/**
 * The deck editor (deckEditScene 0x0882ADB8, scene 0x140) and the card list (cardListScene 0x0882C4FC,
 * scene 0x14A) as the game runs and draws them: the per-frame state machine is transcribed into
 * `DeckEditorSim.frame` (one call = one game frame, pad bits as the game reads them), and
 * `DeckEditorRenderer` draws what the scene draws after its logic: deckDrawFrame, deckDrawDeckGrid /
 * deckDrawCardGrid, menuWinUpdateAll (via WindowPainter), cardDrawStatPanel and deckDrawTypeCounts.
 * The card info viewer on top (states 6/7, cardInfoDrawCard) is drawn by CardScreenRenderer.
 *
 * Coordinates are the game's 640×448 virtual space. Sprites follow spriteUpdateVertices/spriteDraw2D:
 * vertex = pos + pivot + trunc(R·S·(corner − pivot)), then x·480/640, y·272/448 truncated. The GE
 * filters bilinearly (sceGuTexFilter(1, 1) in guInitDisplay), so the GL renderer keeps `smooth`.
 * See docs/formats/deck-editor.md.
 */
import { glyphPixels, sjisToGlyph } from '../formats/font'
import type { GameDb } from '../formats/gamedb'
import type { RgbaImage } from '../formats/palette'
import { fontCodes, FONT_NEWLINE } from './cardScreen'
import type { GlRenderer, Vertex } from './gl'
import { asciiMarkup, layoutText, WF_CENTER_X, WF_CENTER_Y, type DuelWindow, type WindowPainter } from './windows'
import { buttonZones, textButtonZones, type ButtonZone } from './buttonZones'

// ---------------------------------------------------------------------------------------------
// pad bits (padGetPressed / padGetRepeat)

export const PAD = {
  SELECT: 0x1,
  START: 0x8,
  UP: 0x10,
  RIGHT: 0x20,
  DOWN: 0x40,
  LEFT: 0x80,
  L: 0x100,
  R: 0x200,
  TRIANGLE: 0x1000,
  CIRCLE: 0x2000,
  CROSS: 0x4000,
  SQUARE: 0x8000,
} as const

/** The `mode` argument of the shared draw functions: 0x140 deck editor, 0x14A card list (the scene ids). */
export const MODE_DECK = 0x140
export const MODE_LIST = 0x14a

/** Card numbers (cardIndexToId order): units 1–122, spells 123–190, bases 191–206. */
export const CARD_NOS = 206
/** g_deckEditCards: [0] unused (Dominator slot), 1..42 = 7 rows × 6. */
const DECK_SLOTS = 43

// ---------------------------------------------------------------------------------------------
// tables and strings read from BOOT.BIN

const ADDR = {
  typeLabelUV: 0x088b831c, // g_deckTypeLabelUV: u8 [4][2] (entries 1..3 used: Unit, Spell, Base)
  filterLabelUV: 0x088b8548, // g_deckFilterLabelUV: u8 [4][2] (All, Unit, Spell, Base)
  attrStrings: 0x088b8398, // g_attributeIconStrings: char *[13] ("＠ｍNN")
  handFrames: 0x088b8664, // uiDrawPointerHand: u8 u[6] at +0, v[6] at +8
  digitCells: 0x088b9f94, // uiDrawDigit cell table
  helpConfirm: 0x088b83dc,
  helpChangeView: 0x088b83ec,
  helpDetails: 0x088b8400,
  helpEnd: 0x088b8414,
  helpListDetails: 0x088b8420,
  helpToCamp: 0x088b843c,
  helpChange: 0x088b844c,
  helpDecide: 0x088b8464,
  helpCancel: 0x088b8474,
  detail1Unit0: 0x088b8484,
  detail1Unit1: 0x088b849c,
  detail1Other: 0x088b84b0,
  detail4Unit0: 0x088b84cc,
  detail4Unit1: 0x088b84e4,
  detail4Other: 0x088b84fc,
  detail8a: 0x088b851c,
  detail8b: 0x088b8530,
  msgTooMany: 0x088b8564, // "%d cards will fit into the deck. "
  msgTooFew: 0x088b8588, // "Please prepare %d cards for the deck. "
  msgPrompt: 0x088b85b0, // "What would you like to do with the edits to the deck? …"
  msgHelp: 0x088b8644, // "＠ｂ０Confirm ＠ｂ１End "
}

type UV = [number, number]

export interface DeckEditorTables {
  typeLabelUV: UV[]
  filterLabelUV: UV[]
  attrStrings: Uint8Array[]
  hand: { u: number[]; v: number[] }
  digit: { u0: number; v0: number; w: number; h: number }
  str: Record<keyof typeof ADDR, Uint8Array>
}

function cstrAt(db: GameDb, vaddr: number, max = 256): Uint8Array {
  const b = db.raw.bytes(vaddr, max)
  const end = b.indexOf(0)
  return end < 0 ? b : b.slice(0, end)
}

/** sprintf(fmt, 30) for the two "%d" messages. */
function fmt30(b: Uint8Array): Uint8Array {
  const s = Array.from(b, (c) => String.fromCharCode(c)).join('').replace('%d', '30')
  return Uint8Array.from(s, (c) => c.charCodeAt(0))
}

export function readDeckEditorTables(db: GameDb): DeckEditorTables {
  const uv = (a: number): UV[] => {
    const b = db.raw.bytes(a, 8)
    return [0, 1, 2, 3].map((i) => [b[i * 2] ?? 0, b[i * 2 + 1] ?? 0])
  }
  const p = db.raw.bytes(ADDR.attrStrings, 13 * 4)
  const attrStrings: Uint8Array[] = []
  for (let i = 0; i < 13; i++) {
    const ptr = ((p[i * 4] ?? 0) | ((p[i * 4 + 1] ?? 0) << 8) | ((p[i * 4 + 2] ?? 0) << 16) | ((p[i * 4 + 3] ?? 0) << 24)) >>> 0
    attrStrings.push(ptr ? cstrAt(db, ptr, 32) : asciiMarkup(`@m${i}`))
  }
  const hf = db.raw.bytes(ADDR.handFrames, 14)
  const dc = db.raw.bytes(ADDR.digitCells, 12)
  const str = {} as Record<keyof typeof ADDR, Uint8Array>
  for (const k of Object.keys(ADDR) as (keyof typeof ADDR)[]) str[k] = cstrAt(db, ADDR[k])
  str.msgTooMany = fmt30(str.msgTooMany)
  str.msgTooFew = fmt30(str.msgTooFew)
  return {
    typeLabelUV: uv(ADDR.typeLabelUV),
    filterLabelUV: uv(ADDR.filterLabelUV),
    attrStrings,
    hand: { u: Array.from(hf.subarray(0, 6)), v: Array.from(hf.subarray(8, 14)) },
    digit: { u0: dc[0] ?? 0, v0: dc[1] ?? 40, w: dc[4] ?? 18, h: dc[5] ?? 24 },
    str,
  }
}

// ---------------------------------------------------------------------------------------------
// uiAnimCounter (0x08848E7C; mode 0 runs once per frame)

export class UiClock {
  private c1 = 0
  private d1 = 1
  private c2 = 0
  private c3 = 0
  private c4 = 0
  angle = 0
  private c6 = 0
  private d6 = 1
  private c7 = 0

  /** uiAnimCounter(0). */
  tick() {
    this.c1 += this.d1
    if (this.c1 > 20) this.d1 = -1
    if (this.c1 < 0) this.d1 = 1
    this.c2 = (this.c2 + 1) & 0xffff
    if (this.c2 >> 2 > 5) this.c2 = 0
    this.c3 = (this.c3 + 1) & 0xff
    if (this.c3 >> 3 > 7) this.c3 = 0
    this.c4 = (this.c4 + 1) & 0xff
    if (this.c4 >> 2 > 5) this.c4 = 0
    let a = this.angle + 1
    if (a > 180) a = this.angle - 359
    this.angle = a < -180 ? a + 360 : a
    this.c6 += this.d6
    if (this.c6 > 12) this.d6 = -1
    if (this.c6 < -12) this.d6 = 1
    this.c7 = (this.c7 + 1) & 0xff
    if (this.c7 & 0x20) this.c7 = 0
  }

  /** Mode 1: 0..21 bouncing (the NEW badge pulse); −1 at the turn, which the byte add wraps back to pct − 1. */
  get m1() {
    return this.c1
  }
  /** Mode 2: pointer hand frame 0..5 (4 vblanks each). */
  get m2() {
    return this.c2 >> 2
  }
  /** Mode 6: −6..6 (side arrows). */
  get m6() {
    return this.c6 === 0 ? 0 : Math.trunc(this.c6 / 2)
  }
  /** Mode 7: 0/1 every 16 frames (the blinking □ button). */
  get m7() {
    return this.c7 & 0x10 ? 1 : 0
  }
}

// ---------------------------------------------------------------------------------------------
// the scene logic

export interface DeckData {
  name: string
  /** The char[24] bytes of a name entered with the keyboard (Play mode). */
  nameRaw?: Uint8Array
  dominator: number
  /** 30 card ids (0 = empty). */
  cards: number[]
}

export interface Collection {
  /** PlayerProfile.cardCount by card number (index 0 unused). */
  owned: number[]
  /** PlayerProfile.cardNewFlags by card number: bit 1 → "New" badge, bit 0 → "Get" badge. */
  newFlags: number[]
  /** g_playerDecks (3). */
  decks: DeckData[]
  /** PlayerProfile.curDeckSlot 1..3. */
  slot: number
}

type WinKey = 'msg' | 'typeCount' | 'help' | 'menu' | 'info'

/** winPrintAt(win, x, y, fontW, fontH, colour, text): glyphs laid out at once with fade step 0x7F. */
export interface WinPrint {
  x: number
  y: number
  size: number
  line: number
  color: number
  text: Uint8Array
  /** Frame it was printed (the glyph fade starts there). */
  at: number
}

export interface SimWindow {
  key: WinKey
  x: number
  y: number
  w: number
  h: number
  chamfer: number
  style: number
  tailIdx: number
  flags: number
  /** winOpenMessage text (typeDelay 0: all at once, fade step 4). */
  text?: Uint8Array
  glyph?: number
  opened: number
  prints: WinPrint[]
}

export type SimEvent = 'saved' | 'exit' | 'nameEntry'

export class DeckEditorSim {
  readonly mode: number
  private db: GameDb
  private tables: DeckEditorTables
  col: Collection
  /** Card number → id and back (cardIndexToId / cardIdToIndex). */
  readonly noToId: number[] = new Array(CARD_NOS + 1).fill(0)
  private idToNo = new Map<number, number>()

  state = 0
  view = 0
  filter = 0
  cursorCol = 0
  cursorRow = 0
  pickCount = 0
  nextSlot = 0
  deckCards = new Int16Array(DECK_SLOTS)
  counts = new Uint8Array(CARD_NOS + 1)
  deckGridScroll = 0
  cardGridScroll = 0
  private helpCardId = 0
  private helpDetailPage = 0
  private helpCardCount = 0
  frameNo = 0

  // cardInfoUpdate state (mode 3)
  infoState = 0
  infoTab = 0
  private infoCardId = 0

  /** Open windows in g_winListHead order (drawn in this order). */
  windows: SimWindow[] = []
  private winStore = new Map<WinKey, SimWindow>()

  /** Card at the cursor as the draw calls of this frame see it (unaff_s4 after the switch). */
  shownCard = 0
  /** Card the name/ability windows were filled with (s4 before the switch). */
  events: SimEvent[] = []
  /** sndPlaySeUi ids of this frame's calls, in order (the view plays them). */
  se: number[] = []
  /**
   * Play mode runs the game's name-entry keyboard for a new deck (state 9, nameEntryUpdate(1)) and
   * answers with `nameEntered`; the viewer (false) names the deck "Deck N" at once.
   */
  externalNameEntry = false

  constructor(db: GameDb, tables: DeckEditorTables, col: Collection, mode: number) {
    this.db = db
    this.tables = tables
    this.col = col
    this.mode = mode
    for (const c of db.cards) {
      if (c.no >= 1 && c.no <= CARD_NOS) this.noToId[c.no] = c.id
      this.idToNo.set(c.id, c.no)
    }
  }

  /** State 9 (nameEntryUpdate(1)): 1 with the entered name → state 10 (save); −1 (null) → back to the grid of the view. */
  nameEntered(name: string | null, raw?: Uint8Array) {
    if (this.state !== 9) return
    if (name === null) this.state = this.view === 2 ? 4 : 2
    else {
      this.col.decks[this.slot - 1] = { ...this.deck, name, nameRaw: raw }
      this.state = 10
    }
  }

  idx(id: number) {
    return this.idToNo.get(id) ?? 0
  }
  owned(no: number) {
    return this.col.owned[no] ?? 0
  }
  newFlag(no: number) {
    return this.col.newFlags[no] ?? 0
  }
  get slot() {
    return Math.min(3, Math.max(1, this.col.slot || 1))
  }
  get deck(): DeckData {
    return this.col.decks[this.slot - 1] ?? { name: '', dominator: 1001, cards: [] }
  }

  // ---- windows (winOpenFrame / winOpenMessage / winClose / winFreeGlyphs / winPrintAt) ----

  win(key: WinKey): SimWindow {
    let w = this.winStore.get(key)
    if (!w) {
      w = { key, x: 0, y: 0, w: 0, h: 0, chamfer: 16, style: 10, tailIdx: 0, flags: 0, opened: 0, prints: [] }
      this.winStore.set(key, w)
    }
    return w
  }
  isOpen(key: WinKey) {
    return this.windows.includes(this.win(key))
  }
  winClose(key: WinKey) {
    const w = this.win(key)
    const i = this.windows.indexOf(w)
    if (i >= 0) {
      this.windows.splice(i, 1)
      w.prints = []
      w.text = undefined
    }
  }
  private winOpenFrame(key: WinKey, x: number, y: number, w: number, h: number, chamfer: number, style: number) {
    this.winClose(key)
    const win = this.win(key)
    Object.assign(win, { x, y, w, h, chamfer, style, flags: 0, text: undefined, glyph: undefined, opened: this.frameNo, prints: [] })
    this.windows.push(win)
    return win
  }
  /** winOpenMessage with typeDelay 0 (parsed at once) and the auto-size flags 0x1000/0x2000. */
  private winOpenMessage(key: WinKey, x: number, y: number, glyph: number, text: Uint8Array, flags: number) {
    this.winClose(key)
    const win = this.win(key)
    const lay = layoutText(text, { glyph })
    Object.assign(win, {
      x, y, w: flags & 0x1000 ? lay.autoW : 0, h: flags & 0x2000 ? lay.autoH : 0, chamfer: 5, style: 7,
      flags: flags & 0xc000, text, glyph, opened: this.frameNo, prints: [],
    })
    this.windows.push(win)
    return win
  }
  private print(key: WinKey, x: number, y: number, size: number, line: number, color: number, text: Uint8Array) {
    this.win(key).prints.push({ x, y, size, line, color, text, at: this.frameNo })
  }

  // ---- deck list helpers ----

  /** deckEditLoadDeck: counts and the deck list from g_playerDecks[slot − 1]. */
  private loadDeck() {
    this.counts.fill(0)
    this.deckCards.fill(0)
    const cards = this.deck.cards
    for (let i = 1; i <= 30; i++) {
      const id = cards[i - 1] ?? 0
      this.deckCards[i] = id
      if (id > 0) this.counts[this.idx(id)]++
    }
  }

  /** deckEditRebuildList: the list sorted by card number from the counts; returns count + 1. */
  rebuildList(): number {
    this.deckCards.fill(0)
    let n = 1
    for (let no = 1; no <= CARD_NOS; no++) for (let k = 0; k < this.counts[no]; k++) this.deckCards[n++ & 0xff] = this.noToId[no]
    this.counts.fill(0)
    for (let i = 1; i < DECK_SLOTS; i++) if (this.deckCards[i] > 0) this.counts[this.idx(this.deckCards[i])]++
    return n & 0xff
  }

  /** deckEditSaveDeck: writes the cards in card-number order back into the slot. */
  private saveDeck() {
    const cards: number[] = []
    for (let no = 1; no <= CARD_NOS; no++) for (let k = 0; k < this.counts[no]; k++) cards.push(this.noToId[no])
    const old = this.deck
    const kept = old.cards.slice(cards.length)
    this.col.decks[this.slot - 1] = { ...old, cards: [...cards, ...kept].slice(0, 30) }
    this.counts.fill(0)
  }

  /** Total copies in the edited deck (state 8 counts 1 + all copies). */
  deckTotal() {
    let n = 0
    for (let i = 1; i <= CARD_NOS; i++) n += this.counts[i]
    return n
  }

  /** The edited deck as card ids in card-number order (for export). */
  editedCards(): number[] {
    const out: number[] = []
    for (let i = 1; i < DECK_SLOTS; i++) if (this.deckCards[i] > 0) out.push(this.deckCards[i])
    return out
  }

  /** deckGridPosToCardNo(pos, filter, mode). */
  gridPosToCardNo(pos: number, filter: number, mode = this.mode): number {
    if (mode !== MODE_DECK) return filter === 3 ? pos + 0xbf : filter === 2 ? pos + 0x7b : pos + 1
    let first = 1, last = 0xce
    if (filter === 3) first = 0xbf
    else if (filter === 2) {
      first = 0x7b
      last = 0xbe
    } else if (filter === 1) last = 0x7a
    let no = first, visible = 0
    for (; no <= last; no++) {
      if (this.owned(no) !== 0) {
        if (pos === visible) break
        visible++
      }
    }
    return no >= last + 1 ? 0 : no
  }

  // ---- shared per-frame calls ----

  /** deckUpdateHelpWin(cardId, mode, state, detailPage) 0x08829098. */
  private updateHelpWin(cardId: number, state: number, detailPage: number) {
    const s = this.tables.str
    const idx = this.idx(cardId)
    if (!this.isOpen('help')) {
      if (state === 4 || state === 2 || state === 0) {
        if (state === 0) {
          this.helpCardId = 0
          this.helpCardCount = 0
          this.helpDetailPage = 0
        }
        const w = this.winOpenFrame('help', 0, 0, 277, 68, 16, 10)
        w.x = 640 - w.w
        w.tailIdx = 4
        w.y = 448 - w.h
      }
    }
    const help = this.win('help')
    if (state === 7) {
      if (cardId === this.helpCardId && detailPage === this.helpDetailPage) return
      help.prints = []
      this.helpCardCount = this.counts[idx]
      this.helpDetailPage = detailPage
      this.helpCardId = cardId
      if (detailPage === 8) {
        this.print('help', 0, 0, 18, 18, 0, s.detail8a)
        this.print('help', 0, 0x13, 18, 18, 0, s.detail8b)
      } else if (detailPage === 4) {
        if (cardId < 2000) {
          this.print('help', 0, 0, 18, 18, 0, s.detail4Unit0)
          this.print('help', 0, 0x13, 18, 18, 0, s.detail4Unit1)
        } else this.print('help', 0, 0, 18, 18, 0, s.detail4Other)
      } else if (detailPage === 1) {
        if (cardId < 2000) {
          this.print('help', 0, 0, 18, 18, 0, s.detail1Unit0)
          this.print('help', 0, 0x13, 18, 18, 0, s.detail1Unit1)
        } else this.print('help', 0, 0, 18, 18, 0, s.detail1Other)
      }
    } else if (state === 5 || state === 3) {
      if (this.helpCardCount === this.counts[idx] && cardId === this.helpCardId) return
      help.prints = []
      this.helpCardCount = this.counts[idx]
      this.helpCardId = cardId
      this.print('help', 0, 0, 18, 18, 0, s.helpChange)
      this.print('help', 0x85, 0, 18, 18, 0, s.helpDecide)
      this.print('help', 0x85, 0x13, 18, 18, 0, s.helpCancel)
    } else if (state === 4 || state === 2) {
      this.helpCardId = 0
      help.prints = []
      if (this.mode === MODE_DECK) {
        this.print('help', 0, 0, 18, 18, 0, s.helpConfirm)
        this.print('help', 0x72, 0x13, 18, 18, 0, s.helpChangeView)
        this.print('help', 0x72, 0, 18, 18, 0, s.helpDetails)
        this.print('help', 0, 0x13, 18, 18, 0, s.helpEnd)
      } else {
        this.print('help', 0, 0, 18, 18, 0, s.helpListDetails)
        this.print('help', 0, 0x13, 18, 18, 0, s.helpToCamp)
      }
    }
  }

  /** The type-count window: closed in states 6/7/9, opened (246×68, left of the help window) in views 1–3. */
  private updateTypeCountWin(state: number, view: number) {
    const v = view & 0xf
    if (state === 9 || state === 7 || state === 6) this.winClose('typeCount')
    else if (!this.isOpen('typeCount') && (v === 3 || v === 2 || v === 1)) {
      const w = this.winOpenFrame('typeCount', 0, 0, 246, 68, 16, 10)
      w.x = this.win('help').x - w.w
      w.y = 448 - w.h
    }
  }

  /** cardDrawNameAbilityWindow 0x088288F0: name + attribute icon, and the three ability names. */
  private nameAbilityWindow(cardId: number, state: number) {
    if (state === 9 || state === 7 || state === 6) {
      this.winClose('info')
      this.winClose('menu')
      return
    }
    if (!this.isOpen('info')) {
      const w = this.winOpenFrame('info', 0, 0, 0, 0, 16, 10)
      w.w = 434
      w.h = 95
      w.tailIdx = 0
      w.y = 285
    }
    const info = this.win('info')
    if (!this.isOpen('menu')) this.winOpenFrame('menu', info.x + info.w, info.y, 640 - info.w, info.h, 16, 10)
    info.prints = []
    this.win('menu').prints = []
    if (cardId === 0 || this.owned(this.idx(cardId)) === 0) return
    const card = this.db.byId.get(cardId)
    const strs = this.db.raw.cardStrings.get(cardId)
    this.print('info', 0, 0, 20, 20, 0, strs?.name ?? new Uint8Array(0))
    const attr = card?.attribute ?? -1
    if (attr >= 0 && attr < 13) this.print('info', 0xfc, 0, 16, 16, 0, this.tables.attrStrings[attr])
    if (cardId < 2000 && card) {
      let y = 0
      for (let i = 0; i < 3; i++) {
        const ab = this.db.abilities.get(card.abilities[i]) ?? this.db.abilities.get(0)
        const id = ab?.id ?? 0
        if (i > 0 && id === 0) return
        const name = this.db.raw.abilityStrings.get(id)?.name ?? new Uint8Array(0)
        this.print('menu', 0, y, 20, 22, ab?.active ? 3 : 0, name)
        y += 22
      }
    }
  }

  /** cardInfoUpdate(cardId, 3) 0x08821714: 0 while loading, 1 open, −1 closed. */
  private cardInfoUpdate(cardId: number, pressed: number): number {
    const allowed = cardId < 2000 ? 0xd : 5
    if (cardId !== this.infoCardId) {
      this.infoState = 0
      this.infoCardId = cardId
    }
    if (this.infoState === 4) {
      this.infoTab = 0
      this.infoCardId = 0
      this.infoState = 0
      return -1
    }
    if (this.infoState === 2) {
      if (this.infoTab === 0) this.infoTab = 1
      if (pressed & PAD.CIRCLE) {
        this.se.push(9)
        this.infoState = 4
        return 1
      }
      const dir = pressed & PAD.LEFT ? -1 : pressed & PAD.RIGHT ? 1 : 0
      if (dir) this.se.push(1) // allowedTabs is never 1 here
      let t = this.infoTab
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
      this.infoTab = t
      return 1
    }
    if (this.infoState === 1) {
      if (this.infoTab === 0) this.infoTab = 1
      this.infoState = 2
      return 0
    }
    if (this.infoState === 0) {
      this.infoState = 1
      return 0
    }
    return 1
  }

  // ---- one game frame ----

  frame(pressed: number, repeat: number) {
    this.frameNo++
    this.events = []
    this.se = []
    if (this.mode === MODE_DECK) this.deckFrame(pressed, repeat)
    else this.listFrame(pressed, repeat)
  }

  /** deckEditScene 0x0882ADB8. */
  private deckFrame(pressed: number, repeat: number) {
    let s3 = 0, s4 = 0, s5 = 0
    if (this.view === 0) {
      this.filter = 0
    } else if (this.view === 1) {
      this.filter = 0
      s3 = this.cursorCol + this.cursorRow * 6 + 1
      s4 = this.deckCards[s3]
    } else {
      s3 = this.gridPosToCardNo(this.cursorCol + this.cursorRow * 10, this.filter)
      s4 = this.noToId[s3] ?? 0
      s5 = this.filter === 1 ? 0x7a : this.filter === 2 ? 0x44 : this.filter === 3 ? 0x10 : 0xce
    }
    this.updateHelpWin(s4, this.state, this.infoTab)
    this.updateTypeCountWin(this.state, this.view)
    this.nameAbilityWindow(s4, this.state)
    const toGrid = () => (this.state = this.view === 1 ? 2 : 4)

    switch (this.state) {
      case 0:
        this.loadDeck()
        this.cursorRow = 0
        this.cursorCol = 0
        this.filter = 0
        this.view = 0
        s4 = 0
        this.rebuildList()
        this.state = 1
        break
      case 1:
        this.state = 2
        break
      case 2: {
        this.view = 1
        if (repeat & PAD.RIGHT) {
          this.cursorCol = this.cursorCol < 5 ? this.cursorCol + 1 : 0
          this.se.push(1)
          break
        }
        if (repeat & PAD.LEFT) {
          this.cursorCol = this.cursorCol < 1 ? 5 : this.cursorCol - 1
          this.se.push(1)
          break
        }
        if (repeat & PAD.DOWN) {
          if ((this.cursorRow + 2) * 6 < 0x2b) {
            this.cursorRow++
            this.se.push(1)
            break
          }
        } else if (repeat & PAD.UP && this.cursorRow > 0) {
          this.cursorRow--
          this.se.push(1)
          break
        }
        const at = this.cursorCol + this.cursorRow * 6 + 1
        s4 = this.deckCards[at]
        if (pressed & PAD.CROSS) {
          if (s4 >= 1) {
            this.state = 3
            this.pickCount = this.counts[this.idx(s4)]
            this.se.push(7)
          } else this.se.push(10)
        } else if (pressed & PAD.TRIANGLE) {
          if (this.deckCards[at] !== 0) {
            this.state = 6
            this.se.push(8)
          } else this.se.push(10)
        } else if (pressed & PAD.SQUARE) {
          this.nextSlot = this.rebuildList()
          this.cursorRow = 0
          this.cursorCol = 0
          this.view = 4
          this.se.push(5)
          this.state = 4
        } else if (pressed & PAD.CIRCLE) {
          this.winClose('help')
          this.se.push(8)
          this.state = 8
        } else if (pressed & PAD.SELECT) this.nextSlot = this.rebuildList()
        break
      }
      case 3: {
        s4 = this.deckCards[this.cursorCol + this.cursorRow * 6 + 1]
        const i = this.idx(s4)
        if (pressed & PAD.UP) {
          const p = this.pickCount
          if (p < 3 && p < this.owned(i) && p + (this.nextSlot - this.counts[i]) < 0x2b) {
            this.pickCount++
            this.se.push(1)
          }
        } else if (pressed & PAD.DOWN) {
          if (this.pickCount !== 0) {
            this.pickCount--
            this.se.push(1)
          }
        } else if (pressed & PAD.CROSS) {
          this.counts[i] = this.pickCount
          this.nextSlot = this.rebuildList()
          this.se.push(7)
          this.state = 2
        } else if (pressed & PAD.CIRCLE) {
          this.se.push(9)
          this.state = 2
        }
        break
      }
      case 4: {
        this.view = 2
        let base = 0
        if (this.filter !== 1) {
          if (this.filter === 2) base = 0x7a
          else if (this.filter === 3) base = 0xbe
          s5 += base
        }
        let n = 0
        for (let no = base + 1; no <= s5; no++) if (this.owned(no) !== 0) n++
        const oldCol = this.cursorCol, oldRow = this.cursorRow
        let dc = repeat & PAD.LEFT ? -1 : repeat & PAD.RIGHT ? 1 : 0
        let dr = repeat & PAD.UP ? -1 : repeat & PAD.DOWN ? 1 : 0
        if (dc !== 0) {
          this.cursorCol += dc
          if (this.cursorCol > 9) this.cursorCol = 0
          if (this.cursorCol < 0) {
            this.cursorCol = 9
            if (n <= this.cursorRow * 10 + 9) this.cursorCol = (n % 10) - 1
          }
          if (n <= this.cursorCol + this.cursorRow * 10) this.cursorCol = 0
          if (oldCol + oldRow * 10 === this.cursorCol + this.cursorRow * 10) dc = 0
        }
        if (dr !== 0) {
          if (this.cursorRow + dr < 0) dr = 0
          if (Math.floor(Math.trunc((n + 9) / 10)) <= this.cursorRow + dr) dr = 0
          if (dr !== 0) {
            this.cursorRow += dr
            if (n <= this.cursorCol + this.cursorRow * 10) this.cursorCol = (n % 10) - 1
          }
        }
        if (dc === 0 && dr === 0) {
          const no = this.gridPosToCardNo(this.cursorCol + this.cursorRow * 10, this.filter)
          s4 = this.noToId[no] ?? 0
          if (pressed & PAD.L) {
            this.filter = this.filter === 0 ? 3 : this.filter - 1
            this.cursorRow = 0
            this.cursorCol = 0
            this.se.push(5)
          } else if (pressed & PAD.R) {
            this.filter = this.filter + 1 > 3 ? 0 : this.filter + 1
            this.cursorRow = 0
            this.cursorCol = 0
            this.se.push(5)
          } else if (pressed & PAD.CROSS) {
            if (this.owned(no) !== 0) {
              this.pickCount = this.counts[no]
              this.se.push(7)
              this.state = 5
            }
          } else if (pressed & PAD.TRIANGLE) {
            if (this.owned(no) !== 0) {
              this.se.push(8)
              this.state = 6
            }
          } else if (pressed & PAD.SQUARE) {
            this.nextSlot = this.rebuildList()
            this.cursorCol = 0
            this.cursorRow = 0
            this.view = 4
            this.se.push(5)
            this.state = 2
          } else if (pressed & PAD.CIRCLE) {
            this.winClose('help')
            this.se.push(8)
            this.state = 8
          }
        } else this.se.push(1)
        break
      }
      case 5: {
        if (pressed & PAD.UP) {
          const p = this.pickCount
          if (p < 3 && p < this.owned(s3) && p + (this.nextSlot - this.counts[s3]) < 0x2b) {
            this.se.push(1)
            this.pickCount++
          }
        } else if (pressed & PAD.DOWN) {
          if (this.pickCount !== 0) {
            this.se.push(1)
            this.pickCount--
          }
        } else if (pressed & PAD.CROSS) {
          this.counts[s3] = this.pickCount
          this.nextSlot = this.rebuildList()
          this.se.push(7)
          this.state = 4
        } else if (pressed & PAD.CIRCLE) {
          this.se.push(9)
          this.state = 4
        }
        break
      }
      case 6:
      case 7: {
        if (this.state === 6) this.state = 7
        const r = this.cardInfoUpdate(s4, pressed)
        if (r < 0) toGrid()
        else if (r > 0) this.detailStep(s4, pressed)
        break
      }
      case 8: {
        const total = 1 + this.deckTotal()
        if (!this.isOpen('msg')) {
          const s = this.tables.str
          const text = total < 0x20 ? (total < 0x1f ? s.msgTooFew : s.msgPrompt) : s.msgTooMany
          const w = this.winOpenMessage('msg', 320, 224, 22, text, 0xf000)
          w.style = 10
          w.w += 10
          w.h += 10
        }
        if (total === 0x1f) {
          if (pressed & PAD.CROSS) {
            this.se.push(7)
            this.state = 10
          } else if (pressed & PAD.CIRCLE) {
            this.se.push(9)
            toGrid()
          } else if (pressed & PAD.TRIANGLE) {
            this.se.push(7)
            this.state = 11
          }
        } else {
          if (!this.isOpen('help')) {
            const w = this.winOpenMessage('help', 320, 250, 18, this.tables.str.msgHelp, 0x3000)
            w.style = 10
            w.w += 10
            w.h += 10
          }
          if (pressed & (PAD.CROSS | PAD.CIRCLE)) {
            this.se.push(9)
            toGrid()
          } else if (pressed & PAD.TRIANGLE) {
            this.se.push(7)
            this.state = 11
          }
        }
        if (this.state !== 8) {
          this.winClose('msg')
          this.winClose('help')
        }
        if (this.state === 10 && this.deck.name === '') {
          // nameEntryInit(&g_playerDecks[slot], ""): state 9 runs the keyboard (Play mode); the viewer skips it
          this.events.push('nameEntry')
          if (this.externalNameEntry) this.state = 9
          else this.col.decks[this.slot - 1] = { ...this.deck, name: `Deck ${this.slot}` }
        }
        break
      }
      case 10:
      case 11:
        if (this.state === 10) {
          this.saveDeck()
          this.events.push('saved')
        }
        for (const k of ['msg', 'typeCount', 'help', 'menu', 'info'] as WinKey[]) this.winClose(k)
        this.state = 0
        this.view = 0
        this.events.push('exit')
        break
    }
    this.shownCard = s4
  }

  /** States 6/7 after cardInfoUpdate returned 1: L/R step to the previous/next card. */
  private detailStep(s4: number, pressed: number) {
    let per: number
    if (this.view === 1) per = 6
    else if (this.view === 2) per = 10
    else return
    let pos = this.cursorCol + this.cursorRow * per
    const go = (p: number) => {
      this.cursorCol = p % per
      this.cursorRow = Math.trunc(p / per)
      this.se.push(5)
      this.state = 6
    }
    if (pressed & PAD.L) {
      if (pos === 0) return
      let found = false
      while (true) {
        pos--
        if (this.view === 1) {
          const c = this.deckCards[pos + 1]
          if (c > 0 && c !== s4) found = true
        } else found = true
        if (found || pos === 0) break
      }
      if (found) go(pos)
    } else if (pressed & PAD.R) {
      let found = false
      let next = pos + 1
      if (this.view === 1) {
        for (; ; pos++) {
          next = pos + 1
          if (pos + 2 > 0x2a) break
          const c = this.deckCards[pos + 2]
          if (c > 0 && c !== s4) {
            found = true
            break
          }
        }
      } else if (this.gridPosToCardNo(next, this.filter) > 0) found = true
      if (found) go(next)
    }
  }

  /** cardListScene 0x0882C4FC (its own state bytes at 0x089AFB10..14; filter always 0). */
  private listFrame(pressed: number, repeat: number) {
    const pos0 = this.cursorCol + this.cursorRow * 10
    const cardId = this.noToId[pos0 + 1] ?? 0
    this.updateHelpWin(cardId, this.state, this.infoTab)
    this.updateTypeCountWin(this.state, this.view)
    this.nameAbilityWindow(cardId, this.state)
    this.shownCard = cardId
    if (this.state === 0xb) {
      for (const k of ['msg', 'typeCount', 'help', 'menu', 'info'] as WinKey[]) this.winClose(k)
      this.state = 0
      this.view = 0
      this.events.push('exit')
      return
    }
    if (this.state === 6 || this.state === 7) {
      this.state = 7
      const r = this.cardInfoUpdate(cardId, pressed)
      if (r < 0) this.state = 4
      else if (r > 0) {
        let pos = pos0
        if (pressed & PAD.L) {
          if (pos !== 0) {
            let found = false
            while (true) {
              pos--
              if (this.owned(pos + 1) !== 0) found = true
              if (found || pos === 0) break
            }
            if (found) {
              this.cursorCol = pos % 10
              this.cursorRow = Math.trunc(pos / 10)
              this.se.push(5)
              this.state = 6
            }
          }
        } else if (pressed & PAD.R && pos < 0xce) {
          let found = false
          while (true) {
            pos++
            if (pos > 0xcd) break
            if (this.owned(pos + 1) !== 0) {
              found = true
              break
            }
          }
          if (found) {
            this.cursorCol = pos % 10
            this.cursorRow = Math.trunc(pos / 10)
            this.se.push(5)
            this.state = 6
          }
        }
      }
      return
    }
    if (this.state === 4) {
      const dc = repeat & PAD.LEFT ? -1 : repeat & PAD.RIGHT ? 1 : 0
      let dr = repeat & PAD.UP ? -1 : repeat & PAD.DOWN ? 1 : 0
      if (dc !== 0) {
        this.cursorCol += dc
        if (this.cursorCol > 9) this.cursorCol = 0
        if (this.cursorCol < 0) {
          this.cursorCol = 9
          if (this.cursorRow * 10 + 9 > 0xcd) this.cursorCol = 5
        }
        if (this.cursorCol + this.cursorRow * 10 > 0xcd) this.cursorCol = 0
      }
      if (dr !== 0) {
        if (this.cursorRow + dr < 0) dr = 0
        if (21 <= this.cursorRow + dr) dr = 0
        if (dr !== 0) {
          this.cursorRow += dr
          if (this.cursorCol + this.cursorRow * 10 > 0xcd) this.cursorCol = 5
        }
      }
      if (dc !== 0 || dr !== 0) this.se.push(1)
      if (dc === 0 && dr === 0) {
        if (pressed & (PAD.CROSS | PAD.TRIANGLE)) {
          if (this.owned(pos0 + 1) !== 0) {
            this.se.push(7)
            this.state = 6
          }
        } else if (pressed & PAD.CIRCLE) {
          this.se.push(9)
          this.state = 0xb
        }
      }
      return
    }
    if (this.state === 0) {
      this.cursorRow = 0
      this.cursorCol = 0
      this.view = 0
      this.state = 1
      return // fileQueueWaitOrPending(1): the loads it just queued are pending this frame
    }
    // state 1: the queue is empty, bgmPlay
    this.view = 3
    this.state = 4
  }
}

// ---------------------------------------------------------------------------------------------
// drawing

/** GE z 0x7FFF (2D-sorted context, depth 0): later draws win the GEQUAL test, i.e. code order. */
const Z = 0x7fff / 65535
const scrX = (v: number) => (Math.trunc((v * 480) / 640) * 640) / 480
const scrY = (v: number) => (Math.trunc((v * 272) / 448) * 448) / 272
/** spriteSetColor nibbles: rgb ((c·255) >> 11) & 15, alpha ((a·255) >> 7) >> 4. */
const sprRgb = (c: number) => ((((Math.trunc(c) * 255) >> 11) & 0xf) * 17) / 255
const sprAlpha = (a: number) => (((((Math.trunc(a) * 255) >> 7) >> 4) & 0xf) * 17) / 255
type Rgba = [number, number, number, number]
const col = (r: number, g: number, b: number, a: number): Rgba => [sprRgb(r), sprRgb(g), sprRgb(b), sprAlpha(a)]
const WHITE: Rgba = [1, 1, 1, 1]

interface SprOpts {
  sx?: number
  sy?: number
  px?: number
  py?: number
  rot?: number
  color?: Rgba
}

export interface DeckEditorAssets {
  /** etc.one 300/1 (deck editor) or 300/7 (card list): Sprite_0898b4e8. */
  frame: RgbaImage | null
  /** etc.one 300/5: the Deck / Album view tabs (Sprite_089af8fc). */
  tabs: RgbaImage | null
  /** etc.one 2/1: number font. */
  digits: RgbaImage | null
  /** etc.one 2/2: pointer hand. */
  hand: RgbaImage | null
  /** etc.one 2/3: New / Get badges (Sprite_089b51e8). */
  badge: RgbaImage | null
  /** etc.one 2/4: g_cardInfoUiSprite (stat labels, side arrows, soul icon). */
  ui: RgbaImage | null
  /** card.one 10000/<card id> (0 → 1000, the blank card): g_cardPicSprites (48×50). */
  cardPic: (id: number) => RgbaImage | null
  font: Uint8Array | null
  fontPalettes: [number, number, number][]
}

export class DeckEditorRenderer {
  private gl: GlRenderer | null = null
  private a: DeckEditorAssets
  private t: DeckEditorTables
  private painter: WindowPainter
  private glyphs = new Map<number, RgbaImage>()
  private printCache = new WeakMap<WinPrint, DuelWindow>()
  /** Play mode (ours): the help label under the mouse, drawn with the menu cursor's bar. */
  hover: (ButtonZone & { key: string }) | null = null

  constructor(assets: DeckEditorAssets, tables: DeckEditorTables, painter: WindowPainter) {
    this.a = assets
    this.t = tables
    this.painter = painter
  }

  /** One quad like spriteUpdateVertices + spriteDraw2D (alpha blend, colour per spriteSetColor). */
  private spr(img: RgbaImage | null, u0: number, v0: number, u1: number, v1: number, x: number, y: number, o: SprOpts = {}) {
    const gl = this.gl
    if (!gl || !img) return
    const w = u1 - u0, h = v1 - v0
    if (w <= 0 || h <= 0) return
    const sX = o.sx ?? 1, sY = o.sy ?? 1, px = o.px ?? 0, py = o.py ?? 0
    const c = Math.cos(o.rot ?? 0), s = Math.sin(o.rot ?? 0)
    const V = (cx: number, cy: number, u: number, v: number): Vertex => {
      let lx = (cx - px) * sX, ly = (cy - py) * sY
      if (o.rot) [lx, ly] = [lx * c - ly * s, lx * s + ly * c]
      return { x: scrX(x + px + Math.trunc(lx)), y: scrY(y + py + Math.trunc(ly)), w: 1, d: Z, u: u / img.width, v: v / img.height }
    }
    const A = V(0, 0, u0, v0), B = V(w, 0, u1, v0), C = V(0, h, u0, v1), D = V(w, h, u1, v1)
    gl.triangles(gl.texture(img), 'alpha', [A, B, C, B, D, C], o.color ?? WHITE)
  }

  /** uiDrawDigit(1, 1, d, x, y, 0, style 0, 0x80808080). */
  private digit(d: number, x: number, y: number) {
    if (d < 0 || d > 12) return
    const { u0, v0, w, h } = this.t.digit
    const u = u0 + d * w
    this.spr(this.a.digits, u, v0, u + w, v0 + h, x, y)
  }

  private glyph(code: number): RgbaImage | null {
    const font = this.a.font
    if (!font) return null
    const idx = sjisToGlyph(code)
    let img = this.glyphs.get(idx)
    if (!img) {
      const px = glyphPixels(font, idx, true)
      const rgba = new Uint8ClampedArray(16 * 16 * 4)
      for (let i = 0; i < 256; i++) if (px[i]) rgba.set([255, 255, 255, px[i] === 1 ? 255 : 63], i * 4)
      img = { width: 16, height: 16, rgba }
      this.glyphs.set(idx, img)
    }
    return img
  }

  /** fontDrawTextScaled 0x088390D4 (see cardScreen.ts): scale (size/18)·0.8 × line/18, advance trunc(16·sx − 5). */
  private text(raw: Uint8Array | string, x: number, y: number, size: number, line: number, pal = 0) {
    const gl = this.gl
    if (!gl) return
    const bytes = typeof raw === 'string' ? Uint8Array.from(raw, (ch) => ch.charCodeAt(0) & 0xff) : raw
    const codes = fontCodes(bytes)
    const scX = Math.fround((size / 18) * 0.8), scY = Math.fround(line / 18)
    const adv = Math.trunc(scX * 16 - 5)
    const hx = Math.trunc(8 * scX), hy = Math.trunc(8 * scY)
    const [r, g, b] = this.a.fontPalettes[pal & 15] ?? [255, 255, 255]
    let cx = x, cy = y
    for (const code of codes) {
      if (code === FONT_NEWLINE) {
        cx = x
        cy += line & 0xff
        continue
      }
      if (code !== 0x8140) {
        const img = this.glyph(code)
        if (img) {
          const X0 = scrX(cx + 8 - hx), X1 = scrX(cx + 8 + hx), Y0 = scrY(cy + 8 - hy), Y1 = scrY(cy + 8 + hy)
          const P = (px: number, py: number, u: number, v: number): Vertex => ({ x: px, y: py, w: 1, d: Z, u, v })
          const A = P(X0, Y0, 0, 0), B = P(X1, Y0, 1, 0), C = P(X0, Y1, 0, 1), D = P(X1, Y1, 1, 1)
          gl.triangles(gl.texture(img), 'alpha', [A, B, C, B, D, C], [r / 255, g / 255, b / 255, 1])
        }
      }
      cx += adv
    }
  }

  /** cardPicDrawScaled / cardPicDrawDimmed: anchor 9, scale · 80/width (a 48-px picture counts as 40). */
  private cardPic(cardId: number, x: number, y: number, scale: number, dim: boolean) {
    const id = (cardId >= 1000 && cardId <= 1999) || cardId === 0 ? 0 : cardId
    const img = this.a.cardPic(id)
    if (!img) return
    const w = img.width === 0x30 ? 0x28 : img.width
    const s = Math.fround(scale * Math.fround(80 / w))
    this.spr(img, 0, 0, img.width, img.height, x, y, { sx: s, sy: s, color: dim ? col(0x40, 0x40, 0x40, 0x80) : WHITE })
  }

  /** uiDrawNewBadge(x, y, 0, 70, 70, kind): 64×24 row `kind`, centre pivot, scale (70 + uiAnimCounter(1))/100. */
  private badge(x: number, y: number, kind: number, clock: UiClock) {
    const k = kind > 1 ? 1 : kind
    const pct = (70 + clock.m1) & 0xff
    const s = Math.fround(pct / 100)
    this.spr(this.a.badge, 0, k * 0x18, 0x40, k * 0x18 + 0x18, x, y, { sx: s, sy: s, px: 32, py: 12 })
  }

  private newBadge(no: number, sim: DeckEditorSim, x: number, y: number, clock: UiClock) {
    const f = sim.newFlag(no)
    const bx = Math.trunc(Math.fround(x + 28.0) - 32.0), by = Math.trunc(Math.fround(Math.fround(y + 64.4) - 24.0))
    if (f & 2) this.badge(bx, by, 0, clock)
    else if (f & 1) this.badge(bx, by, 1, clock)
  }

  /** uiDrawPointerHand(x, y, 0, 0, 0, rotZ): 48×32 frame uiAnimCounter(2), centre pivot. */
  private hand(x: number, y: number, rotDeg: number, clock: UiClock) {
    const f = clock.m2
    const u = this.t.hand.u[f] ?? 0, v = this.t.hand.v[f] ?? 0
    this.spr(this.a.hand, u, v, u + 0x30, v + 0x20, x, y, { px: 0x18, py: 0x10, rot: (rotDeg * 3.1415927) / 180 })
  }

  /** deckDrawFrame(cardId, mode, state, filter, view) 0x08829658. */
  private drawFrame(sim: DeckEditorSim, cardId: number, clock: UiClock) {
    const f = this.a.frame
    const { state, view, filter, mode } = sim
    for (let x = 0; x < 0x280; x += 0x40) this.spr(f, 0, 0, 0x40, 0x3c, x, 0)
    if (mode === MODE_DECK) {
      const tabs = this.a.tabs
      const grey = col(0x40, 0x40, 0x40, 0x80)
      if (state === 5 || state === 4) {
        this.spr(tabs, 0x80, 0, 0x100, 0x80, 0x10, 0, { sx: 0.5, sy: 0.5 })
        this.spr(tabs, 0, 0, 0x80, 0x80, 0x50, 0, { sx: 0.5, sy: 0.5, color: grey })
      } else if (state === 3 || state === 2) {
        this.spr(tabs, 0, 0, 0x80, 0x80, 0x10, 0, { sx: 0.5, sy: 0.5 })
        this.spr(tabs, 0x80, 0, 0x100, 0x80, 0x50, 0, { sx: 0.5, sy: 0.5, color: grey })
      }
      if (state === 4 || state === 2) {
        const b = clock.m7
        this.spr(f, b * 0x20 + 0xa0, 0xa0, (b + 1) * 0x20 + 0xa0, 0xc0, 0x50, 8)
        this.spr(f, 0xc0, 0, 0xf8, 0x18, 0x70, 0x10)
      }
    }
    this.spr(f, 0x40, 0, 0xb9, 0x39, 0, 0x180)
    if (mode === MODE_DECK) {
      this.spr(f, 0, 0x40, 0xf2, 99, 0xc0, 0xe)
      if (state !== 7 && state !== 6) this.text(sim.deck.name, 200, 0x16, 0x16, 0x16)
      if (view === 2) {
        this.spr(f, 0, 99, 0x4f, 0x95, 0x1ca, 7)
        this.spr(f, 0x89, 99, 0xd8, 0x95, 0x219, 7)
        const [u, v] = this.t.filterLabelUV[filter] ?? [0, 0]
        this.spr(f, u, v, u + 0x48, v + 0x16, 0x1f5, 0x1b)
        if (state === 4) this.sideArrows(0x219, 0x20, 0x50, 3, clock)
      }
      let n = 0
      for (let i = 0; i < 0x2b; i++) if (sim.deckCards[i] !== 0) n++
      if (Math.trunc(n / 10) !== 0) this.digit(Math.trunc(n / 10), 0xf, 0x199)
      this.digit(n % 10, 0x21, 0x199)
      this.digit(0xb, 0x33, 0x199)
      this.digit(3, 0x45, 0x199)
      this.digit(0, 0x57, 0x199)
    } else {
      const owned = sim.owned(sim.idx(cardId))
      const v = owned > 99 ? 99 : owned
      if (owned > 9) this.digit(Math.trunc(v / 10), 0x21, 0x199)
      this.digit(v % 10, 0x33, 0x199)
    }
  }

  /** uiDrawSideArrows(x, y, 0, gap, mask, animate 1) 0x08839C80. */
  private sideArrows(x: number, y: number, gap: number, mask: number, clock: UiClock) {
    const a = clock.m6
    const half = gap < 0 ? (gap + 1) >> 1 : gap >> 1
    if (mask & 1) this.spr(this.a.ui, 0, 0x30, 0x20, 0x66, a + (x - 0x20 - half), y - 0x1b)
    if (mask & 2) this.spr(this.a.ui, 0x20, 0x30, 0x40, 0x66, x + half - a, y - 0x1b)
  }

  /** deckDrawDeckGrid 0x08829E14: 2 of the 7 rows × 6, cursor corners + hand, the count popup (state 3). */
  private drawDeckGrid(sim: DeckEditorSim, clock: UiClock) {
    const f = this.a.frame
    const row = sim.cursorRow, sel = sim.cursorCol + row * 6 + 1
    let scroll = sim.deckGridScroll
    if (row === 0) scroll = 0
    else if (scroll <= row) {
      if (scroll + 1 < row) scroll = row - 1
    } else scroll = row
    sim.deckGridScroll = scroll
    let k = scroll * 6, y = 0x44, selX = 0, selY = 0
    for (let r = scroll; r < scroll + 2; r++) {
      let x = 0x20
      for (let c = 0; c < 6; c++) {
        k++
        this.cardPic(sim.deckCards[k] ?? 0, x, y, 1.0, false)
        if (sel === k) {
          // anchor 0x10: pivot (11, 11) of the 23×23 corner; the flips turn around it.
          const o = { px: 11, py: 11 }
          this.spr(f, 0, 0xd0, 0x17, 0xe7, x, y, o)
          this.spr(f, 0, 0xd0, 0x17, 0xe7, x + 0x39, y, { ...o, sx: -1 })
          this.spr(f, 0, 0xd0, 0x17, 0xe7, x, y + 0x4d, { ...o, sy: -1 })
          this.spr(f, 0, 0xd0, 0x17, 0xe7, x + 0x39, y + 0x4d, { ...o, sx: -1, sy: -1 })
          this.hand(x + 0x20, y, 0x87, clock)
          selX = x
          selY = y
        }
        x += 0x60
      }
      y += 0x6c
    }
    if (sim.state === 3) {
      let py: number, dy: number
      if (scroll === row) {
        py = selY + 100
        dy = selY + 0x68
      } else {
        py = selY - 0x20
        dy = selY - 0x1c
      }
      this.spr(f, 0xb0, 0xd0, 0x100, 0xf0, selX, py)
      this.digit(sim.pickCount % 10, selX + 0xd, dy)
      this.digit(0xb, selX + 0x1f, dy)
      const owned = Math.min(3, sim.owned(sim.idx(sim.deckCards[sel] ?? 0)))
      this.digit(owned % 10, selX + 0x31, dy)
    }
  }

  /** deckDrawCardGrid 0x0882A258: 3 rows × 10 of the collection, greying, NEW badges, the enlarged cursor card. */
  private drawCardGrid(sim: DeckEditorSim, clock: UiClock) {
    const f = this.a.frame
    const { mode, filter } = sim
    const last = filter === 3 ? 0xce : filter === 2 ? 0xbe : filter === 1 ? 0x7a : 0xce
    const row = sim.cursorRow
    let scroll = sim.cardGridScroll
    while (scroll + 2 < row) scroll++
    if (row < scroll) scroll = row
    sim.cardGridScroll = scroll
    let selNo: number, no: number
    if (mode === MODE_DECK) {
      selNo = sim.gridPosToCardNo(sim.cursorCol + row * 10, filter)
      no = sim.gridPosToCardNo(scroll * 10, filter)
    } else {
      selNo = sim.cursorCol + row * 10 + 1
      no = scroll * 10 + 1
    }
    let x = 0x10, y = 0x40, r = 0, c = 0
    let selX = 0, selY = 0, selId = 0
    for (; no <= last; no++) {
      const owned = sim.owned(no)
      if (mode === MODE_DECK && owned === 0) continue
      const id = owned !== 0 ? sim.noToId[no] ?? 0 : 0
      if (selNo === no) {
        selId = id
        selX = x
        selY = y
      } else {
        if (mode === MODE_DECK) {
          const inDeck = sim.counts[no]
          this.cardPic(id, x, y, 0.7, inDeck >= 3 || inDeck === owned)
        } else this.cardPic(id, x, y, 0.7, id === 0)
        this.newBadge(no, sim, x, y, clock)
      }
      c++
      x = Math.trunc(x + 60.0)
      if (c > 9) {
        r++
        x = 0x10
        c = 0
        y = Math.trunc(y + 74.0)
        if (r > 2) break
      }
    }
    const i = sim.idx(selId)
    const sx = Math.trunc(selX - 4.0), sy = Math.trunc(selY - 5.0)
    if (mode === MODE_DECK) {
      // cardPicDrawDimmed(…, 0x50) and cardPicDrawScaled(…, 0.8) give the same size
      const inDeck = sim.counts[i]
      this.cardPic(selId, sx, sy, 0.8, inDeck >= 3 || inDeck === sim.owned(i))
    } else this.cardPic(selId, sx, sy, 0.8, selId === 0)
    this.newBadge(i, sim, selX, selY, clock)
    // cursor corners, anchor 9 (pivot at the top-left: the flips extend left/up from the point)
    this.spr(f, 0, 0xd0, 0x17, 0xe7, sx, sy)
    const x2 = Math.trunc(sx + 64.0), y2 = Math.trunc(sy + 80.0)
    this.spr(f, 0, 0xd0, 0x17, 0xe7, x2, sy, { sx: -1 })
    this.spr(f, 0, 0xd0, 0x17, 0xe7, sx, y2, { sy: -1 })
    this.spr(f, 0, 0xd0, 0x17, 0xe7, x2, y2, { sx: -1, sy: -1 })
    if (sim.state === 5) {
      const px = Math.trunc(sx + 32.0 - 40.0)
      const py = scroll + 1 < row ? sy - 0x20 : Math.trunc(sy + 80.0)
      this.spr(f, 0xb0, 0xd0, 0x100, 0xf0, px, py)
      const dy = py + 4, dx = px + 0x28
      this.digit(sim.pickCount % 10, dx - 0x1b, dy)
      this.digit(0xb, dx - 9, dy)
      this.digit(Math.min(3, sim.owned(i)) % 10, dx + 9, dy)
    }
  }

  /** cardDrawStatPanel 0x08828BD8: AP/HP/Move (Range), Cost, Soul, Keep cost over the info window. */
  private drawStatPanel(sim: DeckEditorSim, db: GameDb, cardId: number, clock: UiClock) {
    const info = sim.win('info')
    if (!sim.isOpen('info') || sim.state === 7 || sim.state === 1 || sim.state === 0 || cardId === 0) return
    if (sim.owned(sim.idx(cardId)) === 0) return
    const card = db.byId.get(cardId)
    if (!card) return
    const ui = this.a.ui
    const x = Math.trunc(info.x + 15.0), y0 = Math.trunc(info.y + 15.0)
    const y = y0 + 0x14
    const kind = Math.trunc(cardId / 1000)
    const d2 = (v: number) => (v >= 0 && v < 10 ? ' ' + v : String(v))
    if (kind !== 2) {
      this.spr(ui, 0x50, 0, 0x78, 0x18, x, y)
      this.text(d2(card.ap), x + 0x2c, y0 + 0x18, 0x14, 0x14)
      this.spr(ui, 0, 0, 0x28, 0x18, x + 0x54, y)
      this.text(d2(card.hp), x + 0x80, y0 + 0x18, 0x14, 0x14)
      if (kind === 3) {
        this.spr(ui, 0x78, 0, 0xa8, 0x18, x + 0xa8, y)
        this.text(d2(card.range), x + 0xda, y0 + 0x18, 0x14, 0x14)
      } else {
        this.spr(ui, 0xa8, 0, 0xd8, 0x18, x + 0xa8, y)
        this.text(d2(card.move), x + 0xda, y0 + 0x18, 0x14, 0x14)
      }
    }
    this.spr(ui, 0, 0x18, 0x40, 0x30, x, y0 + 0x2e)
    this.text(d2(card.cost), x + 0x44, y0 + 0x32, 0x14, 0x14)
    if (card.soul > 0) {
      this.spr(ui, 0x51, 0x31, 0x67, 0x47, x + 0x6c, y0 + 0x2e, { px: 11, py: 11, rot: (clock.angle * 3.141592) / 180 })
      this.text(d2(card.soul), x + 0x86, y0 + 0x32, 0x14, 0x14)
    }
    if (kind !== 2) {
      this.spr(ui, 0x40, 0x18, 0xad, 0x30, x + 0xbe, y0 + 0x2e)
      this.text(d2(card.maintenance), x + 0x12f, y0 + 0x32, 0x14, 0x14)
    }
  }

  /** deckDrawTypeCounts 0x08828594: Unit / Spell / Base labels with counts inside g_deckWinTypeCount. */
  private drawTypeCounts(sim: DeckEditorSim) {
    if (!sim.isOpen('typeCount')) return
    const w = sim.win('typeCount')
    let x = Math.trunc(w.x + 15.0)
    const y = Math.trunc(w.y + 15.0)
    const counts = [0, 0, 0]
    for (let no = 1; no < 0xcf; no++) {
      const n = sim.mode === MODE_DECK ? sim.counts[no] : sim.owned(no) !== 0 ? 1 : 0
      const id = sim.noToId[no] ?? 0
      if (n === 0 || id <= 0) continue
      const k = Math.trunc(id / 1000)
      if (k === 0) counts[0] += n
      else if (k === 2) counts[1] += n
      else if (k === 3) counts[2] += n
    }
    for (let i = 0; i < 3; i++) {
      const [u, v] = this.t.typeLabelUV[i + 1] ?? [0, 0]
      this.spr(this.a.frame, u, v, u + 0x48, v + 0x16, x, y)
      let value = counts[i]
      let dx = x + 0x1c
      for (let p = 10; p <= value; p *= 10) dx -= 0x12
      for (let p = 10000; p >= 10; p = Math.trunc(p / 10)) {
        if (p - 1 < counts[i]) {
          this.digit(value < 1 ? 0 : Math.trunc(value / p), dx + 0x12, y + 0x16)
          value %= p
          dx += 0x12
        }
      }
      this.digit(value, dx + 0x12, y + 0x16)
      x += 0x48
    }
  }

  /** The windows as menuWinUpdateAll draws them; winPrintAt glyphs as style-0 overlays at the text origin (15, 15). */
  private drawWindows(sim: DeckEditorSim, frame: number) {
    const gl = this.gl
    if (!gl) return
    for (const w of sim.windows) {
      const base: DuelWindow = {
        x: w.x, y: w.y, w: w.w, h: w.h, codes: [], opened: w.opened, style: w.style, chamfer: w.chamfer, tailIdx: w.tailIdx,
        flags: w.flags & (WF_CENTER_X | WF_CENTER_Y), text: w.text, glyph: w.glyph ?? 20, typeDelay: 0, arrow: false,
      }
      this.painter.draw(gl, base, frame)
      const left = w.flags & WF_CENTER_X ? w.x - w.w / 2 : w.x
      const top = w.flags & WF_CENTER_Y ? w.y - w.h / 2 : w.y
      const h = this.hover
      if (h && h.key === w.key) {
        // (ours) the menu cursor's bar under the hovered label; the window's own text again on top (the prints follow anyway)
        this.painter.drawCursorBar(gl, h.x0, h.y0, h.x1 - h.x0, h.y1 - h.y0)
        if (w.text) {
          const [ox, oy] = this.painter.tables.textOffset[w.style] ?? [15, 15]
          this.painter.draw(gl, { x: Math.trunc(left) + ox, y: Math.trunc(top) + oy, w: 0, h: 0, codes: [], text: w.text, glyph: w.glyph ?? 20, style: 0, fade: 0x7f, opened: w.opened, typeDelay: 0, arrow: false }, frame)
        }
      }
      for (const p of w.prints) {
        let d = this.printCache.get(p)
        if (!d) {
          // Style 0 has text offset (0, 0); style 10 puts glyphs at (15, 15) + the print position.
          d = { x: Math.trunc(left) + 15 + p.x, y: Math.trunc(top) + 15 + p.y, w: 0, h: 0, codes: [], text: p.text, opened: p.at, style: 0, glyph: p.size, textColor: p.color, fade: 0x7f, typeDelay: 0, arrow: false }
          this.printCache.set(p, d)
        }
        this.painter.draw(gl, d, frame)
      }
    }
  }

  /** One frame of the scene's draw calls (after its logic). Returns the card the info viewer shows (states 6/7) or 0. */
  draw(gl: GlRenderer, sim: DeckEditorSim, db: GameDb, clock: UiClock, after?: (gl: GlRenderer) => void): number {
    this.gl = gl
    gl.depthTest = false
    gl.begin([0, 0, 0])
    const cardId = sim.shownCard
    let info = 0
    if (sim.view !== 0) {
      this.drawFrame(sim, cardId, clock)
      if (sim.view === 2 || (sim.mode === MODE_LIST && sim.view === 3)) this.drawCardGrid(sim, clock)
      else if (sim.view === 1) this.drawDeckGrid(sim, clock)
      this.drawWindows(sim, sim.frameNo)
      this.drawStatPanel(sim, db, cardId, clock)
      this.drawTypeCounts(sim)
      if (sim.state === 7 || sim.state === 6) info = cardId
    }
    // Play mode: windows opened later in the same list (the name-entry keyboard of state 9)
    after?.(gl)
    gl.end()
    this.gl = null
    return info
  }

  /** Play mode (ours): the ＠ｂ help-label zones of the open windows (their text and printed lines), topmost window first. */
  helpZones(sim: DeckEditorSim): (ButtonZone & { key: string })[] {
    const tables = this.painter.tables
    const out: (ButtonZone & { key: string })[] = []
    for (let k = sim.windows.length - 1; k >= 0; k--) {
      const w = sim.windows[k]
      const flags = w.flags & (WF_CENTER_X | WF_CENTER_Y)
      const zs = w.text ? buttonZones({ x: w.x, y: w.y, w: w.w, h: w.h, codes: [], opened: w.opened, text: w.text, glyph: w.glyph ?? 20, style: w.style, flags }, tables) : []
      const left = Math.trunc(flags & WF_CENTER_X ? w.x - w.w / 2 : w.x), top = Math.trunc(flags & WF_CENTER_Y ? w.y - w.h / 2 : w.y)
      for (const p of w.prints) zs.push(...textButtonZones(p.text, left + 15 + p.x, top + 15 + p.y, p.size, false, tables))
      for (const z of zs) out.push({ ...z, key: w.key })
    }
    return out
  }

  /** Viewer and Play mode (ours): the grid cell (collection: position, deck: slot index 0..41) under a virtual point, or null. */
  cellAt(sim: DeckEditorSim, vx: number, vy: number): { col: number; row: number } | null {
    if (sim.view === 1) {
      const c = Math.floor((vx - 0x20) / 0x60), r = Math.floor((vy - 0x44) / 0x6c)
      if (c < 0 || c > 5 || r < 0 || r > 1) return null
      if (vx - 0x20 - c * 0x60 > 80 || vy - 0x44 - r * 0x6c > 100) return null
      return { col: c, row: sim.deckGridScroll + r }
    }
    if (sim.view === 2 || sim.view === 3) {
      const c = Math.floor((vx - 0x10) / 60), r = Math.floor((vy - 0x40) / 74)
      if (c < 0 || c > 9 || r < 0 || r > 2) return null
      return { col: c, row: sim.cardGridScroll + r }
    }
    return null
  }
}
