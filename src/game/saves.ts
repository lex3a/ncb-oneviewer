/**
 * The save layer of Play mode: what the PSP savedata utility stores on the Memory Stick, kept in
 * localStorage instead, with the same data layout as a decrypted CADATA.SAV and no encryption.
 *
 * Directories as the game names them (SetData_ListSave / SetData_ListLoad / SetData_Save):
 * - game data: gameName "ULUS10382" + saveNameList sprintf("%02d", 0..2) = ULUS1038200 … ULUS1038202,
 *   file CADATA.SAV, 0x494 bytes (saveSerializeGameData);
 * - continue data: gameName "ULUS10382" + saveName "" = ULUS10382, CADATA.SAV, 0x287CC bytes
 *   (saveSerializeContinue), deleted after a resume (AUTODELETE).
 *
 * localStorage keys: `ncb.save.<dir>` = the file bytes in base64, `ncb.save.<dir>.sfo` = the PARAM.SFO
 * strings the game sets (title, savedataTitle, detail) plus the time of the save, for the list dialog.
 * Export / import use the raw bytes, so a file opens in the viewer's save view and a decrypted real
 * save can be imported.
 */
import { CONTINUE_SIZE } from './continueSave'
import { decodeName, GAME_DATA_SIZE } from './profile'

export const GAME_NAME = 'ULUS10382'
/** saveNameList: sprintf("%02d", i) for i = 0..2. */
export const GAME_SLOTS = 3
export const slotDir = (i: number) => `${GAME_NAME}${String(i).padStart(2, '0')}`
export const CONTINUE_DIR = GAME_NAME
export const SAVE_FILE = 'CADATA.SAV'
const PREFIX = 'ncb.save.'

/** The PARAM.SFO strings of a save (SetData_Paramsfo_String, SetData_GameData / saveSetSfoDetail). */
export interface SaveSfo {
  /** "Neverland Card Battles" (saveGetGameTitle). */
  title: string
  /** Game data: "Data of <name>"; continue data keeps the utility's current savedataTitle. */
  savedataTitle: string
  /** Game data: "Cards: n（k types）" and the three deck lines (full-width spaces); continue: "Temporary Data". */
  detail: string
  /** When it was written (the PSP list shows the file date). */
  saved: string
}

export interface SaveEntry {
  dir: string
  bytes: Uint8Array
  sfo: SaveSfo | null
}

/** Memory fallback when localStorage is blocked (private mode, sandboxed frame). */
const memory = new Map<string, string>()

function getItem(k: string): string | null {
  try {
    return localStorage.getItem(k)
  } catch {
    return memory.get(k) ?? null
  }
}

function removeItem(k: string) {
  try {
    localStorage.removeItem(k)
  } catch {
    // blocked
  }
  memory.delete(k)
}

export function toBase64(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
  return btoa(s)
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s)
  const b = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i)
  return b
}

export function readSave(dir: string): SaveEntry | null {
  const v = getItem(PREFIX + dir)
  if (!v) return null
  let bytes: Uint8Array
  try {
    bytes = fromBase64(v)
  } catch {
    return null
  }
  let sfo: SaveSfo | null = null
  try {
    const j = getItem(PREFIX + dir + '.sfo')
    if (j) sfo = JSON.parse(j) as SaveSfo
  } catch {
    sfo = null
  }
  return { dir, bytes, sfo }
}

/** Writes a save (throws when the storage is full, like the utility's "no space" result). */
export function writeSave(dir: string, bytes: Uint8Array, sfo: SaveSfo) {
  const data = toBase64(bytes)
  try {
    localStorage.setItem(PREFIX + dir, data)
    localStorage.setItem(PREFIX + dir + '.sfo', JSON.stringify(sfo))
  } catch (e) {
    if (e instanceof DOMException && e.name === 'QuotaExceededError') throw e
    memory.set(PREFIX + dir, data)
    memory.set(PREFIX + dir + '.sfo', JSON.stringify(sfo))
  }
}

export function deleteSave(dir: string) {
  removeItem(PREFIX + dir)
  removeItem(PREFIX + dir + '.sfo')
}

/** The three game-data slots in list order (null = "No Data"). */
export function listGameSaves(): (SaveEntry | null)[] {
  return Array.from({ length: GAME_SLOTS }, (_, i) => {
    const e = readSave(slotDir(i))
    return e && e.bytes.length === GAME_DATA_SIZE ? e : null
  })
}

/** Whether a save exists (no decoding: cheap enough for a menu drawn every frame). */
export function hasSave(dir: string): boolean {
  return getItem(PREFIX + dir) !== null
}

export function readContinue(): SaveEntry | null {
  const e = readSave(CONTINUE_DIR)
  return e && e.bytes.length === CONTINUE_SIZE ? e : null
}

/** saveGetGameTitle / the SFO title. */
export const SFO_TITLE = 'Neverland Card Battles'
/** g_saveDetailTexts[3]: the continue save's detail. */
export const CONTINUE_DETAIL = 'Temporary Data'
/** saveGetSaveDataTitle: the default savedataTitle (saveParamInit), kept by the continue save. */
export const DEFAULT_SAVEDATA_TITLE = 'NCB GAME DATA'

/**
 * SetData_GameData(0): savedataTitle sprintf("Data of %s", header name) and the detail from the
 * serialized buffer: profile totalCards / cardKinds (+0x1BC / +0x1C0) and the 3 deck names (the
 * game builds it in Shift-JIS with full-width spaces, then converts it to UTF-8).
 */
export function gameDataSfo(b: Uint8Array): Omit<SaveSfo, 'saved'> {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const name = decodeName(b, 0x41c)
  const deck = (k: number) => decodeName(b, 0x2fc + k * 0x60)
  const detail = `Cards: ${dv.getUint32(0x1bc, true)}（${dv.getUint32(0x1c0, true)} types）\nDeck　　1.${deck(0)}\n　　　　　2.${deck(1)}\n　　　　　3.${deck(2)}`
  return { title: SFO_TITLE, savedataTitle: `Data of ${name}`, detail }
}

/** Kind of a raw CADATA.SAV by its size. */
export function saveFileKind(b: Uint8Array): 'game' | 'continue' | null {
  return b.length === GAME_DATA_SIZE ? 'game' : b.length === CONTINUE_SIZE ? 'continue' : null
}

/** Imports a decrypted CADATA.SAV into a directory (by size: game data into a slot, continue data into ULUS10382). */
export function importSave(bytes: Uint8Array, slot: number): string {
  const kind = saveFileKind(bytes)
  if (!kind) throw new Error(`Not a decrypted CADATA.SAV: ${bytes.length} bytes (0x494 game data or 0x287CC continue data expected; files from the Memory Stick are encrypted)`)
  const now = new Date().toISOString()
  if (kind === 'game') {
    const dir = slotDir(slot)
    writeSave(dir, bytes, { ...gameDataSfo(bytes), saved: now })
    return dir
  }
  writeSave(CONTINUE_DIR, bytes, { title: SFO_TITLE, savedataTitle: DEFAULT_SAVEDATA_TITLE, detail: CONTINUE_DETAIL, saved: now })
  return CONTINUE_DIR
}

/** A file name for an exported save: <dir>_CADATA.SAV (the viewer opens *.sav files as saves). */
export const exportName = (dir: string) => `${dir}_${SAVE_FILE}`
