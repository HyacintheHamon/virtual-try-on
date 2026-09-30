import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Euler, Matrix4, Quaternion, Vector3 } from 'three'
import { FacePoseSmoother, getFacePose, isTrackingFrameFresh, landmarkToWorld, updateFaceOcclusionPositions } from '../app/lib/face-tracking.ts'
import { estimatePupillaryDistance } from '../app/lib/pupillary-distance.ts'

const video = { width: 1280, height: 720 }
const viewport = { width: 448, height: 448 }
const near = (actual, expected, epsilon = 1e-6) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`)

function face(euler = new Euler(), withMatrix = true, scale = 1) {
  const rotation = new Quaternion().setFromEuler(euler)
  const matrix = new Matrix4().compose(new Vector3(12, -10, -50), rotation, new Vector3(scale, scale, scale))
  const landmarks = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }))
  for (const [index, coordinates] of [[33, [-100, 0, 0]], [263, [100, 0, 0]], [10, [0, 130, 0]], [152, [0, -130, 0]]]) {
    const point = new Vector3(...coordinates).applyQuaternion(rotation)
    landmarks[index] = { x: 0.5 + point.x / video.width, y: 0.5 - point.y / video.height, z: -point.z / video.width }
  }
  return { faceLandmarks: [landmarks], faceBlendshapes: [], facialTransformationMatrixes: withMatrix ? [{ rows: 4, columns: 4, data: matrix.toArray() }] : [] }
}

test('cover mapping preserves pixel aspect ratio and mirrors landscape and portrait frames', () => {
  const point = { x: 0.25, y: 0.25, z: -0.1 }
  const landscape = landmarkToWorld(point, { width: 1280, height: 720 }, { width: 360, height: 360 })
  assert.deepEqual(landscape.toArray(), [160, 90, 64])
  const portrait = landmarkToWorld(point, { width: 720, height: 1280 }, { width: 360, height: 360 })
  assert.deepEqual(portrait.toArray(), [90, 160, 36])
})

for (const [axis, euler] of [
  ['pitch', new Euler(0.3, 0, 0)], ['yaw', new Euler(0, 0.5, 0)],
  ['roll', new Euler(0, 0, -0.4)], ['combined', new Euler(0.2, -0.4, 0.3, 'YXZ')],
]) {
  test(`mirrored ${axis} matches reflected face basis, with scaled matrix and landmark fallback`, () => {
    const result = face(euler, true, 1.7)
    const pose = getFacePose(result, video, viewport)
    const fallback = getFacePose(face(euler, false), video, viewport)
    const q = new Quaternion().setFromEuler(euler)
    const expected = new Quaternion(q.x, -q.y, -q.z, q.w)
    near(pose.rotation.angleTo(expected), 0)
    near(fallback.rotation.angleTo(expected), 0)
    near(pose.eyeDistance, 200 * viewport.height / video.height)
    const eyeLine = landmarkToWorld(result.faceLandmarks[0][33], video, viewport)
      .sub(landmarkToWorld(result.faceLandmarks[0][263], video, viewport)).normalize()
    near(new Vector3(1, 0, 0).applyQuaternion(pose.rotation).distanceTo(eyeLine), 0)
  })
}

test('fitting offset rotates with the face instead of drifting vertically in screen space', () => {
  const pose = getFacePose(face(new Euler(0, 0, Math.PI / 4)), video, viewport)
  const expected = new Vector3(0, -pose.eyeDistance * 0.1, pose.eyeDistance * 0.04).applyQuaternion(pose.rotation)
  near(pose.position.distanceTo(expected), 0)
})

test('invalid or missing data never produces a transform containing NaN', () => {
  assert.equal(getFacePose({ faceLandmarks: [], facialTransformationMatrixes: [] }, video, viewport), null)
  assert.equal(getFacePose(face(), { width: 0, height: 720 }, viewport), null)
  const invalid = face()
  invalid.faceLandmarks[0][33].x = NaN
  assert.equal(getFacePose(invalid, video, viewport), null)
  const invalidMatrix = face()
  invalidMatrix.facialTransformationMatrixes[0].data.fill(0)
  near(getFacePose(invalidMatrix, video, viewport).rotation.angleTo(new Quaternion()), 0)
})

const poseAt = (x, angle = 0, width = 100) => ({ position: new Vector3(x, 0, 0), rotation: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), angle), eyeDistance: width })

test('adaptive filter converges within 0.1px across camera FPS and attenuates jitter', () => {
  const run = fps => {
    const filter = new FacePoseSmoother()
    filter.update(poseAt(0), 0)
    let output
    for (let frame = 1; frame <= fps; frame++) output = filter.update(poseAt(100, 0.5, 150), frame * 1000 / fps)
    return output
  }
  const low = run(15), high = run(60)
  near(low.position.x, high.position.x, 0.1)
  near(low.eyeDistance, high.eyeDistance, 0.1)
  near(low.rotation.angleTo(high.rotation), 0, 0.001)
  const filter = new FacePoseSmoother()
  filter.update(poseAt(0), 0)
  let maxError = 0
  for (let i = 1; i <= 60; i++) maxError = Math.max(maxError, Math.abs(filter.update(poseAt(i % 2 ? 2 : -2), i * 1000 / 30).position.x))
  assert.ok(maxError < 1.2)
})

test('face loss, stale frames and reacquisition cannot reuse another face pose', () => {
  const filter = new FacePoseSmoother()
  filter.update(poseAt(0), 0)
  assert.equal(filter.update(poseAt(200), 600).position.x, 200)
  filter.reset()
  assert.equal(filter.update(poseAt(-200), 620).position.x, -200)
  assert.equal(isTrackingFrameFresh(null, 100), false)
  assert.equal(isTrackingFrameFresh({ timestampMs: 100 }, 200), true)
  assert.equal(isTrackingFrameFresh({ timestampMs: 100 }, 601), false)
  assert.equal(isTrackingFrameFresh({ timestampMs: 100 }, 99), false)
})

test('quaternions take the short path across the Euler wrap boundary', () => {
  const filter = new FacePoseSmoother()
  filter.update(poseAt(0, Math.PI - 0.01), 0)
  const value = filter.update(poseAt(0, -Math.PI + 0.01), 33)
  assert.ok(value.rotation.angleTo(poseAt(0, Math.PI).rotation) < 0.02)
})

function irisFace(width = 1280, height = 720, roll = 0) {
  const result = face(new Euler(0, 0, roll))
  const lm = result.faceLandmarks[0]
  const halfSpacing = (64 / 11.7 * 20) / 2
  const point = (x, y) => ({
    x: 0.5 + (x * Math.cos(roll) - y * Math.sin(roll)) / width,
    y: 0.5 + (x * Math.sin(roll) + y * Math.cos(roll)) / height,
    z: 0,
  })
  lm[33] = point(-halfSpacing - 20, 0)
  lm[263] = point(halfSpacing + 20, 0)
  for (const [center, cx] of [[468, -halfSpacing], [473, halfSpacing]]) {
    lm[center] = point(cx, 0)
    lm[center + 1] = point(cx + 10, 0)
    lm[center + 2] = point(cx, -10)
    lm[center + 3] = point(cx - 10, 0)
    lm[center + 4] = point(cx, 10)
  }
  lm[159] = point(-halfSpacing, -6); lm[145] = point(-halfSpacing, 6)
  lm[386] = point(halfSpacing, -6); lm[374] = point(halfSpacing, 6)
  return result
}

test('PD uses real pixels and iris centers across portrait, landscape and head roll', () => {
  for (const [width, height] of [[1280, 720], [720, 1280], [640, 480]]) {
    for (const roll of [0, 0.4, 0.8]) near(estimatePupillaryDistance(irisFace(width, height, roll), width, height), 64)
  }
})

test('PD clears on blinking, head turns, unreliable irises, missing data and invalid dimensions', () => {
  const blink = irisFace(); blink.faceLandmarks[0][159] = blink.faceLandmarks[0][145]
  assert.equal(estimatePupillaryDistance(blink, 1280, 720), null)
  const yaw = irisFace(); yaw.faceLandmarks[0][33].z = 0.1
  assert.equal(estimatePupillaryDistance(yaw, 1280, 720), null)
  const pitch = irisFace(); pitch.facialTransformationMatrixes = face(new Euler(0.6, 0, 0)).facialTransformationMatrixes
  assert.equal(estimatePupillaryDistance(pitch, 1280, 720), null)
  const small = irisFace(); small.faceLandmarks[0][469] = small.faceLandmarks[0][471]; small.faceLandmarks[0][470] = small.faceLandmarks[0][472]
  assert.equal(estimatePupillaryDistance(small, 1280, 720), null)
  const bad = irisFace(); bad.faceLandmarks[0][468].x = Infinity
  assert.equal(estimatePupillaryDistance(bad, 1280, 720), null)
  assert.equal(estimatePupillaryDistance({ faceLandmarks: [] }, 1280, 720), null)
  assert.equal(estimatePupillaryDistance(irisFace(), 0, 720), null)
})


test('face occlusion mesh reprojects to the detected face under combined mirrored rotations', () => {
  const result = face(new Euler(0.2, 0.4, -0.3))
  const pose = getFacePose(result, video, viewport)
  const positions = new Float32Array(468 * 3)
  assert.equal(updateFaceOcclusionPositions(result, video, viewport, pose, positions), true)
  const eyeZ = -(result.faceLandmarks[0][33].z + result.faceLandmarks[0][263].z) / 2 * video.width * viewport.height / video.height
  for (const index of [33, 263, 10, 152]) {
    const rendered = new Vector3().fromArray(positions, index * 3).multiplyScalar(pose.eyeDistance)
      .applyQuaternion(pose.rotation).add(pose.position)
    const expected = landmarkToWorld(result.faceLandmarks[0][index], video, viewport)
    expected.z -= eyeZ
    near(rendered.distanceTo(expected), 0, 0.0001)
  }
  result.faceLandmarks[0][100].z = NaN
  assert.equal(updateFaceOcclusionPositions(result, video, viewport, pose, positions), false)
})

test('adaptive filter follows fast translation without the lag of a fixed slow filter', () => {
  const filter = new FacePoseSmoother()
  filter.update(poseAt(0), 0)
  let output
  for (let i = 1; i <= 30; i++) output = filter.update(poseAt(i * 10), i * 1000 / 30)
  assert.ok(300 - output.position.x < 6, `Fast-motion lag: ${300 - output.position.x}px`)
})


test('lens anchor stays ahead of the nose bridge while the face mask preserves its depth', () => {
  const result = face()
  result.faceLandmarks[0][168] = {x:0.5,y:0.5,z:-40/video.width}
  const pose = getFacePose(result, video, viewport)
  const positions = new Float32Array(468*3)
  updateFaceOcclusionPositions(result, video, viewport, pose, positions)
  assert.ok(positions[168*3+2] < 0, 'The nose bridge must sit behind the front frame anchor')
  near(positions[168*3+2], -0.04)
})
