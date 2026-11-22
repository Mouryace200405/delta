/**
 * Generate the application icon.
 *
 * The mark is the Delta symbol drawn as a triangle inside a triangle: nothing
 * else. The geometry comes from the original artwork — an outer triangle with
 * a smaller one nested in its lower half — and the strokes sit *inside* the
 * outline, so the two shapes never overlap.
 *
 * The background is left transparent: the mark is the icon, not a tile with
 * the mark painted on it.
 *
 * A small PNG writer is used so the icon can be produced without pulling in
 * an image library.
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = 512

/** The artwork the mark comes from, in its own 738 × 602 coordinates. */
const ART = {
  outer: [
    [369, 129],
    [542.205, 429],
    [195.795, 429],
  ],
  inner: [
    [369, 229],
    [455.603, 379],
    [282.397, 379],
  ],
  stroke: 20,
}

const NORD = {
  frost: '#88C0D0',
  snowStorm: '#ECEFF4',
}

/** The sizes a Linux desktop expects in its icon folders. */
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512]

function hex(color) {
  const value = color.replace('#', '')
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ]
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** Encode an RGBA pixel buffer as a PNG. */
function encodePng(width, height, pixels) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Fit the artwork into a square of `size`, centred, with a margin.
 *
 * The artwork is measured from its own coordinates, so the proportions of
 * the original drawing are kept exactly.
 */
function geometry(size) {
  const xs = ART.outer.flatMap(([x]) => x)
  const ys = ART.outer.flatMap(([, y]) => y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)

  const margin = size * 0.117
  const scale = Math.min((size - margin * 2) / (maxX - minX), (size - margin * 2) / (maxY - minY))
  const centerX = (minX + maxX) / 2
  const centerY = (minY + maxY) / 2

  const move = (points) =>
    points.map(([x, y]) => [size / 2 + (x - centerX) * scale, size / 2 + (y - centerY) * scale])

  return {
    outer: move(ART.outer),
    inner: move(ART.inner),
    // The stroke is drawn on the inside of the outline, so half of it shows.
    stroke: (ART.stroke * scale) / 2,
  }
}

/** Distance from a point to a line segment. */
function distanceToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax
  const dy = by - ay
  const lengthSq = dx * dx + dy * dy
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq))
  const cx = ax + t * dx
  const cy = ay + t * dy
  return Math.hypot(px - cx, py - cy)
}

/** True when a point lies inside a triangle. */
function insideTriangle(px, py, vertices) {
  let inside = false
  for (let i = 0; i < 3; i++) {
    const [x1, y1] = vertices[i]
    const [x2, y2] = vertices[(i + 1) % 3]
    if (y1 > py !== y2 > py) {
      const crossing = x1 + ((py - y1) * (x2 - x1)) / (y2 - y1)
      if (px < crossing) inside = !inside
    }
  }
  return inside
}

/**
 * Coverage of a triangle outline at a point.
 *
 * The band sits on the inside of the outline, which is what the original
 * artwork does with its masks.
 */
function outlineCoverage(x, y, vertices, half) {
  if (!insideTriangle(x, y, vertices)) return 0
  let best = Infinity
  for (let i = 0; i < 3; i++) {
    const a = vertices[i]
    const b = vertices[(i + 1) % 3]
    best = Math.min(best, distanceToSegment(x, y, a, b))
  }
  return Math.max(0, Math.min(1, half + 0.5 - best))
}

function blend(target, index, color, alpha) {
  if (alpha <= 0) return
  for (let channel = 0; channel < 3; channel++) {
    target[index + channel] = Math.round(target[index + channel] * (1 - alpha) + color[channel] * alpha)
  }
  target[index + 3] = Math.round(target[index + 3] * (1 - alpha) + 255 * alpha)
}

/** Draw the mark at one size and return the PNG. */
function render(size) {
  const { outer, inner, stroke } = geometry(size)
  const outerColor = hex(NORD.frost)
  const innerColor = hex(NORD.snowStorm)
  const pixels = Buffer.alloc(size * size * 4)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const index = (y * size + x) * 4
      const px = x + 0.5
      const py = y + 0.5

      // The outer triangle first, then the inner one on top of it.
      blend(pixels, index, outerColor, outlineCoverage(px, py, outer, stroke))
      blend(pixels, index, innerColor, outlineCoverage(px, py, inner, stroke))
    }
  }

  return encodePng(size, size, pixels)
}

/** The same mark as a vector, for the scalable icon folder. */
function renderSvg() {
  const { outer, inner, stroke } = geometry(BASE)
  const path = (points) =>
    points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ') + ' Z'
  const width = (stroke * 2).toFixed(2)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${BASE}" height="${BASE}" viewBox="0 0 ${BASE} ${BASE}">
  <path d="${path(outer)}" fill="none" stroke="${NORD.frost}" stroke-width="${width}" stroke-linejoin="miter"/>
  <path d="${path(inner)}" fill="none" stroke="${NORD.snowStorm}" stroke-width="${width}" stroke-linejoin="miter"/>
</svg>
`
}

const outDir = join(ROOT, 'resources', 'icons')
mkdirSync(outDir, { recursive: true })

for (const size of SIZES) {
  writeFileSync(join(outDir, `icon-${size}.png`), render(size))
}
writeFileSync(join(outDir, 'icon.png'), render(BASE))
writeFileSync(join(outDir, 'icon.svg'), renderSvg())

console.log(`wrote ${SIZES.length + 1} icons and icon.svg to ${outDir}`)
