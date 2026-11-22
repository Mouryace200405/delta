// Sample pixel colours from a PNG without any image dependency.
// Usage: node scripts/sample-png.mjs <file.png> [x,y] [x,y] ...
import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

function decode(path) {
  const data = readFileSync(path)
  let pos = 8
  let width = 0
  let height = 0
  let colorType = 6
  const idat = []
  while (pos < data.length) {
    const length = data.readUInt32BE(pos)
    const type = data.toString('ascii', pos + 4, pos + 8)
    const chunk = data.subarray(pos + 8, pos + 8 + length)
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0)
      height = chunk.readUInt32BE(4)
      colorType = chunk[9]
    } else if (type === 'IDAT') {
      idat.push(chunk)
    }
    pos += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  const bpp = colorType === 6 ? 4 : 3
  const stride = width * bpp
  const out = Buffer.alloc(height * stride)
  let src = 0
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[src++]
    const line = Buffer.from(raw.subarray(src, src + stride))
    src += stride
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0
      const b = prev[x]
      const c = x >= bpp ? prev[x - bpp] : 0
      if (filter === 1) line[x] = (line[x] + a) & 255
      else if (filter === 2) line[x] = (line[x] + b) & 255
      else if (filter === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
        line[x] = (line[x] + pred) & 255
      }
    }
    line.copy(out, y * stride)
    prev = line
  }
  return { width, height, bpp, stride, data: out }
}

const [file, ...points] = process.argv.slice(2)
const img = decode(file)
console.log(`${file}  ${img.width}x${img.height}`)
const hex = (n) => n.toString(16).padStart(2, '0')
for (const point of points) {
  const [x, y] = point.split(',').map(Number)
  const o = y * img.stride + x * img.bpp
  const [r, g, b] = [img.data[o], img.data[o + 1], img.data[o + 2]]
  console.log(`  (${x},${y}) rgb(${r}, ${g}, ${b})  #${hex(r)}${hex(g)}${hex(b)}`)
}
