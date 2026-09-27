/**
 * Headless checks of src/effect/mapRules.ts, gameRand.ts and parts of mapFlows.ts against the behaviour read from the game code
 * (docs/formats/rules.md, card-effects.md). Run with `node scripts/map-rules-check.ts` (Node ≥ 22
 * strips the types; mapRules.ts only imports types).
 */
import { MapGame, type RAbility, type RCard, type Player } from '../src/effect/mapRules.ts'
import { GameRand } from '../src/effect/gameRand.ts'
import { MapFlows, spellTargetMode, type FlowHost, type WinRef } from '../src/effect/mapFlows.ts'

let failed = 0
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`)
}

const cards = new Map<number, RCard>()
const def = (id: number, type: RCard['type'], p: Partial<RCard> = {}) =>
  cards.set(id, { id, type, ap: 2, hp: 5, range: 1, move: 3, cost: 3, soul: 0, maintenance: 1, attribute: 0, abilities: [0, 0, 0], mapEffect: 0, battleEffect: 0, ...p })
def(1001, 'chara', { ap: 3, hp: 20, move: 2, abilities: [53, 0, 0], maintenance: 0 })
def(1002, 'chara', { ap: 3, hp: 20, move: 2, abilities: [53, 0, 0], maintenance: 0 })
def(10, 'unit', { ap: 3, hp: 4, attribute: 1 })
def(11, 'unit', { ap: 2, hp: 4, abilities: [21, 0, 0] }) // Spy
def(12, 'unit', { ap: 2, hp: 4, abilities: [41, 0, 0] }) // Wandering Citizen
def(13, 'unit', { ap: 2, hp: 4, abilities: [24, 0, 0] }) // Support Attack
def(14, 'unit', { ap: 1, hp: 6, abilities: [18, 2, 0] }) // Boost Buffs 1.5x, First Attack
def(15, 'unit', { ap: 4, hp: 3, abilities: [16, 0, 0] }) // Annul Base
def(2302, 'spell', { cost: 5, abilities: [1, 1, 0] })
def(2309, 'spell', { cost: 4, abilities: [1, 1, 0] })
def(2001, 'spell', { cost: 3 })
def(3001, 'base', { range: 3, hp: 5, ap: 0, abilities: [29, 0, 0] }) // Goblin Watchtower
def(3004, 'base', { range: 4, hp: 5, ap: 0, abilities: [29, 0, 0] }) // Labyrinth Marsh
def(3009, 'base', { range: 0, hp: 5, ap: 0, abilities: [29, 0, 0] }) // Toneriko Tree
def(3011, 'base', { range: 4, hp: 5, ap: 0, abilities: [29, 0, 0] }) // Symbolic Flag
const abilities = new Map<number, RAbility>()

const land = new Array(1600).fill(-1)
for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) land[y * 40 + x] = 0
land[5 * 40 + 5] = 1

function game() {
  const g = new MapGame(12, 12, land, 100, (id) => cards.get(id), (id) => abilities.get(id))
  for (const p of g.players) {
    p.deck = [1001 + p.index, 10, 11, 12, 13, 14, 15, 2302, 2309, 2001, 3001, 3004, 3009, 3011, ...new Array(17).fill(0)]
    p.deckState = new Uint8Array(31)
    for (let s = 0; s < 31; s++) g.initUnit(g.units[p.index][s], p.index, p.deck[s], s)
  }
  return g
}
const put = (g: MapGame, p: number, slot: number, x: number, y: number) => {
  const u = g.units[p][slot]
  u.posX = x * 64
  u.posY = y * 64
  g.placeOnGrid(u)
  return u
}

// playerCalcPayment: cost clamps to 1; Soul pays a shortfall (g_mapCostRules 3); Toneriko Tree −1 for spells
{
  const g = game()
  const p = g.players[0]
  p.cost = 2
  p.soul = 5
  eq('payment: soul covers the shortfall', g.calcPayment(p, 4, 1, 8), [0, 2])
  eq('payment: not enough', g.calcPayment(p, 9, 0, 8), [-7, 5])
  put(g, 0, 12, 0, 0) // Toneriko Tree
  eq('payment: Toneriko Tree −1 (spell flag)', g.calcPayment(p, 3, 0, 8), [0, 5])
  eq('payment: never below 1', g.calcPayment(p, 1, 0, 8), [1, 5])
  p.flags |= 0x200
  eq('payment: Cast Spell −2, min 1', g.calcPayment(p, 3, 0, 8), [1, 5])
  eq('payment: flag 0x10 (abilities) no modifiers, Soul pays the shortfall', g.calcPayment(p, 3, 0, 0x10), [0, 4])
}
// handMarkUsableCards: Dried-up Well greys everything; counter cards only in their windows
{
  const g = game()
  const p = g.players[0]
  p.hand = [1, 7, 9, 0, 0, 0]
  p.cost = 3
  p.soul = 0
  g.markUsable(p, 1)
  eq('usable: cost 3 fits, 5 does not', p.usable, [1, 2, 1, 0, 0, 0])
  p.flags |= 0x10
  g.markUsable(p, 1)
  eq('usable: Dried-up Well', p.usable, [0, 0, 0, 0, 0, 0])
  g.markUsable(p, 0x400)
  eq('usable: discard mode ignores the well', p.usable, [1, 1, 1, 0, 0, 0])
}
// unitRecalcStats: attachments ×1.5 (Boost Buffs), land bonus, enemy Watchtower, Support Attack
{
  const g = game()
  const u = put(g, 0, 5, 3, 3) // AP 1, Boost Buffs
  u.attachments = [2302, 2309, 0, 0, 0, 0]
  g.recalc(u)
  eq('recalc: (4−2)×1.5 + 1 = 4 AP, (1−1)×1.5 = 0 DF', [u.effAp, u.effDf], [4, 0])
  const v = put(g, 0, 1, 5, 5) // attribute 1 on land 1
  eq('recalc: land bonus +1/+1', [v.effAp, v.effDf], [4, 1])
  put(g, 1, 10, 6, 7) // enemy Watchtower within 3 of (5,5)
  g.recalc(v)
  eq('recalc: enemy Watchtower −1/−1', [v.effAp, v.effDf], [3, 0])
  put(g, 0, 4, 5, 4) // Support Attack holder next to v
  g.recalc(v)
  eq('recalc: adjacent Support Attack +1 AP', v.effAp, 4)
  const an = put(g, 0, 6, 6, 6) // Annul Base next to the tower
  eq('recalc: Annul Base ignores the tower', [an.effAp, an.effDf], [4, 0])
}
// mapSeizeCell: Symbolic Flag of the other team, Wandering Citizen, Cause for Civil War
{
  const g = game()
  put(g, 1, 13, 8, 8) // enemy Symbolic Flag, range 4
  const u = put(g, 0, 1, 1, 1)
  g.lift(u)
  u.posX = 6 * 64
  u.posY = 7 * 64
  eq('seize: inside an enemy Symbolic Flag', g.seizeCell(u, 0, 1), false)
  u.posX = 1 * 64
  u.posY = 2 * 64
  eq('seize: outside', g.seizeCell(u, 0, 1), true)
  eq('seize: pending bit and leg', g.conquest[2 * 40 + 1].toString(16), '101')
  const w = g.units[0][3] // Wandering Citizen
  w.posX = 2 * 64
  w.posY = 2 * 64
  eq('seize: Wandering Citizen', g.seizeCell(w, 0, 1), false)
  g.players[0].flags |= 8
  u.posX = 1 * 64
  u.posY = 3 * 64
  eq('seize: Cause for Civil War', g.seizeCell(u, 0, 2), false)
  g.undoSeize(1)
  eq('undo seize: leg 1 back to owned bits', g.conquest[2 * 40 + 1], 0)
}
// mapMarkMoveLines: an enemy base stops the line unless Spy; a Labyrinth Marsh square stops it
{
  const g = game()
  put(g, 1, 10, 4, 1) // enemy Watchtower (base) at (4,1)
  const s = put(g, 0, 2, 1, 1) // Spy
  g.markMoveLines(s, 5, 0)
  eq('move lines: Spy passes the enemy base', [g.marks[1 * 40 + 3], g.marks[1 * 40 + 4], g.marks[1 * 40 + 5]], [0x11, 0x11, 0x11])
  g.marks.fill(0)
  const n = put(g, 0, 1, 1, 2)
  put(g, 1, 11, 11, 11) // Labyrinth Marsh far away: range 4 does not reach
  g.markMoveLines(n, 5, 0)
  eq('move lines: open line', g.marks[2 * 40 + 6], 0x11)
  g.marks.fill(0)
  const m = g.units[1][11]
  g.lift(m)
  g.removeBaseAura(m)
  m.posX = 5 * 64
  m.posY = 6 * 64
  g.placeOnGrid(m) // marsh covers (3,2)? |5−3| + |6−2| = 6 > 4, (5,2): 4
  g.markMoveLines(n, 6, 0)
  eq('move lines: stops on the first marsh square', [g.marks[2 * 40 + 5], g.marks[2 * 40 + 6]], [0x11, 0])
}
// mapCanDeployAt: adjacent to an own unit; land of the card's attribute if unseized; Ambush anywhere
{
  const g = game()
  put(g, 0, 0, 1, 1)
  eq('deploy: next to own Dominator', g.canDeployAt(0, 0, 2, 1), true)
  eq('deploy: far away', g.canDeployAt(0, 0, 8, 8), false)
  eq('deploy: attribute land (5,5) for attribute 1', g.canDeployAt(0, 1, 5, 5), true)
  g.conquest[5 * 40 + 5] = 0x2000
  eq('deploy: attribute land owned by the enemy', g.canDeployAt(0, 1, 5, 5), false)
  g.players[0].flags |= 4
  eq('deploy: Ambush', g.canDeployAt(0, 0, 8, 8), true)
}
// unitDestroy: Soul for the unit's team when the card had been on the board; Epsilon's Protection doubles
{
  const g = game()
  const u = put(g, 0, 1, 2, 2)
  u.hp = 0
  g.players[0].flags |= 0x100
  g.destroy(u, true)
  eq('destroy: +2 Soul with Epsilon, discard pile, square cleared', [g.players[0].soul, g.players[0].deckState[1] & 8, g.grid[2 * 40 + 2]], [2, 8, 0])
}
// mapCommitConquest
{
  const g = game()
  g.conquest[0] = 0x100
  g.conquest[1] = 0x201
  g.conquest[2] = 0x1000
  g.commitConquest()
  eq('commit: pending → owned, counts', [g.conquest[0], g.conquest[1], g.conquestCount[0], g.conquestCount[1]], [0x1000, 0x2000, 2, 1])
}
// battleCalcDamage outcome: the sole First Attack holder strikes first, DF absorbs
{
  const g = game()
  const a = put(g, 0, 1, 2, 2) // AP 3, HP 4
  const t = put(g, 1, 5, 2, 3) // AP 1, HP 6, First Attack, Boost Buffs
  eq('battle: first strike then the attacker', g.battlePredict(a, t), [3, 3])
}

// ---- random numbers (src/effect/gameRand.ts) ----
{
  // newlib rand(): next = next · 0x5851F42D4C957F2D + 1, bits 32..62
  const r = new GameRand()
  r.srand(12345)
  let x = 12345n
  let same = true
  for (let i = 0; i < 2000; i++) {
    x = (x * 0x5851f42d4c957f2dn + 1n) & 0xffffffffffffffffn
    if (r.rand() !== Number((x >> 32n) & 0x7fffffffn)) same = false
  }
  eq('rand: newlib 64-bit LCG', same, true)
  // gameRandNext: s = ((s·t) >> 8, rounded toward 0) + (rand() & 0x7FFF), 16 bits
  const a = new GameRand(), b = new GameRand()
  a.reset(0)
  b.reset(0)
  let s = 0x3427, t = 0x1654, ok = true
  for (let i = 0; i < 500; i++) {
    // 32-bit signed product, C division by 256 (rounds toward zero)
    const q = Math.trunc((s * t | 0) / 256)
    s = t = (q + (b.rand() & 0x7fff)) & 0xffff
    if (a.next() !== s) ok = false
  }
  eq('gameRandNext: formula', ok, true)
  const c = new GameRand()
  c.reset(7)
  const d = new GameRand()
  d.reset(7)
  eq('adhocSyncRand: seed · 0x343FD + 0x269EC3', c.adhocNext(), ((Math.imul(7, 0x343fd) + 0x269ec3) >>> 0 & 0x7fffffff) >>> 16)
  void d
}
// playerShuffleDeck: a permutation of 1..30, and 30 hits + 10001 misses of rand() % 30 for the 31st round
{
  const g = game()
  const r = new GameRand()
  r.reset(99)
  g.rng = r
  g.gameMode = 1
  const p = g.players[0]
  g.shuffle(p)
  const sorted = [...p.drawOrder.slice(1)].sort((x, y) => x - y)
  eq('shuffle: drawOrder[1..30] is a permutation of 1..30', sorted.join(), Array.from({ length: 30 }, (_, i) => i + 1).join())
  const r2 = new GameRand()
  r2.reset(99)
  const used = new Set<number>()
  let calls = 0
  for (let k = 1; k < 32; k++)
    for (let tries = 0; tries < 10001; tries++) {
      calls++
      const v = r2.rand() % 30
      if (!used.has(v)) {
        used.add(v)
        break
      }
    }
  eq('shuffle: the generator ends in the same state', r.rand() === r2.rand() && calls > 10000, true)
}

// ---- flows with a scripted host (mapFlows.ts) ----
function flowHost(g: MapGame) {
  const wins = new Map<string, WinRef>()
  const log: string[] = []
  const host = {
    game: g,
    pressed: 0,
    select: 0,
    name: (id: number) => Uint8Array.from(String(id), (ch) => ch.charCodeAt(0)),
    abilityName: () => new Uint8Array(0),
    abilityDesc: () => new Uint8Array(0),
    cardText: () => new Uint8Array(0),
    str: () => new Uint8Array(0),
    msg: (key: string, x: number, y: number) => {
      const w = { win: { x, y, w: 100, h: 30 } }
      wins.set(key, w)
      return w
    },
    frame: (key: string, x: number, y: number, w: number, h: number) => {
      const r = { win: { x, y, w, h } }
      wins.set(key, r)
      return r
    },
    print: () => {},
    clearPrints: () => {},
    close: (key: string) => void wins.delete(key),
    closeAll: () => wins.clear(),
    isOpen: (key: string) => wins.has(key),
    win: (key: string) => wins.get(key),
    cursorStep: () => true,
    effect: (id: number) => void log.push(`effect ${id}`),
    effectBusy: () => false,
    setCurUnit: () => {},
    isCpu: (p: number) => (g.players[p]?.controller ?? 0) >= 2,
    playerName: () => new Uint8Array(0),
    handSelect: (p: Player) => {
      if (host.select > 0) p.selected = p.hand[p.cursor >> 5]
      return host.select
    },
    openList: (key: string, x: number, y: number, w: number, h: number) => host.frame(key, x, y, w, h),
    openMenu: (key: string, x: number, y: number) => host.frame(key, x, y, 100, 50),
    listInput: () => {},
    listCursor: () => 0,
    eventStart: () => {},
    eventUpdate: () => 1,
  }
  return { host: host as unknown as FlowHost & { pressed: number; select: number }, log, wins }
}
def(2401, 'spell', { cost: 6 })
def(2402, 'spell', { cost: 5, abilities: [1, 1, 0] })
def(2007, 'spell', { cost: 10, mapEffect: 21 })
// mapCounterSpellWindow: the CPU waits 48 frames, then declines when ((r & 0xFFFF) + 1) / 11 % 10 < 4
for (const seed of [1, 2, 3, 4, 5, 6]) {
  const g = game()
  const r = new GameRand()
  r.reset(seed)
  g.rng = r
  const { host } = flowHost(g)
  const f = new MapFlows(host)
  g.players[1].controller = 0xff
  g.players[1].cost = 20
  g.players[1].deck[20] = 2401
  g.players[1].hand = [20, 0, 0, 0, 0, 0]
  const probe = new GameRand()
  probe.reset(seed)
  const willDecline = Math.trunc(((probe.next() & 0xffff) + 1) / 11) % 10 < 4
  let res = 0, frames = 0
  host.select = 1
  while (res === 0 && frames < 400) {
    res = f.counterWindow(2001, 0x20)
    frames++
    if (res === 0 && (f as unknown as { cwState: number }).cwState === 50) (host as { pressed: number }).pressed = 0x4000
    else (host as { pressed: number }).pressed = 0
  }
  // declined in the spell mode → Magic Barrier check (no barrier, mode 0) → not countered
  eq(`counter (seed ${seed}): CPU ${willDecline ? 'declines' : 'counters'}`, [res, g.players[1].hand[0] === 0], willDecline ? [-1, false] : [1, true])
}
// Magic Barrier on the target of a mode-1 spell: nullified, the barrier is removed
{
  const g = game()
  const { host, log } = flowHost(g)
  const f = new MapFlows(host)
  const t = put(g, 1, 1, 4, 4)
  t.attachments = [2402, 0, 0, 0, 0, 0]
  f.spTarget = t
  f.spMode = 1
  f.spCard = 2001
  let res = 0
  for (let i = 0; i < 20 && res === 0; i++) {
    res = f.counterWindow(2001, 0x20)
    ;(host as { pressed: number }).pressed = (f as unknown as { cwState: number }).cwState === 50 ? 0x4000 : 0
  }
  eq('counter: Magic Barrier nullifies (effect 0x45 when the barrier has a map effect)', [res, t.attachments[0]], [1, 0])
  void log
}
// spellGetTargetMode
eq('spellGetTargetMode: Memory Slip 7, Summon Earth 4, Shard of Life 10, Earth Nova 12, Firestorm 6, Magic Bolt 1', [2601, 2502, 2205, 2007, 2002, 2001].map(spellTargetMode), [7, 4, 10, 12, 6, 1])
// spellEarthNova: HP − 4 for every unit, a Magic Barrier holder is spared and loses the barrier
{
  const g = game()
  const { host, log } = flowHost(g)
  const f = new MapFlows(host)
  g.players[0].controller = 0xff
  g.players[1].controller = 0xff
  const a = put(g, 0, 1, 2, 2)
  const b = put(g, 1, 2, 6, 6)
  b.attachments = [2402, 0, 0, 0, 0, 0]
  g.players[0].deck[5] = 2007
  g.players[0].hand = [5, 0, 0, 0, 0, 0]
  g.players[0].cost = 30
  f.cpuTarget = g.units[0][0]
  let res = 0
  for (let i = 0; i < 200 && res === 0; i++) {
    res = f.spell()
    ;(host as { pressed: number }).pressed = f.spState === 5000 ? 0x4000 : 0
  }
  eq('Earth Nova: HP − 4 (the unit died and went to the discard pile), Magic Barrier consumed, effect 21 played', [a.state, g.players[0].deckState[1] & 8, b.hp, b.attachments[0], log.includes('effect 21')], [0, 8, 4, 0, true])
}

console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
if (failed) process.exitCode = 1
