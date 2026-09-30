'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import type { FaceLandmarkerResult } from '@mediapipe/tasks-vision'
import { useFaceLandmarker } from '@/app/hooks/useFaceLandmarker'
import GlassesList from './GlassesList'
import { GLASSES_CATALOG } from '@/app/data/glasses'
import type { TrackingFrame } from '@/app/lib/face-tracking'
import { estimatePupillaryDistance } from '@/app/lib/pupillary-distance'

// Load R3F canvas client-side only (no SSR)
const GlassesOverlay = dynamic(() => import('./GlassesOverlay'), { ssr: false })

export default function VirtualTryOn() {
  const [session, setSession] = useState(0)
  return <TryOnSession key={session} onRetry={() => setSession(value => value + 1)} />
}

function TryOnSession({ onRetry }: { onRetry: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const landmarksRef = useRef<TrackingFrame | null>(null)
  const invalidateTrackingRef = useRef<(() => void) | null>(null)
  const pdEstimateRef = useRef<number | null>(null)
  const lastPdUpdateRef = useRef(-Infinity)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pdMm, setPdMm] = useState<number | null>(null)
  const [faceDetected, setFaceDetected] = useState(false)
  const [cameraReady, setCameraReady] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)

  const selectedGlasses = GLASSES_CATALOG.find((g) => g.id === selectedId) ?? null

  useEffect(() => {
    let cancelled = false
    let stream: MediaStream | null = null
    const video = videoRef.current

    function onEnded() {
      if (cancelled) return
      landmarksRef.current = null
      setPdMm(null)
      setFaceDetected(false)
      setCameraReady(false)
      setCameraError('Camera disconnected. Please reconnect it and retry.')
    }

    async function startCamera() {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('Camera access requires HTTPS and a supported browser.')
        }
        const acquired = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
        })
        // Strict Mode/unmount can happen while the permission dialog is open.
        if (cancelled || !video) {
          acquired.getTracks().forEach(track => track.stop())
          return
        }
        stream = acquired
        stream.getVideoTracks().forEach(track => track.addEventListener('ended', onEnded))
        video.srcObject = stream
        await video.play()
        if (!cancelled) setCameraReady(true)
      } catch (error) {
        stream?.getTracks().forEach(track => track.stop())
        if (cancelled) return
        const name = error instanceof Error ? error.name : ''
        const message = name === 'NotAllowedError'
          ? 'Camera access denied. Please allow camera permissions and retry.'
          : name === 'NotFoundError'
            ? 'No camera found. Connect a camera and retry.'
            : name === 'NotReadableError'
              ? 'Your camera is busy. Close other camera apps and retry.'
              : error instanceof Error ? error.message : 'Unable to start the camera. Please retry.'
        setCameraError(message)
      }
    }

    void startCamera()
    return () => {
      cancelled = true
      landmarksRef.current = null
      stream?.getTracks().forEach(track => {
        track.removeEventListener('ended', onEnded)
        track.stop()
      })
      if (video && video.srcObject === stream) {
        video.pause()
        video.srcObject = null
      }
    }
  }, [])

  const handleLandmarks = useCallback((result: FaceLandmarkerResult | null, timestampMs: number) => {
    const detected = !!result?.faceLandmarks[0]
    landmarksRef.current = detected && result ? { result, timestampMs } : null
    invalidateTrackingRef.current?.()
    setFaceDetected(detected)

    const estimate = result && detected
      ? estimatePupillaryDistance(result, videoRef.current?.videoWidth ?? 0, videoRef.current?.videoHeight ?? 0)
      : null
    if (estimate === null) {
      pdEstimateRef.current = null
      lastPdUpdateRef.current = -Infinity
      setPdMm(null)
      return
    }
    // Smooth unrounded values, then publish at most ~6 times/sec to React.
    const previous = pdEstimateRef.current
    pdEstimateRef.current = previous === null ? estimate : previous + (estimate - previous) * 0.2
    if (timestampMs - lastPdUpdateRef.current >= 150) {
      lastPdUpdateRef.current = timestampMs
      setPdMm(Math.round(pdEstimateRef.current))
    }
  }, [])

  const { isLoading, error: trackingError } = useFaceLandmarker(videoRef, handleLandmarks, cameraReady)
  const error = cameraError ?? trackingError

  return (
    // Fond blanc plein écran, contenu centré horizontalement
    <div className="w-full h-dvh bg-white flex justify-center overflow-hidden">
      {/* Colonne centrale contrainte en largeur, prend toute la hauteur */}
      <div className="w-full max-w-md flex flex-col h-full">

        {/* ── Vidéo carrée — largeur fixe, ne se redimensionne pas verticalement ── */}
        <div
          className="relative w-full flex-shrink-0 bg-black overflow-hidden"
          style={{ aspectRatio: '1 / 1' }}
        >
          {/* Video (mirrored) */}
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="absolute inset-0 w-full h-full object-cover"
            style={{ transform: 'scaleX(-1)' }}
          />

          {/* Three.js glasses overlay */}
          {cameraReady && selectedGlasses && !error && (
            <GlassesOverlay modelPath={selectedGlasses.modelPath} landmarksRef={landmarksRef}
              videoRef={videoRef} invalidateTrackingRef={invalidateTrackingRef} rotOffset={selectedGlasses.rotOffset ?? [0, 0, 0]} />
          )}

          {/* Loading badge */}
          {isLoading && cameraReady && !error && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-black/60 text-white text-xs px-3 py-1.5 rounded-full backdrop-blur-sm">
              Loading face detection…
            </div>
          )}

          {!cameraReady && !error && (
            <div role="status" className="absolute inset-0 flex items-center justify-center text-white text-sm">
              Starting camera…
            </div>
          )}
          {cameraReady && !isLoading && !faceDetected && !error && (
            <div role="status" className="absolute top-4 left-1/2 -translate-x-1/2 whitespace-nowrap bg-black/60 text-white text-xs px-3 py-1.5 rounded-full">
              Position your face in the camera
            </div>
          )}
          {error && (
            <div role="alert" className="absolute inset-0 z-10 flex flex-col gap-4 items-center justify-center bg-black/80 text-white text-sm text-center px-6">
              <p>{error}</p>
              <button onClick={onRetry} className="rounded-full bg-white text-black px-4 py-2 font-medium">
                Retry
              </button>
            </div>
          )}

          {/* Selected glasses bar (bottom of camera) */}
          {selectedGlasses && (
            <div className="absolute bottom-0 left-0 right-0 flex items-center gap-3 px-4 py-3 bg-gradient-to-t from-black/70 to-transparent">
              <div
                className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
                style={{ background: `${selectedGlasses.color}30`, border: `1.5px solid ${selectedGlasses.color}80` }}
              >
                <span className="text-lg">🕶️</span>
              </div>
              <span className="flex-1 text-white text-sm font-medium truncate">
                {selectedGlasses.name}
              </span>
              <button className="bg-white text-black text-sm font-semibold px-4 py-2 rounded-full hover:bg-gray-100 transition-colors">
                Add to cart
              </button>
            </div>
          )}
        </div>

        {/* ── PD bar ── */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-100 flex-shrink-0">
          <span className="text-sm font-medium text-gray-900">Estimated pupillary distance:</span>
          {pdMm ? (
            <>
              <span className="text-sm font-semibold text-gray-900">≈ {pdMm} mm</span>
              <PDIndicator value={pdMm} />
            </>
          ) : (
            <span className="text-sm text-gray-400">—</span>
          )}
        </div>

        {/* ── Liste lunettes — flex-1 : absorbe tout l'espace vertical restant ── */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          <GlassesList
            items={GLASSES_CATALOG}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onClear={() => setSelectedId(null)}
          />
        </div>

      </div>
    </div>
  )
}

// Animated PD dots (like in the reference screenshot)
function PDIndicator({ value }: { value: number }) {
  // Map PD 55-75 mm onto 5 dots
  const normalized = Math.max(0, Math.min(1, (value - 55) / 20))
  const activeDot = Math.round(normalized * 4) // 0-4

  return (
    <div className="flex items-center gap-1 ml-1">
      {[0, 1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className={`rounded-full transition-all ${
            i === activeDot ? 'w-2.5 h-2.5 bg-black' : 'w-1.5 h-1.5 bg-gray-300'
          }`}
        />
      ))}
    </div>
  )
}
