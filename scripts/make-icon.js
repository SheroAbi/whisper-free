// =============================================================================
// Generates build/icon.ico — the branded desktop / installer icon.
//
// Reuses the same equalizer-on-rounded-square glyph the app draws at runtime
// (src/main/assets.ts), rendered to PNGs at several sizes and packed into a
// multi-resolution ICO (PNG-compressed entries, supported on Windows Vista+).
//
//   node scripts/make-icon.js
// =============================================================================

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

// --- PNG encoding -----------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

function encodePng(rgba, width, height) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.writeUInt8(8, 8) // bit depth
  ihdr.writeUInt8(6, 9) // color type: RGBA
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

// --- tiny canvas (matches src/main/assets.ts) -------------------------------
class Canvas {
  constructor(w, h) {
    this.w = w
    this.h = h
    this.buf = Buffer.alloc(w * h * 4)
  }
  blend(x, y, [r, g, b, a]) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return
    const i = (y * this.w + x) * 4
    const sa = a / 255
    const da = this.buf[i + 3] / 255
    const outA = sa + da * (1 - sa)
    if (outA <= 0) return
    this.buf[i] = Math.round((r * sa + this.buf[i] * da * (1 - sa)) / outA)
    this.buf[i + 1] = Math.round((g * sa + this.buf[i + 1] * da * (1 - sa)) / outA)
    this.buf[i + 2] = Math.round((b * sa + this.buf[i + 2] * da * (1 - sa)) / outA)
    this.buf[i + 3] = Math.round(outA * 255)
  }
  roundedRect(x, y, w, h, r, color) {
    for (let py = Math.floor(y); py < y + h; py++) {
      for (let px = Math.floor(x); px < x + w; px++) {
        if (this.insideRounded(px + 0.5, py + 0.5, x, y, w, h, r)) this.blend(px, py, color)
      }
    }
  }
  insideRounded(px, py, x, y, w, h, r) {
    const x2 = x + w
    const y2 = y + h
    if (px < x || px > x2 || py < y || py > y2) return false
    const cx = Math.min(Math.max(px, x + r), x2 - r)
    const cy = Math.min(Math.max(py, y + r), y2 - r)
    const dx = px - cx
    const dy = py - cy
    return dx * dx + dy * dy <= r * r
  }
}

const BRAND = [91, 140, 255, 255]
const WHITE = [255, 255, 255, 235]

function buildPng(size) {
  const c = new Canvas(size, size)
  const radius = size * 0.24
  c.roundedRect(0, 0, size, size, radius, BRAND)
  c.roundedRect(0, 0, size, size * 0.5, radius, [255, 255, 255, 16])
  const bars = [0.42, 0.66, 0.92, 0.6, 0.36]
  const barW = size * 0.082
  const gap = size * 0.052
  const totalW = bars.length * barW + (bars.length - 1) * gap
  let bx = (size - totalW) / 2
  const baseY = size / 2
  for (const frac of bars) {
    const bh = size * 0.5 * frac
    c.roundedRect(bx, baseY - bh / 2, barW, bh, barW / 2, WHITE)
    bx += barW + gap
  }
  return encodePng(c.buf, size, size)
}

// --- ICO packing ------------------------------------------------------------
function buildIco(sizes) {
  const pngs = sizes.map((s) => ({ size: s, data: buildPng(s) }))
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(pngs.length, 4)

  const entries = []
  let offset = 6 + pngs.length * 16
  for (const p of pngs) {
    const e = Buffer.alloc(16)
    e.writeUInt8(p.size >= 256 ? 0 : p.size, 0) // width (0 == 256)
    e.writeUInt8(p.size >= 256 ? 0 : p.size, 1) // height
    e.writeUInt8(0, 2) // palette
    e.writeUInt8(0, 3) // reserved
    e.writeUInt16LE(1, 4) // color planes
    e.writeUInt16LE(32, 6) // bits per pixel
    e.writeUInt32LE(p.data.length, 8)
    e.writeUInt32LE(offset, 12)
    entries.push(e)
    offset += p.data.length
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)])
}

const root = path.resolve(__dirname, '..')
const outDir = path.join(root, 'build')
fs.mkdirSync(outDir, { recursive: true })
const outFile = path.join(outDir, 'icon.ico')
fs.writeFileSync(outFile, buildIco([16, 24, 32, 48, 64, 128, 256]))
console.log('Wrote', outFile)
