/**
 * PARAM.SFO — the PSP's game metadata (title, disc id, version, parental level…).
 *
 *   0x00 "\0PSF", 0x04 u32 version, 0x08 u32 key table offset, 0x0C u32 data table offset,
 *   0x10 u32 entry count, then 16-byte entries:
 *   u16 key offset, u16 format (0x0004 raw utf8, 0x0204 utf8 NUL-terminated, 0x0404 u32),
 *   u32 used length, u32 max length, u32 data offset.
 */
export interface SfoEntry {
  key: string
  value: string | number
}

export const isSfo = (b: Uint8Array) => b.length >= 0x14 && b[0] === 0 && b[1] === 0x50 && b[2] === 0x53 && b[3] === 0x46

export function parseSfo(b: Uint8Array): SfoEntry[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const keys = dv.getUint32(8, true)
  const data = dv.getUint32(12, true)
  const count = dv.getUint32(16, true)
  const utf8 = new TextDecoder()
  const cstr = (o: number, max: number) => {
    const s = b.subarray(o, o + max)
    const end = s.indexOf(0)
    return utf8.decode(end < 0 ? s : s.subarray(0, end))
  }
  const out: SfoEntry[] = []
  for (let i = 0; i < count; i++) {
    const e = 0x14 + i * 16
    const key = cstr(keys + dv.getUint16(e, true), 64)
    const fmt = dv.getUint16(e + 2, true)
    const len = dv.getUint32(e + 4, true)
    const off = data + dv.getUint32(e + 12, true)
    out.push({ key, value: fmt === 0x0404 ? dv.getUint32(off, true) : cstr(off, len) })
  }
  return out
}
