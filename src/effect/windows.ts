/**
 * Message windows, ported from menuWinUpdateAll (0x08867E14) and the per-style draw functions of
 * g_winStateDrawFuncs (0x088F4040, indexed by Window.drawStyle 0–13), with the menu cursor bar
 * (winDrawMenuCursor), the "next" arrow (winDrawNextArrow), text glyphs (winGlyphDraw), inline icon
 * glyphs (winIconGlyphDraw, the ＠ｂ/＠ｍ/＠ｅ/＠ｐ tags) and digit glyphs (winDigitGlyphDraw,
 * winPrintNumber). Used by the duel, story events and the Windows gallery. See docs/formats/windows.md.
 *
 * Every coordinate is the game's 640×448 virtual space. Like the GE path, sprite vertices are
 * computed in virtual pixels (position + trunc(scale·corner)) and mapped to the 480×272 screen with a
 * truncating x·480/640, y·272/448; Prim2D quads use x·0.75, y·0.60714287. The results are handed to
 * the GlRenderer in virtual units again (screen/0.75), so they land on whole screen pixels.
 */
import { glyphPixels, sjisToGlyph } from '../formats/font'
import { asciiToSjis, MSG_NEWLINE, MSG_SPACE, MSG_WIDE_SPACE, type GameDb } from '../formats/gamedb'
import type { RgbaImage } from '../formats/palette'
import type { BlendMode, GlRenderer, Vertex } from './gl'

/** GE z 0x7FFF (window depth 0 in the 2D-sorted context). */
const Z = 0x7fff / 65535

// Window.flags bits used by the draw code.
/** Style 7: divider lines at pointX / pointY. */
export const WF_DIVIDERS = 0x8
/** Menu / list window: the cursor bar is drawn instead of the next arrow. */
export const WF_MENU = 0x4
/** Menu: scroll bar with arrows (skin 5). */
export const WF_SCROLLBAR = 0x10
/** Menu: pointer sprite at the end of the cursor bar (skin 4). */
export const WF_POINTER = 0x20
/** x is the centre of the window. */
export const WF_CENTER_X = 0x4000
/** y is the centre of the window. */
export const WF_CENTER_Y = 0x8000
/** Without this flag a window with a face shifts its text 100 px right. */
export const WF_FACE_NO_SHIFT = 0x40000

type Rect = [number, number, number, number]
type Rgba = [number, number, number, number]

export interface WinTables {
  /** g_winTextOffsetByState 0x088F3FD0: text origin per draw style (int x, int y). */
  textOffset: [number, number][]
  /** g_winTailRects 0x088F3F78: skin 14 tail rects {u0, v0, u1, v1} by Window.tailIdx. */
  tailRects: Rect[]
  /** g_winIconRectTables 0x088F472C: rect tables of skins 7–10 ({u0, v0, u1, v1} from the 4-corner records). */
  iconRects: Record<number, Rect[]>
  /** g_winDigitUVs 0x088F4758: [4 styles][15] as the code reads them (u0, v0, u1, v1). */
  digitUVs: Rect[][]
  /** g_winTintOffsets 0x088F4938: signed RGB offsets of the digit glyphs by attribute. */
  tints: [number, number, number][]
  /** g_fontPaletteColors 0x088F4C00: text colours (＠ｃ / Window.textColor). */
  fontPalettes: [number, number, number][]
}

const ADDR = {
  textOffset: 0x088f3fd0,
  tailRects: 0x088f3f78,
  iconRects: 0x088f472c,
  digitUVs: 0x088f4758,
  tints: 0x088f4938,
  fontPalettes: 0x088f4c00,
}
/** Entries in each icon rect table (the tables sit back to back: 0x088F40D8, 0x41A8, 0x4368, 0x4678). */
const ICON_COUNTS: Record<number, number> = { 7: 13, 8: 28, 9: 49, 10: 13 }

/** The same tables as literals (read from the USA BOOT.BIN), for callers without a GameDb. */
export const DEFAULT_WIN_TABLES: WinTables = (() => {
  const grid = (n: number, cols: number): Rect[] => Array.from({ length: n }, (_, i) => [18 * (i % cols), 18 * Math.trunc(i / cols), 18 * (i % cols) + 18, 18 * Math.trunc(i / cols) + 18])
  const attr: Rect[] = [[128, 0, 160, 32], [0, 0, 32, 32], [32, 0, 64, 32], [64, 0, 96, 32], [96, 0, 128, 32], [0, 32, 32, 64], [32, 32, 64, 64], [64, 32, 96, 64], [96, 32, 128, 64], [128, 32, 160, 64], [160, 32, 192, 64], [192, 32, 224, 64], [192, 0, 224, 32]]
  const buttons: Rect[] = [...grid(7, 7), [0, 18, 36, 36], [0, 54, 54, 72], [36, 18, 72, 36], [36, 36, 72, 54], [72, 18, 126, 36], [72, 36, 126, 54]]
  const digits = (w: number, h: number, v: number): Rect[] => Array.from({ length: 15 }, (_, d) => [w, h, w * d, v])
  return {
    textOffset: [[0, 0], [10, 10], [10, 10], [20, 20], [30, 30], [4, 4], [10, 10], [10, 10], [0, 0], [0, 0], [15, 15], [15, 15], [15, 15], [15, 15]],
    tailRects: [[0, 0, 0, 0], [0, 0, 128, 16], [0, 20, 128, 36], [0, 40, 64, 56], [0, 60, 64, 76], [0, 80, 64, 96], [0, 100, 64, 116], [64, 40, 128, 56], [64, 60, 128, 76], [64, 80, 128, 96], [64, 100, 128, 116]],
    iconRects: { 7: buttons, 8: grid(28, 28), 9: grid(49, 7), 10: attr },
    digitUVs: [digits(8, 10, 0), digits(6, 8, 10), digits(4, 6, 18), Array.from({ length: 15 }, (_, d): Rect => [10 * d, 0, 10 * d + 10, 20])],
    tints: [[0, 0, 0], [10, -100, -100], [-100, 10, -100], [-100, -100, 10], [10, -60, -60], [-60, 10, -60], [-60, -60, 10], ...Array.from({ length: 9 }, (): [number, number, number] => [0, 0, 0])],
    fontPalettes: [[255, 255, 255], [225, 40, 10], [40, 128, 60], [255, 252, 0], [50, 60, 150], [130, 50, 180], [40, 135, 140], [50, 25, 20], [130, 120, 80], [222, 23, 103], [60, 100, 0], [120, 90, 0], [50, 55, 240], [160, 30, 80], [0, 100, 255], [230, 70, 0]],
  }
})()

/** Reads the window tables from BOOT.BIN (falls back to DEFAULT_WIN_TABLES without a db). */
export function readWinTables(db: GameDb | null | undefined): WinTables {
  if (!db) return DEFAULT_WIN_TABLES
  const i16 = (a: Uint8Array, i: number) => (((a[i * 2] ?? 0) | ((a[i * 2 + 1] ?? 0) << 8)) << 16) >> 16
  const i32 = (a: Uint8Array, i: number) => (a[i * 4] ?? 0) | ((a[i * 4 + 1] ?? 0) << 8) | ((a[i * 4 + 2] ?? 0) << 16) | ((a[i * 4 + 3] ?? 0) << 24)
  const to = db.raw.bytes(ADDR.textOffset, 14 * 8)
  const tr = db.raw.bytes(ADDR.tailRects, 11 * 8)
  const ptrs = db.raw.bytes(ADDR.iconRects, 11 * 4)
  const du = db.raw.bytes(ADDR.digitUVs, 4 * 15 * 8)
  const ti = db.raw.bytes(ADDR.tints, 16 * 4)
  const fp = db.raw.bytes(ADDR.fontPalettes, 48)
  const iconRects: Record<number, Rect[]> = {}
  for (const skin of [7, 8, 9, 10]) {
    const base = i32(ptrs, skin) >>> 0
    const n = ICON_COUNTS[skin]
    const d = db.raw.bytes(base, n * 16)
    // Records are four corners {TL, TR, BR, BL}; winIconGlyphDraw uses TL (+0) and BR (+8).
    iconRects[skin] = Array.from({ length: n }, (_, k): Rect => [i16(d, k * 8), i16(d, k * 8 + 1), i16(d, k * 8 + 4), i16(d, k * 8 + 5)])
  }
  const sb = (v: number) => (v << 24) >> 24
  return {
    textOffset: Array.from({ length: 14 }, (_, k): [number, number] => [i32(to, k * 2), i32(to, k * 2 + 1)]),
    tailRects: Array.from({ length: 11 }, (_, k): Rect => [i16(tr, k * 4), i16(tr, k * 4 + 1), i16(tr, k * 4 + 2), i16(tr, k * 4 + 3)]),
    iconRects,
    digitUVs: Array.from({ length: 4 }, (_, s) => Array.from({ length: 15 }, (_, d): Rect => {
      const o = (s * 15 + d) * 4
      return [i16(du, o), i16(du, o + 1), i16(du, o + 2), i16(du, o + 3)]
    })),
    tints: Array.from({ length: 16 }, (_, k): [number, number, number] => [sb(ti[k * 4] ?? 0), sb(ti[k * 4 + 1] ?? 0), sb(ti[k * 4 + 2] ?? 0)]),
    fontPalettes: Array.from({ length: 16 }, (_, k): [number, number, number] => [fp[k * 3] ?? 255, fp[k * 3 + 1] ?? 255, fp[k * 3 + 2] ?? 255]),
  }
}

/**
 * menuWinSysInit (0x08867B1C): the 15 window skins. Skin i is member i+1 of etc.one entry 1 for
 * i ∈ {1, 3, 10, 13, 14}, else member i+1 of option.one entry 20.
 */
export const WIN_SKIN_SOURCES: [archive: string, entry: number, member: number][] = Array.from({ length: 15 }, (_, i) =>
  [1, 3, 10, 13, 14].includes(i) ? ['etc.one', 1, i + 1] : ['option.one', 20, i + 1],
)

/** What each skin holds (docs/formats/windows.md). */
export const WIN_SKIN_ROLES = [
  'style 3 frame', 'style 4 frame', 'style 5 caps', 'style 7 frame', 'menu pointer', 'scroll-bar arrows', 'next arrow',
  '＠ｂ button icons', '＠ｐ icons (animated)', '＠ｅ icons', '＠ｍ attribute icons', 'style 8 labels', 'digits', 'styles 10–13 frames', 'styles 10/11 tails',
]

/** menuWinSysInit spriteSetBlend: skins 1, 11 and 12 use the additive (ONE_MINUS_DST_ALPHA) mode. */
const SKIN_BLEND: BlendMode[] = WIN_SKIN_SOURCES.map((_, i) => ([11, 12].includes(i) ? 'add' : 'alpha'))

export function loadWinSkins(image: (archive: string, entry: number, member: number) => RgbaImage | null): (RgbaImage | null)[] {
  return WIN_SKIN_SOURCES.map(([a, e, m]) => image(a, e, m))
}

/** Default fill (g_winDefaultFillRgba) and cursor colours (0x08B3E1FC, 3 × RGBA) set by menuWinSysInit. */
export const WIN_DEFAULT_FILL: Rgba = [0x20, 0x20, 0x20, 0x70]
export const WIN_CURSOR_COLORS: Rgba[] = [[0x10, 0x80, 0xf0, 0x40], [0x10, 0x80, 0x80, 0x40], [0x80, 0x80, 0x80, 0]]

export interface WinMenu {
  /** Window.cursorRow (row of the bar). */
  row: number
  /** cursorOffX / cursorOffY (10, 8 from winOpenMenu / winOpenList). */
  offX?: number
  offY?: number
  /** cursorW (w − 20). */
  cursorW?: number
  /** cursorR..A (WIN_CURSOR_COLORS[0]). */
  color?: Rgba
  /** Frame the cursor last moved (flag 0x400): the bar flashes for 8 frames. */
  movedAt?: number
  /** Scroll bar (flag 0x10): itemCount, visibleRows, scrollTop. */
  itemCount?: number
  visibleRows?: number
  scrollTop?: number
}

/** Style 8 (radar hexagon): six values and six deltas, axes clockwise from the top. */
export interface WinHexagon {
  values: number[]
  deltas: number[]
  /** The caller re-sets the fields every frame (otherwise the draw function counts them down to 0). */
  hold?: boolean
}

/** Style 9: a row of bars that grows by one every `period + 1` frames. */
export interface WinBars {
  /** Window.cursorRow: bars at the first frame. */
  count: number
  /** Window.scrollTop: final count. */
  target: number
  /** Window.visibleRows: frames between steps. */
  period: number
  /** Window.cursorW: gap between bars. */
  gap: number
  /** cursorR..A. */
  color: Rgba
}

/** winPrintNumber(win, x, y, style, showSign, attr, maxDigits, value). */
export interface WinNumber {
  x: number
  y: number
  style: number
  sign: boolean
  attr: number
  maxDigits: number
  value: number
}

export interface DuelWindow {
  x: number
  y: number
  w: number
  h: number
  /** Text as msgCodes (letters only). `text` (raw bytes with markup) takes precedence. */
  codes: number[]
  /** Raw game text: msgParseNextGlyph with all tags (＠ｂ/＠ｍ/＠ｅ/＠ｐ icons, ＠ｃ colour, ＠ｔ style, …). */
  text?: Uint8Array
  /** Frame on which the text was set (typing and fading start there). */
  opened: number
  /** Corner chamfer of the fill (win+0x20): 5 for message windows, 16 for face panels, 0 for style 1. */
  chamfer?: number
  /** winOpenMessage glyphW/lineH (20 by default; 22 for the intro names and story events). */
  glyph?: number
  /** winOpenFace: a chara.one face at scale w/160, bottom centre at (x + w/2 + 8, y + h − 8). */
  face?: RgbaImage | null
  /** Frame the face started fading in (+8 alpha per frame); defaults to `opened`. */
  faceOpened?: number
  /** Window alpha 0..128 (win+0x38). */
  alpha?: number
  /** Brightness 0..128 (win+0x6E): dims the frame, text and face of the side that is not speaking. */
  bright?: number
  /** Window.drawStyle 0–13 (default 10). */
  style?: number
  /** Window.flags (WF_*). */
  flags?: number
  /** pointX / pointY: the bubble's tail target (style 6, absolute) or the divider positions (style 7, relative). */
  pointX?: number
  pointY?: number
  /** Styles 10/11: tail sprite (g_winTailRects index, 0 = none). */
  tailIdx?: number
  /** fillR..fillA (WIN_DEFAULT_FILL). */
  fill?: Rgba
  /** Window.textColor (font palette) at the start of the text. */
  textColor?: number
  /** Window.glyphFadeStep: alpha added per frame to each glyph (4). */
  fade?: number
  /** Line start x inside the window (the story narrator starts at 100; winPrintAt's x). */
  textX?: number
  /** First line y inside the window (winPrintAt's y). */
  textY?: number
  /** Full-width layout of winPrintAtEx(…, narrow 0): advance glyph+1, line glyph+2, scale glyph/18. */
  wide?: boolean
  /** Typewriter: one step every `typeDelay` frames from `opened` (0 = all at once). */
  typeDelay?: number
  /** Steps taken before the first glyph (a leading ＠ｖ voice tag is one). */
  typeLead?: number
  /** Show the "next" arrow (flag 0x80 polled, voice idle, text complete). */
  arrow?: boolean
  /** Menu cursor bar (flag 0x4). */
  menu?: WinMenu
  hexagon?: WinHexagon
  bars?: WinBars
  numbers?: WinNumber[]
}

// ---------------------------------------------------------------------------------------------
// text layout (msgParseNextGlyph 0x08871570, winEmitGlyph / winEmitIcon / winEmitDigitGlyph)

export type WinGlyph =
  | { k: 'text'; code: number; x: number; y: number; at: number; palette: number; fade: number }
  | { k: 'icon'; skin: number; id: number; last: number; delay: number; x: number; y: number; at: number; fade: number }
  | { k: 'digit'; style: number; digit: number; attr: number; x: number; y: number; at: number; fade: number }

export interface WinLayout {
  glyphs: WinGlyph[]
  /** Frame offset of the last parse step that produced something (typing is complete from there). */
  end: number
  /** Draw style set by a ＠ｔ tag. */
  style?: number
  /** Flag 0x1000 / 0x2000 sizes: max(cursorX + 20), cursorY + lineH + 18. */
  autoW: number
  autoH: number
  /** Window.maxCol: the most columns of a line (each glyph, ASCII space, full-width space and icon is one; winOpenMenu: w = (maxCol + 1) · advance). */
  maxCol: number
}

/** Layout of a glyph size: advance (glyphW+1)/2, line height, and the glyph scale. */
/**
 * Glyph metrics: winPrintAt / winOpenMessage (narrow) use advance (glyphW+1)/2, line height glyphH and
 * scale (glyphW/18·0.8, glyphH/18); winPrintAtEx(…, narrow 0) (the name-entry keyboard) uses advance
 * glyphW+1, line height glyphH+2 and scale (glyphW/18, glyphH/18).
 */
const layout = (g = 20, wide = false) => (wide ? { adv: g + 1, line: g + 2, sx: g / 18, sy: g / 18 } : { adv: (g + 1) >> 1, line: g, sx: (g / 18) * 0.8, sy: g / 18 })

/** Advance of the text up to its last visible glyph (auto-width windows: w = that + 20). */
export function textAdvance(codes: number[], glyph = 20): number {
  const { adv } = layout(glyph)
  let x = 0, last = 0
  for (const c of codes) {
    if (c === MSG_NEWLINE) x = 0
    else if (c === MSG_WIDE_SPACE) x += adv >> 1
    else {
      x += adv
      if (c !== MSG_SPACE) last = x
    }
  }
  return last
}

const layoutCache = new WeakMap<object, { key: string; lay: WinLayout }>()

/**
 * msgParseNextGlyph over a whole text: each call is one typewriter step (a glyph, an ASCII space,
 * a newline byte, a full-width space, an icon, or a ＠ｗ/＠ｖ/＠ｆ tag; ＠ｎ, ＠ｃ, ＠ｔ, ＠ａ, ＠ｓ and
 * unknown tags do not end a step). `at` is the frame offset of the step from menuWinUpdateAll's
 * typewriter (typeTimer = typeDelay after each parse, ＠ｗN sets it to N, ＠ｓN sets both).
 */
export function layoutText(b: Uint8Array, opts: { glyph?: number; typeDelay?: number; originX?: number; originY?: number; textColor?: number; fade?: number; tables?: WinTables; lead?: number; wide?: boolean }): WinLayout {
  const { adv, line } = layout(opts.glyph, opts.wide)
  const tables = opts.tables ?? DEFAULT_WIN_TABLES
  const glyphs: WinGlyph[] = []
  let delay = opts.typeDelay ?? 0
  let fade = opts.fade ?? 4
  let palette = opts.textColor ?? 0
  const originX = opts.originX ?? 0
  const originY = opts.originY ?? 0
  let cx = originX, cy = originY, t = (opts.lead ?? 0) * delay, end = 0, autoW = 0, autoH = line + 18
  let col = 0, maxCol = 0
  const colStep = () => {
    col++
    if (col > maxCol) maxCol = col
  }
  let style: number | undefined
  let i = 0
  /** After ＠－: msgParseNextGlyphRaw (strict 2-byte codes, 0x8140 advances a full advance). */
  let raw = false
  const num = (max: number) => {
    let v = 0, n = 0
    while (n < max && b[i] === 0x82 && b[i + 1] >= 0x4a && b[i + 1] <= 0x59) {
      v = v * 10 + (b[i + 1] - 0x4f)
      i += 2
      n++
    }
    return v
  }
  const emitText = (code: number) => {
    glyphs.push({ k: 'text', code, x: cx, y: cy, at: t, palette, fade })
    cx += adv
    autoW = Math.max(autoW, cx + 20)
    colStep()
  }
  const newline = () => {
    col = 0
    cx = originX
    cy += line
    autoH = Math.max(autoH, cy + line + 18)
  }
  while (i < b.length && b[i]) {
    // one call of msgParseNextGlyph
    let timer = delay
    let produced = true
    for (;;) {
      if (i >= b.length || !b[i]) {
        produced = false
        break
      }
      const c = b[i]
      if (raw) {
        // msgParseNextGlyphRaw (0x088726AC): the rest of the text in the same step
        const code = (c << 8) | (b[i + 1] ?? 0)
        if (code === 0x8140) {
          cx += adv
          i += 2
          continue
        }
        if (code === 0x8197) {
          const t2 = (b[i + 2] << 8) | b[i + 3]
          if (t2 === 0x828e) {
            // ＠ｎ
            newline()
            i += 4
          } else if (t2 === 0x8283) {
            // ＠ｃNN: colour
            i += 4
            palette = num(2)
          } else i += 2
          continue
        }
        emitText(code)
        i += 2
        continue
      }
      if (c === 0x20) {
        cx += adv
        colStep()
        i++
        break
      }
      if (c === 0x2d || c === 0x2b || c === 0x2e || (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) {
        emitText(asciiToSjis(c))
        i++
        break
      }
      if (c === 0x0a) {
        newline()
        i++
        break
      }
      const code = (c << 8) | (b[i + 1] ?? 0)
      if (code === 0x8140) {
        cx += adv >> 1
        colStep()
        i += 2
        break
      }
      if (code !== 0x8197) {
        emitText(c >= 0x81 ? code : asciiToSjis(c))
        i += 2
        break
      }
      // markup: ＠ + full-width letter + full-width digits
      const tag = b[i + 2] === 0x82 ? b[i + 3] - 0x81 + 0x61 : b[i + 2] === 0x81 && b[i + 3] === 0x7c ? 0x2d : 0
      i += 4
      const ch = String.fromCharCode(tag)
      if (ch === 'n') {
        newline()
        continue
      }
      if (ch === '-') {
        // ＠－: msgParseNextGlyphRaw lays out the rest at once (name-entry keyboard)
        raw = true
        continue
      }
      if ('bmep'.includes(ch)) {
        const id = num(2)
        const skin = ch === 'b' ? 7 : ch === 'p' ? 8 : ch === 'e' ? 9 : 10
        const rect = tables.iconRects[skin]?.[id]
        glyphs.push({ k: 'icon', skin, id, last: skin === 8 ? 3 : 0, delay: skin === 8 ? 8 : 0, x: cx, y: cy - 1, at: t, fade })
        cx += rect ? rect[2] - rect[0] + 3 : 0
        autoW = Math.max(autoW, cx + 20)
        colStep()
        break
      }
      if (ch === 'w') {
        timer = num(3)
        break
      }
      if (ch === 'v') {
        num(4)
        break
      }
      if (ch === 'f') {
        num(3)
        break
      }
      if (ch === 'g') {
        // g_scrGameVars[n]: not tracked, printed as 0
        num(3)
        emitText(0x824f)
        break
      }
      if (ch === 'd' || ch === 'h') {
        num(3)
        continue
      }
      if (ch === 'k') continue
      if (ch === 'c') {
        palette = num(2)
        continue
      }
      if (ch === 'a') {
        fade = num(3)
        continue
      }
      if (ch === 's') {
        delay = num(2)
        timer = delay
        continue
      }
      if (ch === 't') {
        style = num(2)
        continue
      }
      // unknown tag: only the ＠ is skipped
      i -= 2
    }
    if (!produced) break
    end = t
    t += timer
  }
  return { glyphs, end, style, autoW, autoH, maxCol }
}

/** The same layout for msgCodes (the duel and story texts: letters, spaces and new lines only). */
function layoutCodes(codes: number[], glyph: number | undefined, delay: number, lead: number, originX: number, palette: number, fade: number): WinLayout {
  const { adv, line } = layout(glyph)
  const glyphs: WinGlyph[] = []
  let cx = originX, cy = 0, step = lead, end = 0, autoW = 0, col = 0, maxCol = 0
  for (const c of codes) {
    if (c === MSG_NEWLINE) {
      cx = originX
      cy += line
      col = 0
      continue
    }
    maxCol = Math.max(maxCol, ++col)
    end = step * delay
    if (c === MSG_SPACE) cx += adv
    else if (c === MSG_WIDE_SPACE) cx += adv >> 1
    else {
      glyphs.push({ k: 'text', code: c, x: cx, y: cy, at: step * delay, palette, fade })
      cx += adv
      autoW = Math.max(autoW, cx + 20)
    }
    step++
  }
  return { glyphs, end, autoW, autoH: cy + line + 18, maxCol }
}

export function windowLayout(win: DuelWindow, tables: WinTables = DEFAULT_WIN_TABLES): WinLayout {
  const key = `${win.glyph}|${win.typeDelay}|${win.typeLead}|${win.textX}|${win.textY}|${win.wide}|${win.textColor}|${win.fade}|${win.text?.length ?? -1}|${win.codes.length}`
  const hit = layoutCache.get(win.text ?? win.codes)
  if (hit && hit.key === key) return hit.lay
  const lay = win.text
    ? layoutText(win.text, { glyph: win.glyph, typeDelay: win.typeDelay ?? 0, originX: win.textX ?? 0, originY: win.textY ?? 0, textColor: win.textColor, fade: win.fade, tables, lead: win.typeLead, wide: win.wide })
    : layoutCodes(win.codes, win.glyph, win.typeDelay ?? 0, win.typeLead ?? 0, win.textX ?? 0, win.textColor ?? 0, win.fade ?? 4)
  layoutCache.set(win.text ?? win.codes, { key, lay })
  return lay
}

/** Frame on which the typewriter has shown the whole text. */
export function typingDone(win: DuelWindow): number {
  if (win.text) return win.opened + windowLayout(win).end
  const steps = win.codes.filter((c) => c !== MSG_NEWLINE).length + (win.typeLead ?? 0)
  return win.opened + Math.max(0, steps - 1) * (win.typeDelay ?? 0)
}

/** Converts viewer-friendly ASCII markup ("@b0", "@n", "\n") to the game's Shift-JIS tags. */
export function asciiMarkup(s: string): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '@' && /[a-z-]/.test(s[i + 1] ?? '')) {
      const t = s[i + 1]
      out.push(0x81, 0x97)
      if (t === '-') out.push(0x81, 0x7c)
      else out.push(0x82, 0x81 + t.charCodeAt(0) - 0x61)
      i += 2
      while (i < s.length && /[0-9]/.test(s[i])) out.push(0x82, 0x4f + Number(s[i++]))
      i--
    } else if (ch === '\n') out.push(0x0a)
    else {
      const c = ch.charCodeAt(0)
      out.push(c < 0x80 ? c : 0x3f)
    }
  }
  return Uint8Array.from(out)
}

// ---------------------------------------------------------------------------------------------
// colour conversions

/** spriteSetColor: rgb nibble = ((c·255) >> 11) & 15 (129..143 wrap to 0), alpha nibble = ((a·255) >> 7) >> 4. */
const sprRgb = (c: number) => ((((Math.trunc(c) * 255) >> 11) & 0xf) * 17) / 255
const sprAlpha = (a: number) => ((((Math.trunc(a) * 255) >> 7) >> 4 & 0xf) * 17) / 255
const sprCol = (r: number, g: number, b: number, a: number): Rgba => [sprRgb(r), sprRgb(g), sprRgb(b), sprAlpha(a)]

/** Virtual → screen, truncated like spriteDraw2D (x·0x1E0/0x280, y·0x110/0x1C0), back in virtual units. */
const sprX = (v: number) => (Math.trunc((v * 480) / 640) * 640) / 480
const sprY = (v: number) => (Math.trunc((v * 272) / 448) * 448) / 272
/** prim2DDraw: x·0.75, y·0.60714287 truncated. */
const primX = (v: number) => Math.trunc(v * 0.75) / 0.75
const primY = (v: number) => Math.trunc(v * 0.60714287) / 0.60714287

/**
 * The GE-side Prim2D (0x68 bytes): four vertices and four RGBA4444 colours. prim2DDraw always sends a
 * 4-vertex GU_TRIANGLE_STRIP whatever prim2DInit's kind says, and prim2DInit zeroes the corners but
 * keeps the colours. So a "line" (kind 1: two vertices set) is drawn as the triangle (v0, v1, origin)
 * with the colours v2/v3 left over from earlier draws of the same Prim2D. The painter keeps these
 * objects between draws like the game's globals at 0x08B3E210 / 280 / 2F0 / 360.
 */
class Prim2D {
  kind = 4
  count = 4
  v: [number, number][] = [[0, 0], [0, 0], [0, 0], [0, 0]]
  /** Nibbles r, g, b, a per vertex. */
  c: number[][] = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]

  init(kind: number) {
    this.kind = kind
    this.count = [1, 2, 3, 4, 4][kind] ?? 4
    this.v = [[0, 0], [0, 0], [0, 0], [0, 0]]
  }
  private put(i: number, r: number, g: number, b: number, a: number) {
    const c = this.c[i]
    if (r >= 0) c[0] = (r >> 4) & 0xf
    if (g >= 0) c[1] = (g >> 4) & 0xf
    if (b >= 0) c[2] = (b >> 4) & 0xf
    if (a >= 0) c[3] = ((a * 255) >> 7) >> 4 & 0xf
  }
  /** prim2DSetColor: r/g/b 0..255 (top nibble), a 0..0x80; a negative component keeps that channel. */
  setColor(r: number, g: number, b: number, a: number) {
    for (let i = 0; i < this.count; i++) this.put(i, r, g, b, a)
  }
  setVertexColor(i: number, r: number, g: number, b: number, a: number) {
    this.put(i, r, g, b, a)
  }
  set(i: number, x: number, y: number) {
    this.v[i] = [Math.trunc(x), Math.trunc(y)]
  }
}

// ---------------------------------------------------------------------------------------------

export interface WindowPainterOptions {
  /** The 15 skins (loadWinSkins); missing ones are skipped. */
  skins: (RgbaImage | null)[]
  font: Uint8Array | null
  tables?: WinTables
  lineMode?: 'ge' | 'intended'
}

const quad = (a: Vertex, b: Vertex, c: Vertex, d: Vertex) => [a, b, c, b, d, c]

/** Hexagon axes (winStateDraw08Hexagon), clockwise from the top; the code writes 0.866026 and 0.866025. */
const HEX_DIRS: [number, number][] = [[0, -1], [0.866026, -0.5], [0.866025, 0.5], [0, 1], [-0.866026, 0.5], [-0.866025, -0.5]]

export class WindowPainter {
  private skins: (RgbaImage | null)[]
  private font: Uint8Array | null
  readonly tables: WinTables
  private glyphs = new Map<number, RgbaImage>()
  private p210 = new Prim2D()
  private p280 = new Prim2D()
  private p2f0 = new Prim2D()
  private p360 = new Prim2D()
  /**
   * 'ge' draws Prim2D "lines" the way the GE does (triangle strips to the origin, see Prim2D);
   * 'intended' draws them as 1-px lines, which is what the code was written for (viewer option).
   */
  lineMode: 'ge' | 'intended' = 'ge'

  constructor(opts: WindowPainterOptions) {
    this.skins = opts.skins
    this.font = opts.font
    this.tables = opts.tables ?? DEFAULT_WIN_TABLES
    this.lineMode = opts.lineMode ?? 'ge'
  }

  /** A glyph with ink (palette entry 1) and the fullfontLoad outline halo (entry 2, alpha 63). */
  private glyph(code: number): RgbaImage | null {
    if (!this.font) return null
    const idx = sjisToGlyph(code)
    let img = this.glyphs.get(idx)
    if (!img) {
      const px = glyphPixels(this.font, idx, true)
      const rgba = new Uint8ClampedArray(16 * 16 * 4)
      for (let i = 0; i < px.length; i++) {
        if (!px[i]) continue
        rgba.set([255, 255, 255, px[i] === 1 ? 255 : 63], i * 4)
      }
      img = { width: 16, height: 16, rgba }
      this.glyphs.set(idx, img)
    }
    return img
  }

  // ---- primitives ----

  /** prim2DDraw(x, y, prim): the 4-vertex triangle strip, Gouraud-shaded, normal alpha blend. */
  private primDraw(gl: GlRenderer, p: Prim2D, x: number, y: number) {
    const col = (i: number): Rgba => p.c[i].map((n) => (n * 17) / 255) as Rgba
    const V = (i: number): Vertex => ({ x: primX(x + p.v[i][0]), y: primY(y + p.v[i][1]), w: 1, d: Z, u: 0, v: 0, c: col(i) })
    if (p.kind === 1 && this.lineMode === 'intended') {
      // a 1-screen-pixel line from v0 to v1 in colour c0
      const x0 = Math.trunc((x + p.v[0][0]) * 0.75), y0 = Math.trunc((y + p.v[0][1]) * 0.60714287)
      const x1 = Math.trunc((x + p.v[1][0]) * 0.75), y1 = Math.trunc((y + p.v[1][1]) * 0.60714287)
      const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1
      const nx = (-dy / len) * 0.5, ny = (dx / len) * 0.5
      const c = col(0)
      const P = (sx: number, sy: number): Vertex => ({ x: (sx + 0.5) / 0.75, y: (sy + 0.5) / 0.60714287, w: 1, d: Z, u: 0, v: 0, c })
      gl.triangles(null, 'alpha', quad(P(x0 - nx, y0 - ny), P(x1 - nx, y1 - ny), P(x0 + nx, y0 + ny), P(x1 + nx, y1 + ny)), [1, 1, 1, 1])
      return
    }
    gl.triangles(null, 'alpha', [V(0), V(1), V(2), V(1), V(2), V(3)], [1, 1, 1, 1])
  }

  /**
   * spriteDraw of one skin: spriteSetSrcRect(u0, v0, u1, v1) (pivot reset to the top-left), scale
   * (sx, sy), vertices = (x, y) + trunc(S·corner), colour from spriteSetColor.
   */
  private spr(gl: GlRenderer, skin: number, u0: number, v0: number, u1: number, v1: number, x: number, y: number, col: Rgba, sx = 1, sy = 1) {
    const img = this.skins[skin]
    if (!img || col[3] <= 0) return
    this.sprImg(gl, img, u0, v0, u1, v1, x, y, col, sx, sy, SKIN_BLEND[skin])
  }

  private sprImg(gl: GlRenderer, img: RgbaImage, u0: number, v0: number, u1: number, v1: number, x: number, y: number, col: Rgba, sx: number, sy: number, blend: BlendMode) {
    const w = u1 - u0, h = v1 - v0
    const X0 = sprX(x), X1 = sprX(x + Math.trunc(sx * w)), Y0 = sprY(y), Y1 = sprY(y + Math.trunc(sy * h))
    if (X0 === X1 || Y0 === Y1) return
    const P = (px: number, py: number, u: number, v: number): Vertex => ({ x: px, y: py, w: 1, d: Z, u: u / img.width, v: v / img.height })
    gl.triangles(gl.texture(img), blend, quad(P(X0, Y0, u0, v0), P(X1, Y0, u1, v0), P(X0, Y1, u0, v1), P(X1, Y1, u1, v1)), col)
  }

  // ---- window geometry ----

  private origin(win: DuelWindow) {
    const f = win.flags ?? 0
    let X = Math.trunc(win.x), Y = Math.trunc(win.y)
    if (f & WF_CENTER_X) X -= Math.trunc(win.w / 2)
    if (f & WF_CENTER_Y) Y -= Math.trunc(win.h / 2)
    return { X, Y, W: Math.trunc(win.w), H: Math.trunc(win.h), f }
  }

  /** winDrawFillOctagon (0x0886A66C): 3 quads with 45° chamfers, colour fillRGB, alpha fillA·alpha/128. */
  private fillOctagon(gl: GlRenderer, win: DuelWindow, h = win.h, chamfer = win.chamfer ?? 5) {
    const f = win.flags ?? 0
    let X = Math.trunc(win.x), Y = Math.trunc(win.y)
    const c = Math.trunc(chamfer), W = Math.trunc(win.w), H = Math.trunc(h)
    if (f & WF_CENTER_X) X -= Math.trunc(win.w / 2)
    if (f & WF_CENTER_Y) Y -= Math.trunc(h / 2)
    const [r, g, b, a] = win.fill ?? WIN_DEFAULT_FILL
    // (short)(char)(int)(fillA · alpha/128): above 127 the value turns negative and the alpha is kept.
    const fa = (Math.trunc(a * ((win.alpha ?? 128) / 128)) << 24) >> 24
    const p = this.p210
    p.init(3)
    p.setColor(r, g, b, fa)
    p.set(0, 0, c); p.set(1, c, 0); p.set(2, 0, H - c); p.set(3, c, H)
    this.primDraw(gl, p, X, Y)
    p.set(0, c, 0); p.set(1, W - c, 0); p.set(2, c, H); p.set(3, W - c, H)
    this.primDraw(gl, p, X, Y)
    p.set(0, W - c, 0); p.set(1, W, c); p.set(2, W - c, H); p.set(3, W, H - c)
    this.primDraw(gl, p, X, Y)
  }

  /** winDrawNextArrow (0x08869358): skin 6, frame uiAnimCounter(4), top-left at (x + w − 32 [−10 for style ≥ 7], y + h − 40). */
  private nextArrow(gl: GlRenderer, win: DuelWindow, frame: number) {
    if (!win.arrow) return
    const f = win.flags ?? 0, style = win.style ?? 10
    const dx = f & WF_FACE_NO_SHIFT && win.face ? -100 : 0
    const left = f & WF_CENTER_X ? dx + win.x - win.w / 2 : dx + win.x
    const fr = (frame >> 2) % 6
    this.spr(gl, 6, 24 * fr, 0, 24 * fr + 24, 32, Math.trunc(win.w + left - 32 - (style < 7 ? 0 : 10)), Math.trunc(win.y + win.h - 40), sprCol(128, 128, 128, win.alpha ?? 128))
  }

  /** The cursor bar of winDrawMenuCursor: a fw × fh rect at (bx, by) whose colour fades out to its edges. */
  private cursorBar(gl: GlRenderer, bx: number, by: number, fw: number, fh: number, flash: number, color: Rgba, alpha: number) {
    const [cr, cg, cb, ca] = color
    const x00 = Math.trunc(fw), y = Math.trunc(fh)
    const x01 = Math.trunc((fw - flash) / 8), y00 = Math.trunc((fh - flash) / 3)
    const x = x00 - x01, y2 = y - y00
    const a = Math.trunc(ca * (alpha / 128)) & 0xff
    const p = this.p210
    p.init(3)
    const G = (i: number) => p.setVertexColor(i, 0x80, 0x80, 0x80, 0)
    const C = (i: number) => p.setVertexColor(i, cr, cg, cb, a)
    p.set(0, 0, 0); p.set(1, x00, 0); p.set(2, x01, y00); p.set(3, x, y00)
    G(0); G(1); C(2); C(3)
    this.primDraw(gl, p, bx, by)
    p.set(0, x01, y2); p.set(1, x, y2); p.set(2, 0, y); p.set(3, x00, y)
    C(0); C(1); G(2); G(3)
    this.primDraw(gl, p, bx, by)
    p.set(0, 0, 0); p.set(1, x01, y00); p.set(2, 0, y); p.set(3, x01, y2)
    G(0); C(1); G(2); C(3)
    this.primDraw(gl, p, bx, by)
    p.set(0, x, y00); p.set(1, x00, 0); p.set(2, x, y2); p.set(3, x00, y)
    C(0); G(1); C(2); G(3)
    this.primDraw(gl, p, bx, by)
    p.set(0, x01, y00); p.set(1, x, y00); p.set(2, x01, y2); p.set(3, x, y2)
    C(0); C(1); C(2); C(3)
    this.primDraw(gl, p, bx, by)
  }

  /** Play mode (ours): the menu cursor's bar over any rect, e.g. a hovered help label; then draw the text again on top. */
  drawCursorBar(gl: GlRenderer, x: number, y: number, w: number, h: number, alpha = 0x80) {
    this.cursorBar(gl, Math.trunc(x) - 1, Math.trunc(y) - 1, Math.trunc(w) + 2, Math.trunc(h) + 1, 0, WIN_CURSOR_COLORS[0], alpha)
  }

  /** winDrawMenuCursor (0x0886965C). */
  private menuCursor(gl: GlRenderer, win: DuelWindow, frame: number) {
    const m = win.menu
    if (!m) return
    const f = win.flags ?? 0, alpha = win.alpha ?? 128, style = win.style ?? 10
    const lineH = layout(win.glyph ?? 20, win.wide).line
    const offX = m.offX ?? 10, offY = m.offY ?? 8
    const cursorW = m.cursorW ?? Math.trunc(win.w) - 20
    const [cr, cg, cb, ca] = m.color ?? WIN_CURSOR_COLORS[0]
    const flash = m.movedAt === undefined ? 0 : Math.max(0, 8 - (frame - m.movedAt))
    const fw = f & WF_SCROLLBAR ? cursorW - 16 : cursorW
    const fh = lineH + 1
    if (cursorW > 0) this.cursorBar(gl, Math.trunc(win.x + offX - 1), Math.trunc(win.y + offY + m.row * lineH - 1), fw, fh, flash, [cr, cg, cb, ca], alpha)
    const p = this.p210
    if (f & WF_POINTER) {
      this.spr(gl, 4, 0, 0, 32, 32, Math.trunc(cursorW + win.x + offX - 8), Math.trunc((lineH >> 1) - 30 + win.y + offY + m.row * lineH), sprCol(128, 128, 128, alpha))
    }
    if (f & WF_SCROLLBAR) {
      const items = m.itemCount ?? 1, rows = m.visibleRows ?? 1, top = m.scrollTop ?? 0
      const ratio = items / rows
      const track = win.h - 16 - 33
      const ax = Math.trunc(win.x + win.w - 24 - (style < 10 ? 0 : 10))
      const col = sprCol(128, 128, 128, alpha)
      const up: Rect = top === 0 ? [16, 0, 32, 16] : [0, 0, 16, 16]
      this.spr(gl, 5, ...up, ax, Math.trunc(win.y + 24 - 1), col, 1, -1)
      const down: Rect = top === items - rows ? [16, 0, 32, 16] : [0, 0, 16, 16]
      this.spr(gl, 5, ...down, ax, Math.trunc(win.y + 24 + Math.trunc(track)), col, 1, 1)
      p.init(3)
      p.set(0, 0, 0); p.set(1, 16, 0); p.set(2, 0, Math.trunc(track) + 1); p.set(3, 16, Math.trunc(track) + 1)
      p.setColor(0x10, 0x10, 0x10, alpha & 0xff)
      this.primDraw(gl, p, ax, Math.trunc(win.y + 24))
      const thumb = track / ratio, step = track / items
      p.set(0, 0, 0); p.set(1, 12, 0); p.set(2, 0, Math.trunc(thumb) + 1); p.set(3, 12, Math.trunc(thumb) + 1)
      p.setColor(0xd0, 0xd0, 0xd0, alpha & 0xff)
      this.primDraw(gl, p, Math.trunc(win.x) + Math.trunc(win.w) - (style < 10 ? 0x16 : 0x20), Math.trunc(win.y) + 0x18 + Math.trunc(step * top))
    }
  }

  // ---- styles ----

  /** Style 2 (0x0886A998): fill, then a black outline and a white one inset by 2 px ("lines", see Prim2D). */
  private style2(gl: GlRenderer, win: DuelWindow) {
    const { X, Y, W, H } = this.origin(win)
    const c = Math.trunc(win.chamfer ?? 5), alpha = (win.alpha ?? 128) & 0xff
    this.fillOctagon(gl, win)
    const p = this.p210
    const outline = (d: number, ox: number, oy: number) => {
      const pts: [number, number, number, number][] = [
        [c, 0, 0, c], [0, c, 0, H - d - c], [0, H - d - c, c, H - d], [c, H - d, W - d - c, H - d],
        [W - d - c, H - d, W - d, H - d - c], [W - d, H - d - c, W - d, c], [W - d, c, W - d - c, 0], [W - d - c, 0, c, 0],
      ]
      for (const [x0, y0, x1, y1] of pts) {
        p.set(0, x0, y0)
        p.set(1, x1, y1)
        this.primDraw(gl, p, ox, oy)
      }
    }
    p.init(1)
    p.setColor(0, 0, 0, alpha)
    outline(1, X, Y)
    p.init(1)
    p.setColor(0xff, 0xff, 0xff, alpha)
    outline(5, X + 2, Y + 2)
  }

  /** Style 3 (0x0886B024): fill + skin 0 frame, 39×39 corners, 7-px edges. */
  private style3(gl: GlRenderer, win: DuelWindow) {
    const { X, Y, W, H } = this.origin(win)
    this.fillOctagon(gl, win)
    const b = win.bright ?? 128, col = sprCol(b, b, b, win.alpha ?? 128)
    const s = (r: Rect, x: number, y: number, sx = 1, sy = 1) => this.spr(gl, 0, ...r, x, y, col, sx, sy)
    s([0, 0, 0x27, 0x27], X, Y)
    s([0x29, 0, 0x50, 0x27], X + W - 0x27, Y)
    s([0, 0x29, 0x27, 0x50], X, Y + H - 0x27)
    s([0x29, 0x29, 0x50, 0x50], X + W - 0x27, Y + H - 0x27)
    s([0x27, 0, 0x28, 7], X + 0x27, Y, W - 0x4e, 1)
    s([0x27, 0x4a, 0x28, 0x50], X + 0x27, Y + H - 6, W - 0x4e, 1)
    s([0, 0x27, 7, 0x28], X, Y + 0x27, 1, H - 0x4e)
    s([0x4a, 0x27, 0x50, 0x28], X + W - 6, Y + 0x27, 1, H - 0x4e)
  }

  /** Style 4 (0x0886B3CC): fill + skin 1 frame, 32×32 corners, edges tiled in 64-px pieces (last one cut). */
  private style4(gl: GlRenderer, win: DuelWindow) {
    const { X, Y, W, H } = this.origin(win)
    this.fillOctagon(gl, win)
    const b = win.bright ?? 128, col = sprCol(b, b, b, win.alpha ?? 128)
    const img = this.skins[1]
    // winStateDraw04 resets the skin's blend to 0 (normal) when it first binds it.
    const s = (r: Rect, x: number, y: number) => img && this.sprImg(gl, img, ...r, x, y, col, 1, 1, 'alpha')
    s([0, 0, 32, 32], X, Y)
    s([96, 0, 128, 32], X + W - 32, Y)
    s([0, 96, 32, 128], X, Y + H - 32)
    s([96, 96, 128, 128], X + W - 32, Y + H - 32)
    for (let rem = W - 64, x = X + 32; rem > 0; rem -= 64, x += 64) {
      s(rem < 65 ? [96 - rem, 0, 96, 32] : [32, 0, 96, 32], x, Y)
      s(rem < 65 ? [96 - rem, 96, 96, 128] : [32, 96, 96, 128], x, Y + H - 32)
    }
    for (let rem = H - 64, y = Y + 32; rem > 0; rem -= 64, y += 64) {
      s(rem < 65 ? [0, 96 - rem, 32, 96] : [0, 32, 32, 96], X, y)
      s(rem < 65 ? [96, 96 - rem, 128, 96] : [96, 32, 128, 96], X + W - 32, y)
    }
  }

  /** Style 5 (0x0886B7A4): a 30-px band (fill with h = 30, chamfer 0) and skin 2 caps. */
  private style5(gl: GlRenderer, win: DuelWindow) {
    this.fillOctagon(gl, win, 30, 0)
    const { X, Y, W } = this.origin(win)
    const b = win.bright ?? 128, col = sprCol(b, b, b, win.alpha ?? 128)
    this.spr(gl, 2, 0, 0, 0x30, 0x30, X - 0x26, Y - 5, col)
    this.spr(gl, 2, 0x30, 0, 0x60, 0x30, X + W - 10, Y - 5, col)
    this.spr(gl, 2, 0x30, 0, 0x31, 0x30, X + 10, Y - 5, col, W - 0x14, 1)
  }

  /** Style 6 (0x0886B9E8): white speech bubble with a drop shadow and a tail toward (pointX, pointY). */
  private style6(gl: GlRenderer, win: DuelWindow, frame: number) {
    const { X, Y, W, H } = this.origin(win)
    const c = Math.trunc(win.chamfer ?? 5)
    const px = Math.trunc(win.pointX ?? 0), py = Math.trunc(win.pointY ?? 0)
    const alpha = (win.alpha ?? 128) & 0xff
    const yb = H - c, xr = W - c
    const [a, b2, c2] = [this.p210, this.p280, this.p2f0]
    a.init(3); a.set(0, 0, c); a.set(1, c, 0); a.set(2, 0, yb); a.set(3, c, H)
    b2.init(3); b2.set(0, c, 0); b2.set(1, xr, 0); b2.set(2, c, H); b2.set(3, xr, H)
    c2.init(3); c2.set(0, xr, 0); c2.set(1, W, c); c2.set(2, xr, H); c2.set(3, W, yb)
    // side of the tail: 1 above, 2 below, 3 left, 4 right; (s6, s7) = tail base
    let side = 0, s6 = 0, s7 = 0, l4 = 0, l8 = 0
    if (py < Y) { side = 1; s7 = Y } else if (Y + H < py) { side = 2; s7 = Y + H }
    const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
    if (side === 0) {
      if (px < X) { side = 3; s6 = X } else if (X + W < px) { side = 4; s6 = X + W }
      if (side) {
        s7 = clamp(py + 30, Y + c, Y + H - c - 40)
        l4 = 0; l8 = 40
      }
    } else {
      s6 = clamp(px + 30, X + c, X + W - c - 40)
      l4 = 40; l8 = 0
    }
    const tx = px - s6, ty = py - s7
    const t = this.p360
    if (side) {
      t.init(2)
      t.set(0, 0, 0); t.set(1, l4, l8); t.set(2, tx, ty)
    }
    const shadow = Math.max(0, alpha - 0x40)
    for (const p of [a, b2, c2]) {
      p.setColor(0, 0, 0, shadow)
      this.primDraw(gl, p, X + 8, Y + 10)
    }
    if (side) {
      t.setColor(0, 0, 0, shadow)
      this.primDraw(gl, t, s6 + 8, s7 + 10)
      t.setColor(0xf0, 0xf0, 0xf0, alpha)
      this.primDraw(gl, t, s6, s7)
    }
    for (const p of [a, b2, c2]) {
      p.setColor(0xf0, 0xf0, 0xf0, alpha)
      this.primDraw(gl, p, X, Y)
    }
    // outline ("lines", see Prim2D)
    a.init(1)
    a.setColor(0, 0, 0, alpha)
    const L = (x0: number, y0: number, x1: number, y1: number, ox = X, oy = Y) => {
      a.set(0, x0, y0)
      a.set(1, x1, y1)
      this.primDraw(gl, a, ox, oy)
    }
    L(c, 0, 0, c)
    if (side === 3) {
      L(0, c, 0, s7 - Y)
      L(0, 0, 0, yb - (s7 - Y + 40), X, s7 + 40)
    } else L(0, c, 0, yb)
    L(0, yb, c, H)
    if (side === 2) {
      L(c, H, s6 - X, H)
      L(0, H, xr - (s6 - X + 40), H, s6 + 40, Y)
    } else L(c, H, xr, H)
    L(xr, H, W, yb)
    if (side === 4) {
      L(W, c, W, s7 - Y)
      L(W, 0, W, yb - (s7 - Y + 40), X, s7 + 40)
    } else L(W, yb, W, c)
    L(W, c, xr, 0)
    if (side === 1) {
      L(c, 0, s6 - X, 0)
      L(0, 0, xr - (s6 - X + 40), 0, s6 + 40, Y)
    } else L(xr, 0, c, 0)
    if (side) {
      L(tx, ty, l4, l8, s6, s7)
      L(0, 0, tx, ty, s6, s7)
    }
    this.nextArrow(gl, win, frame)
  }

  /** Style 7 (0x0886C6B8): fill, cursor or arrow, skin 3 frame (8-px corners) and optional dividers (flag 8). */
  private style7(gl: GlRenderer, win: DuelWindow, frame: number) {
    const { X, Y, W, H, f } = this.origin(win)
    this.fillOctagon(gl, win)
    if (f & WF_MENU) this.menuCursor(gl, win, frame)
    else this.nextArrow(gl, win, frame)
    const b = win.bright ?? 128, col = sprCol(b, b, b, win.alpha ?? 128)
    const s = (r: Rect, x: number, y: number, sx = 1, sy = 1) => this.spr(gl, 3, ...r, x, y, col, sx, sy)
    s([0, 0, 8, 8], X, Y)
    s([0, 11, 8, 19], X, Y + H - 8)
    s([11, 0, 19, 8], X + W - 8, Y)
    s([11, 11, 19, 19], X + W - 8, Y + H - 8)
    s([8, 0, 9, 8], X + 8, Y, W - 16, 1)
    s([8, 11, 9, 19], X + 8, Y + H - 8, W - 16, 1)
    s([0, 8, 8, 9], X, Y + 8, 1, H - 16)
    s([11, 8, 19, 9], X + W - 8, Y + 8, 1, H - 16)
    if (f & WF_DIVIDERS) {
      const px = Math.trunc(win.pointX ?? 0), py = Math.trunc(win.pointY ?? 0)
      let n = 0
      if (px > 0 && px < W) {
        n = 1
        s([0x15, 0, 0x1f, 8], X + px - 5, Y)
        s([0x15, 0xc, 0x1f, 0x14], X + px - 5, Y + H - 8)
        s([0x17, 8, 0x1d, 9], X + px - 3, Y + 8, 1, H - 16)
      }
      if (py > 0 && py < H) {
        s([0, 0x15, 8, 0x1f], X, Y + py - 5)
        s([0xc, 0x15, 0x14, 0x1f], X + W - 8, Y + py - 5)
        s([8, 0x17, 9, 0x1d], X + 8, Y + py - 3, W - 16, 1)
        n++
      }
      if (n === 2) s([0x15, 0x15, 0x1f, 0x1f], X + px - 5, Y + py - 5)
    }
  }

  /**
   * Style 8 (0x0886CCE4): radar hexagon centred on (x, y), unit = chamfer px. Each frame the draw
   * function first moves all twelve fields one step toward 0. Rings at 10–40 units ("lines" = fans
   * from the centre, see Prim2D), blue value triangles, orange delta bands, and six labels (skin 11)
   * at 60 units.
   */
  private style8(gl: GlRenderer, win: DuelWindow, frame: number) {
    const hx = win.hexagon
    if (!hx) return
    const { X, Y } = this.origin(win)
    const alpha = (win.alpha ?? 128) & 0xff
    const k = hx.hold ? 0 : Math.max(0, frame - win.opened)
    const step = (v: number) => Math.sign(v) * Math.max(0, Math.abs(Math.trunc(v)) - (k + 1))
    const val = hx.values.map(step), del = hx.deltas.map(step)
    const u = win.chamfer ?? 1
    const pt = (r: number, i: number): [number, number] => [Math.trunc(r * HEX_DIRS[i][0]), Math.trunc(r * HEX_DIRS[i][1])]
    const p = this.p210
    p.init(1)
    p.setColor(0xff, 0xff, 0xff, alpha)
    for (let i = 0; i < 6; i++) {
      p.set(0, 0, 0)
      const q = pt(u * 50, i)
      p.set(1, q[0], q[1])
      this.primDraw(gl, p, X, Y)
    }
    p.init(1)
    p.setColor(0xff, 0xff, 0xff, Math.max(0, (win.alpha ?? 128) - 0x40) & 0xff)
    for (const r of [10, 20, 30, 40]) {
      for (let i = 0; i < 6; i++) {
        const a = pt(u * r, i), b = pt(u * r, (i + 1) % 6)
        p.set(0, a[0], a[1])
        p.set(1, b[0], b[1])
        this.primDraw(gl, p, X, Y)
      }
    }
    const inner = val.map((v, i) => pt(u * v, i))
    for (let i = 0; i < 6; i++) {
      p.init(2)
      p.setVertexColor(0, 0, 0, 0, 0)
      p.setVertexColor(1, 0, 0x80, 0xff, alpha)
      p.setVertexColor(2, 0, 0x80, 0xff, alpha)
      p.set(0, 0, 0)
      p.set(1, ...inner[i])
      p.set(2, ...inner[(i + 1) % 6])
      this.primDraw(gl, p, X, Y)
    }
    const outer = val.map((v, i) => pt(u * (v + del[i]), i))
    for (let i = 0; i < 6; i++) {
      const j = (i + 1) % 6
      p.init(3)
      for (let n = 0; n < 4; n++) p.setVertexColor(n, 0xff, 0x40, 0, alpha)
      p.set(0, ...inner[i]); p.set(1, ...inner[j]); p.set(2, ...outer[i]); p.set(3, ...outer[j])
      this.primDraw(gl, p, X, Y)
    }
    const col = sprCol(128, 128, 128, win.alpha ?? 128)
    const r60 = u * 60
    const lab = (r: Rect, i: number, dy = -8) => {
      const q = pt(r60, i)
      this.spr(gl, 11, ...r, X - 16 + q[0], Y + dy + q[1], col)
    }
    lab([0, 0, 32, 16], 0)
    lab([32, 0, 64, 16], 1)
    lab([64, 0, 104, 16], 4)
    lab([0, 16, 32, 32], 5)
    lab([32, 16, 64, 48], 2)
    lab([64, 16, 104, 32], 3, -12)
  }

  /** Style 9 (0x0886F12C): `count` bars of w×h, `gap` apart, in the cursor colour; no fill, no frame. */
  private style9(gl: GlRenderer, win: DuelWindow, frame: number) {
    const bs = win.bars
    if (!bs) return
    const k = Math.max(0, frame - win.opened)
    // drawn before the update: +1 on the first frame, then every period + 1 frames, up to target
    const count = bs.count >= bs.target ? bs.count : Math.min(bs.target, bs.count + Math.trunc((k + bs.period) / (bs.period + 1)))
    const W = Math.trunc(win.w), H = Math.trunc(win.h)
    const p = this.p210
    p.init(3)
    p.set(0, 0, 0); p.set(1, W, 0); p.set(2, 0, H); p.set(3, W, H)
    p.setColor(bs.color[0], bs.color[1], bs.color[2], Math.trunc(bs.color[3] * ((win.alpha ?? 128) / 128)) & 0xff)
    for (let i = 0; i < count; i++) this.primDraw(gl, p, i * (W + bs.gap) + Math.trunc(win.x), Math.trunc(win.y))
  }

  /** Styles 10–13 (winStateDrawFramed 0x0886F364): fill, cursor/arrow, 9-slice of a skin 13 cell, tail (skin 14). */
  private framed(gl: GlRenderer, win: DuelWindow, frame: number) {
    const { X, Y, W, H, f } = this.origin(win)
    const style = win.style ?? 10
    this.fillOctagon(gl, win)
    if (f & WF_MENU) this.menuCursor(gl, win, frame)
    else this.nextArrow(gl, win, frame)
    // The arrow is drawn a second time for message windows (flag 2 is tested twice).
    this.nextArrow(gl, win, frame)
    const u0 = style === 11 || style === 13 ? 64 : 0, v0 = style >= 12 ? 64 : 0
    const b = win.bright ?? 128, col = sprCol(b, b, b, win.alpha ?? 128)
    const s = (r: Rect, x: number, y: number, sx = 1, sy = 1) => this.spr(gl, 13, r[0] + u0, r[1] + v0, r[2] + u0, r[3] + v0, x, y, col, sx, sy)
    s([0, 0, 20, 16], X, Y)
    s([44, 0, 64, 16], X + W - 20, Y)
    s([0, 48, 20, 64], X, Y + H - 16)
    s([44, 48, 64, 64], X + W - 20, Y + H - 16)
    s([20, 0, 21, 16], X + 20, Y, W - 40, 1)
    s([20, 48, 21, 64], X + 20, Y + H - 16, W - 40, 1)
    s([0, 16, 20, 17], X, Y + 16, 1, H - 32)
    s([44, 16, 64, 17], X + W - 20, Y + 16, 1, H - 32)
    if (style === 12) s([20, 16, 21, 17], X + 20, Y + 16, W - 40, H - 32)
    const ti = win.tailIdx ?? 0
    if ((style === 10 || style === 11) && ti) {
      const r = this.tables.tailRects[ti]
      if (r) this.spr(gl, 14, ...r, X + 20, Y + H - (r[3] - r[1]), col)
    }
  }

  // ---- glyphs ----

  private glyphAlpha(win: DuelWindow, g: WinGlyph, frame: number): number {
    const appear = win.opened + g.at
    if (frame < appear) return -1
    return Math.min(g.fade * (frame - appear + 1), win.alpha ?? 128)
  }

  /** winGlyphDraw / winIconGlyphDraw / winDigitGlyphDraw for every glyph of the window. */
  private drawGlyphs(gl: GlRenderer, win: DuelWindow, frame: number, lay: WinLayout) {
    const f = win.flags ?? 0
    const style = win.style ?? 10
    const [ox, oy] = this.tables.textOffset[style] ?? [15, 15]
    const shift = win.face && !(f & WF_FACE_NO_SHIFT) ? 100 : 0
    const { sx, sy } = layout(win.glyph, win.wide)
    const left = f & WF_CENTER_X ? win.x - win.w / 2 : win.x
    const top = f & WF_CENTER_Y ? win.y - win.h / 2 : win.y
    const L = Math.trunc(left), T = Math.trunc(top)
    const b = win.bright ?? 128
    const glyphs = win.numbers ? [...lay.glyphs, ...numberGlyphs(win.numbers, win.fade ?? 4)] : lay.glyphs
    for (const g of glyphs) {
      const a = this.glyphAlpha(win, g, frame)
      if (a <= 0) continue
      if (g.k === 'text') {
        const img = this.glyph(g.code)
        if (!img) continue
        // spriteDrawFontGlyph at p = trunc(scale + winLeft + x + offset (+100)). The fullfont glyph
        // sprites have anchor 0x10 (pivot (8, 8), offset 0), so vertex = p + 8 + trunc(scale·(corner − 8)):
        // the glyph is centred on p + 8, i.e. its unscaled 16×16 cell has its top-left at p.
        const cx = Math.trunc(sx + left + g.x + ox + shift) + 8, cy = Math.trunc(sy + top + g.y + oy) + 8
        const hx = Math.trunc(8 * sx), hy = Math.trunc(8 * sy)
        const pal = this.tables.fontPalettes[g.palette & 0xf] ?? [255, 255, 255]
        const c = sprCol(b, b, b, a)
        const X0 = sprX(cx - hx), X1 = sprX(cx + hx), Y0 = sprY(cy - hy), Y1 = sprY(cy + hy)
        const P = (px: number, py: number, u: number, v: number): Vertex => ({ x: px, y: py, w: 1, d: Z, u: u / 16, v: v / 16 })
        gl.triangles(gl.texture(img), 'alpha', quad(P(X0, Y0, 0, 0), P(X1, Y0, 16, 0), P(X0, Y1, 0, 16), P(X1, Y1, 16, 16)), [(c[0] * pal[0]) / 255, (c[1] * pal[1]) / 255, (c[2] * pal[2]) / 255, c[3]])
      } else if (g.k === 'icon') {
        const r = this.tables.iconRects[g.skin]?.[g.id]
        if (!r) continue
        const kk = frame - (win.opened + g.at)
        const n = kk >= g.delay ? Math.trunc((kk - g.delay) / (g.delay + 1)) + 1 : 0
        const fr = g.last > 0 || g.delay > 0 ? n % (g.last + 1) : 0
        const sc = g.skin === 10 ? 0.5625 : 1
        this.spr(gl, g.skin, r[0], r[1] + fr * 0x12, r[2], r[3] + fr * 0x12, Math.trunc(1.2 + L + g.x + ox + shift), Math.trunc(1.2 + T + g.y + oy), sprCol(b, b, b, a), sc, sc)
      } else {
        const r = this.tables.digitUVs[g.style]?.[g.digit]
        if (!r) continue
        const t = this.tables.tints[g.attr] ?? [0, 0, 0]
        // winDigitGlyphDraw's clamp: out-of-range channels become 0, and an overflowing G or B clears R.
        let R = b + t[0], G = b + t[1], B = b + t[2]
        if (R < 0) R = 0
        else if (R > 0x100) R = 0
        if (G < 0) G = 0
        else if (G > 0x100) R = 0
        if (B < 0) B = 0
        else if (B > 0x100) R = 0
        const face = win.face && !(f & WF_FACE_NO_SHIFT)
        const x = face ? Math.trunc(L + g.x + ox + 100 + 4) : Math.trunc(L + g.x + ox - 4)
        const y = face ? Math.trunc(T + g.y + oy + 4) : Math.trunc(T + g.y + oy)
        this.spr(gl, 12, ...r, x, y, sprCol(R & 0xff, G & 0xff, B & 0xff, a))
      }
    }
  }

  /** Face (menuWinUpdateAll): scale (w/160, h/160), bottom centre at (x + w/2 + 8, y + h − 8), fading in +8/frame. */
  private drawFace(gl: GlRenderer, win: DuelWindow, frame: number) {
    const f = win.face
    if (!f) return
    const since = frame - (win.faceOpened ?? win.opened)
    const a = Math.min(8 * (since + 1), win.alpha ?? 128)
    if (a <= 0) return
    const b = win.bright ?? 128
    const scx = win.w / 160, scy = win.h / 160
    const px = Math.trunc(win.x + win.w / 2 + 8), py = Math.trunc(win.y + win.h - 8)
    const X0 = sprX(px + Math.trunc(-scx * (f.width / 2))), X1 = sprX(px + Math.trunc(scx * (f.width / 2)))
    const Y0 = sprY(py + Math.trunc(-scy * f.height)), Y1 = sprY(py)
    const P = (x: number, y: number, u: number, v: number): Vertex => ({ x, y, w: 1, d: Z, u, v })
    gl.triangles(gl.texture(f), 'alpha', quad(P(X0, Y0, 0, 0), P(X1, Y0, 1, 0), P(X0, Y1, 0, 1), P(X1, Y1, 1, 1)), sprCol(b, b, b, a))
  }

  /** One window as menuWinUpdateAll draws it: the style's draw function, then the glyphs, then the face. */
  draw(gl: GlRenderer, win: DuelWindow, frame: number) {
    const lay = windowLayout(win, this.tables)
    const style = lay.style ?? win.style ?? 10
    const w = style === (win.style ?? 10) ? win : { ...win, style }
    switch (style) {
      case 0:
        break
      case 1:
        this.fillOctagon(gl, w)
        break
      case 2:
        this.style2(gl, w)
        break
      case 3:
        this.style3(gl, w)
        break
      case 4:
        this.style4(gl, w)
        break
      case 5:
        this.style5(gl, w)
        break
      case 6:
        this.style6(gl, w, frame)
        break
      case 7:
        this.style7(gl, w, frame)
        break
      case 8:
        this.style8(gl, w, frame)
        break
      case 9:
        this.style9(gl, w, frame)
        break
      default:
        this.framed(gl, w, frame)
    }
    this.drawGlyphs(gl, w, frame, lay)
    this.drawFace(gl, w, frame)
  }
}

/** winPrintNumber (0x08873460): digits right to left from x − 12, 12 px apart, then the sign glyph. */
export function numberGlyphs(nums: WinNumber[], fade: number): WinGlyph[] {
  const out: WinGlyph[] = []
  for (const n of nums) {
    let v = Math.trunc(n.value), sign = 0
    if (n.sign) {
      if (v < 0) {
        sign = 0xc
        v = -v
      } else sign = 0xb
      if (v === 0) sign = 0xd
    }
    let x = n.x, i = 0
    while (i < n.maxDigits) {
      const d = v % 10
      x -= 12
      v = Math.trunc(v / 10)
      out.push({ k: 'digit', style: n.style, digit: d, attr: n.attr, x, y: n.y, at: 0, fade })
      i++
      if (v === 0) break
    }
    if (sign && i < n.maxDigits) out.push({ k: 'digit', style: n.style, digit: sign, attr: n.attr, x: x - 12, y: n.y, at: 0, fade })
  }
  return out
}
