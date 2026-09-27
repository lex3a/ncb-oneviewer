/** RGBA palette, 8 bits per channel, alpha already expanded to 0..255. */
export type Palette = Uint8ClampedArray

/** PS2 CLUT layout: in 256-color palettes, bits 3 and 4 of the index are swapped. */
const unswizzle = (i: number) => (i & 0xe7) | ((i & 0x08) << 1) | ((i & 0x10) >> 1)

/**
 * Reads a PS2/PSP-style palette: R, G, B, A bytes where alpha 0x80 means opaque.
 * 256-color palettes are stored CLUT-swizzled and are reordered here.
 */
export function readPalette(bytes: Uint8Array, offset: number, count: number): Palette {
  const pal = new Uint8ClampedArray(count * 4)
  for (let i = 0; i < count; i++) {
    const o = offset + (count === 256 ? unswizzle(i) : i) * 4
    pal[i * 4] = bytes[o]
    pal[i * 4 + 1] = bytes[o + 1]
    pal[i * 4 + 2] = bytes[o + 2]
    const a = bytes[o + 3]
    // Same scaling as the game's loaders: (a * 255) >> 7, so 0x80 is fully opaque.
    pal[i * 4 + 3] = Math.min(255, (a * 255) >> 7)
  }
  return pal
}

/** Expands packed 4bpp/8bpp indices to RGBA. 4bpp uses low nibble first. */
export function indicesToRgba(
  data: Uint8Array,
  width: number,
  height: number,
  bpp: 4 | 8,
  pal: Palette,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4)
  const n = width * height
  const colors = pal.length / 4
  for (let i = 0; i < n; i++) {
    let idx: number
    if (bpp === 8) idx = data[i] ?? 0
    else {
      const b = data[i >> 1] ?? 0
      idx = i & 1 ? b >> 4 : b & 0x0f
    }
    if (idx >= colors) continue
    out[i * 4] = pal[idx * 4]
    out[i * 4 + 1] = pal[idx * 4 + 1]
    out[i * 4 + 2] = pal[idx * 4 + 2]
    out[i * 4 + 3] = pal[idx * 4 + 3]
  }
  return out
}

export interface RgbaImage {
  width: number
  height: number
  rgba: Uint8ClampedArray
}
