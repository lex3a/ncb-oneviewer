/**
 * Two scenes the retail game never shows (docs/formats/extras.md):
 *
 * - **How to play** — rulesHelpScene (0x0884CC90, scene 400) and rulesHelpOpenWindow (0x0884CB4C):
 *   a list window with the 15 topics of 0x088DCD50 and a message window with the text of
 *   0x088DCD10[topic], drawn by menuWinUpdateAll (WindowPainter).
 * - **Staff roll** — staffRollScene (0x08834AE8, scene 2000): etc.one 1000 members 1..18 shown one
 *   after the other on the timetable 0x088B9B18, voice clip 500, a fade to black after 6000 frames or
 *   START. The images are not on the UMD (etc.one has no entry 1000), so the viewer draws labelled
 *   placeholders with the game's exact timing, blending and fade.
 */
import type { GameDb } from '../formats/gamedb'
import type { RgbaImage } from '../formats/palette'
import type { GlRenderer, Vertex } from './gl'
import { WF_CENTER_X, WF_CENTER_Y, WF_MENU, WIN_CURSOR_COLORS, layoutText, type DuelWindow, type WinTables, type WindowPainter } from './windows'

export const PAD = {
  START: 0x8,
  UP: 0x10,
  DOWN: 0x40,
  SQUARE: 0x8000,
  CIRCLE: 0x2000,
  CROSS: 0x4000,
} as const

export const ADDR = {
  /** Topic names, 15 × 0x20 bytes (NUL-terminated ASCII, most with a trailing space). */
  topics: 0x088dcd50,
  /** 15 pointers to the topic texts (just before the names). */
  topicTexts: 0x088dcd10,
  /** staffRollScene timetable: 32 × int seconds per image (only the first 18 are drawn). */
  staffTimes: 0x088b9b18,
} as const

export const TOPIC_COUNT = 15
export const TOPIC_STRIDE = 0x20

export interface ExtrasTables {
  /** The 15 list rows as stored (stride 0x20). */
  topics: Uint8Array[]
  /** The 15 topic texts (Shift-JIS with ＠ｎ). */
  texts: Uint8Array[]
  /** 0x088B9B18: seconds per staff-roll image (32 entries). */
  staffSeconds: number[]
}

export function readExtrasTables(db: GameDb): ExtrasTables {
  const cstr = (a: number, max = 1024) => {
    const b = db.raw.bytes(a, max)
    const e = b.indexOf(0)
    return b.slice(0, e < 0 ? b.length : e)
  }
  const u32 = (a: number) => {
    const b = db.raw.bytes(a, 4)
    return ((b[0] ?? 0) | ((b[1] ?? 0) << 8) | ((b[2] ?? 0) << 16) | ((b[3] ?? 0) << 24)) >>> 0
  }
  const i32 = (a: number) => u32(a) | 0
  return {
    topics: Array.from({ length: TOPIC_COUNT }, (_, i) => cstr(ADDR.topics + i * TOPIC_STRIDE, TOPIC_STRIDE)),
    texts: Array.from({ length: TOPIC_COUNT }, (_, i) => cstr(u32(ADDR.topicTexts + i * 4))),
    staffSeconds: Array.from({ length: 32 }, (_, i) => i32(ADDR.staffTimes + i * 4)),
  }
}

/** Game text as plain text (＠ｎ → newline, full-width → ASCII where the font has both). */
export function plainText(b: Uint8Array): string {
  return new TextDecoder('shift_jis').decode(b).replace(/＠ｎ/g, '\n').replace(/ +\n/g, '\n').trimEnd()
}

// ---------------------------------------------------------------------------------------------
// How to play (rulesHelpScene)

/** One pad sample: pressed = new presses (padGetPressed), repeat = presses + auto-repeats (padGetRepeat), held = padGetHeld. */
export interface PadFrame {
  pressed: number
  repeat: number
  held: number
}

/**
 * rulesHelpScene + the window part of menuWinUpdateAll for its two windows (g_deckWinMenu, the list;
 * g_deckWinInfo, the text). DAT_089F3C18 = state (0 open list, 1 list, 2 text, 3 exit), DAT_089F3C14
 * = topic.
 */
export class RulesHelpScene {
  state = 0
  topic = 0
  frame = 0
  /** Returned 1 (scene 400 → title 0x32). */
  exited = false
  /** sndPlaySe / sndPlaySeUi ids of the last frames (viewer log). */
  se: { frame: number; id: number; ui: boolean }[] = []
  /** g_deckWinMenu: winOpenList state. */
  list: { win: DuelWindow; cursor: number; flags: number; laidOutAt: number } | null = null
  /** g_deckWinInfo. */
  info: DuelWindow | null = null
  private t: ExtrasTables
  private win: WinTables
  private onSe?: (id: number) => void

  /** `onSe`: called for every sndPlaySe / sndPlaySeUi id (the map board forwards them to its SE log). */
  constructor(t: ExtrasTables, win: WinTables, onSe?: (id: number) => void) {
    this.t = t
    this.win = win
    this.onSe = onSe
  }

  private playSe(id: number, ui: boolean) {
    this.onSe?.(id)
    this.se.push({ frame: this.frame, id, ui })
    if (this.se.length > 8) this.se.shift()
  }

  /**
   * rulesHelpOpenWindow(1): winOpenList(16, 16, maxLen·21 + 20, 350, g_deckWinMenu, 15, 20, 20,
   * topics, 0x20, 0x800), maxLen = max(strlen(topic) >> 1). (2): winClose + winOpenMessage(320, 224,
   * 0, 0, g_deckWinInfo, 20, 20, text[topic], 0, 0, 0xF000).
   */
  private openWindow(which: 1 | 2) {
    if (which === 2) {
      const text = this.t.texts[this.topic] ?? new Uint8Array(0)
      const lay = layoutText(text, { glyph: 20, tables: this.win })
      // winOpenMessage: style 7, chamfer 5, alpha 0x80, glyph fade 4, typeDelay 0 (parsed at once);
      // 0x1000 / 0x2000 size it to the text, 0x4000 / 0x8000 centre it on (320, 224).
      this.info = { x: 320, y: 224, w: lay.autoW, h: lay.autoH, codes: [], text, glyph: 20, style: 7, chamfer: 5, flags: WF_CENTER_X | WF_CENTER_Y, alpha: 0x80, opened: this.frame }
      return
    }
    if (this.list) return // winOpenList does nothing on an open window
    let max = 0
    for (const s of this.t.topics) max = Math.max(max, s.length >> 1)
    const w = Math.fround(Math.fround(max * 21) + 20)
    const h = 350
    let rows = Math.trunc((h - 10) / 20)
    if (rows < 1) rows = 1
    if (TOPIC_COUNT < rows) rows = TOPIC_COUNT
    this.list = {
      // flags & 0x70838 | 0x304: 0x800 (dimming) survives; 0x100 = no input on the opening frame, 0x200 = lay out the rows
      win: { x: 16, y: 16, w, h, codes: [], glyph: 20, style: 7, chamfer: 5, flags: WF_MENU, alpha: 0x80, bright: 0x80, opened: this.frame, menu: { row: 0, offX: 10, offY: 8, cursorW: Math.trunc(w) - 20, color: WIN_CURSOR_COLORS[0], itemCount: TOPIC_COUNT, visibleRows: rows, scrollTop: 0 } },
      cursor: 0,
      flags: 0x800 | 0x304,
      laidOutAt: -1,
    }
  }

  /** winUpdateInput (0x0886F9A8) for the list: Up/Down with auto-repeat, wrap on a press at the ends, □ held pages. */
  private listInput(p: PadFrame) {
    const L = this.list
    if (!L || L.flags & 0x100) return
    const m = L.win.menu!
    const n = m.itemCount ?? 1, vis = m.visibleRows ?? 1
    let top = m.scrollTop ?? 0
    if (p.held & PAD.DOWN) {
      if (p.pressed & PAD.DOWN && L.cursor === n - 1) {
        m.row = 0
        top = 0
      } else if (p.repeat & PAD.DOWN) {
        if (!(p.held & PAD.SQUARE)) {
          if (m.row < vis - 1) m.row++
          else if (top < n - vis) top++
        } else if (top < n - vis) top = Math.min(n - vis, top + vis)
        else if (m.row < vis - 1) m.row++
      }
    } else if (p.held & PAD.UP) {
      if (p.pressed & PAD.UP && L.cursor === 0) {
        m.row = vis - 1
        top = n - vis
      } else if (p.repeat & PAD.UP) {
        if (!(p.held & PAD.SQUARE)) {
          if (m.row < 1) {
            if (top !== 0) top--
          } else m.row--
        } else if (top === 0) {
          if (m.row > 0) m.row--
        } else top = Math.max(0, top - vis)
      }
    }
    if (top !== m.scrollTop) {
      m.scrollTop = top
      L.flags |= 0x200
    }
    if (L.cursor !== top + m.row) {
      this.playSe(1, false)
      m.movedAt = this.frame
      L.cursor = top + m.row
    }
  }

  /** One frame of scene 400: rulesHelpScene, then menuWinUpdateAll's bookkeeping (drawing is `draw`). */
  step(p: PadFrame) {
    this.frame++
    switch (this.state) {
      case 0:
        this.topic = 0
        this.state = 1
        this.openWindow(1)
        break
      case 1:
        this.listInput(p)
        if (p.pressed & PAD.CROSS) {
          this.topic = this.list?.cursor ?? 0
          this.playSe(7, true)
          this.state = 2
          this.openWindow(2)
        } else if (p.pressed & PAD.CIRCLE) {
          this.playSe(9, true)
          this.state = 3
        }
        break
      case 2:
        if (p.pressed & (PAD.CROSS | PAD.CIRCLE)) {
          this.info = null
          this.playSe(9, true)
          this.state = 1
        }
        break
      case 3:
        // winCloseAll; returns 1 → main sets scene 0x32 (title)
        this.list = null
        this.info = null
        this.state = 0
        this.exited = true
        return
    }
    // menuWinUpdateAll: dimming (flag 0x800: +8 up to 0x80 while last in the list, else −8 down to 0x38),
    // list mode 1 re-lays out the rows when flag 0x200 is set (glyph fade 0x7F), then flags 0x80..0x400 clear.
    const L = this.list
    if (L) {
      const last = !this.info
      let b = L.win.bright ?? 0x80
      if (last) {
        if (b < 0x80) b = Math.min(0x80, b + 8)
      } else if (b > 0x38) b = Math.max(0x38, b - 8)
      L.win.bright = b
      if (L.flags & 0x200) L.laidOutAt = this.frame
      L.flags &= ~0x780
    }
  }

  /** The windows in g_winListHead order (list first, then the text window). */
  draw(gl: GlRenderer, painter: WindowPainter) {
    const L = this.list
    if (L) {
      const w = L.win
      painter.draw(gl, w, this.frame)
      const [ox, oy] = this.win.textOffset[7] ?? [10, 10]
      const m = w.menu!
      for (let i = 0; i < (m.visibleRows ?? 0); i++) {
        const text = this.t.topics[(m.scrollTop ?? 0) + i]
        if (!text) continue
        painter.draw(gl, { x: Math.trunc(w.x) + ox, y: Math.trunc(w.y) + oy + i * 20, w: 0, h: 0, codes: [], text, glyph: 20, style: 0, fade: 0x7f, opened: L.laidOutAt, alpha: w.alpha, bright: w.bright }, this.frame)
      }
    }
    if (this.info) painter.draw(gl, this.info, this.frame)
  }

  /**
   * Play mode's mouse (ours): over the topic list the pointer moves the cursor and a click on a row
   * opens it (✕); a click while a topic is shown closes it (✕). Returns the extra pad bits.
   */
  pointer(x: number, y: number, moved: boolean, click: boolean): number {
    if (x < 0) return 0
    if (this.state === 2) return click ? PAD.CROSS : 0
    if (this.state !== 1) return 0
    const row = this.rowAt(x, y)
    if (row < 0 || row >= TOPIC_COUNT) return 0
    if (moved || click) this.setCursor(row)
    return click ? PAD.CROSS : 0
  }

  /** Viewer: the list row under a virtual-space point (−1 = none). */
  rowAt(x: number, y: number): number {
    const L = this.list
    if (!L) return -1
    const w = L.win, m = w.menu!
    if (x < w.x || x >= w.x + w.w) return -1
    const r = Math.floor((y - (w.y + 8)) / 20)
    if (r < 0 || r >= (m.visibleRows ?? 0)) return -1
    return (m.scrollTop ?? 0) + r
  }

  /** Viewer: put the cursor on a row (as if moved with the pad). */
  setCursor(i: number) {
    const L = this.list
    if (!L || i === L.cursor) return
    const m = L.win.menu!
    m.row = i - (m.scrollTop ?? 0)
    L.cursor = i
    m.movedAt = this.frame
    this.playSe(1, false)
  }
}

// ---------------------------------------------------------------------------------------------
// Staff roll (staffRollScene)

/** Images drawn by the loop (0x12); 20 are loaded, 32 counters are set up. */
export const STAFF_DRAWN = 18
export const STAFF_LOADED = 20
/** The roll fades out when the frame counter passes this (or on START). */
export const STAFF_TIMEOUT = 6000
/** sndPlayVoiceVag(500): goc.dat clip 499. */
export const STAFF_VOICE = 500

export interface StaffImageState {
  index: number
  /** DAT_089B60A8[i]: frames since the image's start (negative = not yet). */
  counter: number
  /** Alpha 0..0x80 of this frame, −1 = not drawn. */
  alpha: number
  /** Drawn as the plain sprite (alpha 0x80) or as the 10-copy glow (fading). */
  glow: boolean
}

/**
 * staffRollScene. DAT_089B6098 = state (0 load, 1 roll, 2 unload), DAT_089B60A0 = frame counter
 * (incremented on every call, also in state 0), DAT_089B609C = fade to black, DAT_089B60A8[32] =
 * per-image counters, DAT_089B6128[32] = per-image mode (never written: all 0, so the scroll mode 1
 * is dead code).
 */
export class StaffRollScene {
  state = 0
  frameCount = 0
  fade = 0
  counters = new Array(32).fill(0)
  /** Mode per image (DAT_089B6128, .bss, zero). */
  modes = new Array(32).fill(0)
  /** Returned scene 1000 (save), with g_mapStageNo = 0x10. */
  done = false
  /** Events for the view: 'voice' (sndPlayVoiceVag 500 after bgmStop 0/1), 'stopVoice'. */
  events: ('voice' | 'stopVoice')[] = []
  /** Images of the last frame. */
  shown: StaffImageState[] = []
  readonly seconds: number[]

  constructor(seconds: number[]) {
    this.seconds = seconds
  }

  step(pressed: number) {
    this.frameCount++
    this.shown = []
    if (this.state === 2) {
      // spriteUnload ×20, gfree, g_mapStageNo = 0x10, counters reset, sndStopVoice → scene 1000
      this.fade = 0
      this.frameCount = 0
      this.state = 0
      this.done = true
      this.events.push('stopVoice')
      return
    }
    if (this.state === 0) {
      // spriteLoadOneMember(etc.one, 1000, 1..20) — fatal on the retail disc; counters: c[0] = 0, c[i] = c[i−1] − 60·sec[i−1]
      for (let i = 0; i < 32; i++) this.counters[i] = i === 0 ? 0 : this.counters[i - 1] - (this.seconds[i - 1] ?? 0) * 60
      this.events.push('voice')
      this.state = 1
      return
    }
    for (let i = 0; i < STAFF_DRAWN; i++) {
      const c = ++this.counters[i]
      const len = (this.seconds[i] ?? 0) * 60
      if (this.modes[i] === 1) {
        // Dead: scroll up from y 380 at 0.5 px per frame, alpha min(len − c, 0x80), until c = len.
        if (c > 0 && c < len) this.shown.push({ index: i, counter: c, alpha: Math.min(0x80, Math.max(0, len - c)), glow: false })
      } else if (this.modes[i] === 0 && c > 0 && c < len + 0x40) {
        let a = c < len ? c : len + 0x40 - c
        a = Math.min(0x80, Math.max(0, a * 2))
        this.shown.push({ index: i, counter: c, alpha: a, glow: a !== 0x80 })
      }
    }
    if ((pressed & PAD.START || this.frameCount > STAFF_TIMEOUT) && this.fade === 0) this.fade = 1
    if (this.fade) this.fade++
    if (this.fade > 0x7f) this.state = 2
  }

  /** Scroll-mode y (dead code): trunc(380 − c·0.5), at least 0. */
  static scrollY(c: number): number {
    return Math.max(0, Math.trunc(Math.fround(380 - Math.fround(c * 0.5))))
  }
}

/** spriteSetColor alpha nibble, as 0..1. */
const nibA = (a: number) => (((((Math.trunc(a) * 255) >> 7) >> 4) & 0xf) * 17) / 255
const ALPHA_TEST = 40 / 255

/** Glow offsets: angle 0, 36, … 324 degrees, radius (0x80 − a)/20, trunc(r·cos) / trunc(r·sin). */
export function glowOffsets(a: number): [number, number][] {
  const r = Math.fround((0x80 - a) / 20)
  const out: [number, number][] = []
  for (let deg = 0; deg < 360; deg += 36) {
    const t = Math.fround(deg * 0.017453292)
    out.push([Math.trunc(Math.fround(r * Math.cos(t))), Math.trunc(Math.fround(r * Math.sin(t)))])
  }
  return out
}

export interface StaffDrawOptions {
  /** 'ge': the glow copies are drawn at alpha nibble a/10 → 1, which the GE alpha test (> 0x28) discards,
   *  so each image pops in and out; 'intended': the additive copies as the code means them. */
  glow: 'ge' | 'intended'
}

/**
 * The roll's draw calls for one frame: every shown image (spriteDraw at (0, 0) with alpha 0x80, or
 * ten additive spriteDrawProjected copies around (0, 0) at alpha a/10), then the black Prim2D
 * 640×448 at alpha DAT_089B609C (untextured: sceGuDisable(GU_TEXTURE_2D)).
 */
export function drawStaffRoll(gl: GlRenderer, scene: StaffRollScene, images: (RgbaImage | null)[], opts: StaffDrawOptions) {
  const quadAt = (dx: number, dy: number): Vertex[] => {
    // A placeholder covers the whole 640×448 virtual screen (the real images' size is unknown).
    const X0 = dx, Y0 = dy, X1 = dx + 640, Y1 = dy + 448
    const P = (x: number, y: number, u: number, v: number): Vertex => ({ x, y, w: 1, d: 0.5, u, v })
    return [P(X0, Y0, 0, 0), P(X1, Y0, 1, 0), P(X0, Y1, 0, 1), P(X1, Y0, 1, 0), P(X1, Y1, 1, 1), P(X0, Y1, 0, 1)]
  }
  for (const s of scene.shown) {
    const img = images[s.index]
    if (!img) continue
    const tex = gl.texture(img)
    if (scene.modes[s.index] === 1) {
      gl.triangles(tex, 'alpha', quadAt(0, StaffRollScene.scrollY(s.counter)), [1, 1, 1, nibA(s.alpha)])
      continue
    }
    if (!s.glow) {
      gl.triangles(tex, 'alpha', quadAt(0, 0), [1, 1, 1, 1])
      continue
    }
    const a10 = Math.trunc(s.alpha / 10)
    const na = nibA(a10)
    if (opts.glow === 'ge' && na <= ALPHA_TEST) continue
    for (const [dx, dy] of glowOffsets(s.alpha)) {
      // additive SRC_ALPHA / ONE: colour·alpha is the same as (colour·alpha, alpha 1), which passes the alpha test
      const col: [number, number, number, number] = opts.glow === 'ge' ? [1, 1, 1, na] : [a10 / 128, a10 / 128, a10 / 128, 1]
      gl.triangles(tex, 'add', quadAt(dx, dy), col)
    }
  }
  const fa = nibA(scene.fade)
  if (scene.fade > 0 && fa > ALPHA_TEST) {
    const P = (x: number, y: number): Vertex => ({ x, y, w: 1, d: 1, u: 0, v: 0 })
    gl.triangles(null, 'alpha', [P(0, 0), P(640, 0), P(0, 448), P(640, 0), P(640, 448), P(0, 448)], [0, 0, 0, fa])
  }
}

/**
 * When image i is on screen, in values of the frame counter DAT_089B60A0 (1 on the loading frame):
 * its counter is F − 1 − start, drawn while 0 < counter < len + 64, opaque (alpha 0x80) for
 * 64 ≤ counter ≤ len.
 */
export function staffSchedule(seconds: number[]): { index: number; start: number; first: number; opaqueFrom: number; opaqueTo: number; last: number }[] {
  const out = []
  let s = 0
  for (let i = 0; i < STAFF_DRAWN; i++) {
    const len = (seconds[i] ?? 0) * 60
    out.push({ index: i, start: s, first: s + 2, opaqueFrom: s + 65, opaqueTo: s + len + 1, last: s + len + 64 })
    s += len
  }
  return out
}
