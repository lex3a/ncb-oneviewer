/**
 * The game's window list for the 2D scenes of Play mode (g_winListHead and menuWinUpdateAll
 * 0x08867E14): windows in list order (a window opened again is unlinked and appended), each with its
 * winPrintAt glyphs, the window-opening functions the menu scenes use (winOpenMessage, winOpenFrame,
 * winOpenMenu, winOpenFace), winUpdateInput / winGetCursor for menus and lists, winFadeClose,
 * winBringToFront, winSetText and winApproachPos. `tick` is menuWinUpdateAll's update part (flag 0x800
 * dimming, then the per-frame flags 0x80 / 0x100 / 0x200 / 0x400 are cleared), `draw` its draw part.
 */
import { WF_CENTER_X, WF_CENTER_Y, WF_MENU, WF_SCROLLBAR, WIN_CURSOR_COLORS, layoutText, type DuelWindow, type WindowPainter, type WinTables } from '../effect/windows'
import { buttonZones } from '../effect/buttonZones'
import type { GlRenderer } from '../effect/gl'
import type { RgbaImage } from '../formats/palette'
import { PAD } from './input'

interface Print {
  x: number
  y: number
  glyph: number
  wide: boolean
  text: Uint8Array
  at: number
}

interface Entry {
  key: string
  win: DuelWindow
  prints: Print[]
  /** Window.flags as the game keeps them (0x100 no input this frame, 0x10000 no wrap-around, …). */
  gflags: number
  /** Window.cursor (menus and lists). */
  cursor: number
}

/** Flags the painter reads (menu cursor, dividers, scroll bar, pointer, centring, dimming, face shift). */
const PAINTER_FLAGS = 0x4 | 0x8 | 0x10 | 0x20 | 0x800 | WF_CENTER_X | WF_CENTER_Y | 0x40000

/** What winUpdateInput needs from the pad (padGetHeld / Pressed / Repeat, the repeat timer) and sndPlaySe. */
export interface WinInput {
  held: number
  pressed: number
  repeat: number
  setRepeat(timer: number, delay: number): void
  /** Play mode (ours): the mouse in virtual 640×448 (−1 outside) and whether it moved this frame. */
  pointerX?: number
  pointerY?: number
  pointerMoved?: boolean
}

/** What `helpMouse` needs: the pad words it rewrites and the mouse. */
export interface WinMouse {
  pressed: number
  pointerX: number
  pointerY: number
}

export class WinList {
  list: Entry[] = []
  frame = 0
  /** Play mode (ours): the help label under the mouse, drawn with the menu cursor's bar. */
  hover: { key: string; x0: number; y0: number; x1: number; y1: number } | null = null
  private tables: WinTables

  constructor(tables: WinTables) {
    this.tables = tables
  }

  private entry(key: string) {
    return this.list.find((e) => e.key === key)
  }

  get(key: string): DuelWindow | undefined {
    return this.entry(key)?.win
  }

  isOpen(key: string) {
    return !!this.entry(key)
  }

  /** winClose. */
  close(key: string) {
    this.list = this.list.filter((e) => e.key !== key)
  }

  /** winCloseAll. */
  closeAll() {
    this.list = []
  }

  private append(key: string, win: DuelWindow, gflags = win.flags ?? 0) {
    this.close(key)
    const e: Entry = { key, win, prints: [], gflags, cursor: 0 }
    this.list.push(e)
    return e
  }

  /**
   * winOpenMessage(x, y, 0, 0, win, glyphW, lineH, text, 0, 0, flags): draw style 7, chamfer 5, alpha
   * 0x80, brightness 0x80, glyph fade 4; 0x1000 / 0x2000 size it to the text (w = text + 20,
   * h = lines + 18 for the style-7 text origin (10, 10)), 0x4000 / 0x8000 centre it.
   */
  openMessage(key: string, x: number, y: number, text: Uint8Array, glyph: number, flags: number): DuelWindow {
    const lay = layoutText(text, { glyph, tables: this.tables })
    const win: DuelWindow = {
      x,
      y,
      w: flags & 0x1000 ? lay.autoW : 0,
      h: flags & 0x2000 ? lay.autoH : 0,
      codes: [],
      text,
      glyph,
      opened: this.frame,
      style: 7,
      chamfer: 5,
      flags: flags & (WF_CENTER_X | WF_CENTER_Y | 0x800),
      alpha: 0x80,
      bright: 0x80,
    }
    this.append(key, win, flags)
    return win
  }

  /** winOpenFrame(x, y, w, h, chamfer, win, style, flags): a text-less frame (flags & 0xFF808 kept); re-opening closes it first. */
  openFrame(key: string, x: number, y: number, w: number, h: number, chamfer: number, style: number, flags: number): DuelWindow {
    const f = flags & 0xff808
    const win: DuelWindow = { x, y, w, h, codes: [], opened: this.frame, style, chamfer, flags: f & PAINTER_FLAGS, alpha: 0x80, bright: 0x80 }
    this.append(key, win, f)
    return win
  }

  /**
   * winOpenMenu (0x0887088C): nothing when the window is open; else flags 0x104 (0x100 = no input on
   * the opening frame), style 7, chamfer 5, list mode 2 (one row per ＠ｎ line), cursor bar at (10, 8),
   * h = rows · lineH + 14, w = (maxCol + 1) · advance, cursorW = w − 20.
   */
  openMenu(key: string, x: number, y: number, glyph: number, text: Uint8Array): DuelWindow {
    const old = this.get(key)
    if (old) return old
    const lay = layoutText(text, { glyph, tables: this.tables })
    let lines = 1
    for (let i = 0; i + 3 < text.length; i++) if (text[i] === 0x81 && text[i + 1] === 0x97 && text[i + 2] === 0x82 && text[i + 3] === 0x8e) lines++
    const adv = ((glyph + 1) & 0xff) >> 1
    const w = (lay.maxCol + 1) * adv
    const h = lines * glyph + 14
    const win: DuelWindow = {
      x,
      y,
      w,
      h,
      codes: [],
      glyph,
      opened: this.frame,
      style: 7,
      chamfer: 5,
      flags: WF_MENU,
      alpha: 0x80,
      bright: 0x80,
      menu: { row: 0, offX: 10, offY: 8, cursorW: Math.trunc(w) - 20, color: WIN_CURSOR_COLORS[0], itemCount: lines, visibleRows: lines, scrollTop: 0 },
    }
    const e = this.append(key, win, 0x104)
    // list mode 2 re-lays the rows out every frame (glyph fade 0x7F)
    e.prints.push({ x: 0, y: 0, glyph, wide: false, text, at: this.frame - 1 })
    return win
  }

  /**
   * winOpenFace(x, y, w, h, win, charaCardId, expr, flags): a text-less style-10 window, chamfer 16,
   * flags & 0xFF808, the face sprite (face key expr·100 + chara index) fading in from alpha 0.
   */
  openFace(key: string, x: number, y: number, w: number, h: number, face: RgbaImage | null, flags: number): DuelWindow {
    const f = flags & 0xff808
    const win: DuelWindow = { x, y, w, h, codes: [], opened: this.frame, faceOpened: this.frame, style: 10, chamfer: 16, flags: f & PAINTER_FLAGS, alpha: 0x80, bright: 0x80, face }
    this.append(key, win, f)
    return win
  }

  /** Sets game flags on an open window (win->flags |= bits). */
  addFlags(key: string, bits: number) {
    const e = this.entry(key)
    if (!e) return
    e.gflags |= bits
    e.win.flags = ((e.win.flags ?? 0) | bits) & PAINTER_FLAGS
  }

  /** winFreeGlyphs. */
  freeGlyphs(key: string) {
    const e = this.entry(key)
    if (e) {
      e.prints = []
      if (e.win.text) e.win.text = undefined
    }
  }

  /** winSetText(win, text, 0, 0): the glyphs are freed and the text parsed again (at once: typeDelay 0). */
  setText(key: string, text: Uint8Array) {
    const e = this.entry(key)
    if (!e) return
    e.prints = []
    e.win.text = text
    e.win.opened = this.frame
  }

  /** winPrintAt (narrow) / winPrintAtEx(…, 0) (wide): glyphs at (x, y) in the window, fade step 0x7F. */
  print(key: string, x: number, y: number, glyph: number, text: Uint8Array, wide = false) {
    const e = this.entry(key)
    if (!e) return
    e.prints.push({ x, y, glyph, wide, text, at: this.frame })
    // winPrintAtEx leaves its advance / line height in the window (the menu cursor uses lineH)
    if (wide) {
      e.win.glyph = glyph
      e.win.wide = true
    }
  }

  /** winFadeClose(win, step): alpha − step; below 0 the window is closed. */
  fadeClose(key: string, step: number) {
    const e = this.entry(key)
    if (!e) return
    const a = (e.win.alpha ?? 0x80) - step
    if (a < 0) {
      e.win.alpha = 0
      this.close(key)
    } else e.win.alpha = a
  }

  /** winApproachPos(x, y, divisor, win, alphaStep). */
  approach(key: string, x: number, y: number, div: number, alphaStep: number) {
    const w = this.get(key)
    if (!w) return
    w.x = w.x - (w.x - x) / div
    w.y = w.y - (w.y - y) / div
    let a = (w.alpha ?? 0x80) + alphaStep
    if (a > 0x80) a = 0x80
    else if (a < 0) a = 0
    w.alpha = a
  }

  /** winBringToFront: an open window is unlinked and appended (drawn last, the one that stays bright). */
  bringToFront(key: string) {
    const i = this.list.findIndex((e) => e.key === key)
    if (i < 0) return
    const [e] = this.list.splice(i, 1)
    this.list.push(e)
  }

  /** winGetCursor. */
  cursor(key: string): number {
    return this.entry(key)?.cursor ?? 0
  }

  /**
   * winUpdateInput (0x0886F9A8) for a menu / list window (flag 4): nothing while flag 0x100 is set
   * (the frame it opened). Held ↓ / ↑: a press at the last / first item wraps around (unless flag
   * 0x10000) and sets the pad repeat timer to 0x10, delay 8; otherwise on the pad repeat one row (with
   * □ held: one page). A changed cursor plays SE 1 and sets flag 0x400 (the bar flashes).
   */
  updateInput(key: string, pad: WinInput, playSe: (id: number) => void) {
    const e = this.entry(key)
    if (!e || e.gflags & 0x100) return
    e.gflags |= 0x80
    const m = e.win.menu
    if (!(e.gflags & 4) || !m) return
    const n = m.itemCount ?? 1, vis = m.visibleRows ?? 1
    let row = m.row, top = m.scrollTop ?? 0
    if (pad.held & PAD.DOWN) {
      if (!(e.gflags & 0x10000) && pad.pressed & PAD.DOWN && n - 1 === e.cursor) {
        row = 0
        top = 0
        pad.setRepeat(0x10, 8)
      } else if (pad.repeat & PAD.DOWN) {
        if (!(pad.held & PAD.SQUARE)) {
          if (row < vis - 1) row++
          else if (top < n - vis) top++
        } else if (top < n - vis) top = Math.min(n - vis, top + vis)
        else if (row < vis - 1) row++
      }
    } else if (pad.held & PAD.UP) {
      if (!(e.gflags & 0x10000) && pad.pressed & PAD.UP && e.cursor === 0) {
        row = vis - 1
        top = n - vis
        pad.setRepeat(0x10, 8)
      } else if (pad.repeat & PAD.UP) {
        if (!(pad.held & PAD.SQUARE)) {
          if (row < 1) {
            if (top !== 0) top--
          } else row--
        } else if (top === 0) {
          if (row > 0) row--
        } else top = Math.max(0, top - vis)
      }
    }
    row = this.rowMouse(e, pad, row, top)
    m.row = row
    m.scrollTop = top
    if (e.cursor !== top + row) {
      playSe(1)
      e.gflags |= 0x400
      m.movedAt = this.frame
      e.cursor = top + row
    }
  }

  /**
   * Mouse (Play mode, ours): the visible row under the pointer of a menu / list. Hovering a row moves
   * the cursor there (the caller plays SE 1 as for the pad), a click on a row becomes ✕ (PAD.POINTER is
   * dropped). Only rows that hold an item; the scroll position never changes.
   */
  private rowMouse(e: Entry, pad: WinInput, row: number, top: number): number {
    const m = e.win.menu
    const px = pad.pointerX ?? -1, py = pad.pointerY ?? -1
    const click = (pad.pressed & PAD.POINTER) !== 0
    if (!m || px < 0 || (!pad.pointerMoved && !click) || (e.win.alpha ?? 0x80) <= 0) return row
    const w = e.win
    const lineH = w.wide ? (w.glyph ?? 20) + 2 : (w.glyph ?? 20)
    const offX = m.offX ?? 10, offY = m.offY ?? 8
    const cw = m.cursorW ?? Math.trunc(w.w) - 20
    // the rect of winDrawMenuCursor's bar (drawn at win.x / win.y, centring flags or not)
    const x0 = Math.trunc(w.x + offX - 1), x1 = x0 + ((w.flags ?? 0) & WF_SCROLLBAR ? cw - 16 : cw)
    const r = Math.floor((py - Math.trunc(w.y + offY - 1)) / lineH)
    if (px < x0 || px >= x1 || r < 0 || r >= (m.visibleRows ?? 1) || top + r >= (m.itemCount ?? 1)) return row
    if (click) pad.pressed = (pad.pressed & ~PAD.POINTER) | PAD.CROSS
    return r
  }

  /**
   * Mouse (Play mode, ours): the ＠ｂ help label under the pointer ("✕ Yes", "○ Return" …) of the open
   * windows, topmost first, gets the menu cursor's bar (`hover`), and a click on it becomes that
   * button. With `clickAnywhere` (a pure acknowledgement or a yes / no question) a click that missed
   * the labels is ✕. Returns true when the click was used.
   */
  helpMouse(input: WinMouse, clickAnywhere = false): boolean {
    this.hover = null
    if (input.pointerX < 0) return false
    for (let k = this.list.length - 1; k >= 0; k--) {
      const e = this.list[k]
      if ((e.win.alpha ?? 0x80) <= 0 || !e.win.text) continue
      const z = buttonZones(e.win, this.tables).find((q) => input.pointerX >= q.x0 && input.pointerX < q.x1 && input.pointerY >= q.y0 && input.pointerY < q.y1)
      if (!z) continue
      this.hover = { key: e.key, x0: z.x0, y0: z.y0, x1: z.x1, y1: z.y1 }
      if (input.pressed & PAD.POINTER) {
        input.pressed = (input.pressed & ~PAD.POINTER) | z.bit
        return true
      }
      return false
    }
    if (clickAnywhere && input.pressed & PAD.POINTER) {
      input.pressed = (input.pressed & ~PAD.POINTER) | PAD.CROSS
      return true
    }
    return false
  }

  /** Sets a list's cursor fields directly (cursorRow / scrollTop / cursor, as stageSelectOpenState restores them). */
  setCursor(key: string, row: number, top: number) {
    const e = this.entry(key)
    if (!e?.win.menu) return
    e.win.menu.row = row
    e.win.menu.scrollTop = top
    e.cursor = row + top
  }

  /** menuWinUpdateAll's per-window update: flag 0x800 dimming (the last window brightens, the others dim), then flags 0x80 / 0x100 / 0x200 / 0x400 cleared. */
  tick() {
    this.frame++
    this.list.forEach((e, i) => {
      const w = e.win
      if (e.gflags & 0x800 || (w.flags ?? 0) & 0x800) {
        let b = w.bright ?? 0x80
        if (i === this.list.length - 1) {
          if (b < 0x80) b = Math.min(0x80, b + 8)
        } else if (b > 0x38) b = Math.max(0x38, b - 8)
        w.bright = b
      }
      e.gflags &= ~0x780
    })
  }

  /** The draw part: each window (style function, glyphs), then its printed glyphs. */
  draw(gl: GlRenderer, painter: WindowPainter) {
    for (const e of this.list) {
      const w = e.win
      painter.draw(gl, w, this.frame)
      const h = this.hover
      if (h && h.key === e.key && w.text) {
        painter.drawCursorBar(gl, h.x0, h.y0, h.x1 - h.x0, h.y1 - h.y0, w.alpha ?? 0x80)
        const [ox, oy] = this.tables.textOffset[w.style ?? 10] ?? [15, 15]
        const l = (w.flags ?? 0) & WF_CENTER_X ? w.x - Math.trunc(w.w / 2) : w.x
        const t = (w.flags ?? 0) & WF_CENTER_Y ? w.y - Math.trunc(w.h / 2) : w.y
        painter.draw(gl, { x: l + ox, y: t + oy, w: 0, h: 0, codes: [], text: w.text, glyph: w.glyph, wide: w.wide, style: 0, fade: 0x7f, opened: w.opened, alpha: w.alpha, bright: w.bright }, this.frame)
      }
      if (!e.prints.length) continue
      const [ox, oy] = this.tables.textOffset[w.style ?? 10] ?? [15, 15]
      const left = (w.flags ?? 0) & WF_CENTER_X ? w.x - w.w / 2 : w.x
      const top = (w.flags ?? 0) & WF_CENTER_Y ? w.y - w.h / 2 : w.y
      for (const p of e.prints) {
        // the glyphs belong to the window: its position, alpha and brightness; style 0 has no frame and text offset (0, 0)
        painter.draw(gl, { x: left + ox, y: top + oy, w: 0, h: 0, codes: [], text: p.text, textX: p.x, textY: p.y, glyph: p.glyph, wide: p.wide, opened: p.at, style: 0, fade: 0x7f, alpha: w.alpha, bright: w.bright }, this.frame)
      }
    }
  }
}
