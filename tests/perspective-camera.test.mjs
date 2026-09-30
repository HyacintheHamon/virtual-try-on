import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PerspectiveCamera, Vector3 } from 'three'
import { applyCameraIntrinsics, createCameraIntrinsics, getCoverIntrinsics } from '../app/lib/perspective-camera.ts'

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`)

test('perspective projection matches centered cover and final selfie mirror at every viewport', () => {
  for (const source of [
    { width: 1280, height: 720, fx: 1100, fy: 1080, cx: 610, cy: 345 },
    { width: 720, height: 1280, fx: 1000, fy: 1050, cx: 370, cy: 650 },
  ]) {
    for (const viewport of [{ width: 448, height: 448 }, { width: 390, height: 720 }, { width: 960, height: 540 }]) {
      const camera = new PerspectiveCamera(50, 1, 0.5, 500)
      assert.equal(applyCameraIntrinsics(camera, source, viewport), true)
      const scale = Math.max(viewport.width / source.width, viewport.height / source.height)
      for (const point of [new Vector3(-5, 3, -40), new Vector3(8, -2, -60), new Vector3(0, 0, -25)]) {
        const u = source.fx * point.x / -point.z + source.cx
        const v = source.cy - source.fy * point.y / -point.z
        const expectedX = u * scale - (source.width * scale - viewport.width) / 2
        const expectedY = v * scale - (source.height * scale - viewport.height) / 2
        const ndc = point.clone().project(camera)
        const screenX = (ndc.x + 1) * viewport.width / 2
        const screenY = (1 - ndc.y) * viewport.height / 2
        near(screenX, expectedX)
        near(screenY, expectedY)
        near(viewport.width - screenX, viewport.width - expectedX)
        const recovered = ndc.clone().unproject(camera)
        assert.ok(recovered.distanceTo(point) < 1e-8)
      }
    }
  }
})

test('calibration scales with matching video resolution and rejects an unknown sensor crop', () => {
  const calibrated = { width: 1280, height: 720, fx: 1000, fy: 1020, cx: 620, cy: 370 }
  assert.deepEqual(createCameraIntrinsics({ width: 640, height: 360 }, calibrated),
    { width: 640, height: 360, fx: 500, fy: 510, cx: 310, cy: 185 })
  assert.equal(createCameraIntrinsics({ width: 640, height: 480 }, calibrated), null)
  assert.equal(createCameraIntrinsics({ width: 0, height: 480 }), null)
  assert.equal(createCameraIntrinsics({ width: 640, height: 360 }, { ...calibrated, fx: NaN }), null)
  assert.equal(getCoverIntrinsics(calibrated, { width: 0, height: 400 }), null)
})

test('default camera is a consistent explicit field-of-view assumption across video orientation', () => {
  const landscape = createCameraIntrinsics({ width: 1280, height: 720 })
  const portrait = createCameraIntrinsics({ width: 720, height: 1280 })
  near(landscape.fx, portrait.fx)
  near(landscape.fx, landscape.fy)
  near(landscape.cx, 640)
  near(portrait.cy, 640)
})
