'use client'

import { useEffect, useEffectEvent, useState } from 'react'
import type { FaceLandmarkerResult } from '@mediapipe/tasks-vision'
import { TRACKING_TIMEOUT_MS } from '@/app/lib/face-tracking'

import { createTrackingEngine } from '@/app/lib/tracking-engine'
import type { TrackingEngine } from '@/app/lib/tracking-engine'

const FRAME_INTERVAL_MS = 1000 / 60

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
    let rafId = 0
    let engine: TrackingEngine | null = null
    const abort = new AbortController()
    let hasResult = false
    let lastResultTime = -Infinity

    function clearResult(now: number) {
      if (hasResult) {
        hasResult = false
        publish(null, now)
      }
    }

    function onVisibilityChange() {
      if (document.hidden) clearResult(performance.now())
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

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
        let lastVideoTime = -1
        let lastDetectionTime = -Infinity
        let consecutiveErrors = 0
        let inFlight = false

        async function detect(now: number) {
          if (cancelled || !engine) return
          rafId = requestAnimationFrame(detect)
          const video = videoRef.current
          if (document.hidden || !video || video.paused || video.ended ||
              video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) {
            clearResult(now)
          } else if (!inFlight && video.currentTime !== lastVideoTime && now - lastDetectionTime >= FRAME_INTERVAL_MS) {
            lastVideoTime = video.currentTime
            lastDetectionTime = now
            inFlight = true
            try {
              const result = await engine.detect(video, now)
              if (cancelled) return
              if (document.hidden || video.paused || performance.now() - now > TRACKING_TIMEOUT_MS) {
                clearResult(performance.now())
                return
              }
              lastResultTime = now
              consecutiveErrors = 0
              hasResult = true
              publish(result, now)
            } catch (error) {
              if (cancelled) return
              clearResult(now)
              if (++consecutiveErrors >= 5) {
                console.error('Face tracking stopped after repeated detection failures.', error)
                setState({ isLoading: false, error: 'Face tracking stopped. Please retry.' })
                cancelAnimationFrame(rafId)
                engine.close()
                engine = null
                return
              }
            } finally {
              inFlight = false
            }
          } else if (now - lastResultTime > TRACKING_TIMEOUT_MS) {
            clearResult(now)
          }
        }

        rafId = requestAnimationFrame(detect)
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
      cancelAnimationFrame(rafId)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      abort.abort()
      engine?.close()
      engine = null
    }
  }, [enabled, videoRef])

  return { isLoading: enabled && state.isLoading, error: enabled ? state.error : null }
}
