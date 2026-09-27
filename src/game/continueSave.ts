/**
 * The continue ("Temp save") file, ULUS10382/CADATA.SAV decrypted: 0x287CC bytes written by
 * saveSerializeContinue (0x0882D900) and read by saveDeserializeContinue (0x0882E1F8). A snapshot of
 * a map battle in progress; see docs/formats/save-menus.md §1.5.
 *
 * Like the game, the serializer writes field by field into a buffer that lives for the whole run
 * (g_saveContinueBufPtr, here GameState.continueBuf, also the buffer a resume loads into): bytes it
 * does not write (pads, profile slots 1–3, the four unused globals) keep whatever the buffer held.
 * Fields the ports do not model (MapUnit posZ and colours, DuelPlayer +0xA4) are kept per object when
 * a file is loaded and default to what unitInitFromCard / profileInitNewGame write.
 */
import type { MapBoardScene } from '../effect/mapBoard'
import type { MapGame, Player, Unit } from '../effect/mapRules'
import { DECK_SIZE, encodeSjis, PROFILE_SIZE, readDeck, readHeader, readProfile, writeDeck, writeHeaderFields, writeProfile, type PlayerDeck, type PlayerProfile, type SaveHeader } from './profile'

export const CONTINUE_SIZE = 0x287cc

/** File offsets (save-menus.md §1.5). */
export const CO = {
  header: 0x00000,
  profiles: 0x00078,
  decks: 0x00c68,
  players: 0x00d88,
  units: 0x010a8,
  grid: 0x03b48,
  conquest: 0x05448,
  land: 0x060c8,
  auras: 0x06708,
  range: 0x27a48,
  seizeFx: 0x28088,
  scalars: 0x286c8,
} as const

const PLAYER_SIZE = 200
const UNIT_SIZE = 0x58

/** Unit fields the rules do not model, kept from a loaded file (unitInitFromCard: posZ 0, colours 0x80). */
export interface UnitSaveExtra {
  posZ: number
  color: [number, number, number, number]
}

/** Per-object extras live on the objects themselves (a WeakMap keyed by the Unit / Player). */
const unitExtra = new WeakMap<Unit, UnitSaveExtra>()
const playerA4 = new WeakMap<Player, number>()

/** The session globals of the file (g_mapId … g_localPlayer). */
export interface ContinueSession {
  mapId: number
  mapVariant: number
  stageNo: number
  gameMode: number
  numPlayers: number
  localPlayer: number
  layoutId: number
}

/** What saveDeserializeContinue restores besides the board: the header, profile slot 0, the decks and the session bytes. */
export interface ContinueData {
  header: SaveHeader
  profile: PlayerProfile
  decks: [PlayerDeck, PlayerDeck, PlayerDeck]
  session: ContinueSession
  /** duelSetPlayerName: versus takes the profile slot names, the other modes the Dominators' card names (the caller resolves them). */
  slotNames: [string, string]
  round: number
  turnPlayer: number
}

function dvOf(b: Uint8Array) {
  return new DataView(b.buffer, b.byteOffset, b.byteLength)
}

function writeUnit(b: Uint8Array, o: number, u: Unit) {
  const dv = dvOf(b)
  const x = unitExtra.get(u)
  dv.setInt32(o + 0x00, u.cardId, true)
  dv.setInt32(o + 0x04, u.slot, true)
  dv.setInt32(o + 0x08, u.player, true)
  b[o + 0x0c] = u.team & 0xff
  dv.setInt16(o + 0x0e, u.cellX, true)
  dv.setInt16(o + 0x10, u.cellY, true)
  dv.setInt32(o + 0x14, u.posX, true)
  dv.setInt32(o + 0x18, u.posY, true)
  dv.setInt32(o + 0x1c, x?.posZ ?? 0, true)
  b[o + 0x20] = u.actFlags & 0xff
  dv.setInt8(o + 0x21, ((u.maxHp << 24) >> 24))
  dv.setInt8(o + 0x22, ((u.hp << 24) >> 24))
  dv.setInt8(o + 0x23, ((u.baseAp << 24) >> 24))
  dv.setInt8(o + 0x24, ((u.dfBonus << 24) >> 24))
  b[o + 0x25] = u.attribute & 0xff
  for (let i = 0; i < 6; i++) dv.setUint16(o + 0x26 + i * 2, u.attachments[i] ?? 0, true)
  dv.setInt32(o + 0x34, u.effAp, true)
  dv.setInt32(o + 0x38, u.effDf, true)
  dv.setInt32(o + 0x3c, u.effRange, true)
  dv.setInt32(o + 0x40, u.effMove, true)
  dv.setInt32(o + 0x44, u.effAttr, true)
  dv.setUint16(o + 0x48, u.status & 0xffff, true)
  b[o + 0x4a] = u.facing & 0xff
  b[o + 0x4b] = u.scalePct & 0xff
  const c = x?.color ?? [0x80, 0x80, 0x80, 0x80]
  for (let i = 0; i < 4; i++) dv.setUint16(o + 0x4c + i * 2, c[i], true)
  dv.setInt32(o + 0x54, u.state, true)
}

function readUnit(b: Uint8Array, o: number, u: Unit) {
  const dv = dvOf(b)
  u.cardId = dv.getInt32(o, true)
  u.slot = dv.getInt32(o + 4, true)
  u.player = dv.getInt32(o + 8, true)
  u.team = b[o + 0x0c]
  u.cellX = dv.getInt16(o + 0x0e, true)
  u.cellY = dv.getInt16(o + 0x10, true)
  u.posX = dv.getInt32(o + 0x14, true)
  u.posY = dv.getInt32(o + 0x18, true)
  u.actFlags = b[o + 0x20]
  u.maxHp = dv.getInt8(o + 0x21)
  u.hp = dv.getInt8(o + 0x22)
  u.baseAp = dv.getInt8(o + 0x23)
  u.dfBonus = dv.getInt8(o + 0x24)
  u.attribute = b[o + 0x25]
  u.attachments = Array.from({ length: 6 }, (_, i) => dv.getUint16(o + 0x26 + i * 2, true))
  u.effAp = dv.getInt32(o + 0x34, true)
  u.effDf = dv.getInt32(o + 0x38, true)
  u.effRange = dv.getInt32(o + 0x3c, true)
  u.effMove = dv.getInt32(o + 0x40, true)
  u.effAttr = dv.getInt32(o + 0x44, true)
  u.status = dv.getUint16(o + 0x48, true)
  u.facing = b[o + 0x4a]
  u.scalePct = b[o + 0x4b]
  u.state = dv.getInt32(o + 0x54, true)
  unitExtra.set(u, { posZ: dv.getInt32(o + 0x1c, true), color: [0, 1, 2, 3].map((i) => dv.getUint16(o + 0x4c + i * 2, true)) as UnitSaveExtra['color'] })
}

/** saveSerializeContinue's DuelPlayer copy (the pads +0x01, +0x7E, +0xA7, +0xB9, +0xC5 are not written). */
function writePlayer(b: Uint8Array, o: number, p: Player, handCount: number) {
  const dv = dvOf(b)
  b[o] = p.index & 0xff
  for (let i = 0; i < 31; i++) dv.setInt16(o + 2 + i * 2, p.deck[i] ?? 0, true)
  for (let i = 0; i < 31; i++) b[o + 0x40 + i] = p.deckState[i] ?? 0
  for (let i = 0; i < 31; i++) b[o + 0x5f + i] = p.drawOrder[i] ?? 0
  for (let i = 0; i < 6; i++) dv.setInt32(o + 0x80 + i * 4, p.hand[i] ?? 0, true)
  let usable = 0
  for (let i = 0; i < 6; i++) usable |= ((p.usable[i] ?? 0) & 0xf) << (i * 4)
  dv.setUint32(o + 0x98, usable >>> 0, true)
  dv.setInt32(o + 0x9c, p.selected, true)
  dv.setInt32(o + 0xa0, p.cursor, true)
  b[o + 0xa4] = playerA4.get(p) ?? 0
  b[o + 0xa5] = handCount & 0xff
  b[o + 0xa6] = p.deckCount & 0xff
  dv.setInt32(o + 0xa8, p.cost, true)
  dv.setInt32(o + 0xac, p.soul, true)
  dv.setUint16(o + 0xb0, p.maintenance & 0xffff, true)
  dv.setUint16(o + 0xb2, p.income & 0xffff, true)
  dv.setUint32(o + 0xb4, p.flags >>> 0, true)
  b[o + 0xb8] = p.controller & 0xff
  dv.setInt32(o + 0xbc, p.panelX, true)
  dv.setInt32(o + 0xc0, p.panelY, true)
  b[o + 0xc4] = p.visible & 0xff
}

function readPlayer(b: Uint8Array, o: number, p: Player) {
  const dv = dvOf(b)
  p.index = b[o]
  p.deck = Array.from({ length: 31 }, (_, i) => dv.getInt16(o + 2 + i * 2, true))
  p.deckState = b.slice(o + 0x40, o + 0x40 + 31)
  p.drawOrder = Array.from(b.subarray(o + 0x5f, o + 0x5f + 31))
  p.hand = Array.from({ length: 6 }, (_, i) => dv.getInt32(o + 0x80 + i * 4, true))
  const usable = dv.getUint32(o + 0x98, true)
  p.usable = Array.from({ length: 6 }, (_, i) => (usable >>> (i * 4)) & 0xf)
  p.selected = dv.getInt32(o + 0x9c, true)
  p.cursor = dv.getInt32(o + 0xa0, true)
  playerA4.set(p, b[o + 0xa4])
  p.deckCount = b[o + 0xa6]
  p.cost = dv.getInt32(o + 0xa8, true)
  p.soul = dv.getInt32(o + 0xac, true)
  p.maintenance = dv.getUint16(o + 0xb0, true)
  p.income = dv.getUint16(o + 0xb2, true)
  p.flags = dv.getUint32(o + 0xb4, true)
  p.controller = b[o + 0xb8]
  p.panelX = dv.getInt32(o + 0xbc, true)
  p.panelY = dv.getInt32(o + 0xc0, true)
  p.visible = b[o + 0xc4]
}

export interface ContinueSource {
  header: SaveHeader
  profile: PlayerProfile
  decks: [PlayerDeck, PlayerDeck, PlayerDeck]
  session: ContinueSession
  /** Versus: unitGetName of each side's Dominator overwrites the names of profile slots 0 and 1. */
  unitNames?: [string, string]
  map: MapBoardScene
}

/**
 * saveSerializeContinue into `buf` (0x287CC bytes, modified in place and returned): header and
 * profile slot 0 field by field, versus names into slots 0 / 1, the decks, DuelPlayer[4], MapUnit
 * [4][31] (memcpy), the map state block pieces, then the scalars.
 */
export function serializeContinue(buf: Uint8Array, src: ContinueSource): Uint8Array {
  if (buf.length !== CONTINUE_SIZE) throw new Error('continue buffer must be 0x287CC bytes')
  const b = buf
  const dv = dvOf(b)
  const m = src.map
  const g = m.game
  writeHeaderFields(b, CO.header, src.header)
  writeProfile(b, CO.profiles, src.profile)
  if (src.session.gameMode === 0 && src.unitNames) {
    // sprintf(slot + 0x78, unitGetName(side)) for sides 0 and 1
    src.unitNames.forEach((n, k) => {
      const o = CO.profiles + k * PROFILE_SIZE
      const t = encodeSjis(n)
      b.set(t, o)
      b[o + t.length] = 0
    })
  }
  src.decks.forEach((d, k) => {
    const o = CO.decks + k * DECK_SIZE
    // the decks are written field by field here: name, cards, +0x58, +0x5C (the pad at +0x56 is not)
    const keep = dv.getUint16(o + 0x56, true)
    writeDeck(b, o, d)
    dv.setUint16(o + 0x56, keep, true)
  })
  const players = [g.players[0], g.players[1], m.sparePlayers[0], m.sparePlayers[1]]
  players.forEach((p, k) => {
    if (p) writePlayer(b, CO.players + k * PLAYER_SIZE, p, k < 2 ? g.handCount(p) : p.hand.filter((h) => h > 0).length)
  })
  // memcpy(file + 0x10A8, g_mapUnits, 0x2AA0): sides 2 and 3 are never initialised (zero, or the buffer's old bytes)
  for (let side = 0; side < 2; side++) for (let s = 0; s < 31; s++) writeUnit(b, CO.units + (side * 31 + s) * UNIT_SIZE, g.units[side][s])
  for (let i = 0; i < 1600; i++) dv.setUint32(CO.grid + i * 4, g.grid[i] >>> 0, true)
  for (let i = 0; i < 1600; i++) dv.setUint16(CO.conquest + i * 2, g.conquest[i], true)
  for (let i = 0; i < 1600; i++) dv.setInt8(CO.land + i, g.land[i])
  b.set(g.auras, CO.auras)
  b.set(g.marks, CO.range)
  b.set(g.seizeMark, CO.seizeFx)
  const S = src.session
  b[0x286c8] = S.mapId
  b[0x286c9] = S.mapVariant
  b[0x286ca] = S.stageNo
  b[0x286cb] = S.gameMode
  b[0x286cc] = S.numPlayers
  b[0x286cd] = S.localPlayer
  dv.setUint32(0x286d0, S.layoutId >>> 0, true)
  dv.setUint32(0x286d4, g.round >>> 0, true)
  dv.setUint32(0x286d8, g.turnPlayer >>> 0, true)
  dv.setUint16(0x286dc, g.goal & 0xffff, true)
  dv.setUint16(0x286de, g.W & 0xffff, true)
  dv.setUint16(0x286e0, g.H & 0xffff, true)
  // 0x286E2 / 0x286E4 (0x08A1B26A / 0x08A1B26C) and 0x286F0 ... are copied from globals nothing else uses: kept
  dv.setUint32(0x286e8, m.firstTurn >>> 0, true)
  for (let i = 0; i < 4; i++) dv.setUint32(0x286ec + i * 4, (g.conquestCount[i] ?? 0) >>> 0, true)
  // 0x286FC g_mapSeizeTally (0xA0 bytes): only the save / load touch it: kept
  for (let i = 0; i < 4; i++) b[0x2879c + i] = g.placedCount[i] ?? 0
  // 0x287A0..0x287AF (0x08A1B328..0x08A1B334): unused globals: kept
  dv.setUint32(0x287b0, g.deployRules >>> 0, true)
  dv.setUint32(0x287b4, g.soulRules >>> 0, true)
  dv.setUint32(0x287b8, g.costRules >>> 0, true)
  dv.setInt32(0x287bc, m.cursor.x, true)
  dv.setInt32(0x287c0, m.cursor.y, true)
  // 0x287C4 (0x08A1B34C): unused global: kept
  dv.setUint16(0x287c8, m.actionFlags & 0xffff, true)
  return b
}

/** The non-board part of saveDeserializeContinue. */
export function parseContinue(b: Uint8Array): ContinueData {
  if (b.length !== CONTINUE_SIZE) throw new Error(`continue data must be 0x287CC bytes (got 0x${b.length.toString(16)})`)
  const dv = dvOf(b)
  const profile = readProfile(b, CO.profiles)
  const slot1 = readProfile(b, CO.profiles + PROFILE_SIZE)
  return {
    header: readHeader(b, CO.header),
    profile,
    decks: [readDeck(b, CO.decks), readDeck(b, CO.decks + DECK_SIZE), readDeck(b, CO.decks + 2 * DECK_SIZE)],
    session: {
      mapId: b[0x286c8],
      mapVariant: b[0x286c9],
      stageNo: b[0x286ca],
      gameMode: b[0x286cb],
      numPlayers: b[0x286cc],
      localPlayer: b[0x286cd],
      layoutId: dv.getUint32(0x286d0, true),
    },
    slotNames: [profile.name, slot1.name],
    round: dv.getUint32(0x286d4, true),
    turnPlayer: dv.getUint32(0x286d8, true),
  }
}

/** The board part of saveDeserializeContinue: fills a MapBoardScene (use as MapBoardScene.resume's `fill`). */
export function fillBoardFromContinue(b: Uint8Array, g: MapGame, m: MapBoardScene) {
  const dv = dvOf(b)
  const players = [g.players[0], g.players[1], m.sparePlayers[0], m.sparePlayers[1]]
  players.forEach((p, k) => p && readPlayer(b, CO.players + k * PLAYER_SIZE, p))
  for (let side = 0; side < 2; side++) for (let s = 0; s < 31; s++) readUnit(b, CO.units + (side * 31 + s) * UNIT_SIZE, g.units[side][s])
  for (let i = 0; i < 1600; i++) g.grid[i] = dv.getUint32(CO.grid + i * 4, true)
  for (let i = 0; i < 1600; i++) g.conquest[i] = dv.getUint16(CO.conquest + i * 2, true)
  for (let i = 0; i < 1600; i++) g.land[i] = dv.getInt8(CO.land + i)
  g.auras.set(b.subarray(CO.auras, CO.auras + g.auras.length))
  g.marks.set(b.subarray(CO.range, CO.range + 1600))
  g.seizeMark.set(b.subarray(CO.seizeFx, CO.seizeFx + 1600))
  g.gameMode = b[0x286cb]
  g.round = dv.getUint32(0x286d4, true)
  g.turnPlayer = dv.getUint32(0x286d8, true)
  g.goal = dv.getUint16(0x286dc, true)
  m.firstTurn = dv.getUint32(0x286e8, true)
  g.conquestCount = [0, 1, 2, 3].map((i) => dv.getUint32(0x286ec + i * 4, true))
  g.placedCount = [0, 1, 2, 3].map((i) => b[0x2879c + i])
  g.deployRules = dv.getUint32(0x287b0, true)
  g.soulRules = dv.getUint32(0x287b4, true)
  g.costRules = dv.getUint32(0x287b8, true)
  m.cursor.x = dv.getInt32(0x287bc, true)
  m.cursor.y = dv.getInt32(0x287c0, true)
  g.cursor = m.cursor
  m.actionFlags = dv.getUint16(0x287c8, true)
}

