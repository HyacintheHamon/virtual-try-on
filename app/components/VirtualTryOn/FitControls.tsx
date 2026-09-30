'use client'

import { useState } from 'react'
import type { WearerCalibrationState } from '@/app/lib/wearer-scale-calibration'

export interface FitAdjustment {
  heightMm: number
  depthMm: number
}

interface FitControlsProps {
  enabled: boolean
  measuredModel: boolean
  knownPdMm: number | null
  onKnownPdChange: (value: number | null) => void
  adjustment: FitAdjustment
  onAdjustmentChange: (value: FitAdjustment) => void
  calibration: WearerCalibrationState | null
}

export default function FitControls({ enabled, measuredModel, knownPdMm, onKnownPdChange,
  adjustment, onAdjustmentChange, calibration }: FitControlsProps) {
  const [pdInput, setPdInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const captureHint = calibration?.rejection === 'open-eyes' ? 'Keep both eyes open.' :
    calibration?.rejection === 'face-too-small' ? 'Move a little closer to the camera.' :
    calibration?.rejection === 'tracking-quality' ? 'Face the camera in even lighting.' :
    calibration?.rejection === 'out-of-range' ? 'Check your measured pupillary distance, then try again.' :
    calibration?.rejection === 'missing-iris' ? 'Keep both eyes clearly visible.' :
    'Look straight ahead at the camera and hold still.'
  return (
    <details className="border-b border-gray-100 px-4 py-3 text-sm flex-shrink-0">
      <summary className="cursor-pointer font-medium text-gray-900">Adjust fit</summary>
      <div className="mt-3 space-y-3">
        <p className="text-xs text-gray-500">
          {measuredModel ? 'This frame has defined dimensions. Add your measured pupillary distance to refine its size.' :
            'This frame uses an approximate visual size. Its real dimensions have not been supplied.'}
        </p>
        <form onSubmit={event => {
          event.preventDefault()
          const value = Number(pdInput)
          if (!Number.isFinite(value) || value < 40 || value > 85) {
            setError('Enter a measured pupillary distance between 40 and 85 mm.')
            return
          }
          setError(null)
          onKnownPdChange(value)
        }} className="flex flex-wrap items-end gap-2">
          <label className="flex-1 text-xs text-gray-700">
            Measured pupillary distance (mm)
            <input type="number" min="40" max="85" step="0.1" inputMode="decimal"
              value={pdInput} onChange={event => setPdInput(event.target.value)} placeholder="e.g. 63"
              className="mt-1 block w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900" />
          </label>
          <button type="submit" disabled={!enabled}
            className="rounded-full bg-black px-3 py-2 text-xs font-medium text-white disabled:opacity-40">
            Calibrate size
          </button>
        </form>
        {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
        <p role="status" className="text-xs text-gray-500">
          {!enabled ? 'Choose a frame to adjust its fit.' : calibration?.status === 'ready'
            ? `Reference applied: ${knownPdMm} mm. Size remains an estimate.`
            : knownPdMm !== null
              ? `${captureHint} ${calibration?.acceptedFrames ?? 0} / ${calibration?.requiredFrames ?? 15}`
              : 'Use a measurement you already know, rather than the estimate shown above.'}
        </p>
        <label className="block text-xs text-gray-700">
          Height <span className="float-right">{adjustment.heightMm > 0 ? '+' : ''}{adjustment.heightMm} mm</span>
          <input className="mt-2 w-full accent-black" aria-label="Frame height" type="range" min="-5" max="5" step="0.5"
            value={adjustment.heightMm} onChange={event => onAdjustmentChange({ ...adjustment, heightMm: Number(event.target.value) })} />
        </label>
        <label className="block text-xs text-gray-700">
          Distance from nose <span className="float-right">{adjustment.depthMm > 0 ? '+' : ''}{adjustment.depthMm} mm</span>
          <input className="mt-2 w-full accent-black" aria-label="Frame depth" type="range" min="-2" max="5" step="0.5"
            value={adjustment.depthMm} onChange={event => onAdjustmentChange({ ...adjustment, depthMm: Number(event.target.value) })} />
        </label>
        <button type="button" onClick={() => {
          setPdInput(''); setError(null); onKnownPdChange(null)
          onAdjustmentChange({ heightMm: 0, depthMm: 0 })
        }} className="text-xs underline underline-offset-2 text-gray-600">Reset fit</button>
      </div>
    </details>
  )
}
