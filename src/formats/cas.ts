/**
 * CAS1 — compiled effect script (effect.one). Mirrors the game's loader scrSetBuffer (FUN_0889cba4)
 * and interpreter (FUN_0889ce10). See docs/formats/cas1.md.
 *
 *   0x00 char[4] "CAS1"
 *   0x04 u32     total size
 *   0x08 u32     instruction count N
 *   0x0C u16     string count C
 *   0x10 u16     source file count F
 *   0x12 u16     global slot count G
 *   0x18         N × instruction: u8 op, u8 file, u16 line, u32 arg
 *                C × string: u16 len, u16 pad, char[len]
 *                G × u32 globals (initial values, modified in place at runtime)
 *                F × char[256] source file paths (debug info)
 */
export interface CasInstr {
  index: number
  op: number
  file: number
  line: number
  arg: number
  argFloat: number
}

export interface Cas {
  size: number
  files: string[]
  strings: string[]
  globals: Uint8Array
  globalsOffset: number
  instrs: CasInstr[]
}

export const CODE_BASE = 0x18

/** Opcode mnemonics (FUN_0889ce10). */
export const CAS_OPS: Record<number, string> = {
  0x01: 'call',
  0x02: 'gvar',
  0x04: 'addr',
  0x10: 'int',
  0x20: 'float',
  0x30: 'str',
  0x60: 'label',
}

export function isCas(b: Uint8Array): boolean {
  return b.length >= 0x18 && b[0] === 0x43 && b[1] === 0x41 && b[2] === 0x53 && b[3] === 0x31
}

export function parseCas(bytes: Uint8Array): Cas {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const size = Math.min(dv.getUint32(4, true) || bytes.length, bytes.length)
  const count = dv.getUint32(8, true)
  const stringCount = dv.getUint16(0x0c, true)
  const fileCount = dv.getUint16(0x10, true)
  const globalCount = dv.getUint16(0x12, true)
  const dec = new TextDecoder('latin1')
  const cstr = (b: Uint8Array) => {
    const end = b.indexOf(0)
    return dec.decode(end < 0 ? b : b.subarray(0, end))
  }

  const instrs: CasInstr[] = []
  let o = CODE_BASE
  for (let i = 0; i < count && o + 8 <= size; i++, o += 8) {
    instrs.push({
      index: i,
      op: bytes[o],
      file: bytes[o + 1],
      line: dv.getUint16(o + 2, true),
      arg: dv.getUint32(o + 4, true),
      argFloat: dv.getFloat32(o + 4, true),
    })
  }

  const strings: string[] = []
  for (let i = 0; i < stringCount && o + 4 <= size; i++) {
    const len = dv.getUint16(o, true)
    strings.push(cstr(bytes.subarray(o + 4, o + 4 + len)))
    o += 4 + len
  }

  const globalsOffset = o
  const globals = bytes.subarray(o, Math.min(size, o + globalCount * 4))
  o += globalCount * 4

  const files: string[] = []
  for (let i = 0; i < fileCount && o + 256 <= size; i++, o += 256) files.push(cstr(bytes.subarray(o, o + 256)))

  return { size, files, strings, globals, globalsOffset, instrs }
}
