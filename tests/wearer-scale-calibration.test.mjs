import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Euler, Quaternion, Vector3 } from 'three'
import { CANONICAL_FACE_POINTS } from '../app/data/canonical-face.ts'
import { WearerScaleCalibrator } from '../app/lib/wearer-scale-calibration.ts'

const camera = { width: 1280, height: 720, fx: 920, fy: 920, cx: 640, cy: 360 }
const center = (a, b) => new Vector3(...CANONICAL_FACE_POINTS[a]).add(new Vector3(...CANONICAL_FACE_POINTS[b])).multiplyScalar(0.5)
const pupilA = center(33, 133)
const pupilB = center(263, 362)
const canonicalPdMm = pupilA.distanceTo(pupilB) * 10
const near = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`)

function frame(timestampMs = 0, options = {}) {
  const intrinsics = options.camera ?? camera
  const rotation = options.rotation ?? new Quaternion()
  const position = options.position ?? new Vector3(0.8, -0.4, -60)
  const project = point => {
    const p = point.clone().applyQuaternion(rotation).add(position)
    return { x: (intrinsics.cx - intrinsics.fx * p.x / p.z) / intrinsics.width, y: (intrinsics.cy + intrinsics.fy * p.y / p.z) / intrinsics.height, z: 0 }
  }
  const landmarks = CANONICAL_FACE_POINTS.map(p => project(new Vector3(...p)))
  // The four rim points are immaterial; the center IDs remain 468 and 473.
  for (let i = 0; i < 5; i++) landmarks.push(project(pupilA))
  for (let i = 0; i < 5; i++) landmarks.push(project(pupilB))
  return { camera: intrinsics, rotation, position, landmarks, timestampMs, reprojectionErrorPx: 0.8, inlierRatio: 0.95 }
}

function collect(calibrator, startMs = 0, options = {}) {
  let state
  for (let i = 0; i < 15; i++) state = calibrator.observe(frame(startMs + i * 34, options))
  return state
}

test('manual PD is optional and invalid references cannot become a metric calibration', () => {
  const calibrator = new WearerScaleCalibrator()
  assert.equal(collect(calibrator).status, 'disabled')
  for (const value of [0, 39.9, 85.1, NaN, Infinity]) {
    assert.equal(calibrator.configure(value, 'camera-1').status, 'invalid-reference')
    assert.equal(collect(calibrator).faceScale, null)
  }
  for (const value of [40, 85]) assert.equal(calibrator.configure(value, 'camera-1').status, 'collecting')
})

test('15 stable unique observations recover known scale from native intrinsics and raw eye depths', () => {
  const calibrator = new WearerScaleCalibrator()
  calibrator.configure(63, 'camera-1')
  for (let i = 0; i < 14; i++) assert.equal(calibrator.observe(frame(i * 34)).status, 'collecting')
  const ready = calibrator.observe(frame(14 * 34))
  assert.equal(ready.status, 'ready')
  assert.equal(ready.acceptedFrames, 15)
  near(ready.faceScale, 63 / canonicalPdMm)
  // A completed scale is not re-estimated from later poses or gaze changes.
  near(calibrator.observe(frame(1500, { rotation: new Quaternion().setFromEuler(new Euler(0, 0.6, 0)) })).faceScale, ready.faceScale)
})

test('portrait, noncentral intrinsics and permitted combined rotation retain separate eye depths', () => {
  const calibrator = new WearerScaleCalibrator()
  calibrator.configure(66, 'portrait')
  const options = {
    camera: { width: 720, height: 1280, fx: 780, fy: 810, cx: 325, cy: 612 },
    rotation: new Quaternion().setFromEuler(new Euler(-0.08, 0.12, 0.18, 'YXZ')),
    position: new Vector3(-1.2, 1.4, -55),
  }
  const ready = collect(calibrator, 0, options)
  assert.equal(ready.status, 'ready')
  near(ready.faceScale, 66 / canonicalPdMm)
})

test('duplicate or reversed timestamps cannot complete calibration; observation duration matters', () => {
  const calibrator = new WearerScaleCalibrator()
  calibrator.configure(63, 'camera-1')
  for (let i = 0; i < 30; i++) calibrator.observe(frame(100))
  assert.equal(calibrator.state.acceptedFrames, 1)
  calibrator.observe(frame(90))
  assert.equal(calibrator.state.acceptedFrames, 1)
  calibrator.reset()
  for (let i = 0; i < 15; i++) calibrator.observe(frame(i * 10))
  assert.equal(calibrator.state.status, 'collecting')
  for (let i = 15; i <= 40; i++) calibrator.observe(frame(i * 10))
  assert.equal(calibrator.state.status, 'ready')
})

test('camera, focal settings and manual reference changes invalidate an existing calibration', () => {
  const calibrator = new WearerScaleCalibrator()
  calibrator.configure(63, 'camera-1')
  collect(calibrator)
  assert.equal(calibrator.configure(63, 'camera-1').status, 'ready')
  assert.equal(calibrator.configure(63, 'camera-2').faceScale, null)
  collect(calibrator, 1000)
  assert.equal(calibrator.configure(64, 'camera-2').faceScale, null)
  collect(calibrator, 2000)
  const altered = frame(3000, { camera: { ...camera, fx: 950, fy: 950 } })
  const changed = calibrator.observe(altered)
  assert.equal(changed.status, 'collecting')
  assert.equal(changed.acceptedFrames, 1)
  assert.equal(changed.faceScale, null)
  assert.equal(calibrator.configure(null, 'camera-2').status, 'disabled')
})

test('profile, poor fit, missing iris, blink and small faces reject the observation', () => {
  const cases = [
    [f => { f.rotation.setFromEuler(new Euler(0, 0.4, 0)) }, 'look-straight'],
    [f => { f.rotation.setFromEuler(new Euler(0.3, 0, 0)) }, 'look-straight'],
    [f => { f.reprojectionErrorPx = 15 }, 'tracking-quality'],
    [f => { f.inlierRatio = 0.5 }, 'tracking-quality'],
    [f => { f.landmarks[468].x = NaN }, 'missing-iris'],
    [f => { f.landmarks[159] = f.landmarks[145] }, 'open-eyes'],
    [f => { f.position.z = NaN }, 'invalid-pose'],
    [f => { f.camera = { ...f.camera, fx: 0 } }, 'invalid-camera'],
  ]
  for (const [mutate, rejection] of cases) {
    const calibrator = new WearerScaleCalibrator()
    calibrator.configure(63, 'camera-1')
    const observation = frame()
    mutate(observation)
    const state = calibrator.observe(observation)
    assert.equal(state.rejection, rejection)
    assert.equal(state.acceptedFrames, 0)
    assert.equal(state.faceScale, null)
  }
  const distant = new WearerScaleCalibrator()
  distant.configure(63, 'camera-1')
  assert.equal(distant.observe(frame(0, { position: new Vector3(0, 0, -250) })).rejection, 'face-too-small')
})

test('tracking gaps and sudden pupil motion reset the stable sample window', () => {
  const calibrator = new WearerScaleCalibrator()
  calibrator.configure(63, 'camera-1')
  for (let i = 0; i < 10; i++) calibrator.observe(frame(i * 34))
  assert.equal(calibrator.observe(frame(1000)).acceptedFrames, 1)
  const moving = frame(1034)
  moving.landmarks[468].x += (moving.landmarks[133].x - moving.landmarks[33].x) * 0.09
  assert.equal(calibrator.observe(moving).rejection, 'keep-still')
  assert.equal(calibrator.state.acceptedFrames, 0)
  assert.equal(collect(calibrator, 2000).status, 'ready')
})

test('median tolerates tiny tracking noise while slow gaze drift cannot calibrate', () => {
  const calibrator = new WearerScaleCalibrator()
  calibrator.configure(63, 'camera-1')
  for (let i = 0; i < 15; i++) {
    const f = frame(i * 34)
    f.landmarks[468].x += (i % 2 ? 0.05 : -0.05) / camera.width
    calibrator.observe(f)
  }
  assert.equal(calibrator.state.status, 'ready')
  near(calibrator.state.faceScale, 63 / canonicalPdMm, 0.001)

  calibrator.reset()
  for (let i = 0; i < 15; i++) {
    const f = frame(i * 34)
    // Per-frame movement is small, but the whole window contains a gaze sweep.
    for (const [iris, outer, inner] of [[468, 33, 133], [473, 263, 362]]) {
      f.landmarks[iris].x += (f.landmarks[inner].x - f.landmarks[outer].x) * (i - 7) * 0.01
    }
    calibrator.observe(f)
  }
  assert.equal(calibrator.state.faceScale, null)
  assert.equal(calibrator.state.rejection, 'keep-still')
})

// Eye observations and fitted-pose metrics from the real frontal development
// fixture. This captures generic-model mismatch absent from exact-canonical
// synthetic tests. Repeated observations only exercise gating; they do not
// establish the person's true PD or real-video stability.
function realShapeFrame(timestampMs, resolutionScale = 1, noisePx = 0) {
  const points = {
    33: [0.36771062, 0.37773344], 133: [0.44477740, 0.38016713],
    145: [0.40383482, 0.38202602], 159: [0.39905286, 0.36443076],
    263: [0.61871737, 0.37514082], 362: [0.54240799, 0.37861720],
    374: [0.58276933, 0.37978604], 386: [0.58767730, 0.36233529],
    468: [0.40038276, 0.37315452], 473: [0.58592039, 0.37144321],
  }
  const size = 640 * resolutionScale
  const focal = size / (2 * Math.tan(Math.PI / 6))
  const landmarks = []
  for (const [index, [x, y]] of Object.entries(points)) {
    const noise = Math.sin(timestampMs * 0.013 + Number(index)) * noisePx / 640
    landmarks[Number(index)] = { x: x + noise, y: y - noise * 0.4 }
  }
  return {
    landmarks, timestampMs,
    position: new Vector3(-0.28841260, 1.95186415, -33.55628709),
    rotation: new Quaternion(0.05668529, 0.01088200, 0.00437105, 0.99832322).normalize(),
    camera: { width: size, height: size, fx: focal, fy: focal, cx: size / 2, cy: size / 2 },
    reprojectionErrorPx: 4.59332824 * resolutionScale,
    inlierRatio: 18 / 22,
  }
}

test('real-shape residuals with small pupil noise calibrate at multiple input resolutions', () => {
  const scales = []
  for (const resolutionScale of [0.5, 1, 2]) {
    const calibrator = new WearerScaleCalibrator()
    calibrator.configure(63, `source-${resolutionScale}`)
    for (let i = 0; i < 15; i++) calibrator.observe(realShapeFrame(i * 34, resolutionScale, 0.15))
    assert.equal(calibrator.state.status, 'ready')
    assert.ok(calibrator.state.faceScale > 0.65 && calibrator.state.faceScale < 1.5)
    scales.push(calibrator.state.faceScale)
  }
  near(scales[0], scales[1])
  near(scales[1], scales[2])
})

test('real-shape acceptance still rejects residuals beyond the normalized quality boundary', () => {
  for (const relativeError of [0.999, 1.001]) {
    const calibrator = new WearerScaleCalibrator()
    calibrator.configure(63, 'source')
    const observation = realShapeFrame(0)
    const a = observation.landmarks[33], b = observation.landmarks[263]
    const span = Math.hypot((a.x - b.x) * 640, (a.y - b.y) * 640)
    observation.reprojectionErrorPx = span * 0.035 * relativeError
    const state = calibrator.observe(observation)
    assert.equal(state.acceptedFrames, relativeError < 1 ? 1 : 0)
    assert.equal(state.rejection, relativeError < 1 ? null : 'tracking-quality')
  }
})

test('a slower device can calibrate while observations remain within the tracking freshness window', () => {
  const calibrator = new WearerScaleCalibrator()
  calibrator.configure(63, 'source')
  for (let i = 0; i < 15; i++) calibrator.observe(realShapeFrame(i * 333))
  assert.equal(calibrator.state.status, 'ready')
})
