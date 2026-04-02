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
  rotOffset: [number, number, number]
}

function GlassesModel({ modelPath, landmarksRef, videoRef, rotOffset }: GlassesModelProps) {
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

    // Use 3D eye distance (stable across yaw rotations).
    // MediaPipe z has the same scale as x (normalized to face width).
    // When the head turns, the 2D projected distance shrinks but the 3D stays constant.
    const W_vw = vw * s
    const lz = leftOuter.z * W_vw
    const rz = rightOuter.z * W_vw
    const eyeDist = Math.hypot(R.x - L.x, R.y - L.y, rz - lz)

    const scale = (eyeDist * GLASSES_SCALE) / modelWidth

    // ── Rotation from MediaPipe facial transformation matrix ──────────────────
    // The matrix maps canonical face model → camera space (column-major, right-hand).
    // MediaPipe image space: X right, Y down, Z out of screen.
    // Three.js convention (orthographic camera looking at -Z): X right, Y up, Z toward viewer.
    // Mapping: rotX_three = -rotX_mp, rotY_three = -rotY_mp, rotZ_three = rotZ_mp
    let rotX = 0, rotY = 0, rotZ = 0

    const matData = result.facialTransformationMatrixes?.[0]?.data
    if (matData && matData.length === 16) {
      const m = new THREE.Matrix4().fromArray(Array.from(matData))
      const euler = new THREE.Euler().setFromRotationMatrix(m, 'YXZ')
      rotX = -euler.x
      rotY = -euler.y
      rotZ =  euler.z
    } else {
      // Fallback: estimate from landmarks
      const noseTip   = lm[4]
      const eyeMidX   = (leftOuter.x + rightOuter.x) / 2
      const eyeMidY   = (leftOuter.y + rightOuter.y) / 2
      rotY = -(noseTip.x - eyeMidX) * Math.PI * 1.8
      rotX =  (noseTip.y - eyeMidY) * Math.PI * 0.6
      rotZ =  Math.atan2(R.y - L.y, R.x - L.x)
    }
    // ─────────────────────────────────────────────────────────────────────────

    const offsetY = -eyeDist * GLASSES_Y_OFFSET

    groupRef.current.position.set(cx, cy + offsetY, 0)
    groupRef.current.scale.setScalar(scale)
    groupRef.current.rotation.set(
      rotX + MODEL_ROT_OFFSET.x,
      rotY + MODEL_ROT_OFFSET.y,
      rotZ + MODEL_ROT_OFFSET.z,
      'YXZ',
    )
  })

  return (
    <group ref={groupRef}>
      {/* Inner group: per-model orientation correction (fixes GLB export axes) */}
      <group rotation={rotOffset}>
        <primitive
          object={gltf.scene}
          position={[-modelCenter.x, -modelCenter.y, -modelCenter.z]}
        />
      </group>
    </group>
  )
}

interface GlassesOverlayProps {
  modelPath: string | null
  landmarksRef: React.MutableRefObject<FaceLandmarkerResult | null>
  videoRef: React.RefObject<HTMLVideoElement | null>
  rotOffset: [number, number, number]
}

export default function GlassesOverlay({ modelPath, landmarksRef, videoRef, rotOffset }: GlassesOverlayProps) {
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
          <GlassesModel modelPath={modelPath} landmarksRef={landmarksRef} videoRef={videoRef} rotOffset={rotOffset} />
        </Suspense>
      )}
    </Canvas>
  )
}

// Preload all models on import
useGLTF.preload('/models/aviator_sunglasses.glb')
useGLTF.preload('/models/glasses-1-.glb')
useGLTF.preload('/models/glasses-5b.glb')
useGLTF.preload('/models/glasses-5c.glb')
useGLTF.preload('/models/glasses-6.glb')
useGLTF.preload('/models/glasses-7b.glb')
useGLTF.preload('/models/glasses-7c.glb')
useGLTF.preload('/models/glasses-8b.glb')
useGLTF.preload('/models/glasses-8c.glb')
useGLTF.preload('/models/glasses-9b.glb')
useGLTF.preload('/models/glasses-9c.glb')
useGLTF.preload('/models/glasses-10.glb')
useGLTF.preload('/models/glasses-11b.glb')
useGLTF.preload('/models/glasses-11c.glb')
useGLTF.preload('/models/glasses-12.glb')
