import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const source = join(dirname(require.resolve('@mediapipe/tasks-vision')), 'wasm')
const destination = fileURLToPath(new URL('../public/mediapipe/wasm/', import.meta.url))
await mkdir(destination, { recursive: true })
for (const file of await readdir(source)) {
  if (/^vision_wasm.*\.(js|wasm)$/.test(file)) await copyFile(join(source, file), join(destination, file))
}
