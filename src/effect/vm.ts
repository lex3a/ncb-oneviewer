/**
 * CAS1 interpreter, a port of the game's scrExecSlot (0x0889CE10) and its built-ins.
 * Values are references: every stack entry is a cell index into one flat memory, so assignments
 * write through their left operand exactly like the original (even into code literals).
 * See docs/formats/cas1.md ("Execution model").
 */
import { parseCas, type Cas } from '../formats/cas'
import { casFuncName } from '../formats/casNames'
import { gameRng } from './gameRand'

export const T_INT = 0x10
export const T_FLOAT = 0x20
export const T_STR = 0x30
export const T_LABEL = 0x60

const THREADS = 13
const CALL_DEPTH = 8
const STACK = 128
const RING = 128
const LOCALS = 32
/** Not in the game (a loop without wait_frame hangs it); keeps a broken script from freezing the tab. */
const BUDGET = 2_000_000

export interface StackRef {
  ref: number
  tag: number
}

/** Built-ins outside the VM core (effect library, sound, battle state). Return the handler result, or undefined if unknown. */
export type Host = (id: number, vm: Vm) => number | undefined

export class ScriptError extends Error {}

export class Vm {
  readonly cas: Cas
  private mem: ArrayBuffer
  readonly i32: Int32Array
  readonly f32: Float32Array
  private readonly codeBase = 0
  private readonly globalsBase: number
  private readonly ringBase: number
  private readonly locIntBase: number
  private readonly locFltBase: number
  private readonly strBase: number

  private stackRef = new Int32Array(STACK)
  private stackTag = new Int32Array(STACK)
  sp = 0
  private ringIdx = 0
  private pcStack = new Int32Array(THREADS * CALL_DEPTH)
  private depth = new Int16Array(THREADS).fill(-1)
  private entry = new Int32Array(16)
  private entryEnabled = new Uint8Array(16)
  private args: number[] = []
  curThread = 0
  /** 1 running, 0 dead. */
  state = 1
  frame = 0
  log: string[] = []

  private host: Host

  constructor(data: Uint8Array, host: Host) {
    this.host = host
    // Each run works on a fresh copy: the globals live inside the file and are written in place.
    this.cas = parseCas(data.slice())
    const n = this.cas.instrs.length
    const g = this.cas.globals.length >> 2
    this.globalsBase = this.codeBase + n
    this.ringBase = this.globalsBase + g
    this.locIntBase = this.ringBase + RING
    this.locFltBase = this.locIntBase + THREADS * LOCALS
    this.strBase = this.locFltBase + THREADS * LOCALS
    this.mem = new ArrayBuffer((this.strBase + 1) * 4)
    this.i32 = new Int32Array(this.mem)
    this.f32 = new Float32Array(this.mem)
    for (let i = 0; i < n; i++) this.i32[i] = this.cas.instrs[i].arg | 0
    const gv = new DataView(this.cas.globals.buffer, this.cas.globals.byteOffset, this.cas.globals.byteLength)
    for (let i = 0; i < g; i++) this.i32[this.globalsBase + i] = gv.getInt32(i * 4, true)
  }

  // ---- driver (effectStateWaitLoad) ----

  /** Init pass (scrSetBuffer) and the trigger of entry 15. Entry 15 first runs on the next frame. */
  start() {
    this.entryEnabled[15] = 1
    this.depth[0] = 0
    this.pcStack[0] = this.entry[15]
    this.execFrame()
    if (this.state === 1 && this.entryEnabled[15] && this.depth[0] < 4) {
      this.depth[0]++
      this.pcStack[this.depth[0]] = this.entry[15]
    }
  }

  get running() {
    return this.state === 1
  }

  /** scrExecSlot: all threads for one frame. */
  execFrame() {
    if (this.state !== 1) return
    this.frame++
    let budget = BUDGET
    const instrs = this.cas.instrs
    for (let t = 0; t < THREADS; t++) {
      this.curThread = t
      if (this.state !== 1) break
      while (this.depth[t] >= 0) {
        if (--budget < 0) throw new ScriptError(`thread ${t} never waits (pc ${this.pc(t)})`)
        const pc = this.pc(t)
        const ins = instrs[pc]
        let r = 0
        switch (ins.op) {
          case 0x10:
            this.push(this.codeBase + pc, T_INT)
            break
          case 0x20:
            this.push(this.codeBase + pc, T_FLOAT)
            break
          case 0x04:
            this.push(this.codeBase + pc, T_LABEL)
            break
          case 0x30: {
            const k = this.popInt()
            this.push(this.strBase + ((ins.arg + k) | 0), T_STR)
            break
          }
          case 0x02: {
            const k = this.popInt()
            this.push(this.globalsBase + (ins.arg & 0xffff) + k, (ins.arg & 0xff0000) === 0x210000 ? T_FLOAT : T_INT)
            break
          }
          case 0x01:
            r = this.call(ins.arg)
            break
        }
        if (r === -1) {
          this.kill()
          return
        }
        let yieldNow = false
        if (r === 0 || r === 1) {
          if (this.depth[t] >= 0) this.pcStack[t * CALL_DEPTH + this.depth[t]]++
          yieldNow = r === 1
        } else if (r === 2) yieldNow = true
        if (yieldNow || this.depth[t] < 0) break
        if (this.pc(t) >= instrs.length) {
          this.state = 0
          return
        }
        if (this.state !== 1) break
      }
    }
    this.curThread = 0
  }

  private kill() {
    this.state = 0
    this.depth.fill(-1)
    this.sp = 0
  }

  private pc(t: number) {
    return this.pcStack[t * CALL_DEPTH + this.depth[t]]
  }
  private setPc(v: number) {
    const t = this.curThread
    this.pcStack[t * CALL_DEPTH + this.depth[t]] = v
  }

  // ---- stack helpers (scrPush*/scrPop*) ----

  push(ref: number, tag: number) {
    if (this.sp >= STACK) throw new ScriptError('stack overflow')
    this.stackRef[this.sp] = ref
    this.stackTag[this.sp] = tag
    this.sp++
  }
  pop(): StackRef {
    if (this.sp <= 0) throw new ScriptError('stack underflow')
    this.sp--
    return { ref: this.stackRef[this.sp], tag: this.stackTag[this.sp] }
  }
  private popTag(tag: number): number {
    const e = this.pop()
    if (e.tag !== tag) throw new ScriptError(`expected ${tagName(tag)}, got ${tagName(e.tag)}`)
    return e.ref
  }
  popIntRef = () => this.popTag(T_INT)
  popInt = () => this.i32[this.popTag(T_INT)]
  popFloat = () => this.f32[this.popTag(T_FLOAT)]
  popLabel = () => this.i32[this.popTag(T_LABEL)]
  popString = () => this.cas.strings[this.popTag(T_STR) - this.strBase] ?? ''
  /** Int or float argument as a JS number (the effect library converts by tag). */
  popNum(): number {
    const e = this.pop()
    if (e.tag === T_INT) return this.i32[e.ref]
    if (e.tag === T_FLOAT) return this.f32[e.ref]
    throw new ScriptError(`expected a number, got ${tagName(e.tag)}`)
  }
  /** Out-parameter: stores by the reference's tag. */
  store(e: StackRef, v: number) {
    if (e.tag === T_FLOAT) this.f32[e.ref] = v
    else this.i32[e.ref] = Math.trunc(v)
  }
  pushInt(v: number) {
    this.i32[this.ringBase + this.ringIdx] = v | 0
    this.push(this.ringBase + this.ringIdx, T_INT)
    this.ringIdx = (this.ringIdx + 1) & (RING - 1)
  }
  pushFloat(v: number) {
    this.f32[this.ringBase + this.ringIdx] = v
    this.push(this.ringBase + this.ringIdx, T_FLOAT)
    this.ringIdx = (this.ringIdx + 1) & (RING - 1)
  }
  private val(e: StackRef) {
    return e.tag === T_INT ? this.i32[e.ref] : this.f32[e.ref]
  }

  // ---- built-ins ----

  private call(id: number): number {
    const t = this.curThread
    if (id >= 0x0a && id <= 0x0d) {
      const b = this.pop()
      const a = this.pop()
      this.numTags(a, b)
      if (a.tag === T_INT && b.tag === T_INT) {
        const x = this.i32[a.ref]
        const y = this.i32[b.ref]
        this.pushInt(id === 0x0a ? x + y : id === 0x0b ? x - y : id === 0x0c ? Math.imul(x, y) : y === 0 ? (x < 0 ? 1 : -1) : (x / y) | 0)
      } else {
        const x = this.val(a)
        const y = this.val(b)
        this.pushFloat(id === 0x0a ? x + y : id === 0x0b ? x - y : id === 0x0c ? x * y : x / y)
      }
      return 0
    }
    if (id >= 0x0e && id <= 0x11) {
      const y = this.popInt()
      const x = this.popInt()
      this.pushInt(id === 0x0e ? (y === 0 ? x : x % y) : id === 0x0f ? x & y : id === 0x10 ? x | y : x ^ y)
      return 0
    }
    if (id >= 0x12 && id <= 0x19) {
      const b = this.pop()
      const a = this.pop()
      this.numTags(a, b)
      const x = this.val(a)
      const y = this.val(b)
      const r = [x !== 0 || y !== 0, x !== 0 && y !== 0, x === y, x !== y, x < y, x > y, x <= y, x >= y][id - 0x12]
      this.pushInt(r ? 1 : 0)
      return 0
    }
    if (id >= 0x1e && id <= 0x23) {
      const v = this.pop()
      const d = this.pop()
      this.numTags(v, d)
      const op = id - 0x1e
      if (d.tag === T_INT) {
        const s = v.tag === T_INT ? this.i32[v.ref] : Math.trunc(this.f32[v.ref]) | 0
        const cur = this.i32[d.ref]
        const r = [s, cur + s, cur - s, Math.imul(cur, s), s === 0 ? 0 : (cur / s) | 0, s === 0 ? cur : cur % s][op] | 0
        this.i32[d.ref] = r
        if (v.tag === T_INT) this.pushInt(r)
        else this.pushFloat(r)
      } else {
        const s = this.val(v)
        const cur = this.f32[d.ref]
        this.f32[d.ref] = [s, cur + s, cur - s, cur * s, cur / s, cur % s][op]
        this.pushFloat(this.f32[d.ref])
      }
      return 0
    }
    switch (id) {
      case 0x1a: {
        const a = this.pop()
        this.numTags(a, a)
        if (a.tag === T_INT) this.pushInt(-this.i32[a.ref])
        else this.pushFloat(-this.f32[a.ref])
        return 0
      }
      case 0x1b:
        this.pushInt(this.popInt() === 0 ? 1 : 0)
        return 0
      case 0x46:
        this.setPc(this.popLabel() - 1)
        return 0
      case 0x47:
      case 0x48: {
        const l = this.popLabel()
        const c = this.popInt()
        if ((id === 0x48) === (c === 0)) this.setPc(l - 1)
        return 0
      }
      case 0x49: {
        const l = this.popLabel()
        this.gosub(l)
        return 0
      }
      case 0x4c: {
        const v = this.popInt()
        this.depth[t]--
        if (this.depth[t] === -2) return -1
        this.pushInt(v)
        if (this.depth[t] === -1) this.sp = 0
        return 0
      }
      case 0x5f:
        this.push(this.locIntBase + t * LOCALS + this.popInt(), T_INT)
        return 0
      case 0x60:
        this.push(this.locFltBase + t * LOCALS + this.popInt(), T_FLOAT)
        return 0
      case 0x64:
        this.pop()
        this.sp = 0
        this.pushInt(0)
        return 1
      case 0x65:
        this.pop()
        return 0
      case 0x66:
        this.log.push(`frame ${this.frame}: exit`)
        return -1
      case 0x6d: {
        this.args = []
        for (;;) {
          const e = this.pop()
          if (e.tag === T_LABEL) {
            this.gosub(this.i32[e.ref])
            return 0
          }
          this.args.push(e.ref)
        }
      }
      case 0x75:
        this.pushInt(this.args.length)
        return 0
      case 0x76:
      case 0x77: {
        const k = this.popInt()
        const ref = this.args[this.args.length - 1 - k]
        if (ref === undefined) throw new ScriptError(`argument ${k} missing`)
        this.push(ref, id === 0x76 ? T_INT : T_FLOAT)
        return 0
      }
      case 0x6e: {
        const l = this.popLabel()
        const n = this.popInt()
        this.entry[n & 15] = l
        this.entryEnabled[n & 15] = 1
        this.pushInt(0)
        return 0
      }
      case 0x70: {
        const l = this.popLabel()
        const th = this.popInt()
        if (th < 0 || th >= THREADS) throw new ScriptError(`bad thread ${th}`)
        if (this.depth[th] >= 0) throw new ScriptError(`thread ${th} already running`)
        this.depth[th] = 0
        this.pcStack[th * CALL_DEPTH] = l
        this.pushInt(0)
        return 0
      }
      case 0x71: {
        let th = this.popInt()
        if (th < 0) th = t
        if (th < THREADS) this.depth[th] = -1
        this.pushInt(th)
        return 0
      }
      case 0x72: {
        const th = this.popInt()
        this.pushInt(th < 0 ? this.depth.reduce((n, d) => n + (d !== -1 ? 1 : 0), 0) : this.depth[th] !== -1 ? 1 : 0)
        return 0
      }
      case 0x80:
        this.log.push(`frame ${this.frame}: print ${this.popNum()}`)
        this.pushInt(0)
        return 0
      case 0x82:
        this.log.push(`frame ${this.frame}: print "${this.popString()}"`)
        this.pushInt(0)
        return 0
      case 0x8c:
        this.pushInt(Math.trunc(this.popFloat()))
        return 0
      case 0x8d:
        this.pushFloat(this.popInt())
        return 0
      case 0x8e: {
        const n = this.popInt()
        const s = rand16()
        this.pushInt(n === 0 ? 0 : (((s + 1) / 11) | 0) % n)
        return 0
      }
      case 0xc8:
        this.pushFloat(Math.sin(this.popFloat()))
        return 0
      case 0xc9:
        this.pushFloat(Math.cos(this.popFloat()))
        return 0
      case 0xca:
        this.pushFloat(Math.tan(this.popFloat()))
        return 0
      case 0xcd:
        this.pushFloat(Math.atan(this.popFloat()))
        return 0
      case 0xd0:
        this.pushFloat(this.popFloat() * 0.017453292519943295)
        return 0
      case 0xd1:
        this.pushFloat(this.popFloat() / 0.017453292519943295)
        return 0
      case 0xde: {
        const v = this.popInt()
        this.pushInt(Math.max(v, -v))
        return 0
      }
      case 0xe3:
        this.pushFloat(Math.abs(this.popFloat()))
        return 0
      case 0xe6:
        this.pushFloat(Math.sqrt(this.popFloat()))
        return 0
      case 0xed: {
        const z2 = this.popInt(), y2 = this.popInt(), x2 = this.popInt()
        const z1 = this.popInt(), y1 = this.popInt(), x1 = this.popInt()
        const sq = (Math.imul(x2 - x1, x2 - x1) + Math.imul(y2 - y1, y2 - y1) + Math.imul(z2 - z1, z2 - z1)) | 0
        this.pushInt(Math.trunc(Math.sqrt(Math.fround(sq))))
        return 0
      }
    }
    const r = this.host(id, this)
    if (r === undefined) throw new ScriptError(`unsupported function ${casFuncName(id)} (0x${id.toString(16)})`)
    return r
  }

  private gosub(l: number) {
    const t = this.curThread
    if (this.depth[t] + 1 >= CALL_DEPTH) throw new ScriptError('call stack overflow')
    this.depth[t]++
    this.setPc(l - 1)
  }

  private numTags(a: StackRef, b: StackRef) {
    for (const e of [a, b]) if (e.tag !== T_INT && e.tag !== T_FLOAT) throw new ScriptError(`expected a number, got ${tagName(e.tag)}`)
  }

  /** Thread states for the UI. */
  threads(): { thread: number; pc: number; depth: number }[] {
    const out = []
    for (let t = 0; t < THREADS; t++) if (this.depth[t] >= 0) out.push({ thread: t, pc: this.pc(t), depth: this.depth[t] })
    return out
  }
}

function tagName(t: number) {
  return { [T_INT]: 'int', [T_FLOAT]: 'float', [T_STR]: 'string', [T_LABEL]: 'label' }[t] ?? `tag ${t}`
}

// rand(n) draws from gameRandNext (0x0887B544), the same generator the map uses (src/effect/gameRand.ts).
function rand16(): number {
  return gameRng.next()
}
