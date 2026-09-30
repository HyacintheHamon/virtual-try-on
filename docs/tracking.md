# Face tracking: implementation and validation

## Engine decision (30 September 2026)

This implementation keeps Google's Face Landmarker model and upgrades the JavaScript runtime from MediaPipe Tasks Vision 0.10.34 to the pinned stable 1.0.1. The runtime upgrade does **not** imply new model weights: the official `face_landmarker/float16/1` bundle remains in use. It provides 478 landmarks, including irises, and the canonical-to-camera facial transform.

There is no evidence here of universal superiority over commercial trackers. A defensible comparison needs the same recordings, camera parameters, frame models and target phones for every engine.

| Candidate | What the official documentation establishes | Decision |
| --- | --- | --- |
| MediaPipe Face Landmarker | Browser inference, facial transform, iris landmarks, GPU/CPU delegates; one-face mode enables landmark smoothing | Implement and validate in the existing Three.js stack |
| DeepAR | Browser AR, glasses effects, additional high-accuracy face-tracking mode; a domain license key is required | Benchmark with licensed access before considering replacement |
| Banuba Face AR | Web face tracking and eyewear features; integration requires a client token | Benchmark with licensed access before considering replacement |
| Jeeliz VTO | Eyewear-specific rendering; the public VTO-widget repository identifies itself as the legacy integration | Evaluate the current supported product, not an unverified swap to the legacy widget |

Sources:
- [Google Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker)
- [Google's web guide](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker/web_js)
- [Official sample dependency versions](https://github.com/google-ai-edge/mediapipe-samples-web/blob/main/package.json)
- [DeepAR Web API and license requirements](https://docs.deepar.ai/deepar-sdk/deep-ar-sdk-for-web/api-reference/)
- [Banuba integration](https://docs.banuba.com/far-sdk/tutorials/development/basic_integration/)
- [Jeeliz VTO repository](https://github.com/jeeliz/jeelizGlassesVTOWidget)
- [Speed-adaptive filtering research](https://gery.casiez.net/1euro/)

## Pipeline

1. Acquire the front camera. Late permission responses and unmounts stop their streams; a disconnect or failure offers Retry.
2. Schedule inference on `requestVideoFrameCallback` when supported, deduplicating video presentation times; retain a `requestAnimationFrame` fallback. Timestamp acquisition immediately before inference. Prefer a dedicated worker with a transferable ImageBitmap and **one frame in flight**. Extra source frames are dropped instead of queued. Software WebGL uses the CPU delegate. Unsupported workers, GPU initialization failures and worker inference failures have fallbacks.
3. Serve WASM files from the installed package on the same origin. `postinstall` and `prebuild` copy them to `public/mediapipe/wasm`; generated binaries are not checked into git. Model weights still download from Google's versioned model URL. Images are processed locally; no frame upload is added.
4. Fit a single perspective 6-DoF pose against 22 weighted upper-face observations and Google's canonical face mesh. MediaPipe supplies a rotation seed; its translation is not copied into a camera with different optics. Robust translation followed by a bounded-iteration reprojection refinement downweights outliers. Require regional support, enough inliers, plausible depth/orientation and a bounded residual; reject poor fits instead of displaying an invented transform. Mouth, chin and eyelid motion do not drive the rigid fit.
5. Solve in unmirrored source-video coordinates and centimeters. The same camera intrinsics drive Three.js projection, including asymmetric focal lengths, principal point and centered `object-fit: cover`. Mirror the final canvas once, exactly like the video. Browser camera intrinsics are not exposed by `getUserMedia`: the default **60° long-edge field of view is an assumption**, not a device calibration. `GlassesOverlay.calibratedCamera` accepts measured source intrinsics; same-aspect resolution changes rescale them, while unknown sensor crops are rejected.
6. Use a constant canonical (or wearer-calibrated) face scale. Apparent size now follows perspective distance, without remeasuring and multiplying an eye-distance scale every frame. Filter the bridge position and quaternion, then reconstruct one rigid face-origin transform. Preserve bounded render-time prediction (60 ms, 5% of physical reference eye span, 0.08 radians), reset momentum after loss/gaps/reversals, and share the transform between glasses and depth meshes.
7. Normalize a private clone of each GLB after export-axis correction. Dimensioned models use explicit unit conversion, bridge and hinge anchors; their physical model width stays fixed across wearer scales. Unmeasured legacy models retain a clearly identified visual ratio of 1.55 outer-eye spans. Reconstruct the 468-vertex face mask by lifting observed image points at canonical-informed camera depths, then extend the face oval with the existing side/rear head shell in centimeters. Relative landmark Z is not treated as metric depth. The canvas renders only for new tracking data or the short prediction window, and GLBs load on selection.
8. Clear immediately for explicit no-face results, hidden/paused video and camera errors. For a rejected pose while a face is still detected, freeze the last rendered transform for at most 120 ms, with no prediction; repeated rejects cannot extend that window or the last accepted capture's 500 ms deadline. This avoids an immediate blink on one borderline observation while clearing sustained uncertainty. Lifecycle generations prevent a result captured before pause/backgrounding from reappearing after resume. Expire stale results with a separate 500 ms timer even if video callbacks stop. The iris-based PD readout uses pixel-correct distances, rejects poor observations and is explicitly approximate.

## Reference frame and personal fit

`Reference 52–18` is an original generated demo, not a commercial product or a scan. The GLB has a 140 mm overall width, nominal 52 × 35 mm lens openings, an 18 mm bridge and 140 mm temple centerlines. It uses centimeters, +Y up, +Z front, temples toward −Z, with the central bridge underside at the origin. Rebuild it deterministically with:

```sh
node scripts/generate-reference-glasses.mjs
```

The catalog marks it as a demo and does not show a price/cart action. `app/data/reference-frame.ts` contains its dimensions and anchors; `app/lib/glasses-fitting.ts` handles measured versus legacy visual fitting. For a real product, measure the actual frame, verify export units, and place the bridge/hinge anchors in its corrected axes. Bounding boxes alone cannot recover manufacturer dimensions.

**Adjust fit** optionally accepts a wearer-supplied measured PD. Never feed the iris-derived estimate above the form back into this calibration. It collects at least 15 fresh, frontal, eyes-open observations over at least 400 ms, reconstructs the iris centers at each canonical eye depth, checks pose quality/gaze/scale stability and freezes a robust median scale for the session. Camera/reference changes reset it. The dimensioned GLB remains fixed while face coordinates and translation scale together; this resolves a reference-size ambiguity without introducing circular calibration. It still depends on estimated eye depth and camera optics. Height/depth controls change a fixed local bridge offset, never per-frame screen-space offsets.

Canonical shape is generic. Per-person geometry is currently used for the observed occlusion surface and optional size reference; an identity-specific 3D head/ear reconstruction is not implemented. No calibration data or camera images are persisted or uploaded.

## Automated checks

Run on Node 22.6+ (native TypeScript stripping is used for tests):

```sh
npm ci
npm test
npm run lint
npx tsc --noEmit
npm run build
```

Tests cover portrait/landscape cropping; mirrored pitch, yaw, roll and combined rotations; scaled matrices and fallback pose; invalid landmarks; quaternion wraparound; adaptive filtering at different sample rates and during rapid motion; face loss/reacquisition; face-mask reprojection; nose-bridge depth; and PD behavior under head roll, blinking and unreliable input.

Head-shell regression tests use a nondegenerate 36-point oval and ray intersections to check the exact seam, open front, closed rear, hidden temple tips and visible lenses/near branches from frontal and bilateral rotated views. Invalid or collapsed outlines leave the last geometry buffer untouched and disable the shell in the renderer.

Motion tests cover direct bridge attachment across orientations and viewport sizes, fast angular filter response, bounded prediction at 15/30/60 Hz, abrupt stops/reversals, quaternion sign changes and reacquisition. At a synthetic constant yaw speed of 1 rad/s, filter-only steady lag is approximately 1.52 degrees (previously 3.04 degrees); this is not a measured device or end-to-end accuracy claim.

Scheduler tests exercise the compiled hook with controlled browser/engine mocks: video-frame cadence, capture timestamps, one inference in flight, stalled-stream expiry, pause/seek/background cancellation, rAF fallback and cleanup after repeated errors.

Browser verification uses an official MediaPipe portrait fixture as a simulated camera, the real model/WASM, and a production build. It exercises worker inference, on-demand GLB loading, pause/resume, viewport resize, and camera disconnect/retry. This is functional verification, **not** an accuracy or FPS benchmark on physical phones. Headless software rendering must not be used to advertise mobile performance.

The previous orthographic implementation also had a renderer check comparing the actual Aviator and Bold Frame GLBs with face-only versus head-shell occlusion at five synthetic orientations. The shell preserves the front-frame pixels in all ten comparisons and removes the detached rear hooks at bilateral 50-degree yaw. A small far-temple segment remains visible on Aviator at combined 40-degree yaw / -25-degree pitch: the skull proxy does not replace per-model fitting or measured ear/head geometry.

## Device acceptance before a production quality claim

Use actual iOS Safari and Android Chrome, including an older/mid-range phone. Record the same sequences for each candidate engine:

- A stationary face for 10 seconds: RMS/p95 bridge and outer-frame drift, relative to eye distance.
- Slow and fast yaw/pitch/roll, then abrupt stops: pose error, end-to-end latency and overshoot.
- Move toward/away from the camera: scale variation and temple alignment.
- Leave/re-enter frame, cover part of the face, blink, and change illumination: loss rate and reacquisition time.
- Compare every frame model from front, three-quarter and profile views; confirm the near lens stays visible and the far temple is occluded.
- Run for several minutes: inference/render p50/p95, long tasks, memory, dropped frames, thermal throttling and battery behavior.
- Deny permission, interrupt the camera, background/foreground the page, block a model download, then retry.

Current limits: the default focal length and generic face shape are assumptions; a lower reprojection error is not proof of lower real head-pose error. The side/rear occluder is a conservative skull proxy, not measured hair, ears or hands. The generated reference has known design dimensions, while existing catalog GLBs remain visual fits without verified physical measurements. Manual PD refines a scale reference but does not guarantee optical fitting. Physical-camera calibration, actual product measurements and a representative multi-person/device benchmark remain necessary before stronger accuracy or sizing claims. Commercial SDKs have not been compared head-to-head.

## Perspective validation (30 September 2026)

Focused tests exercise exact perspective projections through bilateral yaw/pitch/roll and distance changes; gross eye/nose/cheek outliers; nonrigid mouth motion; portrait/landscape intrinsics and mirrored cover crops; monocular scale ambiguity; atomic invalid-occlusion rejection; centimeter shell scaling; original GLB dimensions/anchors/materials; and measured-PD collection/rejection/reset behavior. Existing scheduler and temporal tests remain in place.

On the saved real 640 × 640 MediaPipe portrait fixture with the assumed 60° camera, weighted RMS on the final inlier set changes from 6.86 px (MediaPipe rotation with independently fitted translation) to 4.59 px (refined pose), with 18/22 inliers. Estimated pitch also changes by about 7.55°: these numbers measure reprojection under a model, not ground-truth pose or tracking superiority. Synthetic rigid-face tests verify mathematical consistency; they do not reproduce real facial morphology or phone cameras.

The canonical vertex data is converted without coordinate changes from Google's pinned MediaPipe source. The original OBJ, Apache-2.0 license and provenance are preserved under `app/data/vendor/mediapipe/`.

The final change passes 80 tests, ESLint, TypeScript and the production build. The production-browser flow with real model inference checks both reference and legacy GLBs, successful optional PD collection, repeat calibration, height/depth controls, immediate reset while paused, resume, resize and camera disconnect/retry, without uncaught page errors. The 63 mm input in this smoke test is arbitrary test data, not a measured PD of the portrait subject.

Static perspective renders compare Reference, Aviator and Bold using initial/refined poses and synthetic ±50° yaw. In all 12 comparisons, adding the skull shell preserves the anterior-geometry pixel count while reducing exposed rear-temple geometry. At ±70°, synthetic asymmetric facial shape with small stationary noise remains bounded; adding gross far-side outliers can legitimately fail the pose gate. The short frozen-pose grace reduces isolated blinking, but sustained poor support still hides the overlay. No physical-phone or multi-person accuracy benchmark has been completed.
