/**
 * spriteDraw for the 2D scenes of Play mode (title, name entry), on the `wide` layer (the 640×448
 * virtual space rendered into 480×272, as the GE does):
 *  - a virtual-space sprite: vertex = position + trunc(corner), then x·480/640 and y·272/448
 *    truncated (spriteUpdateVertices / spriteDraw2D; windows.md);
 *  - a sprite with `nativeCoords` = 1 (the 480×272 backgrounds): drawn 1:1 in screen pixels.
 */
import type { GlRenderer, Vertex } from '../effect/gl'
import type { RgbaImage } from '../formats/palette'

type Rgba = [number, number, number, number]
const Z = 0x7fff / 65535
const WHITE: Rgba = [1, 1, 1, 1]
/** Virtual → screen truncation, back in virtual units (the wide layer's space). */
const scrX = (v: number) => (Math.trunc((v * 480) / 640) * 640) / 480
const scrY = (v: number) => (Math.trunc((v * 272) / 448) * 448) / 272

function quad(gl: GlRenderer, img: RgbaImage, x0: number, y0: number, x1: number, y1: number, u0: number, v0: number, u1: number, v1: number, color: Rgba) {
  const P = (x: number, y: number, u: number, v: number): Vertex => ({ x, y, w: 1, d: Z, u: u / img.width, v: v / img.height })
  const A = P(x0, y0, u0, v0), B = P(x1, y0, u1, v0), C = P(x0, y1, u0, v1), D = P(x1, y1, u1, v1)
  gl.triangles(gl.texture(img), 'alpha', [A, B, C, B, D, C], color)
}

/** spriteSetSrcRect(u0, v0, u1, v1) + spriteDraw(x, y) of a virtual-space sprite (top-left anchor). */
export function drawSprite(gl: GlRenderer, img: RgbaImage | null, u0: number, v0: number, u1: number, v1: number, x: number, y: number, color: Rgba = WHITE) {
  if (!img) return
  const w = u1 - u0, h = v1 - v0
  quad(gl, img, scrX(x), scrY(y), scrX(x + w), scrY(y + h), u0, v0, u1, v1, color)
}

/** spriteDraw(x, y) of a whole image with nativeCoords = 1: screen pixels, 1:1. */
export function drawNative(gl: GlRenderer, img: RgbaImage | null, x = 0, y = 0) {
  if (!img) return
  const sx = 640 / 480, sy = 448 / 272
  quad(gl, img, x * sx, y * sy, (x + img.width) * sx, (y + img.height) * sy, 0, 0, img.width, img.height, WHITE)
}

/** spriteSetColor(r, g, b, a) (0..128 = 1.0): RGB keep ((c·255) >> 11) & 15, alpha ((a·255) >> 7) >> 4 (windows.md). */
export function spriteColor(r: number, g: number, b: number, a: number): Rgba {
  const n = (c: number) => ((((c * 255) >> 11) & 15) * 17) / 255
  return [n(r), n(g), n(b), (Math.min(15, ((a * 255) >> 7) >> 4) * 17) / 255]
}

/**
 * spriteDraw of a virtual-space sprite with a scale and a pivot: vertex = position + offset + pivot +
 * trunc(scale·(corner − pivot)), corners 0..w / 0..h of the source rect. `offset` is 0 (the quad
 * stays in place: spriteSetAnchor only moves the pivot) or −pivot after spriteResetOffset (the pivot
 * lands on the draw point).
 */
export function drawSpriteEx(
  gl: GlRenderer,
  img: RgbaImage | null,
  u0: number,
  v0: number,
  u1: number,
  v1: number,
  x: number,
  y: number,
  o: { color?: Rgba; sx?: number; sy?: number; px?: number; py?: number; resetOffset?: boolean } = {},
) {
  if (!img) return
  const w = u1 - u0, h = v1 - v0
  const sx = o.sx ?? 1, sy = o.sy ?? 1, px = o.px ?? 0, py = o.py ?? 0
  const ox = o.resetOffset ? -px : 0, oy = o.resetOffset ? -py : 0
  const X = (c: number) => scrX(x + ox + px + Math.trunc(sx * (c - px)))
  const Y = (c: number) => scrY(y + oy + py + Math.trunc(sy * (c - py)))
  quad(gl, img, X(0), Y(0), X(w), Y(h), u0, v0, u1, v1, o.color ?? WHITE)
}
