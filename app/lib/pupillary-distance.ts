import type { FaceLandmarkerResult, NormalizedLandmark } from '@mediapipe/tasks-vision'

const IRIS_DIAMETER_MM = 11.7

/** Approximate PD from iris size; only report usable, near-frontal observations. */
export function estimatePupillaryDistance(
  result: FaceLandmarkerResult,
  width: number,
  height: number,
): number | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  const lm = result.faceLandmarks[0]
  const indices = [33, 263, 159, 145, 386, 374, 468, 469, 470, 471, 472, 473, 474, 475, 476, 477]
  if (!lm || indices.some(i => !lm[i] || ![lm[i].x, lm[i].y, lm[i].z].every(Number.isFinite))) return null

  const distance = (a: NormalizedLandmark, b: NormalizedLandmark) =>
    Math.hypot((a.x - b.x) * width, (a.y - b.y) * height)
  const eyeDepth = Math.abs(lm[33].z - lm[263].z) * width
  const eyeWidth = distance(lm[33], lm[263])
  if (eyeWidth < 1 || eyeDepth / eyeWidth > 0.2) return null

  const matrix = result.facialTransformationMatrixes[0]?.data
  if (matrix?.length === 16) {
    if (!matrix.every(Number.isFinite)) return null
    const normalLength = Math.hypot(matrix[8], matrix[9], matrix[10])
    if (normalLength < 1e-6 || matrix[10] / normalLength < Math.cos(Math.PI / 9)) return null
  }

  const leftDiameter = Math.max(distance(lm[469], lm[471]), distance(lm[470], lm[472]))
  const rightDiameter = Math.max(distance(lm[474], lm[476]), distance(lm[475], lm[477]))
  if (Math.min(leftDiameter, rightDiameter) < 5 ||
      Math.max(leftDiameter, rightDiameter) / Math.min(leftDiameter, rightDiameter) > 1.25) return null
  if (distance(lm[159], lm[145]) < leftDiameter * 0.35 ||
      distance(lm[386], lm[374]) < rightDiameter * 0.35) return null

  // Dedicated iris centers: 468 and 473. Focal length cancels in this ratio.
  const estimate = distance(lm[468], lm[473]) * IRIS_DIAMETER_MM /
    ((leftDiameter + rightDiameter) / 2)
  return estimate >= 40 && estimate <= 85 ? estimate : null
}
