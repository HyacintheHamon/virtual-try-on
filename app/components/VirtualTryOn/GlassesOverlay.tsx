'use client'

import { useEffect, useRef, useMemo, Suspense } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { FacePoseSmoother, getFacePose, isTrackingFrameFresh, updateFaceOcclusionPositions } from '@/app/lib/face-tracking'
import type { TrackingFrame } from '@/app/lib/face-tracking'
import { FACE_TRIANGLES } from '@/app/data/face-triangles'
import { createHeadOcclusionGeometry, updateHeadOcclusionPositions } from '@/app/lib/head-occlusion'
import { FacePosePredictor } from '@/app/lib/pose-prediction'

const GLASSES_SCALE = 1.55

interface GlassesModelProps {
  modelPath: string
  landmarksRef: React.RefObject<TrackingFrame | null>
  videoRef: React.RefObject<HTMLVideoElement | null>
  rotOffset: [number, number, number]
}

function GlassesModel({ modelPath, landmarksRef, videoRef, rotOffset }: GlassesModelProps) {
  const gltf = useGLTF(modelPath)
  const groupRef = useRef<THREE.Group>(null)
  const occluderRef = useRef<THREE.Mesh>(null)
  const headOccluderRef = useRef<THREE.Mesh>(null)
  const headGeometry = useMemo(() => createHeadOcclusionGeometry(), [])
  const faceGeometry = useMemo(() => {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(468 * 3), 3).setUsage(THREE.DynamicDrawUsage))
    geometry.setIndex(FACE_TRIANGLES)
    return geometry
  }, [])
  useEffect(() => () => faceGeometry.dispose(), [faceGeometry])
  useEffect(() => () => headGeometry.dispose(), [headGeometry])
  const smoother = useMemo(() => new FacePoseSmoother(), [])
  const predictor = useMemo(() => new FacePosePredictor(), [])
  const lastFrame = useRef<TrackingFrame | null>(null)
  const { size, invalidate } = useThree()
  const [rx, ry, rz] = rotOffset

  const { model, modelWidth } = useMemo(() => {
    // Never move/rotate useGLTF's shared cached scene. Normalize a private clone
    // AFTER the export-axis correction so width/anchor use the displayed axes.
    const model = new THREE.Group()
    const corrected = new THREE.Group()
    corrected.rotation.set(rx, ry, rz)
    corrected.add(gltf.scene.clone(true))
    model.add(corrected)
    model.updateMatrixWorld(true)
    const bounds = new THREE.Box3().setFromObject(model)
    const center = bounds.getCenter(new THREE.Vector3())
    const width = bounds.getSize(new THREE.Vector3()).x
    // Anchor the front plane of the frame, not the middle of its long temples.
    corrected.position.set(-center.x, -center.y, -bounds.max.z)
    return { model, modelWidth: width || 1 }
  }, [gltf.scene, rx, ry, rz])

  // Resize changes object-fit: cover coordinates, so discard the old filter state.
  const viewportKey = `${size.width}:${size.height}`
  const previousViewport = useRef('')

  useFrame(() => {
    const group = groupRef.current
    if (!group) return
    const frame = landmarksRef.current
    const video = videoRef.current
    const now = performance.now()
    if (!frame || !isTrackingFrameFresh(frame, now) ||
        !video || video.paused || video.ended || document.hidden) {
      group.visible = false
      smoother.reset()
      predictor.reset()
      lastFrame.current = null
      return
    }

    const dimensions = `${viewportKey}:${video.videoWidth}:${video.videoHeight}`
    if (previousViewport.current !== dimensions) {
      previousViewport.current = dimensions
      smoother.reset()
      predictor.reset()
      lastFrame.current = null
    }
    if (lastFrame.current !== frame) {
      lastFrame.current = frame
      const target = getFacePose(frame.result,
        { width: video.videoWidth, height: video.videoHeight }, size)
      if (!target) {
        group.visible = false
        smoother.reset()
        predictor.reset()
        return
      }

      const positions = faceGeometry.getAttribute('position') as THREE.BufferAttribute
      const hasOcclusion = updateFaceOcclusionPositions(frame.result,
        { width: video.videoWidth, height: video.videoHeight }, size, target, positions.array as Float32Array)
      positions.needsUpdate = true
      if (occluderRef.current) occluderRef.current.visible = hasOcclusion
      const headPositions = headGeometry.getAttribute('position') as THREE.BufferAttribute
      const hasHeadOcclusion = hasOcclusion && updateHeadOcclusionPositions(
        positions.array as Float32Array, headPositions.array as Float32Array)
      if (hasHeadOcclusion) headPositions.needsUpdate = true
      if (headOccluderRef.current) headOccluderRef.current.visible = hasHeadOcclusion

      predictor.update(target, smoother.update(target, frame.timestampMs), frame.timestampMs)
    }

    const pose = predictor.sample(now)
    if (!pose) return
    group.position.copy(pose.position)
    group.quaternion.copy(pose.rotation)
    group.scale.setScalar(pose.eyeDistance)
    group.visible = true
    if (predictor.needsRender(now)) invalidate()
  })

  return (
    <group ref={groupRef} visible={false}>
      <mesh ref={occluderRef} geometry={faceGeometry} renderOrder={-1} frustumCulled={false}>
        <meshBasicMaterial colorWrite={false} depthWrite depthTest side={THREE.DoubleSide} />
      </mesh>
      <mesh ref={headOccluderRef} geometry={headGeometry} renderOrder={-1} frustumCulled={false} visible={false}>
        <meshBasicMaterial colorWrite={false} depthWrite depthTest side={THREE.DoubleSide} />
      </mesh>
      <group scale={GLASSES_SCALE / modelWidth} dispose={null}>
        <primitive object={model} />
      </group>
    </group>
  )
}

interface GlassesOverlayProps extends GlassesModelProps {
  invalidateTrackingRef: React.RefObject<(() => void) | null>
}

function TrackingInvalidation({ callbackRef }: { callbackRef: React.RefObject<(() => void) | null> }) {
  const invalidate = useThree(state => state.invalidate)
  useEffect(() => {
    callbackRef.current = invalidate
    return () => { callbackRef.current = null }
  }, [callbackRef, invalidate])
  return null
}

export default function GlassesOverlay(props: GlassesOverlayProps) {
  return (
    <Canvas
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
      dpr={[1, 1.5]}
      frameloop="demand"
      orthographic
      camera={{ near: -1000, far: 1000, position: [0, 0, 200] }}
      gl={{ alpha: true, antialias: true }}
      onCreated={({ gl }) => gl.setClearColor(0x000000, 0)}
    >
      <TrackingInvalidation callbackRef={props.invalidateTrackingRef} />
      <ambientLight intensity={1.5} />
      <directionalLight position={[0, 5, 5]} intensity={1} />
      <directionalLight position={[0, -3, 3]} intensity={0.4} />
      <Suspense key={props.modelPath} fallback={null}>
        <GlassesModel {...props} />
      </Suspense>
    </Canvas>
  )
}
