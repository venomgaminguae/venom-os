/**
 * Draws the placeholder app icon, desktop/app-icon.ico.
 *
 *   node scripts/make-icon.mjs                 writes desktop/app-icon.ico
 *   node scripts/make-icon.mjs --png out.png   also writes a 256px PNG preview
 *
 * The icon is drawn here from plain shapes (a dark rounded square, a cyan ring
 * and a dot), so it has no outside source and no licence of its own beyond
 * this project's. The output is the same bytes on every run.
 *
 * To use your own icon instead, replace desktop/app-icon.ico with any Windows
 * .ico file (include a 256px image) and run `npm run app:build` again.
 *
 * No dependencies: the .ico holds uncompressed 32-bit images at 16, 24, 32,
 * 48, 64 and 256 pixels.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'desktop', 'app-icon.ico')
const SIZES = [16, 24, 32, 48, 64, 256]

const BACK = [1, 6, 12]
const RING = [53, 224, 255]

/** Colour and coverage at a point of the unit square (0..1 on both axes). */
function sample(x, y) {
  // Rounded square, corner radius 0.22.
  const r = 0.22
  const cx = Math.min(Math.max(x, r), 1 - r)
  const cy = Math.min(Math.max(y, r), 1 - r)
  if (Math.hypot(x - cx, y - cy) > r) return null
  const d = Math.hypot(x - 0.5, y - 0.5)
  if ((d >= 0.27 && d <= 0.36) || d <= 0.1) return RING
  return BACK
}

/** RGBA pixels (top row first) of a size x size image, 4x4 samples per pixel. */
function draw(size) {
  const px = Buffer.alloc(size * size * 4)
  const n = 4
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let hit = 0
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const c = sample((x + (sx + 0.5) / n) / size, (y + (sy + 0.5) / n) / size)
          if (!c) continue
          r += c[0]
          g += c[1]
          b += c[2]
          hit++
        }
      }
      const i = (y * size + x) * 4
      if (hit) {
        px[i] = Math.round(r / hit)
        px[i + 1] = Math.round(g / hit)
        px[i + 2] = Math.round(b / hit)
        px[i + 3] = Math.round((hit / (n * n)) * 255)
      }
    }
  }
  return px
}

/** One .ico image: a 40-byte bitmap header, BGRA rows bottom-up, then an empty mask. */
function dib(size, rgba) {
  const head = Buffer.alloc(40)
  head.writeUInt32LE(40, 0)
  head.writeInt32LE(size, 4)
  head.writeInt32LE(size * 2, 8) // colour rows + mask rows
  head.writeUInt16LE(1, 12)
  head.writeUInt16LE(32, 14)
  head.writeUInt32LE(size * size * 4, 20)
  const body = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    const from = (size - 1 - y) * size * 4
    for (let x = 0; x < size; x++) {
      const s = from + x * 4
      const d = (y * size + x) * 4
      body[d] = rgba[s + 2]
      body[d + 1] = rgba[s + 1]
      body[d + 2] = rgba[s]
      body[d + 3] = rgba[s + 3]
    }
  }
  const maskRow = Math.ceil(size / 32) * 4
  return Buffer.concat([head, body, Buffer.alloc(maskRow * size)])
}

function ico(images) {
  const dir = Buffer.alloc(6 + 16 * images.length)
  dir.writeUInt16LE(1, 2)
  dir.writeUInt16LE(images.length, 4)
  let offset = dir.length
  images.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i
    dir[e] = size === 256 ? 0 : size
    dir[e + 1] = size === 256 ? 0 : size
    dir.writeUInt16LE(1, e + 4)
    dir.writeUInt16LE(32, e + 6)
    dir.writeUInt32LE(data.length, e + 8)
    dir.writeUInt32LE(offset, e + 12)
    offset += data.length
  })
  return Buffer.concat([dir, ...images.map((i) => i.data)])
}

function png(size, rgba) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const out = Buffer.alloc(8 + data.length + 4)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(zlib.crc32(body) >>> 0, 8 + data.length)
    return out
  }
  const head = Buffer.alloc(13)
  head.writeUInt32BE(size, 0)
  head.writeUInt32BE(size, 4)
  head[8] = 8
  head[9] = 6
  const rows = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', head),
    chunk('IDAT', zlib.deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const images = SIZES.map((size) => ({ size, data: dib(size, draw(size)) }))
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, ico(images))
console.log(`wrote ${OUT} (${SIZES.join(', ')} px)`)

const at = process.argv.indexOf('--png')
if (at >= 0 && process.argv[at + 1]) {
  const file = resolve(process.argv[at + 1])
  writeFileSync(file, png(256, draw(256)))
  console.log(`wrote ${file}`)
}
