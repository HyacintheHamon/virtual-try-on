export interface Glasses {
  id: string
  name: string
  modelPath: string
  price: number
  color: string
  // Per-model rotation correction (Euler XYZ, radians) applied BEFORE face tracking.
  // Use this to fix GLB export orientation issues.
  // Common fixes:
  //   branches pointing down  → rotX: Math.PI        (flip 180° on X)
  //   facing backwards        → rotY: Math.PI        (flip 180° on Y)
  //   lying flat (Z-up model) → rotX: -Math.PI / 2   (Blender Z-up → Y-up)
  //   sideways                → rotZ: Math.PI / 2
  rotOffset?: [number, number, number]
}

const PI  = Math.PI
const PI2 = Math.PI / 2

export const GLASSES_CATALOG: Glasses[] = [
  {
    id: 'aviator-classic',
    name: 'Aviator Classic',
    modelPath: '/models/aviator_sunglasses.glb',
    price: 199,
    color: '#2a2a2a',
    rotOffset: [0, 0, 0],
  },
  {
    id: 'glasses-1',
    name: 'Round Classic',
    modelPath: '/models/glasses-1-.glb',
    price: 179,
    color: '#1a1a1a',
    rotOffset: [0, 0, 0],
  },
  {
    id: 'glasses-5b',
    name: 'Square Matte Black',
    modelPath: '/models/glasses-5b.glb',
    price: 219,
    color: '#111111',
    rotOffset: [0, 0, 0],
  },
  {
    id: 'glasses-5c',
    name: 'Square Tortoise',
    modelPath: '/models/glasses-5c.glb',
    price: 219,
    color: '#7B4F2E',
    rotOffset: [0, 0, 0],
  },
  {
    id: 'glasses-6',
    name: 'Oval Modern',
    modelPath: '/models/glasses-6.glb',
    price: 189,
    color: '#3d3d3d',
    rotOffset: [0, 0, 0],
  },
  {
    id: 'glasses-7b',
    name: 'Cat Eye Black',
    modelPath: '/models/glasses-7b.glb',
    price: 229,
    color: '#0a0a0a',
    rotOffset: [0, 0, 0],
  },
  {
    id: 'glasses-7c',
    name: 'Cat Eye Crystal',
    modelPath: '/models/glasses-7c.glb',
    price: 229,
    color: '#a0c4d8',
    rotOffset: [0, 0, 0],
  },
  {
    id: 'glasses-8b',
    name: 'Rectangular Steel',
    modelPath: '/models/glasses-8b.glb',
    price: 249,
    color: '#8a8a8a',
    rotOffset: [0, 0, 0],
  },
  {
    id: 'glasses-8c',
    name: 'Rectangular Rose Gold',
    modelPath: '/models/glasses-8c.glb',
    price: 249,
    color: '#c9836a',
    rotOffset: [0, 0, 0],
  },
  {
    id: 'glasses-9b',
    name: 'Slim Wire Black',
    modelPath: '/models/glasses-9b.glb',
    price: 189,
    color: '#222222',
    rotOffset: [0, 0, 0],
  },
  {
    id: 'glasses-9c',
    name: 'Slim Wire Gold',
    modelPath: '/models/glasses-9c.glb',
    price: 189,
    color: '#c9a84c',
    rotOffset: [0, 0, 0],
  },
  {
    id: 'glasses-10',
    name: 'Bold Frame',
    modelPath: '/models/glasses-10.glb',
    price: 259,
    color: '#2c2c2c',
    rotOffset: [0, 0, 0],
  },
  {
    id: 'glasses-11b',
    name: 'Retro Square Black',
    modelPath: '/models/glasses-11b.glb',
    price: 209,
    color: '#1c1c1c',
    rotOffset: [0, 0, 0],
  },
  {
    id: 'glasses-11c',
    name: 'Retro Square Havana',
    modelPath: '/models/glasses-11c.glb',
    price: 209,
    color: '#6B3A2A',
    rotOffset: [0, 0, 0],
  },
  {
    id: 'glasses-12',
    name: 'Geometric Pro',
    modelPath: '/models/glasses-12.glb',
    price: 269,
    color: '#444444',
    rotOffset: [0, 0, 0],
  },
]

// Suppress unused-variable warnings for helpers defined above
void PI; void PI2
