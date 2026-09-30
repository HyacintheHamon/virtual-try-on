import type { PerspectiveCamera } from 'three'
import type { FrameSize } from './face-tracking.ts'

/** Pinhole intrinsics in pixels of the unmirrored source video. */
export interface CameraIntrinsics extends FrameSize {
  fx: number
  fy: number
  cx: number
  cy: number
}

// Browsers do not expose a camera calibration through getUserMedia. This is an
// explicit starting assumption, NOT a measurement of the user's lens. A host
// with a calibrated camera can supply its measured intrinsics instead.
export const DEFAULT_LONG_EDGE_FOV_DEGREES = 60

const validSize = ({ width, height }: FrameSize) =>
  Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0

export function validCameraIntrinsics(camera: CameraIntrinsics) {
  return validSize(camera) && [camera.fx, camera.fy, camera.cx, camera.cy].every(Number.isFinite) &&
    camera.fx > 0 && camera.fy > 0 && camera.cx >= 0 && camera.cx <= camera.width &&
    camera.cy >= 0 && camera.cy <= camera.height
}

export function createCameraIntrinsics(
  video: FrameSize,
  calibrated?: CameraIntrinsics,
): CameraIntrinsics | null {
  if (!validSize(video)) return null
  if (calibrated) {
    if (!validCameraIntrinsics(calibrated)) return null
    // A change of sensor crop invalidates calibration. Scaling a known matching
    // image is safe; guessing how the browser cropped another aspect ratio isn't.
    const sx = video.width / calibrated.width
    const sy = video.height / calibrated.height
    if (Math.abs(sx / sy - 1) > 0.001) return null
    return { ...video, fx: calibrated.fx * sx, fy: calibrated.fy * sy,
      cx: calibrated.cx * sx, cy: calibrated.cy * sy }
  }
  const focal = Math.max(video.width, video.height) /
    (2 * Math.tan(DEFAULT_LONG_EDGE_FOV_DEGREES * Math.PI / 360))
  return { ...video, fx: focal, fy: focal, cx: video.width / 2, cy: video.height / 2 }
}

/** Match the video's centered object-fit: cover without altering pose estimates. */
export function getCoverIntrinsics(camera: CameraIntrinsics, viewport: FrameSize): CameraIntrinsics | null {
  if (!validCameraIntrinsics(camera) || !validSize(viewport)) return null
  const cover = Math.max(viewport.width / camera.width, viewport.height / camera.height)
  const cropX = (camera.width * cover - viewport.width) / 2
  const cropY = (camera.height * cover - viewport.height) / 2
  return { ...viewport, fx: camera.fx * cover, fy: camera.fy * cover,
    cx: camera.cx * cover - cropX, cy: camera.cy * cover - cropY }
}

export function applyCameraIntrinsics(
  camera: PerspectiveCamera,
  source: CameraIntrinsics,
  viewport: FrameSize,
) {
  const projected = getCoverIntrinsics(source, viewport)
  if (!projected) return false
  const { width, height, fx, fy, cx, cy } = projected
  const near = camera.near
  camera.position.set(0, 0, 0)
  camera.quaternion.identity()
  camera.scale.set(1, 1, 1)
  camera.projectionMatrix.makePerspective(
    -cx * near / fx, (width - cx) * near / fx,
    cy * near / fy, -(height - cy) * near / fy, near, camera.far,
  )
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert()
  camera.updateMatrixWorld(true)
  return true
}
