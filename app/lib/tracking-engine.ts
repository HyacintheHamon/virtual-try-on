import type { FaceLandmarkerResult } from '@mediapipe/tasks-vision'

import { WASM_URL, MODEL_URL } from './tracking-config'

export interface TrackingEngine {
  detect(video: HTMLVideoElement, timestampMs: number): Promise<FaceLandmarkerResult>
  close(): void
}

export type WorkerRequest = { type: 'init' } | { type: 'frame'; bitmap: ImageBitmap; timestampMs: number }
export type WorkerResponse =
  | { type: 'ready'; delegate: 'GPU' | 'CPU' }
  | { type: 'result'; result: FaceLandmarkerResult }
  | { type: 'error'; message: string }

const abortError = () => new DOMException('Tracking cancelled', 'AbortError')

async function createWorkerEngine(signal: AbortSignal): Promise<TrackingEngine> {
  const worker = new Worker(new URL('../workers/face-landmarker.worker.ts', import.meta.url))
  let closed = false
  let warmedUp = false
  let pending: { resolve: (result: FaceLandmarkerResult) => void; reject: (error: Error) => void } | null = null
  let frameTimeout: ReturnType<typeof setTimeout> | undefined
  let initTimeout: ReturnType<typeof setTimeout> | undefined
  let rejectInit: (error: Error) => void = () => {}

  function close() {
    if (closed) return
    closed = true
    clearTimeout(initTimeout)
    clearTimeout(frameTimeout)
    signal.removeEventListener('abort', close)
    worker.terminate()
    rejectInit(abortError())
    pending?.reject(abortError())
    pending = null
  }
  signal.addEventListener('abort', close, { once: true })

  try {
    await new Promise<void>((resolve, reject) => {
      rejectInit = reject
      initTimeout = setTimeout(() => reject(new Error('Worker initialization timed out')), 15000)
      worker.onerror = event => {
        const error = new Error(event.message || 'Face tracking worker failed')
        reject(error)
        clearTimeout(frameTimeout)
        pending?.reject(error)
        pending = null
      }
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const response = event.data
        if (response.type === 'ready') {
          clearTimeout(initTimeout)
          resolve()
        } else if (response.type === 'result') {
          warmedUp = true
          clearTimeout(frameTimeout)
          pending?.resolve(response.result)
          pending = null
        } else {
          const error = new Error(response.message)
          reject(error)
          clearTimeout(frameTimeout)
          pending?.reject(error)
          pending = null
        }
      }
      worker.postMessage({ type: 'init' } satisfies WorkerRequest)
    })
    if (signal.aborted) throw abortError()
  } catch (error) {
    close()
    throw error
  }

  return {
    async detect(video, timestampMs) {
      if (closed) throw abortError()
      if (pending) throw new Error('A tracking frame is already in flight')
      const bitmap = await createImageBitmap(video)
      if (closed) {
        bitmap.close()
        throw abortError()
      }
      return new Promise<FaceLandmarkerResult>((resolve, reject) => {
        pending = { resolve, reject }
        frameTimeout = setTimeout(() => {
          pending?.reject(new Error('Face tracking frame timed out'))
          pending = null
          close()
        }, warmedUp ? 2000 : 15000)
        try {
          worker.postMessage({ type: 'frame', bitmap, timestampMs } satisfies WorkerRequest, [bitmap])
        } catch (error) {
          bitmap.close()
          clearTimeout(frameTimeout)
          pending = null
          reject(error)
        }
      })
    },
    close,
  }
}

/** Prefer off-thread inference; retain a GPU/CPU main-thread fallback for browsers without it. */
export async function createTrackingEngine(signal: AbortSignal): Promise<TrackingEngine> {
  if (signal.aborted) throw abortError()
  if (typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function') {
    try {
      let active = await createWorkerEngine(signal)
      let usingWorker = true
      return {
        async detect(video, timestampMs) {
          try {
            return await active.detect(video, timestampMs)
          } catch (error) {
            if (signal.aborted || !usingWorker) throw error
            usingWorker = false
            active.close()
            console.warn('Worker inference failed; switching to CPU fallback.', error)
            active = await createMainThreadEngine(signal, 'CPU')
            return active.detect(video, timestampMs)
          }
        },
        close: () => active.close(),
      }
    } catch (error) {
      if (signal.aborted) throw abortError()
      console.warn('Off-thread tracking unavailable; using browser fallback.', error)
    }
  }
  return createMainThreadEngine(signal)
}

async function createMainThreadEngine(signal: AbortSignal, preferred: 'GPU' | 'CPU' = 'GPU'): Promise<TrackingEngine> {
  const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision')
  if (signal.aborted) throw abortError()
  const vision = await FilesetResolver.forVisionTasks(WASM_URL)
  if (signal.aborted) throw abortError()
  const create = (delegate: 'GPU' | 'CPU') => FaceLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: 'VIDEO', numFaces: 1,
    minFaceDetectionConfidence: 0.6, minFacePresenceConfidence: 0.6, minTrackingConfidence: 0.6,
    outputFacialTransformationMatrixes: true,
  })
  let landmarker
  try {
    landmarker = await create(preferred)
  } catch (error) {
    if (signal.aborted) throw abortError()
    console.warn('GPU face tracking unavailable; trying CPU.', error)
    landmarker = await create('CPU')
  }
  if (signal.aborted) {
    landmarker.close()
    throw abortError()
  }
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    signal.removeEventListener('abort', close)
    landmarker.close()
  }
  signal.addEventListener('abort', close, { once: true })
  return {
    async detect(video, timestampMs) {
      if (closed) throw abortError()
      return landmarker.detectForVideo(video, timestampMs)
    },
    close,
  }
}
