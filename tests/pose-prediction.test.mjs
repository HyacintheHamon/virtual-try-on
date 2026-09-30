import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Quaternion, Vector3 } from 'three'
import { FacePosePredictor } from '../app/lib/pose-prediction.ts'

const poseAt = (x, angle = 0) => ({
  position: new Vector3(x, 0, 0),
  rotation: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), angle),
  eyeDistance: 100,
})
const near = (a, b, epsilon = 1e-6) => assert.ok(Math.abs(a - b) < epsilon, `${a} != ${b}`)

test('render-time prediction compensates a 40ms inference delay in steady movement', () => {
  for (const fps of [15, 30, 60]) {
    const predictor = new FacePosePredictor()
    for (let i = 0; i <= fps; i++) {
      const pose = poseAt(i / fps * 100, i / fps)
      predictor.update(pose, pose, i / fps * 1000)
    }
    const predicted = predictor.sample(1040)
    const truth = poseAt(104, 1.04)
    assert.ok(predicted.position.distanceTo(truth.position) < 0.01)
    assert.ok(predicted.rotation.angleTo(truth.rotation) < 0.001)
    near(predicted.eyeDistance, 100)
  }
})

test('prediction is bounded in time, translation and rotation and stops scheduling renders', () => {
  const predictor = new FacePosePredictor()
  for (let i = 0; i < 20; i++) {
    const pose = poseAt(i * 20, i * 0.2)
    predictor.update(pose, pose, i * 33)
  }
  const base = poseAt(380, 3.8)
  const predicted = predictor.sample(20 * 33 + 10000)
  assert.ok(predicted.position.distanceTo(base.position) <= 5.000001)
  assert.ok(predicted.rotation.angleTo(base.rotation) <= 0.080001)
  near(predicted.position.distanceTo(predictor.sample(19 * 33 + 60).position), 0)
  assert.equal(predictor.needsRender(19 * 33 + 30), true)
  assert.equal(predictor.needsRender(19 * 33 + 60), false)
  near(predictor.sample(0).position.distanceTo(base.position), 0)
})

test('a stop or reversal immediately cancels forward momentum', () => {
  for (const reverse of [false, true]) {
    const predictor = new FacePosePredictor()
    for (let i = 0; i < 10; i++) {
      const pose = poseAt(i, i * 0.02)
      predictor.update(pose, pose, i * 33)
    }
    const stopped = poseAt(reverse ? 8 : 9, reverse ? 0.16 : 0.18)
    predictor.update(stopped, stopped, 330)
    const predicted = predictor.sample(370)
    near(predicted.position.distanceTo(stopped.position), 0)
    near(predicted.rotation.angleTo(stopped.rotation), 0)
    assert.equal(predictor.needsRender(370), false)
  }
})

test('reacquisition, large jumps and reset cannot reuse the preceding velocity', () => {
  for (const [timestamp, target] of [[1000, poseAt(3, 0.03)], [66, poseAt(100, 1)]]) {
    const predictor = new FacePosePredictor()
    predictor.update(poseAt(0), poseAt(0), 0)
    predictor.update(poseAt(2, 0.02), poseAt(2, 0.02), 33)
    predictor.update(target, target, timestamp)
    near(predictor.sample(timestamp + 40).position.distanceTo(target.position), 0)
    near(predictor.sample(timestamp + 40).rotation.angleTo(target.rotation), 0)
    predictor.reset()
    assert.equal(predictor.sample(timestamp + 50), null)
    assert.equal(predictor.needsRender(timestamp + 50), false)
  }
})

test('quaternion sign changes and stationary noise do not create a spin or drift', () => {
  const predictor = new FacePosePredictor()
  for (let i = 0; i < 30; i++) {
    const pose = poseAt(i % 2 ? 0.01 : -0.01, i % 2 ? 0.0005 : -0.0005)
    if (i % 2) pose.rotation.set(-pose.rotation.x, -pose.rotation.y, -pose.rotation.z, -pose.rotation.w)
    predictor.update(pose, pose, i * 33)
    near(predictor.sample(i * 33 + 40).position.distanceTo(pose.position), 0)
    near(predictor.sample(i * 33 + 40).rotation.angleTo(pose.rotation), 0)
    assert.equal(predictor.needsRender(i * 33 + 40), false)
  }
})
