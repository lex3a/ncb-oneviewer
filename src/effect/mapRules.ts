/**
 * The rules behind mapBoardScene, ported from the functions named on each method: the map state block
 * (cell words, conquest words, land attributes, base-aura counters, range marks), the MapUnit and
 * DuelPlayer records, unitRecalcStats with the passive abilities, playerCalcPayment,
 * handMarkUsableCards, mapCanDeployAt / mapMarkSummonCells, mapMarkMoveLines, mapFloodMovePreview,
 * mapSeizeCell / mapUndoSeize / mapCommitConquest, unitPlaceOnGrid, unitDestroy, playerDrawCard,
 * unitSumMaintenance, mapCountDeployed. See docs/formats/rules.md and card-effects.md.
 *
 * The module imports only types and gameRand.ts, so it runs headless (node strips the types) for the
 * rule checks.
 */
import { gameRng, type GameRand } from './gameRand.ts'

/** The card fields the rules read (a subset of gamedb's Card). */
export interface RCard {
  id: number
  type: 'unit' | 'chara' | 'spell' | 'base'
  ap: number
  hp: number
  range: number
  move: number
  cost: number
  soul: number
  maintenance: number
  attribute: number
  abilities: number[]
  mapEffect: number
  battleEffect: number
}

/** AbilityDef fields the rules read. */
export interface RAbility {
  id: number
  active: boolean
  useCost: number
  useSoul: number
  effect: number
}

/** MapUnit (0x58 bytes, g_mapUnits[4][31]); only players 0 and 1 are used. */
export interface Unit {
  cardId: number
  /** +0x04 deck slot, 0 = Dominator. */
  slot: number
  /** +0x08 original owner (row in g_mapUnits). */
  player: number
  /** +0x0C current owner. */
  team: number
  cellX: number
  cellY: number
  posX: number
  posY: number
  /** +0x20: 1 cannot move, 2 no ability, 4 no attack, 8 finished. */
  actFlags: number
  maxHp: number
  hp: number
  baseAp: number
  dfBonus: number
  attribute: number
  /** +0x26 u16[6]. */
  attachments: number[]
  effAp: number
  effDf: number
  effRange: number
  effMove: number
  effAttr: number
  /** +0x48: 1 Boost, 2 Foot Stamp, 4 Euro's Shackles. */
  status: number
  facing: number
  scalePct: number
  /** −1 not in play, 0 off the board, 1 on the board, 2 moving, 3 has moved, 4 dying, 6 gone. */
  state: number
}

/** DuelPlayer (200 bytes). */
export interface Player {
  index: number
  deck: number[]
  /** 1 in hand, 2 face up, 4 has been on the board, 8 discard pile. */
  deckState: Uint8Array
  drawOrder: number[]
  hand: number[]
  /** handUsable nibbles: 0 empty, 1 usable, 2 not usable. */
  usable: number[]
  selected: number
  /** handCursor (position × 32). */
  cursor: number
  deckCount: number
  cost: number
  soul: number
  maintenance: number
  income: number
  flags: number
  /** 0 local pad, ≥ 2 CPU. */
  controller: number
  panelX: number
  panelY: number
  visible: number
}

export const CT_UNIT = 0
export const CT_CHARA = 1
export const CT_SPELL = 2
export const CT_BASE = 3
/** cardGetType: id / 1000 (0 unit, 1 Dominator, 2 spell, 3 base). */
export const cardType = (id: number) => (id <= 0 ? -1 : Math.trunc(id / 1000))

export const A = {
  supportDefense: 1,
  firstAttack: 2,
  mutualDeath: 3,
  revival: 4,
  snipe1: 6,
  footStamp: 7,
  assassinate: 8,
  castSpell: 9,
  attackCastle: 10,
  destroyOutpost: 11,
  memento: 12,
  kodama: 13,
  defenseSkills: 14,
  ironclad: 15,
  annulBase: 16,
  mutualFight: 17,
  boostBuffs: 18,
  annulAttack: 19,
  unableBuff: 20,
  spy: 21,
  blindFaith: 22,
  counter: 23,
  supportAttack: 24,
  regeneration: 25,
  berserk: 26,
  boost: 27,
  deathDefense: 29,
  destinyHealing: 30,
  mindRead: 31,
  evasion: 32,
  assistSummon: 34,
  breath: 39,
  lastFlower: 40,
  wandering: 41,
  fierce: 46,
  wordPsalm: 47,
  baseRepair: 48,
  bless: 49,
  reflect: 50,
  snipe2: 51,
  snipe3: 52,
  dominator: 53,
  evolution: 54,
  rotatingSlash: 55,
  pickPocket: 56,
  dominationCall: 57,
  bankruptcy: 58,
} as const

/** Map state rules bits (g_mapDeployRules / g_mapSoulRules / g_mapCostRules at game start). */
export const DEPLOY_RULES = 0x1c
export const SOUL_RULES = 1
export const COST_RULES = 3

export class MapGame {
  readonly W: number
  readonly H: number
  readonly card: (id: number) => RCard | undefined
  readonly ability: (id: number) => RAbility | undefined
  /** g_mapLandAttr: −1 no square, 0 plain, 1–4 attribute. */
  land: Int8Array
  /** g_mapGrid cell words. */
  grid = new Uint32Array(1600)
  /** +0x1900 conquest words. */
  conquest = new Uint16Array(1600)
  /** +0x2BC0 base-aura counters: 1600 × 85 (17 any team, then 17 per team). */
  auras = new Uint8Array(1600 * 85)
  /** g_mapRangeGrid. */
  marks = new Uint8Array(1600)
  /** g_mapMovePreview. */
  preview = new Uint8Array(1600)
  /** +0x24540 seize-wall markers (1 growing, 2 shrinking). */
  seizeMark = new Uint8Array(1600)
  units: Unit[][]
  players: Player[]
  turnPlayer = 0
  round = 0
  conquestCount = [0, 0, 0, 0]
  goal: number
  placedCount = [0, 0, 0, 0]
  deployRules = DEPLOY_RULES
  soulRules = SOUL_RULES
  costRules = COST_RULES
  /** g_mapCursorX/Y (square × 64): playerCalcPayment reads it for Assist Summon. */
  cursor = { x: 0, y: 0 }
  /** The game's generators (rand, gameRandNext, adhocSyncRand), shared with the effect player. */
  rng: GameRand = gameRng
  /** g_gameMode: 0 versus (ad-hoc), 1 story, 2 free battle. Selects the generator of shuffles and spells. */
  gameMode = 1
  /** g_mapDrawFlags: 1 terrain, 2 units, 4 cursor hand, 8 status HUD, 0x10 hover panel, 0x40 preview / range. */
  drawFlags = 0x1f
  /** Sound-effect hook (sndPlaySeUi id); the viewer only logs it. */
  onSe: (id: number) => void = () => {}

  constructor(w: number, h: number, land: ArrayLike<number>, goal: number, card: (id: number) => RCard | undefined, ability: (id: number) => RAbility | undefined) {
    this.W = w
    this.H = h
    this.land = Int8Array.from({ length: 1600 }, (_, i) => land[i] ?? -1)
    this.goal = goal
    this.card = card
    this.ability = ability
    this.units = [0, 1].map((p) => Array.from({ length: 31 }, (_, s) => this.blankUnit(p, s)))
    this.players = [0, 1].map((p) => blankPlayer(p))
  }

  /** memset of the map state block (state 12000) with the terrain land attributes copied back. */
  resetBoard(land: ArrayLike<number>) {
    for (let i = 0; i < 1600; i++) this.land[i] = land[i] ?? -1
    this.grid.fill(0)
    this.conquest.fill(0)
    this.auras.fill(0)
    this.marks.fill(0)
    this.preview.fill(0)
    this.seizeMark.fill(0)
    this.conquestCount = [0, 0, 0, 0]
    this.placedCount = [0, 0, 0, 0]
    this.deployRules = DEPLOY_RULES
    this.units = [0, 1].map((p) => Array.from({ length: 31 }, (_, s) => this.blankUnit(p, s)))
    this.players = [0, 1].map((p) => ({ ...blankPlayer(p), controller: this.players[p]?.controller ?? 0 }))
  }

  private blankUnit(p: number, s: number): Unit {
    return { cardId: 0, slot: s, player: p, team: p, cellX: 0, cellY: 0, posX: 0, posY: 0, actFlags: 0, maxHp: 0, hp: 0, baseAp: 0, dfBonus: 0, attribute: 0, attachments: [0, 0, 0, 0, 0, 0], effAp: 0, effDf: 0, effRange: 0, effMove: 0, effAttr: 0, status: 0, facing: 0, scalePct: 0, state: -1 }
  }

  // ---- grid ----

  inBoard(x: number, y: number) {
    return x >= 0 && y >= 0 && x < this.W && y < this.H
  }
  /** mapGetCell(grid, x, y, 1): the cell word, −1 outside the board or on land −1. */
  getCell(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= 40 || y >= 40 || this.land[y * 40 + x] < 0) return -1
    return this.grid[y * 40 + x]
  }
  /** Grid word at a flat index as the game reads it (neighbour reads past the row end wrap). */
  word(i: number) {
    return i >= 0 && i < 1600 ? this.grid[i] : 0
  }
  unitOfWord(w: number): Unit | null {
    if (!w) return null
    const p = (w >>> 28) - 1
    let s = (w >>> 16) & 0xff
    if (s === 0xff) s = 0
    return this.units[p]?.[s] ?? null
  }
  unitAt(x: number, y: number): Unit | null {
    const w = this.getCell(x, y)
    return w > 0 ? this.unitOfWord(w) : null
  }
  /** (w & 0xFFFFFFF) >> 24: team + 1 of a cell word. */
  static teamOf(w: number) {
    return (w & 0xfffffff) >>> 24
  }
  cellX(u: Unit) {
    return u.posX >> 6
  }
  cellY(u: Unit) {
    return u.posY >> 6
  }
  /** Every placed unit (state > 0) of players 0 and 1. */
  allUnits(): Unit[] {
    return [...this.units[0], ...this.units[1]].filter((u) => u.cardId > 0 && u.state > 0)
  }

  // ---- abilities ----

  /** unitCountAbility(unit, id, withAttachments). */
  countAbility(u: Unit, id: number, withAtt = true): number {
    const cid = u.cardId
    if (!cid || cardType(cid) === CT_SPELL) return 0
    const c = this.card(cid)
    if (!c) return 0
    let n = 0
    for (let i = 0; i < 3; i++) if ((c.abilities[i] ?? 0) === id) n++
    if ((c.abilities[0] ?? 0) === A.dominator && (id === A.deathDefense || id === A.unableBuff)) n++
    if (withAtt) {
      if (id === A.fierce) n += this.countAttachments(u, 2310)
      else if (id === A.deathDefense) n += this.countAttachments(u, 2207)
      else if (id === A.supportAttack) n += this.countAttachments(u, 2307)
      else if (id === A.firstAttack) n += this.countAttachments(u, 2306) + this.countAttachments(u, 2308)
    }
    return n
  }
  /** mapUnitCountCardAbility(player, slot, id): the card's own slots only, units and Dominators only. */
  cardAbility(u: Unit | null, id: number): number {
    if (!u || u.cardId >= 2000 || !u.cardId) return 0
    const c = this.card(u.cardId)
    let n = 0
    for (let i = 0; i < 3; i++) if ((c?.abilities[i] ?? 0) === id) n++
    return n
  }
  countAttachments(u: Unit, id: number) {
    return u.attachments.filter((a) => a === id).length
  }
  attachedCount(u: Unit) {
    return u.attachments.filter((a) => a !== 0).length
  }
  /** unitAttachmentOp(unit, id, op): 0 count, 1 add, 2 remove one, 4 remove all (id 0 = every card). Returns the count / success. */
  attachmentOp(u: Unit, id: number, op: number): number {
    if (op === 0) return id ? this.countAttachments(u, id) : this.attachedCount(u)
    if (op === 1) {
      const i = u.attachments.indexOf(0)
      if (i < 0) return 0
      u.attachments[i] = id
      return 1
    }
    if (op === 2) {
      const i = u.attachments.indexOf(id)
      if (i < 0) return 0
      u.attachments[i] = 0
      this.compactAttachments(u)
      return 1
    }
    let n = 0
    for (let i = 0; i < 6; i++)
      if (u.attachments[i] && (id === 0 || u.attachments[i] === id)) {
        u.attachments[i] = 0
        n++
      }
    this.compactAttachments(u)
    return n
  }
  /** unitCompactAttachments. */
  compactAttachments(u: Unit) {
    const a = u.attachments.filter((x) => x !== 0)
    while (a.length < 6) a.push(0)
    u.attachments = a
  }

  // ---- base auras ----

  /** mapCountBaseAuras(grid, x, y, playerMask, id): the per-team counters (the "any team" block is not read). */
  countBaseAuras(x: number, y: number, mask: number, id: number): number {
    if (id < 3000 || id - 3000 >= 0x11) return 0
    const i = (y * 40 + x) * 85 + (id - 3000)
    if (i < 0 || i + 17 * 4 >= this.auras.length) return 0
    let n = 0
    for (let t = 0; t < 4; t++) if (mask & (1 << t)) n += this.auras[i + 17 * (t + 1)]
    return n
  }
  /**
   * mapAddBaseAura / mapRemoveBaseAura: the diamond of CardDef.range around the base. Rows are clipped
   * only at the top (the bottom-edge test has an empty body), columns not at all: x < 0 or x ≥ 40 run
   * into the neighbouring row of the flat 40-wide array (as in the game).
   */
  private baseAura(u: Unit, d: number) {
    const id = u.cardId
    if (cardType(id) !== CT_BASE || id - 3000 >= 0x11) return
    const r = this.card(id)?.range ?? 0
    const cx = u.posX >> 6, cy = u.posY >> 6
    for (let y = cy - r; y <= cy + r; y++) {
      if (y < 0) continue
      const k = r - Math.abs(cy - y)
      for (let x = cx - k; x <= cx + k; x++) {
        const cell = y * 40 + x
        if (cell < 0 || cell >= 1600) continue
        const b = cell * 85 + (id - 3000)
        this.auras[b] = (this.auras[b] + d) & 0xff
        this.auras[b + 17 * (u.team + 1)] = (this.auras[b + 17 * (u.team + 1)] + d) & 0xff
      }
    }
  }
  addBaseAura(u: Unit) {
    this.baseAura(u, 1)
  }
  removeBaseAura(u: Unit) {
    this.baseAura(u, -1)
  }

  // ---- stats ----

  /**
   * unitRecalcStats(unit, flags, force) (0x08830760) with abilityDispatch(0, 0): only units and
   * Dominators standing exactly on a square. Flags: 1 attachments, 2 bases in range, 4 land, 8 passive
   * abilities; Annul Base clears 2.
   */
  recalc(u: Unit, flags = 0xf) {
    const t = cardType(u.cardId)
    if (t !== CT_UNIT && t !== CT_CHARA) return
    if (u.posX & 0x3f || u.posY & 0x3f) return
    if (this.countAbility(u, A.annulBase)) flags &= 0xfd
    const c = this.card(u.cardId)
    let move = c?.move ?? 0
    u.effAp = u.effDf = u.effMove = u.effRange = u.effAttr = 0
    if (u.status & 2) u.actFlags |= 0xf
    if (flags & 1) {
      for (const a of u.attachments) {
        if (a === 2309) {
          u.effAp -= 2
          u.effDf -= 1
        } else if (a === 2308) u.effAp += 6
        else if (a === 2305) {
          u.effAp += 2
          u.effDf += 2
        } else if (a === 2304) u.effDf += 3
        else if (a === 2303) {
          u.effAp += 3
          u.effDf += 2
        } else if (a === 2302) {
          u.effAp += 4
          u.effDf += 1
        } else if (a === 2110) u.effMove = Math.min(9, u.effMove + 1)
        else if (a === 2104) u.actFlags |= 6
        else if (a === 2103) u.actFlags |= 0xf
        else if (a === 2102) u.effMove = Math.min(9, u.effMove + 3)
      }
      if (this.countAbility(u, A.boostBuffs) > 0) {
        u.effAp = (u.effAp * 3 + 1) >> 1
        u.effDf = (u.effDf * 3 + 1) >> 1
      }
    }
    if (u.status & 4) move = 1
    u.effAp += u.baseAp
    u.effDf += u.dfBonus
    u.effMove += move
    u.effRange += c?.range ?? 0
    u.effAttr += c?.attribute ?? 0
    const x = u.posX >> 6, y = u.posY >> 6
    if (flags & 2) {
      const w = this.countBaseAuras(x, y, ~(1 << u.team) & 0xf, 3001)
      u.effAp -= w
      u.effDf -= w
      const sh = this.countBaseAuras(x, y, 0xf, 3003)
      if (sh > 0 && u.attribute) {
        u.effAp += sh * 2
        u.effDf += sh
      }
      const st = this.countBaseAuras(x, y, 1 << u.team, 3008)
      u.effAp += st
      u.effDf += st
      u.effDf += this.countBaseAuras(x, y, 1 << u.team, 3010)
    }
    if (flags & 4) {
      const l = this.land[y * 40 + x]
      if (u.attribute && l > 0 && l === u.attribute) {
        u.effAp++
        u.effDf++
      }
    }
    if (flags & 8) {
      this.passives(u)
      if (u.status & 1) {
        u.effAp += 2
        u.effDf += 1
      }
    }
    const pf = this.players[u.team]?.flags ?? 0
    if (pf & 0x40) {
      u.effAp++
      u.effDf++
    }
    if (pf & 0x80) u.effMove = Math.min(9, u.effMove + 1)
    if (flags & 1 && u.attachments.includes(2301)) u.effAp = 1
    if (flags & 2 && this.countBaseAuras(x, y, 0xf, 3004)) u.effMove = 1
    if (this.countAbility(u, A.kodama)) u.effAp = u.baseAp
    u.effAp = Math.max(0, Math.min(99, u.effAp))
    u.effDf = Math.max(0, Math.min(99, u.effDf))
    if (u.effMove > 9) u.effMove = 9
  }

  /** abilityDispatch(0, 0): Support Defense, Defense Skills, Ironclad, Mutual Fight, Counter, Support Attack. */
  private passives(u: Unit) {
    const x = u.posX >> 6, y = u.posY >> 6
    const i = y * 40 + x
    // abilityApplySupportDefense: the neighbour words, bounds x > 0, x < 63, y > 0, y < 63 (a 40-wide row wraps).
    const nb = [x > 0 ? this.word(i - 1) : 0, x < 0x3f ? this.word(i + 1) : 0, y > 0 ? this.word(i - 40) : 0, y < 0x3f ? this.word(i + 40) : 0]
    for (const w of nb) if (MapGame.teamOf(w) === u.team + 1 && this.cardAbility(this.unitOfWord(w), A.supportDefense) > 0) u.effDf++
    if (this.cardAbility(u, A.defenseSkills) > 0) u.effDf += 1
    if (this.cardAbility(u, A.ironclad) > 0) u.effDf += 2
    if (this.cardAbility(u, A.mutualFight) > 0) {
      let n = 0
      for (const p of this.units) for (const v of p) if (v.state > 0 && v.cardId === u.cardId) n++
      if (n > 1) {
        u.effAp += (n - 1) * 2
        u.effDf += n - 1
      }
    }
    if (u.team !== this.turnPlayer && this.cardAbility(u, A.counter) > 0) u.effAp += 3
    for (const w of nb) {
      if ((w | 0) <= 0) continue
      const v = this.unitOfWord(w)
      if (MapGame.teamOf(w) === u.team + 1 && v && this.countAbility(v, A.supportAttack)) u.effAp++
    }
  }

  /** unitRecalcStatsAll: every placed unit. */
  recalcAll() {
    for (const p of this.units) for (const u of p) if (u.cardId && u.state > 0) this.recalc(u)
  }

  // ---- players ----

  /** playerCalcPayment(out, player, cost, soul, flags): the remaining Cost and Soul. */
  calcPayment(p: Player, cost: number, soul: number, flags: number): [number, number] {
    let rc = p.cost, rs = p.soul
    if (cost < 1 && soul < 1) return [rc, rs]
    if (flags & 2) {
      let taverns = 0
      for (const q of this.units) for (const v of q.slice(1)) if (v.team === p.index && v.state > 0 && v.hp > 0 && v.cardId === 3014) taverns++
      const cx = this.cursor.x >> 6, cy = this.cursor.y >> 6
      let assist = 0
      for (const [dx, dy] of [[-1, 0], [0, -1], [1, 0], [0, 1]]) {
        const w = this.getCell(cx + dx, cy + dy)
        if (w > 0 && MapGame.teamOf(w) === p.index + 1) {
          const v = this.unitOfWord(w)
          if (v && this.countAbility(v, A.assistSummon)) assist++
        }
      }
      cost = cost - taverns - assist
    }
    if (flags & 8) {
      let trees = 0
      for (const q of this.units) for (const v of q.slice(1)) if (v.team === p.index && v.state > 0 && v.hp > 0 && v.cardId === 3009) trees++
      cost -= trees
    }
    if (flags & 10) cost -= p.flags & 0x200 ? 2 : 0
    if (!(flags & 4)) {
      if (cost < 1) cost = 1
    } else if (p.flags & 0x20) cost <<= 1
    rc = p.cost - cost
    if (this.costRules & 1) rs = p.soul - soul
    if (this.costRules & 2 && rc < 0 && rs + rc >= 0) {
      rs += rc
      rc = 0
    }
    return [rc, rs]
  }

  /**
   * handMarkUsableCards(player, mode) (0x088547F0): 1 usable, 2 not usable. Mode 0x10 (duel): battle
   * spells only; 2401/2403/2405 only in their counter windows (0x20 / 0x40); 0x200 swap: units only;
   * 0x400 discard: all. The cost test always uses the spell flag (8). Dried-up Well: none.
   */
  markUsable(p: Player, mode: number) {
    p.usable = [0, 0, 0, 0, 0, 0]
    const swap = mode & 0x200, discard = mode & 0x400
    if (!discard && !swap && p.flags & 0x10) return
    for (let i = 0; i < 6; i++) {
      if (p.hand[i] <= 0) continue
      const cid = p.deck[p.hand[i]] ?? 0
      let v = 0
      if (cid > 0) {
        if (mode & 0x10) {
          v = 2
          if (cardType(cid) === CT_SPELL && (this.card(cid)?.abilities[0] ?? 0) === 1) v = 0
        }
        if (cid === 2405 || cid === 2403 || cid === 2401) v = 2
        if (mode & 0x20) v = cid === 2405 || cid === 2401 ? 0 : 2
        if (mode & 0x40) v = cid === 2405 || cid === 2403 ? 0 : 2
        if (swap && cid > 999) v = 2
        if (discard) v = 0
      }
      if (v === 0) {
        v = 1
        if (!swap && !discard) {
          const c = this.card(cid)
          const [rc, rs] = this.calcPayment(p, c?.cost ?? 0, c?.soul ?? 0, 8)
          if (rc < 0 || rs < 0) v = 2
        }
      }
      p.usable[i] = v
    }
  }

  /** unitSumMaintenance(team): living placed units of the team; ×2 when either player has Janess' Shadow. */
  sumMaintenance(team: number): number {
    const dbl = (this.players[0].flags | this.players[1].flags) & 0x20
    let n = 0
    for (const q of this.units) for (const v of q) if (v.state > 0 && v.hp > 0 && v.team === team) n += (this.card(v.cardId)?.maintenance ?? 0) * (dbl ? 2 : 1)
    return n
  }
  updateMaintenance() {
    this.players[0].maintenance = this.sumMaintenance(0)
    this.players[1].maintenance = this.sumMaintenance(1)
  }

  /** mapCountDeployed: units and bases with state > 0 and HP > 0, per team (entries 0 and 1). */
  countDeployed() {
    this.placedCount[0] = this.placedCount[1] = 0
    for (const q of this.units) for (const v of q) if (v.state > 0 && v.hp > 0 && v.team < 4) this.placedCount[v.team]++
  }

  handCount(p: Player) {
    return p.hand.filter((d) => d > 0).length
  }
  /** playerCompactHand. */
  compactHand(p: Player) {
    const h = p.hand.filter((d) => d > 0)
    while (h.length < 6) h.push(0)
    p.hand = h
  }
  recountDeck(p: Player) {
    let n = 0
    for (let i = 0; i < 31; i++) if (p.deckState[i] === 0) n++
    p.deckCount = n
    return n
  }
  /**
   * playerShuffleDeck (0x08853DB0): for k = 1..31, up to 10001 tries of r = rand() % 30 (versus:
   * (adhocSyncRand() & 0xFFFF) % 30) until slot r + 1 is free, which becomes drawOrder[k]. After 30
   * picks every slot is taken, so the 31st round always burns its 10001 draws (and writes nothing).
   */
  shuffle(p: Player) {
    const order = new Array(31).fill(0)
    const used = new Uint8Array(32)
    for (let k = 1; k < 32; k++) {
      for (let tries = 0; tries < 10001; tries++) {
        const r = this.gameMode === 0 ? (this.rng.adhocNext() & 0xffff) % 30 : this.rng.rand() % 30
        if (!used[r + 1]) {
          if (k < 31) order[k] = r + 1
          used[r + 1] = 1
          break
        }
      }
    }
    p.drawOrder = order
  }
  /** The generator of spells, Pick Pocket and the counter window: adhocSyncRand in versus, else gameRandNext. */
  randSpell(): number {
    return this.gameMode === 0 ? this.rng.adhocNext() : this.rng.next()
  }
  /** playerDrawCardUpdate mode 5: the next deck card goes to the discard pile. Returns its card id, −1 when the deck is empty. */
  millOne(p: Player): number {
    for (let k = 0; k < 31; k++) {
      const s = p.drawOrder[k] ?? 0
      if (p.deckState[s] === 0) {
        p.deckState[s] |= 8
        this.recountDeck(p)
        return p.deck[s] ?? 0
      }
    }
    return -1
  }

  /**
   * The draw step of playerDrawCard / playerDrawCardUpdate: the first drawOrder slot still in the deck
   * goes to the first empty hand place; refused when the hand already holds `limit` cards. Returns the
   * card id, 0 when refused, −1 when the deck is empty.
   */
  drawOne(p: Player, limit: number, state: number): number {
    this.recountDeck(p)
    if (p.deckCount === 0) return -1
    let slot = -1
    for (let k = 0; k < 31; k++) {
      const s = p.drawOrder[k] ?? 0
      if (p.deckState[s] === 0) {
        slot = s
        break
      }
    }
    if (slot < 0) return -1
    if (this.handCount(p) >= limit) return 0
    const i = p.hand.findIndex((d) => d <= 0)
    if (i < 0) return 0
    p.hand[i] = slot
    p.deckState[slot] = state
    this.recountDeck(p)
    return p.deck[slot] ?? 0
  }
  /** playerRecycleUsedCards: the discard pile back into the deck, reshuffled. Returns the count. */
  recycle(p: Player): number {
    let n = 0
    for (let i = 0; i < 31; i++)
      if (p.deckState[i] & 8) {
        p.deckState[i] = 0
        n++
      }
    if (n) this.shuffle(p)
    this.recountDeck(p)
    return n
  }

  // ---- conquest ----

  /** mapCommitConquest: pending bits become ownership; recounts g_mapConquestCount. */
  commitConquest() {
    this.conquestCount = [0, 0, 0, 0]
    for (let y = 0; y < this.H; y++)
      for (let x = 0; x < this.W; x++) {
        const i = y * 40 + x
        let w = this.conquest[i]
        if (w & 0xf00) w = this.conquest[i] = ((w & 0xf00) << 4) & 0xffff
        for (let t = 0; t < 4; t++) if (w & (0x1000 << t)) this.conquestCount[t]++
      }
  }

  /**
   * mapSeizeCell(grid, unit, team, leg) (0x0885903C): on a whole square that is empty or the team's
   * own. Not with Wandering Citizen, Cause for Civil War (turn player's flag 8), or inside another
   * team's Symbolic Flag without Annul Base. Returns true when the walls start.
   */
  seizeCell(u: Unit, team: number, leg: number): boolean {
    if (u.posX & 0x3f || u.posY & 0x3f || team < 0 || team >= 4) return false
    if (this.countAbility(u, A.wandering) >= 1) return false
    if (this.players[this.turnPlayer].flags & 8) return false
    const x = u.posX >> 6, y = u.posY >> 6, i = y * 40 + x
    for (let t = 0; t < 2; t++) if (t !== team && !this.countAbility(u, A.annulBase) && this.countBaseAuras(x, y, 1 << t, 3011)) return false
    const w = this.grid[i]
    if (w !== 0 && MapGame.teamOf(w) !== team + 1) return false
    let started = false
    if ((this.conquest[i] & 0xff) === 0) {
      this.seizeMark[i] = 1
      this.onSe(0x1d)
      started = true
      this.conquest[i] = (this.conquest[i] | ((1 << (team + 8)) + leg)) & 0xffff
    }
    return started
  }

  /** mapUndoSeize(grid, leg): clears the range grid and resets every word of that leg to its owned bits. */
  undoSeize(leg: number) {
    this.marks.fill(0)
    for (let i = 0; i < 1600; i++) if ((this.conquest[i] & 0xff) === leg && this.conquest[i] & 0xf00) this.conquest[i] &= 0xf000
  }

  // ---- marks ----

  /**
   * mapMarkMoveLines(grid, unit, points, team): 0x10 on the unit, 0x11 + dir along straight lines. A line
   * stops before the edge, land −1, or a square of another team (a base may be crossed with Spy); it
   * stops on the first Labyrinth Marsh square unless Annul Base; starting in a marsh limits it to 1.
   */
  markMoveLines(u: Unit, points: number, team: number) {
    const x = u.posX >> 6, y = u.posY >> 6
    if (team < 0 || team >= 4) return
    const annul = this.countAbility(u, A.annulBase), spy = this.countAbility(u, A.spy)
    this.marks[y * 40 + x] = 0x10
    if (points <= 0) return
    if (this.countBaseAuras(x, y, 0xf, 3004) > 0 && !annul) points = 1
    for (let dir = 0; dir < 4; dir++) {
      for (let k = 1; k < points + 1; k++) {
        const nx = dir === 0 ? x + k : dir === 1 ? x - k : x
        const ny = dir === 2 ? y + k : dir === 3 ? y - k : y
        if (nx < 0 || nx >= this.W || ny < 0 || ny >= this.H) break
        const w = this.grid[ny * 40 + nx]
        if (w !== 0 && MapGame.teamOf(w) !== team + 1 && ((w & 0xffff) < 3000 || !spy)) break
        if (this.land[ny * 40 + nx] < 0) break
        this.marks[ny * 40 + nx] = 0x11 + dir
        if (this.countBaseAuras(nx, ny, 0xf, 3004) > 0 && !annul) break
      }
    }
  }
  clearMoveLines() {
    for (let i = 0; i < 1600; i++) if ((this.marks[i] & 0xf0) === 0x10) this.marks[i] = 0
  }

  /**
   * mapFloodMovePreview(x, y, moves, player, team, slot, flags) (0x08857B6C): own units are passed
   * straight on only, an enemy base with Spy likewise; other enemies stop it; a Labyrinth Marsh square
   * reached without Annul Base ends the flood there (it goes one square further only from the start).
   */
  flood(x: number, y: number, moves: number, u: Unit, flags: number) {
    if (x < 0 || y < 0 || x >= 40 || y >= 40 || this.land[y * 40 + x] < 0) return
    const w = this.grid[y * 40 + x]
    let slot = (w >>> 16) & 0xff
    if (slot === 0xff) slot = 0
    let pass = false
    if (w !== 0) {
      if (MapGame.teamOf(w) === (u.team & 0xff) + 1) {
        if ((u.slot & 0xff) !== slot) pass = true
      } else {
        if (Math.trunc((w & 0xffff) / 1000) === 3) pass = this.countAbility(u, A.spy) !== 0
        if (!pass) return
      }
    }
    const i = y * 40 + x
    if (this.preview[i] > moves) return
    if (w === 0) this.preview[i] = moves
    const dirs = pass ? flags : 0xf
    let m = moves - 1
    if (m <= 0) return
    if (this.countBaseAuras(x, y, 0xf, 3004) > 0 && !this.countAbility(u, A.annulBase)) {
      m = 0
      if (flags === 0xf) m = 1
    }
    if (x > 0 && dirs & 1) this.flood(x - 1, y, m, u, 1)
    if (y > 0 && dirs & 2) this.flood(x, y - 1, m, u, 2)
    if (x < 0x27 && dirs & 4) this.flood(x + 1, y, m, u, 4)
    if (y < 0x27 && dirs & 8) this.flood(x, y + 1, m, u, 8)
  }
  startFlood(u: Unit, moves: number) {
    this.preview.fill(0)
    this.flood(u.posX >> 6, u.posY >> 6, moves, u, 0xf)
  }

  /**
   * mapMarkAttackRange(grid, unit, r): |dx| + |dy| < r; r = 0 uses CardDef.range + 1 and marks 0x40 for
   * bases. Rows and columns are clipped to the board.
   */
  markAttackRange(u: Unit, r: number) {
    let v = 0x20
    if (r < 1) {
      if (r !== 0) return
      r = (this.card(u.cardId)?.range ?? 0) + 1
      v = u.cardId < 3000 ? 0x20 : 0x40
    }
    const cx = u.posX >> 6, cy = u.posY >> 6
    for (let dy = 0; dy < r; dy++)
      for (let dx = 0; dx < r - dy; dx++) {
        for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          const x = cx + sx * dx, y = cy + sy * dy
          if (x >= 0 && y >= 0 && x < this.W && y < this.H) this.marks[y * 40 + x] = v
        }
      }
  }
  /** mapFillDiamond(x, y, r, v): |dx| + |dy| ≤ r (clipped). */
  fillDiamond(cx: number, cy: number, r: number, v: number) {
    for (let y = cy - r; y <= cy + r; y++)
      for (let x = cx - r; x <= cx + r; x++) if (this.inBoard(x, y) && Math.abs(x - cx) + Math.abs(y - cy) <= r) this.marks[y * 40 + x] = v
  }

  /** mapCanDeployAt(team, cardAttr, x, y) (0x0885F098). */
  canDeployAt(team: number, attr: number, x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return false
    if (this.land[y * 40 + x] === -1) return false
    const i = y * 40 + x
    if (this.grid[i] !== 0) return false
    const f = this.conquest[i]
    const r = this.deployRules
    if (this.players[team].flags & 4 && r & 0x10) return true
    if (r & 1 && f & (1 << (team + 12))) return true
    if (r & 2 && !(f & 0xf000)) return true
    if (r & 4) {
      if (x - 1 >= 0 && team + 1 === MapGame.teamOf(this.word(i - 1))) return true
      if (x + 1 < this.W && team + 1 === MapGame.teamOf(this.word(i + 1))) return true
      if (y - 1 >= 0 && team + 1 === MapGame.teamOf(this.word(i - 40))) return true
      if (y + 1 < this.H && team + 1 === MapGame.teamOf(this.word(i + 40))) return true
    }
    if (r & 8 && attr & 0xff && this.land[i] === (attr & 0xff)) {
      if (!(f & 0xf000)) return true
      if (f & (1 << (team + 12))) return true
    }
    return false
  }
  /** mapMarkSummonCells: 0x80 on every legal square for the turn player's selected card (its unit attribute). */
  markSummonCells(attr: number, team = this.turnPlayer) {
    for (let y = 0; y < 40; y++)
      for (let x = 0; x < 40; x++) if (this.land[y * 40 + x] !== -1 && this.canDeployAt(team, attr, x, y)) this.marks[y * 40 + x] |= 0x80
  }
  clearDeployMarks() {
    for (let i = 0; i < 1600; i++) this.marks[i] &= 0x7f
  }

  // ---- units ----

  /** unitInitFromCard(unit, player, card, slot): a fresh record, off the board (state −1). */
  initUnit(u: Unit, player: number, cardId: number, slot: number) {
    const c = this.card(cardId)
    Object.assign(u, this.blankUnit(player, slot))
    u.cardId = cardId
    u.maxHp = u.hp = c?.hp ?? 0
    u.baseAp = c?.type === 'base' ? 0 : (c?.ap ?? 0)
    u.attribute = c?.attribute ?? 0
    u.effAp = u.baseAp
    u.effMove = c?.move ?? 0
    u.effRange = c?.range ?? 0
    u.effAttr = u.attribute
  }

  /**
   * unitPlaceOnGrid (0x0882F464): state 1, facing 0, the cell word, the square becomes owned by the
   * team (whole conquest word), mapCommitConquest, the base aura, unitRecalcStats; the first placement
   * sets deck state 4 and recounts. Returns 1 when the card had been on the board already.
   */
  placeOnGrid(u: Unit): number {
    const x = u.posX >> 6, y = u.posY >> 6
    u.cellX = x
    u.cellY = y
    u.state = 1
    u.facing = 0
    // cardId | (u8)slot << 16 | (player + 1) << 28 | (team + 1) << 24: the Dominator's slot field is 0
    this.grid[y * 40 + x] = (u.cardId | ((u.slot & 0xff) << 16) | ((u.player + 1) << 28) | (((u.team + 1) & 0xf) << 24)) >>> 0
    this.conquest[y * 40 + x] = 1 << (u.team + 12)
    this.commitConquest()
    this.addBaseAura(u)
    this.recalc(u)
    const p = this.players[u.player]
    if (!(p.deckState[u.slot] & 4)) {
      if (u.cardId && cardType(u.cardId) !== CT_SPELL) {
        this.countDeployed()
        p.deckState[u.slot] |= 4
      }
      return 0
    }
    return 1
  }

  /** Lift a unit off the grid (the move code clears its word). */
  lift(u: Unit) {
    const i = (u.posY >> 6) * 40 + (u.posX >> 6)
    if (this.unitOfWord(this.grid[i]) === u) this.grid[i] = 0
  }

  /**
   * unitDestroy(unit, grantSoul) (0x0882FC34): only at HP ≤ 0; discard pile; Soul for the unit's team
   * (twice with Epsilon's Protection) when the card had been on the board; clears the square and the
   * aura, re-creates the record from its card (state 0), recomputes maintenance.
   */
  destroy(u: Unit, grantSoul: boolean) {
    if (u.hp > 0) return
    const p = this.players[u.player]
    const slot = u.slot
    p.deckState[slot] |= 8
    if (grantSoul) {
      let ok = false
      if (this.soulRules & 1) ok = (p.deckState[slot] & 4) !== 0
      if (this.soulRules & 2 && p.deckState[slot] & 2) ok = true
      if (ok) {
        const q = this.players[u.team]
        if (q.soul < 99) q.soul++
        if (q.flags & 0x100 && q.soul < 99) q.soul++
        if (q.soul > 99) q.soul = 99
      }
    }
    if (p.deckState[slot] & 4) {
      this.lift(u)
      this.removeBaseAura(u)
      this.placedCount[u.player]--
    }
    if (slot > 0) this.initUnit(u, u.player, p.deck[slot] ?? u.cardId, slot)
    u.state = 0
    this.updateMaintenance()
  }

  /**
   * The duel's outcome without the duel scene (battleDuelUpdate with battleCalcDamage, no duel spells):
   * Attack Castle and Kodama at the start, the sole First Attack holder strikes first (and alone if it
   * kills), DF absorbs before HP (not against Fierce Attack), Resist / Reflect Big Swings zero the
   * damage, bases never strike, Mutual Death. Returns the HP [attacker, target].
   */
  battlePredict(a: Unit, t: Unit): [number, number] {
    this.recalc(a)
    this.recalc(t)
    const f = [a, t].map((u) => ({ u, hp: u.hp, ap: u.effAp, df: u.effDf, base: cardType(u.cardId) === CT_BASE }))
    for (const [i, j] of [[0, 1], [1, 0]]) {
      if (this.countAbility(f[i].u, A.attackCastle) && f[j].base) f[i].ap += 5
    }
    for (const [i, j] of [[0, 1], [1, 0]]) if (this.countAbility(f[i].u, A.kodama)) f[i].ap = f[j].ap
    if (f[1].base) f[1].ap = 0
    const hit = (x: (typeof f)[0], y: (typeof f)[0]) => {
      let dmg = x.ap
      for (let k = 1; k <= 4; k++) if (this.countAbility(y.u, 41 + k) && x.u.attribute === k) dmg = 0
      if (this.countAbility(y.u, A.reflect) && x.ap > 3) dmg = 0
      if (!this.countAbility(x.u, A.fierce)) {
        if (y.df < dmg) {
          dmg -= y.df
          y.df = 0
        } else {
          y.df -= dmg
          dmg = 0
        }
      }
      y.hp = Math.max(0, y.hp - dmg)
    }
    // battleDuelUpdate: both strike before the HP pass, unless exactly one has First Attack: then it
    // strikes, the HP pass runs, and the other strikes back only if it survived
    const fa = this.countAbility(a, A.firstAttack) > 0, ft = this.countAbility(t, A.firstAttack) > 0
    const order = ft && !fa ? [1, 0] : [0, 1]
    hit(f[order[0]], f[order[1]])
    if ((fa === ft || f[order[1]].hp > 0) && !f[order[1]].base) hit(f[order[1]], f[order[0]])
    for (const [i, j] of [[0, 1], [1, 0]]) if (f[i].hp <= 0 && this.countAbility(f[i].u, A.mutualDeath) && f[j].hp > 0 && !this.countAbility(f[j].u, A.deathDefense)) f[j].hp = 0
    return [f[0].hp, f[1].hp]
  }

  /** Dominator-alive mask of players 0 and 1 (state 9000). */
  aliveMask() {
    return (this.units[0][0].hp > 0 ? 1 : 0) | (this.units[1][0].hp > 0 ? 2 : 0)
  }
  dominatorDown() {
    return this.units[0][0].hp < 1 || this.units[1][0].hp < 1
  }
}

export function blankPlayer(i: number): Player {
  return { index: i, deck: new Array(31).fill(0), deckState: new Uint8Array(31), drawOrder: new Array(31).fill(0), hand: [0, 0, 0, 0, 0, 0], usable: [0, 0, 0, 0, 0, 0], selected: 0, cursor: 0, deckCount: 0, cost: 0, soul: 0, maintenance: 0, income: 0, flags: 0, controller: 0, panelX: -0x1e0, panelY: 0x140, visible: 0 }
}
