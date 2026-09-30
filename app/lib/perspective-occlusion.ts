import { Vector3 } from 'three'
import type { FaceLandmarkerResult } from '@mediapipe/tasks-vision'
import { CANONICAL_FACE_POINTS } from '../data/canonical-face.ts'
import type { FacePose } from './face-tracking'
import type { CameraIntrinsics } from './perspective-camera.ts'

const FACE_VERTEX_COUNT = 468
const CANONICAL_EYE_DISTANCE = new Vector3(...CANONICAL_FACE_POINTS[33])
  .distanceTo(new Vector3(...CANONICAL_FACE_POINTS[263]))

/**
 * Reconstruct the observed face in the raw pose's local centimeter space.
 * Camera depth comes from the posed canonical mesh; landmark z is relative,
 * not metric. The observed x/y still project exactly back onto the video.
 * Apply the shared smoothed/predicted pose afterward, with parent scale = 1.
 */
export function updatePerspectiveOcclusionPositions(
  result: FaceLandmarkerResult,
  camera: CameraIntrinsics,
  pose: Pick<FacePose, 'position' | 'rotation'>,
  positions: Float32Array,
  faceScale = 1,
): boolean {
  const landmarks = result.faceLandmarks[0]
  if (!landmarks || landmarks.length < FACE_VERTEX_COUNT || positions.length < FACE_VERTEX_COUNT * 3 ||
      !Number.isFinite(faceScale) || faceScale <= 0 ||
      ![camera.width, camera.height, camera.fx, camera.fy].every(value => Number.isFinite(value) && value > 0) ||
      ![camera.cx, camera.cy, pose.position.x, pose.position.y, pose.position.z,
        pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w].every(Number.isFinite) ||
      pose.rotation.lengthSq() < 1e-8) return false

  const rotation = pose.rotation.clone().normalize()
  const inverse = rotation.clone().invert()
  const canonical = new Vector3()
  const cameraPoint = new Vector3()
  const localPoint = new Vector3()
  // Stage the complete face so one corrupt landmark cannot partly replace a
  // previously valid depth buffer. This is only 5.6 KB per detection.
  const next = new Float32Array(FACE_VERTEX_COUNT * 3)
  const maxDeviation = CANONICAL_EYE_DISTANCE * faceScale * 2

  for (let index = 0; index < FACE_VERTEX_COUNT; index++) {
    const landmark = landmarks[index]
    if (!landmark || !Number.isFinite(landmark.x) || !Number.isFinite(landmark.y)) return false
    canonical.fromArray(CANONICAL_FACE_POINTS[index]).multiplyScalar(faceScale)
    cameraPoint.copy(canonical).applyQuaternion(rotation).add(pose.position)
    const depth = -cameraPoint.z
    if (!Number.isFinite(depth) || depth <= 1e-4) return false

    cameraPoint.set(
      (landmark.x * camera.width - camera.cx) * depth / camera.fx,
      -(landmark.y * camera.height - camera.cy) * depth / camera.fy,
      -depth,
    )
    localPoint.copy(cameraPoint).sub(pose.position).applyQuaternion(inverse)
    // Reject gross corruption, while permitting individual facial shape and
    // expressions. Clamping would break alignment with the observed silhouette.
    if (!Number.isFinite(localPoint.lengthSq()) || localPoint.distanceTo(canonical) > maxDeviation) return false
    localPoint.toArray(next, index * 3)
  }
  if (!next.every(Number.isFinite)) return false
  positions.set(next)
  return true
}
