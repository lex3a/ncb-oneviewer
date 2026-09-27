import { indicesToRgba, readPalette, type Palette, type RgbaImage } from './palette'

/**
 * GBP — paletted image.
 *
 * Header (0x20 bytes, little endian):
 *   0x00 char[4]  "GBP\0"
 *   0x08 u32      total size (header + palette + pixel data)
 *   0x10 u16      width
 *   0x12 u16      height
 *   0x14 u8       format: 0x13 = 8bpp (256 colors), 0x14 = 4bpp (16 colors)
 *   0x16 u16      1
 *   0x18 u32      compression: 0 = raw, 1 = RLE, 2 = fill runs
 * Then palette (RGBA, alpha 0x80 = opaque), then pixel data.
 *
 * Compression works on the packed byte stream (2 pixels per byte for 4bpp):
 *   1: pairs of (value u8, count u8)
 *   2: u32 runCount, u32 fillByte, runCount × (u32 pos, u32 len), then literal
 *      bytes for everything outside the runs.
 */
export interface Gbp {
  width: number
  height: number
  bpp: 4 | 8
  format: number
  compression: number
  size: number
  palette: Palette
  /** Packed indices, decompressed. */
  indices: Uint8Array
  warning?: string
}

export function isGbp(b: Uint8Array): boolean {
  return b.length >= 0x20 && b[0] === 0x47 && b[1] === 0x42 && b[2] === 0x50 && b[3] === 0
}

export function parseGbp(bytes: Uint8Array): Gbp {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const size = Math.min(dv.getUint32(0x08, true) || bytes.length, bytes.length)
  const width = dv.getUint16(0x10, true)
  const height = dv.getUint16(0x12, true)
  const format = bytes[0x14]
  const compression = dv.getUint32(0x18, true)
  const bpp: 4 | 8 = format === 0x14 ? 4 : 8
  const colors = bpp === 8 ? 256 : 16
  const palette = readPalette(bytes, 0x20, colors)
  const dataStart = 0x20 + colors * 4
  const src = bytes.subarray(dataStart, size)
  const outLen = Math.ceil((width * height * bpp) / 8)
  const indices = new Uint8Array(outLen)
  let warning: string | undefined

  if (compression === 0) {
    indices.set(src.subarray(0, outLen))
    if (src.length < outLen) warning = `Not enough pixel data: ${src.length} < ${outLen}`
  } else if (compression === 1) {
    let o = 0
    for (let i = 0; i + 1 < src.length && o < outLen; i += 2) {
      const v = src[i]
      const n = src[i + 1]
      indices.fill(v, o, Math.min(o + n, outLen))
      o += n
    }
    if (o !== outLen) warning = `RLE: decoded ${o} bytes instead of ${outLen}`
  } else if (compression === 2) {
    const sv = new DataView(src.buffer, src.byteOffset, src.byteLength)
    const runs = sv.getUint32(0, true)
    const fill = sv.getUint32(4, true) & 0xff
    let lit = 8 + runs * 8
    let o = 0
    const copy = (end: number) => {
      const n = Math.max(0, Math.min(end, outLen) - o)
      indices.set(src.subarray(lit, lit + n), o)
      lit += n
      o += n
    }
    for (let k = 0; k < runs; k++) {
      const pos = sv.getUint32(8 + k * 8, true)
      const len = sv.getUint32(12 + k * 8, true)
      copy(pos)
      indices.fill(fill, o, Math.min(pos + len, outLen))
      o = Math.max(o, Math.min(pos + len, outLen))
    }
    copy(outLen)
    if (lit < src.length - 16 || o < outLen) warning = `Fill-runs: incomplete data (${o}/${outLen})`
    // Tail that the file didn't cover is left as the fill value.
    if (o < outLen) indices.fill(fill, o)
  } else {
    warning = `Unknown compression ${compression}`
  }

  return { width, height, bpp, format, compression, size, palette, indices, warning }
}

export function gbpToImage(g: Gbp, palette: Palette = g.palette): RgbaImage {
  return {
    width: g.width,
    height: g.height,
    rgba: indicesToRgba(g.indices, g.width, g.height, g.bpp, palette),
  }
}
