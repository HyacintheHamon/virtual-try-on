'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import type { FaceLandmarkerResult } from '@mediapipe/tasks-vision'
import { useFaceLandmarker } from '@/app/hooks/useFaceLandmarker'
import GlassesList from './GlassesList'
import { GLASSES_CATALOG } from '@/app/data/glasses'

// Load R3F canvas client-side only (no SSR)
const GlassesOverlay = dynamic(() => import('./GlassesOverlay'), { ssr: false })

// ─── Iris PD helpers (MediaPipe Iris paper, 2020) ─────────────────────────────
// LEFT_IRIS : [468-472]  RIGHT_IRIS : [473-477]
const IRIS_DIAMETER_MM = 11.7 // average adult iris diameter (±0.5 mm)

type NormPoint = { x: number; y: number }

function averagePoint(pts: NormPoint[]): NormPoint {
  return {
    x: pts.reduce((a, p) => a + p.x, 0) / pts.length,
    y: pts.reduce((a, p) => a + p.y, 0) / pts.length,
  }
}

function maxDiameter(pts: NormPoint[]): number {
  let max = 0
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++) {
      const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y)
      if (d > max) max = d
    }
  return max
}

// Pinhole model: focal ≈ 0.75 × videoWidth (empirically calibrated for mobile)
function estimateFocalPx(video: HTMLVideoElement | null): number {
  const track = (video?.srcObject as MediaStream | null)?.getVideoTracks?.()[0]
  const w = track?.getSettings?.().width ?? video?.videoWidth ?? 1280
  return w * 0.75
}
// ─────────────────────────────────────────────────────────────────────────────

export default function VirtualTryOn() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const landmarksRef = useRef<FaceLandmarkerResult | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pdMm, setPdMm] = useState<number | null>(null)
  const [cameraReady, setCameraReady] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)

  const selectedGlasses = GLASSES_CATALOG.find((g) => g.id === selectedId) ?? null

  // Start webcam
  useEffect(() => {
    let stream: MediaStream | null = null

    navigator.mediaDevices
      .getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      })
      .then((s) => {
        stream = s
        if (videoRef.current) {
          videoRef.current.srcObject = s
          videoRef.current.play().catch((err) => {
            // AbortError is expected during hot-module reloads
            if (err.name !== 'AbortError') {
              setCameraError('Failed to start camera stream.')
            }
          })
        }
      })
      .catch(() => {
        setCameraError('Camera access denied. Please allow camera permissions.')
      })

    return () => {
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  // Receive landmarks from MediaPipe — depth-from-iris PD (MediaPipe Iris paper)
  const handleLandmarks = useCallback((result: FaceLandmarkerResult) => {
    landmarksRef.current = result

    const lm = result.faceLandmarks?.[0]
    if (!lm || lm.length < 478) { setPdMm(null); return }

    // 5 points per iris
    const leftIris  = [468, 469, 470, 471, 472].map(i => lm[i])
    const rightIris = [473, 474, 475, 476, 477].map(i => lm[i])

    const leftCenter  = averagePoint(leftIris)
    const rightCenter = averagePoint(rightIris)

    // Iris diameter in normalised coords → convert to pixels
    const vw = videoRef.current?.videoWidth ?? 1280
    const leftDiamPx  = maxDiameter(leftIris)  * vw
    const rightDiamPx = maxDiameter(rightIris) * vw
    const avgDiamPx   = (leftDiamPx + rightDiamPx) / 2

    if (avgDiamPx < 5) return // detection too unstable

    // Pinhole: distanceFace = focalPx × IRIS_MM / irisPixelDiam
    const focalPx       = estimateFocalPx(videoRef.current)
    const distanceMm    = (focalPx * IRIS_DIAMETER_MM) / avgDiamPx

    // PD = irisDistPx × distanceMm / focalPx
    //    = irisDistPx / avgDiamPx × IRIS_DIAMETER_MM  (focal cancels)
    const irisDistPx    = Math.hypot(rightCenter.x - leftCenter.x, rightCenter.y - leftCenter.y) * vw
    const pdCalculated  = (irisDistPx * distanceMm) / focalPx

    // Exponential moving average (30 % weight on new frame → smooth without lag)
    setPdMm(prev =>
      prev === null
        ? Math.round(pdCalculated)
        : Math.round(prev * 0.7 + pdCalculated * 0.3)
    )
  }, [videoRef])

  const { isLoading } = useFaceLandmarker(videoRef, handleLandmarks, cameraReady)

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
            onCanPlay={() => setCameraReady(true)}
            className="absolute inset-0 w-full h-full object-cover"
            style={{ transform: 'scaleX(-1)' }}
          />

          {/* Three.js glasses overlay */}
          {cameraReady && <GlassesOverlay modelPath={selectedGlasses?.modelPath ?? null} landmarksRef={landmarksRef} videoRef={videoRef} />}

          {/* Loading badge */}
          {isLoading && cameraReady && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-black/60 text-white text-xs px-3 py-1.5 rounded-full backdrop-blur-sm">
              Loading face detection…
            </div>
          )}

          {/* Camera error */}
          {cameraError && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/80 text-white text-sm text-center px-6">
              {cameraError}
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
          <span className="text-sm font-medium text-gray-900">My Pupillary Distance:</span>
          {pdMm ? (
            <>
              <span className="text-sm font-semibold text-gray-900">{pdMm} mm</span>
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
