import { Matrix4, Quaternion, Vector3 } from 'three'
import type { FaceLandmarkerResult, NormalizedLandmark } from '@mediapipe/tasks-vision'

// A short stall (e.g. compiling a newly selected GLB) must not flicker the overlay.
// Explicit no-face / paused / hidden states still clear immediately.
export const TRACKING_TIMEOUT_MS = 500

export interface TrackingFrame {
  result: FaceLandmarkerResult
  timestampMs: number
}

export interface FacePose {
  position: Vector3
  rotation: Quaternion
  eyeDistance: number
}

export interface FrameSize {
  width: number
  height: number
}

function validSize(size: FrameSize) {
  return Number.isFinite(size.width) && Number.isFinite(size.height) &&
    size.width > 0 && size.height > 0
}

function validPoint(point: NormalizedLandmark | undefined): point is NormalizedLandmark {
  return !!point && Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z)
}

// Coordinates for the centered, object-fit: cover, mirrored camera preview.
// Landmark depth is normalized by image WIDTH, including portrait input.
export function landmarkToWorld(point: NormalizedLandmark, video: FrameSize, viewport: FrameSize) {
  const cover = Math.max(viewport.width / video.width, viewport.height / video.height)
  return new Vector3(
    (0.5 - point.x) * video.width * cover,
    (0.5 - point.y) * video.height * cover,
    -point.z * video.width * cover,
  )
}

export function getFacePose(
  result: FaceLandmarkerResult,
  video: FrameSize,
  viewport: FrameSize,
): FacePose | null {
  if (!validSize(video) || !validSize(viewport)) return null
  const landmarks = result.faceLandmarks[0]
  if (!landmarks) return null
  const left = landmarks[263]
  const right = landmarks[33]
  if (!validPoint(left) || !validPoint(right)) return null

  const leftWorld = landmarkToWorld(left, video, viewport)
  const rightWorld = landmarkToWorld(right, video, viewport)
  const eyeDistance = leftWorld.distanceTo(rightWorld)
  if (eyeDistance < 1) return null

  const rotation = new Quaternion()
  const data = result.facialTransformationMatrixes[0]?.data
  let hasRotation = false
  if (data?.length === 16 && data.every(Number.isFinite)) {
    // Face geometry is already right-handed, Y-up (unlike image landmarks).
    // Strip the matrix's uniform scale before extracting its rotation.
    const matrix = new Matrix4().fromArray(data)
    if (matrix.determinant() > 1e-8) {
      rotation.setFromRotationMatrix(new Matrix4().extractRotation(matrix)).normalize()
      // Mirror X: conjugate R with S = diag(-1, 1, 1), i.e. S * R * S.
      // Preserve pitch and reverse yaw/roll without Euler discontinuities.
      rotation.set(rotation.x, -rotation.y, -rotation.z, rotation.w)
      hasRotation = true
    }
  }

  if (!hasRotation) {
    const forehead = landmarks[10]
    const chin = landmarks[152]
    if (!validPoint(forehead) || !validPoint(chin)) return null
    const x = rightWorld.clone().sub(leftWorld).normalize()
    const up = landmarkToWorld(forehead, video, viewport)
      .sub(landmarkToWorld(chin, video, viewport)).normalize()
    const z = new Vector3().crossVectors(x, up)
    if (z.lengthSq() < 1e-6) return null
    z.normalize()
    const y = new Vector3().crossVectors(z, x).normalize()
    rotation.setFromRotationMatrix(new Matrix4().makeBasis(x, y, z)).normalize()
  }

  const midpoint = leftWorld.add(rightWorld).multiplyScalar(0.5)
  const normal = new Vector3(0, 0, 1).applyQuaternion(rotation)
  const bridge = landmarks[168]
  // Fit in front of the actual nose bridge, not a fixed screen-space Z plane.
  // This prevents the face depth mask from swallowing the lenses.
  const bridgeDepth = validPoint(bridge)
    ? Math.max(0, landmarkToWorld(bridge, video, viewport).sub(midpoint).dot(normal))
    : eyeDistance * 0.25
  const position = midpoint.clone()
  position.z = 0
  position.add(new Vector3(0, -eyeDistance * 0.1, bridgeDepth + eyeDistance * 0.04).applyQuaternion(rotation))
  return { position, rotation, eyeDistance }
}

// Speed-adaptive low-pass filtering inspired by Casiez et al.'s 1€ filter.
// https://gery.casiez.net/1euro/ — slow movements prioritize stability, fast ones responsiveness.
const filterAlpha = (cutoffHz: number, elapsedSeconds: number) =>
  1 / (1 + 1 / (2 * Math.PI * cutoffHz * elapsedSeconds))

export class FacePoseSmoother {
  private pose: FacePose | null = null
  private previous: FacePose | null = null
  private timestampMs = 0
  private velocity = new Vector3()
  private angularSpeed = 0
  private scaleSpeed = 0

  reset() {
    this.pose = null
    this.previous = null
    this.timestampMs = 0
    this.velocity.set(0, 0, 0)
    this.angularSpeed = 0
    this.scaleSpeed = 0
  }

  update(target: FacePose, timestampMs: number): FacePose {
    const elapsed = timestampMs - this.timestampMs
    if (!this.pose || !this.previous || elapsed <= 0 || elapsed > TRACKING_TIMEOUT_MS) {
      this.reset()
      this.pose = { position: target.position.clone(), rotation: target.rotation.clone(), eyeDistance: target.eyeDistance }
      this.previous = { position: target.position.clone(), rotation: target.rotation.clone(), eyeDistance: target.eyeDistance }
    } else {
      const dt = elapsed / 1000
      const derivativeAlpha = filterAlpha(1, dt)
      // Normalize translation by face size so tuning works at every screen/distance.
      const velocity = target.position.clone().sub(this.previous.position)
        .divideScalar(Math.max(target.eyeDistance, 1) * dt)
      this.velocity.lerp(velocity, derivativeAlpha)
      this.angularSpeed += (this.previous.rotation.angleTo(target.rotation) / dt - this.angularSpeed) * derivativeAlpha
      this.scaleSpeed += ((Math.log(target.eyeDistance / this.previous.eyeDistance) / dt) - this.scaleSpeed) * derivativeAlpha
      this.pose.position.lerp(target.position, filterAlpha(1.8 + 3 * this.velocity.length(), dt))
      this.pose.rotation.slerp(target.rotation, filterAlpha(2 + this.angularSpeed, dt))
      this.pose.eyeDistance += (target.eyeDistance - this.pose.eyeDistance) *
        filterAlpha(1.2 + Math.abs(this.scaleSpeed), dt)
      this.previous.position.copy(target.position)
      this.previous.rotation.copy(target.rotation)
      this.previous.eyeDistance = target.eyeDistance
    }
    this.timestampMs = timestampMs
    return this.pose
  }
}

/** Put the face surface in the same local space as the smoothed glasses pose. */
export function updateFaceOcclusionPositions(
  result: FaceLandmarkerResult,
  video: FrameSize,
  viewport: FrameSize,
  pose: FacePose,
  positions: Float32Array,
): boolean {
  const landmarks = result.faceLandmarks[0]
  if (!landmarks || landmarks.length < 468 || positions.length < 468 * 3 ||
      !validSize(video) || !validSize(viewport) || pose.eyeDistance <= 0) return false
  const cover = Math.max(viewport.width / video.width, viewport.height / video.height)
  const width = video.width * cover
  const height = video.height * cover
  const eyeZ = -(landmarks[33].z + landmarks[263].z) * 0.5 * width
  const inverse = pose.rotation.clone().invert()
  const point = new Vector3()
  for (let i = 0; i < 468; i++) {
    const lm = landmarks[i]
    if (!validPoint(lm)) return false
    point.set((0.5 - lm.x) * width, (0.5 - lm.y) * height, -lm.z * width - eyeZ)
      .sub(pose.position).applyQuaternion(inverse).divideScalar(pose.eyeDistance)
    point.toArray(positions, i * 3)
  }
  return true
}

export function isTrackingFrameFresh(frame: TrackingFrame | null, nowMs: number) {
  return frame !== null && nowMs >= frame.timestampMs &&
    nowMs - frame.timestampMs <= TRACKING_TIMEOUT_MS
}
