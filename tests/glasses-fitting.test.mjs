import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { Box3, Vector3 } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { getGlassesFittingTransform, REFERENCE_FRAME_FITTING } from '../app/lib/glasses-fitting.ts'

const bounds = new Box3(new Vector3(-7, -2.5, -13.2), new Vector3(7, 1.8, 0.24))
const near = (a, b, epsilon = 1e-5) => assert.ok(Math.abs(a - b) < epsilon, `${a} != ${b}`)

test('known frame dimensions stay fixed in centimetres for every wearer', () => {
  for (const eyeDistanceCm of [6, 9, 12]) {
    const transform = getGlassesFittingTransform(bounds, eyeDistanceCm, REFERENCE_FRAME_FITTING)
    near(transform.scale, 1)
    near(transform.offset.length(), 0)
    assert.equal(transform.mode, 'dimensions')
    near(bounds.getSize(new Vector3()).x * transform.scale, 14)
  }
  const millimetreModel = { ...REFERENCE_FRAME_FITTING, millimetersPerUnit: 1, bridgeAnchor: [3, 8, 4] }
  const transform = getGlassesFittingTransform(bounds, 9, millimetreModel)
  near(transform.scale, 0.1)
  assert.deepEqual(new Vector3(3, 8, 4).add(transform.offset).multiplyScalar(transform.scale).toArray(), [0, 0, 0])
})

test('unmeasured legacy assets retain explicit visual fitting and front-plane anchoring', () => {
  const transform = getGlassesFittingTransform(bounds, 9)
  assert.equal(transform.mode, 'visual')
  near(bounds.getSize(new Vector3()).x * transform.scale, 9 * 1.55)
  near(bounds.max.z + transform.offset.z, 0)
  const center = bounds.getCenter(new Vector3()).add(transform.offset)
  near(center.x, 0)
  near(center.y, 0)
})

test('invalid calibration cannot silently produce a misleading physical scale', () => {
  for (const fitting of [
    { ...REFERENCE_FRAME_FITTING, millimetersPerUnit: 0 },
    { ...REFERENCE_FRAME_FITTING, frameWidthMm: NaN },
    { ...REFERENCE_FRAME_FITTING, bridgeAnchor: [0, Infinity, 0] },
  ]) assert.throws(() => getGlassesFittingTransform(bounds, 9, fitting), RangeError)
  assert.throws(() => getGlassesFittingTransform(new Box3(), 9), RangeError)
  assert.throws(() => getGlassesFittingTransform(bounds, 0), RangeError)
})

test('generated GLB matches its declared dimensions, anchors and usable materials', async () => {
  const bytes = await readFile(new URL('../public/models/reference-frame.glb', import.meta.url))
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  const gltf = await new GLTFLoader().parseAsync(buffer, '')
  const model = gltf.scene.children[0]
  assert.deepEqual(model.userData.fitting, REFERENCE_FRAME_FITTING)
  const actual = new Box3().setFromObject(model)
  near(actual.getSize(new Vector3()).x * 10, 140, 0.05)
  assert.ok(actual.min.z < -12 && actual.max.z < 0.3, 'Unexpected front/back export axis')
  for (const side of ['Left', 'Right']) {
    const temple = model.getObjectByName(side + '_140_mm_temple')
    assert.ok(temple, 'Missing temple mesh')
    near(temple.userData.centerlineLengthMm, 140, 0.01)
    const lens = model.getObjectByName(side + '_smoke_lens')
    assert.ok(lens.material.transparent)
    assert.ok(lens.material.opacity > 0 && lens.material.opacity < 0.3)
    const hinge = model.getObjectByName(side + '_hinge')
    assert.ok(hinge.material.metalness > 0.5)
  }
  model.traverse(node => {
    if (node.isMesh) {
      for (const attribute of Object.values(node.geometry.attributes)) {
        assert.ok(Array.from(attribute.array).every(Number.isFinite), 'Non-finite generated geometry')
      }
      node.geometry.dispose()
      if (Array.isArray(node.material)) node.material.forEach(material => material.dispose())
      else node.material.dispose()
    }
  })
})
