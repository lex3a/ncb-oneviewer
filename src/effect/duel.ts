/**
 * The duel scene behind an effect (battleDuelScene 0x0888A89C): background, HUD, the two combatants
 * and their portraits, and the duel flow that starts the effects: intro, attack and counter-attack,
 * HP-bar drain, death wipe and the final hold. See docs/formats/effects.md ("Duel scene").
 */
import type { Card, GameDb } from '../formats/gamedb'
import { ganSheet, isMarker, parseGan, type Gan } from '../formats/gan'
import { gbpToImage, parseGbp } from '../formats/gbp'
import type { OneArchive } from '../formats/one'
import type { RgbaImage } from '../formats/palette'
import type { BlendMode, GlRenderer, Vertex } from './gl'
import { loadWinSkins, textAdvance, WindowPainter, type DuelWindow } from './windows'
import { GAN_BASE_ALPHA, stepAt, totalTicks, vertexColor, type EffectScene, type Rgba } from './scene'

/** none: the effect alone; attack: a unit attacks (battleDuelUpdate); spell: battleApplySpellCard. */
export type DuelMode = 'none' | 'attack' | 'spell'

export interface DuelOptions {
  mode: DuelMode
  leftCard: number
  rightCard: number
  /** attack: the side whose turn it is (it attacks first); spell: the target side (0 = left). */
  side: 0 | 1
  /** Entry of the viewed script (1000 + effect id): played by the first attack or by the spell. */
  effectEntry: number
  /** Intro, counter-attack and the end of the duel; otherwise a single attack. */
  full: boolean
  /** Spell mode: the spell card, for its HP change. */
  spellCard?: number
  db?: GameDb
  /** Map context of each unit (unitRecalcStats inputs); absent = neutral. */
  context?: [UnitContext, UnitContext]
  /** gothic16.bin, for the window text. */
  font?: Uint8Array | null
}

/** What unitRecalcStats reads from the board besides the card (docs/formats/rules.md). */
export interface UnitContext {
  /** Current HP (default: the card's HP). */
  hp?: number
  /** Standing on land of its own attribute: +1 AP, +1 DF. */
  land?: boolean
  /** Attached spell cards (MapUnit +0x26). */
  attachments?: number[]
  /** Bases covering the unit: enemy Goblin Watchtowers, Elemental Shrines, own Statues of Hero, own Makeshift Fortresses. */
  bases?: { watchtower?: number; shrine?: number; statue?: number; fortress?: number }
  /** Adjacent allies with Support Attack (24, or Vow of Comrade) / Support Defense (1): each gives this unit +1 AP / +1 DF. */
  supportAttack?: number
  supportDefense?: number
  /** Copies of the same card on the board, for Mutual Fight (17). */
  copies?: number
  /** Player flag Breath of Hellgaia: +1 AP, +1 DF. */
  breath?: boolean
  /** Status bit 0 (Boost, ability 27): +2 AP, +1 DF after the passive abilities. */
  boost?: boolean
}

/** Attachment spells' AP/DF (unitRecalcStats flag 1). Toy Sword (2301) sets AP to 1 instead. */
export const ATTACHMENT_STATS: Record<number, [number, number]> = { 2302: [4, 1], 2303: [3, 2], 2304: [0, 3], 2308: [6, 0], 2309: [-2, -1] }

/** Builds the effect for an effect.one entry, or null when there is none. */
export type EffectFactory = (attackerSide: 0 | 1, entry: number) => EffectScene | null

const WHITE: Rgba = [1, 1, 1, 1]
/** GE z for the 2D-sorted context: 0x7FFF − depth. */
const sortedDepth = (depth: number) => (0x7fff - depth) / 65535
const INTRO_FRAMES = 177
const SPELL_DELAY = 30
const TURN_FRAMES = 30
const WIPE_FRAMES = 101
const END_HOLD = 65

// ---------------------------------------------------------------------------------------------
// stats (unitRecalcStats with neutral land, no attachments, bases or allies) and battleCalcDamage

const has = (c: Card | undefined, id: number) => !!c && c.type !== 'spell' && (c.abilities.includes(id) || (id === 29 && c.abilities.includes(53)))
/** unitCountAbility's attachment cards: First Attack (2) ← Premonition of Battle / Sure-Kill, Fierce Attack (46) ← Piercing Shock, Death Defense (29) ← Blessing Light, Support Attack (24) ← Vow of Comrade. */
const ABILITY_ATTACHMENTS: Record<number, number[]> = { 2: [2306, 2308], 46: [2310], 29: [2207], 24: [2307] }
/** battleDuelUpdate step 1: the abilities announced before the exchange (First Attack, Fierce Attack, 5, Resist Earth / Water / Fire / Air, Reflect Big Swings). */
const EXCHANGE_POPUPS = [2, 46, 5, 42, 43, 44, 45, 50]

interface Fighter {
  cardId: number
  card?: Card
  gans: Gan[]
  anim: number
  time: number
  drawAnim: number
  drawTime: number
  sheets: Map<string, RgbaImage>
  hp: number
  maxHp: number
  /** +0x23: card AP, changed only by the Attack Castle / Kodama pop-ups. */
  baseAp: number
  ap: number
  df: number
  /** HP-bar width 0..152 (float). */
  bar: number
  rate: number
  pendingHp: number
  pendingDf: number
  portraitCut: number
}

type Phase =
  | { k: 'intro'; t: number }
  | { k: 'popups'; queues: number[][]; timers: number[] }
  | { k: 'pre'; t: number }
  | { k: 'prePopups'; t: number }
  | { k: 'mutual'; t: number; kill: boolean; victim: 0 | 1 }
  | { k: 'turn'; t: number; from: number; to: number }
  | { k: 'idle' }
  | { k: 'attack'; side: 0 | 1; started: boolean; effectFrame: number }
  | { k: 'hp'; t: number }
  | { k: 'spellWait'; t: number }
  | { k: 'spellEffect'; effectFrame: number }
  | { k: 'post'; t: number }
  | { k: 'wipe'; t: number }
  | { k: 'hold'; t: number }
  | { k: 'done' }

type Plan = ({ k: 'attack'; side: 0 | 1 } | { k: 'hp' })[]

export class DuelSession {
  readonly opts: DuelOptions
  effect: EffectScene | null = null
  frame = 0
  missing: string[] = []
  private makeEffect: EffectFactory
  private archives: OneArchive[]
  private fighters: [Fighter | null, Fighter | null]
  private portraits: [RgbaImage | null, RgbaImage | null]
  private bg: RgbaImage | null
  private atlas: RgbaImage | null
  private flags: RgbaImage | null
  private phase: Phase = { k: 'done' }
  private plan: Plan = []
  /** Duel angle in degrees: 0 = left unit's turn (it stands low), 90 = right unit's. */
  private angle = 0
  /** g_battleDuelTimer: frames since the last reset. */
  private timer = 0
  private hitDelay = 99
  private turnOwner: 0 | 1 = 0
  private soleFirstStrike = false
  /** Step-1 pop-up queues per side. */
  private exchangeQueue: number[][] = [[], []]
  private windows: WindowPainter
  private nameWins: DuelWindow[] = []
  private popupWins: (DuelWindow | null)[] = [null, null]
  /** battleIntroUpdate: two Dominator face windows and two unit-name windows beside the emblem. */
  private introWins: DuelWindow[] = []

  constructor(archives: OneArchive[], opts: DuelOptions, makeEffect: EffectFactory) {
    this.archives = archives
    this.opts = opts
    this.makeEffect = makeEffect
    const duel = opts.mode !== 'none'
    this.bg = duel ? this.image('etc.one', 200, 1) : null
    this.atlas = duel ? this.image('etc.one', 200, 2) : null
    this.flags = duel ? this.image('etc.one', 110, 5, true) : null
    this.windows = new WindowPainter({ skins: duel ? loadWinSkins((a, e, m) => this.image(a, e, m, true)) : [], font: opts.font ?? null })
    this.fighters = duel ? [this.fighter(opts.leftCard), this.fighter(opts.rightCard)] : [null, null]
    this.portraits = duel ? [this.image('unit.one', opts.leftCard, 3), this.image('unit.one', opts.rightCard, 3)] : [null, null]
    if (!duel) {
      this.effect = makeEffect(opts.side, opts.effectEntry)
      this.phase = { k: 'attack', side: opts.side, started: true, effectFrame: -1 }
      return
    }
    this.initStats()
    if (opts.mode === 'spell') {
      this.angle = 0
      this.setAnims(1, 0)
      this.applyPopupAbilities()
      this.openNameWindows()
      this.phase = { k: 'spellWait', t: 0 }
      return
    }
    // Attack: the turn owner strikes first unless only the attacked unit has First Attack (2).
    this.turnOwner = opts.side
    const fsOwner = this.count(opts.side, 2) > 0, fsOther = this.count(opts.side ^ 1, 2) > 0
    const first: 0 | 1 = fsOther && !fsOwner ? ((opts.side ^ 1) as 0 | 1) : opts.side
    const second = (first ^ 1) as 0 | 1
    this.soleFirstStrike = fsOwner !== fsOther
    const canAttack = (s: number) => {
      const c = this.fighters[s]?.card
      return !!this.fighters[s] && (!c || c.type !== 'base')
    }
    this.plan = []
    if (canAttack(first)) this.plan.push({ k: 'attack', side: first })
    if (opts.full) {
      if (this.soleFirstStrike && canAttack(second)) this.plan.push({ k: 'hp' })
      if (canAttack(second)) this.plan.push({ k: 'attack', side: second })
    }
    this.plan.push({ k: 'hp' })
    this.angle = opts.side === 0 ? 0 : 90
    this.setAnims(opts.side === 0 ? 1 : 0, opts.side === 0 ? 0 : 1)
    if (opts.full) {
      this.phase = { k: 'intro', t: 0 }
      this.openIntroWindows()
    }
    else {
      this.applyPopupAbilities()
      this.openNameWindows()
      this.phase = { k: 'pre', t: 0 }
    }
  }

  get finished() {
    return this.phase.k === 'done' || (this.opts.mode === 'none' && !!this.effect?.finished)
  }

  get error() {
    return this.effect?.error ?? null
  }

  /** The combatants' HP now (left, right); after the duel, the result the map applies. */
  get hps(): [number, number] {
    return [this.fighters[0]?.hp ?? 0, this.fighters[1]?.hp ?? 0]
  }

  /** Both combatants' unit.one animations were found. */
  get ready(): boolean {
    return !!this.fighters[0] && !!this.fighters[1]
  }

  /** What the duel is doing, for the status line. */
  get stage(): string {
    return this.phase.k
  }

  // ---- assets ----

  private file(archive: string, entry: number, member: number, optional = false): Uint8Array | null {
    const a = this.archives.find((x) => x.name.toLowerCase() === archive)
    const f = a?.entries.find((e) => e.id === entry)?.files.find((x) => x.subId === member)
    if (!f || !f.data.length) {
      if (!optional) this.missing.push(`${archive} ${entry}/${member}`)
      return null
    }
    return f.data
  }

  private image(archive: string, entry: number, member: number, optional = false): RgbaImage | null {
    const d = this.file(archive, entry, member, optional)
    return d ? gbpToImage(parseGbp(d)) : null
  }

  /** battleLoadUnitAnims: /20 idle, /21 active, /22 attack, /23 hit; bases load /20 four times. */
  private fighter(cardId: number): Fighter | null {
    const members = Math.floor(cardId / 1000) === 3 ? [20, 20, 20, 20] : [20, 21, 22, 23]
    const gans: Gan[] = []
    for (const m of members) {
      const d = this.file('unit.one', cardId, m)
      if (!d) return null
      gans.push(parseGan(d))
    }
    const card = this.opts.db?.byId.get(cardId)
    return {
      cardId,
      card,
      gans,
      anim: 0,
      time: 0,
      drawAnim: 0,
      drawTime: 0,
      sheets: new Map(),
      hp: card?.hp ?? 0,
      maxHp: Math.max(1, card?.hp ?? 1),
      baseAp: 0,
      ap: 0,
      df: 0,
      bar: 152,
      rate: 0,
      pendingHp: card?.hp ?? 0,
      pendingDf: 0,
      portraitCut: 0,
    }
  }

  /** unitRecalcStats reduced to what the two cards decide, plus the Kodama / Attack Castle pop-ups. */
  /** Base AP (+0x23), then unitRecalcStats for both units. */
  private initStats() {
    this.fighters.forEach((f, s) => {
      if (!f?.card) return
      const ctx = this.opts.context?.[s]
      f.baseAp = f.card.type === 'base' ? 0 : f.card.ap
      if (ctx?.hp !== undefined) f.hp = Math.max(0, Math.min(f.maxHp, ctx.hp))
      f.bar = (f.hp * 152) / f.maxHp
      this.recalc(s)
      f.pendingHp = f.hp
      f.pendingDf = f.df
    })
  }

  /**
   * unitRecalcStats (0x08830760): attachments (×1.5 with Boost Buffs), base AP, base auras (unless
   * Annul Base), land, passive abilities, Breath of Hellgaia, Toy Sword, Kodama; clamped to 0..99.
   */
  private recalc(side: number) {
    const f = this.fighters[side]
    const c = f?.card
    if (!f || !c) return
    const ctx: UnitContext = this.opts.context?.[side] ?? {}
    const owner = this.opts.mode === 'attack' ? this.opts.side : 0
    let ap = 0, df = 0
    for (const id of ctx.attachments ?? []) {
      const [a, d] = ATTACHMENT_STATS[id] ?? [0, 0]
      ap += a
      df += d
    }
    if (has(c, 18)) {
      ap = (3 * ap + 1) >> 1
      df = (3 * df + 1) >> 1
    }
    ap += f.baseAp
    if (!has(c, 16)) {
      const b = ctx.bases ?? {}
      const w = b.watchtower ?? 0, sh = b.shrine ?? 0, st = b.statue ?? 0, fo = b.fortress ?? 0
      ap -= w
      df -= w
      if (c.attribute) {
        ap += 2 * sh
        df += sh
      }
      ap += st
      df += st + fo
    }
    if (ctx.land && c.attribute) {
      ap += 1
      df += 1
    }
    // abilityApplySupportDefense / SupportAttack: every unit gets +1 per adjacent ally holding the ability
    df += ctx.supportDefense ?? 0
    if (has(c, 14)) df += 1
    if (has(c, 15)) df += 2
    if (has(c, 17)) {
      const n = Math.max(1, ctx.copies ?? 1)
      ap += 2 * (n - 1)
      df += n - 1
    }
    if (has(c, 23) && side !== owner) ap += 3
    ap += ctx.supportAttack ?? 0
    if (ctx.boost) {
      ap += 2
      df += 1
    }
    if (ctx.breath) {
      ap += 1
      df += 1
    }
    if (ctx.attachments?.includes(2301)) ap = 1
    if (has(c, 13)) ap = f.baseAp
    if (c.type === 'base') ap = 0
    f.ap = Math.max(0, Math.min(99, ap))
    f.df = Math.max(0, Math.min(99, df))
  }

  /** battleShowAbilityPopup: Attack Castle (+5 AP against a base) and Kodama (AP := the opponent's). */
  private popupAbility(side: number, id: number) {
    const f = this.fighters[side], o = this.fighters[side ^ 1]
    if (!f?.card || !o) return
    if (id === 10 && o.card?.type === 'base') f.baseAp += 5
    if (id === 13) f.baseAp = o.ap
    this.recalc(side)
    f.pendingDf = f.df
  }

  /** unitCountAbility(unit, id, 1): the card's abilities plus the attachment cards that grant them. */
  private count(side: number, id: number): number {
    const c = this.fighters[side]?.card
    let n = has(c, id) ? 1 : 0
    if (c && c.type !== 'spell') for (const a of this.opts.context?.[side]?.attachments ?? []) if ((ABILITY_ATTACHMENTS[id] ?? []).includes(a)) n++
    return n
  }

  private popupList(side: number): number[] {
    return [10, 13].filter((id) => has(this.fighters[side]?.card, id))
  }

  /** Without the intro the pop-ups are skipped, but their AP changes still apply. */
  private applyPopupAbilities() {
    for (const s of [0, 1]) for (const id of this.popupList(s)) this.popupAbility(s, id)
  }

  /**
   * The intro's windows (window slots 1–4): 128×128 face windows of both players' Dominators rising from
   * y 480, and the unit names (glyph size 22, w = 11n + 30, h = 50) at (288 − w, 174) and (351, 224).
   * In story mode the player's Dominator is Galahad; a fighter that is itself a Dominator shows its own face.
   */
  private openIntroWindows() {
    const dom = (s: number, fallback: number) => {
      const c = this.fighters[s]?.card
      return c?.type === 'chara' ? c.id : fallback
    }
    const face = (id: number) => this.image('chara.one', id, 1, true)
    this.introWins.push({ x: 0, y: 480, w: 128, h: 128, codes: [], chamfer: 16, face: face(dom(0, 1001)), opened: this.frame })
    this.introWins.push({ x: 512, y: 480, w: 128, h: 128, codes: [], chamfer: 16, face: face(dom(1, 1004)), opened: this.frame })
    this.fighters.forEach((f, s) => {
      if (!f?.card) return
      const w = textAdvance(f.card.nameCodes, 22) + 30
      this.introWins.push({ x: s ? 351 : 288 - w, y: s ? 224 : 174, w, h: 50, codes: f.card.nameCodes, glyph: 22, opened: this.frame })
    })
  }

  /** winApproachPos with speed 6: faces glide up to y 320 (frames 1–149), then off to x −160 / 672; all close on 176. */
  private stepIntroWindows(t: number) {
    const [l, r] = this.introWins
    if (t >= INTRO_FRAMES - 1) {
      this.introWins = []
      return
    }
    for (const w of [l, r]) {
      if (!w) continue
      if (t <= 149) w.y -= (w.y - 320) / 6
      else w.x += ((w === l ? -160 : 672) - w.x) / 6
    }
  }

  /** The unit-name windows: 300×48 at the bottom, opened once the scene passes the pop-ups. */
  private openNameWindows() {
    this.fighters.forEach((f, s) => {
      if (f?.card) this.nameWins.push({ x: s ? 340 : 0, y: 400, w: 300, h: 48, codes: f.card.nameCodes, opened: this.frame })
    })
  }

  private openPopup(side: number, id: number) {
    const ab = this.opts.db?.abilities.get(id)
    this.popupAbility(side, id)
    if (!ab) return
    const w = textAdvance(ab.nameCodes) + 30
    const cx = side ? 544 : 96
    this.popupWins[side] = { x: cx - Math.trunc(w / 2), y: 248 - 24, w, h: 48, codes: ab.nameCodes, opened: this.frame }
  }

  /** battleCalcDamage: the defender's HP and DF after the attack (applied later by the HP pass). */
  private calcDamage(att: Fighter, def: Fighter) {
    const a = att.card, d = def.card
    if (!a || !d) return
    let dmg = att.ap
    for (let i = 1; i <= 4; i++) if (has(d, 41 + i) && a.attribute === i) dmg = 0
    if (has(d, 50) && att.ap > 3) dmg = 0
    let df = def.pendingDf
    if (!this.count(this.fighters.indexOf(att), 46)) {
      if (df < dmg) {
        dmg -= df
        df = 0
      } else {
        df -= dmg
        dmg = 0
      }
    }
    def.pendingDf = df
    def.pendingHp = Math.max(0, def.pendingHp - dmg)
  }

  // ---- animation helpers ----

  private static switchAnim(f: Fighter | null, anim: number) {
    if (!f || f.anim === anim) return
    f.anim = anim
    f.time = 0
  }

  private setAnims(l: number, r: number) {
    DuelSession.switchAnim(this.fighters[0], l)
    DuelSession.switchAnim(this.fighters[1], r)
  }

  private atLastStep(f: Fighter | null) {
    const g = f?.gans[f.anim]
    return !g || stepAt(g, f!.time) === g.steps.length - 1
  }

  /** battleAnimateHpBar: DF ticks down first, then the bar drains (or fills) and the HP digit follows it. */
  private animateHpBar(f: Fighter | null, targetHp: number, targetDf: number): boolean {
    if (!f) return true
    if (f.df > targetDf) {
      f.df--
      return false
    }
    const tw = targetHp * (152 / f.maxHp)
    let done = true
    if (f.rate > 0) {
      if (tw < f.bar) {
        f.bar -= f.rate / 100
        done = false
      } else f.bar = f.hp < 1 ? 0 : tw
      f.hp = Math.max(Math.trunc(f.bar * (f.maxHp / 152)), targetHp)
    } else if (f.rate < 0) {
      if (f.bar < tw) {
        f.bar -= f.rate / 100
        done = false
      } else if (targetHp < f.hp) f.bar = tw
      f.hp = Math.min(Math.trunc(f.bar * (f.maxHp / 152)), targetHp)
    }
    return done
  }

  private startHpPass() {
    for (const f of this.fighters) if (f) f.rate = Math.trunc(300 / f.maxHp) * (f.hp - f.pendingHp)
    this.timer = 0
    this.phase = { k: 'hp', t: 0 }
  }

  private nextInPlan() {
    const next = this.plan.shift()
    if (!next) {
      this.phase = this.fighters.some((f) => f && f.card && f.hp <= 0) ? { k: 'post', t: 0 } : { k: 'post', t: 0 }
      return
    }
    if (next.k === 'hp') {
      this.startHpPass()
      return
    }
    // An attacker that died in an earlier HP pass (sole first strike) does not counter.
    const att = this.fighters[next.side]
    if (att?.card && att.hp <= 0) {
      this.nextInPlan()
      return
    }
    const want = next.side === 0 ? 0 : 90
    this.plan.unshift(next)
    if (this.angle !== want) this.phase = { k: 'turn', t: 0, from: this.angle, to: want }
    else {
      this.plan.shift()
      this.phase = { k: 'attack', side: next.side, started: false, effectFrame: -1 }
      this.timer = this.timer > 32 ? this.timer : this.timer
    }
  }

  /** 64 frames per pop-up, per side in turn, both sides at once; the window glides from y 248 toward 308. */
  private stepPopups() {
    const p = this.phase
    if (p.k !== 'popups') return
    for (const s of [0, 1]) {
      const w = this.popupWins[s]
      if (w) {
        if (++p.timers[s] >= 64) this.popupWins[s] = null
        else {
          let cy = w.y + 24
          cy += (308 - cy) / 32
          cy += (308 - cy) / 32
          w.y = cy - 24
        }
      }
      if (!this.popupWins[s] && p.queues[s].length) {
        p.timers[s] = 0
        this.openPopup(s, p.queues[s].shift()!)
      }
    }
    if (!this.popupWins[0] && !this.popupWins[1]) {
      this.openNameWindows()
      this.phase = { k: 'pre', t: 0 }
    }
  }

  /** battleSetupCombatantFacing's angle-driven anim switches (not at exactly 0 or 90). */
  private angleAnims() {
    const a = this.angle
    const [L, R] = this.fighters
    if (a > 0 && a < 45) this.setAnims(1, 0)
    else if (a === 45) {
      if (L && L.anim <= 1) DuelSession.switchAnim(L, L.anim ^ 1)
      if (R && R.anim <= 1) DuelSession.switchAnim(R, R.anim ^ 1)
    } else if (a > 45 && a < 90) this.setAnims(0, 1)
  }

  // ---- the frame ----

  /** One 60 Hz frame of battleDuelScene: state update, draw-and-tick of the units, then the effect. */
  step() {
    if (this.phase.k === 'done') return
    this.timer++
    const p = this.phase
    const [L, R] = this.fighters
    switch (p.k) {
      case 'intro':
        this.stepIntroWindows(++p.t)
        if (p.t >= INTRO_FRAMES) {
          const queues = [this.popupList(0), this.popupList(1)]
          this.phase = { k: 'popups', queues, timers: [0, 0] }
          this.stepPopups()
        }
        break
      case 'popups':
        this.stepPopups()
        break
      case 'pre':
        // Exchange steps 0-2: step 1 announces the abilities each unit has (64 frames, both sides at once).
        if (p.t === 0) this.timer = 0
        if (++p.t === 1 && this.opts.mode === 'attack') {
          let any = false
          for (const sd of [0, 1]) {
            const list = EXCHANGE_POPUPS.filter((id) => this.count(sd, id) > 0)
            if (list.length) {
              any = true
              this.exchangeQueue[sd] = list
            }
          }
          if (any) {
            for (const sd of [0, 1]) if (this.exchangeQueue[sd].length) this.openPopup(sd, this.exchangeQueue[sd].shift()!)
            this.phase = { k: 'prePopups', t: 0 }
            break
          }
        }
        if (p.t >= 3) this.nextInPlan()
        break
      case 'prePopups': {
        // 64 frames per pop-up; the windows glide 8 steps of 1/32 per frame toward y 308
        p.t++
        for (const sd of [0, 1]) {
          const w = this.popupWins[sd]
          if (!w) continue
          let cy = w.y + 24
          for (let k = 0; k < 8; k++) cy += (308 - cy) / 32
          w.y = cy - 24
        }
        if (p.t >= 64) {
          let more = false
          for (const sd of [0, 1]) {
            this.popupWins[sd] = null
            if (this.exchangeQueue[sd].length) {
              this.openPopup(sd, this.exchangeQueue[sd].shift()!)
              more = true
            }
          }
          if (more) p.t = 0
          else this.phase = { k: 'pre', t: 2 }
        }
        break
      }
      case 'turn': {
        p.t++
        if (p.t === 1) break // step 3
        const k = p.t - 1
        this.angle = p.from + ((p.to - p.from) * k) / TURN_FRAMES
        this.angleAnims()
        if (k >= TURN_FRAMES) {
          this.angle = p.to
          this.timer = 0
          const next = this.plan.shift()!
          this.phase = { k: 'attack', side: (next as { side: 0 | 1 }).side, started: false, effectFrame: -1 }
        }
        break
      }
      case 'attack': {
        if (this.opts.mode === 'none') break
        const att = this.fighters[p.side], def = this.fighters[p.side ^ 1]
        if (!p.started) {
          if (att && att.anim !== 2) {
            if (this.timer > 32) DuelSession.switchAnim(att, 2)
            break
          }
          const g = att?.gans[2]
          const marker = g ? (g.markerSteps[0] ?? g.steps.length - 1) : 0
          if (!g || stepAt(g, att!.time) === marker) {
            if (att && def) this.calcDamage(att, def)
            const entry = p.side === this.turnOwner || !this.opts.full ? this.opts.effectEntry : 1000 + (att?.card?.battleEffect ?? -1000)
            this.effect = this.makeEffect(p.side, entry)
            const id = entry - 1000
            this.hitDelay = id === 1 || id === 6 ? 1 : 5
            p.started = true
            p.effectFrame = this.frame
            this.timer = 0
          }
          break
        }
        if (this.frame > p.effectFrame && this.hitDelay <= 5 && ++this.hitDelay > 5) DuelSession.switchAnim(def, 3)
        // the right side also waits the 32-frame minimum and the hit delay; the left side ends on an idle effect and the last step
        if ((!this.effect || this.effect.finished) && this.atLastStep(att) && (p.side === 0 || (this.timer > 32 && this.hitDelay > 5))) this.nextInPlan()
        break
      }
      case 'hp': {
        p.t++
        if (p.t === 1) break // step 7
        const dl = this.animateHpBar(L, L?.pendingHp ?? 0, L?.pendingDf ?? 0)
        const dr = this.animateHpBar(R, R?.pendingHp ?? 0, R?.pendingDf ?? 0)
        if (dl && dr && this.timer > 32) {
          this.setAnims(this.angle < 1 ? 1 : 0, this.angle < 1 ? 0 : 1)
          this.nextInPlan()
        }
        break
      }
      case 'spellWait':
        if (++p.t >= SPELL_DELAY) {
          this.effect = this.makeEffect(((this.opts.side + 1) & 1) as 0 | 1, this.opts.effectEntry)
          this.phase = { k: 'spellEffect', effectFrame: this.frame }
        }
        break
      case 'spellEffect':
        if (!this.effect || this.effect.finished) {
          const t = this.fighters[this.opts.side]
          if (t) {
            t.pendingHp = spellHp(this.opts.spellCard ?? 0, t)
            t.pendingDf = t.df
          }
          this.plan = [{ k: 'hp' }]
          this.nextInPlan()
        }
        break
      case 'post':
        // Steps 6, 9/10 (Mutual Death), 11, then the portrait wipe if a unit died, else the end hold.
        if (++p.t === 2 && this.opts.mode === 'attack') {
          for (const sd of [0, 1] as const) {
            const f = this.fighters[sd], o = this.fighters[sd ^ 1]
            if (!f?.card || !o?.card || f.hp > 0 || o.hp <= 0 || !this.count(sd, 3)) continue
            this.openPopup(sd, 3)
            const dd = this.count(sd ^ 1, 29) > 0
            if (dd) this.openPopup(sd ^ 1, 29)
            this.phase = { k: 'mutual', t: 0, kill: !dd, victim: (sd ^ 1) as 0 | 1 }
            break
          }
          if (this.phase.k === 'mutual') break
        }
        if (p.t >= 3) this.phase = this.fighters.some((f) => f?.card && f.hp <= 0) ? { k: 'wipe', t: 0 } : { k: 'hold', t: 0 }
        break
      case 'mutual': {
        p.t++
        for (const sd of [0, 1]) {
          const w = this.popupWins[sd]
          if (!w) continue
          let cy = w.y + 24
          cy += (308 - cy) / 32
          cy += (308 - cy) / 32
          w.y = cy - 24
        }
        if (p.t === 64) {
          this.popupWins = [null, null]
          const v = this.fighters[p.victim]
          if (p.kill && v) {
            v.pendingHp = 0
            v.rate = v.hp * Math.trunc(300 / v.maxHp)
          }
        }
        if (p.t > 64) {
          const v = this.fighters[p.victim]
          const done = !p.kill || this.animateHpBar(v, 0, v?.df ?? 0)
          if (done) this.phase = { k: 'post', t: 2 }
        }
        break
      }
      case 'wipe':
        p.t++
        for (const f of this.fighters) if (f?.card && f.hp <= 0) f.portraitCut = Math.min(300, p.t * 3)
        if (p.t >= WIPE_FRAMES) this.phase = { k: 'hold', t: 0 }
        break
      case 'hold':
        if (++p.t >= (this.opts.full ? END_HOLD : 30)) this.phase = { k: 'done' }
        break
    }
    if (this.effect?.error) this.phase = { k: 'done' }

    for (const f of this.fighters) {
      if (!f) continue
      f.drawAnim = f.anim
      f.drawTime = f.time
      const g = f.gans[f.anim]
      if (g) f.time = (f.time + 1) % Math.max(1, totalTicks(g))
    }

    // The effect state runs after the units; effectStart's own frame only queues the load.
    const eff = this.phase.k === 'attack' || this.phase.k === 'spellEffect' ? this.phase.effectFrame : -1
    if (this.effect && !this.effect.finished && (this.opts.mode === 'none' || this.frame > eff)) this.effect.step()
    this.frame++
  }

  // ---- drawing ----

  /**
   * Game order with the depth buffer: background, HUD, units, portraits, effect camera 0, camera 6.
   * Without it the same visibility comes from painting: background, portraits, camera 0, HUD, units, camera 6.
   */
  render(gl: GlRenderer) {
    if (this.opts.mode === 'none') {
      this.effect?.render(gl)
      return
    }
    const p = this.phase
    this.drawBackground(gl)
    // The last frame of the end hold shows only the background.
    if (p.k === 'hold' && p.t >= END_HOLD - 1 && this.opts.full) return
    const intro = p.k === 'intro'
    if (gl.depthTest) {
      this.drawHud(gl)
      this.drawUnits(gl)
      this.drawPortraits(gl)
      this.effect?.render(gl, [0])
    } else {
      if (!intro) this.drawPortraits(gl)
      this.effect?.render(gl, [0])
      this.drawHud(gl)
      this.drawUnits(gl)
      if (intro) this.drawPortraits(gl)
    }
    this.effect?.render(gl, [6])
    for (const w of [...this.introWins, ...this.nameWins, ...this.popupWins]) if (w) this.windows.draw(gl, w, this.frame)
    // The intro draws a second centre emblem (the "VS" plate) on top of everything.
    if (intro && this.atlas) this.blit(gl, this.atlas, 288, 0, 344, 72, 292, 188, 1)
  }

  private blit(gl: GlRenderer, img: RgbaImage, u0: number, v0: number, u1: number, v1: number, x: number, y: number, d: number, scale = 1) {
    const w = (u1 - u0) * scale, h = (v1 - v0) * scale
    if (w <= 0 || h <= 0) return
    const V = (px: number, py: number, u: number, v: number): Vertex => ({ x: px, y: py, w: 1, d, u: u / img.width, v: v / img.height })
    const tl = V(x, y, u0, v0), tr = V(x + w, y, u1, v0), bl = V(x, y + h, u0, v1), br = V(x + w, y + h, u1, v1)
    gl.triangles(gl.texture(img), 'alpha', [tl, tr, bl, tr, br, bl], WHITE)
  }

  /** etc.one 200/1 is copied 1:1 onto the 480×272 frame buffer, i.e. the whole virtual screen. */
  private drawBackground(gl: GlRenderer) {
    const bg = this.bg
    if (!bg) return
    const V = (x: number, y: number, u: number, v: number): Vertex => ({ x, y, w: 1, d: 0, u, v })
    gl.triangles(gl.texture(bg), 'alpha', [V(0, 0, 0, 0), V(640, 0, 1, 0), V(0, 448, 0, 1), V(640, 0, 1, 0), V(640, 448, 1, 1), V(0, 448, 0, 1)], WHITE)
  }

  /** battleDrawHud: panels, HP bars and numbers from the etc.one 200/2 atlas, and the player flags. */
  private drawHud(gl: GlRenderer) {
    const a = this.atlas
    if (!a) return
    const d = sortedDepth(0)
    const [L, R] = this.fighters
    const wl = Math.trunc(L?.bar ?? 152), wr = Math.trunc(R?.bar ?? 152)
    this.blit(gl, a, 0, 128, 288, 224, 4, 12, d)
    this.blit(gl, a, 0, 112, 124 + wl, 128, 4, 40, d)
    this.blit(gl, a, 0, 0, 288, 96, 348, 12, d)
    this.blit(gl, a, 166 - wr, 96, 288, 112, 514 - wr, 40, d)
    this.blit(gl, a, 288, 0, 344, 72, 292, 16, d)
    const num = (value: number, cx: number, cy: number, big: boolean) => {
      const w = big ? 24 : 18, h = big ? 32 : 24, v = big ? 224 : 264
      const n = Math.max(0, Math.min(99, value | 0))
      const y = cy - h / 2
      if (n < 10) this.blit(gl, a, n * w, v, n * w + w, v + h, cx - w / 2, y, d)
      else {
        const t = Math.floor(n / 10), o = n % 10
        this.blit(gl, a, t * w, v, t * w + w, v + h, cx - w, y, d)
        this.blit(gl, a, o * w, v, o * w + w, v + h, cx, y, d)
      }
    }
    this.fighters.forEach((f, s) => {
      if (!f?.card) return
      num(f.hp, s ? 544 : 96, 50, true)
      num(f.df, s ? 593 : 48, 46, false)
      num(f.ap, s ? 510 : 137, 87, false)
    })
    const fl = this.flags
    if (fl) {
      const fr = 7 - ((this.frame >> 3) & 7)
      this.blit(gl, fl, 32 * fr, 0, 32 * fr + 32, 26, 48 - 16, 73 - 13, d)
      this.blit(gl, fl, 32 * fr, 32, 32 * fr + 32, 58, 563 - 16, 73 - 13, d)
    }
  }

  /**
   * unit.one /3. Intro (battleIntroUpdate): x −320 → 8 by ≤16/frame, hold, then scale 1.3 → 0.8 and
   * y 16 → 128; the right portrait is anchored at its top-right corner (640 − x). Drawn with depth 0,
   * i.e. in front of the units. Afterwards: 0.8× at (8, 128) / (440, 128), GE z 0 (behind the units),
   * cut from the bottom when the unit dies.
   */
  private drawPortraits(gl: GlRenderer) {
    const p = this.phase
    let x = 8, y = 128, s = 0.8, d = 0, intro = false
    if (p.k === 'intro' && p.t < INTRO_FRAMES - 1) {
      intro = true
      const k = p.t
      x = Math.min(8, -320 + 16 * k)
      if (k >= 150) {
        const j = k - 149
        s = Math.max(0.8, 1.3 - 0.02 * Math.min(j, 25))
        y = Math.min(128, 16 + 5 * j)
      } else {
        s = 1.3
        y = 16
      }
      d = sortedDepth(0)
    }
    this.portraits.forEach((img, side) => {
      if (!img) return
      const f = this.fighters[side]
      const v1 = img.height - (f?.portraitCut ?? 0)
      if (v1 <= 0) return
      const left = side === 0 ? x : intro ? 640 - x - img.width * s : 440
      this.blit(gl, img, 0, 0, img.width, v1, left, y, d, s)
    })
  }

  /**
   * battleSetupCombatantFacing: the units stand at world (−64, 96) / (64, 32) at angle 0 and
   * (32, 64) / (96, −64) at 90, moved linearly during a turn; screen = (320, 224) + Rz(angle)·world.
   * The left unit is mirrored, neither is rotated, scale 1.8. Depth 0 for the lower unit, 16 for the other.
   */
  private drawUnits(gl: GlRenderer) {
    const a = this.angle
    const k = a / 3
    const world: [number, number][] = [
      [-64 + 3.2 * k, 96 - (32 / 30) * k],
      [64 + (32 / 30) * k, 32 - 3.2 * k],
    ]
    const r = (a * Math.PI) / 180
    const origins = world.map(([x, y]) => [320 + x * Math.cos(r) - y * Math.sin(r), 224 + x * Math.sin(r) + y * Math.cos(r)] as [number, number])
    const depths = a < 46 ? [0, 16] : [16, 0]
    const order = gl.depthTest ? [0, 1] : depths[0] > depths[1] ? [0, 1] : [1, 0]
    for (const s of order) {
      const f = this.fighters[s]
      if (f) this.drawUnit(gl, f, origins[s], s === 0, sortedDepth(depths[s]))
    }
  }

  private drawUnit(gl: GlRenderer, u: Fighter, origin: [number, number], mirror: boolean, d: number) {
    const g = u.gans[u.drawAnim]
    if (!g || !g.steps.length) return
    const parts = g.frames[g.steps[stepAt(g, u.drawTime)].frame] ?? []
    const S = 1.8
    for (const p of parts) {
      if (p.w <= 0 || p.h <= 0 || isMarker(p)) continue
      const byte = p.flags & 1 ? (p.flags >> 4) & 3 : 0x10
      const alpha = (((128 * (GAN_BASE_ALPHA[byte] ?? 0x7f)) >> 6) & 0xff) >> 1
      const col = vertexColor(128, 128, 128, alpha)
      if (col[3] <= 0) continue
      const pw = p.w / 2, ph = p.h / 2
      const pts = [[-pw, -ph], [pw, -ph], [-pw, ph], [pw, ph]].map(([cx, cy]) => {
        let x = cx, y = cy
        if (p.flags & 8) {
          x *= p.scaleX
          y *= p.scaleY
        }
        if (p.flags & 4) {
          const t = (p.angle * Math.PI) / 180
          ;[x, y] = [x * Math.cos(t) - y * Math.sin(t), x * Math.sin(t) + y * Math.cos(t)]
        }
        const lx = (p.dx - 128 + pw + x) * S
        const ly = (p.dy - 128 + ph + y) * S
        return [origin[0] + (mirror ? -lx : lx), origin[1] + ly]
      })
      const key = `${p.image}:${p.clut}:${u.drawAnim}`
      let img = u.sheets.get(key)
      if (!img) u.sheets.set(key, (img = ganSheet(g, p.image, g.palettes[p.clut])))
      const u0 = p.sx / img.width, v0 = p.sy / img.height, u1 = (p.sx + p.w) / img.width, v1 = (p.sy + p.h) / img.height
      const V = (k: number, uu: number, vv: number): Vertex => ({ x: pts[k][0], y: pts[k][1], w: 1, d, u: uu, v: vv })
      const blend: BlendMode = byte & 1 ? 'add' : 'alpha'
      gl.triangles(gl.texture(img), blend, [V(0, u0, v0), V(1, u1, v0), V(2, u0, v1), V(1, u1, v0), V(3, u1, v1), V(2, u0, v1)], col)
    }
  }
}

/** battleApplySpellCard step 100: the target's HP after the spell (id-specific). */
function spellHp(spell: number, t: Fighter): number {
  const c = t.card
  const hp = t.hp
  const protectedKill = has(c, 29)
  switch (spell) {
    case 2001:
      return Math.max(0, hp - 3)
    case 2003:
      return protectedKill ? hp : 0
    case 2005:
      return !protectedKill && t.ap > 3 ? 0 : hp
    case 2006:
      return !protectedKill && hp + t.df > 4 ? 0 : hp
    case 2009:
      return Math.max(0, hp - t.ap)
    case 2201:
      return hp > 0 ? Math.min(t.maxHp, hp + 2) : hp
    case 2202:
      return hp > 0 ? Math.min(t.maxHp, hp + 5) : hp
    case 2309:
      return Math.max(0, hp - 2)
    case 2506:
      return c?.type === 'base' ? 0 : hp
  }
  return hp
}
