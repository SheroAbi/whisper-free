import zlib from 'node:zlib'
import { nativeImage, NativeImage } from 'electron'

// ---------------------------------------------------------------------------
// Runtime icon generation. We synthesize valid PNGs (a small equalizer glyph on
// a rounded brand square) so the app always has correct tray/window icons with
// zero binary assets in the repo. Drop a build/icon.ico to brand the installer.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

function encodePng(rgba: Buffer, width: number, height: number): Buffer {
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

type RGBA = [number, number, number, number]

class Canvas {
  buf: Buffer
  constructor(public w: number, public h: number) {
    this.buf = Buffer.alloc(w * h * 4) // transparent
  }
  blend(x: number, y: number, [r, g, b, a]: RGBA): void {
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
  roundedRect(x: number, y: number, w: number, h: number, r: number, color: RGBA): void {
    for (let py = Math.floor(y); py < y + h; py++) {
      for (let px = Math.floor(x); px < x + w; px++) {
        if (this.insideRounded(px + 0.5, py + 0.5, x, y, w, h, r)) {
          this.blend(px, py, color)
        }
      }
    }
  }
  private insideRounded(
    px: number,
    py: number,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number
  ): boolean {
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

function buildIcon(size: number, bg: RGBA, accent: RGBA): NativeImage {
  const c = new Canvas(size, size)
  const radius = size * 0.24
  c.roundedRect(0, 0, size, size, radius, bg)
  // soft top highlight
  c.roundedRect(0, 0, size, size * 0.5, radius, [255, 255, 255, 16])

  // equalizer bars
  const bars = [0.42, 0.66, 0.92, 0.6, 0.36]
  const barW = size * 0.082
  const gap = size * 0.052
  const totalW = bars.length * barW + (bars.length - 1) * gap
  let bx = (size - totalW) / 2
  const baseY = size / 2
  for (const frac of bars) {
    const bh = size * 0.5 * frac
    c.roundedRect(bx, baseY - bh / 2, barW, bh, barW / 2, accent)
    bx += barW + gap
  }
  return nativeImage.createFromBuffer(encodePng(c.buf, size, size), {
    width: size,
    height: size
  })
}

let _appIcon: NativeImage | null = null
let _trayIdle: NativeImage | null = null
let _trayRec: NativeImage | null = null

const BRAND: RGBA = [255, 56, 92, 255] // matches the UI accent (#FF385C)
const REC: RGBA = [255, 77, 94, 255]
const WHITE: RGBA = [255, 255, 255, 235]

export function getAppIcon(): NativeImage {
  if (!_appIcon) _appIcon = buildIcon(256, BRAND, WHITE)
  return _appIcon
}

export function getTrayIcon(recording: boolean): NativeImage {
  if (recording) {
    if (!_trayRec) _trayRec = buildIcon(32, REC, WHITE)
    return _trayRec
  }
  if (!_trayIdle) _trayIdle = buildIcon(32, BRAND, WHITE)
  return _trayIdle
}
