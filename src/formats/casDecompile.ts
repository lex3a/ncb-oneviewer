import type { Cas } from './cas'
import { CAS_FUNCS, casFuncName } from './casNames'

/**
 * Turns CAS1 stack code back into C-like statements. The VM pushes operands and `call` pops them
 * (last argument first), and `call pop` (0x65) ends every expression statement, so a simple
 * symbolic stack is enough. Calls with unknown arity take the whole remaining stack; those are
 * marked with "/*?*\/".
 */
export interface CasLine {
  /** Index of the first instruction of the statement. */
  index: number
  line: number
  text: string
  label?: boolean
}

interface Expr {
  text: string
  /** Set for plain integer literals, so subscripts of 0 can be hidden. */
  int?: number
}

const BINARY = new Set([0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19])
const ASSIGN = new Set([0x1e, 0x1f, 0x20, 0x21, 0x22, 0x23])

function arity(id: number): number | null {
  const f = CAS_FUNCS[id]
  if (!f) return null
  if (!f.args) return 0
  const m = /^(\d+) ×/.exec(f.args)
  if (m) return +m[1]
  return f.args.split(',').length
}

export function decompileCas(cas: Cas): CasLine[] {
  const labelAt = new Map<number, number>()
  for (const i of cas.instrs) if (i.op === 0x60) labelAt.set(i.index, i.arg)
  const labelName = (target: number) => (labelAt.has(target) ? `L${labelAt.get(target)}` : `@${target}`)

  const out: CasLine[] = []
  let stack: Expr[] = []
  let start = 0
  const pop = (): Expr => stack.pop() ?? { text: '?' }
  const popN = (n: number) => stack.splice(Math.max(0, stack.length - n), n)
  const sub = (k: Expr) => (k.int === 0 ? '' : `[${k.text}]`)
  const emit = (index: number, text: string, label = false) =>
    out.push({ index, line: cas.instrs[index]?.line ?? 0, text, label })

  for (const ins of cas.instrs) {
    if (stack.length === 0) start = ins.index
    switch (ins.op) {
      case 0x10:
        stack.push({ text: String(ins.arg | 0), int: ins.arg | 0 })
        break
      case 0x20:
        stack.push({ text: `${+ins.argFloat.toPrecision(7)}f` })
        break
      case 0x30: {
        const k = pop()
        const s = k.int !== undefined ? cas.strings[ins.arg + k.int] : undefined
        stack.push({ text: s !== undefined ? JSON.stringify(s) : `str[${ins.arg} + ${k.text}]` })
        break
      }
      case 0x02: {
        const k = pop()
        const kind = ins.arg >>> 16 === 0x21 ? 'gf' : 'g'
        stack.push({ text: `${kind}${ins.arg & 0xffff}${sub(k)}` })
        break
      }
      case 0x04:
        stack.push({ text: labelName(ins.arg) })
        break
      case 0x60:
        emit(ins.index, `L${ins.arg}:`, true)
        break
      case 0x01: {
        const id = ins.arg
        if (BINARY.has(id)) {
          const b = pop()
          const a = pop()
          stack.push({ text: `(${a.text} ${casFuncName(id)} ${b.text})` })
        } else if (ASSIGN.has(id)) {
          const b = pop()
          const a = pop()
          stack.push({ text: `${a.text} ${casFuncName(id)} ${b.text}` })
        } else if (id === 0x1a || id === 0x1b) {
          stack.push({ text: `${id === 0x1a ? '-' : '!'}${pop().text}` })
        } else if (id === 0x65) {
          const e = stack.pop()
          if (e) emit(start, `${e.text};`)
          stack = []
        } else if (id === 0x5f || id === 0x60) {
          stack.push({ text: `${id === 0x5f ? 'li' : 'lf'}[${pop().text}]` })
        } else if (id === 0x76 || id === 0x77 || id === 0x79) {
          stack.push({ text: `arg${['i', 'f', '', 's'][id - 0x76]}[${pop().text}]` })
        } else if (id === 0x6d) {
          // call_func(label, args…): arguments sit above the label on the stack.
          let at = stack.length - 1
          while (at >= 0 && !/^[L@]\d+$/.test(stack[at].text)) at--
          const [target, ...args] = stack.splice(Math.max(0, at))
          stack.push({ text: `${target?.text ?? '?'}(${args.map((a) => a.text).join(', ')})` })
        } else if (id >= 0x46 && id <= 0x4b) {
          // Jumps are not followed by a pop: emit them as statements right away.
          const args = popN(arity(id) ?? 1)
          emit(start, `${casFuncName(id)}(${args.map((a) => a.text).join(', ')});`)
        } else if (id === 0x64) {
          stack = [{ text: 'wait_frame()' }]
        } else {
          const n = arity(id)
          const args = n === null ? stack.splice(0) : popN(n)
          stack.push({ text: `${casFuncName(id)}(${args.map((a) => a.text).join(', ')})${n === null ? '/*?*/' : ''}` })
        }
        break
      }
      default:
        break
    }
  }
  for (const e of stack) emit(start, `${e.text}; /* left on stack */`)
  return out
}
