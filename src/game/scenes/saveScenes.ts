/**
 * The save scenes of Play mode: saveDataScene (0x088A148C) with the Sony savedata sample layer
 * (CB_SaveData_Normal / Savedata_Update) on top of a stand-in for the PSP savedata utility, the
 * scenes that call it (1000 save game data, 0x44C load game data, 0x208 resumeTempSaveScene) and the
 * map board's Temp save. Saves live in localStorage (saves.ts) with the CADATA.SAV layout.
 *
 * What is the game's and what is ours:
 * - saveDataScene's own windows ("An error has occurred." / Back, "Delete data to create free space?"
 *   / Yes No) and resumeTempSaveScene's windows are the game's: winOpenMessage at the same positions,
 *   sizes and flags, texts read from BOOT.BIN;
 * - the utility dialog itself (slot list, confirmation, progress, "Save completed.") is drawn by the
 *   PSP firmware on the real console. Here it is a dialog made of the game's windows, with the
 *   Sony sample's message texts found in BOOT.BIN (GetString_MC_Confirm_Message, GetString_EmptyTitle
 *   "No Data", GetString_Canceled_Message, the no-space format); the few texts the firmware adds
 *   (the dialog titles, "Saving…", "Loading…", "There is no saved data.") are ours.
 */
import { layoutText, WF_CENTER_X, WF_CENTER_Y, type DuelWindow, type WindowPainter, type WinTables } from '../../effect/windows'
import type { GlRenderer } from '../../effect/gl'
import type { GameDb } from '../../formats/gamedb'
import type { Scene, SceneContext } from '../game'
import { GameScene, type GameSceneId } from '../gameScene'
import { PAD, type PadInput } from '../input'
import { buttonZones } from '../buttonZones'
import { encodeSjis } from '../profile'
import { CONTINUE_DETAIL, CONTINUE_DIR, DEFAULT_SAVEDATA_TITLE, deleteSave, gameDataSfo, GAME_SLOTS, listGameSaves, readContinue, SFO_TITLE, slotDir, writeSave, type SaveEntry } from '../saves'

/** SaveSceneOp. */
export const SAVEOP = { BOOT_CHECK: -1, LOAD_GAME: 0, SAVE_GAME: 1, LOAD_CONTINUE: 2, SAVE_CONTINUE: 3 } as const
/** SaveSceneResult. */
export const SAVERES = { CANCEL: -1, BUSY: 0, DONE: 1 } as const
export type SaveResult = (typeof SAVERES)[keyof typeof SAVERES]

/** BOOT.BIN addresses of the texts (read from the loaded disc; the app ships without them). */
const TXT = {
  error: 0x088fda80, // "An error has occurred. "
  back: 0x088fda98, // "＠ｂ３Ｂａｃｋ "
  noSpaceAsk: 0x088fdaa8, // "Delete data to create free space?  "
  yesNo: 0x088fdacc, // "＠ｂ０Ｙｅｓ ＠ｂ３Ｎｏ"
  resumeAsk: 0x088b9bdc, // "This data will be deleted after loading.  ＠ｎIs that all right?  "
  resumeButtons: 0x088b9c20, // "＠ｂ０Yes  ＠ｂ３Cancel "
  resumeDeleted: 0x088b9c3c, // "Temporary data will be deleted. "
  mcNew: 0x08989aa0, // "New data will be created. Do you want to continue?"
  mcOverwrite: 0x08989ad4, // "The data will be overwritten. Do you want to continue?"
  mcSaved: 0x08989a74, // "Save completed."
  mcLoaded: 0x08989b0c, // "Load completed."
  mcErase: 0x08989b34, // "Erase data?"
  canceled: 0x08989a84, // "Processing cancelled."
  noSpaceFmt: 0x08989a2c, // "There is Not enough space.\nAt least %s more space is needed to save.\n"
  noData: 0x08989968, // "No Data" (GetString_EmptyTitle)
} as const

/** sceUtilitySavedata result codes used here (SCE_UTILITY_SAVEDATA_ERROR_*). */
export const UTIL_RESULT = {
  OK: 0,
  CANCEL: 1,
  LOAD_NO_DATA: 0x80110307 | 0,
  SAVE_NO_SPACE: 0x80110383 | 0, // −0x7FEEFC7D: saveDataScene offers the delete list
  LIST_NO_SPACE: 0x80110323 | 0, // −0x7FEEFCDD: same
} as const

function bootText(db: GameDb, addr: number): Uint8Array {
  const b = db.raw.bytes(addr, 256)
  const e = b.indexOf(0)
  return b.slice(0, e < 0 ? b.length : e)
}

/** A JS string as game text: Shift-JIS, "\n" = 0x0A (layoutText's newline). */
export function gameText(s: string): Uint8Array {
  const out: number[] = []
  // msgParseNextGlyph takes only space, - + . digits and letters as single ASCII bytes (anything else
  // starts a 2-byte code), so other ASCII punctuation becomes its full-width form, as in the game's texts
  const single = /[ \-+.0-9A-Za-z]/
  for (const line of s.split('\n')) {
    if (out.length) out.push(0x0a)
    const wide = [...line].map((ch) => {
      const c = ch.charCodeAt(0)
      return c > 0x20 && c < 0x7f && !single.test(ch) ? String.fromCharCode(0xff01 + c - 0x21) : ch
    })
    out.push(...encodeSjis(wide.join(''), 1024))
  }
  return Uint8Array.from(out)
}

/** A set of message windows drawn with the game's window painter (the 640×448 virtual space). */
export class SaveWindows {
  wins = new Map<string, DuelWindow>()
  frame = 0
  private tables: WinTables

  constructor(tables: WinTables) {
    this.tables = tables
  }

  /**
   * winOpenMessage(x, y, 0, 0, win, glyph, glyph, text, 0, 0, flags): draw style 7 (the default),
   * chamfer 5; flags 0x1000 / 0x2000 size the window to the text, 0x4000 / 0x8000 centre it on (x, y).
   */
  open(key: string, x: number, y: number, text: Uint8Array, glyph: number, flags: number, style = 7, fade?: number): DuelWindow {
    const lay = layoutText(text, { glyph, tables: this.tables })
    // a dialog re-opening the same text keeps its glyph fade-in (the stand-in dialog is rebuilt every frame)
    const old = this.prev.get(key) ?? this.wins.get(key)
    const same = !!old?.text && old.text.length === text.length && old.text.every((c, i) => c === text[i])
    // winOpenMessage sizes for style 7 (text origin (10, 10)): w = text + 20, h = lines + 18. The game's
    // callers that switch such a window to style 10 (origin (15, 15)) add 10 to both (nameEntryOpenWindows,
    // campMenuScene's quit question), so a style ≥ 10 window here gets the same +10.
    const pad = style >= 10 ? 10 : 0
    const w: DuelWindow = { x, y, w: flags & 0x1000 ? lay.autoW + pad : 0, h: flags & 0x2000 ? lay.autoH + pad : 0, codes: [], text, glyph, opened: same ? old!.opened : this.frame, style, chamfer: 5, flags: flags & (WF_CENTER_X | WF_CENTER_Y), alpha: 0x80, fade }
    this.wins.set(key, w)
    return w
  }

  close(key: string) {
    this.wins.delete(key)
  }

  /** Windows of the last rebuild (see `rebuild`). */
  private prev = new Map<string, DuelWindow>()

  closeAll() {
    this.wins.clear()
  }

  /** Starts rebuilding the window set: windows opened again with the same text keep their open frame. */
  rebuild() {
    this.prev = this.wins
    this.wins = new Map()
  }

  has(key: string) {
    return this.wins.has(key)
  }

  tick() {
    this.frame++
  }

  /** Play mode (ours): the help label under the mouse ("✕ Enter", "○ Back", "✕ Yes ○ No" …). */
  hover: { key: string; x0: number; y0: number; x1: number; y1: number } | null = null

  updateHover(input: PadInput) {
    this.hover = null
    if (input.pointerX < 0) return
    for (const [key, w] of this.wins) {
      const zones = buttonZones(w, this.tables)
      zonesCache.set(w, zones)
      const z = zones.find((q) => input.pointerIn(q.x0, q.y0, q.x1, q.y1))
      if (z) this.hover = { key, ...z }
    }
  }

  draw(gl: GlRenderer, painter: WindowPainter) {
    for (const [key, w] of this.wins) {
      painter.draw(gl, w, this.frame)
      const h = this.hover
      if (h && h.key === key && w.text) {
        // the menu cursor's bar under the label, then the text again on top
        painter.drawCursorBar(gl, h.x0, h.y0, h.x1 - h.x0, h.y1 - h.y0, w.alpha ?? 0x80)
        const [ox, oy] = this.tables.textOffset[w.style ?? 10] ?? [15, 15]
        const [x0, y0] = winRect(w)
        painter.draw(gl, { x: Math.trunc(x0) + ox, y: Math.trunc(y0) + oy, w: 0, h: 0, codes: [], text: w.text, glyph: w.glyph, wide: w.wide, style: 0, fade: 0x7f, opened: w.opened, alpha: w.alpha, bright: w.bright }, this.frame)
      }
    }
  }
}

// ---- mouse (viewer convenience, not in the game) ----

/** The help-label zones of each window, as the last hover pass found them (clicks reuse them). */
const zonesCache = new WeakMap<DuelWindow, ReturnType<typeof buttonZones>>()

/** A window's rect as drawn: (x, y) is its centre when it has the centring flags. */
function winRect(w: DuelWindow): [number, number, number, number] {
  const f = w.flags ?? 0
  const x = f & WF_CENTER_X ? w.x - w.w / 2 : w.x
  const y = f & WF_CENTER_Y ? w.y - w.h / 2 : w.y
  return [x, y, x + w.w, y + w.h]
}

/** The pointer is over window `w`: -1 outside, else 0 in its left half, 1 in its right half. */
function pointerHalf(input: PadInput, w: DuelWindow | undefined): number {
  if (!w) return -1
  const [x0, y0, x1, y1] = winRect(w)
  if (!input.pointerIn(x0, y0, x1, y1)) return -1
  return input.pointerX < (x0 + x1) / 2 ? 0 : 1
}

/** A click on a button window with two choices ("✕ Yes ○ No", "✕ Enter ○ Back"): ✕ for the left half, ○ for the right. */
function clickButtons(input: PadInput, w: DuelWindow | undefined): number {
  if (!(input.pressed & PAD.POINTER)) return 0
  // the label under the click (the zones the hover highlight shows), else the window's halves
  for (const z of (w && zonesCache.get(w)) || []) if (input.pointerIn(z.x0, z.y0, z.x1, z.y1)) return z.bit
  const h = pointerHalf(input, w)
  return h < 0 ? 0 : h === 0 ? PAD.CROSS : PAD.CIRCLE
}

/** Draws in 640×448 virtual units on the 480×272 map layer (the WindowPainter's space). */
export function scaledGl(gl: GlRenderer): GlRenderer {
  const sx = 480 / 640, sy = 272 / 448
  return {
    texture: (img: Parameters<GlRenderer['texture']>[0]) => gl.texture(img),
    triangles: (tex: Parameters<GlRenderer['triangles']>[0], blend: Parameters<GlRenderer['triangles']>[1], verts: Parameters<GlRenderer['triangles']>[2], color: Parameters<GlRenderer['triangles']>[3]) =>
      gl.triangles(tex, blend, verts.map((v) => ({ ...v, x: v.x * sx, y: v.y * sy })), color),
  } as unknown as GlRenderer
}

/** Slot windows of the stand-in list: 6 lines (title, 4 detail lines, date / size) of glyph 14 = the auto height of 6 lines + 10 (style 10). */
const SLOT_GLYPH = 14
const SLOT_H = 5 * SLOT_GLYPH + SLOT_GLYPH + 18 + 10
const SLOT_Y = 58

type UtilMode = 'LISTLOAD' | 'LISTSAVE' | 'LOAD' | 'SAVE' | 'AUTODELETE' | 'LISTALLDELETE'

interface ListRow {
  dir: string
  entry: SaveEntry | null
}

/**
 * The stand-in for sceUtilitySavedata (InitStart → Update → GetStatus → ShutdownStart): one dialog at a
 * time, `done` once the utility has shut down, then `result` as savedata_param.base.result.
 * g_saveModeTable: op 3 LOAD, 4 SAVE, 5 LISTLOAD, 6 LISTSAVE, 8 LISTALLDELETE, 10 AUTODELETE.
 */
export class SavedataUtility {
  readonly mode: UtilMode
  done = false
  result = 0
  /** LISTLOAD / LOAD: the file read (dataBuf). */
  loaded: Uint8Array | null = null
  /** The slot of the list (saveName "%02d"). */
  slot = -1
  private st = 'open'
  private timer = 0
  private cursor = 0
  private yes = false
  private rows: ListRow[] = []
  private data: Uint8Array | null
  private w: SaveWindows
  private db: GameDb

  constructor(mode: UtilMode, db: GameDb, tables: WinTables, data: Uint8Array | null = null) {
    this.mode = mode
    this.db = db
    this.data = data
    this.w = new SaveWindows(tables)
    this.refreshRows()
    // the list starts on the first slot; the load list skips "No Data" rows
    if (mode === 'LISTLOAD') this.cursor = Math.max(0, this.rows.findIndex((r) => r.entry))
  }

  private refreshRows() {
    if (this.mode === 'LISTSAVE' || this.mode === 'LISTLOAD') {
      const saves = listGameSaves()
      this.rows = Array.from({ length: GAME_SLOTS }, (_, i) => ({ dir: slotDir(i), entry: saves[i] }))
      if (this.mode === 'LISTLOAD') this.rows = this.rows.filter((r) => r.entry)
    } else if (this.mode === 'LISTALLDELETE') {
      const all: ListRow[] = []
      const c = readContinue()
      if (c) all.push({ dir: CONTINUE_DIR, entry: c })
      listGameSaves().forEach((e, i) => e && all.push({ dir: slotDir(i), entry: e }))
      this.rows = all
    }
  }

  private finish(result: number) {
    this.result = result
    this.st = 'closing'
    this.timer = 8
    this.w.closeAll()
  }

  private txt(addr: number) {
    return bootText(this.db, addr)
  }

  /** One frame: sceUtilitySavedataUpdate + the firmware's own input handling. */
  update(pressed: number, repeat: number, input?: PadInput) {
    this.w.tick()
    let P = pressed
    if (input) {
      this.w.updateHover(input)
      P |= this.pointer(input)
    }
    switch (this.st) {
      case 'open':
        // InitStart: a few frames before the dialog accepts input
        if (++this.timer < 8) return
        this.timer = 0
        this.st = this.mode === 'LISTSAVE' || this.mode === 'LISTLOAD' || this.mode === 'LISTALLDELETE' ? 'list' : this.mode === 'LOAD' ? 'loading' : this.mode === 'SAVE' ? 'saving' : 'deleting'
        if (this.st === 'list' && this.rows.length === 0) this.st = this.mode === 'LISTALLDELETE' ? 'closeNow' : 'nodata'
        if (this.mode === 'LOAD' && !readContinue()) this.st = 'nodata'
        return
      case 'closeNow':
        this.finish(UTIL_RESULT.OK)
        return
      case 'list': {
        const n = this.rows.length
        if (repeat & PAD.UP) this.cursor = (this.cursor + n - 1) % n
        else if (repeat & PAD.DOWN) this.cursor = (this.cursor + 1) % n
        else if (P & PAD.CIRCLE) this.finish(UTIL_RESULT.CANCEL)
        else if (P & PAD.CROSS) {
          const row = this.rows[this.cursor]
          this.slot = row.dir === CONTINUE_DIR ? -1 : Number(row.dir.slice(-2))
          if (this.mode === 'LISTLOAD') {
            this.loaded = row.entry?.bytes.slice() ?? null
            this.st = 'loading'
          } else if (this.mode === 'LISTSAVE') {
            this.yes = false
            this.st = 'confirm'
          } else {
            this.yes = false
            this.st = 'confirmErase'
          }
        }
        return
      }
      case 'confirm':
      case 'confirmErase':
        if (repeat & (PAD.LEFT | PAD.RIGHT)) this.yes = !this.yes
        else if (P & PAD.CIRCLE) this.st = 'list'
        else if (P & PAD.CROSS) {
          if (!this.yes) this.st = 'list'
          else if (this.st === 'confirm') this.st = 'saving'
          else {
            deleteSave(this.rows[this.cursor].dir)
            this.refreshRows()
            this.cursor = Math.min(this.cursor, Math.max(0, this.rows.length - 1))
            this.st = this.rows.length ? 'list' : 'closeNow'
          }
        }
        return
      case 'saving':
        if (++this.timer < 40) return
        this.timer = 0
        try {
          const b = this.data ?? new Uint8Array(0)
          const now = new Date().toISOString()
          if (this.mode === 'SAVE') writeSave(CONTINUE_DIR, b, { title: SFO_TITLE, savedataTitle: DEFAULT_SAVEDATA_TITLE, detail: CONTINUE_DETAIL, saved: now })
          else writeSave(this.rows[this.cursor].dir, b, { ...gameDataSfo(b), saved: now })
        } catch {
          // quota exceeded = no space on the Memory Stick
          this.finish(this.mode === 'SAVE' ? UTIL_RESULT.SAVE_NO_SPACE : UTIL_RESULT.LIST_NO_SPACE)
          return
        }
        // the list save ends with "Save completed."; SAVE (overwrite, no list) closes at once
        if (this.mode === 'LISTSAVE') this.st = 'saved'
        else this.finish(UTIL_RESULT.OK)
        return
      case 'loading':
        if (++this.timer < 30) return
        this.timer = 0
        if (this.mode === 'LOAD') this.loaded = readContinue()?.bytes.slice() ?? null
        if (!this.loaded) {
          this.st = 'nodata'
          return
        }
        if (this.mode === 'LISTLOAD') this.st = 'loadedMsg'
        else this.finish(UTIL_RESULT.OK)
        return
      case 'deleting':
        if (++this.timer < 30) return
        deleteSave(CONTINUE_DIR)
        this.finish(UTIL_RESULT.OK)
        return
      case 'saved':
      case 'loadedMsg':
        if (P & (PAD.CROSS | PAD.CIRCLE)) this.finish(UTIL_RESULT.OK)
        return
      case 'nodata':
        if (P & (PAD.CROSS | PAD.CIRCLE)) this.finish(UTIL_RESULT.LOAD_NO_DATA)
        return
      case 'closing':
        // ShutdownStart → status 0: the utility type goes back to None
        if (--this.timer <= 0) this.done = true
        return
    }
  }

  /** Mouse → the dialog's buttons: slots and Yes / No follow the pointer, clicks press ✕ / ○. */
  private pointer(input: PadInput): number {
    const click = (input.pressed & PAD.POINTER) !== 0
    const wins = this.w.wins
    switch (this.st) {
      case 'list': {
        for (let i = 0; i < this.rows.length; i++) {
          if (pointerHalf(input, wins.get(`row${i}`)) < 0) continue
          if (input.pointerMoved || click) this.cursor = i
          return click ? PAD.CROSS : 0
        }
        return clickButtons(input, wins.get('help'))
      }
      case 'confirm':
      case 'confirmErase': {
        const h = pointerHalf(input, wins.get('choice'))
        if (h < 0) return 0
        if (input.pointerMoved || click) this.yes = h === 0
        return click ? PAD.CROSS : 0
      }
      case 'saved':
      case 'loadedMsg':
      case 'nodata':
        return click ? PAD.CROSS : 0
    }
    return 0
  }

  /** The dialog as the firmware would show it, made of the game's windows. */
  draw(gl: GlRenderer, painter: WindowPainter) {
    const w = this.w
    const hover = w.hover
    w.rebuild()
    w.hover = hover
    const title = { LISTSAVE: 'Save', LISTLOAD: 'Load', LISTALLDELETE: 'Delete', SAVE: 'Save', LOAD: 'Load', AUTODELETE: 'Delete' }[this.mode]
    const st = this.st
    if (st === 'open' || st === 'closing' || this.mode === 'AUTODELETE') return
    // (ours) the firmware dialog covers the game's frame: a half-dark backdrop so the camp's windows
    // behind the stand-in do not mix with its text
    const Zd = 0x7fff / 65535
    const V = (x: number, y: number) => ({ x, y, w: 1, d: Zd, u: 0, v: 0 })
    gl.triangles(null, 'alpha', [V(0, 0), V(640, 0), V(0, 448), V(640, 0), V(640, 448), V(0, 448)], [0, 0, 0, 0.6])
    // layout (virtual 640×448): title 6..54, three slot windows 58..398 (6 lines of 14 px each), help 402..446
    w.open('title', 24, 6, gameText(title), 20, 0x3000, 10, 0x7f)
    if (st === 'list' || st === 'confirm' || st === 'confirmErase' || st === 'saved' || st === 'loadedMsg' || (st === 'saving' && this.mode === 'LISTSAVE') || (st === 'loading' && this.mode === 'LISTLOAD')) {
      this.rows.forEach((r, i) => {
        const e = r.entry
        let text: Uint8Array
        if (!e) text = this.txt(TXT.noData)
        else {
          const sfo = e.sfo
          const when = sfo?.saved ? new Date(sfo.saved) : null
          const date = when ? `${when.getFullYear()}/${String(when.getMonth() + 1).padStart(2, '0')}/${String(when.getDate()).padStart(2, '0')} ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}` : ''
          text = gameText(`${sfo?.savedataTitle ?? r.dir}\n${sfo?.detail ?? ''}\n${date}   ${Math.ceil(e.bytes.length / 1024)} KB`)
        }
        const win = w.open(`row${i}`, 72, SLOT_Y + i * (SLOT_H + 2), text, SLOT_GLYPH, 0, 10, 0x7f)
        win.w = 496
        win.h = SLOT_H
        win.bright = i === this.cursor ? 0x80 : 0x40
      })
    }
    const center = (key: string, text: Uint8Array) => w.open(key, 320, 224, text, 20, 0xf000, 10, 0x7f)
    const choice = () => w.open('choice', 320, 300, gameText(this.yes ? '> Yes     No' : '  Yes   > No'), 20, 0xf000, 10, 0x7f)
    switch (st) {
      case 'confirm':
        center('msg', this.txt(this.rows[this.cursor]?.entry ? TXT.mcOverwrite : TXT.mcNew))
        choice()
        break
      case 'confirmErase':
        center('msg', this.txt(TXT.mcErase))
        choice()
        break
      case 'saving':
        center('msg', gameText('Saving…'))
        break
      case 'loading':
        center('msg', gameText('Loading…'))
        break
      case 'deleting':
        break
      case 'saved':
        center('msg', this.txt(TXT.mcSaved))
        break
      case 'loadedMsg':
        center('msg', this.txt(TXT.mcLoaded))
        break
      case 'nodata':
        center('msg', gameText('There is no saved data.'))
        break
    }
    if (st === 'list') w.open('help', 24, 402, bootHelp(this.db), 16, 0x3000, 10, 0x7f)
    w.draw(gl, painter)
  }

  debug() {
    return `utility ${this.mode} ${this.st} cursor ${this.cursor}${this.done ? ` result 0x${(this.result >>> 0).toString(16)}` : ''}`
  }
}

/** The list's help line: the game's own button glyphs (＠ｂ０ ✕, ＠ｂ３ ○) with our words. */
function bootHelp(db: GameDb): Uint8Array {
  // "＠ｂ０" and "＠ｂ３" copied from the game's "＠ｂ０Ｙｅｓ ＠ｂ３Ｎｏ" (6 bytes each)
  const yn = bootText(db, TXT.yesNo)
  const b0 = yn.slice(0, 6)
  const i3 = yn.indexOf(0x97, 6)
  const b3 = yn.slice(i3 - 1, i3 + 5)
  return Uint8Array.from([...b0, ...gameText('Enter '), ...b3, ...gameText('Back ')])
}

/**
 * saveDataScene(op) (0x088A148C) with the sample layer: state 0 starts CB_SaveData_Normal(4 / 3 / 6 / 5)
 * (the SAVE ops serialize the data at InitStart: SetData_GameData); state 1 waits for the utility
 * (Savedata_Update: after a good op 5 load saveDeserializeGameData, after op 3
 * saveDeserializeContinue + g_resumeLoaded = 1 + CB_SaveData_Normal(10) delete); then the result: 0 →
 * DONE; 2 → the game's error windows (state 2, ○ → CANCEL); a no-space code → "Delete data to create
 * free space?" (state 0x14: ✕ → CB_SaveData_Normal(8) the delete list, ending in DONE once it
 * closes; ○ → CANCEL); anything else → CANCEL. It calls rand() on every call.
 */
export class SaveDataRunner {
  private st = 0
  util: SavedataUtility | null = null
  private utilOp = 0
  readonly wins: SaveWindows
  private ctx: SceneContext

  constructor(ctx: SceneContext) {
    this.ctx = ctx
    this.wins = new SaveWindows(ctx.assets.winTables)
  }

  private start(op: number) {
    const { state, assets } = this.ctx
    this.utilOp = op
    const db = state.db, t = assets.winTables
    switch (op) {
      case 3:
        this.util = new SavedataUtility('LOAD', db, t)
        break
      case 4:
        this.util = new SavedataUtility('SAVE', db, t, state.serializeContinue().slice())
        break
      case 5:
        this.util = new SavedataUtility('LISTLOAD', db, t)
        break
      case 6:
        this.util = new SavedataUtility('LISTSAVE', db, t, state.serializeGameData().slice())
        break
      case 8:
        this.util = new SavedataUtility('LISTALLDELETE', db, t)
        break
      case 10:
        this.util = new SavedataUtility('AUTODELETE', db, t)
        break
    }
  }

  /** GetUtilityType() == UType_None. */
  private utilIdle() {
    return !this.util || this.util.done
  }

  /** Savedata_Update: the utility's frame and the game's post-processing when it finishes. */
  private utilUpdate() {
    const u = this.util
    if (!u || u.done) return
    const { input, state } = this.ctx
    u.update(input.pressed, input.repeat, input)
    if (!u.done) return
    if (u.result !== 0) return
    if (this.utilOp === 5 && u.loaded) state.loadGameData(u.loaded)
    else if (this.utilOp === 3 && u.loaded) {
      state.loadContinue(u.loaded)
      state.resumeLoaded = 1
      this.start(10)
    }
  }

  run(op: number): SaveResult {
    const { input, state, audio } = this.ctx
    state.rng.rand()
    if (op === SAVEOP.BOOT_CHECK) return SAVERES.DONE
    this.wins.tick()
    this.wins.updateHover(input)
    this.utilUpdate()
    const db = state.db
    switch (this.st) {
      case 0:
        if (op === SAVEOP.SAVE_CONTINUE) this.start(4)
        else if (op === SAVEOP.LOAD_CONTINUE) this.start(3)
        else if (op === SAVEOP.SAVE_GAME) this.start(6)
        else if (op === SAVEOP.LOAD_GAME) this.start(5)
        else return SAVERES.BUSY
        this.st = 1
        break
      case 1:
        if (this.utilIdle()) {
          const r = this.util?.result ?? 0
          this.st = 0
          this.util = null
          if (r === 0) return SAVERES.DONE
          if (r === 2) {
            this.wins.open('msg', 300, 136, bootText(db, TXT.error), 0x16, 0xf000)
            this.wins.open('btn', 260, 180, bootText(db, TXT.back), 0x12, 0x3000)
            this.st = 2
          } else if (r === UTIL_RESULT.SAVE_NO_SPACE || r === UTIL_RESULT.LIST_NO_SPACE) {
            this.wins.open('msg', 300, 136, bootText(db, TXT.noSpaceAsk), 0x16, 0xf000)
            this.wins.open('btn', 260, 180, bootText(db, TXT.yesNo), 0x12, 0x7000)
            this.st = 0x14
          } else return SAVERES.CANCEL
        }
        break
      case 2:
        if (input.pressed & PAD.CIRCLE || clickButtons(input, this.wins.wins.get('btn'))) {
          this.st = 0
          this.wins.closeAll()
          return SAVERES.CANCEL
        }
        break
      case 0x14: {
        const click = clickButtons(input, this.wins.wins.get('btn'))
        if (input.pressed & PAD.CROSS || click === PAD.CROSS) {
          this.wins.closeAll()
          this.start(8)
          this.st = 1
          return SAVERES.BUSY
        }
        if (input.pressed & PAD.CIRCLE || click === PAD.CIRCLE) {
          this.st = 0
          this.wins.closeAll()
          return SAVERES.CANCEL
        }
        break
      }
    }
    void audio
    return SAVERES.BUSY
  }

  /** The utility dialog, then the game's own windows (menuWinUpdateAll). */
  draw(gl: GlRenderer) {
    const painter = this.ctx.assets.painter
    if (this.util && !this.util.done) this.util.draw(gl, painter)
    this.wins.draw(gl, painter)
  }

  debug() {
    return `saveDataScene state ${this.st}${this.util ? ` · ${this.util.debug()}` : ''}`
  }
}

/** Scenes 1000 / 0x44C (main): saveDataScene(1 / 0); DONE → g_saveReturnScene, CANCEL → g_saveCancelScene. */
export class SaveLoadGameScene implements Scene {
  readonly id: GameSceneId
  private runner: SaveDataRunner | null = null

  constructor(id: GameSceneId) {
    this.id = id
  }

  init(ctx: SceneContext) {
    this.runner = new SaveDataRunner(ctx)
  }

  update(ctx: SceneContext): GameSceneId {
    const r = this.runner!.run(this.id === GameScene.SAVE_GAME ? SAVEOP.SAVE_GAME : SAVEOP.LOAD_GAME)
    if (r === SAVERES.CANCEL) return ctx.state.session.saveCancelScene
    if (r === SAVERES.DONE) return ctx.state.session.saveReturnScene
    return this.id
  }

  draw(ctx: SceneContext) {
    const gl = ctx.screen.use('wide')
    gl.depthTest = false
    gl.begin([0, 0, 0])
    this.runner!.draw(gl)
    gl.end()
  }

  exit() {}

  debug() {
    return this.runner?.debug() ?? ''
  }
}

/**
 * resumeTempSaveScene (0x08835928, scene 0x208): state 0 opens "This data will be deleted after
 * loading. Is that all right?" (340, 136, size 22, 0xF000) and "Yes / Cancel" (240, 180, size 18,
 * 0x3000); ✕ → state 2, ○ → title. State 2 runs saveDataScene(2): while it is busy and
 * g_resumeLoaded is set, "Temporary data will be deleted." opens with a 60-frame timer; DONE →
 * state 3 counts the timer down, then the map (0x50); CANCEL → title.
 */
export class ResumeTempScene implements Scene {
  readonly id = GameScene.RESUME_TEMP
  private st = 0
  private timer = 0
  private runner: SaveDataRunner | null = null
  private wins: SaveWindows | null = null

  init(ctx: SceneContext) {
    this.st = 0
    this.runner = new SaveDataRunner(ctx)
    this.wins = new SaveWindows(ctx.assets.winTables)
  }

  update(ctx: SceneContext): GameSceneId {
    const { input, state, audio } = ctx
    const W = this.wins!
    W.tick()
    W.updateHover(input)
    const db = state.db
    if (this.st === 3) {
      if (this.timer < 1) {
        this.st = 0
        W.closeAll()
        return GameScene.MAP_BOARD
      }
      this.timer--
    } else if (this.st === 2) {
      const r = this.runner!.run(SAVEOP.LOAD_CONTINUE)
      if (r === SAVERES.BUSY) {
        if (state.resumeLoaded === 1) {
          state.resumeLoaded = 0
          this.timer = 0x3c
          W.open('msg', 340, 136, bootText(db, TXT.resumeDeleted), 0x16, 0xf000)
        }
      } else if (r === SAVERES.DONE) {
        if (this.timer < 1) {
          this.st = 0
          W.closeAll()
          return GameScene.MAP_BOARD
        }
        this.st = 3
      } else {
        this.st = 0
        return GameScene.TITLE
      }
    } else {
      if (this.st === 0) {
        W.open('msg', 340, 136, bootText(db, TXT.resumeAsk), 0x16, 0xf000)
        W.open('btn', 240, 180, bootText(db, TXT.resumeButtons), 0x12, 0x3000)
        this.st = 1
      }
      const click = clickButtons(input, W.wins.get('btn'))
      if (input.pressed & PAD.CROSS || click === PAD.CROSS) {
        audio.playSe(7)
        W.closeAll()
        state.resumeLoaded = 0
        this.timer = 0
        this.st = 2
      } else if (input.pressed & PAD.CIRCLE || click === PAD.CIRCLE) {
        audio.playSe(9)
        W.closeAll()
        this.st = 0
        return GameScene.TITLE
      }
    }
    return this.id
  }

  draw(ctx: SceneContext) {
    const gl = ctx.screen.use('wide')
    gl.depthTest = false
    gl.begin([0, 0, 0])
    this.runner!.draw(gl)
    this.wins!.draw(gl, ctx.assets.painter)
    gl.end()
  }

  exit() {}

  debug() {
    return `resume state ${this.st} timer ${this.timer} · ${this.runner?.debug() ?? ''}`
  }
}

/** The map board's Temp save (state 6000): saveDataScene(SAVE_CONTINUE) as MapBoardScene.tempSave, drawn over the board. */
export class TempSaveHook {
  private runner: SaveDataRunner

  constructor(ctx: SceneContext) {
    this.runner = new SaveDataRunner(ctx)
  }

  /** MapBoardScene.tempSave: 0 busy, 1 done, 2 cancelled. */
  step(): number {
    const r = this.runner.run(SAVEOP.SAVE_CONTINUE)
    return r === SAVERES.DONE ? 1 : r === SAVERES.CANCEL ? 2 : 0
  }

  get active() {
    return this.runner.util !== null || this.runner.wins.wins.size > 0
  }

  /** Over the board's 480×272 layer. */
  draw(gl: GlRenderer) {
    this.runner.draw(scaledGl(gl))
  }

  debug() {
    return this.runner.debug()
  }
}
