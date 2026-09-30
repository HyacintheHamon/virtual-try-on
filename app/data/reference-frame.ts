import type { GlassesFitting } from '../lib/glasses-fitting.ts'

/** Dimensions of the generated design, not measurements of a commercial product. */
export const REFERENCE_FRAME_FITTING: GlassesFitting = {
  millimetersPerUnit: 10,
  frameWidthMm: 140,
  bridgeAnchor: [0, 0, 0],
  hingeAnchors: { left: [-6.75, 0.14, -0.33], right: [6.75, 0.14, -0.33] },
}
