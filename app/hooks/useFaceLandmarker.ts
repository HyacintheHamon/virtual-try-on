'use client'

import { useEffect, useRef, useState } from 'react'
import type { FaceLandmarkerResult } from '@mediapipe/tasks-vision'

const WASM_URL =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm'
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'

export function useFaceLandmarker(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  onResult: (result: FaceLandmarkerResult) => void,
  enabled = true,
) {
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const onResultRef = useRef(onResult)
  onResultRef.current = onResult

  useEffect(() => {
    if (!enabled) return

    let cancelled = false
    let rafId: number

    async function init() {
      try {
        const { FaceLandmarker, FilesetResolver } = await import(
          '@mediapipe/tasks-vision'
        )
        const vision = await FilesetResolver.forVisionTasks(WASM_URL)
        const landmarker = await FaceLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: MODEL_URL,
            delegate: 'GPU',
          },
          runningMode: 'VIDEO',
          numFaces: 1,
          outputFacialTransformationMatrixes: true,
        })

        if (cancelled) {
          landmarker.close()
          return
        }

        setIsLoading(false)

        let lastVideoTime = -1
        function detect() {
          if (cancelled) return
          const video = videoRef.current
          if (
            video &&
            video.readyState >= 2 &&
            !video.paused &&
            video.videoWidth > 0 &&
            video.currentTime !== lastVideoTime
          ) {
            lastVideoTime = video.currentTime
            try {
              const result = landmarker.detectForVideo(video, performance.now())
              onResultRef.current(result)
            } catch {
              // ignore per-frame errors
            }
          }
          rafId = requestAnimationFrame(detect)
        }

        rafId = requestAnimationFrame(detect)
      } catch (err) {
        if (!cancelled) {
          console.error('FaceLandmarker init error:', err)
          setError('Failed to load face detection model')
          setIsLoading(false)
        }
      }
    }

    init()

    return () => {
      cancelled = true
      cancelAnimationFrame(rafId)
    }
  }, [enabled, videoRef])

  return { isLoading, error }
}
