import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DoubleSide, Euler, Mesh, MeshBasicMaterial, Raycaster, Vector3 } from 'three'
import { createHeadOcclusionGeometry, FACE_OVAL, updateHeadOcclusionPositions } from '../app/lib/head-occlusion.ts'

// A full oval in outer-eye-distance units. Its outline is behind the glasses
// front plane, and its varying depth exercises the seam around the whole face.
function faceOval() {
  const positions = new Float32Array(468 * 3)
  for (let i = 0; i < FACE_OVAL.length; i++) {
    const angle = i / FACE_OVAL.length * Math.PI * 2
    positions.set([
      0.72 * Math.sin(angle),
      0.08 + Math.cos(angle),
      -0.3 - 0.06 * Math.sin(angle) ** 2,
    ], FACE_OVAL[i] * 3)
  }
  return positions
}

function shell() {
  const geometry = createHeadOcclusionGeometry()
  const face = faceOval()
  assert.equal(updateHeadOcclusionPositions(face, geometry.attributes.position.array), true)
  const material = new MeshBasicMaterial({ side: DoubleSide })
  const mesh = new Mesh(geometry, material)
  return { face, geometry, mesh, dispose: () => { geometry.dispose(); material.dispose() } }
}

// Match the app's orthographic camera: cast from +world Z up to the sample,
// after transforming both shell and sample by the same tracked head pose.
function isHidden(mesh, localPoint, euler = new Euler()) {
  mesh.rotation.copy(euler)
  mesh.updateMatrixWorld(true)
  const point = new Vector3(...localPoint).applyMatrix4(mesh.matrixWorld)
  const distance = 10
  const origin = point.clone().add(new Vector3(0, 0, distance))
  const ray = new Raycaster(origin, new Vector3(0, 0, -1), 0, distance - 1e-5)
  return ray.intersectObject(mesh, false).length > 0
}

test('head shell joins every oval landmark without a seam or forward protrusions', () => {
  const { face, geometry, dispose } = shell()
  try {
    const positions = geometry.attributes.position
    for (let i = 0; i < FACE_OVAL.length; i++) {
      const expected = new Vector3().fromArray(face, FACE_OVAL[i] * 3)
      const actual = new Vector3().fromBufferAttribute(positions, i)
      assert.ok(actual.distanceTo(expected) < 1e-6, `Oval seam at landmark ${FACE_OVAL[i]}`)
    }
    const frontmost = Math.max(...FACE_OVAL.map(index => face[index * 3 + 2]))
    for (let i = FACE_OVAL.length; i < positions.count; i++) {
      assert.ok(positions.getZ(i) <= frontmost + 1e-6, `Vertex ${i} protrudes in front`)
      assert.ok(Number.isFinite(positions.getX(i)) && Number.isFinite(positions.getY(i)))
    }
  } finally { dispose() }
})

test('frontal depth occlusion hides rear tips while preserving lenses and the open front', () => {
  const { mesh, dispose } = shell()
  try {
    for (const side of [-1, 1]) {
      assert.equal(isHidden(mesh, [side * 0.5, 0.15, -1.3]), true, 'Rear tip remains visible')
      assert.equal(isHidden(mesh, [side * 0.35, 0.15, 0.02]), false, 'Lens is covered')
      assert.equal(isHidden(mesh, [side * 0.82, 0.15, -0.5]), false, 'Outside temple is covered')
    }
    assert.equal(isHidden(mesh, [0, 0.08, -0.4]), false, 'An unwanted front cap closes the oval')
    assert.equal(isHidden(mesh, [0, 0.08, -1.5]), true, 'Rear cap is open')
  } finally { dispose() }
})

for (const yaw of [-0.7, 0.7]) {
  for (const [label, rotation] of [
    ['yaw', new Euler(0, yaw, 0)],
    ['yaw, pitch and roll', new Euler(0.18, yaw, -0.2, 'YXZ')],
  ]) {
    test(`${label} ${yaw}: far temple is hidden while the near temple and front remain visible`, () => {
      const { mesh, dispose } = shell()
      try {
        const farSide = Math.sign(yaw)
        assert.equal(isHidden(mesh, [farSide * 0.82, 0.15, -0.55], rotation), true, 'Far temple remains visible')
        assert.equal(isHidden(mesh, [-farSide * 0.82, 0.15, -0.55], rotation), false, 'Near temple is covered')
        for (const side of [-1, 1]) {
          assert.equal(isHidden(mesh, [side * 0.35, 0.15, 0.02], rotation), false, 'Front lens is covered')
        }
      } finally { dispose() }
    })
  }
}

test('invalid, collapsed and implausible input rejects the shell without corrupting its buffer', () => {
  const geometry = createHeadOcclusionGeometry()
  const head = geometry.attributes.position.array
  const invalid = []
  invalid.push(new Float32Array(467 * 3))
  for (const value of [NaN, Infinity, -Infinity]) {
    const face = faceOval()
    face[FACE_OVAL[8] * 3 + 2] = value
    invalid.push(face)
  }
  invalid.push(new Float32Array(468 * 3))
  for (const [axis, scale] of [[0, 0], [1, 0], [0, 4], [1, 3]]) {
    const face = faceOval()
    for (const index of FACE_OVAL) face[index * 3 + axis] *= scale
    invalid.push(face)
  }
  try {
    for (const face of invalid) {
      head.fill(42)
      assert.equal(updateHeadOcclusionPositions(face, head), false)
      assert.ok(head.every(value => value === 42), 'Rejected frame partly overwrote the last valid shell')
    }
    assert.equal(updateHeadOcclusionPositions(faceOval(), new Float32Array(head.length - 1)), false)
  } finally { geometry.dispose() }
})

test('centimeter geometry preserves the shell shape with a matching eye-distance reference', () => {
  const geometry = createHeadOcclusionGeometry()
  const head = geometry.attributes.position.array
  const reference = head.slice()
  const face = faceOval()
  assert.equal(updateHeadOcclusionPositions(face, reference), true)
  try {
    for (const eyeDistance of [7.5, 9, 12]) {
      const metricFace = face.map(value => value * eyeDistance)
      assert.equal(updateHeadOcclusionPositions(metricFace, head, eyeDistance), true)
      for (let index = 0; index < head.length; index++) {
        assert.ok(Math.abs(head[index] / eyeDistance - reference[index]) < 1e-6)
      }
    }
    for (const invalidReference of [0, -1, NaN, Infinity]) {
      head.fill(42)
      assert.equal(updateHeadOcclusionPositions(face, head, invalidReference), false)
      assert.ok(head.every(value => value === 42))
    }
  } finally { geometry.dispose() }
})
