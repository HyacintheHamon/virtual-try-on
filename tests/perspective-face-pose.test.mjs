import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Euler, Matrix4, Quaternion, Vector3 } from 'three'
import {
  CANONICAL_BRIDGE, CANONICAL_EYE_DISTANCE, CANONICAL_FACE_POINTS, POSE_LANDMARKS,
  estimatePerspectiveFacePose, projectPerspectivePoint,
} from '../app/lib/perspective-face-pose.ts'

const camera = { width: 1280, height: 720, fx: 1000, fy: 1010, cx: 622, cy: 351 }
const near = (actual, expected, tolerance = 1e-5) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`)

function projectedFace({ intrinsics = camera, euler = new Euler(), faceScale = 1,
  position = new Vector3(1, -2, -55), perturbSeed = true, deform = point => point } = {}) {
  const rotation = new Quaternion().setFromEuler(euler)
  const landmarks = CANONICAL_FACE_POINTS.map((point, index) => {
    const pixel = projectPerspectivePoint(deform(new Vector3(...point), index).multiplyScalar(faceScale).applyQuaternion(rotation).add(position), intrinsics)
    assert.ok(pixel)
    return { x: pixel.x / intrinsics.width, y: pixel.y / intrinsics.height, z: 0 }
  })
  const seed = perturbSeed
    ? new Quaternion().setFromEuler(new Euler(0.08, -0.06, 0.035)).multiply(rotation)
    : rotation
  // Deliberately incompatible MediaPipe translation and matrix scale. Only its
  // rotation may seed the calibrated projection; neither value is physical here.
  const matrix = new Matrix4().compose(new Vector3(30, 100, -400), seed, new Vector3(1.8, 1.8, 1.8))
  const result = { faceLandmarks: [landmarks], faceBlendshapes: [],
    facialTransformationMatrixes: [{ rows: 4, columns: 4, data: matrix.toArray() }] }
  return { result, rotation, position }
}

test('perspective fit recovers one coherent pose through bilateral yaw, pitch, roll and distance changes', () => {
  for (const euler of [
    new Euler(), new Euler(0, -0.8, 0), new Euler(0, 0.8, 0),
    new Euler(-0.35, 0, 0), new Euler(0.35, 0, 0),
    new Euler(0, 0, -0.45), new Euler(0.2, 0.7, -0.3, 'YXZ'),
  ]) {
    for (const z of [-40, -75]) {
      const truth = projectedFace({ euler, position: new Vector3(1, -2, z) })
      const pose = estimatePerspectiveFacePose(truth.result, camera)
      assert.ok(pose, `No pose at ${euler.toArray()} / ${z}cm`)
      near(pose.position.distanceTo(truth.position), 0)
      near(pose.rotation.angleTo(truth.rotation), 0)
      near(pose.eyeDistance, CANONICAL_EYE_DISTANCE)
      assert.ok(pose.quality.rmsPx < 0.0001)
      assert.ok(pose.quality.seedRmsPx > 1, 'Perturbed seed did not exercise refinement')
      assert.equal(pose.quality.inlierCount, POSE_LANDMARKS.length)
      const bridge = new Vector3(...CANONICAL_BRIDGE).applyQuaternion(truth.rotation).add(truth.position)
      near(pose.bridgePosition.distanceTo(bridge), 0)
    }
  }
})

test('gross eye, nose and cheek outliers do not control pose or its scale', () => {
  for (const yaw of [-0.8, 0, 0.7]) {
    const truth = projectedFace({ euler: new Euler(0.2, yaw, -0.15, 'YXZ') })
    for (const index of [33, 197, 346]) {
      truth.result.faceLandmarks[0][index].x += 0.07
      truth.result.faceLandmarks[0][index].y -= 0.05
    }
    const pose = estimatePerspectiveFacePose(truth.result, camera)
    assert.ok(pose)
    assert.ok(pose.position.distanceTo(truth.position) < 0.2)
    assert.ok(pose.rotation.angleTo(truth.rotation) < 0.01)
    near(pose.eyeDistance, CANONICAL_EYE_DISTANCE)
    assert.equal(pose.quality.inlierCount, POSE_LANDMARKS.length - 3)
    assert.ok(pose.quality.rmsPx < 2)
    assert.ok(pose.quality.allPointsRmsPx > 20, 'Diagnostics must retain evidence of rejected observations')
    assert.ok(pose.quality.rmsPx < pose.quality.seedRmsPx)
  }
})

test('mouth expressions and one missing eye corner do not move the rigid fitting reference', () => {
  const truth = projectedFace({ euler: new Euler(-0.2, 0.45, 0.1) })
  for (const index of [0, 13, 14, 17, 61, 78, 152, 291, 308]) {
    truth.result.faceLandmarks[0][index].x += 0.1
    truth.result.faceLandmarks[0][index].y += 0.15
  }
  truth.result.faceLandmarks[0][33].x = NaN
  const pose = estimatePerspectiveFacePose(truth.result, camera)
  assert.ok(pose)
  near(pose.position.distanceTo(truth.position), 0)
  near(pose.rotation.angleTo(truth.rotation), 0)
  assert.equal(pose.quality.pointCount, POSE_LANDMARKS.length - 1)
})

test('native portrait and landscape intrinsics remain correct through cover cropping and final mirroring', () => {
  for (const intrinsics of [camera, { width: 720, height: 1280, fx: 1040, fy: 1025, cx: 358, cy: 630 }]) {
    const truth = projectedFace({ intrinsics, euler: new Euler(0.16, -0.6, -0.23, 'YXZ') })
    const pose = estimatePerspectiveFacePose(truth.result, intrinsics)
    assert.ok(pose)
    near(pose.rotation.angleTo(truth.rotation), 0)
    for (const viewport of [{ width: 448, height: 448 }, { width: 900, height: 550 }]) {
      const cover = Math.max(viewport.width / intrinsics.width, viewport.height / intrinsics.height)
      const cropX = (intrinsics.width * cover - viewport.width) / 2
      const cropY = (intrinsics.height * cover - viewport.height) / 2
      for (const mirror of [false, true]) {
        for (const index of [33, 168, 263]) {
          const point = new Vector3(...CANONICAL_FACE_POINTS[index]).applyQuaternion(pose.rotation).add(pose.position)
          const pixel = projectPerspectivePoint(point, intrinsics)
          const observed = truth.result.faceLandmarks[0][index]
          const x = (mirror ? intrinsics.width - pixel.x : pixel.x) * cover - cropX
          const expectedX = (mirror ? 1 - observed.x : observed.x) * intrinsics.width * cover - cropX
          near(x, expectedX)
          near(pixel.y * cover - cropY, observed.y * intrinsics.height * cover - cropY)
        }
      }
    }
  }
})

test('known face scale resolves metric size while identical pixels alone cannot', () => {
  const faceScale = 1.15
  const truth = projectedFace({ faceScale, euler: new Euler(0.15, -0.5, 0.1), position: new Vector3(1.2, -2.5, -62) })
  const assumed = estimatePerspectiveFacePose(truth.result, camera)
  const calibrated = estimatePerspectiveFacePose(truth.result, camera, { faceScale })
  assert.ok(assumed && calibrated)
  near(calibrated.position.distanceTo(truth.position), 0)
  near(assumed.position.distanceTo(truth.position.clone().divideScalar(faceScale)), 0)
  near(calibrated.eyeDistance, CANONICAL_EYE_DISTANCE * faceScale)
  near(calibrated.quality.rmsPx, assumed.quality.rmsPx)
  near(calibrated.rotation.angleTo(assumed.rotation), 0)
})

test('invalid cameras, degenerate observations and missing regional support reject a pose', () => {
  const { result } = projectedFace()
  for (const bad of [{ ...camera, fx: 0 }, { ...camera, width: 0 }, { ...camera, cy: NaN }]) {
    assert.equal(estimatePerspectiveFacePose(result, bad), null)
  }
  for (const faceScale of [0, Infinity, 3]) assert.equal(estimatePerspectiveFacePose(result, camera, { faceScale }), null)
  const missing = projectedFace().result
  missing.facialTransformationMatrixes = []
  assert.equal(estimatePerspectiveFacePose(missing, camera), null)
  const collapsed = projectedFace().result
  collapsed.faceLandmarks[0].forEach(point => { point.x = 0.5; point.y = 0.5 })
  assert.equal(estimatePerspectiveFacePose(collapsed, camera), null)
  const oneSide = projectedFace().result
  for (const { index } of POSE_LANDMARKS) {
    if (CANONICAL_FACE_POINTS[index][0] < -1) oneSide.faceLandmarks[0][index].x = NaN
  }
  assert.equal(estimatePerspectiveFacePose(oneSide, camera), null)
  assert.equal(projectPerspectivePoint(new Vector3(0, 0, 1), camera), null)
})

test('reprojection quality gates reject an incoherent face instead of inventing a transform', () => {
  const { result } = projectedFace()
  POSE_LANDMARKS.forEach(({ index }, i) => {
    result.faceLandmarks[0][index].x += (i % 2 ? 1 : -1) * 0.035
    result.faceLandmarks[0][index].y += (i % 3 - 1) * 0.025
  })
  assert.equal(estimatePerspectiveFacePose(result, camera), null)
  const noisy = projectedFace().result
  POSE_LANDMARKS.forEach(({ index }, i) => {
    noisy.faceLandmarks[0][index].x += Math.sin(i * 2) / camera.width
    noisy.faceLandmarks[0][index].y += Math.cos(i * 3) / camera.height
  })
  assert.ok(estimatePerspectiveFacePose(noisy, camera))
  assert.equal(estimatePerspectiveFacePose(noisy, camera, { maxReprojectionErrorPx: 0.1 }), null)
})

for (const contaminated of [false, true]) test(`asymmetric shape and stationary noise near either profile ${contaminated ? 'reject unreliable support or return a bounded pose' : 'remain stable without pose flips'}`, () => {
  const deform = (point, index) => {
    // Deliberately violate the canonical shape: unequal left/right widths,
    // longer upper face and small asymmetric depth. This is not a new fitted
    // face template, and a low residual does not make its pose ground truth.
    point.x *= point.x < 0 ? 1.04 : 0.97
    point.y = point.y * 1.025 + 0.04 * Math.sin(index * 0.7)
    point.z += (point.x > 0 ? 0.1 : -0.08) + 0.04 * Math.sin(index)
    return point
  }
  for (const yaw of [-70, 0, 70]) {
    let previous = null
    let accepted = 0
    for (let frame = 0; frame < 48; frame++) {
      const truth = projectedFace({ euler: new Euler(0.1, yaw * Math.PI / 180, -0.08, 'YXZ'), deform })
      POSE_LANDMARKS.forEach(({ index }, i) => {
        truth.result.faceLandmarks[0][index].x += 0.65 * Math.sin(i * 2.31 + frame * 1.17) / camera.width
        truth.result.faceLandmarks[0][index].y += 0.65 * Math.cos(i * 1.73 + frame * 1.31) / camera.height
      })
      if (contaminated && yaw) {
        // Two badly estimated far-side landmarks simulate partial occlusion.
        for (const index of yaw > 0 ? [263, 346] : [33, 117]) {
          truth.result.faceLandmarks[0][index].x += 0.03
          truth.result.faceLandmarks[0][index].y += 0.025
        }
      }
      const pose = estimatePerspectiveFacePose(truth.result, camera)
      if (!pose) {
        assert.ok(contaminated && yaw, `Rejected moderate shape/noise fixture at yaw ${yaw}, frame ${frame}`)
        continue
      }
      accepted++
      assert.ok(pose.rotation.angleTo(truth.rotation) < 0.12, `Large morphology-induced rotation at yaw ${yaw}`)
      assert.ok(pose.position.distanceTo(truth.position) < 2, `Large morphology-induced translation at yaw ${yaw}`)
      if (previous) {
        assert.ok(pose.rotation.angleTo(previous.rotation) < 0.03, `Stationary rotation jumped at yaw ${yaw}`)
        assert.ok(pose.bridgePosition.distanceTo(previous.bridgePosition) < 0.3, `Stationary bridge jumped at yaw ${yaw}`)
      }
      previous = pose
    }
    assert.ok(accepted > 0, `No accepted pose to verify at yaw ${yaw}`)
  }
})
