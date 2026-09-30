/**
 * Rebuild the original reference frame: node scripts/generate-reference-glasses.mjs
 * Design dimensions: 140 mm overall width, 52 x 35 mm lens opening, 18 mm bridge,
 * 140 mm temple centreline. These are a generated design, not a scanned product.
 * Model coordinates are centimetres, +Z front, -Z temples, +Y up. Bridge fit
 * anchor is [0,0,0]. No textures, remote downloads, randomness, or paid assets.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  Box3, BufferGeometry, CatmullRomCurve3, CylinderGeometry, DoubleSide,
  ExtrudeGeometry, Float32BufferAttribute, Group, Mesh, MeshPhysicalMaterial,
  MeshStandardMaterial, Path, Shape, ShapeGeometry, TubeGeometry, Vector3,
} from 'three'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'

// GLTFExporter uses the browser FileReader API for Blob packing. Node's Blob
// supplies the same bytes; no DOM/canvas is needed for this texture-free model.
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class {
    result = null
    onloadend = null
    onerror = null
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then(result => {
        this.result = result
        this.onloadend?.({ target: this })
      }).catch(error => this.onerror?.(error))
    }
  }
}

const fitting = {
  millimetersPerUnit: 10,
  frameWidthMm: 140,
  bridgeAnchor: [0, 0, 0],
  hingeAnchors: { left: [-6.75, 0.14, -0.33], right: [6.75, 0.14, -0.33] },
}
const root = new Group()
root.name = 'Reference 52-18-140 — original acetate design'
root.userData = {
  fitting,
  designDimensionsMm: { frameWidth: 140, lensOpeningWidth: 52, lensOpeningHeight: 35, bridge: 18, templeCenterlineLength: 140 },
  designNote: 'Procedurally generated reference design. Not a scan or a manufactured product.',
}
const acetate = new MeshPhysicalMaterial({
  name: 'Polished midnight acetate', color: 0x151918, roughness: 0.25,
  metalness: 0, clearcoat: 0.8, clearcoatRoughness: 0.18,
})
const metal = new MeshStandardMaterial({ name: 'Brushed champagne hinge', color: 0x9d9079, metalness: 0.8, roughness: 0.28 })
// Alpha blending preserves the camera preview behind the WebGL canvas. Real
// transmission would sample the WebGL scene, which does not contain that video.
const lens = new MeshPhysicalMaterial({
  name: 'Subtle smoke lens', color: 0x95a7a1, transparent: true, opacity: 0.14,
  roughness: 0.08, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.08,
  depthWrite: false, side: DoubleSide,
})

function roundedRect(width, height, radius, isHole = false) {
  const shape = isHole ? new Path() : new Shape()
  const x = -width / 2, y = -height / 2, r = radius
  shape.moveTo(x + r, y)
  shape.lineTo(x + width - r, y)
  shape.quadraticCurveTo(x + width, y, x + width, y + r)
  shape.lineTo(x + width, y + height - r)
  shape.quadraticCurveTo(x + width, y + height, x + width - r, y + height)
  shape.lineTo(x + r, y + height)
  shape.quadraticCurveTo(x, y + height, x, y + height - r)
  shape.lineTo(x, y + r)
  shape.quadraticCurveTo(x, y, x + r, y)
  return shape
}

function addMesh(geometry, material, name, position) {
  const mesh = new Mesh(geometry, material)
  mesh.name = name
  if (position) mesh.position.set(...position)
  root.add(mesh)
  return mesh
}

function templeCurve(side, length) {
  return new CatmullRomCurve3([
    new Vector3(side * 6.75, 0.55, -0.3),
    new Vector3(side * 6.83, 0.53, -length * 0.18 - 0.3),
    new Vector3(side * 6.78, 0.4, -length * 0.52 - 0.3),
    new Vector3(side * 6.5, 0.18, -length * 0.73 - 0.3),
    new Vector3(side * 6.15, -0.45, -length * 0.87 - 0.3),
    new Vector3(side * 5.84, -2.0, -length * 0.98 - 0.3),
    new Vector3(side * 5.72, -2.45, -length - 0.3),
  ], false, 'centripetal')
}

function makeTemple(side) {
  // Solve the path's Z length to obtain a 140 mm physical centreline.
  let low = 8, high = 15
  for (let i = 0; i < 40; i++) {
    const mid = (low + high) / 2
    if (templeCurve(side, mid).getLength() < 14) low = mid
    else high = mid
  }
  const curve = templeCurve(side, (low + high) / 2)
  const count = 80, radial = 12, positions = [], normals = [], indices = []
  for (let i = 0; i <= count; i++) {
    const t = i / count
    const point = curve.getPointAt(t)
    const tangent = curve.getTangentAt(t).normalize()
    const across = new Vector3().crossVectors(new Vector3(0, 1, 0), tangent).normalize()
    const up = new Vector3().crossVectors(tangent, across).normalize()
    const halfThickness = 0.13 - 0.035 * t
    const halfHeight = 0.25 - 0.06 * t
    for (let j = 0; j <= radial; j++) {
      const angle = j / radial * Math.PI * 2
      const c = Math.cos(angle), s = Math.sin(angle)
      const v = point.clone().addScaledVector(across, c * halfThickness).addScaledVector(up, s * halfHeight)
      positions.push(...v.toArray())
      normals.push(...across.clone().multiplyScalar(c / halfThickness).addScaledVector(up, s / halfHeight).normalize().toArray())
      if (i < count && j < radial) {
        const a = i * (radial + 1) + j, b = a + radial + 1
        indices.push(a, a + 1, b, b, a + 1, b + 1)
      }
    }
  }
  // Cap each end so the model is solid even viewed from behind the ears.
  for (const end of [0, count]) {
    const centerIndex = positions.length / 3
    positions.push(...curve.getPointAt(end / count).toArray())
    const normal = curve.getTangentAt(end / count).multiplyScalar(end === 0 ? -1 : 1)
    normals.push(...normal.toArray())
    for (let j = 0; j < radial; j++) {
      const a = end * (radial + 1) + j
      if (end === 0) indices.push(centerIndex, a + 1, a)
      else indices.push(centerIndex, a, a + 1)
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3))
  geometry.setIndex(indices)
  const temple = addMesh(geometry, acetate, side < 0 ? 'Left 140 mm temple' : 'Right 140 mm temple')
  temple.userData.centerlineLengthMm = curve.getLength() * 10
}

for (const side of [-1, 1]) {
  const label = side < 0 ? 'Left' : 'Right'
  const centerX = side * 3.5
  const outline = roundedRect(5.8, 4.1, 1.18)
  outline.holes.push(roundedRect(5.2, 3.5, 0.95, true))
  const rimGeometry = new ExtrudeGeometry(outline, { depth: 0.36, bevelEnabled: true, bevelSize: 0.055, bevelThickness: 0.055, bevelSegments: 3, curveSegments: 24, steps: 1 })
  rimGeometry.translate(centerX, -0.38, -0.18)
  addMesh(rimGeometry, acetate, label + ' rounded acetate rim')
  addMesh(new ShapeGeometry(roundedRect(5.22, 3.52, 0.95), 28), lens, label + ' smoke lens', [centerX, -0.38, 0.015])
  addMesh(new RoundedBoxGeometry(0.75, 0.6, 0.52, 3, 0.09), acetate, label + ' endpiece', [side * 6.625, 0.55, -0.065])
  addMesh(new RoundedBoxGeometry(0.18, 0.3, 0.62, 2, 0.035), metal, label + ' hinge', [side * 6.77, 0.55, -0.34])
  const rivet = addMesh(new CylinderGeometry(0.055, 0.055, 0.024, 16), metal, label + ' front rivet', [side * 6.58, 0.55, 0.21])
  rivet.rotation.x = Math.PI / 2
  makeTemple(side)
}
const bridge = new CatmullRomCurve3([
  new Vector3(-0.92, 0.37, -0.015),
  new Vector3(-0.54, 0.51, 0.01),
  new Vector3(0, 0.59, 0.03),
  new Vector3(0.54, 0.51, 0.01),
  new Vector3(0.92, 0.37, -0.015),
])
addMesh(new TubeGeometry(bridge, 36, 0.18, 12, false), acetate, 'Sculpted 18 mm bridge')

// The middle bridge tube has its underside at (0, .41, .03). Make that
// physical nose contact the origin, rather than the centre of the lens frame.
for (const child of root.children) child.position.add(new Vector3(0, -0.41, -0.03))
root.updateMatrixWorld(true)
const size = new Box3().setFromObject(root).getSize(new Vector3())
if (Math.abs(size.x * 10 - fitting.frameWidthMm) > 0.05) {
  throw new Error('Generated width does not match declared 140 mm: ' + size.x * 10)
}
const exporter = new GLTFExporter()
const binary = await exporter.parseAsync(root, { binary: true, onlyVisible: true, trs: true })
const target = fileURLToPath(new URL('../public/models/reference-frame.glb', import.meta.url))
await mkdir(fileURLToPath(new URL('../public/models/', import.meta.url)), { recursive: true })
await writeFile(target, Buffer.from(binary))
console.log(JSON.stringify({ file: target, bytes: binary.byteLength, dimensionsMm: size.toArray().map(v => Math.round(v * 100) / 10), fitting }))
