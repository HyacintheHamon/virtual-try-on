import { Quaternion, Vector3 } from 'three'
import type { FacePose } from './face-tracking'

// Compensate short inference delays only; never keep extrapolating a lost face.
export const MAX_PREDICTION_MS = 60
const MAX_SAMPLE_GAP_MS = 150
const MAX_TRANSLATION = 0.05 // outer-eye distances
const MAX_ROTATION = 0.08 // radians (~4.6 degrees)

const copyPose = (pose: FacePose): FacePose => ({
  position: pose.position.clone(), rotation: pose.rotation.clone(), eyeDistance: pose.eyeDistance,
})

/** Bounded render-time compensation, shared by glasses and all occlusion meshes. */
export class FacePosePredictor {
  private previous: FacePose | null = null
  private pose: FacePose | null = null
  private timestampMs = 0
  private velocity = new Vector3()
  private angularVelocity = new Vector3()

  reset() {
    this.previous = null
    this.pose = null
    this.velocity.set(0, 0, 0)
    this.angularVelocity.set(0, 0, 0)
  }

  update(target: FacePose, filtered: FacePose, timestampMs: number) {
    const elapsed = timestampMs - this.timestampMs
    if (this.previous && elapsed > 0 && elapsed <= MAX_SAMPLE_GAP_MS) {
      const dt = elapsed / 1000
      const delta = target.position.clone().sub(this.previous.position)
      const rotation = this.previous.rotation.clone().invert().multiply(target.rotation).normalize()
      // q and -q encode the same rotation. Use the shortest angular displacement.
      if (rotation.w < 0) rotation.set(-rotation.x, -rotation.y, -rotation.z, -rotation.w)
      const axis = new Vector3(rotation.x, rotation.y, rotation.z)
      const angle = 2 * Math.atan2(axis.length(), rotation.w)
      if (delta.length() > target.eyeDistance * 0.3 || angle > 0.5) {
        this.velocity.set(0, 0, 0)
        this.angularVelocity.set(0, 0, 0)
      } else {
        const alpha = dt / (0.04 + dt)
        const velocity = delta.divideScalar(dt)
        const angularVelocity = axis.normalize().multiplyScalar(angle / dt)
        // Stop/reversal clears momentum immediately, rather than coasting past
        // the new observation. Tiny stationary jitter must not trigger prediction.
        if (velocity.length() < target.eyeDistance * 0.03 || velocity.dot(this.velocity) < 0) {
          this.velocity.set(0, 0, 0)
        } else this.velocity.lerp(velocity, alpha)
        if (angularVelocity.length() < 0.1 || angularVelocity.dot(this.angularVelocity) < 0) {
          this.angularVelocity.set(0, 0, 0)
        } else this.angularVelocity.lerp(angularVelocity, alpha)
      }
    } else {
      this.velocity.set(0, 0, 0)
      this.angularVelocity.set(0, 0, 0)
    }
    this.previous = copyPose(target)
    this.pose = copyPose(filtered)
    this.timestampMs = timestampMs
  }

  sample(nowMs: number): FacePose | null {
    if (!this.pose) return null
    const result = copyPose(this.pose)
    const horizon = Math.min(MAX_PREDICTION_MS, Math.max(0, nowMs - this.timestampMs)) / 1000
    const translation = this.velocity.clone().multiplyScalar(horizon)
      .clampLength(0, result.eyeDistance * MAX_TRANSLATION)
    result.position.add(translation)
    const speed = this.angularVelocity.length()
    if (speed > 0) {
      const rotation = new Quaternion().setFromAxisAngle(
        this.angularVelocity.clone().divideScalar(speed), Math.min(MAX_ROTATION, speed * horizon))
      result.rotation.multiply(rotation).normalize()
    }
    return result
  }

  needsRender(nowMs: number) {
    return this.pose !== null && nowMs >= this.timestampMs &&
      nowMs - this.timestampMs < MAX_PREDICTION_MS &&
      (this.velocity.lengthSq() > 0 || this.angularVelocity.lengthSq() > 0)
  }
}
