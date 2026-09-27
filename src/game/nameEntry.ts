/**
 * The name-entry keyboard (g_nameEntry, struct NameEntry 0x550): nameEntryInit (0x0884AD94),
 * nameEntryOpenWindows (0x0884AF74) and nameEntryUpdate (0x0884B29C), with the window list of
 * menuWinUpdateAll (0x08867E14) it relies on (list order, flag 0x800 dimming, winApproachPos,
 * winFadeClose, winPrintAt / winPrintAtEx glyphs).
 *
 * Everything shown comes from BOOT.BIN (read from the player's disc): the prompts, the help line, the
 * confirmation texts, the keyboard pages (g_nameEntryPages 0x088D7034) and the caret strings
 * (0x088DB8C4). The USA game only ever shows page 2 (full-width digits, symbols and Latin letters):
 * nameEntryInit sets keyboardPage 2, and only page 3 (the kanji index) would open a sub-page, which
 * nothing selects.
 *
 * `mode` 0 = the player name (newGamePrologueScene), 1 = a deck name (campMenuScene state 8 → deck
 * rename, deckEditScene state 9 → the name of a new deck). Names are char[24] Shift-JIS, at most 11 full-width characters.
 */
import { WF_CENTER_X, WF_CENTER_Y, WF_MENU, WF_SCROLLBAR, WIN_CURSOR_COLORS, type DuelWindow, type WinTables } from '../effect/windows'
import type { GameDb } from '../formats/gamedb'
import { PAD, type PadInput } from './input'
import { buttonZones, clickButtonZone } from './buttonZones'
import { WinList } from './winList'

export { WinList }

/** BOOT.BIN addresses (texts and tables of the name entry). */
export const NE_ADDR = {
  pages: 0x088d7034, // g_nameEntryPages: 4 pointers (hiragana, katakana, Latin, kanji index)
  caret: 0x088db8c4, // 12 pointers: n half-width spaces + "−" (entry 11 = entry 10)
  promptName: 0x088db8fc, // "Please input your name. "
  promptDeck: 0x088db918, // "Please input deck name. "
  help: 0x088db934, // "＠ｂ０Enter ＠ｂ２Delete ＠ｂ１Return ＠ｂ１１Accept ＠ｎ＠ｂ７Move cursor left ＠ｎ＠ｂ９Move cursor right "
  intro: 0x088db9a4, // "Please input your name. ＠ｎThis name will be displayed for VS mode and save data. "
  confirm: 0x088db9f8, // "＠ｂ０Confirm "
  noName: 0x088dba08, // "You have not entered a name. "
  askName: 0x088dba28, // "The name you entered is   ＠ｎ“%s” ＠ｎIs that all right? "
  askDeck: 0x088dba68, // "The name of the deck is   ＠ｎ“%s” ＠ｎIs that all right? "
  yesNo: 0x088dbaa8, // "＠ｂ０Yes ＠ｂ３No "
} as const

/** The keyboard's windows (g_nameEntry +0x…: prompt, name, help, keyboard, win3, the confirmation pair). */
const NE_WINDOWS = ['prompt', 'name', 'help', 'keyboard', 'win3', 'confirm', 'confirmOpt']

const FULL_SPACE = 0x8140
const ROW_BYTES = 0x26
const MAX_CHARS = 11

function cstr(db: GameDb, addr: number, max = 512): Uint8Array {
  const b = db.raw.bytes(addr, max)
  const e = b.indexOf(0)
  return b.slice(0, e < 0 ? b.length : e)
}
const u32 = (db: GameDb, addr: number) => {
  const b = db.raw.bytes(addr, 4)
  return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0
}

/** Replaces the "%s" of a sprintf format with raw bytes. */
function sprintfS(fmt: Uint8Array, s: Uint8Array): Uint8Array {
  for (let i = 0; i + 1 < fmt.length; i++) {
    if (fmt[i] === 0x25 && fmt[i + 1] === 0x73) return Uint8Array.from([...fmt.subarray(0, i), ...s, ...fmt.subarray(i + 2)])
    if (fmt[i] >= 0x81) i++ // second byte of a 2-byte code
  }
  return fmt
}

const strz = (b: Uint8Array) => {
  const e = b.indexOf(0)
  return b.subarray(0, e < 0 ? b.length : e)
}

// ---------------------------------------------------------------------------------------------
// nameEntry*

export interface NameEntryAudio {
  playSe(id: number): void
}

/** g_nameEntry. */
export class NameEntry {
  readonly wins: WinList
  /** 0 player name, 1 deck name (nameEntryUpdate's argument). */
  mode = 0
  state = 0
  /** unk08: the state to return to after the confirmation. */
  retState = 0
  /** unk0C / unk10 / unk14: keyboard column (0..16), row (0..5), scroll (sub-pages only). */
  col = 0
  row = 0
  scroll = 0
  /** unk18: the kanji-index position saved while a sub-page is open. */
  savedPos = 0
  cursorPos = 0
  nameLen = 0
  /** char[24] Shift-JIS. */
  name = new Uint8Array(24)
  nameOrig = new Uint8Array(24)
  keyboardPage = 2
  /** The committed name (sprintf into the destination in state 4). */
  result: Uint8Array | null = null
  private db: GameDb
  private pages: Uint8Array[] = []
  private subPages = new Map<number, Uint8Array>()

  private tables: WinTables

  /** `wins`: the scene's window list when the keyboard opens over other windows (the camp); a new one otherwise. */
  constructor(db: GameDb, tables: WinTables, wins?: WinList) {
    this.db = db
    this.tables = tables
    this.wins = wins ?? new WinList(tables)
    for (let i = 0; i < 4; i++) this.pages.push(cstr(db, u32(db, NE_ADDR.pages + 4 * i), 0x400))
  }

  private txt(addr: number) {
    return cstr(this.db, addr)
  }

  /** The page being shown (g_nameEntryPages[page], or the kanji sub-page table 0x088DB6F8 in state 3). */
  private pageText(): Uint8Array {
    if (this.state !== 3) return this.pages[this.keyboardPage] ?? new Uint8Array(0)
    let p = this.subPages.get(this.keyboardPage)
    if (!p) {
      p = cstr(this.db, u32(this.db, 0x088db6f8 + 4 * this.keyboardPage), 0x800)
      this.subPages.set(this.keyboardPage, p)
    }
    return p
  }

  /** The character under the keyboard cursor. */
  private keyAt(): number {
    const p = this.pageText()
    const o = this.col * 2 + (this.state === 3 ? (this.scroll + this.row) * ROW_BYTES : this.row * ROW_BYTES) + 4
    return ((p[o] ?? 0) << 8) | (p[o + 1] ?? 0)
  }

  private caret(pos: number): Uint8Array {
    return cstr(this.db, u32(this.db, NE_ADDR.caret + 4 * pos), 32)
  }

  /** nameEntryInit(dest, initialName): empty buffers, the initial name, keyboard page 2, windows reset. */
  init(initial: Uint8Array | null) {
    this.state = 0
    this.name.fill(0)
    this.nameOrig.fill(0)
    this.col = this.row = this.scroll = 0
    this.result = null
    if (initial) {
      const s = strz(initial).subarray(0, 23)
      this.name.set(s)
      this.nameOrig.set(s)
      this.nameLen = s.length >> 1
    } else this.nameLen = 0
    this.cursorPos = this.nameLen
    this.keyboardPage = 2
    // winReset of the keyboard's own windows (a shared list keeps the scene's windows)
    for (const k of NE_WINDOWS) this.wins.close(k)
  }

  /** winFreeGlyphs + winPrintAt of the name and of the caret line. */
  private printName() {
    const W = this.wins
    W.freeGlyphs('name')
    W.print('name', 8, 1, 0x18, strz(this.name))
    W.print('name', 8, 0xc, 0x18, this.caret(this.cursorPos))
  }

  /** nameEntryOpenWindows(500 / 300). */
  private openWindows(player: boolean) {
    const W = this.wins
    const prompt = W.openMessage('prompt', 0, 8, this.txt(player ? NE_ADDR.promptName : NE_ADDR.promptDeck), 0x16, 0x3000)
    prompt.style = 10
    prompt.w += 10
    prompt.h += 10
    prompt.alpha = 0
    const nw = W.openFrame('name', 8, prompt.y + prompt.h, 321, 54, 5, 7, 0)
    nw.style = 10
    nw.alpha = 0
    nw.x = 320 - nw.w / 2
    this.printName()
    const help = W.openMessage('help', 320, 448, this.txt(NE_ADDR.help), 0x14, 0x7000)
    help.w += 10
    help.h += 10
    help.style = 10
    help.y = 448 - help.h
    help.alpha = 0
    const kb = W.openFrame('keyboard', 0, 180, 480, 180, 5, 10, 0x800)
    kb.alpha = 0
    kb.x = 320 - kb.w / 2
    W.print('keyboard', 0, 0, 0x18, this.pages[this.keyboardPage] ?? new Uint8Array(0), true)
    kb.flags = (kb.flags ?? 0) | WF_MENU | WF_SCROLLBAR
    kb.menu = { row: 0, offX: 0xc, offY: 10, cursorW: 0x30, color: WIN_CURSOR_COLORS[0], itemCount: 6, visibleRows: 6, scrollTop: 0 }
  }

  private setKeyboardCursor() {
    const kb = this.wins.get('keyboard')
    if (!kb?.menu) return
    kb.menu.offX = this.col * 0x19 + 0xc
    kb.menu.offY = 10
    kb.menu.row = this.row
    kb.menu.scrollTop = this.scroll
  }

  private openConfirm(text: Uint8Array, opt: Uint8Array, optFlags: number, below: boolean) {
    const W = this.wins
    const c = W.openMessage('confirm', 320, 224, text, 0x16, 0xf000)
    c.style = 10
    c.w += 10
    c.h += 10
    const o = W.openMessage('confirmOpt', 320, (below ? c.h : c.h / 2) + 224, opt, 0x14, optFlags)
    o.style = 10
    o.w += 10
    o.h += 10
  }

  /** A window's rect as drawn ((x, y) is the centre with the centring flags). */
  private rect(w: DuelWindow): [number, number, number, number] {
    const f = w.flags ?? 0
    const x = f & WF_CENTER_X ? w.x - w.w / 2 : w.x
    const y = f & WF_CENTER_Y ? w.y - w.h / 2 : w.y
    return [x, y, x + w.w, y + w.h]
  }

  /**
   * Mouse → buttons (viewer convenience, not in the game): a click closes the intro and the
   * "no name" message; on "✕ Yes ○ No" the left half is ✕ and the right half ○; over the keyboard
   * the pointer moves the key cursor (cells 25 wide from +12, rows of lineH from +10, as
   * setKeyboardCursor places the bar) and a click types the key.
   */
  private pointer(input: PadInput): number {
    const click = (input.pressed & PAD.POINTER) !== 0
    switch (this.state) {
      case 1:
      case 5:
        return click ? PAD.CROSS : 0
      case 4: {
        const o = this.wins.get('confirmOpt')
        if (!click || !o) return 0
        const [x0, y0, x1, y1] = this.rect(o)
        if (!input.pointerIn(x0, y0, x1, y1)) return 0
        return input.pointerX < (x0 + x1) / 2 ? PAD.CROSS : PAD.CIRCLE
      }
      case 2: {
        // a click on a label of the help line ("✕ Enter", "□ Delete", "△ Return", "START Accept", "L …", "R …") presses that button
        const help = clickButtonZone(input, this.wins.get('help'), this.tables)
        if (help) return help
        const kb = this.wins.get('keyboard')
        if (!kb?.menu || !(click || input.pointerMoved)) return 0
        const [x0, y0] = this.rect(kb)
        const lineH = kb.wide ? (kb.glyph ?? 20) + 2 : (kb.glyph ?? 20)
        const col = Math.floor((input.pointerX - x0 - 0xc) / 0x19)
        const row = Math.floor((input.pointerY - y0 - 10) / lineH)
        if (col < 0 || col > 0x10 || row < 0 || row > 5) return 0
        const oc = this.col, or = this.row
        this.col = col
        this.row = row
        if (this.keyAt() === FULL_SPACE) {
          this.col = oc
          this.row = or
          return 0
        }
        this.setKeyboardCursor()
        return click ? PAD.CROSS : 0
      }
    }
    return 0
  }

  /** nameEntryUpdate(mode): 0 busy, 1 entered, −1 cancelled (empty name). Plays its SE through `audio`. */
  update(pressed: number, repeat: number, audio: NameEntryAudio, input?: PadInput): number {
    if (input) pressed |= this.pointer(input)
    this.wins.hover = null
    if (input && input.pointerX >= 0) {
      for (const key of ['help', 'confirmOpt']) {
        const w = this.wins.get(key)
        const z = w && buttonZones(w, this.tables).find((q) => input.pointerIn(q.x0, q.y0, q.x1, q.y1))
        if (z) this.wins.hover = { key, ...z }
      }
    }
    // Backspace (ours) = □ Delete on the keyboard page, with the pad repeat so holding it keeps deleting
    if ((this.state === 2 || this.state === 3) && (pressed | repeat) & PAD.BACKSPACE) pressed |= PAD.SQUARE
    const W = this.wins
    const player = this.mode === 0
    let se = 0
    const st = this.state
    if (st === 2 || st === 3 || st === 4 || st === 5) {
      const help = W.get('help'), kb = W.get('keyboard')
      W.approach('prompt', 0, 8, 8, 8)
      const pp = W.get('prompt')
      W.approach('name', 0, (pp?.y ?? 0) + (pp?.h ?? 0), 8, 8)
      W.approach('help', 320, 448 - (help?.h ?? 0), 8, 8)
      W.approach('keyboard', 95, 448 - (help?.h ?? 0) - (kb?.h ?? 0), 8, 8)
      const b = kb?.bright ?? 0x80
      for (const k of ['name', 'win3', 'prompt', 'help']) {
        const w = W.get(k)
        if (w) w.bright = b
      }
    } else if (st === 1 && player) {
      const p = W.get('prompt')
      if (p) W.approach('prompt', p.x, p.y, 8, 8)
      const h = W.get('help')
      if (h && p) h.alpha = p.alpha
    }
    sw: switch (this.state) {
      case 0:
      case 1:
        if (this.state === 0) {
          this.state = 2
          if (player) {
            W.close('prompt')
            const p = W.openMessage('prompt', 320, 224, this.txt(NE_ADDR.intro), 0x16, 0xf000)
            p.style = 10
            p.w += 10
            p.alpha = 0
            p.h += 10
            W.close('help')
            const h = W.openMessage('help', 320, 0, this.txt(NE_ADDR.confirm), 0x14, 0x7000)
            h.style = 10
            h.w += 10
            h.alpha = 0
            h.h += 10
            this.state = 1
            h.y = p.y + p.h / 2
          }
        }
        // case 1 (case 0 falls through into it)
        if (pressed & PAD.CROSS) {
          W.close('prompt')
          W.close('help')
          se = 7
          this.state = 2
        }
        if (this.state === 2) this.openWindows(player)
        break
      case 2:
      case 3: {
        W.fadeClose('confirm', 10)
        W.fadeClose('confirmOpt', 10)
        this.setKeyboardCursor()
        if (pressed & PAD.START) {
          this.retState = this.state
          se = 7
          if (this.nameLen === 0) {
            if (this.nameOrig[0] === 0) {
              this.openConfirm(this.txt(NE_ADDR.noName), this.txt(NE_ADDR.confirm), 0xb000, true)
              this.state = 5
              break
            }
            this.name.fill(0)
            this.name.set(strz(this.nameOrig))
          }
          const ask = sprintfS(this.txt(player ? NE_ADDR.askName : NE_ADDR.askDeck), strz(this.name))
          this.openConfirm(ask, this.txt(NE_ADDR.yesNo), 0x3000, false)
          this.state = 4
          break
        }
        if (pressed & PAD.L && this.cursorPos > 0) {
          this.cursorPos--
          this.printName()
          se = 1
          break
        }
        if (pressed & PAD.R && this.cursorPos < this.nameLen) {
          this.cursorPos++
          this.printName()
          se = 1
          break
        }
        if (pressed & PAD.CROSS) {
          if (this.state === 2 && this.keyboardPage === 3) {
            // the kanji index opens a sub-page (unreachable in the USA game: page 3 is never selected)
            this.state = 3
            this.keyboardPage = this.col + this.row * 0x12
            this.savedPos = this.row * 0x10000 + this.col
            this.row = this.col = 0
            const sub = this.pageText()
            W.freeGlyphs('keyboard')
            W.print('keyboard', 0, 0, 0x18, sub)
            const kb = W.get('keyboard')
            const rows = Math.trunc(sub.length / ROW_BYTES)
            if (kb?.menu && rows >= 7) kb.menu.itemCount = rows
            se = 7
            break
          }
          if (this.cursorPos === MAX_CHARS) this.cursorPos = 10
          const key = this.keyAt()
          // shift the characters from the cursor one place right (the 11th is lost)
          for (let k = 0; k < 0x14 - this.cursorPos * 2; k += 2) {
            this.name[0x14 - k] = this.name[0x12 - k]
            this.name[0x15 - k] = this.name[0x13 - k]
          }
          this.name[0x17] = 0
          this.name[this.cursorPos * 2] = key >> 8
          this.name[this.cursorPos * 2 + 1] = key & 0xff
          if (this.cursorPos < MAX_CHARS) this.cursorPos++
          if (this.nameLen < MAX_CHARS) this.nameLen++
          this.printName()
          se = 7
          if (this.state === 2) break
        }
        if (this.state === 3 && pressed & (PAD.CROSS | PAD.CIRCLE)) {
          if (pressed & PAD.CIRCLE) se = 9
          this.keyboardPage = 3
          this.col = this.savedPos & 0xffff
          this.row = this.savedPos >>> 16
          this.scroll = 0
          W.freeGlyphs('keyboard')
          W.print('keyboard', 0, 0, 0x18, this.pages[3] ?? new Uint8Array(0))
          const kb = W.get('keyboard')
          if (kb?.menu) {
            kb.menu.itemCount = 6
            kb.menu.visibleRows = 6
          }
          this.state = 2
          this.setKeyboardCursor()
          break
        }
        if (pressed & PAD.SQUARE) {
          const i = this.cursorPos
          if (i < this.nameLen) {
            for (let k = i; k < MAX_CHARS; k++) {
              this.name[k * 2] = this.name[k * 2 + 2]
              this.name[k * 2 + 1] = this.name[k * 2 + 3]
            }
            this.name[0x17] = 0
            if (this.nameLen > 0) this.nameLen--
            this.name[this.nameLen * 2] = 0
            this.name[this.nameLen * 2 + 1] = 0
          } else {
            if (i > 0) this.cursorPos--
            if (this.nameLen > 0) this.nameLen--
            this.name[this.cursorPos * 2] = 0
            this.name[this.cursorPos * 2 + 1] = 0
          }
          this.printName()
          se = 9
          break
        }
        if (pressed & PAD.TRIANGLE) {
          this.name.fill(0, 0, 1)
          se = 9
          this.state = 6
          break
        }
        if (repeat & PAD.UP) {
          do {
            if (this.state === 3) {
              if (this.row + this.scroll === 0) {
                this.row = 5
                this.scroll = 0
                const rows = Math.trunc(this.pageText().length / ROW_BYTES)
                if (rows - 1 > 5) this.scroll = rows - 6
              } else if (this.row === 0) this.scroll--
              else this.row--
              this.reprintSub()
            } else this.row = this.row === 0 ? 5 : this.row - 1
          } while (this.keyAt() === FULL_SPACE)
          se = 1
        } else if (repeat & PAD.DOWN) {
          do {
            if (this.state === 3) {
              const rows = Math.trunc(this.pageText().length / ROW_BYTES)
              if (rows - 1 === this.row + this.scroll) this.scroll = this.row = 0
              else if (this.row === 5) this.scroll++
              else this.row++
              this.reprintSub()
            } else this.row = this.row === 5 ? 0 : this.row + 1
          } while (this.keyAt() === FULL_SPACE)
          se = 1
        }
        if (repeat & PAD.RIGHT) {
          do this.col = this.col === 0x10 ? 0 : this.col + 1
          while (this.keyAt() === FULL_SPACE)
          se = 1
        } else if (repeat & PAD.LEFT) {
          do this.col = this.col === 0 ? 0x10 : this.col - 1
          while (this.keyAt() === FULL_SPACE)
          se = 1
        }
        break
      }
      case 4:
        if (pressed & PAD.CROSS) {
          // sprintf(dest, "%s", name)
          this.result = strz(this.name).slice()
          se = 7
          this.state = 6
        } else if (pressed & PAD.CIRCLE) {
          if (this.nameLen === 0) {
            this.name[0] = 0
            this.name[1] = 0
          }
          se = 9
          this.state = this.retState
        }
        break
      case 5:
        if (pressed & PAD.CROSS) {
          se = 7
          this.state = this.retState
        }
        break
      case 6: {
        let open = 0
        for (const k of ['name', 'prompt', 'keyboard', 'win3', 'help', 'confirm', 'confirmOpt']) {
          W.fadeClose(k, 10)
          if (W.isOpen(k)) open++
        }
        if (open === 0) {
          this.state = 0
          if (this.name[0] === 0) return -1
          return 1
        }
        break sw
      }
    }
    if (se) audio.playSe(se)
    return 0
  }

  /** The sub-page redraw of states 3 (＠－ + the visible rows). */
  private reprintSub() {
    const p = this.pageText()
    const b = Uint8Array.from([0x81, 0x97, 0x81, 0x7c, ...p.subarray(this.scroll * ROW_BYTES + 4, this.scroll * ROW_BYTES + 4 + 0xe0)])
    this.wins.freeGlyphs('keyboard')
    this.wins.print('keyboard', 0, 0, 0x18, b)
  }

  /** The name as the debug overlay shows it. */
  get nameText(): string {
    return new TextDecoder('shift_jis').decode(strz(this.name))
  }
}
