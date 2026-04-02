export interface Glasses {
  id: string
  name: string
  modelPath: string
  price: number
  color: string // for thumbnail placeholder
}

export const GLASSES_CATALOG: Glasses[] = [
  {
    id: 'aviator-classic',
    name: 'Aviator Classic',
    modelPath: '/models/aviator_sunglasses.glb',
    price: 199,
    color: '#2a2a2a',
  },
  {
    id: 'aviator-gold',
    name: 'Aviator Gold',
    modelPath: '/models/aviator_sunglasses.glb',
    price: 249,
    color: '#c9a84c',
  },
  {
    id: 'aviator-silver',
    name: 'Aviator Silver',
    modelPath: '/models/aviator_sunglasses.glb',
    price: 229,
    color: '#a0aec0',
  },
]
