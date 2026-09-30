'use client'

import { useEffect, useRef, useMemo, Suspense } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { FacePoseSmoother, isTrackingFrameFresh } from '@/app/lib/face-tracking'
import type { TrackingFrame } from '@/app/lib/face-tracking'
import { FACE_TRIANGLES } from '@/app/data/face-triangles'
import { createHeadOcclusionGeometry, updateHeadOcclusionPositions } from '@/app/lib/head-occlusion'
import { FacePosePredictor } from '@/app/lib/pose-prediction'
import { PoseQualityGrace } from '@/app/lib/pose-quality-grace'

import { CANONICAL_BRIDGE, CANONICAL_EYE_DISTANCE, estimatePerspectiveFacePose } from '@/app/lib/perspective-face-pose'
import { applyCameraIntrinsics, createCameraIntrinsics } from '@/app/lib/perspective-camera'
import type { CameraIntrinsics } from '@/app/lib/perspective-camera'
import { updatePerspectiveOcclusionPositions } from '@/app/lib/perspective-occlusion'
import { getGlassesFittingTransform } from '@/app/lib/glasses-fitting'
import type { GlassesFitting } from '@/app/lib/glasses-fitting'
import { WearerScaleCalibrator } from '@/app/lib/wearer-scale-calibration'
import type { WearerCalibrationState } from '@/app/lib/wearer-scale-calibration'
import type { FitAdjustment } from './FitControls'

interface GlassesModelProps {
  modelPath: string
  landmarksRef: React.RefObject<TrackingFrame | null>
  videoRef: React.RefObject<HTMLVideoElement | null>
  rotOffset: [number, number, number]
  fitting?: GlassesFitting
  knownPdMm: number | null
  calibrationRequest: number
  adjustment: FitAdjustment
  calibratedCamera?: CameraIntrinsics
  onCalibrationChange: (state: WearerCalibrationState) => void
  onPoseStatusChange: (tracking: boolean) => void
}

function GlassesModel({ modelPath, landmarksRef, videoRef, rotOffset, fitting, knownPdMm, calibrationRequest,
  adjustment, calibratedCamera, onCalibrationChange, onPoseStatusChange, calibrator,
}: GlassesModelProps & { calibrator: WearerScaleCalibrator }) {
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
  const qualityGrace = useMemo(() => new PoseQualityGrace(), [])
  const rejectedPose = useRef(false)
  const lastFrame = useRef<TrackingFrame | null>(null)
  const { size, invalidate, camera } = useThree()
  const sourceCamera = useRef<CameraIntrinsics | null>(null)
  const faceScaleRef = useRef(1)
  const calibrationKey = useRef('')
  const poseStatus = useRef<boolean | null>(null)
  const glassesRef = useRef<THREE.Group>(null)
  const modelScaleRef = useRef<THREE.Group>(null)
  const bridgeLocal = useMemo(() => new THREE.Vector3(...CANONICAL_BRIDGE), [])
  const bridgeWorldOffset = useMemo(() => new THREE.Vector3(), [])
  const [rx, ry, rz] = rotOffset

  const { model, modelScale, fitMode } = useMemo(() => {
    // Never move/rotate useGLTF's shared cached scene. Normalize a private clone
    // AFTER the export-axis correction so width/anchor use the displayed axes.
    const model = new THREE.Group()
    const corrected = new THREE.Group()
    corrected.rotation.set(rx, ry, rz)
    corrected.add(gltf.scene.clone(true))
    model.add(corrected)
    model.updateMatrixWorld(true)
    const bounds = new THREE.Box3().setFromObject(model)
    const transform = getGlassesFittingTransform(bounds, CANONICAL_EYE_DISTANCE, fitting)
    corrected.position.copy(transform.offset)
    return { model, modelScale: transform.scale, fitMode: transform.mode }
  }, [gltf.scene, rx, ry, rz, fitting])

  const previousCamera = useRef('')
  const previousSettings = useRef('')
  const previousViewport = useRef('')
  useEffect(() => { invalidate() }, [knownPdMm, calibrationRequest, adjustment, calibratedCamera, invalidate])

  function publishCalibration(state: WearerCalibrationState) {
    const key = `${state.status}:${state.acceptedFrames}:${state.faceScale}:${state.rejection}`
    if (calibrationKey.current !== key) {
      calibrationKey.current = key
      onCalibrationChange(state)
    }
  }

  function publishPoseStatus(tracking: boolean) {
    if (poseStatus.current !== tracking) {
      poseStatus.current = tracking
      onPoseStatusChange(tracking)
    }
  }

  function holdRejectedPose(now: number) {
    // Preserve the last rendered transform briefly for a borderline observation;
    // do not extrapolate from rejected data or extend the window on more rejects.
    predictor.reset()
    const hold = qualityGrace.reject(now)
    if (groupRef.current) groupRef.current.visible = groupRef.current.visible && hold
    if (hold) invalidate()
    else { smoother.reset(); publishPoseStatus(false) }
  }

  useFrame(() => {
    const group = groupRef.current
    if (!group || !(camera instanceof THREE.PerspectiveCamera)) return
    const frame = landmarksRef.current
    const video = videoRef.current
    const now = performance.now()
    if (!frame || !isTrackingFrameFresh(frame, now) ||
        !video || video.paused || video.ended || document.hidden) {
      group.visible = false
      smoother.reset()
      predictor.reset()
      qualityGrace.reset()
      rejectedPose.current = false
      lastFrame.current = null
      publishPoseStatus(false)
      // A completed size reference is session-scoped; an unfinished capture
      // must not bridge a loss of face, pause, or a tab switch.
      if (calibrator.state.status === 'collecting') publishCalibration(calibrator.reset())
      return
    }

    const trackId = video.srcObject instanceof MediaStream ? video.srcObject.getVideoTracks()[0]?.id : ''
    const cameraKey = `${trackId}:${video.videoWidth}:${video.videoHeight}:${JSON.stringify(calibratedCamera ?? null)}`
    const settingsKey = `${cameraKey}:${knownPdMm}:${calibrationRequest}`
    if (previousSettings.current !== settingsKey) {
      previousSettings.current = settingsKey
      publishCalibration(calibrator.configure(knownPdMm, `${cameraKey}:${calibrationRequest}`))
      faceScaleRef.current = calibrator.state.faceScale ?? 1
      smoother.reset()
      predictor.reset()
      qualityGrace.reset()
      rejectedPose.current = false
      lastFrame.current = null
    }
    if (previousCamera.current !== cameraKey) {
      previousCamera.current = cameraKey
      sourceCamera.current = createCameraIntrinsics(
        { width: video.videoWidth, height: video.videoHeight }, calibratedCamera)
      previousViewport.current = ''
    }
    const intrinsics = sourceCamera.current
    if (!intrinsics) { group.visible = false; publishPoseStatus(false); return }
    const viewportKey = `${size.width}:${size.height}`
    if (previousViewport.current !== viewportKey) {
      previousViewport.current = viewportKey
      applyCameraIntrinsics(camera, intrinsics, size)
    }

    if (lastFrame.current === frame && rejectedPose.current) {
      holdRejectedPose(now)
      return
    }
    if (lastFrame.current !== frame) {
      lastFrame.current = frame
      // Solve once at canonical scale. A measured wearer reference then scales
      // both model-face coordinates and camera translation, never the GLB.
      const raw = estimatePerspectiveFacePose(frame.result, intrinsics)
      if (!raw) {
        rejectedPose.current = true
        holdRejectedPose(now)
        if (calibrator.state.status === 'collecting') publishCalibration(calibrator.reset())
        return
      }
      rejectedPose.current = false
      qualityGrace.accept(frame.timestampMs)
      const calibration = calibrator.observe({
        landmarks: frame.result.faceLandmarks[0], position: raw.position, rotation: raw.rotation,
        camera: intrinsics, timestampMs: frame.timestampMs,
        reprojectionErrorPx: raw.quality.rmsPx,
        inlierRatio: raw.quality.inlierCount / raw.quality.pointCount,
      })
      publishCalibration(calibration)
      const faceScale = calibration.faceScale ?? 1
      if (faceScale !== faceScaleRef.current) {
        faceScaleRef.current = faceScale
        smoother.reset()
        predictor.reset()
      }
      const fullPose = { position: raw.position.clone().multiplyScalar(faceScale), rotation: raw.rotation }
      const target = {
        position: raw.bridgePosition.clone().multiplyScalar(faceScale), rotation: raw.rotation,
        eyeDistance: raw.eyeDistance * faceScale,
      }
      const positions = faceGeometry.getAttribute('position') as THREE.BufferAttribute
      const hasOcclusion = updatePerspectiveOcclusionPositions(frame.result, intrinsics,
        fullPose, positions.array as Float32Array, faceScale)
      if (hasOcclusion) positions.needsUpdate = true
      if (occluderRef.current) occluderRef.current.visible = hasOcclusion
      const headPositions = headGeometry.getAttribute('position') as THREE.BufferAttribute
      const hasHeadOcclusion = hasOcclusion && updateHeadOcclusionPositions(
        positions.array as Float32Array, headPositions.array as Float32Array, target.eyeDistance)
      if (hasHeadOcclusion) headPositions.needsUpdate = true
      if (headOccluderRef.current) headOccluderRef.current.visible = hasHeadOcclusion
      predictor.update(target, smoother.update(target, frame.timestampMs), frame.timestampMs)
      publishPoseStatus(true)
    }

    const pose = predictor.sample(now)
    if (!pose) return
    const faceScale = faceScaleRef.current
    // Filter around the bridge to avoid a rotation lag becoming a translation
    // around the canonical model origin. Reconstruct one rigid transform for
    // glasses and all depth meshes; its scale stays exactly 1.
    bridgeWorldOffset.copy(bridgeLocal).multiplyScalar(faceScale).applyQuaternion(pose.rotation)
    group.position.copy(pose.position).sub(bridgeWorldOffset)
    group.quaternion.copy(pose.rotation)
    group.scale.setScalar(1)
    if (glassesRef.current) {
      glassesRef.current.position.copy(bridgeLocal).multiplyScalar(faceScale)
      glassesRef.current.position.y += (fitMode === 'visual' ? -pose.eyeDistance * 0.1 : 0) + adjustment.heightMm / 10
      glassesRef.current.position.z += (fitMode === 'visual' ? pose.eyeDistance * 0.04 : 0.15) + adjustment.depthMm / 10
    }
    if (modelScaleRef.current) {
      // Unknown legacy assets retain visual face-relative sizing; dimensioned
      // frames preserve their designed centimeter width across wearers.
      modelScaleRef.current.scale.setScalar(modelScale * (fitMode === 'visual' ? faceScale : 1))
    }
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
      <group ref={glassesRef}>
        <group ref={modelScaleRef} scale={modelScale} dispose={null}>
          <primitive object={model} />
        </group>
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
  const calibrator = useMemo(() => new WearerScaleCalibrator(), [])
  return (
    <Canvas
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', transform: 'scaleX(-1)' }}
      dpr={[1, 1.5]}
      frameloop="demand"
      camera={{ manual: true, near: 0.5, far: 500, position: [0, 0, 0] }}
      gl={{ alpha: true, antialias: true }}
      onCreated={({ gl }) => gl.setClearColor(0x000000, 0)}
    >
      <TrackingInvalidation callbackRef={props.invalidateTrackingRef} />
      <ambientLight intensity={1.5} />
      <directionalLight position={[0, 5, 5]} intensity={1} />
      <directionalLight position={[0, -3, 3]} intensity={0.4} />
      <Suspense key={props.modelPath} fallback={null}>
        <GlassesModel {...props} calibrator={calibrator} />
      </Suspense>
    </Canvas>
  )
}
