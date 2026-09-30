import { BufferAttribute, BufferGeometry, DynamicDrawUsage } from 'three'

// MediaPipe FACE_LANDMARKS_FACE_OVAL, in boundary order. The existing face
// surface ends here; this shell closes its sides and back without a front cap.
export const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288,
  397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136,
  172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
] as const

// Conservative skull proxy, not measured hair/ear geometry. Coordinates are
// normalized by outer-eye distance, in the same local space as the face mask.
const RINGS = [
  { depth: 0, scale: 1 },
  { depth: 0.4, scale: 1 },
  { depth: 0.75, scale: 0.75 },
] as const
const RING_SIZE = FACE_OVAL.length
const REAR_POLE = RING_SIZE * RINGS.length

export function createHeadOcclusionGeometry() {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(
    new Float32Array((REAR_POLE + 1) * 3), 3,
  ).setUsage(DynamicDrawUsage))
  const indices: number[] = []
  for (let ring = 0; ring < RINGS.length - 1; ring++) {
    for (let i = 0; i < RING_SIZE; i++) {
      const next = (i + 1) % RING_SIZE
      const a = ring * RING_SIZE + i
      const b = ring * RING_SIZE + next
      const c = (ring + 1) * RING_SIZE + i
      const d = (ring + 1) * RING_SIZE + next
      indices.push(a, b, c, b, d, c)
    }
  }
  const lastRing = REAR_POLE - RING_SIZE
  for (let i = 0; i < RING_SIZE; i++) {
    indices.push(lastRing + i, lastRing + (i + 1) % RING_SIZE, REAR_POLE)
  }
  geometry.setIndex(indices)
  return geometry
}

/** Extend the already reconstructed face mask; no second coordinate transform. */
export function updateHeadOcclusionPositions(face: Float32Array, head: Float32Array): boolean {
  if (face.length < 468 * 3 || head.length < (REAR_POLE + 1) * 3) return false
  let minX = Infinity, maxX = -Infinity
  let minY = Infinity, maxY = -Infinity
  let minZ = Infinity
  for (const index of FACE_OVAL) {
    const x = face[index * 3], y = face[index * 3 + 1], z = face[index * 3 + 2]
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false
    minX = Math.min(minX, x); maxX = Math.max(maxX, x)
    minY = Math.min(minY, y); maxY = Math.max(maxY, y)
    minZ = Math.min(minZ, z)
  }
  const width = maxX - minX, height = maxY - minY
  // Reject collapsed or implausibly large outlines in eye-distance units.
  if (width < 0.5 || width > 3 || height < 0.5 || height > 4) return false
  const centerX = (minX + maxX) / 2
  const centerY = (minY + maxY) / 2
  const rearZ = minZ - width * 0.65

  for (let ring = 0; ring < RINGS.length; ring++) {
    const { depth, scale } = RINGS[ring]
    for (let i = 0; i < RING_SIZE; i++) {
      const source = FACE_OVAL[i] * 3
      const target = (ring * RING_SIZE + i) * 3
      head[target] = centerX + (face[source] - centerX) * scale
      head[target + 1] = centerY + (face[source + 1] - centerY) * scale
      head[target + 2] = face[source + 2] + (rearZ - face[source + 2]) * depth
    }
  }
  head[REAR_POLE * 3] = centerX
  head[REAR_POLE * 3 + 1] = centerY
  head[REAR_POLE * 3 + 2] = rearZ
  return true
}
