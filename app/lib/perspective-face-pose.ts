import { Matrix4, Quaternion, Vector3 } from 'three'
import type { FaceLandmarkerResult } from '@mediapipe/tasks-vision'
import { CANONICAL_FACE_POINTS } from '../data/canonical-face.ts'

export { CANONICAL_FACE_POINTS }
export const CANONICAL_BRIDGE = CANONICAL_FACE_POINTS[168]
export const CANONICAL_EYE_DISTANCE = new Vector3(...CANONICAL_FACE_POINTS[33])
  .distanceTo(new Vector3(...CANONICAL_FACE_POINTS[263]))

/** Intrinsics in the original, unmirrored video pixel coordinates. */
export interface PerspectiveCameraIntrinsics {
  width: number
  height: number
  fx: number
  fy: number
  cx: number
  cy: number
}

export interface PerspectiveFacePose {
  /** Canonical face origin in Three camera coordinates: +X right, +Y up, -Z forward. */
  position: Vector3
  rotation: Quaternion
  /** Constant canonical outer-eye distance times faceScale, in cm; not a pixel measurement. */
  eyeDistance: number
  faceScale: number
  bridgePosition: Vector3
  quality: {
    rmsPx: number
    /** Baseline and refined RMS use the same final inliers for a fair comparison. */
    seedRmsPx: number
    allPointsRmsPx: number
    inlierCount: number
    pointCount: number
    iterations: number
  }
}

export interface PerspectivePoseOptions {
  /** Optional known personal size / canonical size. Default 1 is an assumption, not measured cm. */
  faceScale?: number
  maxReprojectionErrorPx?: number
}

// Eye corners and upper nose have the highest weights. Side cheeks and outer
// brows add spatial support at lower weights; lips, chin and eyelid contours
// are excluded. MediaPipe does not expose useful per-landmark visibility here.
export const POSE_LANDMARKS = [
  { index: 33, weight: 1 }, { index: 133, weight: 1 },
  { index: 263, weight: 1 }, { index: 362, weight: 1 },
  { index: 168, weight: 1.4 }, { index: 6, weight: 1.4 },
  { index: 197, weight: 1.2 }, { index: 195, weight: 1.1 },
  { index: 5, weight: 0.7 }, { index: 4, weight: 0.5 },
  { index: 98, weight: 0.5 }, { index: 327, weight: 0.5 },
  { index: 127, weight: 0.45 }, { index: 356, weight: 0.45 },
  { index: 117, weight: 0.6 }, { index: 346, weight: 0.6 },
  { index: 123, weight: 0.45 }, { index: 352, weight: 0.45 },
  { index: 70, weight: 0.35 }, { index: 300, weight: 0.35 },
  { index: 46, weight: 0.35 }, { index: 276, weight: 0.35 },
] as const

interface Observation { point: Vector3; x: number; y: number; weight: number; region: number }
interface State { position: Vector3; rotation: Quaternion }

function validCamera(camera: PerspectiveCameraIntrinsics) {
  return [camera.width, camera.height, camera.fx, camera.fy, camera.cx, camera.cy].every(Number.isFinite) && camera.width > 0 && camera.height > 0 &&
    camera.fx > 0 && camera.fy > 0
}

export function projectPerspectivePoint(point: Vector3, camera: PerspectiveCameraIntrinsics) {
  if (!validCamera(camera) || ![point.x, point.y, point.z].every(Number.isFinite) || point.z >= -0.01) return null
  return { x: camera.cx - camera.fx * point.x / point.z, y: camera.cy + camera.fy * point.y / point.z }
}

/** Small partial-pivot solver; only 3x3 and 6x6 systems are used. */
function solve(matrix: number[][], rhs: number[]): number[] | null {
  const size = rhs.length
  const rows = matrix.map((row, i) => [...row, rhs[i]])
  for (let column = 0; column < size; column++) {
    let pivot = column
    for (let row = column + 1; row < size; row++) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row
    }
    if (Math.abs(rows[pivot][column]) < 1e-12) return null
    ;[rows[column], rows[pivot]] = [rows[pivot], rows[column]]
    const divisor = rows[column][column]
    for (let j = column; j <= size; j++) rows[column][j] /= divisor
    for (let row = 0; row < size; row++) {
      if (row === column) continue
      const factor = rows[row][column]
      for (let j = column; j <= size; j++) rows[row][j] -= factor * rows[column][j]
    }
  }
  const answer = rows.map(row => row[size])
  return answer.every(Number.isFinite) ? answer : null
}

const huberWeight = (error: number, threshold: number) => error <= threshold ? 1 : threshold / error
const huberLoss = (error: number, threshold: number) =>
  error <= threshold ? error * error / 2 : threshold * (error - threshold / 2)

function errors(observations: Observation[], state: State, camera: PerspectiveCameraIntrinsics) {
  return observations.map(observation => {
    const pixel = projectPerspectivePoint(observation.point.clone().applyQuaternion(state.rotation).add(state.position), camera)
    return pixel ? Math.hypot(pixel.x - observation.x, pixel.y - observation.y) : Infinity
  })
}

function objective(observations: Observation[], state: State, camera: PerspectiveCameraIntrinsics, threshold: number) {
  return errors(observations, state, camera).reduce((sum, error, i) => sum + observations[i].weight * huberLoss(error, threshold), 0)
}

function solveTranslation(observations: Observation[], rotation: Quaternion, camera: PerspectiveCameraIntrinsics, threshold: number) {
  let position: Vector3 | null = null
  for (let iteration = 0; iteration < 5; iteration++) {
    const matrix = Array.from({ length: 3 }, () => Array<number>(3).fill(0))
    const rhs = Array<number>(3).fill(0)
    const residuals = position ? errors(observations, { position, rotation }, camera) : null
    for (let i = 0; i < observations.length; i++) {
      const observation = observations[i]
      const rotated = observation.point.clone().applyQuaternion(rotation)
      const x = (observation.x - camera.cx) / camera.fx
      const y = (camera.cy - observation.y) / camera.fy
      const weight = observation.weight * (residuals ? huberWeight(residuals[i], threshold) : 1)
      for (const [row, target] of [
        [[1, 0, x], -rotated.x - x * rotated.z],
        [[0, 1, y], -rotated.y - y * rotated.z],
      ] as const) {
        for (let a = 0; a < 3; a++) {
          rhs[a] += weight * row[a] * target
          for (let b = 0; b < 3; b++) matrix[a][b] += weight * row[a] * row[b]
        }
      }
    }
    const translation = solve(matrix, rhs)
    if (!translation) return null
    position = new Vector3().fromArray(translation)
  }
  return position
}

function refine(observations: Observation[], seed: State, camera: PerspectiveCameraIntrinsics, threshold: number) {
  let state = { position: seed.position.clone(), rotation: seed.rotation.clone() }
  let cost = objective(observations, state, camera, threshold)
  let damping = 0.001
  let iterations = 0
  for (; iterations < 15; iterations++) {
    const normal = Array.from({ length: 6 }, () => Array<number>(6).fill(0))
    const rhs = Array<number>(6).fill(0)
    for (const observation of observations) {
      const rotated = observation.point.clone().applyQuaternion(state.rotation)
      const point = rotated.clone().add(state.position)
      const pixel = projectPerspectivePoint(point, camera)
      if (!pixel) return { state: seed, iterations }
      const dx = observation.x - pixel.x, dy = observation.y - pixel.y
      const weight = observation.weight * huberWeight(Math.hypot(dx, dy), threshold)
      const ux = -camera.fx / point.z, uz = camera.fx * point.x / (point.z * point.z)
      const vy = camera.fy / point.z, vz = -camera.fy * point.y / (point.z * point.z)
      // A small camera-space rotation acts on R*p, leaving translation separate.
      const jx = [uz * rotated.y, ux * rotated.z - uz * rotated.x, -ux * rotated.y, ux, 0, uz]
      const jy = [-vy * rotated.z + vz * rotated.y, -vz * rotated.x, vy * rotated.x, 0, vy, vz]
      for (let a = 0; a < 6; a++) {
        rhs[a] += weight * (jx[a] * dx + jy[a] * dy)
        for (let b = 0; b < 6; b++) normal[a][b] += weight * (jx[a] * jx[b] + jy[a] * jy[b])
      }
    }
    for (let a = 0; a < 6; a++) normal[a][a] += damping * Math.max(normal[a][a], 1)
    const step = solve(normal, rhs)
    if (!step) break
    const angle = new Vector3(step[0], step[1], step[2])
    const turn = angle.length()
    const delta = turn > 0 ? new Quaternion().setFromAxisAngle(angle.divideScalar(turn), Math.min(turn, 0.15)) : new Quaternion()
    const candidate = {
      rotation: delta.multiply(state.rotation).normalize(),
      position: state.position.clone().add(new Vector3(step[3], step[4], step[5])),
    }
    const nextCost = objective(observations, candidate, camera, threshold)
    if (nextCost < cost) {
      state = candidate
      const improvement = cost - nextCost
      cost = nextCost
      damping = Math.max(1e-7, damping / 3)
      if (improvement < 1e-7) break
    } else {
      damping *= 10
      if (damping > 1e7) break
    }
  }
  return { state, iterations }
}

/**
 * Refine MediaPipe's rotation against real image pixels using one perspective
 * camera. MediaPipe's translation is intentionally unused: it belongs to its
 * assumed camera. This fits canonical shape, not person-specific anatomy.
 * Mirroring and object-fit cropping belong to the final viewport, not this fit.
 */
export function estimatePerspectiveFacePose(
  result: FaceLandmarkerResult,
  camera: PerspectiveCameraIntrinsics,
  options: PerspectivePoseOptions = {},
): PerspectiveFacePose | null {
  const faceScale = options.faceScale ?? 1
  if (!validCamera(camera) || !Number.isFinite(faceScale) || faceScale < 0.5 || faceScale > 2) return null
  if (options.maxReprojectionErrorPx !== undefined &&
      (!Number.isFinite(options.maxReprojectionErrorPx) || options.maxReprojectionErrorPx <= 0)) return null
  const landmarks = result.faceLandmarks[0]
  const data = result.facialTransformationMatrixes[0]?.data
  if (!landmarks || data?.length !== 16 || !data.every(Number.isFinite)) return null
  const matrix = new Matrix4().fromArray(data)
  if (matrix.determinant() < 1e-8) return null
  const rotation = new Quaternion().setFromRotationMatrix(new Matrix4().extractRotation(matrix)).normalize()
  const observations: Observation[] = []
  for (const { index, weight } of POSE_LANDMARKS) {
    const landmark = landmarks[index]
    if (!landmark || !Number.isFinite(landmark.x) || !Number.isFinite(landmark.y) ||
        landmark.x < 0 || landmark.x > 1 || landmark.y < 0 || landmark.y > 1) continue
    const point = new Vector3(...CANONICAL_FACE_POINTS[index]).multiplyScalar(faceScale)
    observations.push({ point, x: landmark.x * camera.width, y: landmark.y * camera.height, weight,
      region: point.x < -faceScale ? -1 : point.x > faceScale ? 1 : 0 })
  }
  if (observations.length < 12) return null
  // Use several bilateral spans to set pixel tolerances. A single corrupted
  // outer-eye landmark must not enlarge the outlier threshold or set the scale.
  const spans: number[] = []
  for (const [a, b] of [[33, 263], [133, 362], [70, 300], [127, 356], [117, 346]]) {
    const left = landmarks[a], right = landmarks[b]
    if (!left || !right || ![left.x, left.y, right.x, right.y].every(Number.isFinite)) continue
    const canonicalSpan = new Vector3(...CANONICAL_FACE_POINTS[a]).distanceTo(new Vector3(...CANONICAL_FACE_POINTS[b]))
    spans.push(Math.hypot((left.x - right.x) * camera.width, (left.y - right.y) * camera.height) * CANONICAL_EYE_DISTANCE / canonicalSpan)
  }
  spans.sort((a, b) => a - b)
  if (spans.length < 3) return null
  const eyePixels = spans[Math.floor(spans.length / 2)]
  if (!Number.isFinite(eyePixels) || eyePixels < 24) return null
  const threshold = Math.max(2, eyePixels * 0.035)
  const position = solveTranslation(observations, rotation, camera, threshold)
  if (!position) return null
  const seed = { position, rotation }
  const { state, iterations } = refine(observations, seed, camera, threshold)
  const residuals = errors(observations, state, camera)
  const seedResiduals = errors(observations, seed, camera)
  const inlierLimit = Math.max(3, eyePixels * 0.07)
  const inliers = residuals.map((error, i) => error <= inlierLimit ? i : -1).filter(i => i >= 0)
  const support = [-1, 0, 1].map(region => inliers.filter(i => observations[i].region === region).length)
  if (inliers.length < Math.max(12, observations.length * 0.7) || support.some(count => count < 3)) return null
  const weightSum = inliers.reduce((sum, i) => sum + observations[i].weight, 0)
  const rms = (values: number[]) => Math.sqrt(inliers.reduce((sum, i) => sum + observations[i].weight * values[i] ** 2, 0) / weightSum)
  const rmsPx = rms(residuals)
  if (rmsPx > (options.maxReprojectionErrorPx ?? Math.max(2.5, eyePixels * 0.055)) ||
      state.position.z > -12 * faceScale || state.position.z < -250 * faceScale ||
      new Vector3(0, 0, 1).applyQuaternion(state.rotation).z < 0.15 ||
      state.rotation.angleTo(rotation) > 0.6) return null
  return {
    position: state.position, rotation: state.rotation,
    eyeDistance: CANONICAL_EYE_DISTANCE * faceScale, faceScale,
    bridgePosition: new Vector3(...CANONICAL_BRIDGE).multiplyScalar(faceScale).applyQuaternion(state.rotation).add(state.position),
    quality: {
      rmsPx, seedRmsPx: rms(seedResiduals),
      allPointsRmsPx: Math.sqrt(residuals.reduce((sum, error) => sum + error * error, 0) / residuals.length),
      inlierCount: inliers.length, pointCount: observations.length, iterations,
    },
  }
}
