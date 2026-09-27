import { isCas } from './cas'
import { isGan } from './gan'
import { isGbp } from './gbp'

/**
 * ONE archive (Neverland Card Battles, PSP).
 *
 *   0x0000 char[4] "ONE1"
 *   0x0004 array of { u16 id, u16 sizeInSectors } terminated by {0, 0}
 *   0xA000 entry data, back to back, each padded to 2048-byte sectors
 *
 * An entry is either a single file or a CLC2 container:
 *   char[4] "CLC2", u32 count, count × { u32 id, u32 offset, u32 size }
 */
export const SECTOR = 2048
export const DATA_START = 0xa000

export type FileKind = 'gbp' | 'gan' | 'cas' | 'clc2' | 'bin'

export interface OneFile {
  /** Stable key used by the UI. */
  key: string
  /** Human readable path inside the archive, e.g. "100/3". */
  path: string
  id: number
  subId: number | null
  offset: number
  kind: FileKind
  data: Uint8Array
}

export interface OneEntry {
  id: number
  offset: number
  sectors: number
  container: boolean
  files: OneFile[]
}

export interface OneArchive {
  name: string
  size: number
  entries: OneEntry[]
}

export function detectKind(b: Uint8Array): FileKind {
  if (isGbp(b)) return 'gbp'
  if (isGan(b)) return 'gan'
  if (isCas(b)) return 'cas'
  if (b.length >= 8 && b[0] === 0x43 && b[1] === 0x4c && b[2] === 0x43 && b[3] === 0x32) return 'clc2'
  return 'bin'
}

export const KIND_EXT: Record<FileKind, string> = { gbp: 'gbp', gan: 'gan', cas: 'cas', clc2: 'clc2', bin: 'bin' }

export function parseOne(name: string, buf: ArrayBuffer): OneArchive {
  const bytes = new Uint8Array(buf)
  const dv = new DataView(buf)
  const magic = String.fromCharCode(...bytes.subarray(0, 4))
  if (magic !== 'ONE1') throw new Error(`${name}: not a ONE archive (magic "${magic}")`)

  const entries: OneEntry[] = []
  let offset = DATA_START
  for (let t = 4; t + 4 <= DATA_START; t += 4) {
    const id = dv.getUint16(t, true)
    const sectors = dv.getUint16(t + 2, true)
    if (id === 0 && sectors === 0) break
    const data = bytes.subarray(offset, Math.min(offset + sectors * SECTOR, bytes.length))
    entries.push(parseEntry(id, offset, sectors, data))
    offset += sectors * SECTOR
  }
  return { name, size: bytes.length, entries }
}

function parseEntry(id: number, offset: number, sectors: number, data: Uint8Array): OneEntry {
  if (detectKind(data) === 'clc2') {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const count = dv.getUint32(4, true)
    const files: OneFile[] = []
    for (let k = 0; k < count && 8 + k * 12 + 12 <= data.length; k++) {
      const subId = dv.getUint32(8 + k * 12, true)
      const so = dv.getUint32(12 + k * 12, true)
      const ss = dv.getUint32(16 + k * 12, true)
      const sub = data.subarray(so, so + ss)
      files.push({
        key: `${id}/${subId}#${k}`,
        path: `${id}/${subId}`,
        id,
        subId,
        offset: offset + so,
        kind: detectKind(sub),
        data: sub,
      })
    }
    return { id, offset, sectors, container: true, files }
  }
  // Single file: trim sector padding using the size field most formats carry at +4/+8.
  const kind = detectKind(data)
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let len = data.length
  if (kind === 'gan' || kind === 'cas') len = Math.min(len, dv.getUint32(4, true) || len)
  else if (kind === 'gbp') len = Math.min(len, dv.getUint32(8, true) || len)
  return {
    id,
    offset,
    sectors,
    container: false,
    files: [{ key: `${id}`, path: `${id}`, id, subId: null, offset, kind, data: data.subarray(0, len) }],
  }
}
