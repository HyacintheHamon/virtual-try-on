import { Quaternion, Vector3 } from 'three'
import { CANONICAL_FACE_POINTS } from '../data/canonical-face.ts'
import { TRACKING_TIMEOUT_MS } from './face-tracking.ts'

export const WEARER_CALIBRATION_FRAMES = 15
export const MIN_KNOWN_PD_MM = 40
export const MAX_KNOWN_PD_MM = 85

interface ImagePoint { x: number; y: number }
interface CalibrationCamera {
  width: number
  height: number
  fx: number
  fy: number
  cx: number
  cy: number
}

export interface WearerCalibrationFrame {
  landmarks: readonly ImagePoint[]
  /** Raw, UNSCALED canonical-face origin, in centimeters, in a Three camera space. */
  position: Vector3
  /** Unmirrored rotation: +Y up; visible points have negative camera Z. */
  rotation: Quaternion
  /** Intrinsics and dimensions of the input video, before cover-crop or mirroring. */
  camera: CalibrationCamera
  timestampMs: number
  reprojectionErrorPx: number
  inlierRatio: number
}

export type WearerCalibrationRejection =
  | 'missing-iris' | 'invalid-camera' | 'invalid-pose' | 'tracking-quality'
  | 'look-straight' | 'face-too-small' | 'open-eyes' | 'keep-still' | 'out-of-range'

export interface WearerCalibrationState {
  status: 'disabled' | 'invalid-reference' | 'collecting' | 'ready'
  acceptedFrames: number
  requiredFrames: number
  faceScale: number | null
  rejection: WearerCalibrationRejection | null
}

interface Observation {
  scale: number
  gaze: number[]
  timestampMs: number
}

const eyes = [
  { iris: 468, outer: 33, inner: 133, top: 159, bottom: 145 },
  { iris: 473, outer: 263, inner: 362, top: 386, bottom: 374 },
] as const
const eyeCenters = eyes.map(({ outer, inner }) => new Vector3(...CANONICAL_FACE_POINTS[outer])
  .add(new Vector3(...CANONICAL_FACE_POINTS[inner])).multiplyScalar(0.5))

function median(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function finitePoint(point: ImagePoint | undefined): point is ImagePoint {
  return !!point && Number.isFinite(point.x) && Number.isFinite(point.y) &&
    point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1
}

function validCamera(camera: CalibrationCamera) {
  return [camera.width, camera.height, camera.fx, camera.fy].every(value => Number.isFinite(value) && value > 0) &&
    Number.isFinite(camera.cx) && Number.isFinite(camera.cy)
}

/**
 * Optional metric reference, supplied explicitly by the wearer. Never feed the app's
 * image-derived PD estimate back into this API: that would be a circular calibration.
 * The result still depends on the generic eye-depth model and camera intrinsics; it
 * is not an optical fitting measurement. A completed scale is held for this session.
 */
export class WearerScaleCalibrator {
  private knownPdMm: number | null = null
  private cameraKey = ''
  private intrinsicsKey = ''
  private observations: Observation[] = []
  private lastTimestampMs = -Infinity
  private result: WearerCalibrationState = this.emptyState()

  get state(): WearerCalibrationState { return { ...this.result } }

  /** Use a stable camera/device identity, not a frame-specific key. */
  configure(knownPdMm: number | null, cameraKey: string) {
    if (Object.is(knownPdMm, this.knownPdMm) && cameraKey === this.cameraKey) return this.state
    this.knownPdMm = knownPdMm
    this.cameraKey = cameraKey
    this.reset()
    return this.state
  }

  reset() {
    this.observations = []
    this.lastTimestampMs = -Infinity
    this.intrinsicsKey = ''
    this.result = this.emptyState()
    return this.state
  }

  private emptyState(): WearerCalibrationState {
    return {
      status: this.knownPdMm === null ? 'disabled' :
        Number.isFinite(this.knownPdMm) && this.knownPdMm >= MIN_KNOWN_PD_MM && this.knownPdMm <= MAX_KNOWN_PD_MM
          ? 'collecting' : 'invalid-reference',
      acceptedFrames: 0,
      requiredFrames: WEARER_CALIBRATION_FRAMES,
      faceScale: null,
      rejection: null,
    }
  }

  private reject(rejection: WearerCalibrationRejection) {
    // Require a continuous stable observation, rather than mixing different gazes
    // or tracking reacquisitions into an apparently reliable median.
    this.observations = []
    this.result = { ...this.emptyState(), rejection }
    return this.state
  }

  observe(frame: WearerCalibrationFrame): WearerCalibrationState {
    if (this.result.status === 'disabled' || this.result.status === 'invalid-reference') return this.state
    if (!validCamera(frame.camera)) return this.reject('invalid-camera')
    const { width, height, fx, fy, cx, cy } = frame.camera
    const intrinsicsKey = [width, height, fx, fy, cx, cy].join(':')
    // Resolution, focal estimate and device changes all invalidate the reference.
    if (this.intrinsicsKey && intrinsicsKey !== this.intrinsicsKey) this.reset()
    this.intrinsicsKey = intrinsicsKey
    if (this.result.status === 'ready') return this.state

    if (!Number.isFinite(frame.timestampMs)) return this.reject('invalid-pose')
    if (frame.timestampMs <= this.lastTimestampMs) return this.state
    if (frame.timestampMs - this.lastTimestampMs > TRACKING_TIMEOUT_MS && this.observations.length) this.reject('keep-still')
    this.lastTimestampMs = frame.timestampMs
    if (!frame.position.toArray().every(Number.isFinite) || !frame.rotation.toArray().every(Number.isFinite) ||
      Math.abs(frame.rotation.lengthSq() - 1) > 0.01 || frame.position.z >= -10) return this.reject('invalid-pose')

    const normal = new Vector3(0, 0, 1).applyQuaternion(frame.rotation)
    const yaw = Math.atan2(normal.x, normal.z)
    const pitch = Math.atan2(-normal.y, Math.hypot(normal.x, normal.z))
    if (Math.abs(yaw) > Math.PI / 18 || Math.abs(pitch) > Math.PI / 18) return this.reject('look-straight')

    const pupils: Vector3[] = []
    const gaze: number[] = []
    for (const [index, eye] of eyes.entries()) {
      const iris = frame.landmarks[eye.iris]
      const outer = frame.landmarks[eye.outer]
      const inner = frame.landmarks[eye.inner]
      if (!finitePoint(iris) || !finitePoint(outer) || !finitePoint(inner)) return this.reject('missing-iris')
      const dx = (inner.x - outer.x) * width
      const dy = (inner.y - outer.y) * height
      const eyeWidth = Math.hypot(dx, dy)
      if (eyeWidth < 12) return this.reject('face-too-small')
      const ix = (iris.x - outer.x) * width
      const iy = (iris.y - outer.y) * height
      const along = (ix * dx + iy * dy) / (eyeWidth * eyeWidth)
      const across = (ix * -dy + iy * dx) / (eyeWidth * eyeWidth)
      if (along < 0.2 || along > 0.8 || Math.abs(across) > 0.25) return this.reject('look-straight')
      const top = frame.landmarks[eye.top]
      const bottom = frame.landmarks[eye.bottom]
      if (!finitePoint(top) || !finitePoint(bottom)) return this.reject('missing-iris')
      const aperture = Math.abs(((bottom.x - top.x) * width * -dy + (bottom.y - top.y) * height * dx) / eyeWidth)
      if (aperture / eyeWidth < 0.08) return this.reject('open-eyes')
      gaze.push(along, across)

      // Use each eye's own transformed depth, so a small permitted yaw does not
      // force both pupils onto a common front-facing plane. Ignore landmark Z.
      const depth = -eyeCenters[index].clone().applyQuaternion(frame.rotation).add(frame.position).z
      if (!Number.isFinite(depth) || depth < 5) return this.reject('invalid-pose')
      pupils.push(new Vector3((iris.x * width - cx) * depth / fx, (cy - iris.y * height) * depth / fy, -depth))
    }

    const irisA = frame.landmarks[468]
    const irisB = frame.landmarks[473]
    const pupilPixels = Math.hypot((irisA.x - irisB.x) * width, (irisA.y - irisB.y) * height)
    if (pupilPixels < 40) return this.reject('face-too-small')
    const outerA = frame.landmarks[33]
    const outerB = frame.landmarks[263]
    const outerEyePixels = Math.hypot((outerA.x - outerB.x) * width, (outerA.y - outerB.y) * height)
    // Canonical-shape mismatch creates nonzero residuals even on a still, well
    // observed real face. Use the fitter's outer-eye scale and robust-loss
    // transition (3.5%), below its 5.5% rendering acceptance threshold. The
    // iris/gaze and temporal checks remain independent; low RMS alone is not
    // evidence of a valid personal measurement.
    if (!Number.isFinite(frame.reprojectionErrorPx) || frame.reprojectionErrorPx < 0 ||
      frame.reprojectionErrorPx > Math.max(2, outerEyePixels * 0.035) ||
      !Number.isFinite(frame.inlierRatio) || frame.inlierRatio < 0.75 || frame.inlierRatio > 1) {
      return this.reject('tracking-quality')
    }
    const scale = this.knownPdMm! / (10 * pupils[0].distanceTo(pupils[1]))
    if (!Number.isFinite(scale) || scale < 0.65 || scale > 1.5) return this.reject('out-of-range')
    const previous = this.observations.at(-1)
    if (previous && (gaze.some((value, i) => Math.abs(value - previous.gaze[i]) > 0.05) ||
      Math.abs(scale / median(this.observations.map(observation => observation.scale)) - 1) > 0.06)) {
      return this.reject('keep-still')
    }
    this.observations.push({ scale, gaze, timestampMs: frame.timestampMs })
    // Limit memory even when very high camera rates need more than 15 frames to
    // cover the minimum duration. Normal camera frame rates keep all samples.
    if (this.observations.length > 120) this.observations.shift()
    this.result = { ...this.emptyState(), acceptedFrames: Math.min(this.observations.length, WEARER_CALIBRATION_FRAMES) }
    if (this.observations.length < WEARER_CALIBRATION_FRAMES || frame.timestampMs - this.observations[0].timestampMs < 400) return this.state

    const scales = this.observations.map(observation => observation.scale)
    const center = median(scales)
    const scaleMad = median(scales.map(value => Math.abs(value - center)))
    const gazeUnstable = gaze.some((_, dimension) => {
      const values = this.observations.map(observation => observation.gaze[dimension])
      const gazeMedian = median(values)
      return median(values.map(value => Math.abs(value - gazeMedian))) > 0.025 || Math.max(...values) - Math.min(...values) > 0.12
    })
    if (scaleMad / center > 0.015 || gazeUnstable) return this.reject('keep-still')
    this.result = { ...this.result, status: 'ready', faceScale: center }
    return this.state
  }
}
