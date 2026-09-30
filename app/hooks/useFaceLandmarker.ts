'use client'

import { useEffect, useEffectEvent, useState } from 'react'
import type { FaceLandmarkerResult } from '@mediapipe/tasks-vision'
import { TRACKING_TIMEOUT_MS } from '@/app/lib/face-tracking'

import { createTrackingEngine } from '@/app/lib/tracking-engine'
import type { TrackingEngine } from '@/app/lib/tracking-engine'

export function useFaceLandmarker(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  onResult: (result: FaceLandmarkerResult | null, timestampMs: number) => void,
  enabled = true,
) {
  const [state, setState] = useState({ isLoading: true, error: null as string | null })
  const publish = useEffectEvent(onResult)

  useEffect(() => {
    if (!enabled) return

    let cancelled = false
    let rafId: number | null = null
    let videoFrameId: number | null = null
    let expiryTimer: ReturnType<typeof setTimeout> | undefined
    let video: HTMLVideoElement | null = null
    let engine: TrackingEngine | null = null
    const abort = new AbortController()
    let hasResult = false
    let generation = 0
    let lastVideoTime = -1
    let consecutiveErrors = 0
    let inFlight = false

    function clearResult(now: number) {
      clearTimeout(expiryTimer)
      expiryTimer = undefined
      if (hasResult) {
        hasResult = false
        publish(null, now)
      }
    }

    function cancelScheduledFrame() {
      if (rafId !== null) cancelAnimationFrame(rafId)
      if (videoFrameId !== null) video?.cancelVideoFrameCallback(videoFrameId)
      rafId = null
      videoFrameId = null
    }

    function invalidateFrames() {
      // An inference begun before pause/seek/backgrounding must not reappear on resume.
      generation++
      lastVideoTime = -1
      cancelScheduledFrame()
      clearResult(performance.now())
    }

    function onVideoChange() {
      invalidateFrames()
      scheduleFrame()
    }

    function onVisibilityChange() {
      invalidateFrames()
      if (!document.hidden) scheduleFrame()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    const videoEvents = ['pause', 'ended', 'emptied', 'seeking', 'seeked', 'playing', 'loadeddata'] as const

    function bindVideo(next: HTMLVideoElement | null) {
      if (video === next) return
      invalidateFrames()
      for (const event of videoEvents) video?.removeEventListener(event, onVideoChange)
      video = next
      for (const event of videoEvents) video?.addEventListener(event, onVideoChange)
    }

    function scheduleFrame() {
      if (cancelled || !engine || document.hidden || rafId !== null || videoFrameId !== null) return
      bindVideo(videoRef.current)
      const source = video
      if (!source) {
        // The ref may not be attached yet when initialization finishes.
        rafId = requestAnimationFrame(() => {
          rafId = null
          scheduleFrame()
        })
        return
      }
      if (source.paused || source.ended || source.seeking) return

      if (typeof source.requestVideoFrameCallback === 'function') {
        videoFrameId = source.requestVideoFrameCallback((_now, metadata) => {
          videoFrameId = null
          scheduleFrame()
          void detect(source, metadata.mediaTime)
        })
      } else {
        rafId = requestAnimationFrame(() => {
          rafId = null
          scheduleFrame()
          void detect(source, source.currentTime)
        })
      }
    }

    async function detect(source: HTMLVideoElement, mediaTime: number) {
      if (cancelled || !engine || source !== videoRef.current || document.hidden) return
      if (source.paused || source.ended || source.seeking || source.readyState < 2 ||
          source.videoWidth === 0 || source.videoHeight === 0) {
        clearResult(performance.now())
        return
      }
      if (inFlight || mediaTime === lastVideoTime) return
      lastVideoTime = mediaTime
      inFlight = true
      const frameGeneration = generation
      // rAF/rVFC callback timestamps can predate acquisition. Stamp the actual capture.
      const capturedAt = performance.now()
      try {
        const result = await engine.detect(source, capturedAt)
        if (cancelled || frameGeneration !== generation) return
        const now = performance.now()
        if (document.hidden || source !== videoRef.current || source.paused || source.ended ||
            source.seeking || now - capturedAt > TRACKING_TIMEOUT_MS) {
          clearResult(now)
          return
        }
        consecutiveErrors = 0
        hasResult = true
        publish(result, capturedAt)
        clearTimeout(expiryTimer)
        // Video callbacks stop on stalled streams; expiry must not depend on another frame.
        expiryTimer = setTimeout(() => clearResult(performance.now()),
          Math.max(0, TRACKING_TIMEOUT_MS - (performance.now() - capturedAt)))
      } catch (error) {
        if (cancelled || frameGeneration !== generation) return
        clearResult(performance.now())
        if (++consecutiveErrors >= 5) {
          console.error('Face tracking stopped after repeated detection failures.', error)
          setState({ isLoading: false, error: 'Face tracking stopped. Please retry.' })
          cancelScheduledFrame()
          abort.abort()
          engine?.close()
          engine = null
        }
      } finally {
        inFlight = false
      }
    }

    async function init() {
      try {
        // Yield before synchronizing external-resource state with React.
        await Promise.resolve()
        if (cancelled) return
        setState({ isLoading: true, error: null })
        engine = await createTrackingEngine(abort.signal)
        if (cancelled) {
          engine.close()
          return
        }
        setState({ isLoading: false, error: null })
        scheduleFrame()
      } catch (error) {
        if (!cancelled) {
          console.error('FaceLandmarker init error:', error)
          setState({ isLoading: false, error: 'Unable to load face tracking. Check your connection and retry.' })
        }
      }
    }

    void init()
    return () => {
      cancelled = true
      cancelScheduledFrame()
      clearTimeout(expiryTimer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      for (const event of videoEvents) video?.removeEventListener(event, onVideoChange)
      abort.abort()
      engine?.close()
      engine = null
    }
  }, [enabled, videoRef])

  return { isLoading: enabled && state.isLoading, error: enabled ? state.error : null }
}
