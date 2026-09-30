import { Box3, Vector3 } from 'three'

export type ModelPoint = readonly [number, number, number]

/** All anchors use corrected model axes: +Z front, -Z temples, +Y up. */
export interface GlassesFitting {
  millimetersPerUnit: number
  frameWidthMm: number
  bridgeAnchor: ModelPoint
  hingeAnchors: { left: ModelPoint; right: ModelPoint }
}

export { REFERENCE_FRAME_FITTING } from '../data/reference-frame.ts'

const validPoint = (point: ModelPoint) => point.length === 3 && point.every(Number.isFinite)

/**
 * Position the corrected child by `offset`, then apply `scale` to its parent.
 * The resulting geometry is in centimetres. Known frame dimensions must never
 * be resized to each wearer's face: that would hide the actual size difference.
 * Camera/face calibration is still needed before making physical-fit claims.
 */
export function getGlassesFittingTransform(
  bounds: Box3,
  fallbackOuterEyeDistanceCm: number,
  fitting?: GlassesFitting,
): { offset: Vector3; scale: number; mode: 'dimensions' | 'visual' } {
  if (fitting) {
    if (!Number.isFinite(fitting.millimetersPerUnit) || fitting.millimetersPerUnit <= 0 ||
        !Number.isFinite(fitting.frameWidthMm) || fitting.frameWidthMm <= 0 ||
        !validPoint(fitting.bridgeAnchor) || !validPoint(fitting.hingeAnchors.left) ||
        !validPoint(fitting.hingeAnchors.right)) {
      throw new RangeError('Invalid glasses fitting dimensions or anchors')
    }
    return {
      offset: new Vector3(...fitting.bridgeAnchor).negate(),
      scale: fitting.millimetersPerUnit / 10,
      mode: 'dimensions',
    }
  }

  const width = bounds.max.x - bounds.min.x
  if (!Number.isFinite(width) || width <= 0 ||
      !Number.isFinite(fallbackOuterEyeDistanceCm) || fallbackOuterEyeDistanceCm <= 0 ||
      !bounds.min.toArray().every(Number.isFinite) || !bounds.max.toArray().every(Number.isFinite)) {
    throw new RangeError('Invalid glasses bounds or visual fitting scale')
  }
  const center = bounds.getCenter(new Vector3())
  return {
    offset: new Vector3(-center.x, -center.y, -bounds.max.z),
    scale: fallbackOuterEyeDistanceCm * 1.55 / width,
    mode: 'visual',
  }
}
