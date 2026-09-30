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
4. Convert landmarks using the actual video width/height, centered cover crop and horizontal mirror. Extract scale-free matrix rotation; conjugate it for the mirror instead of negating arbitrary Euler angles. A landmark-basis fallback handles missing/invalid matrices.
5. Use 3D outer-eye distance for scale and the measured nose bridge in all three axes for the front-frame anchor, retaining the shared eye-relative depth origin. Apply a speed-adaptive position/rotation/scale filter with faster angular response during turns. Compensate short inference delays at render time: predict translation/rotation for at most 60 ms, capped at 5% of outer-eye distance and 0.08 radians. Stops, reversals, large jumps, gaps over 150 ms and loss/reacquisition clear prediction momentum; scale is never extrapolated. Glasses and occlusion masks share the predicted parent transform.
6. Normalize a private clone of each GLB **after** its export-axis correction. Keep the front plane at the anchor; long temples no longer define the rotation pivot. Bold Frame needs a 180-degree Y correction because its temples point along +Z.
7. Render a depth-only, 468-vertex face surface in the same filtered coordinate space as the glasses. Extend its oval boundary with a lightweight, closed side/rear shell so temple ends behind the estimated head volume are hidden too. The shell shares the exact face boundary and filtered transform, has no front cap, and disables itself on invalid outlines. Exposed branches and lenses remain subject to normal depth testing. The canvas renders on new tracking data instead of continuously, and GLBs load only when selected.
8. Clear immediately for explicit no-face results, hidden/paused video and camera errors. Lifecycle generations prevent a result captured before pause/backgrounding from reappearing after resume. Expire stale results with a separate 500 ms timer even if video callbacks stop. The iris-based PD readout uses pixel-correct distances, rejects poor observations and is explicitly approximate.

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

An additional renderer check compares the actual Aviator and Bold Frame GLBs with face-only versus head-shell occlusion at five synthetic orientations. The shell preserves the front-frame pixels in all ten comparisons and removes the detached rear hooks at bilateral 50-degree yaw. A small far-temple segment remains visible on Aviator at combined 40-degree yaw / -25-degree pitch: the skull proxy does not replace per-model fitting or measured ear/head geometry.

## Device acceptance before a production quality claim

Use actual iOS Safari and Android Chrome, including an older/mid-range phone. Record the same sequences for each candidate engine:

- A stationary face for 10 seconds: RMS/p95 bridge and outer-frame drift, relative to eye distance.
- Slow and fast yaw/pitch/roll, then abrupt stops: pose error, end-to-end latency and overshoot.
- Move toward/away from the camera: scale variation and temple alignment.
- Leave/re-enter frame, cover part of the face, blink, and change illumination: loss rate and reacquisition time.
- Compare every frame model from front, three-quarter and profile views; confirm the near lens stays visible and the far temple is occluded.
- Run for several minutes: inference/render p50/p95, long tasks, memory, dropped frames, thermal throttling and battery behavior.
- Deny permission, interrupt the camera, background/foreground the page, block a model download, then retry.

Current limits: monocular depth and an orthographic fit are approximations. The side/rear occluder is a conservative skull proxy derived from the face oval, not a measured head scan; it does not detect hair, ears or hands. Temple visibility around the ears still needs physical-device and multi-person validation. GLBs have no verified physical frame dimensions, so their default visual width ratio is not a size guarantee. Iris-based PD is an estimate. A calibrated perspective camera, verified frame measurements/anchors and a representative multi-person video benchmark are prerequisites for stronger fit/accuracy claims. Commercial SDKs have not been run in a head-to-head benchmark here.
