/**
 * The camp (campMenuScene 0x0881AE60, scene 300) and the stage select (stageSelectScene 0x0881CF08,
 * scene 0x136) of Play mode, ported from the code: the same windows (winOpenMenu / winOpenFrame /
 * winOpenMessage / winOpenFace at the same coordinates, sizes and flags), texts read from BOOT.BIN,
 * the same state machines, SE ids and pad handling, the images of etc.one 300 / 310 / 320 and the
 * face of chara.one. See docs/formats/camp-stage-select.md.
 */
import type { GlRenderer } from '../../effect/gl'
import type { GameDb } from '../../formats/gamedb'
import type { RgbaImage } from '../../formats/palette'
import type { Scene, SceneContext } from '../game'
import { GameScene, type GameSceneId } from '../gameScene'
import { PAD } from '../input'
import { NameEntry } from '../nameEntry'
import { dbGetDeckNameByDominator, decodeName, encodeSjis, nameBytes, PLAYER_DOMINATOR, type PlayerDeck } from '../profile'
import { drawNative, drawSpriteEx, spriteColor } from '../sprite2d'
import { BGM, MODE_FREE, MODE_STORY, type GameState } from '../state'
import { WinList } from '../winList'
import { SaveDataRunner, SAVEOP, SAVERES } from './saveScenes'

/** BOOT.BIN addresses of the camp and stage-select texts (read from the player's disc). */
const T = {
  // campDrawStatusWindows
  allCleared: 0x088a9b84, // "All maps cleared "
  spaceS: 0x088a9bc4, // " %s"
  unsearched: 0x088a9bc8, // "Unsearched map "
  blockA: 0x088a9bd8, // "Block A "
  blockB: 0x088a9be4, // "Block B "
  battlesFmt: 0x088a9bf0, // "Number of battles: ＠ｎ%14d battles ＠ｎWinning rate: %3d, %02d ％ "
  cardsFmt: 0x088a9c34, // "Number of cards: ＠ｎ%16d cards＠ｎCollection rate: %4d ％ "
  // campMenuOpenState / campMenuScene
  menuMain: 0x088a9c70, // "Search ＠ｎBuild deck ＠ｎCard list ＠ｎSystem "
  menuDeck: 0x088a9ca0, // "Edit ＠ｎCreate new ＠ｎCopy ＠ｎChange deck name ＠ｎDelete "
  slotsFmt: 0x088a9ce0, // "1.%s ＠ｎ2.%s ＠ｎ3.%s "
  copyAskFmt: 0x088a9cf8, // "Where would you like to copy ＠ｎ%s to? "
  menuSystem: 0x088a9d24, // "Save ＠ｎLoad ＠ｎBack to title "
  deleteAskFmt: 0x088a9d4c, // "Is it all right to delete ＠ｎ%s? "
  yesNo: 0x088a9d70, // "＠ｂ０Yes ＠ｂ３No "
  onlyDeck: 0x088a9d84, // "You cannot delete your only deck. "
  confirm: 0x088a9da8, // "＠ｂ０Confirm "
  noEdit: 0x088a9db8, // "There are no decks to edit. "
  noCopy: 0x088a9dd8, // "There are no decks to copy. "
  noDeck: 0x088a9df8, // "You have not created a deck. "
  noDelete: 0x088a9e18, // "There are no decks to delete. "
  createAfterDelete: 0x088a9e38, // "Please create a new deck after deleting the old one. "
  copyOccupied: 0x088a9e70, // "There is a saved deck in the copy destination. …"
  quitAsk: 0x088a9ee8, // "Returning to title screen. ＠ｎCurrent game data will disappear …"
  quitButtons: 0x088a9f5c, // "＠ｂ０To title ＠ｂ３Return "
  // stageSelectScene / stageSelectOpenState / charaDrawInfoWindow / stageDrawMapStats
  acceptReturn: 0x088a9f7c, // "＠ｂ０Accept ＠ｂ３Return "
  blockC: 0x088a9f98, // "Block C "
  floorFmt: 0x088a9fb0, // "B%dF "
  charaStatsFmt: 0x088a9fb8, // "HP: %2d AP: %d ＠ｎMove %d "
  charaBattlesFmt: 0x088a9fd4, // "No.of battles: %6d "
  terrainFmt: 0x088a9fe8, // "Total land: %5d ＠ｎEarth: %d ＠ｎWater: %d ＠ｎFire: %d Air: %d "
  recordFmt: 0x088aa02c, // "No.of battles: ＠ｎ%8d battles ＠ｎNo.of wins: ＠ｎ%8d wins "
  letters: [0x088aa06c, 0x088aa070, 0x088aa074], // "A ", "B ", "C "
  mapConfirmFmt: 0x088aa0e0, // "Map： %s- %s ＠ｎOpponent： %s ＠ｎDeck used： %s "
  returningCamp: 0x088aa114, // "Returning to camp. "
  toCamp: 0x088aa128, // "＠ｂ０To camp ＠ｂ３Cancel "
  acceptCancel: 0x088aa144, // "＠ｂ０Accept ＠ｂ３Cancel "
} as const

function cstr(db: GameDb, addr: number, max = 256): Uint8Array {
  const b = db.raw.bytes(addr, max)
  const e = b.indexOf(0)
  return b.slice(0, e < 0 ? b.length : e)
}

const strz = (b: Uint8Array) => {
  const e = b.indexOf(0)
  return b.subarray(0, e < 0 ? b.length : e)
}

/** sprintf over Shift-JIS bytes: %s (bytes), %d with the 0 flag and a width, %%. */
export function sprintfBytes(fmt: Uint8Array, args: (number | Uint8Array)[]): Uint8Array {
  const out: number[] = []
  let ai = 0
  for (let i = 0; i < fmt.length && fmt[i]; i++) {
    const c = fmt[i]
    if ((c >= 0x81 && c <= 0x9f) || (c >= 0xe0 && c <= 0xfc)) {
      out.push(c, fmt[i + 1] ?? 0)
      i++
      continue
    }
    if (c !== 0x25) {
      out.push(c)
      continue
    }
    let j = i + 1, zero = false, width = 0
    if (fmt[j] === 0x30) {
      zero = true
      j++
    }
    while (fmt[j] >= 0x30 && fmt[j] <= 0x39) width = width * 10 + fmt[j++] - 0x30
    const conv = fmt[j]
    if (conv === 0x64) {
      const v = Math.trunc(Number(args[ai++] ?? 0))
      let s = String(Math.abs(v))
      if (zero) s = s.padStart(width - (v < 0 ? 1 : 0), '0')
      if (v < 0) s = '-' + s
      s = s.padStart(width, ' ')
      for (const ch of s) out.push(ch.charCodeAt(0))
    } else if (conv === 0x73) {
      const a = args[ai++]
      if (a instanceof Uint8Array) out.push(...strz(a))
    } else if (conv === 0x25) out.push(0x25)
    i = j
  }
  return Uint8Array.from(out)
}

/** A deck name as the char[24] bytes up to the NUL. */
const deckName = (d: PlayerDeck) => strz(nameBytes(d.name, d.nameRaw))

/** charaGetLadderId(i): g_charaLadderOrder[i], entry 0 for i ≥ 19. */
function ladderId(db: GameDb, i: number): number {
  return db.ladder[i < 0x13 ? i : 0] ?? db.ladder[0] ?? PLAYER_DOMINATOR
}

/** charaGetLadderIndex(id): the last index holding id, stopping at the next 1001 after index 0. */
function ladderIndex(db: GameDb, id: number): number {
  const L = db.ladder
  let res = 0
  for (let k = 0; k < 64; k++) {
    const v = L[k > 0x12 ? 0 : k] ?? L[0]
    if (v === id) res = k
    if (k > 0 && v === PLAYER_DOMINATOR) break
  }
  return res
}

/** charaIdToIndex: 1001 → 1, 1002..1011 → 2..11, the rematch cards 1012..1021 → 2..11. */
function charaIndex(id: number): number {
  if (id >= 1002 && id <= 1011) return id - 1000
  if (id >= 1012 && id <= 1021) return id - 1010
  return 1
}

/**
 * The face for face key 100 + chara index: msgLoadFaces(0, 0) (stageSelectLoadAssets) fills the face
 * cache with chara.one entry 1000 members 1..11 under keys 101..111 (the default faces), so every
 * opponent, a rematch card included, shows its character's default face.
 */
function faceImage(ctx: SceneContext, id: number): RgbaImage | null {
  return ctx.assets.image('chara.one', 1000, charaIndex(id))
}

/** mapFormatAreaName(dst, areaIndex 0..9, 0): the area name (areaNames is indexed by area 1..10). */
function areaName(ctx: SceneContext, idx: number): Uint8Array {
  return ctx.assets.mapTables.areaNames[idx + 1] ?? new Uint8Array(0)
}

// =============================================================================================
// campMenuScene

/** g_campMenuState. */
const CS = {
  LOAD: 0,
  WAIT: 1,
  MAIN: 2,
  DECK_MENU: 3,
  DECK_SLOT: 4,
  COPY_TO: 7,
  RENAME: 8,
  DELETE_ASK: 9,
  MESSAGE: 10,
  SYSTEM: 0xd,
  SAVE: 0xe,
  LOAD_GAME: 0xf,
  QUIT_ASK: 0x11,
  EXIT: 0x12,
} as const

/**
 * campMenuScene (g_campMenuState 0x0898BAF4?): 0 campMenuLoadAssets (winReset of the ten camp windows,
 * etc.one 300/2 background 480×272 and 300/3 Galahad 448×448, card GANs once) → 1 once loaded:
 * campMenuOpenState(2) and bgmPlay(0, 0xF) → 2 the main menu (Search → 0x136, Build deck → 3,
 * Card list → 0x14A, System → 0xD; SE 7 for every ✕) … (see the doc for the full table). A chosen
 * scene goes through state 0x12 on the next frame (sprites freed, winCloseAll, bgmStop(0)).
 * Every frame (not while loading): the background at (0, 0) in screen pixels, 300/3 at (0xC0, 0)
 * with the main menu's brightness and alpha, then menuWinUpdateAll.
 */
export class CampScene implements Scene {
  readonly id = GameScene.CAMP
  st: number = CS.LOAD
  private W: WinList | null = null
  private entry: NameEntry | null = null
  private runner: SaveDataRunner | null = null
  private next: GameSceneId = GameScene.CAMP
  private loading = true

  init(ctx: SceneContext) {
    this.st = CS.LOAD
    this.W = new WinList(ctx.assets.winTables)
    this.entry = null
    this.runner = null
    this.next = GameScene.CAMP
  }

  private txt(ctx: SceneContext, a: number) {
    return cstr(ctx.state.db, a)
  }

  /** winOpenMessage + the "＠ｂ０Confirm" prompt below its centre (states 10 / 11). */
  private message(ctx: SceneContext, text: Uint8Array) {
    const W = this.W!
    const m = W.openMessage('c.msg', 320, 224, text, 0x16, 0xf000)
    W.openMessage('c.prompt', 320, m.y + m.h / 2, this.txt(ctx, T.confirm), 0x14, 0x7000)
  }

  /** campMenuOpenState(state). */
  private openState(ctx: SceneContext, state: number) {
    const W = this.W!
    const st = ctx.state
    switch (state) {
      case 0xd:
        W.openMenu('c.sub', 16, 168, 0x16, this.txt(ctx, T.menuSystem))
        W.addFlags('c.sub', 0x800)
        break
      case 7: {
        const d = st.decks[st.profile.curDeckSlot - 1]
        const text = sprintfBytes(this.txt(ctx, T.copyAskFmt), [d ? deckName(d) : new Uint8Array(0)])
        W.openMessage('c.msg', 184, 48, text, 0x16, 0x3000)
        W.bringToFront('c.slot')
        break
      }
      case 4: {
        const text = sprintfBytes(this.txt(ctx, T.slotsFmt), st.decks.map(deckName))
        W.openMenu('c.slot', 184, 168, 0x16, text)
        W.addFlags('c.slot', 0x800)
        break
      }
      case 3:
        W.openMenu('c.sub', 16, 168, 0x16, this.txt(ctx, T.menuDeck))
        W.addFlags('c.sub', 0x800)
        break
      case 2: {
        W.openFrame('c.unsearched', 16, 168, 250, 20, 5, 7, 0)
        const rec = W.openFrame('c.record', 16, 0, 251, 146, 5, 7, 0)
        rec.y = 448 - rec.h - 16
        const dl = W.openFrame('c.decks', 0, 0, 273, 89, 5, 7, 0)
        dl.x = 640 - dl.w - 8
        dl.y = 448 - dl.h - 8
        this.drawStatus(ctx)
        W.openMenu('c.main', 16, 48, 0x16, this.txt(ctx, T.menuMain))
        W.addFlags('c.main', 0x800)
        break
      }
    }
  }

  /**
   * campDrawStatusWindows (0x0881A598): the first area with an unlocked, uncleared block ("Unsearched
   * map" + its name, and "Block A" / "Block B" lines when block B exists; h 64 + 23 per line), the
   * battle totals and winning rate over charaBattles / charaWins[0..18], the card totals from
   * cardCountCollection (written back into the profile; collection rate kinds·100 / 206, at least 1),
   * and the three deck names.
   */
  drawStatus(ctx: SceneContext) {
    const W = this.W!
    const st = ctx.state, p = st.profile
    const cleared = (s: number) => s > 0 && (p.stageClearMask >>> (s - 1)) & 1
    W.freeGlyphs('c.unsearched')
    let area = 0, bits = 0
    for (;;) {
      bits = 0
      const a = st.stageIfUnlocked(area + 1, 0)
      if (a && !cleared(a)) bits = 1
      const b = st.stageIfUnlocked(area + 1, 1)
      if (b && !cleared(b)) bits |= 2
      if (bits || area + 1 > 9) {
        if (!bits) area++
        break
      }
      area++
    }
    // all areas done: area 10 → "All maps cleared" once stage 18 is cleared (bit 17), else the last area
    if (area > 9 && !((p.stageClearMask >>> 17) & 1)) area = 9
    const name = area < 10 ? areaName(ctx, area) : this.txt(ctx, T.allCleared)
    const line = sprintfBytes(this.txt(ctx, T.spaceS), [name])
    W.print('c.unsearched', 0, 0, 0x14, this.txt(ctx, T.unsearched))
    W.print('c.unsearched', -0xb, 0x15, 0x16, line)
    const uw = W.get('c.unsearched')
    if (uw) {
      uw.h = 64
      if (area < 10 && st.stageIfUnlocked(area + 1, 1)) {
        uw.h += 23
        if (!(bits & 1)) W.print('c.unsearched', 0x73, 0x2c, 0x16, this.txt(ctx, T.blockB))
        else {
          W.print('c.unsearched', 0x73, 0x2c, 0x16, this.txt(ctx, T.blockA))
          if (bits & 2) {
            W.print('c.unsearched', 0x73, 0x43, 0x16, this.txt(ctx, T.blockB))
            uw.h += 23
          }
        }
      }
    }
    W.freeGlyphs('c.record')
    let wins = 0, battles = 0
    for (let i = 0; i < 19; i++) {
      wins += p.charaWins[i]
      battles += p.charaBattles[i]
    }
    wins >>>= 0
    battles >>>= 0
    let rate = 0, frac = 0
    if (wins !== 0) {
      rate = Math.trunc((wins * 100) / battles) >>> 0
      const f = Math.floor(Math.fround(Math.fround(Math.fround(wins * 100) / Math.fround(battles)) * 100))
      frac = (f >>> 0) % 100
    }
    W.print('c.record', 0, 0, 0x14, sprintfBytes(this.txt(ctx, T.battlesFmt), [battles, rate, frac]))
    st.recountProfile()
    let coll = Math.trunc((p.cardKinds * 100) / 0xce)
    if (coll === 0) coll = 1
    W.print('c.record', 0, 0x3f, 0x14, sprintfBytes(this.txt(ctx, T.cardsFmt), [p.totalCards, coll]))
    W.freeGlyphs('c.decks')
    st.decks.forEach((d, i) => W.print('c.decks', 0, i * 0x17, 0x16, deckName(d)))
  }

  private empty(st: GameState, i: number) {
    return (st.decks[i]?.name ?? '') === ''
  }

  update(ctx: SceneContext): GameSceneId {
    const { input, audio, state: st } = ctx
    const W = this.W!
    const se = (id: number) => audio.playSe(id)
    // mouse (ours): the help labels ("✕ Yes ○ No", "✕ Confirm" …), and a click anywhere answers the
    // messages and yes / no questions; name entry and the save dialog read the mouse themselves
    const s0 = this.st
    W.hover = null
    if (s0 !== CS.LOAD && s0 !== CS.WAIT && s0 !== CS.RENAME && s0 !== CS.SAVE && s0 !== CS.LOAD_GAME)
      W.helpMouse(input, s0 === CS.MESSAGE || s0 === 0xb || s0 === CS.DELETE_ASK || s0 === CS.QUIT_ASK)
    let P = input.pressed
    let next: GameSceneId = GameScene.CAMP
    if (this.st !== CS.LOAD) {
      // the status frames follow the main menu's dimming
      const b = W.get('c.main')?.bright ?? 0x80
      for (const k of ['c.record', 'c.unsearched', 'c.decks']) {
        const w = W.get(k)
        if (w) w.bright = b
      }
    }
    switch (this.st) {
      case CS.LOAD:
        this.st = CS.WAIT
        this.loading = true
        W.closeAll()
        break
      case CS.WAIT:
        this.loading = false
        this.openState(ctx, 2)
        audio.playBgm(BGM.camp)
        this.st = CS.MAIN
        break
      case CS.MAIN:
        W.fadeClose('c.sub', 10)
        W.fadeClose('c.slot', 10)
        if (!W.isOpen('c.sub') && !W.isOpen('c.slot')) {
          W.updateInput('c.main', input, se)
          P = input.pressed // a click on a row is ✕
          if (P & PAD.CROSS) {
            const c = W.cursor('c.main')
            if (c === 3) {
              this.openState(ctx, 0xd)
              this.st = CS.SYSTEM
            } else if (c === 2) next = GameScene.CARD_LIST
            else if (c === 1) {
              this.openState(ctx, 3)
              this.st = CS.DECK_MENU
            } else if (c === 0) next = GameScene.STAGE_SELECT
            se(7)
          }
        }
        break
      case CS.DECK_MENU:
        W.fadeClose('c.slot', 10)
        if (!W.isOpen('c.slot')) {
          W.updateInput('c.sub', input, se)
          P = input.pressed // a click on a row is ✕
          if (P & PAD.CROSS) {
            this.openState(ctx, 4)
            se(7)
            this.st = CS.DECK_SLOT
          } else if (P & PAD.CIRCLE) {
            se(9)
            this.st = CS.MAIN
          }
        }
        break
      case CS.DECK_SLOT:
        W.fadeClose('c.msg', 10)
        W.fadeClose('c.prompt', 10)
        if (!W.isOpen('c.msg') && !W.isOpen('c.prompt')) {
          W.updateInput('c.slot', input, se)
          P = input.pressed // a click on a row is ✕
          if (P & PAD.CROSS) {
            const slot = W.cursor('c.slot')
            st.profile.curDeckSlot = slot + 1
            const op = W.cursor('c.sub')
            if (op === 1) {
              // Create new: only into an empty slot
              if (this.empty(st, slot)) {
                se(7)
                next = GameScene.DECK_EDIT
              } else {
                this.message(ctx, this.txt(ctx, T.createAfterDelete))
                se(10)
                this.st = CS.MESSAGE
              }
            } else if (op === 0 || op === 2 || op === 3 || op === 4) {
              if (this.empty(st, slot)) {
                const t = op === 0 ? T.noEdit : op === 2 ? T.noCopy : op === 3 ? T.noDeck : T.noDelete
                se(10)
                this.message(ctx, this.txt(ctx, t))
                this.st = CS.MESSAGE
              } else if (op === 4) {
                let n = 0
                for (let i = 0; i < 3; i++) if (!this.empty(st, i)) n++
                let text: Uint8Array
                if (n < 2) {
                  text = this.txt(ctx, T.onlyDeck)
                  this.st = CS.MESSAGE
                  W.openMessage('c.prompt', 320, 0, this.txt(ctx, T.confirm), 0x14, 0x7000)
                  se(10)
                } else {
                  text = sprintfBytes(this.txt(ctx, T.deleteAskFmt), [deckName(st.decks[slot])])
                  this.st = CS.DELETE_ASK
                  W.openMessage('c.prompt', 320, 0, this.txt(ctx, T.yesNo), 0x14, 0x7000)
                  se(7)
                }
                const m = W.openMessage('c.msg', 320, 224, text, 0x16, 0xf000)
                const pr = W.get('c.prompt')
                // (the prompt was opened first, so the message is the later window, as in the game)
                if (pr) pr.y = m.y + m.h / 2
              } else {
                if (op === 0) next = GameScene.DECK_EDIT
                else if (op === 2) {
                  this.openState(ctx, 7)
                  this.st = CS.COPY_TO
                } else if (op === 3) {
                  // nameEntryInit(&g_playerDecks[slot], name): the keyboard opens over the camp windows
                  const ne = new NameEntry(st.db, ctx.assets.winTables, W)
                  ne.mode = 1
                  ne.init(deckName(st.decks[slot]))
                  this.entry = ne
                  this.st = CS.RENAME
                }
                se(7)
              }
            }
          } else if (P & PAD.CIRCLE) {
            se(9)
            this.st = CS.DECK_MENU
          }
        }
        break
      case CS.COPY_TO:
        W.updateInput('c.slot', input, se)
        P = input.pressed // a click on a row is ✕
        if (P & PAD.CROSS) {
          const to = W.cursor('c.slot')
          if (this.empty(st, to)) {
            const from = st.decks[st.profile.curDeckSlot - 1]
            const dst = st.decks[to]
            // the 12-halfword name loop copies all 24 bytes (stale bytes after the NUL included)
            dst.nameRaw = nameBytes(from.name, from.nameRaw)
            dst.name = from.name
            dst.cards.set(from.cards)
            dst.unk58 = from.unk58
            dst.unk5C = from.unk5C
            W.close('c.slot')
            this.openState(ctx, 4)
            se(7)
            this.st = CS.DECK_SLOT
          } else {
            this.message(ctx, this.txt(ctx, T.copyOccupied))
            se(10)
            this.st = CS.MESSAGE
          }
        } else if (P & PAD.CIRCLE) {
          se(9)
          this.st = CS.DECK_SLOT
        }
        if (this.st !== CS.COPY_TO) this.drawStatus(ctx)
        break
      case CS.RENAME: {
        const ne = this.entry!
        const r = ne.update(input.pressed, input.repeat, audio, input)
        if (ne.result) {
          // state 4 ✕: sprintf(&g_playerDecks[slot].name, "%s", name): the bytes after the NUL stay
          const d = st.decks[W.cursor('c.slot')]
          const b = nameBytes(d.name, d.nameRaw)
          b.set(ne.result.subarray(0, 23))
          b[Math.min(23, ne.result.length)] = 0
          d.nameRaw = b
          d.name = decodeName(b, 0)
          ne.result = null
        }
        if (r === -1) this.st = CS.DECK_SLOT
        else if (r === 1) {
          W.close('c.slot')
          this.openState(ctx, 4)
          this.st = CS.DECK_SLOT
        }
        if (this.st !== CS.RENAME) {
          this.entry = null
          this.drawStatus(ctx)
        }
        break
      }
      case CS.DELETE_ASK:
        if (P & PAD.CROSS) {
          const d = st.decks[W.cursor('c.slot')]
          // sprintf(name, ""): only the first byte becomes NUL
          const b = nameBytes(d.name, d.nameRaw)
          b[0] = 0
          d.nameRaw = b
          d.name = ''
          d.cards.fill(0)
          d.unk58 = 0
          d.unk5C = 0
          W.close('c.slot')
          this.openState(ctx, 4)
          se(7)
          this.st = CS.DECK_SLOT
        } else if (P & PAD.CIRCLE) {
          se(9)
          this.st = CS.DECK_SLOT
        }
        if (this.st !== CS.DELETE_ASK) this.drawStatus(ctx)
        break
      case CS.MESSAGE:
      case 0xb:
        if (P & (PAD.CROSS | PAD.CIRCLE)) {
          W.close('c.msg')
          W.close('c.prompt')
          se(9)
          this.st = CS.DECK_SLOT
        }
        break
      case CS.SYSTEM:
        W.updateInput('c.sub', input, se)
        P = input.pressed // a click on a row is ✕
        if (P & PAD.CROSS) {
          se(7)
          const c = W.cursor('c.sub')
          if (c === 2) {
            const m = W.openMessage('c.msg', 320, 224, this.txt(ctx, T.quitAsk), 0x16, 0xf000)
            m.style = 10
            m.w += 10
            m.h += 10
            const pr = W.openMessage('c.prompt', 320, 224, this.txt(ctx, T.quitButtons), 0x14, 0x7000)
            pr.style = 10
            pr.w += 10
            pr.h += 10
            this.st = CS.QUIT_ASK
            pr.y = m.y + m.h / 2
          } else if (c === 1) this.st = CS.LOAD_GAME
          else if (c === 0) this.st = CS.SAVE
        } else if (P & PAD.CIRCLE) {
          se(9)
          this.st = CS.MAIN
        }
        break
      case CS.SAVE:
      case CS.LOAD_GAME: {
        // saveDataScene(SAVE_GAME / LOAD_GAME) inside the camp, then the status is redrawn
        this.runner ??= new SaveDataRunner(ctx)
        const r = this.runner.run(this.st === CS.SAVE ? SAVEOP.SAVE_GAME : SAVEOP.LOAD_GAME)
        if (r === SAVERES.CANCEL || r === SAVERES.DONE) {
          this.runner = null
          this.drawStatus(ctx)
          this.st = CS.SYSTEM
        }
        break
      }
      case CS.QUIT_ASK:
        if (P & PAD.CROSS) {
          se(7)
          next = GameScene.TITLE
        } else if (P & PAD.CIRCLE) {
          se(9)
          this.st = CS.SYSTEM
        }
        if (this.st !== CS.QUIT_ASK) {
          W.close('c.msg')
          W.close('c.prompt')
          this.drawStatus(ctx)
        }
        break
      case CS.EXIT: {
        // sprites freed (the card GANs too when leaving for the stage select or the title), winCloseAll, bgmStop(0)
        W.closeAll()
        audio.stopBgm()
        this.st = CS.LOAD
        return this.next
      }
    }
    if (next !== GameScene.CAMP) {
      this.next = next
      this.st = CS.EXIT
    }
    if (!this.loading) W.tick()
    return this.id
  }

  draw(ctx: SceneContext) {
    if (this.loading) return
    const gl = ctx.screen.use('wide')
    gl.depthTest = false
    gl.begin([0, 0, 0])
    this.drawScene(ctx, gl)
    gl.end()
  }

  /** The background, Galahad with the main menu's brightness / alpha, the windows, the save dialog on top. */
  private drawScene(ctx: SceneContext, gl: GlRenderer) {
    const a = ctx.assets
    drawNative(gl, a.image('etc.one', 300, 2))
    const m = this.W!.get('c.main')
    const b = m?.bright ?? 0x80
    const img = a.image('etc.one', 300, 3)
    if (img) drawSpriteEx(gl, img, 0, 0, img.width, img.height, 0xc0, 0, { color: spriteColor(b, b, b, m?.alpha ?? 0x80) })
    this.W!.draw(gl, a.painter)
    this.runner?.draw(gl)
  }

  exit() {}

  debug() {
    const W = this.W
    return `camp state 0x${this.st.toString(16)} · main ${W?.cursor('c.main') ?? 0} · sub ${W?.cursor('c.sub') ?? 0} · slot ${W?.cursor('c.slot') ?? 0}${this.entry ? ` · entry state ${this.entry.state} "${this.entry.nameText}"` : ''}${this.runner ? ` · ${this.runner.debug()}` : ''}`
  }
}

// =============================================================================================
// stageSelectScene

/** g_stageSelState. */
const SS = {
  INIT: 0,
  LOAD: 1,
  AREA: 2,
  OPPONENT: 3,
  DECK: 4,
  CONFIRM: 5,
  CONFIRM_UNUSED: 6,
  TO_CAMP: 7,
  GO: 8,
} as const

/**
 * stageSelectScene: 0 winReset of the eleven windows, area title (mapFormatAreaName, 320, 32, glyph
 * 24, 0xF000), help "Accept / Return" (244, 402, 0x3000), stageSelectLoadAssets (etc.one 300/6 the
 * block labels, 310/(i+1)·100 the area plates 208×70, 320/i·100+v+101 the 400×240 previews and
 * +111 their grid overlays, the face cache) → 1 once loaded: bgmPlay(0, 0xF), stageSelectOpenState(2)
 * → 2 the area list … (full table in the doc). ✕ in state 5 → 8: the decks (DuelPlayer 0 = the slot's
 * cards with Dominator 1001, DuelPlayer 1 = dbGetDeckByDominator(opponent, mode 1 ? 3 : 1)), the
 * Dominators' names, 2 players → 0x50. ○ in state 2 → 7 "Returning to camp." → ✕ → 300.
 */
export class StageSelectScene implements Scene {
  readonly id = GameScene.STAGE_SELECT
  st: number = SS.INIT
  private W: WinList | null = null
  /** g_stageSelArea (0-based), g_stageSelBlock, g_stageSelCursorRow / ScrollTop, g_stageSelOpponentIdx / Id. */
  area = 0
  block = 0
  private cursorRow = 0
  private scrollTop = 0
  oppIdx = 0
  oppId = 0
  private loading = true
  /** Mouse (ours): the block a click on a plate's block strip picked this frame (−1 none). */
  private blockPick = -1

  init(ctx: SceneContext) {
    this.W = new WinList(ctx.assets.winTables)
    this.st = SS.INIT
  }

  private txt(ctx: SceneContext, a: number) {
    return cstr(ctx.state.db, a)
  }

  private openAreaTitle(ctx: SceneContext) {
    const W = this.W!
    W.close('s.title')
    W.openMessage('s.title', 320, 32, areaName(ctx, this.area), 0x18, 0xf000)
  }

  /** stagePrintFloorBlock inlined: "B%dF" (area + 1) at x 0 and "Block A/B/C" at x 100, glyph 22. */
  private printBlock(ctx: SceneContext) {
    const W = this.W!
    W.freeGlyphs('s.block')
    W.print('s.block', 0, 0, 0x16, sprintfBytes(this.txt(ctx, T.floorFmt), [this.area + 1]))
    W.print('s.block', 100, 0, 0x16, this.txt(ctx, [T.blockA, T.blockB, T.blockC][this.block] ?? T.blockA))
  }

  /**
   * stageDrawMapStats(area, block): the board's land counts (mapLoadTerrain: total, earth, water, fire,
   * air) and the stage record mapBattles / mapWins of dbGetMapLayoutId (layout 17 adds stage 18's).
   */
  private drawMapStats(ctx: SceneContext) {
    const W = this.W!
    const st = ctx.state, p = st.profile
    const board = st.db.maps.find((m) => m.area === this.area + 1 && m.variant === this.block)
    let lay = board?.stage ?? 0
    if (lay < 1) lay = 1
    const c = board?.attrCounts ?? [0, 0, 0, 0]
    W.freeGlyphs('s.terrain')
    W.print('s.terrain', 0, 0, 0x15, sprintfBytes(this.txt(ctx, T.terrainFmt), [board?.squares ?? 0, c[0], c[1], c[2], c[3]]))
    let battles = p.mapBattles[lay - 1], wins = p.mapWins[lay - 1]
    if (lay === 0x11) {
      battles += p.mapBattles[0x11]
      wins += p.mapWins[0x11]
    }
    W.freeGlyphs('s.record')
    W.print('s.record', 0, 0, 0x15, sprintfBytes(this.txt(ctx, T.recordFmt), [battles >>> 0, wins >>> 0]))
  }

  /** charaDrawInfoWindow(id): name (glyph 32), deck name, "HP / AP / Move", battles against it; the face key. */
  private drawCharaInfo(ctx: SceneContext, id: number) {
    const W = this.W!
    const st = ctx.state, db = st.db
    const li = ladderIndex(db, id)
    const cw = W.get('s.chara')
    const x = Math.trunc((cw?.w ?? 480) / 2 - 48)
    const card = db.byId.get(id)
    W.freeGlyphs('s.chara')
    W.print('s.chara', x, 1, 0x20, db.raw.cardStrings.get(id)?.name ?? encodeSjis(card?.name ?? ''))
    W.print('s.chara', x, 0x21, 0x16, encodeSjis(dbGetDeckNameByDominator(db, id)))
    W.print('s.chara', x, 0x38, 0x16, sprintfBytes(this.txt(ctx, T.charaStatsFmt), [card?.hp ?? 0, card?.ap ?? 0, card?.move ?? 0]))
    W.print('s.chara', x, 0x7d, 0x16, sprintfBytes(this.txt(ctx, T.charaBattlesFmt), [st.profile.charaBattles[li] >>> 0]))
    // g_stageSelFaceWin.faceKey = charaIdToIndex(id) + 100 (the face alpha is not reset)
    const fw = W.get('s.face')
    if (fw) fw.face = faceImage(ctx, id)
  }

  /** stageSelectOpenState(state). */
  private openState(ctx: SceneContext, state: number) {
    const W = this.W!
    const st = ctx.state
    switch (state) {
      case 2: {
        W.close('s.help')
        const h = W.openMessage('s.help', 244, 0, this.txt(ctx, T.acceptReturn), 0x14, 0x3000)
        h.y = 448 - h.h
        // (the " ＠ｎ ＠ｎ ＠ｎEarth / Water / Fire / Air" labels printed into the terrain window here are
        // freed again by stageDrawMapStats below: they never show)
        W.openFrame('s.areas', 4, 106, 232, 338, 0, 7, 0)
        let n = 0
        while (st.stageIfUnlocked(n + 1, 0) && n + 1 < 10) n++
        if (st.stageIfUnlocked(n + 1, 0)) n++
        W.addFlags('s.areas', 0x10014)
        const aw = W.get('s.areas')!
        aw.glyph = 0x48
        aw.menu = { row: this.cursorRow, offX: 8, offY: 9, cursorW: 200, color: [0x10, 0x80, 0xf0, 0x40], itemCount: n, visibleRows: Math.min(4, n), scrollTop: this.scrollTop }
        W.setCursor('s.areas', this.cursorRow, this.scrollTop)
        W.openFrame('s.block', 4, 64, 232, 38, 0, 7, 0x800)
        this.printBlock(ctx)
        W.openFrame('s.terrain', aw.x + aw.w + 8, 288, 196, 112, 0, 7, 0)
        const tw = W.get('s.terrain')!
        W.openFrame('s.record', tw.x + tw.w + 4, 288, 196, 112, 0, 7, 0)
        this.drawMapStats(ctx)
        break
      }
      case 3: {
        W.close('s.help')
        W.openMessage('s.help', 320, 402, this.txt(ctx, T.acceptReturn), 0x14, 0x7000)
        W.openFrame('s.chara', 320, 206, 480, 196, 0, 7, 0)
        W.addFlags('s.chara', 0x4800)
        // winOpenFace(96, 224, 160, 160, face of 1002, expr 1, 0x800) with drawStyle 0: only the face shows
        const fw = W.openFace('s.face', 96, 224, 160, 160, faceImage(ctx, 0x3ea), 0x800)
        fw.style = 0
        this.drawCharaInfo(ctx, this.oppId)
        break
      }
      case 4: {
        const text = sprintfBytes(this.txt(ctx, T.slotsFmt), st.decks.map(deckName))
        W.openMenu('s.deck', 240, 64, 0x16, text)
        W.addFlags('s.deck', 0x800)
        break
      }
      case 5: {
        const slot = W.cursor('s.deck')
        const opp = st.db.raw.cardStrings.get(this.oppId)?.name ?? new Uint8Array(0)
        const text = sprintfBytes(this.txt(ctx, T.mapConfirmFmt), [areaName(ctx, this.area), this.txt(ctx, T.letters[this.block] ?? T.letters[0]), opp, deckName(st.decks[slot])])
        const w = W.openMessage('s.confirm', 320, 224, text, 0x16, 0xe000)
        w.w = 350
        break
      }
      case 7:
        W.openMessage('s.confirm', 244, 124, this.txt(ctx, T.returningCamp), 0x16, 0x3000)
        W.setText('s.help', this.txt(ctx, T.toCamp))
        break
    }
  }

  update(ctx: SceneContext): GameSceneId {
    const { input, audio, state: st } = ctx
    const W = this.W!
    const se = (id: number) => audio.playSe(id)
    this.mouse(ctx)
    let P = input.pressed
    const s = this.st
    if (s === SS.TO_CAMP || s === SS.AREA) {
      const b = W.get('s.block')?.bright ?? 0x80
      for (const k of ['s.terrain', 's.areas', 's.record']) {
        const w = W.get(k)
        if (w) w.bright = b
      }
    } else for (const k of ['s.block', 's.areas', 's.terrain', 's.record']) W.fadeClose(k, 10)
    if (s === SS.TO_CAMP || s === SS.AREA) {
      W.fadeClose('s.chara', 10)
      W.fadeClose('s.face', 10)
    } else {
      const c = W.get('s.chara'), f = W.get('s.face')
      if (c && f) c.bright = f.bright
    }
    if (s !== SS.TO_CAMP && s !== SS.CONFIRM_UNUSED && s !== SS.CONFIRM) {
      W.fadeClose('s.confirm', 10)
      W.fadeClose('s.prompt', 10)
    }
    if (s !== SS.CONFIRM_UNUSED && s !== SS.CONFIRM && s !== SS.DECK) W.fadeClose('s.deck', 10)
    let leave: GameSceneId | null = null
    sw: switch (this.st) {
      case SS.INIT:
        this.cursorRow = this.scrollTop = 0
        this.block = this.area = 0
        this.oppId = 0
        W.closeAll()
        this.openAreaTitle(ctx)
        W.openMessage('s.help', 244, 402, this.txt(ctx, T.acceptReturn), 0x14, 0x3000)
        this.loading = true
        this.st = SS.LOAD
        break
      case SS.LOAD:
        // fileQueueWaitOrPending(1) == 0
        this.loading = false
        audio.playBgm(BGM.camp)
        this.openState(ctx, 2)
        this.st = SS.AREA
        break
      case SS.AREA: {
        W.updateInput('s.areas', input, se)
        P = input.pressed // a click on a row is ✕
        const cur = W.cursor('s.areas')
        if (this.area !== cur) {
          this.block = 0
          this.area = cur
          this.openAreaTitle(ctx)
        }
        if (!st.stageIfUnlocked(this.area + 1, this.block)) this.block = 0
        if (st.stageIfUnlocked(this.area + 1, 1)) {
          if (P & PAD.LEFT) {
            if (this.block > 0) {
              this.block--
              se(1)
            }
          } else if (P & PAD.RIGHT && this.block < 1) {
            this.block++
            se(1)
          }
        }
        if (this.blockPick >= 0) {
          // mouse (ours): a click on the "Block A →" / "← Block B" strip of a plate
          if (this.block !== this.blockPick && st.stageIfUnlocked(this.area + 1, this.blockPick)) {
            this.block = this.blockPick
            se(1)
          }
          this.blockPick = -1
        }
        this.printBlock(ctx)
        this.drawMapStats(ctx)
        W.bringToFront('s.block')
        const aw = W.get('s.areas')
        if (P & PAD.CROSS) {
          const s2 = st.session
          s2.mapId = this.area + 1
          s2.mapVariant = this.block
          const stage = st.stageIfUnlocked(s2.mapId, this.block) & 0xff
          s2.stageNo = stage
          s2.gameMode = st.isCleared(stage) ? MODE_FREE : MODE_STORY
          this.cursorRow = aw?.menu?.row ?? 0
          this.scrollTop = aw?.menu?.scrollTop ?? 0
          this.oppIdx = (stage - 1) & 0xff
          this.oppId = ladderId(st.db, stage)
          this.openState(ctx, 3)
          se(7)
          this.st = SS.OPPONENT
        }
        if (P & PAD.CIRCLE) {
          this.cursorRow = aw?.menu?.row ?? 0
          this.scrollTop = aw?.menu?.scrollTop ?? 0
          this.openState(ctx, 7)
          this.st = SS.TO_CAMP
          se(9)
        }
        break
      }
      case SS.OPPONENT:
        if (W.isOpen('s.deck')) break
        W.bringToFront('s.face')
        if (st.session.gameMode === MODE_FREE) {
          // free battle: ← / → (pad repeat) step through the cleared stages' opponents
          const mask = st.profile.stageClearMask >>> 0
          let u = this.oppIdx
          if (input.repeat & PAD.RIGHT) {
            let found = false
            do {
              u++
              if (mask >>> u === 0) {
                found = true
                break
              }
              this.oppIdx = (this.oppIdx + 1) & 0xff
              if ((mask >>> u) & 1) {
                found = true
                break
              }
            } while (u < 0x21)
            if (!found) {
              this.oppIdx = 0
              u = 0
            }
            if (u === this.oppIdx) se(1)
          } else if (input.repeat & PAD.LEFT) {
            do {
              u--
              if (u < 0) break
              this.oppIdx = (this.oppIdx - 1) & 0xff
            } while (!((mask >>> u) & 1))
            if (u === this.oppIdx) se(1)
          }
        }
        this.oppId = ladderId(st.db, this.oppIdx + 1)
        this.drawCharaInfo(ctx, this.oppId)
        if (P & PAD.CROSS) {
          this.openState(ctx, 4)
          this.st = SS.DECK
          se(7)
        } else if (P & PAD.CIRCLE) {
          this.openState(ctx, 2)
          this.drawMapStats(ctx)
          this.st = SS.AREA
          se(9)
        }
        break
      case SS.DECK: {
        W.updateInput('s.deck', input, se)
        P = input.pressed // a click on a row is ✕
        const slot = W.cursor('s.deck')
        if (P & PAD.CROSS) {
          st.profile.curDeckSlot = slot + 1
          if ((st.decks[slot]?.name ?? '') === '') se(10)
          else {
            this.openState(ctx, 5)
            this.st = SS.CONFIRM
            se(7)
          }
        } else if (P & PAD.CIRCLE) {
          se(9)
          this.st = SS.OPPONENT
        }
        break
      }
      case SS.CONFIRM:
      case SS.CONFIRM_UNUSED:
        if (P & PAD.CROSS) {
          this.st = this.st === SS.CONFIRM ? SS.GO : SS.DECK
          se(7)
        } else if (P & PAD.CIRCLE) {
          this.st = SS.DECK
          se(9)
        }
        break
      case SS.TO_CAMP:
      case SS.GO:
        if (this.st === SS.TO_CAMP) {
          if (P & PAD.CROSS) {
            se(7)
            leave = GameScene.CAMP
          } else {
            if (P & PAD.CIRCLE) {
              this.st = SS.AREA
              se(9)
              W.close('s.help')
              const h = W.openMessage('s.help', 244, 0, this.txt(ctx, T.acceptCancel), 0x14, 0x3000)
              h.y = 448 - h.h
            }
            break sw
          }
        }
        // stageSelectFreeAssets, winCloseAll, bgmStop(0)
        W.closeAll()
        audio.stopBgm()
        this.st = SS.INIT
        if (leave === GameScene.CAMP) return GameScene.CAMP
        this.setupBattle(st)
        return GameScene.MAP_BOARD
    }
    if (!this.loading) W.tick()
    return this.id
  }

  /**
   * Mouse (Play mode, ours), before the state runs: the help labels (hover bar, a click presses the
   * button); in the area list a click on the lower strip of a plate with two blocks picks block A (left
   * half) or B (right half) instead of choosing; with the opponent shown the free-battle side arrows
   * are ← / →, and a click elsewhere is ✕ as in the confirmation and "Returning to camp." (yes / no).
   * The rows of the area and deck lists are handled by WinList.updateInput.
   */
  private mouse(ctx: SceneContext) {
    const { input, audio, state: st } = ctx
    const W = this.W!
    const s = this.st
    W.hover = null
    this.blockPick = -1
    if (this.loading || s === SS.INIT || s === SS.LOAD || s === SS.GO) return
    const question = s === SS.CONFIRM || s === SS.CONFIRM_UNUSED || s === SS.TO_CAMP
    if (W.helpMouse(input, question) || !(input.pressed & PAD.POINTER)) return
    const drop = () => (input.pressed &= ~PAD.POINTER)
    if (s === SS.AREA) {
      const m = W.get('s.areas')?.menu
      if (!m) return
      const top = m.scrollTop ?? 0
      const r = Math.floor((input.pointerY - 0x6f) / 0x48)
      const i = top + r
      if (r < 0 || r >= (m.visibleRows ?? 1) || i >= (m.itemCount ?? 1) || !st.stageIfUnlocked(i + 1, 1)) return
      const y = r * 0x48 + 0x6f
      if (!input.pointerIn(0x22, y + 0x20, 0xba, y + 0x48)) return
      drop()
      if (W.cursor('s.areas') !== i) {
        W.setCursor('s.areas', r, top)
        audio.playSe(1)
      }
      this.blockPick = input.pointerX < 0x74 ? 0 : 1
    } else if (s === SS.OPPONENT) {
      if (W.isOpen('s.deck')) return
      if (st.session.gameMode === MODE_FREE) {
        // the arrows as draw() places them (uiDrawSideArrowsLarge(0x140, 0x150, 0, 0x200, mask)), with room for the bobbing
        const left = this.oppIdx > 0, right = st.profile.stageClearMask >>> ((this.oppIdx + 1) & 0x1f) !== 0
        if (left && input.pointerIn(0x14, 0x12a, 0x48, 0x170)) {
          drop()
          input.repeat |= PAD.LEFT
          return
        }
        if (right && input.pointerIn(0x238, 0x12a, 0x26c, 0x170)) {
          drop()
          input.repeat |= PAD.RIGHT
          return
        }
      }
      input.pressed = (input.pressed & ~PAD.POINTER) | PAD.CROSS
    }
  }

  /** State 8: deckCopyCards(slot → DuelPlayer 0) with Dominator 1001, dbGetDeckByDominator(opponent, mode 1 ? 3 : 1), names, 2 players. */
  private setupBattle(st: GameState) {
    const s = st.session
    const board = st.db.maps.find((m) => m.area === s.mapId && m.variant === s.mapVariant) ?? st.boardForStage(s.stageNo)
    if (!board) return
    st.setupStageBattle(board, st.profile.curDeckSlot || 1, this.oppId, s.stageNo)
  }

  draw(ctx: SceneContext) {
    if (this.loading) return
    const gl = ctx.screen.use('wide')
    gl.depthTest = false
    gl.begin([0, 0, 0])
    const a = ctx.assets, st = ctx.state, W = this.W!
    const s = this.st
    if (s === SS.AREA || s === SS.TO_CAMP) {
      const aw = W.get('s.areas')
      const cur = W.cursor('s.areas')
      // the preview of the area under the cursor (anchor 9 + spriteResetOffset: top-left at (0xF4, 0x40))
      const b = aw?.bright ?? 0x80, al = aw?.alpha ?? 0x80
      const col = spriteColor(b, b, b, al)
      for (const m of [101, 111]) {
        const img = a.image('etc.one', 320, cur * 100 + this.block + m)
        if (img) drawSpriteEx(gl, img, 0, 0, img.width, img.height, 0xf4, 0x40, { color: col })
      }
    } else if (s >= SS.OPPONENT && s <= SS.CONFIRM_UNUSED) {
      if (s === SS.OPPONENT && st.session.gameMode !== MODE_STORY) {
        let mask = this.oppIdx > 0 ? 1 : 0
        if (st.profile.stageClearMask >>> ((this.oppIdx + 1) & 0x1f) !== 0) mask |= 2
        this.sideArrowsLarge(ctx, gl, 0x140, 0x150, 0x200, mask)
      }
      // the chosen area's preview at half size, centred on (0x140, 0x80), with the character window's brightness
      const img = a.image('etc.one', 320, this.area * 100 + this.block + 101)
      const cw = W.get('s.chara')
      const b = cw?.bright ?? 0x80
      if (img) drawSpriteEx(gl, img, 0, 0, img.width, img.height, 0x140, 0x80, { color: spriteColor(b, b, b, cw?.alpha ?? 0x80), sx: 0.5, sy: 0.5, px: img.width >> 1, py: img.height >> 1, resetOffset: true })
    }
    W.draw(gl, a.painter)
    if (s === SS.AREA || s === SS.TO_CAMP) this.drawPlates(ctx, gl)
    gl.end()
  }

  /**
   * The area plates and block labels of the 4 visible rows: spriteDraw(…, z −0x8000, …), in front of
   * everything drawn at depth 0 (the preview) and of the windows menuWinUpdateAll draws after them, so
   * they cover the area list's fill and its cursor bar: drawn after the windows here.
   */
  private drawPlates(ctx: SceneContext, gl: GlRenderer) {
    const a = ctx.assets, st = ctx.state, W = this.W!
    const frame = a.image('etc.one', 300, 6)
    const s = this.st
    const aw = W.get('s.areas')
    const top = aw?.menu?.scrollTop ?? 0
    const cur = W.cursor('s.areas')
    for (let i = top; i >= 0 && i < 10 && i < top + 4; i++) {
      if (!st.stageIfUnlocked(i + 1, 0) && !st.stageIfUnlocked(i + 1, 1)) break
      const plate = a.image('etc.one', 310, (i + 1) * 100)
      if (!plate) continue
      const y = (i - top) * 0x48
      const c = s === SS.TO_CAMP ? 0x20 : i === cur ? 0x80 : 0x20
      const col = spriteColor(c, c, c, 0x80)
      drawSpriteEx(gl, plate, 0, 0, plate.width, plate.height, 0xd, y + 0x6f, { color: col })
      if (st.stageIfUnlocked(i + 1, 1)) {
        if (i === cur && this.block === 1) {
          // "Block B" at (0x80, …), the arrow mirrored about its centre at (0x22, …)
          drawSpriteEx(gl, frame, 0, 0x14, 0x46, 0x28, 0x80, y + 0x99, { color: col })
          drawSpriteEx(gl, frame, 0x46, 0, 0x80, 0x28, 0x22, y + 0x8f, { color: col, sx: -1, px: 29, py: 20 })
        } else {
          drawSpriteEx(gl, frame, 0, 0, 0x46, 0x14, 0x22, y + 0x99, { color: col })
          drawSpriteEx(gl, frame, 0x46, 0, 0x80, 0x28, 0x80, y + 0x8f, { color: col, px: 29, py: 20 })
        }
      }
    }
  }

  /** uiDrawSideArrowsLarge(x, y, 0, gap, mask, 1): etc.one 2/4 cells (0xBE, 0xA0) / (0xDE, 0xA0), 32×54, bobbing by uiAnimCounter(6). */
  private sideArrowsLarge(ctx: SceneContext, gl: GlRenderer, x: number, y: number, gap: number, mask: number) {
    if (!(mask & 3)) return
    const ui = ctx.assets.image('etc.one', 2, 4)
    const a = ctx.ui.m6
    const half = gap < 0 ? (gap + 1) >> 1 : gap >> 1
    if (mask & 1) drawSpriteEx(gl, ui, 0xbe, 0xa0, 0xde, 0xd6, a + (x - 0x20 - half), y - 0x1b)
    if (mask & 2) drawSpriteEx(gl, ui, 0xde, 0xa0, 0xfe, 0xd6, x + half - a, y - 0x1b)
  }

  exit() {}

  debug() {
    return `stage select state ${this.st} · area ${this.area} block ${this.block} · opponent ${this.oppId} (idx ${this.oppIdx})`
  }
}

