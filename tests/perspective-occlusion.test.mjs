import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Euler, PerspectiveCamera, Quaternion, Vector3 } from 'three'
import { CANONICAL_FACE_POINTS } from '../app/data/canonical-face.ts'
import { updatePerspectiveOcclusionPositions } from '../app/lib/perspective-occlusion.ts'
import { applyCameraIntrinsics } from '../app/lib/perspective-camera.ts'

const sourceCamera = { width: 1280, height: 720, fx: 940, fy: 910, cx: 658, cy: 342 }
const near = (actual, expected, tolerance = 2e-4) => {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`)
}

function projectedFace(pose, faceScale = 1, camera = sourceCamera) {
  return {
    faceLandmarks: [CANONICAL_FACE_POINTS.map(coordinates => {
      const point = new Vector3(...coordinates).multiplyScalar(faceScale)
        .applyQuaternion(pose.rotation).add(pose.position)
      const depth = -point.z
      return {
        x: (camera.fx * point.x / depth + camera.cx) / camera.width,
        y: (-camera.fy * point.y / depth + camera.cy) / camera.height,
        // This intentionally is not a camera-space depth. MediaPipe z has
        // different units, so using it as centimeters would break the test.
        z: 0.2,
      }
    })],
  }
}

function cameraPoint(local, index, pose) {
  return new Vector3().fromArray(local, index * 3)
    .applyQuaternion(pose.rotation).add(pose.position)
}

for (const yaw of [-1.2, 0, 1.2]) {
  test(`face vertices reproject onto source landmarks at yaw ${yaw}`, () => {
    const pose = {
      position: new Vector3(3, -2, -55),
      rotation: new Quaternion().setFromEuler(new Euler(0.2, yaw, -0.15, 'YXZ')),
    }
    const result = projectedFace(pose)
    // Preserve measured silhouette differences rather than always returning
    // the canonical face, including points whose relative z is unavailable.
    result.faceLandmarks[0][234].x += 0.008
    result.faceLandmarks[0][152].y += 0.006
    result.faceLandmarks[0][168].z = NaN
    const positions = new Float32Array(468 * 3)
    assert.equal(updatePerspectiveOcclusionPositions(result, sourceCamera, pose, positions), true)

    for (let index = 0; index < 468; index++) {
      const point = cameraPoint(positions, index, pose)
      const landmark = result.faceLandmarks[0][index]
      near(sourceCamera.fx * point.x / -point.z + sourceCamera.cx, landmark.x * sourceCamera.width)
      near(-sourceCamera.fy * point.y / -point.z + sourceCamera.cy, landmark.y * sourceCamera.height)
    }
    assert.ok(new Vector3().fromArray(positions, 234 * 3)
      .distanceTo(new Vector3(...CANONICAL_FACE_POINTS[234])) > 0.1)
  })
}

test('faceScale changes canonical centimeters exactly once, independently of camera distance', () => {
  for (const faceScale of [0.85, 1, 1.2]) {
    for (const distance of [35, 65, 100]) {
      const pose = {
        position: new Vector3(-1, 2, -distance),
        rotation: new Quaternion().setFromEuler(new Euler(-0.18, 0.8, 0.1)),
      }
      const positions = new Float32Array(468 * 3)
      const result = projectedFace(pose, faceScale)
      assert.equal(updatePerspectiveOcclusionPositions(result, sourceCamera, pose, positions, faceScale), true)
      for (let index = 0; index < 468; index++) {
        const actual = new Vector3().fromArray(positions, index * 3)
        const expected = new Vector3(...CANONICAL_FACE_POINTS[index]).multiplyScalar(faceScale)
        assert.ok(actual.distanceTo(expected) < 2e-6)
      }
    }
  }
})

test('camera cover projection and final CSS mirror align with the mirrored video', () => {
  const pose = {
    position: new Vector3(2, 1, -45),
    rotation: new Quaternion().setFromEuler(new Euler(0.1, -0.9, 0.2)),
  }
  const result = projectedFace(pose)
  const positions = new Float32Array(468 * 3)
  assert.equal(updatePerspectiveOcclusionPositions(result, sourceCamera, pose, positions), true)

  for (const viewport of [{ width: 448, height: 448 }, { width: 360, height: 640 }, { width: 900, height: 420 }]) {
    const camera = new PerspectiveCamera(45, viewport.width / viewport.height, 0.1, 1000)
    assert.equal(applyCameraIntrinsics(camera, sourceCamera, viewport), true)
    camera.updateMatrixWorld(true)
    const cover = Math.max(viewport.width / sourceCamera.width, viewport.height / sourceCamera.height)
    for (const index of [10, 33, 168, 234, 263, 454, 152]) {
      const landmark = result.faceLandmarks[0][index]
      const point = cameraPoint(positions, index, pose).project(camera)
      const canvasX = (point.x + 1) * viewport.width / 2
      const canvasY = (1 - point.y) * viewport.height / 2
      const mirroredX = viewport.width - canvasX
      near(mirroredX, viewport.width / 2 + (0.5 - landmark.x) * sourceCamera.width * cover)
      near(canvasY, viewport.height / 2 + (landmark.y - 0.5) * sourceCamera.height * cover)
    }
  }
})

test('invalid input and behind-camera faces leave the previous buffer unchanged', () => {
  const pose = { position: new Vector3(0, 0, -50), rotation: new Quaternion() }
  const valid = projectedFace(pose)
  const invalidResult = projectedFace(pose)
  invalidResult.faceLandmarks[0][467].x = NaN
  const corruptedResult = projectedFace(pose)
  corruptedResult.faceLandmarks[0][467].y = 1e20
  const invalidCases = [
    [invalidResult, sourceCamera, pose, 1],
    [corruptedResult, sourceCamera, pose, 1],
    [{ faceLandmarks: [] }, sourceCamera, pose, 1],
    [valid, { ...sourceCamera, fx: 0 }, pose, 1],
    [valid, { ...sourceCamera, cy: NaN }, pose, 1],
    [valid, sourceCamera, { ...pose, position: new Vector3(0, 0, 5) }, 1],
    [valid, sourceCamera, { ...pose, rotation: new Quaternion(0, 0, 0, 0) }, 1],
    [valid, sourceCamera, pose, 0],
    [valid, sourceCamera, pose, NaN],
  ]
  for (const [result, camera, target, scale] of invalidCases) {
    const positions = new Float32Array(468 * 3).fill(42)
    assert.equal(updatePerspectiveOcclusionPositions(result, camera, target, positions, scale), false)
    assert.ok(positions.every(value => value === 42), 'invalid input partially updated the previous face')
  }
  assert.equal(updatePerspectiveOcclusionPositions(valid, sourceCamera, pose, new Float32Array(467 * 3)), false)
})
