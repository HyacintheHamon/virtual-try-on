'use client'

import { useRef, useMemo, Suspense } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import type { FaceLandmarkerResult } from '@mediapipe/tasks-vision'

// ─── Tunable constants ────────────────────────────────────────────────────────
// Ratio: glasses frame width / outer-eye-corner distance.
// Increase to make glasses wider, decrease to shrink them.
const GLASSES_SCALE = 1.55

// Adjust if the model is rotated incorrectly out of the box.
// e.g. if lenses face down, set rotX offset to Math.PI / 2
const MODEL_ROT_OFFSET = new THREE.Euler(0, 0, 0)

// Vertical offset: positive moves glasses down, negative moves up.
// Expressed as a fraction of eye-distance.
const GLASSES_Y_OFFSET = 0.1
// ─────────────────────────────────────────────────────────────────────────────

interface GlassesModelProps {
  modelPath: string
  landmarksRef: React.MutableRefObject<FaceLandmarkerResult | null>
  videoRef: React.RefObject<HTMLVideoElement | null>
}

function GlassesModel({ modelPath, landmarksRef, videoRef }: GlassesModelProps) {
  const gltf = useGLTF(modelPath)
  const groupRef = useRef<THREE.Group>(null)
  const { size } = useThree()

  const { modelWidth, modelCenter } = useMemo(() => {
    const box = new THREE.Box3().setFromObject(gltf.scene)
    const sz = new THREE.Vector3()
    box.getSize(sz)
    const center = new THREE.Vector3()
    box.getCenter(center)
    return { modelWidth: sz.x || 1, modelCenter: center }
  }, [gltf.scene])

  useFrame(() => {
    if (!groupRef.current) return
    const result = landmarksRef.current

    if (!result?.faceLandmarks?.[0]) {
      groupRef.current.visible = false
      return
    }

    groupRef.current.visible = true
    const lm = result.faceLandmarks[0]

    // Natural video dimensions (may differ from canvas size due to object-fit: cover)
    const vw = videoRef.current?.videoWidth || size.width
    const vh = videoRef.current?.videoHeight || size.height

    // object-fit: cover scale: the larger of the two scale factors
    const s = Math.max(size.width / vw, size.height / vh)

    // Convert normalized landmark → Three.js world coords (cover-corrected + mirrored X)
    const toWorld = (p: { x: number; y: number }) => ({
      x: (0.5 - p.x) * vw * s,
      y: (0.5 - p.y) * vh * s,
    })

    const leftOuter = lm[263]
    const rightOuter = lm[33]

    const L = toWorld(leftOuter)
    const R = toWorld(rightOuter)

    const cx = (L.x + R.x) / 2
    const cy = (L.y + R.y) / 2
    const eyeDist = Math.hypot(R.x - L.x, R.y - L.y)

    const scale = (eyeDist * GLASSES_SCALE) / modelWidth

    const rotZ = Math.atan2(R.y - L.y, R.x - L.x)

    const noseTip = lm[4]
    const eyeMidX_lm = (leftOuter.x + rightOuter.x) / 2
    const rotY = -(noseTip.x - eyeMidX_lm) * Math.PI * 1.8

    const eyeMidY_lm = (leftOuter.y + rightOuter.y) / 2
    const rotX = (noseTip.y - eyeMidY_lm) * Math.PI * 0.6 + MODEL_ROT_OFFSET.x

    const offsetY = -eyeDist * GLASSES_Y_OFFSET

    groupRef.current.position.set(cx, cy + offsetY, 0)
    groupRef.current.scale.setScalar(scale)
    groupRef.current.rotation.set(rotX, rotY + MODEL_ROT_OFFSET.y, rotZ + MODEL_ROT_OFFSET.z)
  })

  return (
    <group ref={groupRef}>
      {/* Centering primitive at model's geometric center */}
      <primitive
        object={gltf.scene}
        position={[-modelCenter.x, -modelCenter.y, -modelCenter.z]}
      />
    </group>
  )
}

interface GlassesOverlayProps {
  modelPath: string | null
  landmarksRef: React.MutableRefObject<FaceLandmarkerResult | null>
  videoRef: React.RefObject<HTMLVideoElement | null>
}

export default function GlassesOverlay({ modelPath, landmarksRef, videoRef }: GlassesOverlayProps) {
  return (
    <Canvas
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
      }}
      orthographic
      camera={{ near: -1000, far: 1000, position: [0, 0, 200] }}
      gl={{ alpha: true, antialias: true }}
      onCreated={({ gl }) => {
        gl.setClearColor(0x000000, 0)
      }}
    >
      <ambientLight intensity={1.5} />
      <directionalLight position={[0, 5, 5]} intensity={1} />
      <directionalLight position={[0, -3, 3]} intensity={0.4} />
      {modelPath && (
        <Suspense fallback={null}>
          <GlassesModel modelPath={modelPath} landmarksRef={landmarksRef} videoRef={videoRef} />
        </Suspense>
      )}
    </Canvas>
  )
}

// Preload model on import
useGLTF.preload('/models/aviator_sunglasses.glb')
