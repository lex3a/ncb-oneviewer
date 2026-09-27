/**
 * The PSP screen of Play mode: 480×272 frame buffers stacked in one element and scaled by CSS with
 * nearest-neighbour filtering (crisp pixels at ×2 / ×3).
 *  - `main`: WebGL in the 480×272 space (the map board draws its own sprites here).
 *  - `wide`: WebGL in the game's 640×448 virtual 2D space (duel, story events, deck editor, windows),
 *    rendered into a 480×272 buffer like the GE does.
 *  - `overlay`: a 2D canvas (card screen, placeholder menus).
 * A layer that was not drawn during a frame is hidden, so each scene shows only what it draws.
 */
import { GlRenderer } from '../effect/gl'

export const PSP_W = 480
export const PSP_H = 272
export const VIRTUAL_W = 640
export const VIRTUAL_H = 448

export type Layer = 'main' | 'wide' | 'overlay'

export class Screen {
  readonly main: GlRenderer
  readonly wide: GlRenderer
  readonly overlay: CanvasRenderingContext2D
  /** The element holding the layers (a movie's <video> is added here, above them). */
  readonly host: HTMLElement
  private els: Record<Layer, HTMLCanvasElement>
  private used = new Set<Layer>()
  private shown = new Set<Layer>()
  private smoothTex = true
  /** Bilinear texture filtering (the GE's sceGuTexFilter(1, 1)); off = nearest. Also used for the card screen's scaled images (2D canvas). */
  set smooth(v: boolean) {
    this.smoothTex = v
    this.main.smooth = v
    this.wide.smooth = v
  }
  get smooth(): boolean {
    return this.smoothTex
  }

  /** Viewer: how the 480×272 layers are scaled up to the window — false = crisp pixels, true = smoothed by the browser. */
  set smoothScaling(v: boolean) {
    for (const c of Object.values(this.els)) c.classList.toggle('smooth', v)
  }

  constructor(host: HTMLElement) {
    this.host = host
    const make = (z: number) => {
      const c = document.createElement('canvas')
      c.width = PSP_W
      c.height = PSP_H
      c.className = 'play-layer'
      c.style.zIndex = String(z)
      c.style.visibility = 'hidden'
      host.appendChild(c)
      return c
    }
    this.els = { main: make(1), wide: make(2), overlay: make(3) }
    this.main = new GlRenderer(this.els.main, PSP_W, PSP_H)
    this.wide = new GlRenderer(this.els.wide, VIRTUAL_W, VIRTUAL_H)
    this.overlay = this.els.overlay.getContext('2d')!
  }

  /** Mark a layer as drawn this frame (and return it for convenience). */
  use<L extends Layer>(layer: L): L extends 'overlay' ? CanvasRenderingContext2D : GlRenderer {
    this.used.add(layer)
    return (layer === 'overlay' ? this.overlay : this[layer]) as L extends 'overlay' ? CanvasRenderingContext2D : GlRenderer
  }

  /** The 2D overlay, cleared and marked as used. */
  overlay2d(): CanvasRenderingContext2D {
    const ctx = this.use('overlay')
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, PSP_W, PSP_H)
    return ctx
  }

  beginFrame() {
    this.used.clear()
  }

  /** Show the layers drawn this frame, hide the others. */
  endFrame() {
    for (const l of ['main', 'wide', 'overlay'] as Layer[]) {
      const on = this.used.has(l)
      if (on === this.shown.has(l)) continue
      this.els[l].style.visibility = on ? 'visible' : 'hidden'
      if (on) this.shown.add(l)
      else this.shown.delete(l)
    }
  }

  /** The visible frame as one canvas (screenshots from the debug overlay). */
  snapshot(): HTMLCanvasElement {
    const c = document.createElement('canvas')
    c.width = PSP_W
    c.height = PSP_H
    const g = c.getContext('2d')!
    g.fillStyle = '#000'
    g.fillRect(0, 0, PSP_W, PSP_H)
    for (const l of ['main', 'wide', 'overlay'] as Layer[]) if (this.shown.has(l)) g.drawImage(this.els[l], 0, 0)
    return c
  }

  dispose() {
    for (const c of Object.values(this.els)) {
      c.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext()
      c.remove()
    }
  }
}
