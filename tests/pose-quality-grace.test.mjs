import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PoseQualityGrace, POSE_QUALITY_GRACE_MS } from '../app/lib/pose-quality-grace.ts'
import { TRACKING_TIMEOUT_MS } from '../app/lib/face-tracking.ts'

test('one borderline rejection holds only for a fixed grace window', () => {
  const grace = new PoseQualityGrace()
  grace.accept(100)
  assert.equal(grace.needsRender(130), false, 'render polling cannot start grace')
  assert.equal(grace.reject(140), true)
  assert.equal(grace.needsRender(140), true)
  assert.equal(grace.reject(140 + POSE_QUALITY_GRACE_MS - 1), true)
  assert.equal(grace.reject(140 + POSE_QUALITY_GRACE_MS), false)
  assert.equal(grace.needsRender(140 + POSE_QUALITY_GRACE_MS), false)
})

test('repeated rejected observations and render polling never extend grace', () => {
  const grace = new PoseQualityGrace()
  grace.accept(100)
  assert.equal(grace.reject(120), true)
  for (const now of [130, 150, 190, 239]) {
    assert.equal(grace.reject(now), true)
    assert.equal(grace.needsRender(now), true)
  }
  for (const now of [240, 250, 300, 400]) {
    assert.equal(grace.reject(now), false)
    assert.equal(grace.needsRender(now), false)
  }
})

test('the last accepted capture deadline can end grace before 120 milliseconds', () => {
  const grace = new PoseQualityGrace()
  grace.accept(100)
  const deadline = 100 + TRACKING_TIMEOUT_MS
  assert.equal(grace.reject(deadline - 20), true)
  assert.equal(grace.reject(deadline), true)
  assert.equal(grace.reject(deadline + 1), false)
  assert.equal(grace.needsRender(deadline + 1), false)
})

test('a new acceptance recovers immediately, while duplicate or older acceptance cannot refresh grace', () => {
  const grace = new PoseQualityGrace()
  grace.accept(100)
  grace.reject(120)
  assert.equal(grace.reject(240), false)
  for (const timestamp of [90, 100]) {
    grace.accept(timestamp)
    assert.equal(grace.reject(250), false)
  }
  grace.accept(260)
  assert.equal(grace.needsRender(270), false)
  assert.equal(grace.reject(280), true)
  assert.equal(grace.reject(400), false)
})

test('explicit lifecycle reset removes a pose immediately and requires a new acceptance', () => {
  const grace = new PoseQualityGrace()
  grace.accept(100)
  assert.equal(grace.reject(120), true)
  grace.reset()
  assert.equal(grace.needsRender(121), false)
  assert.equal(grace.reject(121), false)
  grace.accept(150)
  assert.equal(grace.reject(160), true)
})

test('missing, non-finite, future and backwards timestamps fail closed', () => {
  const grace = new PoseQualityGrace()
  assert.equal(grace.reject(10), false)
  for (const invalid of [NaN, Infinity, -Infinity, -1]) {
    grace.accept(100)
    grace.accept(invalid)
    assert.equal(grace.reject(120), false)
    grace.accept(100)
    assert.equal(grace.reject(invalid), false)
    assert.equal(grace.needsRender(120), false)
  }
  grace.accept(200)
  assert.equal(grace.reject(199), false, 'a future capture cannot authorize a hold')
  assert.equal(grace.reject(201), false, 'an invalid clock discards the capture')
  grace.accept(100)
  assert.equal(grace.reject(150), true)
  assert.equal(grace.reject(149), false, 'time cannot move backwards within grace')
  assert.equal(grace.reject(151), false)
})
