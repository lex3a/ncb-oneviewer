/**
 * CADATA.SAV after decryption (docs/formats/save-menus.md): game data (0x494 bytes: PlayerProfile,
 * PlayerDeck[3], SaveHeader) or the continue snapshot (0x287CC bytes, header first). The savedata
 * utility encrypts the file on the Memory Stick with the game key; the game adds no checksum.
 */

export const GAME_DATA_SIZE = 0x494
export const CONTINUE_SIZE = 0x287cc

export interface SaveDeck {
  name: string
  dominator: number
  cards: number[]
}

export interface SaveProfile {
  name: string
  /** Owned copies per card index 1..206 (index 0 unused). */
  cardCount: number[]
  newFlags: number[]
  totalCards: number
  cardKinds: number
  stageClearMask: number
  mapBattles: number[]
  mapWins: number[]
  charaBattles: number[]
  charaWins: number[]
  curDeckSlot: number
}

export interface SaveFile {
  kind: 'game' | 'continue'
  profile: SaveProfile
  decks: SaveDeck[]
  header: { playerName: string; deckNames: string[]; playTime: number; clearMask: number; totalCards: number; cardKinds: number }
  /** Continue saves: stage and turn of the suspended battle. */
  battle?: { area: number; variant: number; stage: number; mode: number; round: number; turnPlayer: number }
  warnings: string[]
}

export function saveKind(b: Uint8Array): 'game' | 'continue' | null {
  return b.length === GAME_DATA_SIZE ? 'game' : b.length === CONTINUE_SIZE ? 'continue' : null
}

export function parseSave(b: Uint8Array): SaveFile {
  const kind = saveKind(b)
  if (!kind) throw new Error(`Not a decrypted CADATA.SAV (size ${b.length}; expected ${GAME_DATA_SIZE} or ${CONTINUE_SIZE}). Files straight from the Memory Stick are encrypted.`)
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const td = new TextDecoder('shift_jis')
  const str = (o: number, n: number) => {
    const s = b.subarray(o, o + n)
    const end = s.indexOf(0)
    return td.decode(end < 0 ? s : s.subarray(0, end)).normalize('NFKC').trim()
  }
  const u32s = (o: number, n: number) => Array.from({ length: n }, (_, i) => dv.getUint32(o + i * 4, true))

  const profileAt = kind === 'game' ? 0 : 0x78
  const decksAt = kind === 'game' ? 0x2fc : 0xc68
  const headerAt = kind === 'game' ? 0x41c : 0

  const p = profileAt
  const profile: SaveProfile = {
    name: str(p, 24),
    cardCount: Array.from(b.subarray(p + 0x1c, p + 0x1c + 207)),
    newFlags: Array.from(b.subarray(p + 0xeb, p + 0xeb + 207)),
    totalCards: dv.getUint32(p + 0x1bc, true),
    cardKinds: dv.getUint32(p + 0x1c0, true),
    stageClearMask: dv.getUint32(p + 0x1c4, true),
    mapBattles: u32s(p + 0x1c8, 19),
    mapWins: u32s(p + 0x214, 19),
    charaBattles: u32s(p + 0x260, 19),
    charaWins: u32s(p + 0x2ac, 19),
    curDeckSlot: b[p + 0x2f8],
  }
  const decks: SaveDeck[] = []
  for (let d = 0; d < 3; d++) {
    const o = decksAt + d * 0x60
    const ids = Array.from({ length: 31 }, (_, i) => dv.getInt16(o + 0x18 + i * 2, true))
    decks.push({ name: str(o, 24), dominator: ids[0], cards: ids.slice(1) })
  }
  const h = headerAt
  const header = {
    playerName: str(h, 24),
    deckNames: [0, 1, 2].map((i) => str(h + 0x18 + i * 24, 24)),
    playTime: dv.getUint32(h + 0x64, true),
    clearMask: dv.getUint32(h + 0x68, true),
    totalCards: dv.getUint32(h + 0x70, true),
    cardKinds: dv.getUint16(h + 0x74, true),
  }
  const warnings: string[] = []
  if (profile.cardCount[0] !== 0 || profile.cardCount.some((c) => c > 10)) warnings.push('card counts out of range (0..10)')
  if (profile.curDeckSlot < 1 || profile.curDeckSlot > 3) warnings.push(`deck slot ${profile.curDeckSlot} is not 1..3`)
  if (header.playerName !== profile.name) warnings.push('header name differs from the profile name')
  let battle: SaveFile['battle']
  if (kind === 'continue') {
    battle = {
      area: b[0x286c8],
      variant: b[0x286c9],
      stage: b[0x286ca],
      mode: b[0x286cb],
      round: dv.getUint32(0x286d4, true),
      turnPlayer: dv.getUint32(0x286d8, true),
    }
  }
  return { kind, profile, decks, header, battle, warnings }
}
