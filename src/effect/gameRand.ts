/**
 * The game's random numbers (docs/formats/map-board.md "Random numbers"):
 * - `rand()` / `srand()`: newlib's 64-bit LCG (next = next · 0x5851F42D4C957F2D + 1, returns bits 32–62).
 *   The title screen calls srand(save playTime), which is always 0 in this build; the deck shuffle
 *   (playerShuffleDeck, modes 1/2), randJitter2D and the font cache draw from it.
 * - `gameRandNext()` (0x0887B544): s = ((s·t) >> 8 [signed, rounded toward 0] + (rand() & 0x7FFF)) & 0xFFFF,
 *   t = s, initial s/t 0x3427 / 0x1654 (never re-seeded). The map spells, the CPU, the counter window,
 *   the card rewards and the effect scripts' `rand(n)` use it.
 * - `adhocSyncRand()`: the ad-hoc (versus, g_gameMode 0) LCG seed·0x343FD + 0x269EC3, (seed & 0x7FFFFFFF) >> 16,
 *   used instead of both in versus play so the two PSPs stay in step.
 *
 * One shared instance (`gameRng`) stands for the game's globals: the map and the effect player draw from
 * the same sequence, as in the game.
 */
export class GameRand {
  /** newlib _rand_next as two 32-bit halves. */
  private lo = 1
  private hi = 0
  /** gameRandNext state s, t. */
  s = 0x3427
  t = 0x1654
  /** g_adhocSyncRandSeed. */
  adhoc = 0

  /** srand(seed): _rand_next = seed (high word 0). */
  srand(seed: number) {
    this.lo = seed >>> 0
    this.hi = 0
  }

  /** newlib rand(): 0..0x7FFFFFFF. */
  rand(): number {
    // next = next · 0x5851F42D_4C957F2D + 1 (mod 2^64)
    const A_LO = 0x4c957f2d, A_HI = 0x5851f42d
    const lo = this.lo, hi = this.hi
    // 32×32 → 64 product of the low words, split in 16-bit pieces
    const a0 = A_LO & 0xffff, a1 = A_LO >>> 16, b0 = lo & 0xffff, b1 = lo >>> 16
    const p00 = a0 * b0, p01 = a0 * b1, p10 = a1 * b0, p11 = a1 * b1
    const mid = (p00 >>> 16) + (p01 & 0xffff) + (p10 & 0xffff)
    const low = ((mid & 0xffff) << 16) | (p00 & 0xffff)
    const high = p11 + (p01 >>> 16) + (p10 >>> 16) + (mid >>> 16)
    let nlo = (low >>> 0) + 1
    let carry = 0
    if (nlo > 0xffffffff) {
      nlo -= 0x100000000
      carry = 1
    }
    const nhi = (high + Math.imul(lo, A_HI) + Math.imul(hi, A_LO) + carry) >>> 0
    this.lo = nlo >>> 0
    this.hi = nhi
    return nhi & 0x7fffffff
  }

  /** gameRandNext (0x0887B544): 0..0xFFFF. */
  next(): number {
    let p = Math.imul(this.s, this.t)
    if (p < 0) p += 0xff
    const r = this.rand()
    let u = r & 0x7fff
    if ((r | 0) < 0 && u !== 0) u -= 0x8000
    this.s = ((p >> 8) + u) & 0xffff
    this.t = this.s
    return this.s
  }

  /** adhocSyncRand: 0..0x7FFF. */
  adhocNext(): number {
    this.adhoc = (Math.imul(this.adhoc, 0x343fd) + 0x269ec3) >>> 0
    return (this.adhoc & 0x7fffffff) >>> 16
  }

  /** A fresh game session: srand(seed), gameRandNext back to its boot values, the ad-hoc seed. */
  reset(seed: number) {
    this.srand(seed)
    this.s = 0x3427
    this.t = 0x1654
    this.adhoc = seed >>> 0
  }
}

/** The game's globals: shared by the map rules, the flows, the CPU and the effect scripts. */
export const gameRng = new GameRand()
