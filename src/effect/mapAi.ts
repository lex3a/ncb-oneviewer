/**
 * The CPU player of the map (docs/formats/ai.md), ported from aiMapTurnUpdate (0x08822B38) and the
 * functions it calls: aiFloodDistMap, aiSelectNextUnit, aiPlanUnit / aiMoveSearch /
 * aiEvalAttackTarget, aiCommitPlan, aiDecideAction with aiPickActivatedAbility / aiEvalAbility and
 * the aiEval* ability evaluators, aiChooseHandCard, aiPlaceSummon, aiChooseMapSpell with
 * aiSpellTargetOk, and aiChooseDiscard.
 */
import { A, cardType, CT_BASE, CT_CHARA, CT_SPELL, CT_UNIT, MapGame, type Player, type Unit } from './mapRules.ts'
import type { MapFlows } from './mapFlows.ts'

/** g_aiPlans entry (31 × 0x38). */
interface Plan {
  flags: number
  moveScore: number
  moveDest: number
  movePath: number
  moveSteps: number
  atkScore: number
  atkCell: number
  atkPath: number
  atkNew: number
  atkSteps: number
  /** owner << 8 | slot */
  atkTarget: number
  ability: number
  abilityPri: number
  abilityTarget: number
}
const blankPlan = (): Plan => ({ flags: 0, moveScore: 0, moveDest: 0, movePath: 0, moveSteps: 0, atkScore: 0, atkCell: 0, atkPath: 0, atkNew: 0, atkSteps: 0, atkTarget: 0, ability: 0, abilityPri: 0, abilityTarget: 0 })

export interface AiHost {
  readonly game: MapGame
  readonly flows: MapFlows
  /** handSelectUpdate(player, mode) of the scene (the CPU branch calls back into chooseHandCard / chooseDiscard). */
  handSelect(p: Player, mode: number): number
  /** unitStepToward: 1 walking, 0 arrived, −1 not in line. */
  stepToward(u: Unit, tx: number, ty: number): number
  loadWalk(u: Unit): void
  /** The board scene's active unit (g_mapActiveUnit = g_aiCurUnit). */
  setActive(u: Unit): void
}

export class MapAi {
  readonly h: AiHost
  state = 0
  timer = 0
  unitSlot = 0
  private steps = 0
  dist = new Uint8Array(1600).fill(0xff)
  plans: Plan[] = Array.from({ length: 31 }, blankPlan)
  cur: Unit | null = null
  private moveDest = 0
  private movePath = 0
  private stepTx = 0
  private stepTy = 0
  /** g_aiHandCards (frames 0–5 of aiChooseHandCard). */
  private handCards = [0, 0, 0, 0, 0, 0]
  private summonCell = 0xffff
  private summonSlot = 0
  /** aiChooseMapSpell results: the target unit (g_duelAttackerUnit) and cell (g_aiSpellTargetCell). */
  spellTarget: Unit | null = null
  spellCell = 0
  /** The attack target after aiDecideAction (g_duelTargetUnit). */
  attackTarget: Unit | null = null
  private discardWait = 0

  constructor(h: AiHost) {
    this.h = h
  }
  private get g() {
    return this.h.game
  }
  private get tp() {
    return this.g.turnPlayer
  }
  private enemyDom() {
    return this.g.units[(this.tp + 1) & 1][0]
  }

  /** A new CPU turn (g_aiUnitSlot = 0 after mapTurnEndUpdate). */
  reset() {
    this.state = 0
    this.timer = 0
    this.unitSlot = 0
  }

  /** aiMapTurnUpdate: one frame; a nonzero return is the new board state. */
  update(): number {
    const g = this.g
    const p = g.players[this.tp]
    const s0 = this.state
    let r = 0
    switch (this.state) {
      case 0:
        this.cur = g.units[this.tp][0]
        if (this.unitSlot === 0) {
          this.resetPlans()
          this.state = 1
        } else this.state = 3
        break
      case 1: {
        const e = this.enemyDom()
        this.flood(e.posX >> 6, e.posY >> 6, 0, 0xf)
        if (++this.steps > 3) {
          this.steps = 0
          this.state = 4
        }
        break
      }
      case 3: {
        const k = this.selectNextUnit()
        if (k > 0) this.state = 7
        else if (k < 0) this.state = 14
        break
      }
      case 4: {
        const c = this.h.handSelect(p, 1)
        if (c !== 0) this.state = 3
        if (c === 1) {
          const t = cardType(p.deck[p.hand[p.cursor >> 5]] ?? 0)
          this.summonSlot = 0
          if (t === CT_SPELL) this.state = 6
          else if (t === CT_BASE || t === CT_UNIT) {
            this.state = 5
            const u = g.units[this.tp][p.selected]
            g.marks.fill(0)
            g.markSummonCells(u.attribute)
          } else this.state = 3
        }
        break
      }
      case 5: {
        const k = this.placeSummon()
        if (k > 0) this.state = 4
        else if (k < 0) this.state = 3
        break
      }
      case 6: {
        this.h.flows.cpuTarget = this.spellTarget
        const k = this.h.flows.spell()
        if (k !== 0) {
          this.state = 4
          if (g.dominatorDown()) r = 9000
        }
        break
      }
      case 7:
        this.planUnit()
        this.commitPlan()
        this.state = this.steps === 0 ? 10 : 8
        break
      case 8: {
        const u = this.cur!
        g.lift(u)
        u.state = 3
        if (u.posX === (this.moveDest & 0xff) << 6 && u.posY === (this.moveDest >> 8) << 6) this.state = 10
        else {
          this.h.loadWalk(u)
          this.nextStep(this.movePath & 3)
          this.state = 9
        }
        break
      }
      case 9: {
        const u = this.cur!
        u.state = 2
        const k = this.h.stepToward(u, this.stepTx, this.stepTy)
        g.cursor.x = u.posX
        g.cursor.y = u.posY
        g.seizeCell(u, u.player, 0)
        if (k === 0) {
          if (--this.steps <= 0) {
            this.steps = 0
            u.state = 3
            g.attachmentOp(u, 2102, 4)
            this.state = 10
          } else {
            const d = (this.movePath & 0xf) >> 2
            this.movePath >>>= 2
            this.nextStep(d)
          }
        }
        break
      }
      case 10:
        if (++this.timer > 0x40) this.state = 11
        break
      case 11: {
        const k = this.decideAction()
        this.state = k === 1 ? 12 : k === 2 ? 13 : 14
        break
      }
      case 12:
        if (++this.timer > 0x1f) r = 0x834
        break
      case 13: {
        const k = this.h.flows.ability()
        if (k === 0x834) {
          // Boost: the battle against the ability's target
          this.attackTarget = this.h.flows.abTarget
          r = 0x834
        }
        else if (k > 0) r = 0xb54
        else if (k < 0) {
          g.cursor.x = this.cur!.posX
          g.cursor.y = this.cur!.posY
          this.state = 14
        }
        break
      }
      case 14:
        r = 9000
        break
    }
    if (this.cur) this.h.setActive(this.cur)
    if (r !== 0) this.state = 0
    if (this.state !== s0) this.timer = 0
    return r
  }

  /** The next square of the 2-bit path (0 x−1, 1 y−1, 2 x+1, 3 y+1); a step onto a missing square ends the walk (viewer guard). */
  private nextStep(d: number) {
    const u = this.cur!
    this.stepTx = u.posX + (d === 0 ? -0x40 : d === 2 ? 0x40 : 0)
    this.stepTy = u.posY + (d === 1 ? -0x40 : d === 3 ? 0x40 : 0)
    const x = this.stepTx >> 6, y = this.stepTy >> 6
    if (!this.g.inBoard(x, y) || this.g.land[y * 40 + x] < 0 || this.g.grid[y * 40 + x]) {
      this.stepTx = u.posX
      this.stepTy = u.posY
      this.steps = 1
    }
  }

  /** aiResetPlans: distance map 0xFF, plan flags and attack scores cleared. */
  private resetPlans() {
    this.dist.fill(0xff)
    this.plans = Array.from({ length: 31 }, blankPlan)
    this.state = 0
    this.steps = 0
    this.summonSlot = 0
  }

  /** aiFloodDistMap(x, y, d, dir) (0x088228A4). */
  private flood(x: number, y: number, d: number, dir: number) {
    const g = this.g
    if (x < 0 || y < 0 || x >= g.W || y >= g.H || g.land[y * 40 + x] < 0) return
    const w = g.grid[y * 40 + x]
    let slot = (w >>> 16) & 0xff
    if (slot === 0xff) slot = 0
    if ((w | 0) > 0 && MapGame.teamOf(w) !== this.tp + 1 && slot !== 0) d |= 0x80
    const n = d + 1
    if (d < this.dist[y * 40 + x] && (n & 0x7f) < 0x20) {
      this.dist[y * 40 + x] = n
      if (dir === 3) {
        this.flood(x - 1, y, n, 0)
        this.flood(x + 1, y, n, 2)
        this.flood(x, y + 1, n, 3)
      } else if (dir === 2) {
        this.flood(x, y - 1, n, 1)
        this.flood(x, y + 1, n, 3)
        this.flood(x + 1, y, n, 2)
      } else if (dir === 1) {
        this.flood(x - 1, y, n, 0)
        this.flood(x + 1, y, n, 2)
        this.flood(x, y - 1, n, 1)
      } else if (dir === 0) {
        this.flood(x, y - 1, n, 1)
        this.flood(x, y + 1, n, 3)
        this.flood(x - 1, y, n, 0)
      } else {
        this.flood(x - 1, y, n, 0)
        this.flood(x + 1, y, n, 2)
        this.flood(x, y - 1, n, 1)
        this.flood(x, y + 1, n, 3)
      }
    }
  }

  /** aiSelectNextUnit: slots from g_aiUnitSlot (0 → 1) to 30, then the Dominator. */
  private selectNextUnit(): number {
    const g = this.g
    let s = this.unitSlot === 0 ? 1 : this.unitSlot
    for (;;) {
      if (s >= 31) s = 0
      const u = g.units[this.tp][s]
      const t = cardType(u.cardId)
      if ((!(u.actFlags & 8) && u.team === this.tp && u.hp > 0 && u.state >= 1 && (t === CT_CHARA || t === CT_UNIT)) || s === 0) break
      s++
    }
    this.unitSlot = s
    const u = g.units[this.tp][s]
    if (u.actFlags & 8 || u.state < 1) return -1
    this.movePath = 0
    this.steps = 0
    this.cur = u
    this.moveDest = ((u.posY >> 6) << 8) + (u.posX >> 6)
    const pl = this.plans[s]
    pl.flags = 0
    pl.moveScore = 0
    pl.atkScore = 0
    pl.atkCell = pl.moveDest = this.moveDest
    pl.atkPath = pl.movePath = 0
    pl.atkNew = 0
    pl.ability = 0
    return 1
  }

  /** aiPlanUnit: reset the plan, recompute stats and search from the unit's square. */
  private planUnit() {
    const g = this.g
    const u = g.units[this.tp][this.unitSlot]
    g.recalcAll()
    this.movePath = 0
    this.steps = 0
    this.moveDest = ((u.posY >> 6) << 8) + (u.posX >> 6)
    this.cur = u
    const pl = this.plans[this.unitSlot]
    Object.assign(pl, blankPlan(), { moveDest: this.moveDest, atkCell: this.moveDest })
    this.search(u.posX >> 6, u.posY >> 6, u.slot & 0xff, 0, 0, 0, 0, 0xf)
  }

  /**
   * aiMoveSearch(x, y, slot, depth, path, newCells, pathBits, arriveDir) (0x08825C70): an exhaustive
   * search over every path of up to `move` steps. Friendly units are passed straight on only, enemy
   * units block (bases can be passed with Spy); a Labyrinth Marsh square allows one more step.
   */
  private search(x: number, y: number, slot: number, depth: number, path: number, newCells: number, bits: number, arrive: number) {
    const g = this.g
    const u = this.cur!
    const move = u.effMove & 0xff
    let dirs = 0xf
    let pass = false
    if (x < 0 || y < 0 || x >= g.W || y >= g.H || g.land[y * 40 + x] < 0) return
    let w = g.grid[y * 40 + x]
    if ((w | 0) > 0) {
      let ws = (w >>> 16) & 0xff
      if (ws === 0xff) ws = 0
      if (bits) dirs = 0
      let blocked = false
      if (MapGame.teamOf(w) === this.tp + 1) {
        if ((slot & 0xff) !== ws) pass = true
      } else {
        blocked = true
        if (cardType(w & 0xffff) === CT_BASE && g.countAbility(u, A.spy)) pass = true
      }
      if (blocked && !pass) return
    }
    if (pass && bits) dirs = arrive
    if (!dirs) return
    if (bits) {
      let fresh = true
      let px = (u.posX & 0x3fff) >> 6, py = (u.posY & 0x3fff) >> 6
      if (x === px && y === py) fresh = false
      else
        for (let k = 0; k < bits - 2; k += 2) {
          const d = (path >>> k) & 3
          if (d === 0) px = (px - 1) & 0xff
          else if (d === 1) py = (py - 1) & 0xff
          else if (d === 2) px = (px + 1) & 0xff
          else py = (py + 1) & 0xff
          if (x === px && y === py) {
            fresh = false
            break
          }
        }
      if (fresh && !(g.conquest[y * 40 + x] & (1 << (this.tp + 12)))) newCells = (newCells + 1) & 0xff
    }
    let score = 0
    let better = false
    if (bits === 0) better = true
    else {
      const D = this.dist[y * 40 + x]
      const e = this.enemyDom()
      if (D === 0xff) score = (newCells << 8) + (g.W - Math.abs((e.posX >> 6) - x)) + (g.H - Math.abs((e.posY >> 6) - y))
      else if ((slot & 0xff) === 0) {
        score = newCells << 8
        if (g.units[this.tp][0].hp < 7 || g.round < 3) score += D
        else score += 0xff - D
      } else if (u.effAp < e.hp) {
        if (e.hp < 0xb) score = u.effMove << 1 < D ? newCells + (0xff - D) : newCells + (0xff - D) * 4
        else score = (newCells << 8) + (0xff - D)
      } else score = newCells + (0xff - D) * 0x10
      score = (score << 16) >> 16
    }
    const pl = this.plans[slot & 0xff]
    if (pl.moveScore < score) better = true
    if (pass) better = false
    w = g.grid[y * 40 + x]
    if (w !== 0) better = false
    if (bits === 0) better = true
    if (better) {
      pl.flags |= 1
      pl.moveScore = score
      pl.movePath = path
      pl.moveDest = (y << 8) + x
      pl.moveSteps = depth
    }
    if ((bits === 0 || (w === 0 && !pass)) && !(u.actFlags & 4)) {
      this.evalAttack(x - 1, y, path, newCells, bits)
      this.evalAttack(x, y - 1, (path | (1 << bits)) >>> 0, newCells, bits)
      this.evalAttack(x + 1, y, (path | (2 << bits)) >>> 0, newCells, bits)
      this.evalAttack(x, y + 1, (path | (3 << bits)) >>> 0, newCells, bits)
    }
    let next = depth + 1
    if (next <= move && dirs) {
      if (g.countBaseAuras(x, y, 0xf, 3004) > 0 && !g.countAbility(u, A.annulBase)) next = move
      if (!(u.actFlags & 9)) {
        if (x > 0 && dirs & 1) this.search(x - 1, y, slot, next, path, newCells, bits + 2, 1)
        if (y > 0 && dirs & 2) this.search(x, y - 1, slot, next, (path | (1 << bits)) >>> 0, newCells, bits + 2, 2)
        if (x < 0x27 && dirs & 4) this.search(x + 1, y, slot, next, (path | (2 << bits)) >>> 0, newCells, bits + 2, 4)
        if (y < 0x27 && dirs & 8) this.search(x, y + 1, slot, next, (path | (3 << bits)) >>> 0, newCells, bits + 2, 8)
      }
    }
  }

  /** aiEvalAttackTarget(x, y, path, newCells, pathBits) (0x08825518): the battleCalcDamage prediction. */
  private evalAttack(x: number, y: number, path: number, newCells: number, bits: number) {
    const g = this.g
    const M = this.cur!
    if (x < 0 || y < 0 || x >= g.W || y >= g.H || g.land[y * 40 + x] < 0) return
    const w = g.grid[y * 40 + x]
    if ((w | 0) <= 0 || MapGame.teamOf(w) === this.tp + 1) return
    let tslot = (w >>> 16) & 0xff
    if (tslot === 0xff) tslot = 0
    const T = g.unitOfWord(w)
    if (!T) return
    let atkT = T.effAp
    const hpT = T.hp
    let atkM = M.effAp
    const hpM = M.hp
    let dfM = M.effDf
    let dfT = T.effDf
    if (cardType(T.cardId) === CT_BASE && g.countAbility(M, A.attackCastle)) {
      atkM += 5
      dfM += 1
    }
    let a = g.countAbility(M, A.kodama) ? atkT : atkM
    if (g.countAbility(T, A.kodama)) atkT = a
    if (g.countAbility(M, A.fierce)) dfT = 0
    if (g.countAbility(T, A.fierce)) dfM = 0
    if (a > 3 && g.countAbility(T, A.reflect)) a = 0
    if (atkT > 3 && g.countAbility(M, A.reflect)) atkT = 0
    for (let i = 0; i < 4; i++) {
      if (g.countAbility(T, i + 42) && M.attribute === i + 1) a = 0
      if (g.countAbility(M, i + 42) && T.attribute === i + 1) atkT = 0
    }
    const leftM = hpM + dfM - atkT
    const leftT = hpT + dfT - a
    let score: number
    let pen = 0
    if (leftT < 1) score = tslot === 0 ? 0x4100 : 0x100
    else {
      if (a <= dfT) return
      if (tslot === 0) score = (leftT < 10 ? 0x101 : 0x40) + 0x10
      else score = 0x10
    }
    if (dfM < atkT) {
      if (leftM < 1) {
        if (M.slot > 0) pen = 1
      } else score += 0x80
    } else if (cardType(T.cardId) !== CT_BASE) score += 0x1000
    if (M.slot === 0) {
      if (T.slot === 0) {
        if (leftM < 10 && leftM < leftT) score = 0
      } else if (leftM < 5) score = 0
    }
    if (g.countAbility(T, A.firstAttack) && !g.countAbility(M, A.firstAttack) && leftM < 1) score = 0
    if (g.countAbility(M, A.evasion)) score = 5
    if (g.countAbility(M, A.deathDefense)) {
      if (g.countAbility(T, A.mutualDeath) && leftT < 1) pen++
      if (g.countAbility(T, A.wordPsalm)) pen++
    }
    if (score === 0) return
    score -= pen
    const pl = this.plans[M.slot]
    if (pl.atkScore > score) return
    // the cell from which to attack: walk the path until the target square
    let pos = ((M.posY >> 6) << 8) + (M.posX >> 6)
    let cell = pos
    for (let k = 0; k <= 0x1f; k += 2) {
      cell = pos
      const d = (path >>> k) & 3
      if (d === 0) pos = (pos - 1) & 0xffff
      else if (d === 1) pos = (pos - 0x100) & 0xffff
      else if (d === 2) pos = (pos + 1) & 0xffff
      else pos = (pos + 0x100) & 0xffff
      if (pos === (y << 8) + x) break
      cell = pos
    }
    const steps = bits >> 1
    if (score !== pl.atkScore || (pl.atkNew <= newCells && (newCells !== pl.atkNew || pl.atkSteps === 0 || steps <= pl.atkSteps))) {
      pl.flags |= 2
      pl.atkScore = score
      pl.atkCell = cell
      pl.atkPath = path
      pl.atkNew = newCells
      pl.atkTarget = (T.player << 8) + T.slot
      pl.atkSteps = steps
    }
  }

  /** aiCommitPlan: an attack score below 11 (unsigned) falls back to the move plan. */
  private commitPlan() {
    const pl = this.plans[this.cur!.slot]
    if (pl.atkScore >>> 0 < 0xb) {
      pl.atkScore = 0
      this.moveDest = pl.moveDest
      this.movePath = pl.movePath
      this.steps = pl.moveSteps
    } else {
      this.moveDest = pl.atkCell
      this.movePath = pl.atkPath
      this.steps = pl.atkSteps
    }
  }

  /** aiDecideAction: pri ≥ 6 ability; attack ≥ 0x1000; pri ≥ 4; attack ≥ 0x100; pri ≥ 1; attack ≥ 1. */
  private decideAction(): number {
    const g = this.g
    const u = this.cur!
    const x = u.posX >> 6, y = u.posY >> 6
    this.pickAbility(u)
    this.evalAbility(u, x, y, false)
    const pl = this.plans[u.slot]
    const pri = pl.abilityPri, atk = pl.atkScore
    let k: number
    if (pri >= 6) k = 2
    else if (atk >= 0x1000) k = 1
    else if (pri >= 4) k = 2
    else if (atk >= 0x100) k = 1
    else if (pri >= 1) k = 2
    else k = atk >= 1 ? 1 : 0
    if (k === 1) {
      const t = g.units[pl.atkTarget >> 8]?.[pl.atkTarget & 0xff] ?? null
      this.attackTarget = t
      return t && u.team !== t.team ? 1 : -1
    }
    if (k === 2) {
      this.evalAbility(u, x, y, true)
      return 2
    }
    return 0
  }

  /** aiPickActivatedAbility: the last active ability of the card, none with actFlags & 2 or when unaffordable. */
  private pickAbility(u: Unit) {
    const g = this.g
    let id = 0
    for (const a of g.card(u.cardId)?.abilities ?? []) if (g.ability(a)?.active) id = a
    if (u.actFlags & 2) id = 0
    if (id > 0) {
      const ab = g.ability(id)
      const [rc, rs] = g.calcPayment(g.players[u.team], ab?.useCost ?? 0, ab?.useSoul ?? 0, 0x10)
      if (rc < 0 || rs < 0) id = 0
    }
    this.plans[u.slot].ability = id
    this.plans[u.slot].abilityPri = 0
  }

  /** aiEvalAbility(unit, x, y, exec): the priority (exec false) or abilitySetActive (exec true). */
  private evalAbility(u: Unit, x: number, y: number, exec: boolean) {
    const g = this.g
    const pl = this.plans[u.slot]
    const id = pl.ability
    let v = -1
    if (!id) return
    const F = this.h.flows
    const tgt = () => g.units[pl.abilityTarget >> 8]?.[pl.abilityTarget & 0xff] ?? u
    if (id === A.rotatingSlash) v = this.evalRotating(u, x, y, exec)
    else if (id === A.evolution) {
      v = 1
      if (exec) F.abilitySetActive(id, u, u, -1, -1, 2000)
      else if (g.players[this.tp].soul < 2 || u.baseAp > 0x1d) v = 0
    } else if (id >= 35 && id <= 38) v = this.evalSummonElement(u, id, exec)
    else if (id === A.boost) {
      v = 0
      if (exec) {
        F.abilitySetActive(id, u, tgt(), u.posX, u.posY, 2000)
        v = 1
      } else if (pl.atkScore > 0) {
        v = 3
        pl.abilityTarget = pl.atkTarget
      }
    } else if (id === A.berserk) v = this.evalBerserk(u, x, y, exec)
    else if (id === A.assassinate) v = this.evalAssassinate(u, x, y, exec)
    else if (id === A.snipe1 || id === A.snipe2 || id === A.snipe3) v = this.evalSnipe(u, x, y, exec)
    if (!exec) pl.abilityPri = v
  }

  /** aiEvalSnipe: enemies in the scanned square x−r…x+r−1, y−r…y+r−1 that are also in the diamond. */
  private evalSnipe(u: Unit, x: number, y: number, exec: boolean): number {
    const g = this.g
    const pl = this.plans[u.slot]
    if (exec) {
      this.h.flows.abilitySetActive(pl.ability, u, g.units[pl.abilityTarget >> 8]?.[pl.abilityTarget & 0xff] ?? u, -1, -1, 2000)
      return 1
    }
    const r = pl.ability === A.snipe2 ? 3 : pl.ability === A.snipe3 ? 4 : 2
    let best = 0
    let pick: Unit | null = null
    for (let yy = y - r; yy < y + r; yy++)
      for (let xx = x - r; xx < x + r; xx++) {
        if (Math.abs(xx - x) + Math.abs(yy - y) > r || !g.inBoard(xx, yy)) continue
        const w = g.getCell(xx, yy)
        if (w <= 0) continue
        const t = g.unitOfWord(w)
        if (!t || t.team === u.team) continue
        let v = 4
        if (t.slot === 0) v = t.hp < 10 ? 7 : 6
        if (!(u.effAp < t.hp)) v++
        if (t.effAp > 4) v++
        if (best < v) {
          best = v
          pick = t
        }
      }
    if (best && pick) pl.abilityTarget = (pick.player << 8) + pick.slot
    return best
  }
  /** aiEvalBerserk (0x08827400): the last adjacent enemy (W, N, E, S) decides. */
  private evalBerserk(u: Unit, x: number, y: number, exec: boolean): number {
    const g = this.g
    if (exec) this.h.flows.abilitySetActive(A.berserk, u, u, -1, -1, 2000)
    let v = 0, n = 0
    for (const [dx, dy] of [[-1, 0], [0, -1], [1, 0], [0, 1]]) {
      const w = g.getCell(x + dx, y + dy)
      if (w <= 0) continue
      const t = g.unitOfWord(w)
      if (!t || t.team === u.team) continue
      if (t.slot === 0 && t.hp <= 2) v = 4
      else if (u.hp < 3) v = -1
      else v = g.countAbility(t, A.reflect) ? 3 : u.hp < 7 ? 2 : 1
      n++
    }
    if (v === 2) v = n > 2 ? 3 : -1
    else if (v === 1) v = n > 1 ? 3 : -1
    return v
  }
  /**
   * aiEvalAssassinate (0x0882715C): marks the diamond of radius 3 (mapFillDiamond 0x40), scans
   * x − 3…x + 2, y − 3…y + 2 on marked squares for an enemy without Death Defense with the strictly
   * highest AP + maintenance (> 0) → priority 4, else 0; then clears the whole range grid.
   */
  private evalAssassinate(u: Unit, x: number, y: number, exec: boolean): number {
    const g = this.g
    const pl = this.plans[u.slot]
    if (exec) {
      this.h.flows.abilitySetActive(A.assassinate, u, g.units[pl.abilityTarget >> 8]?.[pl.abilityTarget & 0xff] ?? u, -1, -1, 2000)
      return 1
    }
    let pri = 0, best = 0
    let pick: Unit | null = null
    g.fillDiamond(x, y, 3, 0x40)
    for (let yy = y - 3; yy < y + 3; yy++)
      for (let xx = x - 3; xx < x + 3; xx++) {
        const m = xx >= 0 && yy >= 0 && xx < 40 && yy < 40 ? g.marks[yy * 40 + xx] : 0
        const w = m ? g.getCell(xx, yy) : 0
        if (w <= 0) continue
        const t = g.unitOfWord(w)
        if (!t || g.countAbility(t, A.deathDefense) || t.team === this.tp) continue
        const s = t.effAp + (g.card(t.cardId)?.maintenance ?? 0)
        if (best < s) {
          pri = 4
          best = s
          pick = t
        }
      }
    g.marks.fill(0)
    if (pri && pick) pl.abilityTarget = (pick.player << 8) + pick.slot
    return pri
  }
  /**
   * aiEvalRotatingSlash (0x08827808): W, N, E, S; an own Dominator next to it with HP < 2 → −1 (stops);
   * an enemy with Reflect Big Swings → 4; else 3 with two or more adjacent enemies, −1 otherwise.
   */
  private evalRotating(u: Unit, x: number, y: number, exec: boolean): number {
    const g = this.g
    if (exec) {
      this.h.flows.abilitySetActive(A.rotatingSlash, u, u, -1, -1, 2000)
      return 1
    }
    let v = 0, n = 0
    for (const [dx, dy] of [[-1, 0], [0, -1], [1, 0], [0, 1]]) {
      const w = g.getCell(x + dx, y + dy)
      if (w > 0) {
        const t = g.unitOfWord(w)
        if (t) {
          if (MapGame.teamOf(w) === u.team + 1) {
            if (t.slot === 0 && t.hp < 2) v = -1
          } else if (g.countAbility(t, A.reflect)) v = 4
          else n++
        }
      }
      if (v < 0) break
    }
    if (v === 0) v = n > 1 ? 3 : -1
    return v
  }
  /** aiEvalSummonElement (0x08827664): 1 unless the unit's square already has the element (Summon Earth 35 … Air 38). */
  private evalSummonElement(u: Unit, id: number, exec: boolean): number {
    const g = this.g
    if (!id) return 0
    if (exec) {
      this.h.flows.abilitySetActive(id, u, u, -1, -1, 2000)
      return 1
    }
    return g.land[(u.posY >> 6) * 40 + (u.posX >> 6)] === id - 34 ? 0 : 1
  }

  // ---- cards ----

  /**
   * aiChooseHandCard(player) (0x08824EF4): frames 0–5 record the usable cards, frame 6 plays the first
   * that passes (units and bases under the 16-unit limit, never Healing Spring / Labyrinth Marsh / Trap
   * Zone, TNT Clock Tower only unless the enemy Dominator has less HP than the own and more than 15;
   * spells when aiChooseMapSpell picks a target). 1 chosen, −1 none, 0 busy.
   */
  chooseHandCard(p: Player): number {
    const g = this.g
    const t = this.timer
    if (t < 6) {
      this.timer++
      this.handCards[t] = p.usable[t] === 1 ? (p.deck[p.hand[t]] ?? 0) : 0
      return 0
    }
    for (let i = 0; i < 6; i++) {
      const c = this.handCards[i]
      if (!c) continue
      p.cursor = i << 5
      const ty = cardType(c)
      if (ty === CT_BASE) {
        let ok = true
        if (c === 3012) {
          const e = this.enemyDom(), o = g.units[this.tp][0]
          if (e.hp < o.hp && e.hp > 15) ok = false
        } else if (c === 3013 || c === 3004 || c === 3002) ok = false
        if (ok && 16 - g.placedCount[this.tp] > 0) return 1
      } else if (ty === CT_SPELL) {
        if (this.chooseMapSpell(c)) {
          g.cursor.x = (this.spellCell & 0xff) << 6
          g.cursor.y = (this.spellCell >> 8) << 6
          return 1
        }
      } else if (ty === CT_UNIT && 16 - g.placedCount[this.tp] > 0) return 1
    }
    return -1
  }

  /** aiChooseDiscard: waits 32 frames, then the first occupied slot (1-based). */
  chooseDiscard(p: Player): number {
    if (++this.discardWait < 32) return 0
    this.discardWait = 0
    const i = p.hand.findIndex((d) => d > 0)
    return i + 1
  }

  /** aiPlaceSummon (0x0882523C): the marked square nearest the enemy Dominator (or farthest / random for some bases). */
  private placeSummon(): number {
    const g = this.g
    const p = g.players[this.tp]
    const u = g.units[this.tp][p.selected]
    if (this.summonCell === 0xffff) this.summonSlot = 0
    let far = 0
    if (u.cardId === 3014 || u.cardId === 3012 || u.cardId === 3009 || u.cardId === 3006) far = 1
    else if (u.cardId === 3011 || u.cardId === 3005) far = Math.trunc(((g.rng.next() & 0xffff) + 1) / 11) & 1
    if (this.summonSlot === 0) {
      let best = 0
      let found = false
      for (let y = 0; y < g.H; y++)
        for (let x = 0; x < g.W; x++) {
          if (!(g.marks[y * 40 + x] & 0x80)) continue
          const d = this.dist[y * 40 + x]
          const take = best === 0 || (far ? best < d : d < best)
          if (take) {
            best = d
            found = true
            this.summonCell = (y << 8) + x
            this.summonSlot = u.slot
          }
        }
      if (!found) this.summonSlot = 0
    }
    let r: number
    if (this.summonSlot === 0) r = -1
    else {
      g.cursor.x = (this.summonCell & 0xff) << 6
      g.cursor.y = (this.summonCell >> 8) << 6
      r = this.h.flows.summon(u, g.cursor.x, g.cursor.y, 0)
    }
    if (r !== 0) {
      g.compactHand(p)
      this.summonCell = 0xffff
      g.marks.fill(0)
    }
    return r
  }

  /** aiSpellTargetOk(card, unit, x, y, mask) (0x08827DE4): alive and placed, and none of the excluded properties. */
  private targetOk(u: Unit, mask: number): boolean {
    const g = this.g
    if (u.hp < 1 || u.state < 1) return false
    if (mask & 1 && g.countBaseAuras(u.posX >> 6, u.posY >> 6, 0xf, 3005) && !g.countAbility(u, A.annulBase)) return false
    if (mask & 2 && g.countAbility(u, A.annulAttack)) return false
    if (mask & 4 && g.countAbility(u, A.unableBuff)) return false
    if (mask & 8 && g.countAbility(u, A.deathDefense)) return false
    if (mask & 0x10 && g.attachmentOp(u, 2402, 0)) return false
    if (mask & 0x20 && g.attachedCount(u) >= 6) return false
    if (mask & 0x40 && cardType(u.cardId) === CT_CHARA) return false
    if (mask & 0x80 && cardType(u.cardId) === CT_BASE) return false
    return true
  }

  /**
   * aiChooseMapSpell(id) (0x08823450): the card id when it has a target (g_duelAttackerUnit /
   * g_aiSpellTargetCell), else 0. Every loop walks both rows of g_mapUnits (slots 0–30) and filters by
   * team; a candidate must beat the score strictly (unsigned). Cards without a case are never cast.
   */
  private chooseMapSpell(id: number): number {
    const g = this.g
    const own = this.tp, enemy = (own + 1) & 1
    const op = g.players[own], ep = g.players[enemy]
    const oDom = g.units[own][0], eDom = g.units[enemy][0]
    let score = 0
    let accept = 0
    let target: Unit = oDom
    this.cur = oDom
    const all = () => [...g.units[0], ...g.units[1]]
    const best = (list: Unit[], ok: (u: Unit) => boolean, value: (u: Unit) => number) => {
      for (const u of list) {
        if (!ok(u)) continue
        const v = value(u) >>> 0
        if (score >>> 0 < v) {
          score = v
          target = u
        }
      }
    }
    const maint = (u: Unit) => g.card(u.cardId)?.maintenance ?? 0
    const dist = (u: Unit) => this.dist[((u.posY & 0x3fff) >> 6) * 40 + ((u.posX & 0x3fff) >> 6)]
    const hand = (p: Player) => g.handCount(p)
    switch (id) {
      case 2617:
        if (!(op.flags & 0x100)) accept = id
        break
      case 2616:
        if (!(op.flags & 0x80)) accept = id
        break
      case 2615:
        score = (g.placedCount[enemy] - g.placedCount[own]) >>> 0
        break
      case 2614:
        if (!(op.flags & 0x40)) accept = id
        break
      case 2613:
        if (!(op.flags & 0x20)) accept = id
        break
      case 2611:
        if (op.deckCount < 10) {
          target = g.units[op.index][0]
          accept = id
        }
        break
      case 2609:
        if (g.placedCount[enemy] > 3 && g.placedCount[own] < g.placedCount[enemy]) accept = id
        break
      case 2607:
        if (hand(ep) > 1) {
          target = g.units[ep.index][0]
          accept = id
        }
        break
      case 2606:
        if (hand(ep) > 3) {
          target = eDom
          accept = id
        }
        break
      case 2605:
        if (!(ep.flags & 8)) {
          target = g.units[ep.index][0]
          accept = id
        }
        break
      case 2604:
        target = eDom
        accept = id
        break
      case 2603:
        if (g.units[ep.index][0].hp < 6 && ep.deckCount < 6) {
          target = g.units[ep.index][0]
          accept = id
        } else if (hand(op) < 3) {
          if (!(op.deckCount < 6 && g.units[op.index][0].hp < 11)) {
            target = g.units[op.index][0]
            accept = id
          }
        }
        break
      case 2602:
        if (g.units[ep.index][0].hp < 6 && ep.deckCount < 6) {
          target = g.units[ep.index][0]
          accept = id
        } else if (hand(op) < 3 && 5 - hand(op) <= op.deckCount) {
          target = g.units[op.index][0]
          accept = id
        }
        break
      case 2601:
        if (hand(ep) > 2) {
          score = hand(ep)
          target = g.units[ep.index][0]
        }
        break
      case 2506:
        for (const u of all()) {
          let ok = this.targetOk(u, 1)
          if (u.team === own) ok = false
          if (cardType(u.cardId) !== CT_BASE) ok = false
          if (!ok) continue
          const v = u.hp * ((((g.rng.next() & 0xffff) + 1) % 10) + 1)
          if (score < v) {
            score = v
            target = u
          }
        }
        break
      case 2402:
        best(all(), (u) => this.targetOk(u, 0xb1) && u.team === own, (u) => (u.slot === 0 ? 100 : maint(u)))
        break
      case 2304:
        best(all(), (u) => this.targetOk(u, 0xb5) && u.team === own, (u) => (dist(u) <= (u.effMove & 0xff) ? 0x80 : 0) | (u.effAp >= 5 ? 0x1000 : 0) | (u.hp > 2 ? 0x100 : 0))
        break
      case 2310:
      case 2308:
      case 2307:
      case 2306:
      case 2303:
      case 2302:
        best(all(), (u) => this.targetOk(u, 0xb5) && u.team === own, (u) => (dist(u) <= (u.effMove & 0xff) ? 0x8000 : 0) | (u.hp > 2 ? 0x1000 : 0))
        break
      case 2301:
        best(all(), (u) => this.targetOk(u, 0xb5) && u.team !== own && u.effAp > 2, (u) => u.effAp)
        break
      case 2208: {
        let n = 0
        for (const u of all()) {
          if (!this.targetOk(u, 0x11) || u.team !== own) continue
          if (u.slot === 0 ? u.hp < u.maxHp - 3 : u.hp < u.maxHp) n++
        }
        if (n > 2 || oDom.hp < 1) {
          target = oDom
          accept = id
        }
        break
      }
      case 2207:
        best(all(), (u) => this.targetOk(u, 0xf1) && u.team === own && !g.countAbility(u, A.deathDefense) && maint(u) >= 10, (u) => maint(u) + u.effAp)
        break
      case 2206:
        best(all(), (u) => this.targetOk(u, 0xf1) && u.team === own && !g.attachmentOp(u, 2206, 0) && maint(u) >= 10, maint)
        break
      case 2204:
        if (!(op.flags & 2)) {
          target = g.units[op.index][0]
          accept = id
        }
        break
      case 2203:
        // the loop runs g_numPlayers times over the enemy row only
        for (let k = 0; k < 2; k++) best(g.units[enemy], (u) => this.targetOk(u, 0x91) && u.team !== own, (u) => (g.countAttachments(u, 2103) ? 0 : g.attachedCount(u) << 16))
        break
      case 2201:
      case 2202: {
        const heal = id === 2201 ? 2 : 5
        if (oDom.hp < 11 && this.targetOk(oDom, 0x11)) {
          score = id
          target = oDom
        } else best(all(), (u) => this.targetOk(u, 0x11) && u.team === own && u.hp + heal <= u.maxHp, (u) => (u.slot === 0 ? 0x1000 : 0) + u.effAp)
        break
      }
      case 2110:
        if (this.targetOk(oDom, 0xb1) && g.attachmentOp(oDom, 2110, 0) <= 2) {
          target = oDom
          accept = id
        } else best(all(), (u) => this.targetOk(u, 0xb1) && u.team === own && u.effMove <= 8 && !g.countAbility(u, A.wandering), (u) => u.effMove * 0x100 + u.effAp)
        break
      case 2109:
        best(all(), (u) => this.targetOk(u, 0xd1) && u.team !== own && u.effAp + maint(u) > 10, (u) => u.effAp + maint(u))
        break
      case 2009:
      case 2001:
        if (this.targetOk(eDom, 3)) {
          target = eDom
          accept = id
        }
        break
      case 2007: {
        let mine = 0, theirs = 0
        for (const u of all()) {
          if (!this.targetOk(u, 0x13) || u.hp >= 5) continue
          if (u.team === own) mine++
          else theirs++
        }
        if (this.targetOk(eDom, 0x13) && eDom.hp <= 4) {
          target = eDom
          accept = id
        } else if ((!this.targetOk(oDom, 0x13) || oDom.hp > 4) && theirs < mine) {
          target = oDom
          accept = id
        }
        break
      }
      case 2006:
      case 2005:
      case 2004:
      case 2003:
        best(all(), (u) => this.targetOk(u, 0x1b) && u.team !== own, (u) => {
          let reach = u.effMove & 0xff
          if (g.countAbility(u, A.snipe3)) reach += 4
          else if (g.countAbility(u, A.snipe2)) reach += 3
          else if (g.countAbility(u, A.snipe1)) reach += 2
          reach &= 0xff
          let v = 0
          if (!(reach < dist(u))) {
            if (oDom.hp <= (u.effAp & 0xff)) v = 0x80000000
            v = (v | 0x40000000) >>> 0
          }
          const hd = u.hp + u.effDf
          if (hd >= 2) v += hd
          if (u.effAp > 3) v += u.effAp
          if (id === 2005 && u.effAp < 5) v = 0
          if (id === 2006 && hd < 5) v = 0
          return v >>> 0
        })
        break
    }
    let r = score !== 0 ? id : accept
    this.spellTarget = target
    if (r > 0) this.spellCell = ((target.posY >> 6) << 8) + (target.posX >> 6)
    else {
      r = 0
      this.spellCell = ((oDom.posY >> 6) << 8) + (oDom.posX >> 6)
    }
    return r
  }
}
