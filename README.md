# Virtual Try-On

Real-time glasses try-on with Next.js, MediaPipe Face Landmarker and React Three Fiber.

## Development

```sh
npm ci
npm run dev
```

Open http://localhost:3000 and allow camera access. Production camera access requires HTTPS. Select a frame to load its GLB model.

Installation copies the pinned MediaPipe WASM runtime into `public/mediapipe/wasm/`. The same copy runs before a production build. The Face Landmarker model downloads from Google's versioned model URL when tracking starts.

## Validation

```sh
npm test
npm run lint
npx tsc --noEmit
npm run build
```

Tests require Node 22.6+; application requirements follow Next.js 16.

See [tracking implementation, engine comparison and device validation](docs/tracking.md) for the tracking design, fitting conventions and remaining limitations.
