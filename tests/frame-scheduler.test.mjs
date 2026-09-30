import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { TRACKING_TIMEOUT_MS } from '../app/lib/face-tracking.ts'

// Exercise the real hook effect with a deterministic browser clock and deferred inference.
// React rendering and the detector itself are outside this scheduler's contract.
const source = readFileSync(new URL('../app/hooks/useFaceLandmarker.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText

async function flushPromises() {
  for (let turn = 0; turn < 8; turn++) await Promise.resolve()
}

function eventTarget() {
  const listeners = new Map()
  return {
    listeners,
    addEventListener(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(listener)
    },
    removeEventListener(event, listener) {
      listeners.get(event)?.delete(listener)
    },
    emit(event) {
      listeners.get(event)?.forEach(listener => listener())
    },
  }
}

function createHarness({ videoFrameCallbacks = true } = {}) {
  let now = 0
  let nextId = 1
  let effect
  let cleanup
  let closeCount = 0
  let abortSignal
  const animationFrames = new Map()
  const videoFrames = new Map()
  const timers = new Map()
  const results = []
  const detections = []
  const states = []
  const document = { ...eventTarget(), hidden: false }
  const video = {
    ...eventTarget(),
    paused: false,
    ended: false,
    seeking: false,
    readyState: 2,
    videoWidth: 640,
    videoHeight: 480,
    currentTime: 0,
  }

  if (videoFrameCallbacks) {
    video.requestVideoFrameCallback = callback => {
      const id = nextId++
      videoFrames.set(id, callback)
      return id
    }
    video.cancelVideoFrameCallback = id => videoFrames.delete(id)
  }

  const engine = {
    detect(source, timestamp) {
      return new Promise((resolve, reject) => {
        detections.push({ source, timestamp, resolve, reject })
      })
    },
    close() {
      closeCount++
    },
  }
  const exports = {}
  runInNewContext(compiled, {
    exports,
    require(name) {
      if (name === 'react') {
        return {
          useEffect: callback => { effect = callback },
          useEffectEvent: callback => callback,
          useState: initial => [initial, state => states.push(state)],
        }
      }
      if (name === '@/app/lib/face-tracking') return { TRACKING_TIMEOUT_MS }
      if (name === '@/app/lib/tracking-engine') {
        return {
          createTrackingEngine: async signal => {
            abortSignal = signal
            return engine
          },
        }
      }
      throw new Error(`Unexpected scheduler dependency: ${name}`)
    },
    performance: { now: () => now },
    document,
    AbortController,
    console: { error() {} },
    requestAnimationFrame(callback) {
      const id = nextId++
      animationFrames.set(id, callback)
      return id
    },
    cancelAnimationFrame(id) {
      animationFrames.delete(id)
    },
    setTimeout(callback, delay) {
      const id = nextId++
      timers.set(id, { callback, expiresAt: now + delay })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
  })
  exports.useFaceLandmarker({ current: video }, (result, timestamp) => {
    results.push({ result, timestamp })
  })

  return {
    video,
    document,
    animationFrames,
    videoFrames,
    timers,
    results,
    detections,
    states,
    get closeCount() { return closeCount },
    get abortSignal() { return abortSignal },
    async start() {
      cleanup = effect()
      await flushPromises()
    },
    frame(mediaTime, capturedAt, currentTime = mediaTime) {
      now = capturedAt
      video.currentTime = currentTime
      const callbacks = videoFrameCallbacks ? videoFrames : animationFrames
      const entry = callbacks.entries().next().value
      assert.ok(entry, 'a frame callback must be scheduled')
      const [id, callback] = entry
      callbacks.delete(id)
      // A callback's supplied timestamp may predate actual image acquisition.
      callback(capturedAt - 10, { mediaTime })
    },
    advanceTo(timestamp) {
      now = timestamp
      for (const [id, timer] of [...timers]) {
        if (timer.expiresAt <= now) {
          timers.delete(id)
          timer.callback()
        }
      }
    },
    stop() {
      cleanup()
    },
  }
}

test('video callbacks use actual acquisition time instead of the older callback timestamp', async t => {
  const harness = createHarness()
  await harness.start()
  t.after(() => harness.stop())
  assert.equal(harness.videoFrames.size, 1)
  assert.equal(harness.animationFrames.size, 0)

  harness.frame(1, 50)
  assert.equal(harness.detections[0].timestamp, 50)
  harness.detections[0].resolve({ face: 'tracked' })
  await flushPromises()
  assert.equal(harness.results[0].timestamp, 50)
})

test('deduplicates mediaTime and keeps only one inference in flight', async t => {
  const harness = createHarness()
  await harness.start()
  t.after(() => harness.stop())

  harness.frame(1, 50)
  harness.frame(1.1, 60)
  assert.equal(harness.detections.length, 1)
  harness.detections[0].resolve({ face: 'tracked' })
  await flushPromises()

  harness.frame(1, 70, 1.2)
  assert.equal(harness.detections.length, 1, 'deduplication uses mediaTime, not currentTime')
  harness.frame(1.3, 80)
  assert.equal(harness.detections.length, 2)
  assert.equal(harness.videoFrames.size, 1)
})

test('expires a result when a stalled video delivers no further callbacks', async t => {
  const harness = createHarness()
  await harness.start()
  t.after(() => harness.stop())
  harness.frame(1, 50)
  harness.advanceTo(150)
  harness.detections[0].resolve({ face: 'tracked' })
  await flushPromises()

  harness.advanceTo(50 + TRACKING_TIMEOUT_MS - 1)
  assert.equal(harness.results.length, 1)
  harness.advanceTo(50 + TRACKING_TIMEOUT_MS)
  assert.equal(harness.results.length, 2)
  assert.equal(harness.results[1].result, null)
})

test('never publishes inference that completes after its freshness deadline', async t => {
  const harness = createHarness()
  await harness.start()
  t.after(() => harness.stop())
  harness.frame(1, 50)
  harness.advanceTo(51 + TRACKING_TIMEOUT_MS)
  harness.detections[0].resolve({ face: 'too old' })
  await flushPromises()
  assert.equal(harness.results.length, 0)
})

const lifecycleTransitions = [
  {
    name: 'pause and resume',
    suspend(harness) {
      harness.video.paused = true
      harness.video.emit('pause')
    },
    resume(harness) {
      harness.video.paused = false
      harness.video.emit('playing')
    },
  },
  {
    name: 'background and foreground',
    suspend(harness) {
      harness.document.hidden = true
      harness.document.emit('visibilitychange')
    },
    resume(harness) {
      harness.document.hidden = false
      harness.document.emit('visibilitychange')
    },
  },
  {
    name: 'seek and restart',
    suspend(harness) {
      harness.video.seeking = true
      harness.video.emit('seeking')
    },
    resume(harness) {
      harness.video.seeking = false
      harness.video.emit('seeked')
    },
  },
]

for (const transition of lifecycleTransitions) {
  test(`${transition.name} clears the pose and rejects pre-transition inference`, async t => {
    const harness = createHarness()
    await harness.start()
    t.after(() => harness.stop())
    harness.frame(1, 50)
    harness.detections[0].resolve({ face: 'initial' })
    await flushPromises()
    harness.frame(2, 100)

    transition.suspend(harness)
    assert.equal(harness.videoFrames.size, 0)
    assert.equal(harness.results[1].result, null)
    transition.resume(harness)
    assert.equal(harness.videoFrames.size, 1)
    harness.detections[1].resolve({ face: 'before transition' })
    await flushPromises()
    assert.equal(harness.results.length, 2)

    harness.frame(2, 150)
    assert.equal(harness.detections.length, 3, 'the same mediaTime can be acquired after reset')
    harness.detections[2].resolve({ face: 'fresh' })
    await flushPromises()
    assert.equal(harness.results.length, 3)
    assert.equal(harness.results[2].result.face, 'fresh')
  })
}

test('falls back to rAF and skips duplicate video frames', async t => {
  const harness = createHarness({ videoFrameCallbacks: false })
  await harness.start()
  t.after(() => harness.stop())
  assert.equal(harness.animationFrames.size, 1)
  assert.equal(harness.videoFrames.size, 0)

  harness.frame(1, 100)
  harness.detections[0].resolve({ face: 'tracked' })
  await flushPromises()
  harness.frame(1, 110)
  assert.equal(harness.detections.length, 1)
  harness.frame(2, 120)
  assert.equal(harness.detections.length, 2)
})

test('five consecutive detection failures abort the engine and stop scheduling', async t => {
  const harness = createHarness()
  await harness.start()
  t.after(() => harness.stop())
  for (let frame = 0; frame < 5; frame++) {
    harness.frame(frame, frame * 20)
    harness.detections[frame].reject(new Error('Detection failed'))
    await flushPromises()
  }

  assert.equal(harness.videoFrames.size, 0)
  assert.equal(harness.closeCount, 1)
  assert.ok(harness.abortSignal.aborted)
  assert.match(harness.states.at(-1).error, /Please retry/)
})

test('cleanup cancels callbacks, timers and listeners and ignores pending results', async () => {
  const harness = createHarness()
  await harness.start()
  harness.frame(1, 50)
  harness.detections[0].resolve({ face: 'tracked' })
  await flushPromises()
  harness.frame(2, 100)
  harness.stop()

  assert.equal(harness.videoFrames.size, 0)
  assert.equal(harness.animationFrames.size, 0)
  assert.equal(harness.timers.size, 0)
  assert.ok(harness.abortSignal.aborted)
  for (const listeners of harness.video.listeners.values()) assert.equal(listeners.size, 0)
  for (const listeners of harness.document.listeners.values()) assert.equal(listeners.size, 0)
  harness.detections[1].resolve({ face: 'after unmount' })
  await flushPromises()
  assert.equal(harness.results.length, 1)
})
