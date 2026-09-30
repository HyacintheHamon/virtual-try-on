import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'
import { MODEL_URL, WASM_URL } from '../lib/tracking-config'
import type { WorkerRequest, WorkerResponse } from '../lib/tracking-engine'

let landmarker: FaceLandmarker | null = null
const send = (response: WorkerResponse) => self.postMessage(response)

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data
  try {
    if (message.type === 'init') {
      // Next.js emits a classic worker bundle; use the matching classic WASM loader.
      const vision = await FilesetResolver.forVisionTasks(WASM_URL)
      const create = (delegate: 'GPU' | 'CPU') => FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate },
        canvas: new OffscreenCanvas(1, 1),
        runningMode: 'VIDEO', numFaces: 1,
        minFaceDetectionConfidence: 0.6, minFacePresenceConfidence: 0.6, minTrackingConfidence: 0.6,
        outputFacialTransformationMatrixes: true,
      })
      // Software WebGL is slower than XNNPACK CPU inference, especially at startup.
      const probe = new OffscreenCanvas(1, 1).getContext('webgl2')
      const debug = probe?.getExtension('WEBGL_debug_renderer_info')
      const renderer = debug ? String(probe?.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : ''
      let delegate: 'GPU' | 'CPU' = !probe || /swiftshader|llvmpipe|software/i.test(renderer) ? 'CPU' : 'GPU'
      probe?.getExtension('WEBGL_lose_context')?.loseContext()
      try {
        landmarker = await create(delegate)
      } catch (error) {
        if (delegate === 'CPU') throw error
        delegate = 'CPU'
        landmarker = await create(delegate)
      }
      send({ type: 'ready', delegate })
    } else {
      try {
        if (!landmarker) throw new Error('Face tracker is not ready')
        send({ type: 'result', result: landmarker.detectForVideo(message.bitmap, message.timestampMs) })
      } finally {
        message.bitmap.close()
      }
    }
  } catch (error) {
    send({ type: 'error', message: error instanceof Error ? error.message : 'Face tracking failed' })
  }
}
