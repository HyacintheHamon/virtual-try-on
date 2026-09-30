import { TRACKING_TIMEOUT_MS } from './face-tracking.ts'

export const POSE_QUALITY_GRACE_MS = 120

/**
 * Briefly hold the last rendered transform after a rejected pose, without
 * predicting through uncertainty. Face loss/pause/backgrounding must reset it.
 */
export class PoseQualityGrace {
  private acceptedAt: number | null = null
  private rejectedAt: number | null = null

  reset() {
    this.acceptedAt = null
    this.rejectedAt = null
  }

  accept(timestampMs: number) {
    if (!Number.isFinite(timestampMs) || timestampMs < 0) {
      this.reset()
      return
    }
    // Reprocessing an old observation must not refresh an expired hold.
    if (this.acceptedAt !== null && timestampMs <= this.acceptedAt) return
    this.acceptedAt = timestampMs
    this.rejectedAt = null
  }

  reject(nowMs: number): boolean {
    if (!this.hasFreshAcceptance(nowMs) ||
        (this.rejectedAt !== null && nowMs < this.rejectedAt)) {
      this.reset()
      return false
    }
    if (this.rejectedAt === null) this.rejectedAt = nowMs
    return this.needsRender(nowMs)
  }

  /** Read-only: only reject() can begin the fixed grace window. */
  needsRender(nowMs: number): boolean {
    return this.rejectedAt !== null && this.hasFreshAcceptance(nowMs) &&
      nowMs >= this.rejectedAt && nowMs - this.rejectedAt < POSE_QUALITY_GRACE_MS
  }

  private hasFreshAcceptance(nowMs: number) {
    return this.acceptedAt !== null && Number.isFinite(nowMs) &&
      nowMs >= this.acceptedAt && nowMs - this.acceptedAt <= TRACKING_TIMEOUT_MS
  }
}
