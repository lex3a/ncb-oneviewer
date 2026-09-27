/**
 * The step machines of the map scene that run between the player's commands, ported from the named
 * game functions: mapTurnStartUpdate with its field-effect handlers and turnReportAdd/Show,
 * playerDrawCardUpdate, mapProcessDeaths with the death triggers, abilityDispatch(0, 1) with
 * abilityConfirmUse / abilitySelectTarget / abilityConfirmTarget and the ability* handlers,
 * mapSpellCastUpdate with spellSelectTarget / spellConfirmTarget / spellSelectCell and the spell*
 * handlers, mapBattlePrepUpdate (Evasion), mapBattleAfterUpdate, unitSummonUpdate (Trench Mortar) and
 * mapTurnEndUpdate. Each keeps the game's step numbers and window calls; the windows are drawn by the
 * board scene (FlowHost). See docs/formats/rules.md, card-effects.md and map-board.md.
 */
import { A, cardType, CT_BASE, CT_CHARA, CT_SPELL, CT_UNIT, MapGame, type Player, type Unit } from './mapRules.ts'
import type { DuelWindow } from './windows.ts'

export const PAD_UP = 0x10
export const PAD_RIGHT = 0x20
export const PAD_DOWN = 0x40
export const PAD_LEFT = 0x80
export const PAD_CIRCLE = 0x2000
export const PAD_SELECT = 0x1
export const PAD_START = 0x8
export const PAD_TRIANGLE = 0x1000
export const PAD_CROSS = 0x4000
/** Play mode's PAD.POINTER (a click on the screen): advances dialogue like ✕. */
export const PAD_POINTER = 0x40000000
/** Play mode's PAD.POINTER_MIDDLE (a middle click): skips dialogue like START. */
export const PAD_POINTER_MIDDLE = 0x10000000
/** Play mode's PAD.POINTER_RIGHT (a right click, sent together with ○). */
export const PAD_POINTER_RIGHT = 0x08000000
export const PAD_SQUARE = 0x8000
/** L / R shoulder buttons. */
export const PAD_L = 0x100
export const PAD_R = 0x200
const PAD_OK = PAD_CROSS | PAD_CIRCLE

/** A window of the scene as the flows see it (winOpenMessage / winOpenFrame globals by name). */
export interface WinRef {
  win: Pick<DuelWindow, 'x' | 'y' | 'w' | 'h' | 'alpha' | 'tailIdx'>
}

/** What the flows need from the board scene. */
export interface FlowHost {
  readonly game: MapGame
  /** padGetPressed(g_inputPadIndex): in modes 1/2 always pad 0, so the human also advances the CPU's messages. */
  readonly pressed: number
  name(cardId: number): Uint8Array
  abilityName(id: number): Uint8Array
  abilityDesc(id: number): Uint8Array
  cardText(id: number): Uint8Array
  /** A NUL-terminated string of the executable. */
  str(addr: number): Uint8Array
  /** winOpenMessage(x, y, …, glyph, flags) + drawStyle 10, w/h + 10. Keys: msg, top, info, help, tc, menu. */
  msg(key: string, x: number, y: number, text: Uint8Array, glyph: number, flags: number): WinRef
  /** winOpenFrame(x, y, w, h, chamfer, style, flags). */
  frame(key: string, x: number, y: number, w: number, h: number, chamfer: number, style: number, flags: number): WinRef
  print(key: string, x: number, y: number, glyph: number, text: Uint8Array): void
  clearPrints(key: string): void
  close(key: string): void
  closeAll(): void
  isOpen(key: string): boolean
  win(key: string): WinRef | undefined
  /** mapCursorUpdate: true when the cursor rests on a whole square. */
  cursorStep(): boolean
  /** effectStart(id): effect.one entry 1000 + id, played over the board (ignored while another effect runs). */
  effect(id: number): void
  /** effectIsBusy: loading or running (until the frame after the script's slot dies). */
  effectBusy(): boolean
  /** g_mapCurUnit: the unit the effect scripts place (0x388) or remove (0x389). */
  setCurUnit(u: Unit | null): void
  isCpu(player: number): boolean
  /** duelGetPlayerName(index). */
  playerName(index: number): Uint8Array
  /** handSelectUpdate(player, mode) of the board: 1 chosen (player.selected), −1 cancelled, 0 busy. */
  handSelect(p: Player, mode: number): number
  /** winOpenList(x, y, w, h, win, n, glyph, glyph, items, stride, flags) (list mode 1). */
  openList(key: string, x: number, y: number, w: number, h: number, items: Uint8Array[], glyph: number, flags: number): WinRef
  /** winOpenMenu(x, y, win, glyph, glyph, text): one row per ＠ｎ line. */
  openMenu(key: string, x: number, y: number, glyph: number, text: Uint8Array): WinRef
  /** winUpdateInput: the menu / list cursor. */
  listInput(key: string): void
  /** winGetCursor. */
  listCursor(key: string): number
  /** msgEventStart (story mode only) and msgEventUpdate (1 when the script ended, at once without one). */
  eventStart(trigger: 'stageStart' | 'turnStart' | 'afterWin' | 'afterLoss', key: number, dominator: number): void
  eventUpdate(): number
}

// ---------------------------------------------------------------------------------------------
// text

const FW: Record<string, number> = { '＠': 0x8197, '⇒': 0x81cb, '＋': 0x817b, '（': 0x8169, '）': 0x816a, '“': 0x8167, '”': 0x8168, '＝': 0x8181, '　': 0x8140, '’': 0x8166 }
/** ASCII plus the full-width letters, digits and signs the game's format strings use, as Shift-JIS. */
export function sj(s: string): Uint8Array {
  const out: number[] = []
  for (const ch of s) {
    const c = ch.charCodeAt(0)
    let code = -1
    if (c < 0x80) {
      out.push(c)
      continue
    }
    if (c >= 0xff10 && c <= 0xff19) code = 0x824f + (c - 0xff10)
    else if (c >= 0xff21 && c <= 0xff3a) code = 0x8260 + (c - 0xff21)
    else if (c >= 0xff41 && c <= 0xff5a) code = 0x8281 + (c - 0xff41)
    else code = FW[ch] ?? 0x8148
    out.push(code >> 8, code & 0xff)
  }
  return Uint8Array.from(out)
}
/** sprintf: strings are Shift-JIS encoded, byte arrays copied. */
export function cat(...parts: (string | Uint8Array)[]): Uint8Array {
  const bufs = parts.map((p) => (typeof p === 'string' ? sj(p) : p))
  const out = new Uint8Array(bufs.reduce((n, b) => n + b.length, 0))
  let o = 0
  for (const b of bufs) {
    out.set(b, o)
    o += b.length
  }
  return out
}
const d2 = (n: number) => String(n).padStart(2, ' ')
const d3 = (n: number) => String(n).padStart(3, ' ')
const arrow = (a: number, b: number) => `${d2(a)} ⇒ ${d2(b)}`

/** String constants of the executable (DAT_ addresses read by the functions below). */
export const S = {
  acceptCancel: 0x088dd048,
  acceptCancel2: 0x088e6124,
  upkeep: 0x088ec738,
  returnB3: 0x088f3738,
  useCancel: 0x088f3720,
  boostDesc: 0x088f3748,
  selectInArea: 0x088f37c0,
  acceptCancel3: 0x088f39e8,
  castSpell: 0x088f3a2c,
  drawn: 0x088f3ad0,
  noAttachment: 0x088f3bb0,
  seized: 0x088f3c18,
  mindReadFull: 0x088f361c,
  handDrawn: 0x088e5f7c,
  discard: 0x088e5f94,
  discardOk: 0x088e60f8,
  returnB2: 0x088e60c8,
  checkTarget: 0x088e606c,
  returnB3b: 0x088e6094,
  conquestWin: 0x088dd218,
  toTitle: 0x088dd160,
  evasionHand: 0x088ec7e0,
  evasionFull: 0x088ec808,
  revived: 0x088ec978,
  useCancel2: 0x088ec960,
  dollRevived: 0x088ec8fc,
  spellOpponent: 0x088ba134,
  spellReturn: 0x088ba22c,
  spellHere: 0x088ba390,
  spellOpp2: 0x088ba42c,
  lordOfBlanks: 0x088ba554,
  flamesOk: 0x088ba5b4,
  noAttack: 0x088ba5ec,
  noBuff: 0x088ba64c,
  noDeath: 0x088ba684,
  noAttached: 0x088ba6b4,
  sixAttached: 0x088ba6e8,
  barrier: 0x088ba720,
  hpDf5: 0x088ba7a0,
  noReturn: 0x088ba81c,
  noMoreAllies: 0x088ba888,
  handOver5: 0x088ba948,
  alreadyFlag: 0x088ba9a0,
  noHand: 0x088ba9d8,
  accept: 0x088baa50,
  changeView: 0x088baaec,
  plusActions: 0x088bb31c,
  plusPierce: 0x088bb304,
  plusSureKill: 0x088bb28c,
  plusSupport: 0x088bb278,
  plusFirst: 0x088bb268,
  plusDeathDef: 0x088bb254,
  epsilon: 0x088bb410,
  janess: 0x088bb38c,
  ambush: 0x088bb360,
  dried: 0x088bb484,
  civilWar: 0x088bb430,
  reportHelp: 0x088b9ff0,
  reportHp: 0x088ba010,
  selectRevive: 0x088ba198,
  listCancel: 0x088ba29c,
  listAccept: 0x088ba2ac,
  listReturnEnd: 0x088ba23c,
  listAcceptEnd: 0x088ba264,
  attrMenu: 0x088baa6c,
  downArrow: 0x088bad00,
  mirrorSelect: 0x088bac30,
  mirrorConfirm: 0x088bac70,
  relocSelect: 0x088bad60,
  relocDominator: 0x088bad04,
  relocBarrier: 0x088bad2c,
  homesickHand: 0x088bab0c,
  homesickFull: 0x088bab34,
  betrayer: 0x088bae0c,
  retreat: 0x088baeb0,
  slipDiscard: 0x088bb0ac,
  leafDiscard: 0x088bb0e0,
  windOk: 0x088bb150,
  mirageNowEarth: 0x088bafe4,
  mirageNowWater: 0x088bb018,
  mirageNowFire: 0x088bb04c,
  mirageNowAir: 0x088bb07c,
  mirageAskEarth: 0x088baee4,
  mirageAskWater: 0x088baf24,
  mirageAskFire: 0x088baf64,
  mirageAskAir: 0x088bafa4,
  cwSummonGone: 0x088bb644,
  cwSpellGone: 0x088bb624,
  cwBarrierAsk: 0x088bb538,
  cwUseAsk: 0x088bb588,
  cwUseCancel: 0x088bb4c4,
  cwStats: 0x088bb518,
  bankruptcy: 0x088ec88c,
  checkTargetStats: 0x088e60d8,
}

/** sprintf with %d / %2d / %3d / %s into a format read from the executable (only %d, %s, %2d, %3d are used by these strings). */
export function sprintf(f: Uint8Array, ...args: (number | Uint8Array)[]): Uint8Array {
  const out: number[] = []
  let a = 0
  for (let i = 0; i < f.length; i++) {
    const c = f[i]
    if (c >= 0x81 && c <= 0x9f) {
      out.push(c, f[++i] ?? 0)
      continue
    }
    if (c === 0x25) {
      let w = 0
      let j = i + 1
      while (f[j] >= 0x30 && f[j] <= 0x39) w = w * 10 + (f[j++] - 0x30)
      const t = f[j]
      const v = args[a++]
      if (t === 0x73 && v instanceof Uint8Array) out.push(...v)
      else if (t === 0x64) out.push(...sj(String(v ?? 0).padStart(w, ' ')))
      i = j
      continue
    }
    out.push(c)
  }
  return Uint8Array.from(out)
}

/**
 * spellGetTargetMode (0x088475E8): g_mapSpellTargetMode for the CPU's casts (the counter window tests
 * Magic Barrier only in modes 1 and 2): 7 player spells, 4 land spells, 10 caster spells, Shard of Life
 * and Return from Shadows, 12 Battlefield Scales / Green Noa / Earth Nova, 6 Double Action / Firestorm /
 * Magic Dragon Gaze, 1 everything else.
 */
export function spellTargetMode(id: number): number {
  if ([2612, 2607, 2605, 2611, 2610, 2606, 2604, 2603, 2602, 2601].includes(id)) return 7
  if ([2509, 2505, 2504, 2503, 2502, 2510, 2508, 2501].includes(id)) return 4
  if ([2507, 2617, 2616, 2615, 2614, 2613, 2205, 2204].includes(id)) return 10
  if ([2609, 2208, 2007].includes(id)) return 12
  if ([2608, 2008, 2002].includes(id)) return 6
  return 1
}
export function isAttach(id: number) {
  return [2102, 2103, 2104, 2110, 2203, 2206, 2207, 2301, 2302, 2303, 2304, 2305, 2306, 2307, 2308, 2309, 2310, 2402, 2608].includes(id)
}

interface Report {
  names: Uint8Array[][]
  vals: Uint8Array[][]
}

export class MapFlows {
  readonly h: FlowHost
  constructor(h: FlowHost) {
    this.h = h
  }
  get g() {
    return this.h.game
  }
  private get P() {
    return this.h.pressed
  }
  private ok() {
    // a click (Play mode, ours) acknowledges like ✕ / ○
    return (this.P & (PAD_OK | PAD_POINTER)) !== 0
  }
  private center(key: string, text: Uint8Array, glyph = 0x16) {
    return this.h.msg(key, 320, 224, text, glyph, 0xf000)
  }
  private topName(text: Uint8Array, y: number, glyph: number, key = 'top') {
    this.h.close(key)
    return this.h.msg(key, 320, y, text, glyph, 0x7000)
  }

  // ---- turn report ----

  private rep: Report = { names: [[], []], vals: [[], []] }
  /** turnReportClear. */
  reportClear() {
    this.rep = { names: [[], []], vals: [[], []] }
  }
  /** turnReportAdd(unit, value): list 0 for team 0, list 1 otherwise, at most 16 rows. */
  reportAdd(u: Unit, value: Uint8Array) {
    const k = u.team !== 0 ? 1 : 0
    if (this.rep.names[k].length >= 16) return
    this.rep.names[k].push(this.h.name(u.cardId))
    this.rep.vals[k].push(value)
  }
  /** turnReportShow(player, showHelp) (0x0883A0F0). */
  reportShow(player: number, showHelp: boolean) {
    let side = player
    if (side < 0 || side >= 2) side = 0
    const h = this.h
    if (!h.isOpen('msg')) {
      h.frame('msg', 320, 101, 391, 0, 16, 10, 0x4000)
      h.frame('info', 160, 67, 391, 49, 16, 10, 0x4000)
      if (showHelp) h.msg('help', 480, h.win('info')!.win.y, h.str(S.reportHelp), 0x12, 0x7000)
    }
    h.clearPrints('info')
    h.clearPrints('msg')
    const nm = h.name(this.g.units[side][0].cardId)
    h.print('info', 0, 0, 0x12, nm)
    h.win('info')!.win.w = (nm.length >> 1) * 19 + 30
    h.print('msg', 0, 0, 0x12, sj('Unit name'))
    h.print('msg', 0xe4, 0, 0x12, h.str(S.reportHp))
    let n = 0
    for (let i = 0; i < this.rep.names[side].length; i++) {
      h.print('msg', 0, 0x13 * (i + 1), 0x12, this.rep.names[side][i])
      h.print('msg', 0xe4, 0x13 * (i + 1), 0x12, this.rep.vals[side][i])
      n++
    }
    if (n === 0) {
      h.print('msg', 0, 0x13, 0x12, sj('No target '))
      n = 1
    }
    h.win('msg')!.win.h = n * 19 + 49
  }

  // ---- turn start (mapTurnStartUpdate 0x0885B430) ----

  tsStep = 0
  private tsSub = 0
  private tsCnt = 0
  private tsF8 = 0
  private tsTotal = 0

  /** One frame; returns true when the turn start is over (or a Dominator died). */
  turnStart(): boolean {
    const g = this.g, h = this.h
    const tp = g.turnPlayer
    const p = g.players[tp]
    const before = this.tsStep
    let done = false
    const s = this.tsStep
    if (s === 0xc9) {
      if (this.drawUpdate(p, 1, 6) !== 0) done = true
    } else if (s === 200) {
      if (this.tsTotal - p.maintenance < 0) this.tsStep = 100
      else if (h.eventUpdate() > 0) {
        // the turn event (story mode, started in step 100) has ended
        h.closeAll()
        p.cost = this.tsTotal - p.maintenance
        this.tsStep++
      }
    } else if (s === 0x67) {
      if (this.deaths(-1)) this.tsStep = 100
    } else if (s === 0x66) {
      if (h.isCpu(tp)) {
        if (++this.tsCnt > 0x40) this.tsStep++
      } else if (this.P & PAD_CROSS) {
        const w = g.getCell(g.cursor.x >> 6, g.cursor.y >> 6)
        const slot = w > 0 ? (w >>> 16) & 0xff : 0
        if (w > 0 && slot !== 0 && slot !== 0xff) {
          const u = g.unitOfWord(w)
          if (u) u.hp = 0
          this.tsStep++
        }
      } else if (this.P & PAD_CIRCLE) this.tsStep = 100
      if (this.tsStep === 100) h.close('help')
    } else if (s === 0x65) {
      if (h.isCpu(tp)) {
        if (++this.tsCnt >= 0x20 && this.findMaxMaintenance(p.index) > 0) this.tsStep++
      } else if (h.cursorStep() && this.P & PAD_CROSS) {
        const w = g.getCell(g.cursor.x >> 6, g.cursor.y >> 6)
        if (w > 0) {
          const slot = (w >>> 16) & 0xff
          if (slot === 0xff || slot === 0 || MapGame.teamOf(w) !== tp + 1) g.onSe(10)
          else {
            h.close('msg')
            const m = h.msg('msg', 0, 8, sj('Is it all right to destroy this unit? '), 0x16, 0x3000)
            h.close('help')
            const hl = h.msg('help', 0, 0, h.str(S.acceptCancel2), 0x12, 0x3000)
            hl.win.y = m.win.y + m.win.h
            this.tsStep++
          }
        }
      }
    } else if (s === 100) {
      g.recalcAll()
      h.close('msg')
      if (this.tsTotal < p.maintenance) {
        h.msg('msg', 0, 8, h.str(S.upkeep), 0x16, 0x3000)
        this.tsStep++
      } else {
        p.income = this.tsTotal
        if (g.gameMode === 1) h.eventStart('turnStart', g.round, g.units[tp][0].cardId)
        this.tsStep = 200
      }
      g.countDeployed()
    } else if (s === 0x32) {
      h.closeAll()
      done = g.dominatorDown()
      this.tsStep++
    } else if (s === 0x29) {
      if (this.healingSpring()) this.tsStep++
    } else if (s === 0x28) {
      if (this.regeneration()) this.tsStep++
    } else if (s === 0x1e || s === 0x18 || s === 0x15) {
      if (this.deaths(1)) this.tsStep++
    } else if (s === 0x1a || s === 0x17) {
      done = g.dominatorDown()
      this.tsStep++
    } else if (s === 0x19) {
      if (this.trapZone()) this.tsStep++
    } else if (s === 0x16) {
      if (this.tntClockTower()) this.tsStep++
    } else if (s === 0x14) {
      if (this.sureKill()) this.tsStep++
    } else if (s === 0xb || s === 10) {
      const v = s === 10 ? this.blindFaith() : this.magicMine()
      if (v !== 0) {
        if (v > 0) this.tsTotal += v
        p.cost = this.tsTotal
        this.tsStep++
      }
    } else if (s === 0) {
      h.closeAll()
      g.commitConquest()
      this.tsTotal = g.conquestCount[tp]
      this.tsStep++
    } else this.tsStep = (Math.trunc(this.tsStep / 10) + 1) * 10
    if (done) {
      h.closeAll()
      this.tsStep = 0
    }
    if (this.tsStep !== before) {
      if (this.tsStep < 100) h.closeAll()
      this.tsSub = this.tsCnt = this.tsF8 = 0
    }
    return done
  }

  /** unitFindMaxMaintenance(team): the unit (slots 1–30) with the highest maintenance gets HP 0 and the cursor. */
  private findMaxMaintenance(team: number): number {
    const g = this.g
    let best = 0, pick: Unit | null = null
    for (const q of g.units)
      for (const u of q.slice(1)) {
        const m = g.card(u.cardId)?.maintenance ?? 0
        if (u.hp > 0 && u.state > 0 && u.team === team && best < m) {
          best = m
          pick = u
        }
      }
    if (!pick) return -1
    g.cursor.x = pick.posX
    g.cursor.y = pick.posY
    pick.hp = 0
    return pick.slot
  }

  private countOwn(id: number) {
    const g = this.g
    let n = 0
    for (const q of g.units) for (const u of q) if (u.cardId === id && u.hp > 0 && u.state > 0 && u.team === g.turnPlayer) n++
    return n
  }

  /** mapIncomeBlindFaith: +3 Cost per own living unit with Blind Faith (22). */
  private blindFaith(): number {
    const g = this.g, h = this.h
    if (this.tsSub === 1) return this.ok() ? this.tsF8 * 3 : 0
    if (this.tsSub !== 0) return 0
    this.tsF8 = 0
    for (const q of g.units) for (const u of q) if (u.hp > 0 && u.state > 0 && u.team === g.turnPlayer && g.countAbility(u, A.blindFaith)) this.tsF8++
    if (!this.tsF8) return -1
    this.topName(h.abilityName(A.blindFaith), 32, 0x16)
    this.center('msg', sj(`${this.tsF8 * 3} Costs obtained `))
    this.tsSub++
    return 0
  }
  /** mapIncomeMagicMine: +3 Cost per own Magic Mine (3006). */
  private magicMine(): number {
    const h = this.h
    if (this.tsSub === 1) return this.ok() ? this.tsF8 * 3 : 0
    if (this.tsSub !== 0) return 0
    this.tsF8 = this.countOwn(3006)
    if (!this.tsF8) return -1
    h.msg('top', 320, 24, h.name(3006), 0x14, 0x7000)
    this.center('msg', sj(`${this.tsF8 * 3} Costs obtained `))
    this.tsSub++
    return 0
  }
  /** mapTurnSureKillDamage: each own unit HP − (Sure-Kill attachments). */
  private sureKill(): number {
    const g = this.g
    if (this.tsSub === 1) return this.ok() ? 1 : 0
    if (this.tsSub !== 0) return 0
    let n = 0
    for (const q of g.units) for (const u of q) if (u.team === g.turnPlayer && g.countAttachments(u, 2308) > 0) n++
    if (!n) return -1
    this.topName(this.h.name(2308), 16, 0x14)
    this.reportClear()
    for (let k = 0; k < 2; k++)
      for (const u of g.units[(g.turnPlayer + k) & 1]) {
        const c = g.countAttachments(u, 2308)
        if (u.team !== g.turnPlayer || c <= 0) continue
        const v = Math.max(0, u.hp - c)
        this.reportAdd(u, sj(arrow(u.hp, v)))
        u.hp = v
      }
    this.reportShow(g.turnPlayer, false)
    this.tsSub++
    return 0
  }
  /** mapTurnTntClockTower: both Dominators HP − (own towers). */
  private tntClockTower(): number {
    const g = this.g, h = this.h
    if (this.tsSub === 1) return this.ok() ? 1 : 0
    if (this.tsSub !== 0) return 0
    const n = this.countOwn(3012)
    if (!n) return -1
    h.closeAll()
    h.msg('info', 320, 32, h.name(3012), 0x16, 0x7000)
    const parts: Uint8Array[] = []
    for (let p = 0; p < 2; p++) {
      const d = g.units[p][0]
      const v = Math.max(0, d.hp - n)
      if (p > 0) parts.push(sj('＠ｎ'))
      parts.push(cat(h.name(d.cardId), ` ＠ｎHP ${arrow(d.hp, v)} `))
      d.hp = v
    }
    this.center('msg', cat(...parts))
    this.tsSub++
    return 0
  }
  /** mapTurnTrapZone / mapTurnHealingSpring: units and Dominators (not bases) in range of the turn player's bases. */
  private areaReport(id: number, heal: boolean): number {
    const g = this.g, h = this.h
    if (this.tsSub === 2) {
      if (this.P & PAD_SQUARE) {
        g.onSe(5)
        this.tsF8 = (this.tsF8 + 1) & 1
        this.reportShow(this.tsF8, true)
      } else if (this.ok()) {
        h.closeAll()
        return 1
      }
      return 0
    }
    if (this.tsSub === 0) {
      if (!this.countOwn(id)) {
        this.tsF8 = 0
        return -1
      }
      h.closeAll()
      this.topName(h.name(id), 16, 0x16)
      this.reportClear()
      this.tsF8 = 0
      this.tsSub++
    }
    if (this.tsSub !== 1) return 0
    // one team per frame: rows of team tsF8 from both players' units (the turn player's row first)
    for (let k = 0; k < 2; k++)
      for (const u of g.units[(this.tsF8 + k) & 1]) {
        if (u.cardId >= 2000 || u.state <= 0 || u.team !== this.tsF8) continue
        if (heal && u.hp <= 0) continue
        const n = g.countBaseAuras(u.posX >> 6, u.posY >> 6, 1 << g.turnPlayer, id)
        if (!n) continue
        let text: Uint8Array
        if (!g.countAbility(u, A.annulBase)) {
          const v = heal ? Math.min(u.maxHp, u.hp + n) : Math.max(0, u.hp - n)
          text = sj(arrow(u.hp, v))
          u.hp = v
        } else text = h.abilityName(A.annulBase)
        this.reportAdd(u, text)
      }
    this.tsF8++
    if (this.tsF8 >= 2) {
      this.tsF8 = g.turnPlayer
      this.reportShow(g.turnPlayer, true)
      this.tsSub++
    }
    return 0
  }
  private trapZone() {
    return this.areaReport(3013, false)
  }
  private healingSpring() {
    return this.areaReport(3002, true)
  }
  /** mapTurnRegeneration: own units with Regeneration (25) HP + 2. */
  private regeneration(): number {
    const g = this.g, h = this.h
    if (this.tsSub === 1) return this.ok() ? 1 : 0
    if (this.tsSub !== 0) return 0
    const has = (u: Unit) => u.state > 0 && u.team === g.turnPlayer && u.hp > 0 && g.countAbility(u, A.regeneration) !== 0
    if (!g.allUnits().some(has)) return -1
    h.closeAll()
    this.topName(h.abilityName(A.regeneration), 16, 0x14)
    this.reportClear()
    for (let k = 0; k < 2; k++)
      for (const u of g.units[(g.turnPlayer + k) & 1]) {
        if (!has(u)) continue
        const v = Math.min(u.maxHp, u.hp + 2)
        this.reportAdd(u, sj(arrow(u.hp, v)))
        u.hp = v
      }
    this.reportShow(g.turnPlayer, false)
    this.tsSub++
    return 0
  }

  // ---- drawing (playerDrawCardUpdate 0x08853FAC) ----

  private drStep = 0
  private drCard = 0
  /**
   * playerDrawCardUpdate(player, mode, limit) (0x08853FAC): 1 turn draw (deck state 1, face down), 2 face
   * up (state 3, one frame for the picture load), 5 to the discard pile (no hand check). A hand that
   * already holds `limit` cards refuses the draw. An empty deck recycles the discard pile and costs the
   * Dominator 5 HP (a message, then the draw again). Returns the card id, −1 when nothing could be
   * drawn, 0 while busy.
   */
  drawUpdate(p: Player, mode: number, limit: number): number {
    const g = this.g, h = this.h
    let r = 0
    const dom = g.units[p.index][0]
    if (this.drStep === 100) {
      g.recountDeck(p)
      r = this.drCard > 0 ? this.drCard : -1
    } else if (this.drStep === 11) this.drStep = 100
    else if (this.drStep === 10) {
      if (mode === 5) {
        const c = g.millOne(p)
        if (c < 0) r = -1
        else {
          this.drCard = c
          this.drStep = 100
        }
      } else if (mode >= 1 && mode <= 4) {
        const c = g.drawOne(p, limit, mode === 1 ? 1 : 3)
        if (c <= 0) r = -1
        else {
          this.drCard = c
          this.drStep = mode === 1 ? 100 : 11
        }
      } else r = -1
    } else if (this.drStep === 2) {
      if (this.ok()) {
        h.close('msg')
        g.onSe(7)
        this.drStep = 0
        if (dom.hp < 1) r = -1
      }
    } else if (this.drStep === 1) {
      const n = g.recycle(p)
      const v = Math.max(0, dom.hp - 5)
      h.close('msg')
      const nm = h.name(dom.cardId)
      const t = n < 1 ? cat('There are no cards in deck, ＠ｎnor in the discards pile. ＠ｎ', nm, ` ＠ｎHP ${arrow(dom.hp, v)} `) : cat(`There are no cards left in the deck. ＠ｎ${n} discarded cards have been returned to the deck. ＠ｎ`, nm, ` ＠ｎHP ${arrow(dom.hp, v)} `)
      this.center('msg', t)
      dom.hp = v
      this.drStep++
    } else if (this.drStep === 0) {
      this.drCard = 0
      g.recountDeck(p)
      if (mode === 0) r = p.deckCount
      this.drStep = p.deckCount === 0 ? 1 : 10
    }
    if (r !== 0) {
      this.drStep = 0
      this.drCard = 0
    }
    return r
  }

  // ---- deaths (mapProcessDeaths 0x0885EC04) ----

  dStep = 0
  private dUnit: Unit | null = null
  private dSub = 0
  private dCnt = 0

  /** One frame of mapProcessDeaths(grantSoul); returns true when every dead unit is handled (or a Dominator is down). */
  deaths(grant: number): boolean {
    const g = this.g, h = this.h
    const before = this.dStep
    let done = false
    const u = this.dUnit
    const s = this.dStep
    if (s === 200) done = true
    else if (s === 100) {
      if (u) g.destroy(u, grant !== 0)
      this.dStep = 1
    } else if (s === 0x32) this.dStep = 100
    else if (s === 0x29) {
      if (u && this.destinyHealing(u)) this.dStep++
    } else if (s === 0x28) {
      if (u && this.memento(u)) this.dStep++
    } else if (s === 0x1f) {
      if (!h.effectBusy()) this.dStep = grant < 0 ? 100 : this.dStep + 1
    } else if (s === 0x1e) {
      if (!u || u.slot === 0) this.dStep = 0x32
      else {
        h.setCurUnit(u)
        h.effect(0x35)
        u.state = 4
        this.dStep++
      }
    } else if (s === 0x14) {
      if (u && this.lastFlower(u)) this.dStep++
    } else if (s === 0xd) {
      this.dStep = 0xe
      if (u && u.hp > 0 && u.state > 0) this.dStep = 1
    } else if (s === 0xc) {
      if (u && this.revival(u)) this.dStep++
    } else if (s === 0xb) {
      if (u && this.doll(u)) this.dStep++
    } else if (s === 10) {
      if (u && this.returnFromShadows(u)) this.dStep++
    } else if (s === 2) this.dStep = 10
    else if (s === 1) {
      if (g.dominatorDown()) this.dStep = 200
      else {
        let found = false
        for (let p = 0; p < 2 && !found; p++)
          for (let k = 1; k < 31; k++) {
            const v = g.units[p][k]
            if (v.state > 0 && v.hp < 1) {
              this.dUnit = v
              this.dStep = grant < 0 ? 0x1e : 2
              g.cursor.x = v.posX
              g.cursor.y = v.posY
              found = true
              break
            }
          }
        if (!found) this.dStep = 200
      }
    } else if (s === 0) {
      h.closeAll()
      this.dStep++
    } else this.dStep = (Math.trunc(this.dStep / 10) + 1) * 10
    if (done) {
      h.closeAll()
      this.dStep = 0
    }
    if (this.dStep !== before) {
      h.closeAll()
      this.dSub = this.dCnt = 0
    }
    return done
  }

  /** Re-create the unit from its card on its square (Doll, Return from Shadows, Revival). */
  private reinit(u: Unit, team: number) {
    const g = this.g
    g.removeBaseAura(u)
    const x = u.posX, y = u.posY
    g.initUnit(u, u.player, u.cardId, u.slot)
    u.team = team
    u.posX = x
    u.posY = y
    g.placeOnGrid(u)
  }
  /** mapDeathReturnFromShadows (2204): a non-Dominator of a team with player flag 2. */
  private returnFromShadows(u: Unit): number {
    const g = this.g, h = this.h
    const team = u.team
    if (this.dSub === 2) return 1
    if (this.dSub === 1) {
      if (this.ok()) {
        this.reinit(u, g.players[team].index)
        g.players[team].flags &= ~2
        g.players[team].maintenance = g.sumMaintenance(team)
        g.countDeployed()
        this.dSub++
        return 1
      }
      return 0
    }
    if (this.dSub !== 0) return 0
    if (u.hp > 0 || u.slot === 0 || !(g.players[team].flags & 2)) return -1
    h.closeAll()
    h.msg('info', 320, 32, h.name(2204), 0x16, 0x7000)
    this.dSub++
    return 0
  }
  /** mapDeathDollOfLiving (2206 attached). */
  private doll(u: Unit): number {
    const g = this.g, h = this.h
    if (this.dSub === 2) {
      if (this.ok()) {
        this.reinit(u, u.team)
        g.players[u.team].maintenance = g.sumMaintenance(u.team)
        g.countDeployed()
        return 1
      }
      return 0
    }
    if (this.dSub === 1) {
      h.close('info')
      h.msg('info', 320, 32, h.name(2206), 0x16, 0x7000)
      this.center('msg', sprintf(h.str(S.dollRevived), h.name(u.cardId)))
      this.dSub++
      return 0
    }
    if (this.dSub !== 0) return 0
    if (u.hp > 0 || !g.countAttachments(u, 2206)) return -1
    this.dSub++
    return 0
  }
  /** mapDeathRevival (4): the owner may pay the card's cost + Soul (flag 0x10) to revive it; the CPU accepts. */
  private revival(u: Unit): number {
    const g = this.g, h = this.h
    const team = u.team
    const p = g.players[team]
    const cpu = h.isCpu(team)
    if (this.dSub === 3) {
      if (cpu || this.ok()) {
        g.onSe(7)
        h.closeAll()
        return 1
      }
      return 0
    }
    if (this.dSub === 2) {
      if (this.ok()) {
        const c = g.card(u.cardId)
        const [rc, rs] = g.calcPayment(p, c?.cost ?? 0, c?.soul ?? 0, 0x10)
        p.cost = rc
        p.soul = rs
        const af = u.actFlags
        this.reinit(u, team)
        u.actFlags = af
        p.maintenance = g.sumMaintenance(team)
        g.countDeployed()
        g.onSe(7)
        return 1
      }
      return 0
    }
    if (this.dSub === 1) {
      let go = false
      if (cpu) {
        if (++this.dCnt < 0x30) return 0
        go = true
      } else if (this.P & PAD_CROSS) {
        g.onSe(7)
        go = true
      } else if (this.P & PAD_CIRCLE) {
        g.onSe(9)
        return 1
      }
      if (go) {
        h.close('msg')
        h.close('help')
        this.center('msg', sprintf(h.str(S.revived), h.name(g.units[p.index][0].cardId), h.name(u.cardId)))
        this.dSub++
      }
      return 0
    }
    if (this.dSub !== 0) return 0
    if (u.hp > 0 || !g.countAbility(u, A.revival)) return -1
    h.msg('top', 320, 24, h.abilityName(A.revival), 0x14, 0x7000)
    const c = g.card(u.cardId)
    const [rc, rs] = g.calcPayment(p, c?.cost ?? 0, c?.soul ?? 0, 0x10)
    const okPay = rs > -1 && rc > -1
    const m = this.center('msg', okPay ? sj(`Costs: ${d3(p.cost)} ⇒ ${d2(rc)} ＠ｎSoul: ${d3(p.soul)} ⇒ ${d2(rs)}`) : sj('You do not have enough Costs. '))
    this.dSub = okPay ? 1 : 3
    if (okPay) {
      h.close('help')
      h.msg('help', 320, m.win.y + m.win.h / 2, h.str(S.useCancel2), 0x14, 0x7000)
    }
    return 0
  }
  /** Neighbour cell words as mapDeathLastFlower / abilityRotatingSlash read them (mapGetCell). */
  private neighbours(x: number, y: number): Unit[] {
    const out: Unit[] = []
    for (const [dx, dy] of [[-1, 0], [0, -1], [1, 0], [0, 1]]) {
      const w = this.g.getCell(x + dx, y + dy)
      if (w > 0 && this.g.inBoard(x + dx, y + dy)) {
        const v = this.g.unitOfWord(w)
        if (v) out.push(v)
      }
    }
    return out
  }
  /** A "Unit name / HP" table window (Berserk, Rotating Slash, Last Flower). */
  private hpTable(w: number, h0: number, rows: [Unit, number][]) {
    const h = this.h
    h.close('msg')
    const m = h.frame('msg', 320, 224, w, h0, 16, 10, 0xc000)
    h.print('msg', 0, 0, 0x14, sj('Unit name '))
    h.print('msg', 0xfc, 0, 0x14, sj('HP '))
    let y = 0
    for (const [u, v] of rows) {
      y += 0x15
      h.print('msg', 0, y, 0x14, h.name(u.cardId))
      h.print('msg', 0xfc, y, 0x14, sj(arrow(u.hp, v)))
      u.hp = v
    }
    m.win.h += rows.length * 21
    return m
  }
  /** mapDeathLastFlower (40): every occupied neighbour HP − 2. */
  private lastFlower(u: Unit): number {
    const g = this.g, h = this.h
    if (this.dSub === 2) return this.ok() ? 1 : 0
    if (this.dSub === 1) {
      if (h.effectBusy()) return 0
      const rows = this.neighbours(u.posX >> 6, u.posY >> 6).map((v): [Unit, number] => [v, Math.max(0, v.hp - 2)])
      if (rows.length) this.hpTable(408, 51, rows)
      else h.close('msg')
      this.dSub++
      return 0
    }
    if (this.dSub !== 0) return 0
    if (!g.countAbility(u, A.lastFlower)) return -1
    h.closeAll()
    h.msg('top', 320, 24, h.abilityName(A.lastFlower), 0x14, 0x7000)
    g.cursor.x = u.posX
    g.cursor.y = u.posY
    h.effect(g.ability(A.lastFlower)?.effect ?? 0)
    this.dSub++
    return 0
  }
  /** mapDeathMementoTalisman (12): the current owner draws if the hand has ≤ 4 cards. */
  private memento(u: Unit): number {
    const g = this.g, h = this.h
    const p = g.players[u.team]
    if (this.dSub === 2) return this.ok() ? 1 : 0
    if (this.dSub === 1) {
      const c = this.drawUpdate(p, 2, 5)
      if (c === 0) return 0
      if (c < 0) return 1
      this.center('msg', cat(h.name(g.units[p.index][0].cardId), ' ＠ｎhas drawn ＠ｎ', h.name(c), '. '))
      g.compactHand(p)
      this.dSub = 2
      return 0
    }
    if (this.dSub !== 0) return 0
    if (!g.countAbility(u, A.memento)) return -1
    if (g.handCount(p) > 4) return -1
    h.closeAll()
    h.msg('top', 320, 32, h.abilityName(A.memento), 0x16, 0x7000)
    this.dSub++
    return 0
  }
  /** mapDeathDestinyOfHealing (30): the current owner's Dominator HP + 2. */
  private destinyHealing(u: Unit): number {
    const g = this.g, h = this.h
    const d = g.units[u.team][0]
    if (this.dSub === 2) return this.ok() ? 1 : 0
    if (this.dSub === 1) {
      if (h.effectBusy()) return 0
      h.msg('top', 320, 32, h.abilityName(A.destinyHealing), 0x16, 0x7000)
      const v = Math.min(d.maxHp, d.hp + 2)
      this.center('msg', cat(h.name(d.cardId), ` ＠ｎHP ${arrow(d.hp, v)}`))
      d.hp = v
      this.dSub++
      return 0
    }
    if (this.dSub !== 0) return 0
    if (!g.countAbility(u, A.destinyHealing) || d.hp < 1) return -1
    h.closeAll()
    g.cursor.x = d.posX
    g.cursor.y = d.posY
    h.effect(g.ability(A.destinyHealing)?.effect ?? 0)
    this.dSub++
    return 0
  }

  // ---- activated abilities (abilityDispatch(0, 1) 0x08863AE8) ----

  abState = 0
  abId = 0
  abUser: Unit | null = null
  abTarget: Unit | null = null
  private abUse = 0
  private abSel = 0
  private abConf = 0

  /** abilitySetCurrentUnit(unit, 1): the last active ability of the card. */
  abilitySetCurrent(u: Unit) {
    this.abState = 0
    this.abId = 0
    this.abUser = u
    for (const id of this.g.card(u.cardId)?.abilities ?? []) if (this.g.ability(id)?.active) this.abId = id
  }
  /** abilitySetActive(id, user, target, x, y, state): the CPU skips the choice. */
  abilitySetActive(id: number, user: Unit, target: Unit | null, x: number, y: number, state: number) {
    const g = this.g
    if (id < 1) {
      if (id === 0) this.abState = this.abId = 0
      return
    }
    g.cursor.x = x >= 0 ? x : (target?.posX ?? 0)
    g.cursor.y = y >= 0 ? y : (target?.posY ?? 0)
    this.abState = state
    this.abUser = user
    this.abTarget = target
    this.abId = id
  }

  /** abilityConfirmUse (0x088601C0): the cost window; Breath is refused, Mind Read with six cards. */
  private confirmUse(id: number): number {
    const g = this.g, h = this.h
    const p = g.players[g.turnPlayer]
    const ab = g.ability(id)
    const cost = ab?.useCost ?? 0, soul = ab?.useSoul ?? 0
    const [rc, rs] = g.calcPayment(p, cost, soul, 0x10)
    let v = 0
    let text: Uint8Array = new Uint8Array(0)
    if (id === A.breath) v = -1
    else if ([57, 56, 55, 54, 52, 51, 48, 38, 37, 36, 35, 31, 27, 26, 11, 9, 8, 7, 6].includes(id)) {
      if (rc < 0) v = -1
      if (rs < 0) v -= 2
      if (v >= 0) v = 1
    }
    if (v === 0) text = sj('There are no special powers that can be used. ')
    if (id === A.mindRead && g.handCount(p) > 5) {
      v = 0
      text = h.str(S.mindReadFull)
    }
    if (!this.abUse) {
      g.recalcAll()
      h.closeAll()
      if (v < 1) {
        if (v < 0) text = cat(`Cost usage ${cost} /  ${soul} ＠ｎ`, v === -1 ? 'You do not have enough Costs. ' : v === -2 ? 'You do not have enough Soul. ' : 'You do not have enough Costs nor Soul. ')
      } else text = sj(`Cost usage: ${cost} /  ${soul} ＠ｎCosts: ${d3(p.cost)} ⇒ ${d2(rc)} ＠ｎSoul: ${d3(p.soul)} ⇒ ${d2(rs)}`)
      const info = this.center('info', text)
      const hl = h.msg('help', 320, 0, h.str(v < 1 ? S.returnB3 : S.useCancel), 0x14, 0x7000)
      hl.win.y = info.win.y + info.win.h / 2
      if (id !== 0) {
        const top = h.msg('top', 320, 8, h.abilityName(id), 0x16, 0x3000)
        top.win.y = info.win.y - info.win.h / 2 - top.win.h
        top.win.x = 320 - top.win.w / 2
        let desc = h.abilityDesc(id)
        if (id === A.boost && this.abUser) {
          const ap = this.g.attachmentOp(this.abUser, 2301, 0) ? 1 : Math.min(99, this.abUser.effAp + 2)
          desc = sprintf(h.str(S.boostDesc), desc, ap, Math.min(99, this.abUser.effDf + 1))
        }
        const tc = h.msg('tc', 0, 0, desc, 0x14, 0x3000)
        tc.win.y = 448 - tc.win.h
      }
    }
    this.abUse = 1
    let r = 0
    if (h.isCpu(g.turnPlayer)) r = v < 1 ? -1 : 1
    else if (this.P & PAD_CROSS) {
      if (v > 0) {
        g.recalcAll()
        g.onSe(7)
        r = 1
      }
    } else if (this.P & PAD_CIRCLE) {
      g.onSe(9)
      r = -1
    }
    if (r !== 0) this.abUse = 0
    return r
  }

  /** abilitySelectTarget(mode, range) (0x088608E8): 0 resets; range ≥ 0 marks |dx|+|dy| < range around the user. */
  private selectTarget(mode: number, range: number): number {
    const g = this.g, h = this.h
    if (mode === 0) {
      this.abSel = 0
      return 0
    }
    if (mode !== 11 && mode !== 10 && this.abSel) {
      if (!h.cursorStep()) return 0
    }
    const x = g.cursor.x >> 6, y = g.cursor.y >> 6
    const w = g.getCell(x, y) > 0 ? g.grid[y * 40 + x] : 0
    let ok = 0
    let text: Uint8Array
    switch (mode) {
      case 1:
        text = sj('Which unit will you use this on? ')
        if (w) ok = 1
        break
      case 2: {
        text = sj('Which unit will you use this on? ')
        const t = cardType(w & 0xffff)
        ok = t === CT_UNIT || t === CT_CHARA ? 1 : 0
        if (range >= 0 && !g.marks[y * 40 + x]) ok = 0
        break
      }
      case 3:
        text = sj('Which base will you use this on? ')
        if (cardType(w & 0xffff) === CT_BASE) ok = 1
        break
      case 5:
        text = h.str(S.selectInArea)
        if (w && g.marks[y * 40 + x]) ok = 1
        break
      case 7:
        text = sj('Please select target to attack. ')
        ok = w ? 1 : 0
        if (!g.marks[y * 40 + x]) ok = 0
        if (MapGame.teamOf(w) === g.turnPlayer + 1) ok = 0
        break
      case 8:
        ok = g.land[y * 40 + x] > -1 ? 1 : 0
        text = sj('Which land will you use this on? ')
        break
      default:
        ok = 1
        text = sj('Is it all right to use this? ')
    }
    if ([56, 52, 51, 8, 7, 6].includes(this.abId) && this.abUser && this.abUser.posX >> 6 === x && this.abUser.posY >> 6 === y) ok = 0
    this.abTarget = g.unitOfWord(w) ?? g.units[0][0]
    if (!this.abSel) {
      if (range >= 0 && this.abUser) g.markAttackRange(this.abUser, range)
      h.close('info')
      h.close('help')
      const top = h.win('top')
      if (top) {
        top.win.x = 0
        top.win.y = 8
      }
      const m = h.msg('msg', 0, 0, text, 0x16, 0x3000)
      m.win.y = (top?.win.y ?? 8) + (top?.win.h ?? 0)
      this.abSel = 1
    }
    if (this.abId === A.dominationCall) {
      this.abSel = 0
      return 0
    }
    if (this.P & PAD_CROSS && ok) {
      this.abSel = 0
      g.onSe(7)
      return 1
    }
    if (this.P & PAD_CIRCLE) {
      this.abSel = 0
      g.onSe(9)
      return -1
    }
    return 0
  }

  /** abilityConfirmTarget(id, mode) (0x08860E90). */
  private confirmTarget(id: number, mode: number): number {
    const g = this.g, h = this.h
    const x = g.cursor.x >> 6, y = g.cursor.y >> 6
    const w = g.getCell(x, y) > 0 ? g.grid[y * 40 + x] : 0
    let slot = (w >>> 16) & 0xff
    if (slot === 0xff) slot = 0
    const user = this.abUser!, tgt = this.abTarget
    const self = user.player + 1 === w >>> 28 && user.slot === slot
    let v = 0
    let text: Uint8Array = sj('')
    const ally = sj('＠ｎ( This unit is an ＠ｃ１Ally unit＠ｃ０.)  ')
    switch (mode) {
      case 1:
      case 5:
        if (!w) v = -1
        if (self) v = -1
        if (v >= 0) {
          v = 1
          text = sj('Is it all right to use the card on this unit? ')
          if (tgt && user.team === tgt.team) text = cat(text, ally)
        }
        break
      case 2:
      case 6: {
        const t = cardType(tgt?.cardId ?? 0)
        v = t === CT_UNIT || t === CT_CHARA ? 1 : -1
        if (self) v = -1
        if (v >= 0) {
          text = sj('Is it all right to use the card on this unit? ')
          if (tgt && user.team === tgt.team) text = cat(text, ally)
        }
        break
      }
      case 3:
        if (!w) v = -1
        if (cardType(tgt?.cardId ?? 0) !== CT_BASE) v = -1
        if (v >= 0) {
          v = 1
          text = sj('Is it all right to use the card on this base? ')
          if (id === A.destroyOutpost && tgt?.team === g.turnPlayer) text = cat(text, '＠ｎ( This base is an ＠ｃ１Ally base＠ｃ０.)  ')
        }
        break
      case 7:
        if (!w) v = -1
        if (tgt && user.team === tgt.team) v = -1
        if (v >= 0) {
          v = 1
          text = sj('Begin battle ')
        }
        break
      case 8:
        if (g.land[y * 40 + x] < 0) v = -1
        if (v >= 0) {
          v = 1
          text = sj('Is it all right to use the card on this land? ')
        }
        break
      case 10:
      case 11:
        v = 1
        text = cat('Is it all right to use ＠ｎ', h.abilityName(id), '? ')
        break
      default:
        text = cat('Is it all right to use ＠ｎ', h.abilityName(id), '? ')
    }
    if (v >= 0) {
      if (id === A.dominationCall) {
        if (!this.abConf) for (const u of this.neighbours(user.posX >> 6, user.posY >> 6)) g.marks[(u.posY >> 6) * 40 + (u.posX >> 6)] = 0
      } else if (id === A.pickPocket) {
        if (user.posX >> 6 === x && user.posY >> 6 === y) v = 0
      } else if (id === A.rotatingSlash) {
        if (!this.neighbours(user.posX >> 6, user.posY >> 6).length) {
          text = sj('There are no units in neighboring land. ')
          v = 0
        }
      } else if (id === A.assassinate && tgt) {
        if (g.countAbility(tgt, A.deathDefense)) v = 0
        if (v === 0) text = cat('Cannot be used against units with ', h.abilityName(A.deathDefense), '. ')
      }
    }
    if (this.abConf) {
      if (this.P & PAD_CROSS) {
        this.abConf = 0
        if (v > 0) {
          h.closeAll()
          g.onSe(7)
          return v
        }
        g.onSe(9)
        return -1
      }
      if (this.P & PAD_CIRCLE) {
        this.abConf = 0
        g.onSe(9)
        return -1
      }
    } else {
      h.close('info')
      h.close('msg')
      h.close('help')
      const top = h.win('top')
      if (top) {
        top.win.x = 0
        top.win.y = 8
      }
      const m = h.msg('msg', 0, 8, text, 0x16, 0x3000)
      m.win.y = (top?.win.y ?? 8) + (top?.win.h ?? 0)
      const hl = h.msg('help', 0, 0, h.str(v < 1 ? S.returnB3 : S.acceptCancel3), 0x14, 0x3000)
      hl.win.y = m.win.y + m.win.h
      this.abConf = 1
    }
    if (v < 0) {
      this.abConf = 0
      g.onSe(10)
      return v
    }
    return 0
  }

  /**
   * abilityDispatch(0, 1): below 1000 the cost window, then the handler of g_abilityCurId; 1000 pick,
   * 0x44C confirm, 2000 → 0x834 effect → 3000 resolve (a message) → 9999; afterwards Cross/Circle closes
   * and the ability's cost and Soul are paid. Returns −1 cancelled, 0x834 a battle (Boost), 1 done.
   */
  ability(): number {
    const g = this.g, h = this.h
    let r = 0
    if (this.abState < 1000) {
      const c = this.confirmUse(this.abId)
      if (c > 0) this.abState = 1000
      if (c < 0) {
        h.closeAll()
        return -1
      }
      if (c !== 0) this.selectTarget(0, 0)
      return 0
    }
    r = this.abilityHandler()
    if (this.abState === 0) {
      this.clearRange()
      if (r) h.closeAll()
      return r
    }
    const k = Math.trunc(this.abState / 1000)
    if (k === 1) {
      if (r >= 1) this.abState = 2000
      r = 0
    } else if (k === 2) {
      if (this.abState === 2000) {
        h.closeAll()
        this.clearRange()
        this.abState = 0x834
      } else if (this.abState === 0x834) {
        h.effect(g.ability(this.abId)?.effect ?? 0)
        this.abState++
      } else if (!h.effectBusy()) this.abState = 3000
      r = 0
    } else if (k === 3) {
      if (!h.isOpen('top')) h.msg('top', 320, 8, h.abilityName(this.abId), 0x14, 0x7000)
      if (r >= 1) this.abState = 9999
      r = 0
    } else if (this.abState > 3999) {
      if (r >= 0) {
        if (r === 1) r = 0
        if (r === 0 && this.P & (PAD_OK | PAD_POINTER)) r = 1
      }
      if (r > 0) {
        h.closeAll()
        const ab = g.ability(this.abId)
        const p = g.players[g.turnPlayer]
        const [rc, rs] = g.calcPayment(p, ab?.useCost ?? 0, ab?.useSoul ?? 0, 0x10)
        p.cost = rc
        p.soul = rs
      }
    }
    if (r !== 0) h.closeAll()
    return r
  }

  private clearRange() {
    this.g.marks.fill(0)
  }

  /** The ability* handlers (states 1000 / 0x44C / 2000 / 3000 / 4000+). */
  private abilityHandler(): number {
    const g = this.g, h = this.h
    const id = this.abId
    const st = this.abState
    const user = this.abUser!
    const tgt = this.abTarget
    const unitPick = (mode: number, range: number, confirmMode: number, clearR: number) => {
      if (st === 0x44c) {
        const c = this.confirmTarget(id, confirmMode)
        if (c > 0) this.abState = 2000
        if (c < 0) this.abState = 1000
        return 0
      }
      if (st === 1000) {
        const s = this.selectTarget(mode, range)
        if (s > 0) this.abState = 0x44c
        if (s < 0) this.abState = 0
        if (s !== 0 && clearR >= 0) this.clearRange()
        return 0
      }
      return 0
    }
    const selfPick = (confirmMode: number, clear: boolean) => {
      if (st === 1000) {
        this.selectTarget(11, 2)
        this.abState = 0x44c
      }
      const c = this.confirmTarget(id, confirmMode)
      if (c !== 0 && clear) this.clearRange()
      if (c > 0) this.abState = 2000
      if (c < 0) this.abState = 0
      return 0
    }
    const hpMsg = (u: Unit, v: number) => {
      this.center('msg', cat(h.name(u.cardId), ` ＠ｎHP ${arrow(u.hp, v)}`))
      u.hp = v
    }
    switch (id) {
      case A.snipe1:
      case A.snipe2:
      case A.snipe3: {
        if (st === 3000 && tgt) {
          hpMsg(tgt, Math.max(0, tgt.hp - user.effAp))
          return 1
        }
        if (st === 2000) return 1
        const r = id === A.snipe2 ? 3 : id === A.snipe3 ? 4 : 2
        return unitPick(5, r + 1, 5, 0)
      }
      case A.footStamp:
        if (st === 3000 && tgt) {
          this.center('msg', sj('Unable to act '))
          tgt.status |= 2
          tgt.actFlags |= 0xf
          return 1
        }
        if (st === 2000) return 1
        return unitPick(5, 2, 5, -1)
      case A.assassinate:
        if (st === 3000 && tgt) {
          hpMsg(tgt, 0)
          return 1
        }
        if (st === 2000) return 1
        return unitPick(5, 4, 5, 0)
      case A.castSpell:
        if (st === 3000) {
          h.close('msg')
          this.center('msg', h.str(S.castSpell))
          g.players[g.turnPlayer].flags |= 0x200
          return 1
        }
        if (st === 2000) return 1
        if (st === 1000) {
          const c = this.confirmTarget(id, 10)
          if (c > 0) this.abState = 2000
          if (c < 0) this.abState = 0
        }
        return 0
      case A.destroyOutpost:
        if (st === 3000 && tgt) {
          this.center('msg', cat(h.name(user.cardId), ` ＠ｎHP ${arrow(user.hp, 0)} ＠ｎ`, h.name(tgt.cardId), ` ＠ｎHP ${arrow(tgt.hp, 0)}`))
          user.hp = 0
          tgt.hp = 0
          return 1
        }
        if (st === 2000) return 1
        return unitPick(3, -1, 3, 0)
      case A.berserk:
        if (st === 3000) {
          const rows: [Unit, number][] = [[user, Math.max(0, user.hp - 2)]]
          for (const v of this.neighbours(g.cursor.x >> 6, g.cursor.y >> 6)) if (v !== user) rows.push([v, Math.max(0, v.hp - 2)])
          const m = h.frame('msg', 320, 224, 387, 72, 16, 10, 0xc000)
          h.print('msg', 0, 0, 0x14, sj('Unit name '))
          h.print('msg', 0xfc, 0, 0x14, sj('HP '))
          rows.forEach(([u, v], i) => {
            h.print('msg', 0, 0x15 * (i + 1), 0x14, h.name(u.cardId))
            h.print('msg', 0xfc, 0x15 * (i + 1), 0x14, sj(arrow(u.hp, v)))
            u.hp = v
          })
          m.win.h += (rows.length - 1) * 21
          return 1
        }
        if (st === 2000) return 1
        return selfPick(11, true)
      case A.boost:
        if (st === 3000) {
          user.status |= 1
          this.abState = 4000
          return 0x834
        }
        if (st === 2000) {
          g.cursor.x = user.posX
          g.cursor.y = user.posY
          return 1
        }
        if (st === 0x44c) {
          const c = this.confirmTarget(id, 7)
          if (c !== 0) this.clearRange()
          if (c > 0) {
            g.cursor.x = user.posX
            g.cursor.y = user.posY
            this.abState = 2000
          }
          if (c < 0) this.abState = 1000
          return 0
        }
        if (st === 1000) {
          const s = this.selectTarget(7, 0)
          if (s !== 0) this.clearRange()
          if (s > 0) this.abState = 0x44c
          if (s < 0) this.abState = 0
        }
        return 0
      case A.mindRead:
        if (st === 3000) {
          const p = g.players[g.turnPlayer]
          const c = this.drawUpdate(p, 2, 6)
          if (c === 0) return 0
          if (c < 0) return 1
          this.center('msg', sprintf(h.str(S.drawn), h.name(c)))
          g.compactHand(p)
          return 1
        }
        if (st === 2000) return -1
        if (st === 1000) {
          const c = this.confirmTarget(id, 11)
          if (c > 0) this.abState = 2000
          if (c < 0) this.abState = 0
        }
        return 0
      case 35:
      case 36:
      case 37:
      case 38: {
        if (st === 3000) {
          const attr = id - 34
          const names = ['', 'Earth', 'Water', 'Fire', 'Air']
          g.land[(g.cursor.y >> 6) * 40 + (g.cursor.x >> 6)] = attr
          this.center('msg', sj(`The land' s attribute has changed to ${names[attr]}. `))
          g.recalcAll()
          return 1
        }
        if (st === 2000) return 1
        return unitPick(8, -1, 8, -1)
      }
      case A.baseRepair:
        if (st === 3000 && tgt) {
          hpMsg(tgt, Math.min(tgt.maxHp, tgt.hp + 3))
          return 1
        }
        if (st === 2000) return 1
        return unitPick(3, -1, 3, -1)
      case A.evolution:
        if (st === 3000) {
          user.baseAp = Math.min(99, user.baseAp + 2)
          const before = user.effAp
          g.recalc(user)
          this.center('msg', sj(`AP ${arrow(before, user.effAp)}`))
          return 1
        }
        if (st === 2000) return 1
        return selfPick(11, false)
      case A.rotatingSlash:
        if (st === 3000) {
          const rows = this.neighbours(g.cursor.x >> 6, g.cursor.y >> 6).map((v): [Unit, number] => [v, Math.max(0, v.hp - 2)])
          this.hpTable(387, 51, rows)
          return 1
        }
        if (st === 2000) return 1
        return selfPick(11, true)
      case A.pickPocket: {
        if (st === 3000 && tgt) {
          const n = g.attachedCount(tgt)
          let text: Uint8Array
          if (n === 0) text = h.str(S.noAttachment)
          else if (g.attachedCount(user) < 6) {
            const k = ((g.randSpell() & 0xffff) + 1) % n
            const a = tgt.attachments[k]
            text = sprintf(h.str(S.seized), h.name(a))
            if (a) {
              g.removeBaseAura(tgt)
              g.removeBaseAura(user)
              g.attachmentOp(tgt, a, 2)
              g.attachmentOp(user, a, 1)
              g.recalcAll()
              g.placeOnGrid(tgt)
              g.placeOnGrid(user)
            }
          } else text = sj('No more attachment cards can be attached. ')
          this.center('msg', text)
          g.recalcAll()
          return 1
        }
        if (st === 2000) return 1
        if (st === 0x44c) {
          const c = this.confirmTarget(id, 2)
          if (c !== 0) this.clearRange()
          if (c > 0) this.abState = 2000
          if (c < 0) this.abState = 1000
          return 0
        }
        if (st === 1000) {
          const s = this.selectTarget(2, 2)
          if (s > 0) this.abState = 0x44c
          if (s < 0) this.abState = 0
        }
        return 0
      }
      case A.dominationCall: {
        if (st === 3000) {
          const tp = g.turnPlayer
          const before = g.conquestCount[tp]
          const x = g.cursor.x >> 6, y = g.cursor.y >> 6
          for (const [dx, dy] of [[-1, 0], [0, -1], [1, 0], [0, 1]]) {
            const nx = x + dx, ny = y + dy
            if (g.inBoard(nx, ny) && g.land[ny * 40 + nx] > -1 && g.grid[ny * 40 + nx] === 0) g.conquest[ny * 40 + nx] = 1 << (tp + 12)
          }
          g.commitConquest()
          const m = h.frame('msg', 320, 224, 191, 76, 16, 10, 0xc000)
          h.print('msg', Math.trunc(m.win.w / 2 - 69), 0, 0x16, sj('Conquest '))
          h.print('msg', 0, 0x17, 0x16, sj(`${d3(before)} ⇒ ${d3(g.conquestCount[tp])}`))
          return 1
        }
        if (st === 2000) return -1
        return selfPick(11, true)
      }
    }
    return 0
  }

  // ---- map spells (mapSpellCastUpdate 0x08845B0C) ----

  spState = 0
  spCard = 0
  /** g_mapSpellTarget / g_mapSpellTarget2. */
  spTarget: Unit | null = null
  spTarget2: Unit | null = null
  /** g_mapSpellTargetMode (set by spellSelectTarget, or spellGetTargetMode for the CPU). */
  spMode = 0
  /** DAT_089b84b0 / DAT_089b84b1: the select / confirm windows are open. */
  private selOpen = 0
  private confOpen = 0
  /** DAT_089b798c: the card has been paid (some handlers pay in state 4000). */
  private spPaid = false
  /** DAT_089b7970: the side the report shows. */
  private spSide = 0
  /** DAT_089b7950 / DAT_089b7954: hand place and deck slot of the cast card. */
  private spHandPos = 0
  private spSlot = 0
  /** g_mapSpellPicks (slot | cell << 16) and g_mapSpellPickCount (Shard of Life, Divine Light). */
  picks = [0, 0, 0, 0]
  pickCount = 0
  /** g_mapSpellChosenAttr (Cityscape Mirage). */
  private chosenAttr = 0
  /** DAT_089b7988: cards discarded so far (Memory Slip). */
  private spCount = 0
  /** DAT_089b7e90: deck slot of each row of the discard-pile list. */
  private listSlots: number[] = []
  /** The shared sprintf buffer 0x089D1EE0: texts that no case rewrites keep the previous one. */
  private buf: Uint8Array = new Uint8Array(0)
  /** g_turnReportNames / Values as the area spells fill them: [own team, other team] × 16. */
  private areaRows: [Uint8Array, Uint8Array][][] = [[], []]
  /** The CPU's target (aiChooseMapSpell → g_duelAttackerUnit). */
  cpuTarget: Unit | null = null

  private setBuf(...parts: (string | Uint8Array)[]) {
    this.buf = cat(...parts)
  }
  /** winOpenMessage + drawStyle 10 + w/h 10, and optionally tailIdx. */
  private m(key: string, x: number, y: number, text: Uint8Array, glyph: number, flags: number, tail = 0) {
    const w = this.h.msg(key, x, y, text, glyph, flags)
    if (tail) w.win.tailIdx = tail
    return w
  }

  /**
   * spellSelectTarget(card, mode) (0x0883A514). Modes: 1 occupied, 2 unit / Dominator, 3 base, 4 land,
   * 5 area centre, 6 marked square, 7 player list, 8 opponent, 10 / 12 caster, 11 discard-pile list.
   */
  private spellSelect(card: number, mode: number): number {
    const g = this.g, h = this.h
    const tp = g.turnPlayer
    const p = g.players[tp]
    let v = 0
    let n = 0
    if (card === 2106) {
      for (const q of g.units) for (const u of q.slice(1)) if (u.hp > 0 && u.state > 0) n++
      if (n === 0) {
        this.setBuf('There are no target units on the board. ')
        v = -1
      }
    } else if (card === 2105) {
      for (const u of g.units[tp].slice(1)) if (cardType(u.cardId) === CT_UNIT && u.hp > 0 && u.state > 0) n++
      if (n === 0) {
        this.setBuf('There are no target units on the board. ')
        v = -1
      } else {
        n = 0
        if (!this.selOpen) g.markUsable(p, 0x200)
        for (let i = 0; i < 6; i++) if (p.usable[i] === 1 && cardType(p.deck[p.hand[i]] ?? 0) === CT_UNIT) n++
        if (n === 0) {
          this.setBuf('There are no unit cards in your hand. ')
          v = -1
        }
      }
    }
    if (!this.selOpen) h.closeAll()
    else if (mode !== 11 && mode !== 7 && v >= 0) {
      if (!h.cursorStep()) return v
    }
    const x = g.cursor.x >> 6, y = g.cursor.y >> 6
    const w = x >= 0 && y >= 0 && x < 40 && y < 40 ? g.grid[y * 40 + x] : 0
    if (v >= 0) {
      switch (mode) {
        case 1:
          this.setBuf('Which unit will the card be used on? ')
          if (w !== 0) v = 1
          break
        case 2:
          this.setBuf('Which unit will the card be used on? ')
          if (w !== 0 && (w & 0xffff) < 2000) v = 1
          break
        case 3:
          this.setBuf('Which base will the card be used on? ')
          if (w !== 0 && (w & 0xffff) > 3000) v = 1
          break
        case 4:
          this.setBuf('Which land will the card be used on? ')
          if (g.land[y * 40 + x] > -1) v = 1
          break
        case 5:
          this.setBuf('Where will the card be used? ')
          if (g.land[y * 40 + x] > -1) v = 1
          break
        case 6:
          if (g.marks[y * 40 + x]) v = 1
          break
        case 7:
          this.setBuf('Which player will the card be used on? ')
          v = 1
          break
        case 8:
          this.buf = h.str(S.spellOpponent)
          break
        case 10:
        case 12:
          this.setBuf('Is it all right to use ＠ｎ', h.name(this.spCard), '? ')
          v = 1
          break
        case 11:
          this.buf = h.str(S.selectRevive)
          v = 1
          break
      }
    }
    if (mode === 11 || mode === 12 || mode === 10) this.spTarget = g.units[tp][0]
    else if (mode === 8) this.spTarget = g.units[(tp + 1) & 1][0]
    else if ((mode === 3 || mode === 2 || mode === 1) && w !== 0) this.spTarget = g.unitOfWord(w)
    if (card === 2106 && v >= 0 && cardType(w & 0xffff) !== CT_UNIT) v = 0
    if (!this.selOpen) {
      if (mode === 11) {
        const items: Uint8Array[] = []
        this.listSlots = []
        for (let s = 0; s < 31; s++) {
          if (!(p.deckState[s] & 8)) continue
          let id = p.deck[s] ?? 0
          for (let k = 0; k < 4; k++) if ((this.picks[k] & 0xffff) === s) id = 0
          if (id > 0 && cardType(id) !== CT_SPELL) {
            items.push(h.name(g.units[p.index][s].cardId))
            this.listSlots.push(s)
          }
        }
        this.listItems = items
        if (items.length === 0) {
          this.setBuf('There are no revivable cards in the discard pile. ')
          v = -1
        } else if (g.placedCount[p.index] + this.pickCount > 15) {
          this.setBuf('You cannot place any more units. ')
          v = -1
        }
      }
      h.closeAll()
      const info = this.m('info', 8, 8, h.name(card), 0x14, 0x3000)
      const msg = this.m('msg', 8, info.win.h + 8, this.buf, 0x16, 0x3000, 1)
      const tc = this.m('tc', 8, 0, h.cardText(card), 0x14, 0x3000, 1)
      tc.win.y = 448 - tc.win.h - 8
      if (v < 0) {
        this.m('help', 8, msg.win.y + msg.win.h, h.str(S.spellReturn), 0x12, 0x3000)
        g.onSe(10)
      }
      this.selOpen = 1
    }
    this.spMode = mode
    if (mode === 11) {
      if (this.selOpen === 1) {
        const txt = this.pickCount < 1 ? (v < 0 ? S.listCancel : S.listAccept) : v < 0 ? S.listReturnEnd : S.listAcceptEnd
        h.close('help')
        const msg = h.win('msg')!.win
        this.m('help', msg.x, msg.y + msg.h, h.str(txt), 0x12, 0x3000)
      }
      if (v >= 0 && this.selOpen === 1) {
        const k = this.listItems.length
        const lw = h.openList('menu', 0, 0, 272, k < 6 ? k * 21 + 20 : 125, this.listItems, 0x14, k < 6 ? 0x800 : 0x810)
        lw.win.x = 320 - lw.win.w / 2
        lw.win.y = 224 - lw.win.h / 2
      }
      this.selOpen = 2
      if (h.isOpen('menu')) h.listInput('menu')
      if (this.P & PAD_CROSS) {
        if (h.isOpen('menu')) {
          const c = h.listCursor('menu')
          this.selOpen = 0
          this.picks[this.pickCount] = this.listSlots[c] ?? 0
          h.closeAll()
          g.onSe(7)
          return v
        }
        g.onSe(10)
      } else {
        if (this.P & PAD_CIRCLE) {
          this.selOpen = 0
          g.onSe(9)
          if (this.pickCount > 0) {
            this.pickCount--
            const s = this.picks[this.pickCount] & 0xffff
            if (s) p.deckState[s] |= 8
            this.picks[this.pickCount] = 0
            h.close('menu')
            return 0
          }
          h.closeAll()
          return -1
        }
        if (this.P & PAD_SQUARE && this.pickCount > 0) {
          this.selOpen = 0
          h.closeAll()
          g.onSe(7)
          return 4
        }
      }
      return 0
    }
    if (mode === 7) {
      if (!h.isOpen('menu')) {
        this.spMode = 7
        const names: Uint8Array[] = []
        for (let q = 0; q < 2; q++) if (g.units[q][0].hp > 0) names.push(h.name(g.units[q][0].cardId))
        h.openList('menu', 64, 160, 251, names.length * 21 + 20, names, 0x14, 0x800)
        return 0
      }
      h.listInput('menu')
      if (this.P & PAD_CROSS) {
        if (v > 0) {
          // g_mapUnits + cursor · 31: the list row is taken as the player index
          this.spTarget = g.units[h.listCursor('menu')]?.[0] ?? g.units[0][0]
          this.selOpen = 0
          g.onSe(7)
          return v
        }
        if (v < 0) g.onSe(10)
      } else if (this.P & PAD_CIRCLE) {
        this.selOpen = 0
        h.closeAll()
        g.onSe(9)
        return -1
      }
      return 0
    }
    if (mode === 12 || mode === 10 || mode === 8) {
      this.selOpen = 0
      return 1
    }
    if (this.P & PAD_CROSS) {
      if (v > 0) {
        this.selOpen = 0
        return v
      }
    } else if (this.P & PAD_CIRCLE) {
      this.selOpen = 0
      g.onSe(9)
      return -1
    }
    return 0
  }
  private listItems: Uint8Array[] = []

  /** spellConfirmTarget(card, mode) (0x0883B7B8): the legality checks and the Accept / Return window. */
  private spellConfirm(card: number, mode: number): number {
    const g = this.g, h = this.h
    const x = g.cursor.x >> 6, y = g.cursor.y >> 6
    const tp = g.turnPlayer
    const t = this.spTarget ?? g.units[tp][0]
    let v = 0
    if (!this.confOpen) h.closeAll()
    this.buf = new Uint8Array(0)
    const w = g.grid[y * 40 + x] ?? 0
    switch (mode) {
      case 0:
        v = 1
        break
      case 1:
        if ((w | 0) > 0) {
          this.setBuf('Is it all right to use the card on this unit? ')
          v = 1
        }
        break
      case 2:
      case 9:
        if ((w | 0) > 0 && t.cardId < 2000) {
          this.setBuf('Is it all right to use the card on this unit? ')
          v = 1
        }
        break
      case 3:
        if ((w | 0) > 0 && cardType(t.cardId) === CT_BASE) {
          v = 1
          this.setBuf('Is it all right to use the card on this base? ')
          if (t.team === tp) this.buf = cat(this.buf, '＠ｎ( This base is an ＠ｃ１Ally unit＠ｃ０. )  ')
        }
        break
      case 4:
        this.setBuf('Is it all right to use the card on this land? ')
        v = 1
        break
      case 5:
        this.buf = h.str(S.spellHere)
        v = 1
        break
      case 6:
        this.setBuf('Is it all right to use the card on this area? ')
        v = 1
        break
      case 7:
        this.setBuf('Is it all right to use the card ＠ｎon ', h.name(t.cardId), '? ')
        v = 1
        break
      case 8:
        this.buf = h.str(S.spellOpp2)
        v = 1
        break
      default:
        if (mode === 10 || mode === 11 || mode === 12) v = 1
        this.setBuf('Is it all right to use  ＠ｎ', h.name(card), '? ')
    }
    const landText: Record<number, string> = { 2502: 'Earth', 2503: 'Water', 2504: 'Fire', 2505: 'Air' }
    if (landText[card]) this.setBuf(`The attribute of this land will become ${landText[card]}. `)
    else if (card === 2508) this.buf = h.str(S.lordOfBlanks)
    else if (card === 2509) this.setBuf('Please select the new attribute. ')
    else if (card === 2510) this.buf = h.str(S.flamesOk)
    if ([2001, 2003, 2004, 2005, 2006, 2009, 2010].includes(card)) {
      if (g.countAbility(t, A.annulAttack)) v = -1
      if (v < 0) this.buf = h.str(S.noAttack)
      else if (t.team === tp) this.buf = cat(this.buf, '＠ｎ（This unit is an ＠ｃ１Ally unit＠ｃ０.）')
    }
    if (card > 0x8fc && card < 0x960 && v >= 0) {
      if (g.countAbility(t, A.unableBuff)) v = -1
      if (v < 0) this.buf = h.str(S.noBuff)
    }
    if ([2003, 2004, 2005, 2006].includes(card) && v >= 0) {
      if (g.countAbility(t, A.deathDefense)) v = -1
      if (v < 0) this.buf = h.str(S.noDeath)
    }
    if (mode === 9) {
      if (card === 2203) {
        if (v >= 0 && g.attachedCount(t) === 0) {
          this.buf = h.str(S.noAttached)
          v = -1
        }
      } else if (v >= 0 && g.attachedCount(t) > 5) {
        this.buf = h.str(S.sixAttached)
        v = -1
      }
    }
    if (mode === 4) {
      if (v >= 0 && g.countBaseAuras(x, y, 0xf, 3005)) {
        this.buf = sprintf(h.str(S.barrier), h.name(3005))
        v = -1
      }
    } else if (![5, 6, 7, 8, 10, 11, 12].includes(mode)) {
      if (v >= 0 && !g.countAbility(t, A.annulBase) && g.countBaseAuras(x, y, 0xf, 3005)) {
        this.buf = sprintf(h.str(S.barrier), h.name(3005))
        v = -1
      }
    }
    const handOf = (q: number) => g.handCount(g.players[q])
    if (v >= 0) {
      if (card === 2611) {
        v = -1
        for (let i = 0; i < 32; i++) if ((g.players[tp].deckState[i] ?? 0) & 8) v = 1
        if (v < 0) this.setBuf('There are no cards in the discard pile. ')
      } else if (card === 2610) {
        if (t.team !== tp) {
          this.setBuf('You cannot use this on enemy units. ')
          v = -1
        }
        if (v > 0) {
          g.onSe(7)
          return v
        }
      } else if (card === 2609) {
        g.countDeployed()
        if (g.placedCount[0] === g.placedCount[1]) {
          this.setBuf('The number of units dispached is the same. ')
          v = -1
        }
      } else if (card === 2606) {
        if (handOf(t.player) === 0) {
          this.buf = sprintf(h.str(S.noHand), h.playerName(g.players[t.player].index))
          v = -1
        }
      } else if (card === 2607 || card === 2605) {
        if (card === 2605 && g.players[t.player].flags & 8) v = -1
        if (card === 2607 && g.players[t.player].flags & 0x10) v = -1
        if (v < 0) this.buf = sprintf(h.str(S.alreadyFlag), h.name(card))
      } else if (card === 2602) {
        if (handOf(t.player) > 4) {
          this.buf = sprintf(h.str(S.handOver5), h.playerName(g.players[t.player].index))
          v = -1
        }
      } else if (card === 2601) {
        const q = g.players[t.player]
        v = -1
        for (let i = 0; i < 6; i++) {
          if (t.player === tp) {
            if (i !== q.cursor >> 5 && q.hand[i] > 0) v = 1
          } else if (q.hand[i] > 0) v = 1
        }
        if (v < 0) this.setBuf('Your opponent has no cards in hand. ')
      } else if (card === 2510) {
        if (w !== 0) v = -1
        if (v < 0) this.setBuf('You cannot use this on land inhabited by a unit. ')
      } else if (card === 2501) {
        v = -1
        for (let yy = 0; yy < g.H; yy++) for (let xx = 0; xx < g.W; xx++) if (g.conquest[yy * 40 + xx] & (1 << (tp + 12)) && g.grid[yy * 40 + xx] === 0) v = 1
        if (v < 0) this.setBuf('You do not have allied land to relinquish. ')
      } else if (card !== 2507 && card !== 2204) {
        if (card === 2108) {
          if (t.team === tp) {
            this.setBuf('You cannot use this on ally units. ')
            v = -1
          } else if (t.slot === 0) {
            this.setBuf('You cannot use this on Dominators. ')
            v = -1
          } else if (g.placedCount[(t.team + 1) & 1] > 15) {
            this.buf = h.str(S.noMoreAllies)
            v = -1
          }
        } else if (card === 2106) {
          if (v >= 0) {
            if (t.slot === 0) {
              this.setBuf('You cannot use this on Dominators. ')
              v = -1
            } else if (cardType(t.cardId) === CT_BASE) {
              this.setBuf('You cannot use this on bases. ')
              v = -1
            }
            if (v > 0) {
              g.onSe(7)
              return v
            }
          }
        } else if (card === 2105) {
          if (v >= 0) {
            if (t.team === tp) {
              if (t.slot === 0) {
                this.setBuf('You cannot use this on Dominators. ')
                v = -1
              } else if (cardType(t.cardId) === CT_BASE) {
                this.setBuf('You cannot use this on bases. ')
                v = -1
              } else if (t.player !== t.team) {
                this.buf = h.str(S.noReturn)
                v = -1
              }
            } else {
              this.setBuf('You cannot use this on enemy units. ')
              v = -1
            }
            if (v > 0) {
              g.onSe(7)
              return v
            }
          }
        } else if (card === 2006) {
          if (v >= 0) {
            if (t.hp + t.effDf < 5) v = -1
            if (v < 0) this.buf = h.str(S.hpDf5)
          }
        } else if (card === 2005) {
          if (v >= 0) {
            if (t.effAp < 4) v = -1
            if (v < 0) this.setBuf('This unit has less than ＠ｎ4 AP. ')
          }
        } else if ([2206, 2109, 2107, 2104].includes(card)) {
          if (t.slot === 0) v = -1
          if (v < 0) this.setBuf('You cannot use this on Dominators. ')
        }
      }
    }
    if (!this.confOpen) {
      const msg = this.m('msg', 8, 8, this.buf, 0x16, 0x3000, 1)
      const help = v > 0 ? h.str(S.accept) : v < 0 ? h.str(S.spellReturn) : this.buf
      this.m('help', 8, msg.win.y + msg.win.h, help, 0x12, 0x3000)
      if (![12, 11, 10, 8].includes(mode) && v > 0) g.onSe(7)
      if (v < 0) g.onSe(10)
    }
    this.confOpen = 1
    if (card === 2509) {
      if (v > 0) {
        if (!h.isOpen('menu')) {
          const mw = h.openMenu('menu', 0, 0, 0x16, h.str(S.attrMenu))
          mw.win.x = 320 - mw.win.w / 2
          mw.win.y = 224 - mw.win.h / 2
          return 0
        }
        h.listInput('menu')
      }
      if (this.P & PAD_CROSS) {
        this.confOpen = 0
        if (v < 1) {
          g.onSe(9)
          return -1
        }
        this.chosenAttr = h.listCursor('menu') + 1
        g.onSe(7)
        return v
      }
      if (this.P & PAD_CIRCLE) {
        this.confOpen = 0
        g.onSe(9)
        return -1
      }
      return 0
    }
    if (card === 2107) {
      this.confOpen = 1
      return 0
    }
    if (this.P & PAD_CROSS) {
      this.confOpen = 0
      if (v < 1) {
        g.onSe(9)
        return -1
      }
      g.onSe(7)
      return v
    }
    if (this.P & PAD_CIRCLE) {
      this.confOpen = 0
      g.onSe(9)
      return -1
    }
    return 0
  }

  /** spellSelectCell(mode) (0x0883B608): −1 while the cursor moves, else the cell word / mark / 0. */
  private selectCell(mode: number): number {
    const g = this.g
    if (!this.h.cursorStep()) return -1
    const i = (g.cursor.y >> 6) * 40 + (g.cursor.x >> 6)
    if (mode === 0) return 0
    if (mode === 6) return g.marks[i]
    if (mode === 4) return ((g.land[i] & 0xff) << 16) | g.conquest[i]
    return g.grid[i]
  }

  /** Begin a cast (state 0): the selected hand card of the turn player; the CPU jumps to the counter window. */
  spellBegin() {
    const g = this.g
    const tp = g.turnPlayer
    const p = g.players[tp]
    this.spTarget = g.units[tp][0]
    this.spTarget2 = null
    this.spHandPos = p.cursor >> 5
    this.spSlot = p.hand[this.spHandPos] ?? 0
    this.spCard = p.deck[this.spSlot] ?? 0
    this.pickCount = 0
    this.spSide = 0
    this.picks = [0, 0, 0, 0]
    this.spPaid = false
    this.selOpen = this.confOpen = 0
    g.deployRules &= ~0x10
    this.spState = 1
    if (this.h.isCpu(tp)) {
      this.spMode = spellTargetMode(this.spCard)
      this.spTarget = this.cpuTarget ?? this.spTarget
      this.spState = 3000
    }
  }

  /** One frame of mapSpellCastUpdate: −1 cancelled (back to the hand), 1 done, 0 busy. */
  spell(): number {
    const g = this.g, h = this.h
    if (this.spState === 0) this.spellBegin()
    let r = 0
    let v = 0
    const card = this.spCard
    if (this.spState === 3000) {
      v = this.counterWindow(card, 0x20)
      if (v === 0) return 0
      if (v > 0) {
        if (card === 2612 || card === 2205) {
          for (let k = 0; k < 4; k++) {
            const s = this.picks[k] & 0xffff
            if (s) g.players[g.turnPlayer].deckState[s] |= 8
          }
        }
        this.spState = 9000
      }
    }
    const handler = this.spellHandlerFor(card)
    if (handler) v = handler()
    else r = -1
    if (this.spState !== 0) {
      if (this.spState === 1) this.spState = 1000
      else {
        const k = Math.trunc(this.spState / 1000)
        if (k === 1) {
          if (v > 0) this.spState = 2000
          if (v < 0) r = -1
        } else if (k === 2) {
          if (v >= 1) this.spState = 3000
          else if (v < 0) this.spState = 1000
          if (this.spState === 3000) h.closeAll()
        } else if (k === 3) {
          if (this.spState === 0xbc2) {
            if (!h.effectBusy()) v = 1
          } else if (this.spState === 3000) {
            if (v === 0) v = 1
            else {
              if (v === 1) v = g.card(card)?.mapEffect ?? 0
              h.closeAll()
              g.drawFlags &= ~0x18
              h.effect(v)
              v = 0
              this.spState = 0xbc2
            }
          }
          if (v > 0) this.spState = 4000
        } else if (k === 4) {
          if (!h.isOpen('top')) {
            h.close('top')
            const t = h.frame('top', 320, 16, 0, 51, 16, 10, 0x4000)
            const nm = h.name(card)
            h.print('top', 0, 0, 0x14, nm)
            t.win.w = (nm.length >> 1) * 21 + 30
          }
          if (v < 1) return r
          g.recalcAll()
          g.countDeployed()
          g.updateMaintenance()
          this.spState = 5000
        } else if (this.spState === 5000) {
          if (v < 1) return r
          if (v === 1) {
            if (this.ok()) this.spState = 9000
          } else if (v === 2) this.spState = 9000
        } else if (this.spState === 9000) {
          if (!this.spPaid) {
            this.paySelected(g.players[g.turnPlayer])
            this.spPaid = true
          }
          this.spState = 9999
        } else if (this.spState === 9999 && this.deaths(1)) {
          g.drawFlags |= 0x1c
          g.recalcAll()
          g.countDeployed()
          g.updateMaintenance()
          r = 1
        }
      }
    }
    if (r < 0) g.onSe(9)
    if (r !== 0) {
      h.closeAll()
      this.spState = 0
      g.deployRules |= 0x10
    }
    return r
  }

  /** playerPaySelectedCard: pay with the spell flag (8), clamp 0, clear Cast Spell, discard, leave the hand. */
  paySelected(p: Player) {
    const g = this.g
    const c = g.card(p.deck[p.selected] ?? 0)
    let [rc, rs] = g.calcPayment(p, c?.cost ?? 0, c?.soul ?? 0, 8)
    if (rc < 0) rc = 0
    if (rs < 0) rs = 0
    p.cost = rc
    p.soul = rs
    p.flags &= ~0x200
    p.deckState[p.selected] |= 8
    p.hand[p.cursor >> 5] = 0
    g.compactHand(p)
  }
  /** playerPaySelectedCard inside a handler (DAT_089b798c = 1). */
  private payNow() {
    this.paySelected(this.g.players[this.g.turnPlayer])
    this.spPaid = true
  }

  /** The handler mapSpellCastUpdate dispatches to for a card id (null: not a map spell, the cast returns −1). */
  private spellHandlerFor(card: number): (() => number) | null {
    if ([2617, 2616, 2615, 2614, 2613, 2507, 2204].includes(card)) return () => this.hCasterFlag(card)
    if (card === 2612) return () => this.hRevive(4)
    if (card === 2607 || card === 2605) return () => this.hPlayerFlag(card)
    if (card === 2611) return () => this.hWinter()
    if (card === 2610) return () => this.hRunningWind()
    if (card === 2609) return () => this.hScales()
    if (isAttach(card)) return () => this.hAttach(card)
    if (card === 2606) return () => this.hMill(card)
    if (card === 2604) return () => this.hMill(card)
    if (card === 2603) return () => this.hNewLeaf()
    if (card === 2602) return () => this.hGuest()
    if (card === 2601) return () => this.hMemorySlip()
    if (card === 2510 || card === 2508) return () => this.hLandOwner(card)
    if (card === 2509) return () => this.hMirage()
    if (card === 2506) return () => this.simple(3, 3, (t) => this.hpMsg(t, 0))
    if (card >= 2502 && card <= 2505) return () => this.hSummonLand(card)
    if (card === 2501) return () => this.hRetreat()
    if (card === 2208) return () => this.hGreenNoa()
    if (card === 2205) return () => this.hRevive(1)
    if (card === 2202) return () => this.simple(1, 1, (t) => this.hpMsg(t, Math.min(t.maxHp, t.hp + 5)))
    if (card === 2201) return () => this.simple(1, 1, (t) => this.hpMsg(t, Math.min(t.maxHp, t.hp + 2)))
    if (card === 2109) return () => this.hChickBug()
    if (card === 2108) return () => this.hBetrayer()
    if (card === 2107) return () => this.hRelocation()
    if (card === 2106) return () => this.hMirror()
    if (card === 2105) return () => this.hMask()
    if (card === 2101) return () => this.hPush()
    if (card === 2010) return () => this.simple(1, 1, (t) => this.hpMsg(t, Math.max(0, t.hp - 2 * this.g.attachedCount(t))))
    if (card === 2009) return () => this.simple(1, 1, (t) => this.hpMsg(t, Math.max(0, t.hp - t.effAp)))
    if (card === 2008) return () => this.areaSpell(card, 5)
    if (card === 2007) return () => this.hEarthNova()
    if (card === 2006 || card === 2005 || card === 2003) return () => this.simple(1, 1, (t) => this.hpMsg(t, 0))
    if (card === 2004) return () => this.hHomesick()
    if (card === 2002) return () => this.areaSpell(card, 5)
    if (card === 2001) return () => this.simple(1, 1, (t) => this.hpMsg(t, Math.max(0, t.hp - 3)))
    return null
  }

  /** The common handler shape: 1000 select, 2000 confirm, 3000 → effect, 4000 apply, 5000 wait. */
  private simple(mode: number, confirm: number, apply: (t: Unit) => void) {
    const st = this.spState
    const t = this.spTarget ?? this.g.units[this.g.turnPlayer][0]
    if (st === 5000) return 1
    if (st === 4000) {
      apply(t)
      return 1
    }
    if (st === 3000) return 1
    if (st === 2000) return this.spellConfirm(this.spCard, confirm)
    if (st === 1000) return this.spellSelect(this.spCard, mode)
    return 0
  }
  /** Select without a cursor, then confirm (the no-target handlers: 1000 → 2000 in one frame). */
  private selectThenConfirm(mode: number): number {
    if (this.spState === 1000) {
      this.spellSelect(this.spCard, mode)
      this.spState = 2000
    }
    const c = this.spellConfirm(this.spCard, mode)
    if (c < 0) this.spState = 1000
    return c
  }
  private hpMsg(u: Unit, v: number) {
    this.center('msg', cat(this.h.name(u.cardId), ` ＠ｎHP ${arrow(u.hp, v)} `))
    u.hp = v
  }

  /** spellSetCasterFlag: Return from Shadows 2, Ambush 4, Janess' Shadow 0x20, Breath 0x40, Euro's Shackles, Wings 0x80, Epsilon 0x100. */
  private hCasterFlag(card: number): number {
    const g = this.g, h = this.h
    const st = this.spState
    const tp = g.turnPlayer
    if (st === 5000 || st === 3000) return 1
    if (st !== 4000) return st === 1000 || st === 2000 ? this.selectThenConfirm(12) : 0
    let f = 0
    let text: Uint8Array
    if (card === 2617) {
      f = 0x100
      text = sprintf(h.str(S.epsilon), h.name(g.units[tp][0].cardId))
    } else if (card === 2616) {
      f = 0x80
      text = sj('Ally unit ＠ｎMove +1 ')
    } else if (card === 2615) {
      for (const u of g.allUnits()) if (u.hp > 0) u.status |= 4
      text = sj('Units on the board ＠ｎMove ＝ 1 ')
    } else if (card === 2614) {
      f = 0x40
      text = sj('Ally unit ＠ｎAP+1 ＠ｎDF+1 ')
    } else if (card === 2613) {
      f = 0x20
      text = h.str(S.janess)
    } else if (card === 2507) {
      f = 4
      text = h.str(S.ambush)
    } else {
      f = 2
      text = sj('Revive once ')
    }
    this.center('msg', text)
    g.players[tp].flags |= f
    g.updateMaintenance()
    return 1
  }

  /** spellSetTargetPlayerFlag: Cause for Civil War (8) / Dried-up Well (0x10) on the opponent; no effect. */
  private hPlayerFlag(card: number): number {
    const g = this.g, h = this.h
    const st = this.spState
    const t = this.spTarget ?? g.units[(g.turnPlayer + 1) & 1][0]
    if (st === 5000) return 1
    if (st === 3000) {
      h.closeAll()
      this.spState = 4000
      return 0
    }
    if (st === 4000) {
      this.center('msg', h.str(card === 2607 ? S.dried : S.civilWar))
      g.players[t.player].flags |= card === 2607 ? 0x10 : 8
      return 1
    }
    return st === 1000 || st === 2000 ? this.selectThenConfirm(8) : 0
  }

  /** spellAttachCard: select mode 2, confirm mode 9; the attachment and its message. */
  private hAttach(card: number): number {
    const g = this.g, h = this.h
    const st = this.spState
    const t = this.spTarget ?? g.units[g.turnPlayer][0]
    if (st === 5000 || st === 3000) return 1
    if (st === 2000) return this.spellConfirm(card, 9)
    if (st === 1000) return this.spellSelect(card, 2)
    if (st !== 4000) return 0
    const ap = t.effAp, df = t.effDf, mv = t.effMove
    if (card === 2203) g.attachmentOp(t, 0, 4)
    else g.attachmentOp(t, card, 1)
    g.recalc(t)
    let text: Uint8Array | null = null
    if (card === 2402 || card === 2206 || card === 2104) return 1
    if (card === 2608) text = sprintf(h.str(S.plusActions), g.attachmentOp(t, 2608, 0))
    else if (card === 2310) text = h.str(S.plusPierce)
    else if (card === 2309) {
      const v = Math.max(0, t.hp - 2)
      text = sj(`AP ${arrow(ap, t.effAp)} ＠ｎHP ${arrow(t.hp, v)} ＠ｎDF ${arrow(df, t.effDf)} `)
      t.hp = v
    } else if (card === 2308) text = sprintf(h.str(S.plusSureKill), ap, t.effAp, g.attachmentOp(t, 2308, 0))
    else if (card === 2307) text = h.str(S.plusSupport)
    else if (card === 2306) text = h.str(S.plusFirst)
    else if (card === 2207) text = h.str(S.plusDeathDef)
    else if (card === 2203) text = cat(h.name(t.cardId), ` ＠ｎAP ${arrow(ap, t.effAp)} ＠ｎDF ${arrow(df, t.effDf)} ＠ｎMove ${arrow(mv, t.effMove)} `)
    else if (card === 2103) text = sj('Unable to act ')
    else if (card === 2110 || card === 2102) text = sj(`Move  ${mv} ⇒ ${t.effMove} `)
    else text = sj(`AP ${arrow(ap, t.effAp)} ＠ｎDF ${arrow(df, t.effDf)} `)
    this.center('msg', text)
    return 1
  }

  /** spellHomesick (0x0883D70C): pays first; back to the owner's hand when it holds < 5 cards, else destroyed. */
  private hHomesick(): number {
    const g = this.g, h = this.h
    const st = this.spState
    const t = this.spTarget ?? g.units[g.turnPlayer][0]
    if (st === 5000) return 1
    if (st === 3000) return 1
    if (st === 2000) return this.spellConfirm(this.spCard, 1)
    if (st === 1000) return this.spellSelect(this.spCard, 1)
    if (st !== 4000) return 0
    this.payNow()
    const q = g.players[t.player]
    const n = g.handCount(q)
    t.hp = 0
    let text: Uint8Array
    if (n < 5) {
      let i = 0
      while (i < 6 && q.hand[i] !== 0) i++
      g.destroy(t, false)
      q.deckState[t.slot] = 3
      q.hand[i] = t.slot
      text = sprintf(h.str(S.homesickHand), h.name(t.cardId))
    } else text = sprintf(h.str(S.homesickFull), h.name(t.cardId))
    this.center('msg', text, 0x14)
    g.compactHand(q)
    return 1
  }

  /** The "before ↓ after" frame of Chick Bug Curse / Mirror Reflection (283 × h, names centred on 11 cells). */
  private changeFrame(before: number, after: number, height: number) {
    const h = this.h
    h.close('msg')
    const f = h.frame('msg', 320, 224, 283, height, 16, 10, 0xc000)
    f.win.tailIdx = 1
    const col = (id: number) => Math.trunc((5.5 - (h.name(id).length >> 1) / 2) * 23)
    h.print('msg', col(before), 0, 0x16, h.name(before))
    h.print('msg', 0x73, 0x17, 0x16, h.str(S.downArrow))
    h.print('msg', col(after), 0x2e, 0x16, h.name(after))
  }

  /** spellChickBugCurse (0x0884097C): the unit becomes card 55 (attachments and actions kept). */
  private hChickBug(): number {
    const g = this.g
    const st = this.spState
    const t = this.spTarget ?? g.units[g.turnPlayer][0]
    if (st === 5000 || st === 3000) return 1
    if (st === 2000) return this.spellConfirm(this.spCard, 2)
    if (st === 1000) return this.spellSelect(this.spCard, 2)
    if (st !== 4000) return 0
    const before = t.cardId
    const c = g.card(55)
    t.cardId = 55
    t.maxHp = t.hp = c?.hp ?? 1
    t.baseAp = c?.ap ?? 0
    t.attribute = c?.attribute ?? 0
    g.grid[(t.posY >> 6) * 40 + (t.posX >> 6)] = (((t.slot & 0xff) << 16) | ((t.player + 1) << 28) | (((t.team + 1) & 0xf) << 24) | 55) >>> 0
    this.changeFrame(before, 55, 99)
    g.recalcAll()
    g.updateMaintenance()
    return 1
  }

  /** spellRiseOfTheBetrayer (0x088407F0): pays first; the current owner flips (unitSummonUpdate puts it back). */
  private hBetrayer(): number {
    const g = this.g, h = this.h
    const st = this.spState
    const t = this.spTarget ?? g.units[g.turnPlayer][0]
    if (st === 5000 || st === 3000) return 1
    if (st === 2000) return this.spellConfirm(this.spCard, 1)
    if (st === 1000) return this.spellSelect(this.spCard, 1)
    if (st !== 4000) return 0
    this.payNow()
    g.removeBaseAura(t)
    t.team = (t.team + 1) & 1
    g.placeOnGrid(t)
    this.center('msg', sprintf(h.str(S.betrayer), h.name(t.cardId)))
    return 1
  }

  /** spellMirrorReflection (0x0883F720): the target, then any unit on the board to copy (not a base or Dominator). */
  private hMirror(): number {
    const g = this.g, h = this.h
    const st = this.spState
    const t = this.spTarget ?? g.units[g.turnPlayer][0]
    if (st === 5000) return 1
    if (st === 4000) {
      const o = this.spTarget2 ?? t
      const before = t.cardId
      const c = g.card(o.cardId)
      t.cardId = o.cardId
      t.maxHp = t.hp = c?.hp ?? 0
      t.baseAp = c?.ap ?? 0
      t.attribute = c?.attribute ?? 0
      g.attachmentOp(t, 0, 4)
      t.actFlags = 0
      g.grid[(t.posY >> 6) * 40 + (t.posX >> 6)] = (o.cardId | ((t.slot & 0xff) << 16) | ((t.player + 1) << 28) | (((t.team + 1) & 0xf) << 24)) >>> 0
      this.changeFrame(before, o.cardId, 96)
      g.recalcAll()
      g.updateMaintenance()
      return 1
    }
    if (st === 3000) return 1
    if (st === 2000) {
      if (this.P & PAD_CROSS) {
        g.onSe(7)
        g.cursor.x = t.posX
        g.cursor.y = t.posY
        return 1
      }
      if (this.P & PAD_CIRCLE) {
        h.closeAll()
        g.onSe(9)
        this.spState = 0x4b0
      }
      return 0
    }
    if (st === 0x4c4) {
      if (this.ok()) {
        h.closeAll()
        g.onSe(9)
        this.spState = 0x4b0
      }
      return 0
    }
    if (st === 0x4ba) {
      const w = this.selectCell(2)
      if (w < 0) return 0
      if (w > 0) this.mirrorPick = w
      if (this.P & PAD_CROSS) {
        const pick = this.mirrorPick
        let v = 0
        const ty = cardType(pick & 0xffff)
        if (ty === CT_BASE) {
          this.setBuf('This cannot become a base. ')
          v = -1
        } else if (ty === CT_CHARA) {
          this.setBuf('This cannot become a Dominator. ')
          v = -1
        } else if (ty === CT_UNIT && pick) {
          this.spTarget2 = g.unitOfWord(pick)
          this.buf = sprintf(h.str(S.mirrorConfirm), h.name(t.cardId), h.name(this.spTarget2?.cardId ?? 0))
          v = 1
        }
        if (v !== 0) {
          const msg = this.m('msg', 8, 8, this.buf, 0x16, 0x3000)
          if (v < 0) {
            g.onSe(10)
            this.m('help', 8, msg.win.y + msg.win.h, h.str(S.spellReturn), 0x12, 0x3000)
            this.spState = 0x4c4
            return 0
          }
          g.onSe(7)
          this.m('help', 8, msg.win.y + msg.win.h, h.str(S.accept), 0x12, 0x3000)
          return 1
        }
      } else if (this.P & PAD_CIRCLE) {
        g.onSe(9)
        this.spState = 1000
      }
      return 0
    }
    if (st === 1000) {
      const s = this.spellSelect(this.spCard, 2)
      if (s < 1) return s
      this.spState = 0x44c
      return 0
    }
    if (st === 0x44c) {
      const c = this.spellConfirm(this.spCard, 2)
      if (c < 1) {
        if (c < 0) this.spState = 1000
        return 0
      }
      this.spState = 0x4b0
    }
    if (this.spState === 0x4b0) {
      h.closeAll()
      this.m('msg', 8, 8, h.str(S.mirrorSelect), 0x16, 0x3000)
      this.spState = 0x4ba
    }
    return 0
  }
  /** unaff_s1..s3 of spellMirrorReflection: the last occupied cell word under the cursor. */
  private mirrorPick = 0

  /** spellMaskOfChange (0x0883F218): an own unit goes back to the hand and a unit card from the hand takes its square. */
  private hMask(): number {
    const g = this.g, h = this.h
    const st = this.spState
    const tp = g.turnPlayer
    const p = g.players[tp]
    const t = this.spTarget ?? g.units[tp][0]
    if (st === 5000) return 1
    if (st === 0x1004) {
      const o = this.spTarget2
      if (!o) return 1
      const r = this.summon(o, g.cursor.x, g.cursor.y, 1)
      if (r === 0) return 0
      p.deckState[t.slot] = 3
      p.hand[this.spHandPos] = t.slot
      g.initUnit(t, p.index, p.deck[t.slot] ?? t.cardId, t.slot)
      g.updateMaintenance()
      this.center('msg', sprintf(sj('Trade successful between ＠ｎ%sand ＠ｎ%s. '), h.name(t.cardId), h.name(o.cardId)))
      return 1
    }
    if (st === 4000) {
      t.state = 4
      this.spState = 0x1004
      return 0
    }
    if (st === 3000) return 1
    if (st === 2000) {
      if (this.P & PAD_CROSS) {
        const cur = p.cursor
        this.spTarget2 = g.units[p.index][p.selected] ?? null
        p.cursor = this.spHandPos << 5
        p.selected = this.spSlot
        this.spHandPos = cur >> 5
        g.onSe(7)
        return 1
      }
      if (this.P & PAD_CIRCLE) {
        h.closeAll()
        g.onSe(9)
        this.spState = 0x4b0
      }
      return 0
    }
    if (st === 0x4b0) {
      const k = this.h.handSelect(p, 0x200)
      if (k === -1) this.spState = 1000
      else if (k === 1) {
        g.cursor.x = t.posX
        g.cursor.y = t.posY
        h.closeAll()
        const msg = this.m('msg', 8, 8, sj('Is it all right to use the card on this unit? '), 0x16, 0x3000, 1)
        this.m('help', 8, msg.win.y + msg.win.h, h.str(S.accept), 0x12, 0x3000)
        return 1
      }
      return 0
    }
    if (st === 0x44c) {
      const c = this.spellConfirm(this.spCard, 1)
      if (c < 1) {
        if (c < 0) this.spState = 1000
        return 0
      }
      h.closeAll()
      this.spState = 0x4b0
      return 0
    }
    if (st === 1000) {
      const s = this.spellSelect(this.spCard, 1)
      if (s > 0) {
        this.spState = 0x44c
        return 0
      }
      return s
    }
    return 0
  }

  /** spellRelocation (0x0883FECC): two units (no Dominators) swap squares. */
  private hRelocation(): number {
    const g = this.g, h = this.h
    const st = this.spState
    const a = this.spTarget ?? g.units[g.turnPlayer][0]
    const x = g.cursor.x >> 6, y = g.cursor.y >> 6
    const infoBottom = () => {
      const i = h.win('info')?.win
      return (i?.y ?? 8) + (i?.h ?? 0)
    }
    if (st === 5000 || st === 3000) return 1
    if (st === 4000) {
      const b = g.unitOfWord(g.grid[y * 40 + x])
      if (b) {
        g.removeBaseAura(b)
        g.removeBaseAura(a)
        const ax = a.posX, ay = a.posY
        b.posX = ax
        b.posY = ay
        g.placeOnGrid(b)
        a.posX = g.cursor.x
        a.posY = g.cursor.y
        g.placeOnGrid(a)
        this.center('msg', sprintf(sj('Switched positions of ＠ｎ%s and ＠ｎ%s. '), h.name(a.cardId), h.name(b.cardId)))
      }
      return 1
    }
    if (st === 0x834) {
      if (this.P & PAD_CROSS) {
        g.onSe(7)
        return 1
      }
      if (this.P & PAD_CIRCLE) {
        h.close('msg')
        h.close('help')
        g.onSe(9)
        this.spState = 2000
      }
      return 0
    }
    if (st === 0x7da) {
      if (this.ok()) {
        h.close('msg')
        g.onSe(9)
        this.spState = 2000
      }
      return 0
    }
    if (st === 2000) {
      if (!h.isOpen('msg')) this.m('msg', 0, infoBottom(), h.str(S.relocSelect), 0x16, 0x3000, 1)
      const w = this.selectCell(1)
      if (w === -1) return 0
      if (this.P & PAD_CROSS) {
        if (w === 0) return 0
        const b = g.unitOfWord(w)
        if (!b || (a.player === b.player && a.slot === b.slot)) return 0
        this.spTarget2 = b
        this.spState = 0x834
        if (b.slot === 0) {
          this.buf = h.str(S.relocDominator)
          this.spState = 0x7da
        } else if (g.countBaseAuras(x, y, 0xf, 3005) && !g.countAbility(a, A.annulBase)) {
          this.buf = sprintf(h.str(S.relocBarrier), h.name(3005))
          this.spState = 0x7da
        }
        if (this.spState === 0x834) {
          g.onSe(7)
          this.setBuf('Is it all right to switch locations? ')
        } else g.onSe(10)
        h.close('msg')
        const msg = this.m('msg', 8, 8, this.buf, 0x16, 0x3000, 1)
        h.close('help')
        this.m('help', msg.win.x, msg.win.y + msg.win.h, this.spState === 0x834 ? sj('＠ｂ０Yes ＠ｂ３No ') : h.str(S.spellReturn), 0x12, 0x3000)
      } else if (this.P & PAD_CIRCLE) {
        g.onSe(9)
        this.spState = 1000
      }
      return 0
    }
    if (st === 0x3f2) {
      if (this.ok()) {
        g.onSe(9)
        this.spState = 1000
      }
      return 0
    }
    if (st === 1000) {
      let s = this.spellSelect(this.spCard, 1)
      if (s > 0) {
        const t = this.spTarget ?? a
        if (t.slot === 0) {
          this.buf = h.str(S.relocDominator)
          s = 0
        } else if (g.countBaseAuras(x, y, 0xf, 3005) && !g.countAbility(t, A.annulBase)) {
          this.buf = sprintf(h.str(S.relocBarrier), h.name(3005))
          s = 0
        }
        h.close('msg')
        if (s === 0) {
          const msg = this.m('msg', 0, infoBottom(), this.buf, 0x16, 0x3000, 1)
          h.close('help')
          this.m('help', msg.win.x, msg.win.y + msg.win.h, h.str(S.spellReturn), 0x12, 0x3000)
          g.onSe(10)
          this.spState = 0x3f2
        } else g.onSe(7)
      }
      return s
    }
    return 0
  }

  /** spellShardOfLife (count 1) / spellDivineLightOfKoriah (count 4): discard-pile units back on summon squares. */
  private hRevive(max: number): number {
    const g = this.g, h = this.h
    const st = this.spState
    const tp = g.turnPlayer
    const p = g.players[tp]
    const shard = max === 1
    if (st === 5000) return 1
    if (st === 0x1004) {
      h.close('msg')
      const f = h.frame('msg', 320, 224, 0, 0, 16, 10, 0xc000)
      if (shard) {
        const s = this.picks[0] & 0xffff
        if (s) {
          h.print('msg', 0, 0, 0x14, h.name(g.units[tp][s].cardId))
          h.print('msg', 0xd2, 0, 0x14, sj('Revived '))
        }
        f.win.w = 324
        f.win.h = (s ? 1 : 0) * 21 + 30
        return 1
      }
      let n = 0
      for (let k = 0; k < 4; k++) {
        const s = this.picks[k] & 0xffff
        if (!s) break
        if (!(p.deckState[s] & 8)) {
          h.print('msg', 0, k * 0x15, 0x14, h.name(g.units[tp][s].cardId))
          h.print('msg', 0xd2, k * 0x15, 0x14, sj('Revived '))
          n++
        }
      }
      if (n < 1) h.close('msg')
      else {
        f.win.w = 324
        f.win.h = n * 21 + 30
      }
      return 1
    }
    if (st === 0xfaa) {
      const s = this.picks[this.pickCount] & 0xffff
      const r = this.summon(g.units[tp][s], g.cursor.x, g.cursor.y, 1)
      if (r !== 0) {
        this.pickCount++
        this.spState = this.pickCount < max ? 4000 : 0x1004
      }
      return 0
    }
    if (st === 4000) {
      const pk = this.picks[this.pickCount]
      if ((pk & 0xffff) === 0) this.spState = 0x1004
      else {
        g.cursor.x = ((pk >>> 16) & 0xff) << 6
        g.cursor.y = (pk >>> 24) << 6
        this.spState = 0xfaa
        if (shard) p.deckState[pk & 0xffff] = 3
      }
      return 0
    }
    if (st === 3000) {
      this.pickCount = 0
      return 1
    }
    if (st === 2000) {
      const c = this.spellConfirm(this.spCard, 11)
      if (c < 0 && (shard || this.pickCount > 3)) {
        if (this.pickCount > 0) this.pickCount--
        const s = this.picks[this.pickCount] & 0xffff
        if (s) p.deckState[s] |= 8
        this.picks[this.pickCount] = 0
      }
      return c
    }
    if (st === 0x44c) {
      if (h.cursorStep()) {
        const i = (g.cursor.y >> 6) * 40 + (g.cursor.x >> 6)
        if (this.P & PAD_CROSS) {
          if (!g.marks[i]) return 0
          const s = this.picks[this.pickCount] & 0xffff
          if (s) p.deckState[s] = 3
          this.picks[this.pickCount] = (this.picks[this.pickCount] | ((((g.cursor.y >> 6) << 8) + (g.cursor.x >> 6)) << 16)) >>> 0
          this.pickCount++
          g.onSe(7)
          this.spState = this.pickCount < max ? 1000 : 2000
        } else if (this.P & PAD_CIRCLE) {
          this.picks[this.pickCount] = 0
          g.onSe(9)
          this.spState = 1000
        }
        if (this.spState !== 0x44c) g.clearDeployMarks()
      }
      return 0
    }
    if (st === 0x3f2) {
      if (shard ? this.ok() : this.P & PAD_CIRCLE) {
        this.picks[this.pickCount] = 0
        g.onSe(9)
        this.spState = 1000
      }
      return 0
    }
    if (st === 1000) {
      const s = this.spellSelect(this.spCard, 11)
      if (s > 0) {
        if (s < 4) {
          if (this.pickCount > max - 1) return 0
          let n = this.markDeployCells(tp, this.picks[this.pickCount] & 0xff)
          if (!shard && n > 0) {
            for (let k = 0; k < 4 && k !== this.pickCount; k++) {
              const pk = this.picks[k]
              if ((pk & 0xffff) === 0) break
              const i = (pk >>> 24) * 40 + ((pk >>> 16) & 0xff)
              if (g.marks[i] & 0x80) {
                g.marks[i] = 0
                n--
              }
            }
          }
          h.close('msg')
          if (n < 1) {
            const msg = this.m('msg', 8, 8, sj('There are no places to deploy units. '), 0x16, 0x3000)
            h.close('help')
            this.m('help', msg.win.x, msg.win.y + msg.win.h, h.str(S.spellReturn), 0x12, 0x3000)
            this.spState = 0x3f2
          } else {
            const msg = this.m('msg', 8, 8, sj('Please select the location for revival. '), 0x16, 0x3000)
            this.m('help', msg.win.x, msg.win.y + msg.win.h, h.str(S.accept), 0x12, 0x3000)
            this.spState = 0x44c
          }
        } else this.spState = 2000
        return 0
      }
      return s
    }
    return 0
  }
  /** mapMarkDeployCells(player, slot) (0x08848E00 area): 0x80 on every square the unit may be deployed on; returns the count. */
  private markDeployCells(player: number, slot: number): number {
    const g = this.g
    const attr = g.units[player & 0xff]?.[slot & 0xff]?.attribute ?? 0
    let n = 0
    for (let y = 0; y < 40; y++)
      for (let x = 0; x < 40; x++)
        if (g.land[y * 40 + x] !== -1 && g.canDeployAt(g.turnPlayer, attr, x, y)) {
          n++
          g.marks[y * 40 + x] |= 0x80
        }
    return n
  }

  /** spellCityscapeMirage (0x08842340): land square + attribute menu (in spellConfirmTarget); effect 30–33 by the choice. */
  private hMirage(): number {
    const g = this.g, h = this.h
    const st = this.spState
    const a = this.chosenAttr
    if (st === 5000) return 1
    if (st === 4000) {
      const txt = [0, S.mirageNowEarth, S.mirageNowWater, S.mirageNowFire, S.mirageNowAir][a]
      if (txt) this.buf = h.str(txt)
      this.center('msg', this.buf, 0x14)
      g.land[(g.cursor.y >> 6) * 40 + (g.cursor.x >> 6)] = a
      return 1
    }
    if (st === 3000) return a >= 1 && a <= 4 ? 0x1d + a : 1
    if (st === 0x83e) {
      if (this.P & PAD_CROSS) {
        g.onSe(7)
        return 1
      }
      if (this.P & PAD_CIRCLE) {
        g.onSe(9)
        return -1
      }
      return 0
    }
    if (st === 0x834) {
      h.closeAll()
      const txt = [0, S.mirageAskEarth, S.mirageAskWater, S.mirageAskFire, S.mirageAskAir][a]
      if (txt) this.buf = h.str(txt)
      const msg = this.m('msg', 8, 8, this.buf, 0x16, 0x3000)
      this.m('help', 8, msg.win.y + msg.win.h, h.str(S.accept), 0x12, 0x3000)
      this.spState = 0x83e
      return 0
    }
    if (st === 2000) {
      const c = this.spellConfirm(this.spCard, 4)
      if (c > 0) {
        this.spState = 0x834
        return 0
      }
      return c
    }
    if (st === 1000) return this.spellSelect(this.spCard, 4)
    return 0
  }

  /** spellSummonLand: land square (mode 4); the attribute changes without a message. */
  private hSummonLand(card: number): number {
    const g = this.g
    const st = this.spState
    if (st === 5000 || st === 3000) return 1
    if (st === 4000) {
      g.land[(g.cursor.y >> 6) * 40 + (g.cursor.x >> 6)] = card - 2501
      return 1
    }
    if (st === 2000) return this.spellConfirm(this.spCard, 4)
    if (st === 1000) return this.spellSelect(this.spCard, 4)
    return 0
  }

  /** spellLordOfBlanks (radius 2, unowned) / spellFlamesOfInvasion (radius 1, the caster's): empty land outside Anti-magic Barrier. */
  private hLandOwner(card: number): number {
    const g = this.g
    const st = this.spState
    const r = card === 2508 ? 2 : 1
    const cx = g.cursor.x >> 6, cy = g.cursor.y >> 6
    if (st === 5000 || st === 3000) return 1
    if (st === 4000) {
      g.fillDiamond(cx, cy, r, 0x40)
      for (let y = cy - r; y <= cy + r; y++) {
        if (y < 0 || y >= g.H) continue
        for (let x = cx - r; x <= cx + r; x++) {
          if (x >= g.W || x < 0) continue
          const i = y * 40 + x
          if (!g.countBaseAuras(x, y, 0xf, 3005) && g.grid[i] === 0 && g.land[i] >= 0 && g.marks[i] & 0x40) g.conquest[i] = card === 2508 ? 0 : ((g.turnPlayer + 1) * 0x1000) & 0xffff
        }
      }
      g.marks.fill(0)
      g.commitConquest()
      return 1
    }
    if (st === 2000) {
      const c = this.spellConfirm(this.spCard, 4)
      if (c !== 0) g.marks.fill(0)
      return c
    }
    if (st === 1000) {
      const s = this.spellSelect(this.spCard, 4)
      if (s > 0) g.fillDiamond(g.cursor.x >> 6, g.cursor.y >> 6, r, 0x40)
      return s
    }
    return 0
  }

  /** spellStrategicRetreat (0x088419F0): pays at the confirmation and picks the square then; Cost + 3. */
  private hRetreat(): number {
    const g = this.g, h = this.h
    const st = this.spState
    const tp = g.turnPlayer
    if (st === 5000 || st === 3000) return 1
    if (st === 4000) {
      const i = (g.cursor.y >> 6) * 40 + (g.cursor.x >> 6)
      g.conquest[i] = 0
      g.players[tp].cost += 3
      g.conquestCount[tp]--
      g.players[tp].income--
      g.commitConquest()
      this.center('msg', h.str(S.retreat))
      return 1
    }
    if (st !== 1000 && st !== 2000) return 0
    const c = this.selectThenConfirm(12)
    if (c > 0) {
      this.payNow()
      let best = 0, bx = 0, by = 0
      for (let y = 0; y < g.H; y++)
        for (let x = 0; x < g.W; x++) {
          const i = y * 40 + x
          if (g.conquest[i] & (1 << (tp + 12)) && g.grid[i] === 0) {
            const k = ((g.randSpell() & 0xffff) % 100) + 1
            if (best < k) {
              best = k
              bx = x
              by = y
            }
          }
        }
      if (best) {
        g.cursor.x = bx << 6
        g.cursor.y = by << 6
      }
    }
    return c
  }

  /** spellEarthNova (0x0883DCAC): every unit HP − 4 except Annul Attack, Anti-magic Barrier and Magic Barrier (consumed). */
  private hEarthNova(): number {
    const g = this.g
    const st = this.spState
    if (st === 5000 || st === 3000) return 1
    if (st === 4000) {
      for (const q of g.units)
        for (const u of q) {
          let ok = u.state > 0 && u.hp > 0
          if (ok && g.countAbility(u, A.annulAttack)) ok = false
          if (ok && !g.countAbility(u, A.annulBase) && g.countBaseAuras(u.posX >> 6, u.posY >> 6, 0xf, 3005)) ok = false
          if (ok && g.attachmentOp(u, 2402, 2)) ok = false
          if (ok) u.hp = Math.max(0, u.hp - 4)
        }
      this.center('msg', sj('All units: HP-4 '))
      return 1
    }
    return st === 1000 || st === 2000 ? this.selectThenConfirm(12) : 0
  }

  /** spellGreenNoa (0x08841760): own units HP + 3 except Anti-magic Barrier and Magic Barrier (consumed). */
  private hGreenNoa(): number {
    const g = this.g
    const st = this.spState
    const tp = g.turnPlayer
    if (st === 5000 || st === 3000) return 1
    if (st === 4000) {
      for (let k = 0; k < 2; k++)
        for (const u of g.units[(tp + k) & 1]) {
          let ok = u.hp > 0 && u.state > 0 && u.team === tp
          if (ok && g.countBaseAuras(u.posX >> 6, u.posY >> 6, 0xf, 3005) && !g.countAbility(u, A.annulBase)) ok = false
          if (ok && g.attachmentOp(u, 2402, 2)) ok = false
          if (ok) u.hp = Math.min(u.maxHp, u.hp + 3)
        }
      this.center('msg', sj('All allied units ＠ｎheal 3 HP '))
      return 1
    }
    return st === 1000 || st === 2000 ? this.selectThenConfirm(12) : 0
  }

  /** spellWinterPreparation (0x088445E8): the discard pile back into the deck, reshuffled; no effect. */
  private hWinter(): number {
    const g = this.g, h = this.h
    const st = this.spState
    const p = g.players[g.turnPlayer]
    if (st === 5000) return 1
    if (st === 3000) {
      h.closeAll()
      this.spState = 4000
      return 0
    }
    if (st === 4000) {
      let n = 0
      for (let s = 1; s < 31; s++)
        if (p.deckState[s] & 8) {
          p.deckState[s] = 0
          n++
        }
      g.shuffle(p)
      this.center('msg', n === 0 ? sj('There were no discards. ') : sj(`Returned ${n} discards back to deck. `))
      g.recountDeck(p)
      return 1
    }
    return st === 1000 || st === 2000 ? this.selectThenConfirm(12) : 0
  }

  /** spellBattlefieldScales (0x08843B3C): the side with more units loses random ones (keys 1–128, highest first). */
  private hScales(): number {
    const g = this.g, h = this.h
    const st = this.spState
    if (st === 5000 || st === 3000) return 1
    if (st === 4000) {
      const a = g.placedCount[0], b = g.placedCount[1]
      let d: number, side: number
      if (b < a) {
        d = a - b
        side = 0
      } else if (a < b) {
        d = b - a
        side = 1
      } else return 1
      const list = new Array(16).fill(0)
      for (let q = 0; q < 2; q++)
        for (let s = 1; s < 31; s++) {
          const u = g.units[q][s]
          if (u.team !== side || u.state < 1 || u.hp <= 0) continue
          let e = (s + ((((g.randSpell() & 0xffff) + 1) & 0x7f) + 1) * 0x10000 + (q << 8)) >>> 0
          for (let k = 0; k < 16; k++) {
            const cur = list[k]
            if ((cur & 0xff0000) < (e & 0xff0000)) {
              list[k] = e
              e = cur
            }
            if (e === 0) break
          }
        }
      h.close('msg')
      const f = h.frame('msg', 320, 101, 353, 0, 16, 10, 0x4000)
      f.win.h = d * 19 + 30 + 19
      h.print('msg', 0, 0, 0x12, sj('Unit name '))
      h.print('msg', 0xe4, 0, 0x12, sj('HP '))
      for (let k = 0; k < d && k < 16; k++) {
        const e = list[k]
        if (e === 0 || (e & 0xff) === 0) break
        const u = g.units[(e >> 8) & 0xff][e & 0xff]
        h.print('msg', 0, 0x13 * (k + 1), 0x12, h.name(u.cardId))
        h.print('msg', 0xe4, 0x13 * (k + 1), 0x12, sj(`${arrow(u.hp, 0)} `))
        u.hp = 0
      }
      h.close('info')
      h.frame('info', 160, 67, 391, 49, 16, 10, 0x4000)
      const nm = h.name(g.units[side][0].cardId)
      h.print('info', 0, 0, 0x12, nm)
      h.win('info')!.win.w = (nm.length >> 1) * 19 + 30
      return 1
    }
    return st === 1000 || st === 2000 ? this.selectThenConfirm(12) : 0
  }

  /** spellMemorySlip (0x08842AE8): pays first, then up to 3 random hand cards of the player, one message each; no effect. */
  private hMemorySlip(): number {
    const g = this.g, h = this.h
    const st = this.spState
    if (st === 5000) return 1
    if (st === 0xfb4) {
      if (this.ok()) {
        g.onSe(7)
        this.spState = 0xfaa
      }
      return 0
    }
    if (st === 3000) {
      h.closeAll()
      this.spState = 4000
      return 0
    }
    if (st === 2000) return this.spellConfirm(this.spCard, 7)
    if (st === 1000) return this.spellSelect(this.spCard, 7)
    if (st === 4000) {
      this.payNow()
      this.spCount = 0
      this.spState = 0xfaa
    } else if (st !== 0xfaa) return 0
    const t = this.spTarget ?? g.units[0][0]
    const q = g.players[t.player]
    let n = g.handCount(q)
    let k = 0
    while (n !== 0) {
      k = ((g.randSpell() & 0xffff) + 1) % n
      if (q.hand[k] !== 0) break
      n++
      if (n > 10000) break
    }
    const slot = q.hand[k] ?? 0
    const id = q.deck[slot] ?? 0
    h.close('msg')
    this.center('msg', sprintf(h.str(S.slipDiscard), h.name(id)), 0x14).win.tailIdx = 1
    q.deckState[slot] |= 8
    q.hand[k] = 0
    g.compactHand(q)
    this.spCount++
    this.spState = 0xfb4
    if (n === 1 || this.spCount === 3) this.spState = 5000
    return 0
  }

  /** spellUnexpectedGuest (0x08842E70): pays first, then draws face up until the hand holds 5; no effect. */
  private hGuest(): number {
    const g = this.g, h = this.h
    const st = this.spState
    if (st === 5000) return 2
    if (st === 0xfb4) {
      if (this.ok()) {
        g.onSe(7)
        this.spState = 0xfaa
      }
      return 0
    }
    if (st === 0xfaa) {
      const t = this.spTarget ?? g.units[0][0]
      const q = g.players[t.player]
      const c = this.drawUpdate(q, 2, 5)
      if (c === 0) return 0
      if (c < 0) return 1
      h.close('msg')
      this.center('msg', cat(h.name(g.units[t.player][0].cardId), ' ＠ｎhas drawn ＠ｎ', h.name(c), '. '), 0x14).win.tailIdx = 1
      g.compactHand(q)
      this.spState = 0xfb4
      return 0
    }
    if (st === 4000) {
      this.payNow()
      this.spState = 0xfaa
      return 0
    }
    if (st === 3000) {
      h.closeAll()
      this.spState = 4000
      return 0
    }
    if (st === 2000) return this.spellConfirm(this.spCard, 7)
    if (st === 1000) return this.spellSelect(this.spCard, 7)
    return 0
  }

  /** spellTurnOverANewLeaf (0x088430E8): pays first; the whole hand to the discard pile one by one, then 5 draws; no effect. */
  private hNewLeaf(): number {
    const g = this.g, h = this.h
    const st = this.spState
    const t = this.spTarget ?? g.units[0][0]
    const q = g.players[t.player]
    if (st === 5000) return 2
    if (st === 0x100e) {
      if (this.ok()) {
        g.onSe(7)
        this.pickCount++
        if (this.pickCount < 5) this.spState = 0x1004
        else return 1
      }
      return 0
    }
    if (st === 0x1004) {
      const c = this.drawUpdate(q, 2, 5)
      if (c === 0) return 0
      if (c < 0) return 1
      h.close('msg')
      this.center('msg', cat(h.name(g.units[t.player][0].cardId), ' ＠ｎhas drawn ＠ｎ', h.name(c), '. '), 0x14).win.tailIdx = 1
      g.compactHand(q)
      this.spState = 0x100e
      return 0
    }
    if (st === 0xfbe) {
      g.compactHand(q)
      this.spState = 0xfaa
      return 0
    }
    if (st === 0xfb4) {
      if (this.ok()) {
        g.compactHand(q)
        g.onSe(7)
        this.spState = 0xfaa
      }
      return 0
    }
    if (st === 0xfaa) {
      let i = 0
      while (i < 6 && !(q.hand[i] > 0)) i++
      if (i < 6) {
        const slot = q.hand[i]
        const id = q.deck[slot] ?? 0
        h.close('msg')
        this.center('msg', sprintf(h.str(S.leafDiscard), h.name(id)), 0x14)
        q.deckState[slot] |= 8
        q.hand[i] = 0
        this.spState = 0xfb4
      } else {
        this.pickCount = 0
        this.spState = 0x1004
      }
      return 0
    }
    if (st === 4000) {
      this.payNow()
      this.spState = 0xfaa
      return 0
    }
    if (st === 3000) {
      h.closeAll()
      this.spState = 4000
      return 0
    }
    if (st === 2000) return this.spellConfirm(this.spCard, 7)
    if (st === 1000) return this.spellSelect(this.spCard, 7)
    return 0
  }

  /**
   * spellDestructionOfFuture (7 cards, pays at 9000) / spellStarvingTheEnemy (as many as the hand holds,
   * pays first): deck cards to the discard pile one by one ("Deck → Discard"); no effect.
   */
  private hMill(card: number): number {
    const g = this.g, h = this.h
    const st = this.spState
    const t = this.spTarget ?? g.units[0][0]
    const q = g.players[t.player]
    const starve = card === 2606
    if (st === 5000) return 2
    if (starve) {
      if (st === 0xfb4) {
        if (this.ok()) {
          this.pickCount++
          const more = this.pickCount < g.handCount(q)
          if (more) this.spState = 0xfaa
          g.onSe(7)
          return more ? 0 : 1
        }
        return 0
      }
      if (st === 0xfaa) {
        const c = this.drawUpdate(q, 5, 0)
        if (c === 0) return 0
        if (c < 0) return 1
        h.close('msg')
        this.center('msg', cat('Deck → Discard ＠ｎ', h.name(c), ' '), 0x16)
        this.spState = 0xfb4
        return 0
      }
      if (st === 4000) {
        this.payNow()
        if (g.handCount(q) === 0) {
          h.close('msg')
          this.center('msg', sj('There are no cards in hand. '), 0x16)
          return 1
        }
        this.spState = 0xfaa
        return 0
      }
    } else {
      if (st === 0xfaa) {
        if (this.ok()) {
          g.onSe(7)
          this.pickCount++
          if (this.pickCount < 7) this.spState = 4000
          else return 1
        }
        return 0
      }
      if (st === 4000) {
        const c = this.drawUpdate(q, 5, 0)
        if (c === 0) return 0
        if (c < 0) return 1
        h.close('msg')
        this.center('msg', cat('Deck → Discard ＠ｎ', h.name(c), ' '), 0x14)
        this.spState = 0xfaa
        return 0
      }
    }
    if (st === 3000) {
      h.closeAll()
      this.pickCount = 0
      this.spState = 4000
      return 0
    }
    if (st === 2000) return this.spellConfirm(this.spCard, 7)
    if (st === 1000) return this.spellSelect(this.spCard, 7)
    return 0
  }

  /**
   * spellFirestorm (2002, radius 3, HP − 2) and spellMagicDragonGaze (2008, radius 5, HP 0, Death Defense
   * refuses): every living unit in the area except Annul Attack, Anti-magic Barrier (no Annul Base) and
   * Magic Barrier (consumed); the result is a two-sided "Unit name / HP" report (Square switches the side).
   */
  private areaSpell(card: number, mode: number): number {
    const g = this.g, h = this.h
    const st = this.spState
    const cx = g.cursor.x >> 6, cy = g.cursor.y >> 6
    const r = card === 2008 ? 5 : 3
    if (st === 5000) {
      if (this.P & PAD_SQUARE) {
        this.spSide = (this.spSide + 1) % 2
        g.onSe(5)
        this.spState = 0xfaa
        return 0
      }
      return 1
    }
    if (st === 0xfaa) {
      this.reportShowSide(this.spSide)
      return 1
    }
    if (st === 3000) return 1
    if (st === 2000) {
      const c = this.spellConfirm(card, 6)
      if (c !== 0) g.marks.fill(0)
      return c
    }
    if (st === 1000) {
      const s = this.spellSelect(card, mode)
      if (s < 1 || (card === 2002 && s !== 1)) return s
      g.fillDiamond(cx, cy, r, 0x40)
      return s
    }
    if (st !== 4000) return 0
    g.fillDiamond(cx, cy, r, 0x40)
    const own: [Uint8Array, Uint8Array][] = [], other: [Uint8Array, Uint8Array][] = []
    for (const q of g.units)
      for (const u of q) {
        if (u.hp <= 0 || u.state <= 0) continue
        const x = u.posX >> 6, y = u.posY >> 6
        let v = g.marks[y * 40 + x] ? 1 : 0
        if (v && g.countAbility(u, A.annulAttack)) v = -1
        if (v > 0 && card === 2008 && g.countAbility(u, A.deathDefense)) v = -2
        if (v > 0 && g.countBaseAuras(x, y, 0xf, 3005) && !g.countAbility(u, A.annulBase)) v = -3
        if (v > 0 && g.attachmentOp(u, 2402, 2)) v = -4
        if (!v) continue
        let text: Uint8Array
        if (v < 0) text = v === -1 ? h.abilityName(A.annulAttack) : v === -2 ? h.abilityName(A.deathDefense) : v === -3 ? h.name(3005) : h.name(2402)
        else {
          const nv = card === 2008 ? 0 : Math.max(0, u.hp - 2)
          text = sj(card === 2008 ? `${arrow(u.hp, nv)} ` : arrow(u.hp, nv))
          u.hp = nv
        }
        ;(u.team === g.turnPlayer ? own : other).push([h.name(u.cardId), text])
      }
    g.marks.fill(0)
    this.areaRows = [own, other]
    this.spSide = 1
    this.reportShowSide(this.spSide)
    this.spState = 0xfaa
    return 0
  }
  private reportShowSide(side: number) {
    const g = this.g, h = this.h
    if (!h.isOpen('msg') || !h.isOpen('info')) {
      h.frame('msg', 320, 101, 391, 0, 16, 10, 0x4000)
      h.frame('info', 160, 67, 391, 49, 16, 10, 0x4000)
      h.msg('help', 480, h.win('info')!.win.y, h.str(S.changeView), 0x12, 0x7000)
    }
    h.clearPrints('info')
    h.clearPrints('msg')
    const nm = h.name(g.units[(g.turnPlayer + side) & 1][0].cardId)
    h.print('info', 0, 0, 0x12, nm)
    h.win('info')!.win.w = (nm.length >> 1) * 19 + 30
    h.print('msg', 0, 0, 0x12, sj('Unit name '))
    h.print('msg', 0xe4, 0, 0x12, sj('HP '))
    const rows = this.areaRows[side] ?? []
    rows.slice(0, 16).forEach(([a, b], i) => {
      h.print('msg', 0, 0x13 * (i + 1), 0x12, a)
      h.print('msg', 0xe4, 0x13 * (i + 1), 0x12, b)
    })
    if (!rows.length) h.print('msg', 0, 0x13, 0x12, sj('No target '))
    h.win('msg')!.win.h = Math.max(1, Math.min(16, rows.length)) * 19 + 49
  }

  /** spellPush (0x0883EBE8): any unit (not in Anti-magic Barrier without Annul Base) to an empty square within 3. */
  private hPush(): number {
    const g = this.g, h = this.h
    const st = this.spState
    const t = this.spTarget ?? g.units[g.turnPlayer][0]
    const infoBottom = () => {
      const i = h.win('info')?.win
      return (i?.y ?? 8) + (i?.h ?? 0)
    }
    const clearDiamond = () => {
      for (let i = 0; i < 1600; i++) if (Math.abs((i % 40) - (t.posX >> 6)) + Math.abs(Math.trunc(i / 40) - (t.posY >> 6)) <= 3) g.marks[i] = 0
    }
    if (st === 5000 || st === 3000) return 1
    if (st === 4000) {
      g.removeBaseAura(t)
      g.grid[(t.posY >> 6) * 40 + (t.posX >> 6)] = 0
      t.posX = g.cursor.x
      t.posY = g.cursor.y
      g.placeOnGrid(t)
      return 1
    }
    if (st === 0x834) {
      if (this.P & PAD_CROSS) {
        g.onSe(7)
        return 1
      }
      if (this.P & PAD_CIRCLE) {
        g.fillDiamond(t.posX >> 6, t.posY >> 6, 3, 0x40)
        h.close('msg')
        h.close('help')
        this.m('msg', 8, infoBottom(), sj('Where would you like this moved to? '), 0x16, 0x3000, 1)
        g.onSe(9)
        this.spState = 2000
      }
      return 0
    }
    if (st === 2000) {
      const mk = this.selectCell(6)
      if (mk < 0) return 0
      const w = g.grid[(g.cursor.y >> 6) * 40 + (g.cursor.x >> 6)]
      if (this.P & PAD_CROSS) {
        if (mk < 1 || w !== 0) g.onSe(10)
        else {
          h.close('msg')
          h.close('help')
          const msg = this.m('msg', 8, infoBottom(), sj('Is it all right to move this here? '), 0x16, 0x3000, 1)
          this.m('help', 8, msg.win.y + msg.win.h, h.str(S.accept), 0x12, 0x3000, 4)
          clearDiamond()
          g.onSe(7)
          this.spState = 0x834
        }
      } else if (this.P & PAD_CIRCLE) {
        clearDiamond()
        g.onSe(9)
        this.spState = 1000
      }
      return 0
    }
    if (st === 0x3f2) {
      if (this.ok()) {
        g.onSe(9)
        this.spState = 1000
      }
      return 0
    }
    if (st === 1000) {
      let s = this.spellSelect(this.spCard, 1)
      if (s > 0) {
        const tt = this.spTarget ?? t
        const x = g.cursor.x >> 6, y = g.cursor.y >> 6
        if (!g.countAbility(tt, A.annulBase) && g.countBaseAuras(x, y, 0xf, 3005)) {
          this.buf = sprintf(h.str(S.barrier), h.name(3005))
          s = 0
        }
        if (s === 0) {
          g.onSe(10)
          this.spState = 0x3f2
        } else {
          g.fillDiamond(x, y, 3, 0x40)
          this.setBuf('Where would you like this moved to? ')
          g.onSe(7)
        }
        h.close('msg')
        this.m('msg', 8, infoBottom(), this.buf, 0x16, 0x3000, 1)
      }
      return s
    }
    return 0
  }

  /** spellRunningWind (0x08844044): an own unit (the confirmation returns at once) to any empty own square. */
  private hRunningWind(): number {
    const g = this.g, h = this.h
    const st = this.spState
    const t = this.spTarget ?? g.units[g.turnPlayer][0]
    const i = (g.cursor.y >> 6) * 40 + (g.cursor.x >> 6)
    if (st === 5000 || st === 3000) return 1
    if (st === 4000) {
      g.removeBaseAura(t)
      g.grid[(t.posY >> 6) * 40 + (t.posX >> 6)] = 0
      t.posX = g.cursor.x
      t.posY = g.cursor.y
      g.placeOnGrid(t)
      return 1
    }
    if (st === 0x834) {
      if (this.P & PAD_CROSS) {
        g.onSe(7)
        return 1
      }
      if (this.P & PAD_CIRCLE) {
        g.onSe(9)
        this.spState = 0x4b0
      }
      return 0
    }
    if (st === 0x7da) {
      if (this.ok()) {
        h.closeAll()
        g.onSe(9)
        this.spState = 0x4b0
      }
      return 0
    }
    if (st === 2000) {
      h.closeAll()
      if (g.grid[i] === 0) {
        this.buf = h.str(S.windOk)
        this.spState = 0x834
      } else {
        this.setBuf('You cannot move to a location where a unit resides. ')
        this.spState = 0x7da
      }
      const msg = this.m('msg', 8, 8, this.buf, 0x16, 0x3000, 1)
      this.m('help', 8, msg.win.y + msg.win.h, h.str(this.spState === 0x834 ? S.accept : S.spellReturn), 0x12, 0x3000)
      return 0
    }
    if (st === 0x4ba) {
      if (this.selectCell(0) < 0) return 0
      if (this.P & PAD_CROSS) {
        const ok = g.conquest[i] & (1 << (g.turnPlayer + 12)) && g.grid[i] === 0
        g.onSe(ok ? 7 : 10)
        return ok ? 1 : 0
      }
      if (this.P & PAD_CIRCLE) {
        g.onSe(9)
        this.spState = 1000
      }
      return 0
    }
    if (st === 1000) {
      const s = this.spellSelect(this.spCard, 1)
      if (s < 1) return s
      this.spState = 0x44c
      return 0
    }
    if (st === 0x44c) {
      const c = this.spellConfirm(this.spCard, 1)
      if (c < 1) {
        if (c < 0) this.spState = 1000
        return 0
      }
      this.spState = 0x4b0
    }
    if (this.spState === 0x4b0) {
      h.closeAll()
      this.m('msg', 8, 8, sj('Select target location. '), 0x16, 0x3000, 1)
      this.spState = 0x4ba
    }
    return 0
  }

  // ---- counter window (mapCounterSpellWindow 0x088467D0) ----

  /** g_counterWinState, DAT_089b84b3 (the CPU's 48-frame wait), g_counterSpellCardId. */
  private cwState = 0
  private cwCnt = 0
  cwCard = 0

  /**
   * mapCounterSpellWindow(card, mode): the opponent may answer a map spell (0x20) or a summon (0x40)
   * with Defuse Spellpower (2401, spells), Negotiation Trouble (2403, summons) or Reverse Magic (2405,
   * both; the caster's Dominator also loses 2 HP). Without a counter card, a spell on a unit (target mode
   * 1 / 2) that carries Magic Barrier (2402) is nullified and the barrier removed. The CPU waits 48
   * frames and declines 40 % of the time (((gameRandNext() & 0xFFFF) + 1) / 11 % 10 < 4). Returns 1
   * countered, −1 not countered, 0 busy.
   */
  counterWindow(card: number, mode: number): number {
    const g = this.g, h = this.h
    const opp = (g.turnPlayer + 1) & 1
    const P = g.players[opp]
    const cpu = h.isCpu(opp)
    const s0 = this.cwState
    let r = 0
    const noCounter = () => {
      if (mode === 0x20) this.cwState = 5
      else r = -1
    }
    switch (this.cwState) {
      case 50:
        if (this.P) {
          h.closeAll()
          this.cwState = -1
          r = 1
        }
        break
      case 40: {
        if (h.effectBusy()) break
        const tp = g.turnPlayer
        if (this.cwCard === 2405) {
          const d = g.units[tp][0]
          const hp = d.hp, v = Math.max(0, hp - 2)
          if (mode === 0x40) this.buf = cat(h.name(card), "' s ＠ｎsummoning has been eradicated. ＠ｎ", h.name(d.cardId), `HP  ${arrow(hp, v)} `)
          else if (mode === 0x20) this.buf = cat(h.name(card), '. ＠ｎhas been eradicated ＠ｎ', h.name(d.cardId), `HP  ${arrow(hp, v)} `)
          d.hp = v
        } else if (mode === 0x40) this.buf = sprintf(h.str(S.cwSummonGone), h.name(card))
        else if (mode === 0x20) this.buf = sprintf(h.str(S.cwSpellGone), h.name(card))
        this.center('msg', this.buf, 0x14)
        this.m('top', 320, 16, h.name(this.cwCard), 0x14, 0x7000)
        this.cwState = 50
        break
      }
      case 30:
        h.closeAll()
        g.drawFlags &= ~0x18
        if (g.card(this.cwCard)?.mapEffect) h.effect(0x45)
        this.cwState = 40
        break
      case 20:
        if (cpu) {
          if (++this.cwCnt < 0x30) break
          this.cwState = 30
        } else if (this.P & PAD_CROSS) this.cwState = 30
        else if (this.P & PAD_CIRCLE) {
          if (this.cwCard === 2402) r = -1
          else this.cwState = 3
        }
        if (this.cwState === 30) g.onSe(7)
        else if (r < 0 || this.cwState !== 20) g.onSe(9)
        if (this.cwState !== 20 || r !== 0) h.closeAll()
        break
      case 10: {
        const text = this.cwCard === 2402 ? sprintf(h.str(S.cwBarrierAsk), h.name(2402)) : sprintf(h.str(S.cwUseAsk), h.name(this.cwCard))
        const m = this.center('msg', text)
        const hl = this.m('help', 320, 0, h.str(S.accept), 0x12, 0x7000)
        hl.win.y = m.win.y + m.win.h / 2
        this.cwState = 20
        break
      }
      case 5: {
        this.cwCard = 2402
        const t = this.spTarget
        if ((this.spMode === 2 || this.spMode === 1) && t) {
          if (g.attachmentOp(t, 2402, 0)) this.cwState = 30
          if (this.spCard === 2107 && this.spTarget2 && g.attachmentOp(this.spTarget2, 2402, 0)) this.cwState = 30
          if (this.cwState !== 30) r = -1
        } else r = -1
        break
      }
      case 3: {
        g.drawFlags |= 0x18
        const k = h.handSelect(P, mode)
        if (k === -1) noCounter()
        else if (k === 1) {
          this.cwCard = P.deck[P.selected] ?? 0
          this.cwState = 10
        }
        break
      }
      case 2:
        if (cpu) {
          if (++this.cwCnt < 0x30) break
          const rr = g.randSpell()
          if (Math.trunc(((rr & 0xffff) + 1) / 11) % 10 < 4) {
            g.onSe(9)
            noCounter()
          } else {
            g.onSe(7)
            this.cwState = 3
          }
        } else if (this.P & PAD_CROSS) {
          g.onSe(7)
          this.cwState = 3
        } else if (this.P & PAD_CIRCLE) {
          g.onSe(9)
          noCounter()
        }
        if (this.cwState !== 2) h.closeAll()
        break
      case 1: {
        h.closeAll()
        const hl = this.m('help', 320, 224, h.str(S.cwUseCancel), 0x12, 0x7000)
        void hl
        const m = this.m('msg', 320, 224, sprintf(sj("You can use a passive spell ＠ｎagainst %s' s ＠ｎ%s. "), h.name(g.units[(P.index + 1) & 1][0].cardId), h.name(card)), 0x16, 0x7000)
        m.win.y = 224 - m.win.h
        const c = g.card(card)
        const t = cardType(card)
        const info = this.m('info', 8, 0, t === CT_BASE || t === CT_SPELL ? h.cardText(card) : sprintf(h.str(S.cwStats), c?.ap ?? 0, c?.hp ?? 0, c?.move ?? 0), 0x14, 0x3000)
        info.win.y = 440 - info.win.h
        this.cwState = 2
        break
      }
      case 0: {
        g.markUsable(P, mode)
        let n = 0
        for (let i = 0; i < 6; i++) {
          if (P.usable[i] !== 1) continue
          const id = P.deck[P.hand[i]] ?? 0
          if (id === 2405 || (id === 2403 && mode === 0x40) || (id === 2401 && mode === 0x20)) n++
        }
        if (n === 0) noCounter()
        else this.cwState = 1
        break
      }
      default:
        r = -1
    }
    if (r === 0) {
      if (this.cwState !== s0) this.cwCnt = 0
      return 0
    }
    if (r > 0) {
      if (this.cwCard === 2402) {
        if (this.spCard === 2107) {
          for (const u of [this.spTarget, this.spTarget2]) if (u && g.attachmentOp(u, 2402, 0)) {
            g.attachmentOp(u, 2402, 2)
            break
          }
        } else if (this.spTarget) g.attachmentOp(this.spTarget, 2402, 2)
      } else this.paySelected(P)
    }
    h.closeAll()
    this.cwState = 0
    this.cwCnt = 0
    return r < 1 ? -1 : 1
  }

  // ---- battle (mapBattlePrepUpdate / mapBattleAfterUpdate) ----

  private bpStep = 0
  private bpSub = 0
  /** mapBattlePrepUpdate with mapBattlePreCheck (Evasion): 1 start the duel, −1 cancelled (Boost cleared), 0 busy. */
  battlePrep(att: Unit, tgt: Unit): number {
    const h = this.h
    let r = 0
    if (this.bpStep === 100) r = 1
    else if (this.bpStep === 10) this.bpStep = 100
    else if (this.bpStep === 1) {
      const c = this.evasion(tgt)
      if (c >= 1) r = -1
      else if (c < 0) this.bpStep++
    } else if (this.bpStep === 0) {
      h.closeAll()
      this.bpStep++
    } else this.bpStep = (Math.trunc(this.bpStep / 10) + 1) * 10
    if (r !== 0) {
      if (r < 0) att.status &= ~1
      h.closeAll()
      this.bpStep = 0
      this.bpSub = 0
    }
    return r
  }
  private evasion(tgt: Unit): number {
    const g = this.g, h = this.h
    if (this.bpSub === 2) return this.ok() ? 1 : 0
    if (this.bpSub === 1) {
      if (h.effectBusy()) return 0
      const p = g.players[tgt.player]
      const n = g.handCount(p)
      const slot = p.hand.findIndex((d) => d <= 0)
      tgt.hp = 0
      let text: Uint8Array
      if (n < 5) {
        g.destroy(tgt, false)
        p.hand[slot] = tgt.slot
        p.deckState[tgt.slot] = 3
        text = sprintf(h.str(S.evasionHand), h.name(tgt.cardId))
      } else text = sprintf(h.str(S.evasionFull), h.name(tgt.cardId))
      h.close('info')
      h.msg('info', 320, 32, h.abilityName(A.evasion), 0x16, 0x7000)
      h.close('msg')
      this.center('msg', text)
      g.compactHand(p)
      this.bpSub++
      return 0
    }
    if (this.bpSub !== 0) return 0
    if (!g.countAbility(tgt, A.evasion)) return -1
    g.cursor.x = tgt.posX
    g.cursor.y = tgt.posY
    h.effect(g.ability(A.evasion)?.effect ?? 0)
    this.bpSub++
    return 0
  }

  private baStep = 0
  /** DAT_08a43512 (sub-step), DAT_08a43514 (pass / flags) of the after-battle triggers. */
  private baSub = 0
  private baPass = 0
  /**
   * mapBattleAfterUpdate (0x0885D4B4): Word Psalm (47), Bankruptcy Seed (58), Gaugabur Farm (3016), clear
   * Boost, Bless of Training (49). Left / right are g_battleUnitLeft / Right (the team-0 unit is left).
   */
  battleAfter(att: Unit, tgt: Unit): boolean {
    const g = this.g, h = this.h
    const before = this.baStep
    let done = false
    const left = att.team === 0 ? att : tgt, right = left === att ? tgt : att
    const s = this.baStep
    if (s === 100 || s === 0x1e) done = true
    else if (s === 0x15) {
      if (this.bless(left, right)) this.baStep++
    } else if (s === 0x14) {
      this.baStep = 0x15
      att.status &= ~1
    } else if (s === 10) {
      if (this.farm(left, right)) this.baStep++
    } else if (s === 2) {
      if (this.bankruptcy(att, tgt)) this.baStep++
    } else if (s === 1) {
      if (this.wordPsalm(att, tgt)) this.baStep++
    } else if (s === 0) {
      h.closeAll()
      g.recalcAll()
      this.baStep++
    } else this.baStep = (Math.trunc(this.baStep / 10) + 1) * 10
    if (done) {
      h.closeAll()
      this.baStep = 0
    }
    if (this.baStep !== before) this.baSub = this.baPass = 0
    return done
  }
  /**
   * mapWordPsalmUpdate (0x0885C6C0): pass 0 the attacker's Word Psalm hits the target, pass 1 the target's
   * hits the attacker, whenever the other unit survived (the holder may be dead); the effect plays on the
   * victim, then its HP goes to 0, or the message names Death Defense.
   */
  private wordPsalm(att: Unit, tgt: Unit): number {
    const g = this.g, h = this.h
    if (this.baSub === 2) {
      if (this.ok()) {
        this.baPass++
        if (this.baPass > 1) return 1
        this.baSub = 0
      }
      return 0
    }
    if (this.baSub === 1) {
      if (h.effectBusy()) return 0
      h.msg('top', 320, 24, h.abilityName(A.wordPsalm), 0x14, 0x7000)
      const v = this.baPass === 0 ? tgt : att
      let text: Uint8Array
      if (!g.countAbility(v, A.deathDefense)) {
        text = cat(h.name(v.cardId), ` ＠ｎHP ${arrow(v.hp, 0)}`)
        v.hp = 0
      } else text = cat(h.name(v.cardId), ' ＠ｎ', h.abilityName(A.deathDefense), ' ')
      this.center('msg', text)
      this.baSub++
      return 0
    }
    if (this.baSub !== 0) return 0
    let go = false
    if (this.baPass === 0) {
      if (g.countAbility(att, A.wordPsalm) && tgt.hp > 0) go = true
      if (!go) this.baPass++
    }
    if (this.baPass === 1 && g.countAbility(tgt, A.wordPsalm) && att.hp > 0) go = true
    if (!go) return -1
    const v = this.baPass !== 0 ? att : tgt
    g.cursor.x = v.posX
    g.cursor.y = v.posY
    h.closeAll()
    h.effect(g.ability(A.wordPsalm)?.effect ?? 0)
    this.baSub++
    return 0
  }
  /** mapAfterBankruptcySeed (0x0885CA28): per holder (attacker, then target) the opposing player mills one deck card. */
  private bankruptcy(att: Unit, tgt: Unit): number {
    const g = this.g, h = this.h
    if (this.baSub === 3) {
      if (this.ok()) {
        this.baPass++
        if (this.baPass >= 2) return 1
        this.baSub = 0
      }
      return 0
    }
    if (this.baSub === 2) {
      const u = this.baPass !== 0 ? tgt : att
      const q = g.players[(u.team + 1) & 1]
      const c = this.drawUpdate(q, 5, 0)
      if (c !== 0) {
        if (c < 0) {
          this.baPass++
          if (this.baPass >= 2) return -1
          this.baSub = 0
        } else {
          this.center('msg', sprintf(h.str(S.bankruptcy), h.name(g.units[q.index][0].cardId), h.name(c)))
          this.baSub++
        }
      }
      return 0
    }
    if (this.baSub === 1) {
      if (!h.effectBusy()) this.baSub++
      return 0
    }
    if (this.baSub !== 0) return 0
    let go = false
    if (this.baPass === 0) {
      if (g.countAbility(att, A.bankruptcy)) go = true
      else this.baPass++
    }
    if (this.baPass === 1 && g.countAbility(tgt, A.bankruptcy)) go = true
    if (!go) return -1
    const u = this.baPass !== 0 ? tgt : att
    const e = (u.team + 1) & 1
    g.cursor.x = g.units[e][0].posX
    g.cursor.y = g.units[e][0].posY
    g.recountDeck(g.players[e])
    h.closeAll()
    h.msg('top', 320, 32, h.abilityName(A.bankruptcy), 0x16, 0x7000)
    h.effect(g.ability(A.bankruptcy)?.effect ?? 0)
    this.baSub++
    return 0
  }
  /** mapAfterGaugaburFarm (0x0885CE3C): a farm on battle side i (0 left) gives player i's Dominator 2 HP. */
  private farm(left: Unit, right: Unit): number {
    const g = this.g, h = this.h
    if (this.baSub === 2) return this.ok() ? 1 : 0
    if (this.baSub === 1) {
      if (h.effectBusy()) return 0
      h.msg('top', 320, 24, h.name(3016), 0x14, 0x7000)
      const d = g.units[this.baPass][0]
      const v = Math.min(d.maxHp, d.hp + 2)
      this.center('msg', cat(h.name(d.cardId), ` ＠ｎHP ${arrow(d.hp, v)}`))
      d.hp = v
      this.baSub++
      return 0
    }
    if (this.baSub !== 0) return 0
    const i = left.cardId === 3016 ? 0 : right.cardId === 3016 ? 1 : 2
    if (i > 1) return -1
    h.closeAll()
    g.cursor.x = g.units[i][0].posX
    g.cursor.y = g.units[i][0].posY
    this.baPass = i
    h.effect(g.card(3016)?.mapEffect ?? 0)
    this.baSub++
    return 0
  }
  /** mapAfterBlessOfTraining (0x0885D100): the first surviving holder whose opponent died: base AP + 1, DF bonus + 1. */
  private bless(left: Unit, right: Unit): number {
    const g = this.g, h = this.h
    const side = [left, right]
    if (this.baSub === 2) return this.ok() ? 1 : 0
    if (this.baSub === 1) {
      if (h.effectBusy()) return 0
      h.msg('top', 320, 24, h.abilityName(A.bless), 0x14, 0x7000)
      const u = this.baPass & 1 ? left : this.baPass & 2 ? right : null
      if (u) {
        const ap = u.effAp, df = u.effDf
        this.center('msg', cat(h.name(u.cardId), ` ＠ｎAP ${arrow(ap, Math.min(99, ap + 1))} ＠ｎDF ${arrow(df, Math.min(99, df + 1))}`))
        if (u.baseAp < 99) u.baseAp++
        if (u.dfBonus < 99) u.dfBonus++
      }
      g.recalcAll()
      this.baSub++
      return 0
    }
    if (this.baSub !== 0) return 0
    this.baPass = 0
    for (let k = 0; k < 2; k++) if (side[k].hp > 0 && g.countAbility(side[k], A.bless) && side[(k + 1) & 1].hp < 1) this.baPass |= 1 << k
    if (this.baPass === 0) return -1
    const u = this.baPass & 1 ? left : right
    g.cursor.x = u.posX
    g.cursor.y = u.posY
    h.effect(g.ability(A.bless)?.effect ?? 0)
    this.baSub++
    return 0
  }

  // ---- summon (unitSummonUpdate 0x0882F5F0) ----

  private suStep = 0
  /**
   * unitSummonUpdate(unit, posX, posY, mode) (0x0882F5F0): a card already on the board (or the Dominator)
   * is placed at once; a fresh summon (mode 0) offers the opponent's counter window (0x40), plays the
   * summon effect 0x26 (whose script puts the unit on the grid, 0x388), pays with the summon flag (2),
   * places it and takes it out of the hand, then Trench Mortar and the deaths; a countered summon is paid
   * but goes to the discard pile. Mode 1 (revivals) skips the counter and the payment. Returns 1 placed,
   * −1 failed or countered, 0 busy.
   */
  summon(u: Unit, posX: number, posY: number, mode: number): number {
    const g = this.g, h = this.h
    const p = g.players[u.player]
    if (posX > -1) u.posX = posX
    if (posY >= 0) u.posY = posY
    u.cellX = u.posX >> 6
    u.cellY = u.posY >> 6
    let r = 0
    const s = this.suStep
    if (s === 110) {
      if (this.deaths(1)) {
        r = 1
        g.drawFlags |= 0x1c
      }
    } else if (s === 100) {
      g.recalcAll()
      this.suStep = 110
    } else if (s === 42) {
      if (this.ok()) {
        h.closeAll()
        this.suStep = 100
      }
    } else if (s === 41) {
      if (!h.effectBusy()) {
        g.drawFlags |= 0x1c
        h.msg('top', 320, 16, h.name(3015), 0x14, 0x7000)
        h.close('msg')
        const n = g.countBaseAuras(u.posX >> 6, u.posY >> 6, ~(1 << u.team) & 0xf, 3015)
        const v = Math.max(0, u.hp - 2 * n)
        this.center('msg', cat(h.name(u.cardId), ` ＠ｎHP ${arrow(u.hp, v)} `))
        u.hp = v
        this.suStep++
      }
    } else if (s === 40) {
      let n = g.countBaseAuras(u.posX >> 6, u.posY >> 6, ~(1 << u.team) & 0xf, 3015)
      if (g.countAbility(u, A.annulBase)) n = 0
      if (n < 1) this.suStep = 100
      else {
        h.closeAll()
        h.effect(g.card(3015)?.mapEffect ?? 0)
        this.suStep++
      }
    } else if (s === 30) {
      if (!h.effectBusy()) {
        if (!(p.deckState[u.slot] & 8)) {
          u.state = 1
          r = g.placeOnGrid(u)
        } else {
          r = -1
          g.drawFlags |= 0x1c
        }
        p.maintenance = g.sumMaintenance(p.index)
        if ((mode & 0xff) === 0) {
          if (u.slot !== 0) p.hand[p.cursor >> 5] = 0
          g.compactHand(p)
          this.suStep = 40
        } else this.suStep = 100
      }
    } else if (s === 20) {
      const c = g.card(u.cardId)
      let [rc, rs] = g.calcPayment(p, c?.cost ?? 0, c?.soul ?? 0, 2)
      if (rc < 0) rc = 0
      if (rs < 0) rs = 0
      p.cost = rc
      p.soul = rs
      p.flags &= ~0x200
      this.suStep = 30
      g.drawFlags &= ~0x1c
    } else if (s === 10) {
      const v = this.counterWindow(u.cardId, 0x40)
      if (v > 0) p.deckState[u.slot] |= 8
      h.setCurUnit(u)
      if (v < 0) h.effect(0x26)
      if (v !== 0) this.suStep = 20
      g.cursor.x = u.posX
      g.cursor.y = u.posY
      g.clearDeployMarks()
    } else if (s === 0) {
      if (u.hp < 1) return -1
      if ((mode & 0xff) === 1) this.suStep = 30
      else {
        if (p.deckState[u.slot] & 8) return -1
        if (!(p.deckState[u.slot] & 4)) {
          if (u.slot === 0) r = 1
          else this.suStep = 10
        } else r = 1
      }
      h.setCurUnit(u)
      if (r !== 0) g.placeOnGrid(u)
    }
    if (r !== 0) {
      this.suStep = 0
      g.drawFlags |= 0x10
    }
    return r
  }

  // ---- turn end (mapTurnEndUpdate 0x0885C01C) ----

  /** mapTurnEndClearStatus + step 100: flags 8 / 0x10 off, Foot Stamp and Foot-stopper removed, actions back for the team. */
  turnEnd() {
    const g = this.g
    const tp = g.turnPlayer
    g.players[tp].flags &= ~0x18
    for (const q of g.units)
      for (const u of q)
        if (u.team === tp) {
          u.status &= ~2
          g.attachmentOp(u, 2103, 4)
        }
    for (const q of g.units) for (const u of q) if (u.team === tp) u.actFlags = 0
    g.recalcAll()
  }
}

export { CT_SPELL }
