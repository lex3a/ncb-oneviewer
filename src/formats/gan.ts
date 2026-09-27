import { indicesToRgba, readPalette, type Palette, type RgbaImage } from './palette'

/**
 * GAN — 4bpp sprite sheet(s) with animation. Mirrors the game's loader, ganLoadBuffer()
 * (FUN_08878ad4 in the USA EBOOT). See docs/formats/gan.md.
 *
 *   0x00 char[4]  "GAN\x10"
 *   0x04 u32      total size
 *   0x08 u8       bpp (4)
 *   0x0A u8       0x20 (copied by the loader, never read)
 *   0x10 u32      palette count P = 16 × image count
 *   0x14 u8 len + len bytes (skipped)
 *        P × 16-color palettes
 *   image × P/16: u32 id, u16 w, u16 h, u8 len + len bytes, 16-color palette (ignored), pixels
 *   u32 S, S × step (16 bytes): u8 frame, _, u8 duration (255 = forever), _, i8 x, _, i8 y, ...
 *   u32 F, F × frame: u32 partCount (≤ 32), partCount × part (20 bytes)
 *   u32 count + (count - 1) bytes, skipped by the loader (count is 0 in all files)
 */
export interface GanPart {
  /** Index of the source image. */
  image: number
  /** Global palette index: image = clut >> 4, palette within image = clut & 15. */
  clut: number
  sx: number
  sy: number
  dx: number
  dy: number
  w: number
  h: number
  flags: number
  /** Degrees, from a signed 12-bit angle (4096 = 360°). Only used when flags & 4. */
  angle: number
  /** Signed 4.12 fixed point, negative mirrors. Only used when flags & 8. */
  scaleX: number
  scaleY: number
}

export interface GanStep {
  frame: number
  /** Ticks; 255 means "forever" (the game stores it as 0x10000000). */
  duration: number
  /** Copied by the loader but never read by the engine (editor metadata). */
  x: number
  y: number
}

export interface GanImage {
  id: number
  width: number
  height: number
  indices: Uint8Array
}

export interface Gan {
  size: number
  bpp: number
  /** Palettes exactly as stored in the file. */
  rawPalettes: Palette[]
  /** Palettes as the game uploads them (alpha forced, #12 cleared, #15 silhouette). */
  palettes: Palette[]
  images: GanImage[]
  steps: GanStep[]
  frames: GanPart[][]
  /**
   * Steps whose frame contains a marker part (palette 12); the game keeps up to 4. In battle the
   * first one of the attack animation is the impact frame (damage + effect script start).
   */
  markerSteps: number[]
  warning?: string
}

export const HOLD = 255
export const MARKER_PALETTE = 12
export const SILHOUETTE_PALETTE = 15

export function isGan(b: Uint8Array): boolean {
  return b.length >= 0x20 && b[0] === 0x47 && b[1] === 0x41 && b[2] === 0x4e && b[3] === 0x10
}

export const isMarker = (p: GanPart) => (p.clut & 15) === MARKER_PALETTE

/** How the game blends a part: flags bit 0 enables the mode in bits 4–5. */
export function partBlend(p: GanPart): { alpha: number; additive: boolean } {
  if (!(p.flags & 1)) return { alpha: 1, additive: false }
  switch ((p.flags >> 4) & 3) {
    case 0:
      return { alpha: 0.5, additive: false }
    case 1:
      return { alpha: 1, additive: true }
    case 2:
      return { alpha: 0, additive: false }
    default:
      return { alpha: 0.25, additive: true }
  }
}

/** Palette tweaks done by ganLoadBuffer() while uploading CLUTs. */
function gamePalette(raw: Palette, index: number): Palette {
  const pal = new Uint8ClampedArray(raw)
  const slot = index & 15
  for (let i = 0; i < 16; i++) {
    if (pal[i * 4 + 3]) pal[i * 4 + 3] = 255
    if (slot === MARKER_PALETTE) pal.fill(0, i * 4, i * 4 + 4)
    if (slot === SILHOUETTE_PALETTE) pal.set(i === 0 ? [0, 0, 0, 0] : [1, 1, 1, 255], i * 4)
  }
  return pal
}

export function parseGan(bytes: Uint8Array): Gan {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const size = dv.getUint32(4, true)
  const bpp = bytes[8] || 4
  const palCount = dv.getUint32(0x10, true)
  const imageCount = palCount >> 4
  const skipField = (at: number) => at + 1 + bytes[at]

  let o = skipField(0x14)
  const rawPalettes: Palette[] = []
  for (let i = 0; i < palCount; i++, o += 64) rawPalettes.push(readPalette(bytes, o, 16))
  const palettes = rawPalettes.map(gamePalette)

  const images: GanImage[] = []
  for (let i = 0; i < imageCount; i++) {
    const id = dv.getUint32(o, true)
    const width = dv.getUint16(o + 4, true)
    const height = dv.getUint16(o + 6, true)
    o = skipField(o + 8) + 64
    const len = (width * height * bpp) >> 3
    images.push({ id, width, height, indices: bytes.slice(o, o + len) })
    o += len
  }

  const steps: GanStep[] = []
  const frames: GanPart[][] = []
  let warning: string | undefined
  try {
    const stepCount = dv.getUint16(o, true)
    o += 4
    for (let i = 0; i < stepCount; i++, o += 16) {
      steps.push({ frame: bytes[o], duration: bytes[o + 2], x: dv.getInt8(o + 4), y: dv.getInt8(o + 6) })
    }
    const frameCount = dv.getUint16(o, true)
    o += 4
    for (let i = 0; i < frameCount; i++) {
      const n = dv.getInt16(o, true)
      o += 4
      const parts: GanPart[] = []
      for (let p = 0; p < n; p++, o += 20) {
        const a = dv.getUint16(o + 14, true)
        parts.push({
          image: Math.min(dv.getUint16(o, true), Math.max(0, imageCount - 1)),
          clut: Math.min(dv.getUint16(o + 2, true), Math.max(0, palCount - 1)),
          sx: bytes[o + 4],
          sy: bytes[o + 5],
          dx: bytes[o + 6],
          dy: bytes[o + 7],
          w: dv.getUint16(o + 8, true),
          h: dv.getUint16(o + 10, true),
          flags: bytes[o + 12],
          angle: ((a < 0x800 ? a : a - 0x1000) * 360) / 4096,
          scaleX: dv.getInt16(o + 16, true) / 4096,
          scaleY: dv.getInt16(o + 18, true) / 4096,
        })
      }
      frames.push(parts)
    }
    if (o + 8 !== size) warning = `Animation: expected end at 0x${size.toString(16)}, got 0x${(o + 8).toString(16)}`
  } catch (e) {
    warning = `Failed to parse animation: ${(e as Error).message}`
  }

  // Same as the loader: the first 4 frames with a marker, then up to 4 steps showing them.
  const markerFrames = new Set(frames.flatMap((f, i) => (f.some(isMarker) ? [i] : [])).slice(0, 4))
  const markerSteps = steps.flatMap((s, i) => (markerFrames.has(s.frame) ? [i] : [])).slice(0, 4)

  return { size, bpp, rawPalettes, palettes, images, steps, frames, markerSteps, warning }
}

/** Decodes one image with one palette (default: palette 0 of that image, as stored). */
export function ganSheet(g: Gan, image = 0, palette: Palette = g.rawPalettes[image * 16]): RgbaImage {
  const img = g.images[image]
  if (!img) return { width: 1, height: 1, rgba: new Uint8ClampedArray(4) }
  return { width: img.width, height: img.height, rgba: indicesToRgba(img.indices, img.width, img.height, 4, palette) }
}

export interface Bounds {
  x: number
  y: number
  w: number
  h: number
}

function partCorners(p: GanPart): [number, number][] {
  const cx = p.dx + p.w / 2
  const cy = p.dy + p.h / 2
  const sx = p.flags & 8 ? p.scaleX : 1
  const sy = p.flags & 8 ? p.scaleY : 1
  const a = p.flags & 4 ? (p.angle * Math.PI) / 180 : 0
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  return [
    [-p.w / 2, -p.h / 2],
    [p.w / 2, -p.h / 2],
    [p.w / 2, p.h / 2],
    [-p.w / 2, p.h / 2],
  ].map(([x, y]) => [cx + x * sx * cos - y * sy * sin, cy + x * sx * sin + y * sy * cos])
}

/** Bounding box of every part of every frame (so the stage doesn't jump around). */
export function ganBounds(g: Gan): Bounds {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const f of g.frames) {
    for (const p of f) {
      if (!isMarker(p) && (p.w <= 0 || p.h <= 0)) continue
      // Markers are not drawn, but keep their anchor on stage so the overlay can show it.
      for (const [x, y] of isMarker(p) ? [[p.dx - 5, p.dy - 5], [p.dx + 5, p.dy + 5]] : partCorners(p)) {
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y)
      }
    }
  }
  if (!isFinite(x0)) return { x: 0, y: 0, w: 1, h: 1 }
  x0 = Math.floor(x0); y0 = Math.floor(y0)
  return { x: x0, y: y0, w: Math.max(1, Math.ceil(x1) - x0), h: Math.max(1, Math.ceil(y1) - y0) }
}

/** Decoded sheets per (image, palette), built on demand. */
export type SheetCache = (image: number, clut: number) => CanvasImageSource

/**
 * Draws one frame the way the game does: the top-left of a part is at (dx, dy) relative to
 * the origin, rotation and scale pivot around the part's centre, and flags pick the blending.
 */
export function drawGanFrame(
  ctx: CanvasRenderingContext2D,
  sheets: SheetCache,
  parts: GanPart[] | undefined,
  originX: number,
  originY: number,
) {
  for (const p of parts ?? []) {
    if (p.w <= 0 || p.h <= 0 || isMarker(p)) continue
    const { alpha, additive } = partBlend(p)
    if (alpha <= 0) continue
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.globalCompositeOperation = additive ? 'lighter' : 'source-over'
    ctx.translate(originX + p.dx + p.w / 2, originY + p.dy + p.h / 2)
    if (p.flags & 4) ctx.rotate((p.angle * Math.PI) / 180)
    if (p.flags & 8) ctx.scale(p.scaleX, p.scaleY)
    ctx.drawImage(sheets(p.image, p.clut), p.sx, p.sy, p.w, p.h, -p.w / 2, -p.h / 2, p.w, p.h)
    ctx.restore()
  }
}
