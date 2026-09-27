/**
 * Placeholder scenes: a plain menu drawn on the 2D overlay, clearly marked "PLACEHOLDER", that stands
 * in for a scene of main() that is not ported yet and returns the same next scenes as the game's
 * function. They use the game's SE ids (1 cursor, 7 confirm, 9 cancel, 10 refused) and repeat timing.
 */
import type { Scene, SceneContext } from '../game'
import { SCENE_INFO, type GameSceneId } from '../gameScene'
import { PAD } from '../input'
import { PSP_H, PSP_W } from '../screen'

export interface MenuItem {
  label: string
  /** Shown dimmed and refused (SE 10) when false. */
  enabled?: boolean
  /** Right-aligned note (e.g. the step that will implement it). */
  hint?: string
  /** Returns the next scene (or undefined to stay). `scene` is the menu itself (to start a modal step). */
  run: (ctx: SceneContext, scene: MenuScene) => GameSceneId | undefined
}

export interface MenuSpec {
  title: string
  /** Lines under the title (status, what the real scene does). */
  info?: (ctx: SceneContext) => string[]
  items: (ctx: SceneContext) => MenuItem[]
  /** ○: the scene to return (undefined = ○ does nothing). */
  cancel?: (ctx: SceneContext) => GameSceneId | undefined
  /** L / R handler (e.g. deck slot). */
  shoulder?: (ctx: SceneContext, dir: -1 | 1) => void
  /** bgmPlay id on entry (undefined = leave the music alone). */
  bgm?: number
  /** Frames without input before `idle` fires (the title's 900-frame attract timeout). */
  idle?: { frames: number; next: GameSceneId }
  onInit?: (ctx: SceneContext) => void
}

/** A step run inside a placeholder scene (the camp's saveDataScene states 0xE / 0xF): update returns true when finished. */
export interface MenuModal {
  update(ctx: SceneContext): boolean
  draw(ctx: SceneContext): void
  debug?(): string
}

export class MenuScene implements Scene {
  readonly id: GameSceneId
  readonly placeholder = true
  cursor = 0
  /** A running modal step: it gets the frames (and draws) until it is finished. */
  modal: MenuModal | null = null
  private spec: MenuSpec
  private idleFrames = 0
  private scroll = 0

  constructor(id: GameSceneId, spec: MenuSpec) {
    this.id = id
    this.spec = spec
  }

  init(ctx: SceneContext) {
    this.spec.onInit?.(ctx)
    if (this.spec.bgm !== undefined) ctx.audio.playBgm(this.spec.bgm)
    const items = this.spec.items(ctx)
    const first = items.findIndex((i) => i.enabled !== false)
    this.cursor = first < 0 ? 0 : first
  }

  update(ctx: SceneContext): GameSceneId {
    const { input, audio } = ctx
    if (this.modal) {
      if (this.modal.update(ctx)) this.modal = null
      return this.id
    }
    const items = this.spec.items(ctx)
    if (input.held) this.idleFrames = 0
    else if (this.spec.idle && ++this.idleFrames >= this.spec.idle.frames) return this.spec.idle.next
    if (!items.length) return this.id
    if (this.cursor >= items.length) this.cursor = items.length - 1
    if (input.repeat & PAD.UP) {
      this.cursor = (this.cursor + items.length - 1) % items.length
      audio.playSe(1)
    } else if (input.repeat & PAD.DOWN) {
      this.cursor = (this.cursor + 1) % items.length
      audio.playSe(1)
    } else if (input.repeat & (PAD.L | PAD.R) && this.spec.shoulder) {
      this.spec.shoulder(ctx, input.repeat & PAD.L ? -1 : 1)
      audio.playSe(5)
    } else if (input.pressed & PAD.CROSS) {
      const it = items[this.cursor]
      if (it.enabled === false) audio.playSe(10)
      else {
        audio.playSe(7)
        const next = it.run(ctx, this)
        if (next !== undefined) return next
      }
    } else if (input.pressed & PAD.CIRCLE && this.spec.cancel) {
      const next = this.spec.cancel(ctx)
      if (next !== undefined) {
        audio.playSe(9)
        return next
      }
    }
    return this.id
  }

  draw(ctx: SceneContext) {
    if (this.modal) return this.modal.draw(ctx)
    const items = this.spec.items(ctx)
    const info = this.spec.info?.(ctx) ?? []
    drawPlaceholder(ctx, this.id, this.spec.title, info, items, this.cursor, (s) => (this.scroll = s), this.scroll)
  }

  exit() {}

  debug() {
    return this.modal?.debug?.() ?? `menu cursor ${this.cursor}`
  }
}

/** The shared look: dark panel, "PLACEHOLDER" tag, scene id, title, info lines, the menu. */
export function drawPlaceholder(
  ctx: SceneContext,
  id: GameSceneId,
  title: string,
  info: string[],
  items: MenuItem[],
  cursor: number,
  setScroll?: (s: number) => void,
  scroll = 0,
) {
  const g = ctx.screen.overlay2d()
  g.fillStyle = '#0b1020'
  g.fillRect(0, 0, PSP_W, PSP_H)
  g.fillStyle = '#1b2440'
  g.fillRect(0, 0, PSP_W, 22)
  g.font = 'bold 10px monospace'
  g.textBaseline = 'middle'
  g.fillStyle = '#ffcc33'
  g.fillText('PLACEHOLDER', 8, 11)
  g.fillStyle = '#8fa3d9'
  const sc = SCENE_INFO.get(id)
  const tag = `scene 0x${id.toString(16)} ${sc?.name ?? ''}`
  g.fillText(tag, PSP_W - 8 - g.measureText(tag).width, 11)
  g.fillStyle = '#ffffff'
  g.font = 'bold 14px sans-serif'
  g.fillText(title, 12, 38)
  g.font = '10px sans-serif'
  g.fillStyle = '#b8c2dc'
  let y = 56
  for (const line of info.slice(0, 6)) {
    g.fillText(line, 12, y)
    y += 12
  }
  y += 4
  const rowH = 15
  const rows = Math.max(1, Math.floor((PSP_H - 18 - y) / rowH))
  let top = scroll
  if (cursor < top) top = cursor
  if (cursor >= top + rows) top = cursor - rows + 1
  setScroll?.(top)
  g.font = '11px sans-serif'
  items.slice(top, top + rows).forEach((it, k) => {
    const i = top + k
    const ry = y + k * rowH
    if (i === cursor) {
      g.fillStyle = '#2d4a8a'
      g.fillRect(8, ry - 7, PSP_W - 16, rowH - 1)
    }
    g.fillStyle = it.enabled === false ? '#5d6680' : '#ffffff'
    g.fillText(`${i === cursor ? '▶' : ' '} ${it.label}`, 14, ry)
    if (it.hint) {
      g.fillStyle = '#7f8bab'
      g.fillText(it.hint, PSP_W - 14 - g.measureText(it.hint).width, ry)
    }
  })
  if (items.length > rows) {
    g.fillStyle = '#7f8bab'
    g.fillText(`${cursor + 1}/${items.length}`, PSP_W - 50, PSP_H - 22)
  }
  g.fillStyle = '#7f8bab'
  g.font = '9px sans-serif'
  g.fillText('✕ confirm   ○ back   ↑↓ select' + (sc?.status === 'placeholder' ? '   (not ported yet: see docs/formats/play-mode.md)' : ''), 12, PSP_H - 8)
}

/** A placeholder with one line of text that goes on by itself or with START / ✕ (movies). */
export class TimedPlaceholder implements Scene {
  readonly id: GameSceneId
  readonly placeholder = true
  private frames = 0
  private title: string
  private lines: string[]
  private duration: number
  private next: (ctx: SceneContext) => GameSceneId
  private onInit?: (ctx: SceneContext) => void

  constructor(id: GameSceneId, title: string, lines: string[], duration: number, next: (ctx: SceneContext) => GameSceneId, onInit?: (ctx: SceneContext) => void) {
    this.id = id
    this.title = title
    this.lines = lines
    this.duration = duration
    this.next = next
    this.onInit = onInit
  }

  init(ctx: SceneContext) {
    this.frames = 0
    this.onInit?.(ctx)
  }

  update(ctx: SceneContext): GameSceneId {
    this.frames++
    if (this.frames >= this.duration || (this.frames > 1 && ctx.input.pressed & (PAD.START | PAD.CROSS))) return this.next(ctx)
    return this.id
  }

  draw(ctx: SceneContext) {
    drawPlaceholder(ctx, this.id, this.title, [...this.lines, `continues in ${Math.max(0, Math.ceil((this.duration - this.frames) / 60))} s (START / ✕ skips)`], [], 0)
  }

  exit() {}
}
