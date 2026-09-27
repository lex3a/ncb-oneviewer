/**
 * The game's full-screen card info viewer (cardInfoDraw 0x08821C30 and the tabs it calls), drawn with
 * canvas 2D on a 480×272 canvas. Every coordinate below is the game's own 640×448 virtual position;
 * like spriteDraw2D, the four vertices of each quad are computed in virtual pixels (scale and
 * rotation around the sprite's pivot, truncated to integers) and then mapped to the screen with
 * x·480/640 and y·272/448, truncated. See docs/formats/card-screen.md.
 */
import { glyphPixels, sjisToGlyph } from '../formats/font'
import { asciiToSjis, type Card, type GameDb } from '../formats/gamedb'
import { drawGanFrame, HOLD, type Gan, type SheetCache } from '../formats/gan'

export const SCREEN_W = 480
export const SCREEN_H = 272

/** Virtual 640×448 → screen, truncated like spriteDraw2D (x*0x1E0/0x280, y*0x110/0x1C0). */
const toX = (v: number) => Math.trunc((v * 480) / 640)
const toY = (v: number) => Math.trunc((v * 272) / 448)

/** Tab bits of g_cardInfoTab. */
export const TAB_STATUS = 1
export const TAB_ATTACH = 2
export const TAB_FLAVOR = 4
export const TAB_ABILITIES = 8

/** Tab labels as printed on the sprites (etc.one 2/5), in bit order. */
export const TAB_LABELS: Record<number, string> = { 1: 'Ability', 2: 'Enchant', 4: 'Detail', 8: 'Skill' }

/** cardInfoDraw: sprite rect index of each tab bit (1 → 0, 2 → 2, 4 → 1, 8 → 3). */
const TAB_RECT_INDEX: Record<number, number> = { 1: 0, 2: 2, 4: 1, 8: 3 }

// Tables read from BOOT.BIN.
const TAB_RECTS = 0x088b791c // g_cardInfoTabRects: u16 [8][4] (4 inactive, 4 active)
const ATTR_ICON_RECTS = 0x088f4678 // g_attrIconRects: s16 [13][8] (four corners; TL and BR are used)
const DIGIT_CELLS = 0x088b9f94 // uiDrawDigit cell table
const FONT_PALETTES = 0x088f4c00 // g_fontPaletteColors: 16 × RGB
const HAND_FRAMES = 0x088b8664 // uiDrawPointerHand: u8 u[6] at +0, u8 v[6] at +8

type Rect = [number, number, number, number]

export interface CardScreenTables {
  tabInactive: Rect[]
  tabActive: Rect[]
  attrIcons: Rect[]
  /** Style 0 digit cell: u = u0 + digit·w. */
  digit: { u0: number; v0: number; w: number; h: number }
  fontPalettes: [number, number, number][]
  hand: { u: number[]; v: number[] }
}

export function readCardScreenTables(db: GameDb): CardScreenTables {
  const tr = db.raw.bytes(TAB_RECTS, 64)
  const u16 = (a: Uint8Array, i: number) => (a[i * 2] ?? 0) | ((a[i * 2 + 1] ?? 0) << 8)
  const rect = (a: Uint8Array, i: number): Rect => [u16(a, i * 4), u16(a, i * 4 + 1), u16(a, i * 4 + 2), u16(a, i * 4 + 3)]
  const ar = db.raw.bytes(ATTR_ICON_RECTS, 13 * 16)
  const s16 = (i: number) => (u16(ar, i) << 16) >> 16
  const attrIcons: Rect[] = []
  for (let k = 0; k < 13; k++) attrIcons.push([s16(k * 8), s16(k * 8 + 1), s16(k * 8 + 4), s16(k * 8 + 5)])
  const dc = db.raw.bytes(DIGIT_CELLS, 12)
  const fp = db.raw.bytes(FONT_PALETTES, 48)
  const fontPalettes: [number, number, number][] = []
  for (let i = 0; i < 16; i++) fontPalettes.push([fp[i * 3] ?? 255, fp[i * 3 + 1] ?? 255, fp[i * 3 + 2] ?? 255])
  const hf = db.raw.bytes(HAND_FRAMES, 14)
  return {
    tabInactive: [0, 1, 2, 3].map((i) => rect(tr, i)),
    tabActive: [4, 5, 6, 7].map((i) => rect(tr, i)),
    attrIcons,
    digit: { u0: dc[0] ?? 0, v0: dc[1] ?? 40, w: dc[4] ?? 18, h: dc[5] ?? 24 },
    fontPalettes,
    hand: { u: Array.from(hf.subarray(0, 6)), v: Array.from(hf.subarray(8, 14)) },
  }
}

// ---------------------------------------------------------------------------------------------
// text as fontDrawTextScaled 0x088390D4 lays it out

/** Line break code in fontCodes output. */
export const FONT_NEWLINE = -1

/**
 * fontDrawTextScaled splits at `＠ｎ`; fullfontSetText converts each ASCII byte to one full-width code
 * (strAsciiToSjis) and keeps 2-byte codes; fullfontDraw breaks lines at CR LF. No other markup is
 * interpreted (the card texts contain only `＠ｎ`).
 */
export function fontCodes(b: Uint8Array): number[] {
  const out: number[] = []
  let i = 0
  while (i < b.length && b[i]) {
    const c = b[i]
    if (c === 0x81 && b[i + 1] === 0x97 && b[i + 2] === 0x82 && b[i + 3] === 0x8e) {
      out.push(FONT_NEWLINE)
      i += 4
    } else if ((c >= 0x81 && c <= 0x9f) || (c >= 0xe0 && c <= 0xfc) || c === 0x0d) {
      const code = (c << 8) | (b[i + 1] ?? 0)
      out.push(code === 0x0d0a ? FONT_NEWLINE : code)
      i += 2
    } else {
      out.push(asciiToSjis(c))
      i++
    }
  }
  return out
}

const asciiBytes = (s: string) => Uint8Array.from(s, (ch) => ch.charCodeAt(0) & 0xff)

// ---------------------------------------------------------------------------------------------

export type Img = HTMLCanvasElement

export interface CardScreenAssets {
  /** etc.one 2/1: number font (g_uiNumberFontSprite). */
  digits: Img | null
  /** etc.one 2/2: pointer hand. */
  hand: Img | null
  /** etc.one 2/4: labels, banners, stars, underline (g_cardInfoUiSprite). */
  ui: Img | null
  /** etc.one 2/5: tabs and frame (g_cardInfoFrameSprite). */
  frame: Img | null
  /** etc.one 1/11: attribute / category icons (g_winSkinSprites[10]). */
  icons: Img | null
  /** gothic16.bin. */
  font: Uint8Array | null
  /** unit.one <card id>/3, 240×300 (g_cardPreviewSprite). */
  preview: Img | null
  /** unit.one <attachment id or 1000>/2, 80×100 (g_mapInfoAttachSprites). */
  attachments: (Img | null)[]
  /** card.one <card id> (g_cardMapAnims), units only. */
  gan: { gan: Gan; sheets: SheetCache } | null
  /** card.one 10010/<card id>: board token (cardGetTokenSprite), bases. */
  token: Img | null
}

export interface CardScreenState {
  card: Card
  /** g_cardInfoMode: 3 = card list / deck editor (cardInfoDrawCard), 1 = map unit (cardInfoDrawUnit). */
  mode: 1 | 2 | 3
  /** g_cardInfoTab (one bit). */
  tab: number
  /** g_cardInfoAttachCursor, −1 = none. */
  cursor: number
  /** {AP, HP, Range, Move, Attr} */
  base: number[]
  /** {AP, DF, Range, Move, Attr} */
  eff: number[]
  /** g_cardInfoShowDf */
  showDf: boolean
  /** MapUnit attachments (card ids, 0 = empty). */
  attachments: number[]
  /** Map-unit mode: the name unitGetName gives (a Dominator's player name). */
  name?: string | Uint8Array
}

/** Tabs the viewer offers (cardInfoUpdate `allowedTabs`, which equals the tab mask cardInfoDraw draws). */
export function allowedTabs(cardId: number, mode: number): number {
  if (mode === 3) return cardId < 2000 ? 0xd : 5
  if (mode === 2) return cardId < 2000 ? 9 : 1
  if (mode === 1) return cardId < 2000 ? 0xb : 1
  return 1
}

/**
 * Viewer only (the game has no touch input): the tab under screen point (x, y) of the 480×272 canvas,
 * or 0. Tabs sit where cardInfoDraw draws them: slot i (left to right over the allowed bits) at virtual
 * x = trunc(i·0x4C·1.2 + 324), y = 0x15; the hit box is one slot wide and as tall as the active tab sprite.
 */
export function tabAt(tables: CardScreenTables, cardId: number, mode: number, x: number, y: number): number {
  const allowed = allowedTabs(cardId, mode)
  let slot = 0
  for (let bit = 0; bit < 4; bit++) {
    const b = 1 << bit
    if (!(allowed & b)) continue
    const r = tables.tabActive[TAB_RECT_INDEX[b]]
    const vx = Math.trunc(slot * 0x4c * 1.2 + 324.0)
    const x0 = toX(vx), x1 = toX(Math.trunc(vx + 0x4c * 1.2))
    const y0 = toY(0x15), y1 = toY(0x15 + (r ? r[3] - r[1] : 0x28))
    if (x >= x0 && x < x1 && y >= y0 && y < y1) return b
    slot++
  }
  return 0
}

/** cardInfoUpdate state 2: Left/Right move the tab bit and skip tabs that are not allowed. */
export function stepTab(tab: number, dir: number, allowed: number): number {
  let t = tab || 1
  if (dir < 0) {
    do {
      t >>= 1
      if (t === 0) t = 8
    } while ((t & allowed) === 0)
  } else {
    if (dir > 0) t <<= 1
    while ((t & allowed) === 0) {
      const n = (t << 1) & 0xff
      t = n < 0x10 ? n : 1
    }
  }
  return t
}

/** cardInfoUpdate state 3: cursor over the 3×2 grid (Left/Right wrap in the row, Up/Down swap rows). */
export function stepCursor(cursor: number, key: 'left' | 'right' | 'up' | 'down'): number {
  if (key === 'up' || key === 'down') return cursor < 3 ? cursor + 3 : cursor - 3
  if (key === 'left') return cursor === 0 ? 2 : cursor === 3 ? 5 : cursor - 1
  return cursor === 2 ? 0 : cursor === 5 ? 3 : cursor + 1
}

/** Globals the screen animates with: g_cardInfoStarTimer/Frame and uiAnimCounter modes 2 and 5. */
export class CardScreenClock {
  starTimer = 0
  starFrame = 0
  /** uiAnimCounter(0) state: +1 per frame; mode 2 = c2 >> 2 (0..5), mode 5 = angle −180..180. */
  private c2 = 0
  angle = 0
  ganStep = 0
  ganTick = 0
  ganGan: Gan | null = null

  /** uiAnimCounter(0), once per frame. */
  tick() {
    this.c2++
    if (this.c2 >> 2 > 5) this.c2 = 0
    let a = this.angle + 1
    if (a > 180) a = this.angle - 359
    if (a < -180) a += 360
    this.angle = a
  }

  get handFrame() {
    return this.c2 >> 2
  }
}

interface SprOpts {
  scaleX?: number
  scaleY?: number
  pivotX?: number
  pivotY?: number
  /** Z rotation in radians around the pivot. */
  rot?: number
}

export class CardScreenRenderer {
  /** Scaled images drawn bilinearly (Play mode's "bilinear" option); the viewer draws them nearest. */
  smooth = false
  private glyphs = new Map<number, Img>()
  private tables: CardScreenTables
  private db: GameDb
  private assets: CardScreenAssets
  private ctx: CanvasRenderingContext2D | null = null

  constructor(db: GameDb, tables: CardScreenTables, assets: CardScreenAssets) {
    this.db = db
    this.tables = tables
    this.assets = assets
  }

  /**
   * One quad like spriteUpdateVertices + spriteDraw2D: vertex = pos + pivot + trunc(R·S·(corner − pivot)),
   * then virtual → screen. The texture rect is mapped affinely onto the resulting parallelogram.
   */
  private spr(img: Img | null, u0: number, v0: number, u1: number, v1: number, x: number, y: number, o: SprOpts = {}) {
    const ctx = this.ctx
    if (!ctx || !img) return
    const w = u1 - u0, h = v1 - v0
    if (w <= 0 || h <= 0) return
    const sX = o.scaleX ?? 1, sY = o.scaleY ?? 1
    const px = o.pivotX ?? 0, py = o.pivotY ?? 0
    const c = Math.cos(o.rot ?? 0), s = Math.sin(o.rot ?? 0)
    const vert = (cx: number, cy: number): [number, number] => {
      let lx = (cx - px) * sX, ly = (cy - py) * sY
      if (o.rot) [lx, ly] = [lx * c - ly * s, lx * s + ly * c]
      return [toX(x + px + Math.trunc(lx)), toY(y + py + Math.trunc(ly))]
    }
    const [ax, ay] = vert(0, 0)
    const [bx, by] = vert(w, 0)
    const [cx, cy] = vert(0, h)
    if ((bx === ax && by === ay) || (cx === ax && cy === ay)) return
    ctx.setTransform((bx - ax) / w, (by - ay) / w, (cx - ax) / h, (cy - ay) / h, ax, ay)
    ctx.drawImage(img, u0, v0, w, h, 0, 0, w, h)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
  }

  /** A gothic16 glyph in font palette `pal`: ink alpha 0x80, outline (8-neighbour) alpha 0x20 (fullfontLoad). */
  private glyph(code: number, pal: number): Img | null {
    const font = this.assets.font
    if (!font) return null
    const idx = sjisToGlyph(code)
    const key = idx * 16 + (pal & 15)
    let c = this.glyphs.get(key)
    if (!c) {
      const [r, g, b] = this.tables.fontPalettes[pal & 15] ?? [255, 255, 255]
      const px = glyphPixels(font, idx, true)
      c = document.createElement('canvas')
      c.width = 16
      c.height = 16
      const g2 = c.getContext('2d')!
      const im = g2.createImageData(16, 16)
      for (let i = 0; i < 256; i++) if (px[i]) im.data.set([r, g, b, px[i] === 1 ? 255 : 63], i * 4)
      g2.putImageData(im, 0, 0)
      this.glyphs.set(key, c)
    }
    return c
  }

  /**
   * fontDrawTextScaled(text, x, y, z, glyphSize, lineHeight, colour): glyph scale (glyph/18)·0.8 ×
   * line/18 around the glyph centre, advance trunc(16·scaleX − 5), `＠ｎ` moves down `line`.
   */
  private text(raw: Uint8Array | string, x: number, y: number, glyph: number, line: number, pal = 0) {
    const codes = fontCodes(typeof raw === 'string' ? asciiBytes(raw) : raw)
    const scX = Math.fround((glyph / 18) * 0.8), scY = Math.fround(line / 18)
    const adv = Math.trunc(scX * 16 - 5)
    const hx = Math.trunc(8 * scX), hy = Math.trunc(8 * scY)
    let cx = x, cy = y
    for (const code of codes) {
      if (code === FONT_NEWLINE) {
        cx = x
        cy += line & 0xff
        continue
      }
      if (code !== 0x8140) {
        const g = this.glyph(code, pal)
        if (g && this.ctx) {
          const x0 = toX(cx + 8 - hx), y0 = toY(cy + 8 - hy)
          this.ctx.drawImage(g, 0, 0, 16, 16, x0, y0, toX(cx + 8 + hx) - x0, toY(cy + 8 + hy) - y0)
        }
      }
      cx += adv
    }
  }

  /** uiDrawDigit(1, 1, digit, x, y, 0, style 0, 0): etc.one 2/1 cell, 11 = '/'. */
  private digit(d: number, x: number, y: number) {
    if (d < 0 || d > 12) return
    const { u0, v0, w, h } = this.tables.digit
    const u = u0 + d * w
    this.spr(this.assets.digits, u, v0, u + w, v0 + h, x, y)
  }

  /** cardInfoDrawUnderline 0x08839368: left cap, stretched middle, right cap. */
  private underline(width: number, x: number, y: number) {
    const ui = this.assets.ui
    this.spr(ui, 0x50, 0x60, 0x58, 0x66, x, y)
    if (width > 0x10) this.spr(ui, 0x58, 0x60, 0x59, 0x66, x + 8, y, { scaleX: width - 0x10 })
    this.spr(ui, 0x68, 0x60, 0x70, 0x66, x + width - 8, y)
  }

  private icon(index: number, x: number, y: number) {
    const r = this.tables.attrIcons[index]
    if (r) this.spr(this.assets.icons, r[0], r[1], r[2], r[3], x, y)
  }

  /** The spinning Soul icon: anchor 0x10 (centre pivot), rotation uiAnimCounter(5)°. */
  private soulIcon(x: number, y: number, clock: CardScreenClock) {
    this.spr(this.assets.ui, 0x51, 0x31, 0x67, 0x47, x, y, { pivotX: 11, pivotY: 11, rot: (clock.angle * 3.141592) / 180 })
  }

  private ability(id: number) {
    const ab = this.db.abilities.get(id) ?? this.db.abilities.get(0)
    const s = this.db.raw.abilityStrings.get(ab?.id ?? 0)
    return { ab, name: s?.name ?? new Uint8Array(0), description: s?.description ?? new Uint8Array(0) }
  }

  /**
   * One frame: cardInfoDrawCard / cardInfoDrawUnit. `clear` = false draws over what is already there
   * (the deck editor / card list scene behind the viewer, as in the game).
   */
  draw(ctx: CanvasRenderingContext2D, st: CardScreenState, clock: CardScreenClock, clear = true) {
    this.ctx = ctx
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.imageSmoothingEnabled = this.smooth
    if (clear) {
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, SCREEN_W, SCREEN_H)
    }
    this.drawInfo(st, clock)
    if (st.mode === 1 && st.tab === TAB_ATTACH) this.drawAttachments(st, clock, 0x144, 0x20)
    this.ctx = null
  }

  /** cardInfoDraw 0x08821C30. */
  private drawInfo(st: CardScreenState, clock: CardScreenClock) {
    const { card } = st
    const a = this.assets
    if (a.preview) this.spr(a.preview, 0, 0, a.preview.width, a.preview.height, 0x1c, 0x10, { scaleX: 1.2, scaleY: 1.2 })
    let mask = card.id < 2000 ? 9 : 1
    if (st.mode === 3) mask |= 4
    else if (st.mode === 1 && card.id < 2000) mask |= 2
    let count = 0
    for (let m = mask; m; m >>= 1) if (m & 1) count++
    const f = a.frame
    if (f) {
      const tabX = (pos: number) => Math.trunc(pos * 1.2 + 324.0)
      // Inactive tabs, right to left.
      let pos = count * 0x4c
      for (let bit = 3; bit >= 0; bit--) {
        if (!((mask >> bit) & 1)) continue
        pos -= 0x4c
        const r = this.tables.tabInactive[TAB_RECT_INDEX[1 << bit]]
        this.spr(f, r[0], r[1], r[2], r[3], tabX(pos), 0x15, { scaleX: 1.2 })
      }
      // Frame: corners, stretched edges and the stretched centre (the right edge uses rows 0x9A–0xB0).
      this.spr(f, 0, 0x90, 0x20, 0xb0, 0x144, 0x3b)
      this.spr(f, 0x60, 0x90, 0x80, 0xb0, 0x244, 0x3b)
      this.spr(f, 0, 0xf0, 0x20, 0x110, 0x144, 0x158)
      this.spr(f, 0x60, 0xf0, 0x80, 0x110, 0x244, 0x158)
      this.spr(f, 0x20, 0x90, 0x40, 0xb0, 0x164, 0x3b, { scaleX: 7 })
      this.spr(f, 0x20, 0xf0, 0x40, 0x110, 0x164, 0x158, { scaleX: 7 })
      this.spr(f, 0, 0xb0, 0x20, 0xc6, 0x144, 0x5b, { scaleY: 11.5 })
      this.spr(f, 0x60, 0x9a, 0x80, 0xb0, 0x244, 0x5b, { scaleY: 11.5 })
      this.spr(f, 0x20, 0xb0, 0x40, 0xc6, 0x164, 0x5b, { scaleX: 7, scaleY: 11.5 })
      // Active tab, left to right.
      pos = 0
      for (let bit = 0; bit < 4; bit++) {
        const b = 1 << bit
        if ((st.tab & 0xf) === b) {
          const r = this.tables.tabActive[TAB_RECT_INDEX[b]]
          this.spr(f, r[0], r[1], r[2], r[3], tabX(pos), 0x15, { scaleX: 1.2 })
        }
        if (mask & b) pos += 0x4c
      }
      // Name plate.
      this.spr(f, 0, 0x60, 0xf2, 0x83, 0x14a, 0x42)
    }
    const strings = this.db.raw.cardStrings.get(card.id)
    // map-unit mode: unitGetName, which gives a Dominator its player's name (duelGetPlayerName)
    const name = st.mode === 1 && card.id > 1000 && card.id < 2000 && st.name ? st.name : (strings?.name ?? card.name)
    this.text(name, 0x15a, 0x4c, 0x15, 0x15)
    this.icon(card.attribute, 0x23e, 0x45)
    const tab = st.tab & 0xf
    if (tab === TAB_ABILITIES) this.drawAbilityList(card, clock, 0x144, 0x20)
    else if (tab === TAB_FLAVOR) {
      if (card.id < 1000) this.drawGan(clock, 0x220, 0x168, 1.8)
      else if (card.id > 2999 && a.token) {
        // spriteSetAnchor(2) + spriteResetOffset: pivot at the bottom centre, drawn at (0x220 − w/2, 0x168 − h), scale 1.8 around it.
        const t = a.token
        this.spr(t, 0, 0, t.width, t.height, 0x220 - (t.width >> 1), 0x168 - t.height, { scaleX: 1.8, scaleY: 1.8, pivotX: t.width >> 1, pivotY: t.height })
      }
      this.text(strings?.flavor ?? '', Math.trunc(0x144 + 16.0), 0x20 + 0x52, 0x16, 0x16)
    } else if (tab === TAB_STATUS) this.drawDetail(st, clock, 0x144, 0x20)
  }

  /** anmDrawAndTick(x, y, 0, g_cardMapAnims[card]) at scale sc (assumed around the origin at (x, y)). */
  private drawGan(clock: CardScreenClock, x: number, y: number, sc: number) {
    const g = this.assets.gan
    const ctx = this.ctx
    if (!g || !ctx) return
    if (clock.ganGan !== g.gan) {
      clock.ganGan = g.gan
      clock.ganStep = 0
      clock.ganTick = 0
    }
    const steps = g.gan.steps
    const step = steps[clock.ganStep]
    const parts = g.gan.frames[step?.frame ?? 0]
    ctx.save()
    ctx.setTransform((sc * 480) / 640, 0, 0, (sc * 272) / 448, (x * 480) / 640, (y * 272) / 448)
    // Part destinations are stored +128 (docs/formats/gan.md).
    drawGanFrame(ctx, g.sheets, parts, -128, -128)
    ctx.restore()
    // Tick: one frame per draw, 255 holds forever.
    if (step && step.duration !== HOLD && steps.length > 1) {
      clock.ganTick++
      if (clock.ganTick >= Math.max(1, step.duration)) {
        clock.ganTick = 0
        clock.ganStep = (clock.ganStep + 1) % steps.length
      }
    }
  }

  /** cardDrawDetailPanel 0x088200A0: the status tab. */
  private drawDetail(st: CardScreenState, clock: CardScreenClock, x: number, y: number) {
    const { card, base, eff } = st
    const ui = this.assets.ui
    const rarity = card.rarity & 0xff
    // Star blink: 3 frames for rarity 6, 2 for 4–5, one change every 9 draws.
    clock.starTimer++
    if (rarity === 6 || rarity >= 4) {
      if (clock.starTimer > 8) clock.starTimer = 0
      if (clock.starTimer === 0) clock.starFrame++
      if (clock.starFrame > (rarity === 6 ? 2 : 1)) clock.starFrame = 0
    } else clock.starFrame = 0

    const kind = card.id !== 0 ? Math.trunc(card.id / 1000) : 0
    const banner: Rect = kind === 1 ? [0, 0x9a, 0xac, 0xb0] : kind === 2 ? [0, 0x84, 0xac, 0x9a] : kind === 3 ? [0, 0xb0, 0xac, 0xc6] : [0, 0x6e, 0xac, 0x84]
    this.spr(ui, ...banner, x + 0x10, y + 0x48)
    const sf = clock.starFrame
    for (let i = 0; i < rarity; i++) this.spr(ui, sf * 15, 200, (sf + 1) * 15, 0xd7, x + 0xc0 + i * 15, y + 0x4c)

    /** A value with an optional tens digit: ones at `x1 + 0x12`, or tens at `x2` and ones at `x2 + 0x12`. */
    const num = (v: number, x1: number, x2: number, yy: number) => {
      let xx = x1
      if (Math.trunc(v / 10) > 0) {
        xx = x2
        this.digit(Math.trunc(v / 10), xx, yy)
      }
      this.digit(v % 10, xx + 0x12, yy)
      return xx
    }

    const ap = base[0] + eff[0], move = base[3] + eff[3], range = base[2] + eff[2]
    let y0 = y + 0x66
    if (kind !== 2) {
      this.underline(0x72, x + 0x20, y + 0x78)
      this.spr(ui, 0, 0, 0x28, 0x18, x + 0xc, y0) // HP
      const xx = num(base[1], x + 0x26, x + 0x38, y0)
      let xs = xx + 0x24
      this.digit(11, xs, y0) // '/'
      if (Math.trunc(card.hp / 10) > 0) {
        xs = xx + 0x36
        this.digit(Math.trunc(card.hp / 10), xs, y0)
      }
      this.digit(card.hp % 10, xs + 0x12, y0)
      if (kind !== 3 && st.showDf) {
        this.underline(0x3c, x + 0xbe, y + 0x78)
        this.spr(ui, 0x28, 0, 0x50, 0x18, x + 0xaa, y0) // DF
        num(eff[1], x + 0xc4, x + 0xd6, y0)
      }
      y0 = y + 0x84
    }
    if (kind !== 2 && kind !== 3) {
      this.underline(0x3c, x + 0x20, y0 + 0x12)
      this.spr(ui, 0x50, 0, 0x78, 0x18, x + 0xc, y0) // AP
      num(ap, x + 0x26, x + 0x38, y0)
      this.underline(0x3c, x + 0xc6, y0 + 0x12)
      this.spr(ui, 0xa8, 0, 0xd8, 0x18, x + 0xaa, y0) // Move
      num(move, x + 0xca, x + 0xdc, y0)
      y0 += 0x1e
    }
    if (kind === 3) {
      this.underline(0x3c, x + 0x28, y0 + 0x12)
      this.spr(ui, 0x78, 0, 0xa8, 0x18, x + 0xc, y0) // Range
      num(range, x + 0x2e, x + 0x40, y0)
      y0 += 0x1e
    }
    this.underline(card.soul < 1 ? 0x40 : 0x8e, x + 0x38, y0 + 0x12)
    this.spr(ui, 0, 0x18, 0x40, 0x30, x + 0xc, y0) // Cost
    const xc = num(card.cost, x + 0x3e, x + 0x50, y0)
    if (card.soul > 0) {
      this.soulIcon(xc + 0x36, y0, clock)
      num(card.soul, xc + 0x40, xc + 0x52, y0)
    }
    let yy = y0 + 0x1e
    if (kind !== 2) {
      this.underline(0x40, x + 0x65, y0 + 0x30)
      this.spr(ui, 0x40, 0x18, 0xad, 0x30, x + 0xc, yy) // Keep cost
      num(card.maintenance, x + 0x6b, x + 0x7d, yy)
      yy = y0 + 0x3c
    }
    if (kind === 2 || kind === 3) {
      this.spr(ui, 0xc0, 0x48, 0xfc, 0x5d, x + 0xc, yy) // Effect
      let xe = x + 0x4c
      if (kind === 2) {
        if (card.abilities[0] !== 0) {
          this.spr(ui, 200, 0x6e, 0x100, 0x84, xe, yy) // Battle
          xe = x + 0x88
        }
        if (card.abilities[1] !== 0) this.spr(ui, 200, 0x84, 0x100, 0x9a, xe, yy) // Enchant
      }
      this.text(this.db.raw.cardStrings.get(card.id)?.text ?? card.text, x + 10, yy + 0x18, 0x15, 0x15)
    } else {
      this.spr(ui, 0x50, 0x48, 0xb6, 0x5d, x + 0xc, yy) // Skill
      yy += 0x16
      for (let i = 0; i < 3; i++) {
        const { ab, name } = this.ability(card.abilities[i])
        if (!ab || ab.id < 1) {
          if (i === 0) this.text('No powers ', x + 0x44, yy + 10, 0x16, 0x16)
        } else {
          this.icon(ab.category & 0xff, x + 0x24, yy)
          this.text(name, x + 0x4c, yy + 10, 0x16, 0x16, ab.active ? 3 : 0)
        }
        yy += 0x20
      }
    }
  }

  /** cardDrawAbilityList 0x088210C0 (units and Dominators only): name, cost line, description. */
  private drawAbilityList(card: Card, clock: CardScreenClock, x: number, y: number) {
    const kind = card.id === 0 ? -1 : Math.trunc(card.id / 1000)
    if (kind !== 0 && kind !== 1) return
    const ui = this.assets.ui
    let yy = y + 0x4e
    for (let i = 0; i < 3; i++) {
      const { ab, name, description } = this.ability(card.abilities[i])
      const id = ab?.id ?? 0
      if (i === 0 && id === 0) this.text(name, x + 0x10, yy, 0x16, 0x16)
      else if (ab && id > 0) {
        this.text(name, x + 6, yy, 0x16, 0x16, ab.active ? 3 : 0)
        this.text(description, x + 0xd, yy + 0x16, 0x15, 0x15)
        let cost = ab.useCost, soul = ab.useSoul
        if (soul !== 0 || cost !== 0) {
          const xc = x + 0x10 + (name.length >> 1) * 0x12 + 8
          if (cost < 0) {
            cost = card.cost
            soul = card.soul
          }
          let w = cost < 10 ? 0x16 : 0x28
          if (soul > 0) w += cost < 10 ? 0x2e : 0x40
          this.underline(w + 0x14, xc + 0x2c, yy + 0x10)
          this.spr(ui, 0, 0x18, 0x40, 0x30, xc, yy - 2) // Cost
          let xd = xc + 0x44
          if (Math.trunc(cost / 10) > 0) {
            this.digit(Math.trunc(cost / 10), xd, yy - 2)
            xd = xc + 0x56
          }
          this.digit(cost % 10, xd, yy - 2)
          if (soul > 0) {
            this.soulIcon(xd + 0x16, yy - 2, clock)
            let xs = xd + 0x2e
            if (Math.trunc(soul / 10) > 0) {
              this.digit(Math.trunc(soul / 10), xs, yy - 2)
              xs = xd + 0x40
            }
            this.digit(soul % 10, xs, yy - 2)
          }
        }
      }
      yy += 0x56
    }
  }

  /** cardInfoDrawAttachments 0x08820EC0: 3×2 grid at 0.7, the hand on the cursor slot, name and text. */
  private drawAttachments(st: CardScreenState, clock: CardScreenClock, x: number, y: number) {
    let xx = x + 0x10, yy = y + 0x50
    let hx = 0, hy = 0
    for (let i = 0; i < 6; i++) {
      if (i === 3) xx = x + 0x10
      if (i > 2) yy = y + 0x98
      const img = this.assets.attachments[i] ?? null
      if (img) this.spr(img, 0, 0, img.width, img.height, xx, yy, { scaleX: 0.7, scaleY: 0.7 })
      if (st.cursor === i) {
        hx = xx
        hy = yy
      }
      xx += 0x40
    }
    if (st.cursor < 0) return
    // uiDrawPointerHand(x + 0x1C, y, 0, 0, 0, 135°): etc.one 2/2, 48×32 frame, centre pivot.
    const f = clock.handFrame
    const u = this.tables.hand.u[f] ?? 0, v = this.tables.hand.v[f] ?? 0
    this.spr(this.assets.hand, u, v, u + 0x30, v + 0x20, hx + 0x1c, hy, { pivotX: 0x18, pivotY: 0x10, rot: (135 * 3.1415927) / 180 })
    const id = st.attachments[st.cursor]
    if (id) {
      const s = this.db.raw.cardStrings.get(id)
      if (s) {
        this.text(s.name, x + 6, yy + 0x50, 0x16, 0x16)
        this.text(s.text, x + 0xe, yy + 0x68, 0x14, 0x14)
      }
    }
  }
}
