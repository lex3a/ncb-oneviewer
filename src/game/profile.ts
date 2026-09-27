/**
 * The saved game state, typed 1:1 like its memory / CADATA.SAV layout (docs/formats/save-menus.md §1.3,
 * §1.4): PlayerProfile (0x2FC, g_playerProfile 0x089D184C), PlayerDeck[3] (g_playerDecks 0x089C9F68) and
 * SaveHeader (0x78, g_saveHeader 0x089D1E68). Also the database helpers the game uses on it
 * (cardIdToIndex, dbGetDeckByDominator) and profileInitNewGame (0x0882CE7C).
 *
 * The encoder / decoder of the 0x494-byte game data file (saveSerializeGameData /
 * saveDeserializeGameData) and the record codecs shared with the continue file (continueSave.ts).
 */
import type { GameDb } from '../formats/gamedb'

export const PROFILE_SIZE = 0x2fc
export const DECK_SIZE = 0x60
export const HEADER_SIZE = 0x78
export const GAME_DATA_SIZE = PROFILE_SIZE + 3 * DECK_SIZE + HEADER_SIZE // 0x494
/** Card indices 0..206 (0 unused): 1–122 units, 123–190 spells, 191–206 bases. */
export const CARD_SLOTS = 207
export const CARD_NOS = 206
/** Per-stage / per-opponent counters. */
export const COUNTER_SLOTS = 19
/** Dominator of every player deck: Galahad. */
export const PLAYER_DOMINATOR = 1001

/** PlayerProfile (0x2FC). Offsets in the comments. */
export interface PlayerProfile {
  /** +000 char[24], Shift-JIS. */
  name: string
  /** The 24 bytes read from a file (kept while they decode to `name`, so stale bytes after the NUL survive a round trip). */
  nameRaw?: Uint8Array
  /** +018 cleared at New Game; battle mode stores the chosen Dominator here (in its own copy). */
  unk18: number
  /** +01C owned copies per card index (max 10). */
  cardCount: Uint8Array
  /** +0EB per card index: bit 1 first copy ("NEW"), bit 0 a copy ("Get"). */
  cardNewFlags: Uint8Array
  /** +1BC Σ cardCount (recomputed by the camp status window). */
  totalCards: number
  /** +1C0 nonzero cardCount entries. */
  cardKinds: number
  /** +1C4 bit s−1 = story stage s won (stage 18 also sets bit 16). */
  stageClearMask: number
  /** +1C8 battles per stage (index s−1). */
  mapBattles: Uint32Array
  /** +214 wins per stage. */
  mapWins: Uint32Array
  /** +260 battles per opponent (charaGetLadderIndex). */
  charaBattles: Uint32Array
  /** +2AC wins per opponent. */
  charaWins: Uint32Array
  /** +2F8 selected deck 1..3 (0 right after New Game until the stage select picks one). */
  curDeckSlot: number
}

/** PlayerDeck (0x60). */
export interface PlayerDeck {
  /** +00 char[24]; "" = empty slot. */
  name: string
  nameRaw?: Uint8Array
  /** +56 u16 padding (copied by memcpy). */
  pad56?: number
  /** +18 s16[31]: [0] Dominator (1001), [1..30] card ids (0 = empty). */
  cards: Int16Array
  /** +58 / +5C: only cleared and copied. */
  unk58: number
  unk5C: number
}

/** SaveHeader (0x78): rebuilt at save time, only read for the save list text. */
export interface SaveHeader {
  playerName: string
  deckNames: [string, string, string]
  unk60: number
  /** Packed h:m:s:frames; never advanced in this build (so srand(0) on the title). */
  playTime: number
  clearMask: number
  unk6C: number
  totalCards: number
  cardKinds: number
  /** The 0x78 bytes read from a file (pads and bytes after the names; memcpy copies them). */
  raw?: Uint8Array
}

export interface SaveData {
  profile: PlayerProfile
  decks: [PlayerDeck, PlayerDeck, PlayerDeck]
  header: SaveHeader
}

export function emptyProfile(): PlayerProfile {
  return {
    name: '',
    unk18: 0,
    cardCount: new Uint8Array(CARD_SLOTS),
    cardNewFlags: new Uint8Array(CARD_SLOTS),
    totalCards: 0,
    cardKinds: 0,
    stageClearMask: 0,
    mapBattles: new Uint32Array(COUNTER_SLOTS),
    mapWins: new Uint32Array(COUNTER_SLOTS),
    charaBattles: new Uint32Array(COUNTER_SLOTS),
    charaWins: new Uint32Array(COUNTER_SLOTS),
    curDeckSlot: 0,
  }
}

export function emptyDeck(): PlayerDeck {
  return { name: '', cards: new Int16Array(31), unk58: 0, unk5C: 0 }
}

export function emptyHeader(): SaveHeader {
  return { playerName: '', deckNames: ['', '', ''], unk60: 0, playTime: 0, clearMask: 0, unk6C: 0, totalCards: 0, cardKinds: 0 }
}

// ---- database helpers ----

/** cardIdToIndex: the collection index of a card (0 for characters and unknown ids). */
export function cardIdToIndex(db: GameDb, id: number): number {
  const no = db.byId.get(id)?.no ?? 0
  return no >= 1 && no <= CARD_NOS ? no : 0
}

/** cardIndexToId. */
export function cardIndexToId(db: GameDb, index: number): number {
  for (const c of db.cards) if (c.no === index && c.type !== 'chara') return c.id
  return 0
}

/**
 * dbGetDeckByDominator(id, out, flags) (0x088282A8): scans g_deckDefs[31]; flags & 2 stops at the
 * first deck of that Dominator, otherwise the last one wins (the stage select passes 3 for a first
 * story fight, 1 for a replay; New Game passes 1 for Galahad's starter deck). Returns the 31 shorts
 * (Dominator + 30 cards). Without a match the game copies deck 0.
 */
export function dbGetDeckByDominator(db: GameDb, dominator: number, flags: number): number[] {
  const decks = [...db.decks].sort((a, b) => a.index - b.index)
  let hit = 0
  for (let i = 0; i < decks.length; i++) {
    if (decks[i].dominator === dominator) {
      hit = i
      if (flags & 2) break
    }
  }
  const d = decks[hit]
  const out = [d?.dominator ?? 0, ...(d?.cards ?? [])].slice(0, 31)
  while (out.length < 31) out.push(0)
  return out
}

/** dbGetDeckNameByDominator: the first deck of that Dominator (deck 0's name without a match). */
export function dbGetDeckNameByDominator(db: GameDb, dominator: number): string {
  const decks = [...db.decks].sort((a, b) => a.index - b.index)
  return (decks.find((d) => d.dominator === dominator) ?? decks[0])?.name ?? ''
}

/** totalCards / cardKinds as the camp status window recomputes them. */
export function recountCards(p: PlayerProfile) {
  let total = 0, kinds = 0
  for (let i = 1; i < CARD_SLOTS; i++) {
    total += p.cardCount[i]
    if (p.cardCount[i]) kinds++
  }
  p.totalCards = total
  p.cardKinds = kinds
}

/**
 * profileInitNewGame (0x0882CE7C): clears the profile, the three decks and the header; deck 1 =
 * Galahad's starter deck (name from dbGetDeckNameByDominator(1001), cards from
 * dbGetDeckByDominator(1001, …, 1)); cardCount = the copies in that deck. curDeckSlot stays 0. The
 * rest of the function (DuelPlayer controllers and hands, stage 1 / map 1 / mode 0, round and turn
 * 0) is session state: see GameState.newGame.
 */
export function profileInitNewGame(db: GameDb): SaveData {
  const profile = emptyProfile()
  const decks: [PlayerDeck, PlayerDeck, PlayerDeck] = [emptyDeck(), emptyDeck(), emptyDeck()]
  decks[0].name = dbGetDeckNameByDominator(db, PLAYER_DOMINATOR)
  decks[0].cards.set(dbGetDeckByDominator(db, PLAYER_DOMINATOR, 1))
  decks[0].cards[0] = PLAYER_DOMINATOR
  for (let i = 1; i < 31; i++) {
    const idx = cardIdToIndex(db, decks[0].cards[i])
    profile.cardCount[idx]++
  }
  // index 0 collects the empty slots / characters; the game's counter at index 0 is never read
  profile.cardCount[0] = 0
  return { profile, decks, header: emptyHeader() }
}

// ---- the 0x494-byte game data file ----

let sjisEncodeMap: Map<number, number> | null = null

/** Shift-JIS encoding of one character (0 when it has no code), built once from TextDecoder. */
function sjisCode(ch: number): number {
  if (ch < 0x80) return ch
  if (!sjisEncodeMap) {
    const m = new Map<number, number>()
    const td = new TextDecoder('shift_jis')
    for (let b = 0xa1; b <= 0xdf; b++) m.set(td.decode(new Uint8Array([b])).charCodeAt(0), b)
    for (let lead = 0x81; lead <= 0xfc; lead++) {
      if (lead > 0x9f && lead < 0xe0) continue
      for (let trail = 0x40; trail <= 0xfc; trail++) {
        if (trail === 0x7f) continue
        const s = td.decode(new Uint8Array([lead, trail]))
        if (s.length === 1 && s !== '�' && !m.has(s.charCodeAt(0))) m.set(s.charCodeAt(0), (lead << 8) | trail)
      }
    }
    sjisEncodeMap = m
  }
  return sjisEncodeMap.get(ch) ?? 0
}

/** A name as Shift-JIS bytes (characters without a code become "?"), at most `max` bytes. */
export function encodeSjis(s: string, max = 23): Uint8Array {
  const out: number[] = []
  for (const c of s) {
    const code = sjisCode(c.codePointAt(0) ?? 0x3f) || 0x3f
    const bytes = code > 0xff ? [code >> 8, code & 0xff] : [code]
    if (out.length + bytes.length > max) break
    out.push(...bytes)
  }
  return Uint8Array.from(out)
}

/** A NUL-terminated Shift-JIS char[n]. */
export function decodeName(b: Uint8Array, o: number, n = 24): string {
  const s = b.subarray(o, o + n)
  const end = s.indexOf(0)
  return new TextDecoder('shift_jis').decode(end < 0 ? s : s.subarray(0, end))
}

/**
 * The 24 bytes of a char[24] name field as the game copies it (memcpy / the 12-halfword loops): the
 * raw bytes read from a file when they still decode to the same string (stale bytes after the NUL
 * included), else the Shift-JIS text + NUL + zeros.
 */
export function nameBytes(name: string, raw?: Uint8Array): Uint8Array {
  if (raw && raw.length === 24 && decodeName(raw, 0) === name) return raw.slice()
  const out = new Uint8Array(24)
  out.set(encodeSjis(name))
  return out
}

/** sprintf(dst, name): the string and its NUL, the bytes after it stay as they were. */
function sprintfName(b: Uint8Array, o: number, name: string, raw?: Uint8Array) {
  const src = nameBytes(name, raw)
  const end = src.indexOf(0)
  const n = end < 0 ? 24 : end
  b.set(src.subarray(0, n), o)
  if (n < 24) b[o + n] = 0
}

/** Σ cardCount[0..206] and the number of nonzero entries (cardCountCollection: index 0 included). */
export function cardCountCollection(p: PlayerProfile): [number, number] {
  let total = 0, kinds = 0
  for (let i = 0; i < CARD_SLOTS; i++) {
    total += p.cardCount[i]
    if (p.cardCount[i]) kinds++
  }
  return [total, kinds & 0xffff]
}

/** PlayerProfile (0x2FC) field by field, as saveSerializeGameData / saveSerializeContinue copy it (the pads keep the buffer's bytes). */
export function writeProfile(b: Uint8Array, o: number, p: PlayerProfile) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  b.set(nameBytes(p.name, p.nameRaw), o)
  dv.setUint32(o + 0x18, p.unk18 >>> 0, true)
  b.set(p.cardCount.subarray(0, CARD_SLOTS), o + 0x1c)
  b.set(p.cardNewFlags.subarray(0, CARD_SLOTS), o + 0xeb)
  dv.setUint32(o + 0x1bc, p.totalCards >>> 0, true)
  dv.setUint32(o + 0x1c0, p.cardKinds >>> 0, true)
  dv.setUint32(o + 0x1c4, p.stageClearMask >>> 0, true)
  const arr = (off: number, a: Uint32Array) => a.forEach((v, i) => dv.setUint32(o + off + i * 4, v >>> 0, true))
  arr(0x1c8, p.mapBattles)
  arr(0x214, p.mapWins)
  arr(0x260, p.charaBattles)
  arr(0x2ac, p.charaWins)
  b[o + 0x2f8] = p.curDeckSlot
}

export function readProfile(b: Uint8Array, o: number): PlayerProfile {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const arr = (off: number) => Uint32Array.from({ length: COUNTER_SLOTS }, (_, i) => dv.getUint32(o + off + i * 4, true))
  return {
    name: decodeName(b, o),
    nameRaw: b.slice(o, o + 24),
    unk18: dv.getUint32(o + 0x18, true),
    cardCount: b.slice(o + 0x1c, o + 0x1c + CARD_SLOTS),
    cardNewFlags: b.slice(o + 0xeb, o + 0xeb + CARD_SLOTS),
    totalCards: dv.getUint32(o + 0x1bc, true),
    cardKinds: dv.getUint32(o + 0x1c0, true),
    stageClearMask: dv.getUint32(o + 0x1c4, true),
    mapBattles: arr(0x1c8),
    mapWins: arr(0x214),
    charaBattles: arr(0x260),
    charaWins: arr(0x2ac),
    curDeckSlot: b[o + 0x2f8],
  }
}

/** PlayerDeck (0x60) as memcpy copies it (the pad at +0x56 included). */
export function writeDeck(b: Uint8Array, o: number, d: PlayerDeck) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  b.set(nameBytes(d.name, d.nameRaw), o)
  d.cards.forEach((c, i) => dv.setInt16(o + 0x18 + i * 2, c, true))
  dv.setUint16(o + 0x56, d.pad56 ?? 0, true)
  dv.setUint32(o + 0x58, d.unk58 >>> 0, true)
  dv.setUint32(o + 0x5c, d.unk5C >>> 0, true)
}

export function readDeck(b: Uint8Array, o: number): PlayerDeck {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  return {
    name: decodeName(b, o),
    nameRaw: b.slice(o, o + 24),
    cards: Int16Array.from({ length: 31 }, (_, i) => dv.getInt16(o + 0x18 + i * 2, true)),
    pad56: dv.getUint16(o + 0x56, true),
    unk58: dv.getUint32(o + 0x58, true),
    unk5C: dv.getUint32(o + 0x5c, true),
  }
}

/** SaveHeader (0x78) field by field (saveSerializeContinue; the pads keep the buffer's bytes). */
export function writeHeaderFields(b: Uint8Array, o: number, h: SaveHeader) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  b.set(nameBytes(h.playerName, h.raw?.subarray(0, 24)), o)
  h.deckNames.forEach((n, i) => b.set(nameBytes(n, h.raw?.subarray(0x18 + i * 24, 0x30 + i * 24)), o + 0x18 + i * 24))
  dv.setUint32(o + 0x60, h.unk60 >>> 0, true)
  dv.setUint32(o + 0x64, h.playTime >>> 0, true)
  dv.setUint32(o + 0x68, h.clearMask >>> 0, true)
  b[o + 0x6c] = h.unk6C
  dv.setUint32(o + 0x70, h.totalCards >>> 0, true)
  dv.setUint16(o + 0x74, h.cardKinds, true)
}

export function readHeader(b: Uint8Array, o: number): SaveHeader {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  return {
    playerName: decodeName(b, o),
    deckNames: [decodeName(b, o + 0x18), decodeName(b, o + 0x30), decodeName(b, o + 0x48)],
    unk60: dv.getUint32(o + 0x60, true),
    playTime: dv.getUint32(o + 0x64, true),
    clearMask: dv.getUint32(o + 0x68, true),
    unk6C: b[o + 0x6c],
    totalCards: dv.getUint32(o + 0x70, true),
    cardKinds: dv.getUint16(o + 0x74, true),
    raw: b.slice(o, o + HEADER_SIZE),
  }
}

/**
 * saveSerializeGameData (0x0882D6B8): the profile field by field at 0, the 3 decks (memcpy) at 0x2FC,
 * and at 0x41C a copy of g_saveHeader (memcpy) in which sprintf rewrites the player name and the 3 deck
 * names (the bytes after each NUL stay), then clearMask = stageClearMask and totalCards / cardKinds
 * recounted over cardCount[0..206]. The profile's own totalCards / cardKinds are written as they are
 * (the camp status window recomputes them). `base` is g_saveGameDataBuf: the bytes nothing writes
 * (profile pads) keep its contents.
 */
export function serializeGameData(s: SaveData, base?: Uint8Array): Uint8Array {
  const b = base && base.length === GAME_DATA_SIZE ? base.slice() : new Uint8Array(GAME_DATA_SIZE)
  const dv = new DataView(b.buffer)
  writeProfile(b, 0, s.profile)
  s.decks.forEach((d, k) => writeDeck(b, PROFILE_SIZE + k * DECK_SIZE, d))
  const o = PROFILE_SIZE + 3 * DECK_SIZE
  // memcpy(dst, &g_saveHeader, 0x78)
  const h = s.header
  if (h.raw && h.raw.length === HEADER_SIZE) b.set(h.raw, o)
  else b.fill(0, o, o + HEADER_SIZE)
  writeHeaderFields(b, o, h)
  sprintfName(b, o, s.profile.name, s.profile.nameRaw)
  s.decks.forEach((d, i) => sprintfName(b, o + 0x18 + i * 24, d.name, d.nameRaw))
  dv.setUint32(o + 0x68, s.profile.stageClearMask >>> 0, true)
  const [total, kinds] = cardCountCollection(s.profile)
  dv.setUint32(o + 0x70, total, true)
  dv.setUint16(o + 0x74, kinds, true)
  return b
}

/** saveDeserializeGameData (0x0882D514): profile field by field, decks and header by memcpy. */
export function parseGameData(b: Uint8Array): SaveData {
  if (b.length !== GAME_DATA_SIZE) throw new Error(`game data must be 0x494 bytes (got 0x${b.length.toString(16)})`)
  return {
    profile: readProfile(b, 0),
    decks: [readDeck(b, PROFILE_SIZE), readDeck(b, PROFILE_SIZE + DECK_SIZE), readDeck(b, PROFILE_SIZE + 2 * DECK_SIZE)],
    header: readHeader(b, PROFILE_SIZE + 3 * DECK_SIZE),
  }
}
