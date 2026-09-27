/**
 * Card, ability and deck tables read from the game executable (docs/formats/database.md).
 * The UMD's PSP_GAME/SYSDIR/BOOT.BIN is the plain ELF, so an ISO carries its own database.
 * Only ULUS10382 is supported: the table addresses are checked before anything is read.
 */

export type CardType = 'unit' | 'chara' | 'spell' | 'base'

export interface Card {
  /** The name as message codes (msgParseNextGlyph), for drawing it with the game font. */
  nameCodes: number[]
  type: CardType
  id: number
  /** Card number 1..227 (the order of the in-game card list). */
  no: number
  name: string
  ap: number
  hp: number
  /** Units: attack range (always 1). Bases: area of effect radius. */
  range: number
  move: number
  cost: number
  soul: number
  maintenance: number
  /** Units: 0 none, 1 earth, 2 water, 3 fire, 4 air. Spells: category icon 5..12. */
  attribute: number
  rarity: number
  /** Ability ids for units, characters and bases; flags for spells (see battleUsable/attachment). */
  abilities: number[]
  battleEffect: number
  mapEffect: number
  flavor: string
  text: string
}

export interface Ability {
  nameCodes: number[]
  id: number
  name: string
  description: string
  active: boolean
  /** -1 means the card's own cost. */
  useCost: number
  useSoul: number
  category: number
  effect: number
}

export interface Deck {
  index: number
  name: string
  dominator: number
  cards: number[]
}

export interface GameDb {
  cards: Card[]
  byId: Map<number, Card>
  abilities: Map<number, Ability>
  decks: Deck[]
  /** Opponent order of the single-player ladder (character card ids). */
  ladder: number[]
  /** Playable boards (g_mapTerrainTable, mapLoadTerrain). */
  maps: MapBoard[]
  /** Story event scripts (g_apMsgEventTables, msgEventUpdate). */
  stories: StoryScript[]
  /** Card reward weights (g_rewardDropTable, duelRollRewardCards), one row per card number 1..206. */
  rewards: RewardRow[]
  /** Story lines by voice id (goc.dat clip index + 1). */
  voices: Map<number, VoiceLine>
  /** Raw access to the executable, for screens that draw with the game's own tables and strings. */
  raw: GameDbRaw
}

/** The executable behind a GameDb: bytes at a vaddr, and the raw Shift-JIS strings of the tables. */
export interface GameDbRaw {
  /** `len` bytes at `vaddr` (a copy; empty outside the image). */
  bytes: (vaddr: number, len: number) => Uint8Array
  /** CardDef +08 name, +40 flavor text, +44 effect text, as stored (NUL excluded). */
  cardStrings: Map<number, { name: Uint8Array; flavor: Uint8Array; text: Uint8Array }>
  /** AbilityDef +08 name and +1C description; id 0 is record 0, "No powers". */
  abilityStrings: Map<number, { name: Uint8Array; description: Uint8Array }>
}

export interface VoiceLine {
  id: number
  /** Character card id (1001..1021) or 0 for the narrator / an unnamed speaker. */
  speaker: number
  expression: number
  text: string
}

/** goc.dat file-name prefix → story episode (the prefix is not a character: Galahad speaks in all of them). */
export const VOICE_EPISODES: Record<number, string> = {
  0: 'Prologue',
  1: 'Egma',
  2: 'Sha-ee-ah',
  3: 'Iglus',
  4: 'Refina',
  5: 'Sheriela',
  6: 'Simmon',
  7: 'Sha-ee-ah, 2nd meeting',
  8: 'Fellunder',
  9: 'Wise',
  10: 'Sheriela, 2nd meeting',
  11: 'Iglus, 2nd meeting',
  12: 'Wise, 2nd meeting',
  13: 'Refina, 2nd meeting',
  14: 'Egma, 2nd meeting',
  15: 'Hellgaia',
  16: 'Arth, first meeting',
  17: 'Arth, cards not complete',
  18: 'Arth, final battle',
  100: 'Unused',
}

export const CARD_TYPE_LABEL: Record<CardType, string> = { unit: 'Unit', chara: 'Dominator', spell: 'Spell', base: 'Base' }
export const ATTRIBUTE_LABEL = ['—', 'Earth', 'Water', 'Fire', 'Air']

const TABLES: [CardType, number, number, number][] = [
  // type, vaddr, records (incl. dummy record 0), id of record 1
  ['unit', 0x088ad7a8, 123, 1],
  ['chara', 0x088b0220, 22, 1001],
  ['spell', 0x088b3ce8, 69, 2001],
  ['base', 0x088b5b8c, 17, 3001],
]
const CARD_SIZE = 0x48
const ABILITIES = 0x088b71b0
const DECKS = 0x088b7b98
const DECK_NAMES = 0x088b7b1c
const LADDER = 0x088b9fa0
const TERRAIN = 0x088e616c
const TERRAIN_SIZE = 0x658
const LAYOUT_IDS = 0x088b9e5c

export interface MapBoard {
  area: number
  variant: number
  width: number
  height: number
  /** Dominator start squares of player 0 and 1. */
  starts: [number, number][]
  squares: number
  /** earth, water, fire, air square counts. */
  attrCounts: number[]
  /** Conquest goal: squares owned to win (80 %). */
  goal: number
  /** 40×40, row-major: −1 no square, 0 plain, 1 earth, 2 water, 3 fire, 4 air. */
  land: Int8Array
  /** Stage number (g_mapLayoutIds) and the opponent's Dominator card (g_charaLadderOrder[stage]). */
  stage: number
  opponent: number
}

/** Area names as shown by the stage select. */
export const AREA_NAMES = ['', 'Underground shrine', 'Forest of Dryad', 'Clamaton Desert', 'Ruins of Runica', 'Juneilink Island', 'Dark Marsh', 'Umally Island Volcano', 'Ogline Ravine', 'Heavenly Altar', 'Shadow Heaven Ship']

/** Characters in `charaIdToIndex` order: cards 1001..1011 are 1..11, the rematch cards 1012..1021 are 2..11. */
export const CHARA_COUNT = 11
export const charaIndex = (cardId: number) => (cardId <= 1011 ? cardId - 1000 : cardId - 1010)

export function isElf(b: Uint8Array): boolean {
  return b.length > 0x34 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46
}

export function parseGameDb(b: Uint8Array): GameDb | null {
  if (!isElf(b)) return null
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const phoff = dv.getUint32(0x1c, true)
  const phnum = dv.getUint16(0x2c, true)
  const segs: { vaddr: number; off: number; size: number }[] = []
  for (let i = 0; i < phnum; i++) {
    const p = phoff + i * 32
    if (p + 32 > b.length) break
    if (dv.getUint32(p, true) === 1) segs.push({ off: dv.getUint32(p + 4, true), vaddr: dv.getUint32(p + 8, true), size: dv.getUint32(p + 16, true) })
  }
  const fo = (v: number) => {
    for (const s of segs) if (v >= s.vaddr && v < s.vaddr + s.size) return v - s.vaddr + s.off
    return -1
  }
  const i32 = (v: number) => {
    const o = fo(v)
    return o < 0 || o + 4 > b.length ? NaN : dv.getInt32(o, true)
  }
  const u8 = (v: number) => b[fo(v)] ?? 0
  const td = new TextDecoder('shift_jis')
  const codes = (v: number) => {
    const o = fo(v)
    if (o < 0) return []
    let e = o
    while (e < b.length && b[e]) e++
    return msgCodes(b.subarray(o, e))
  }
  const cstr = (v: number) => {
    const o = fo(v >>> 0)
    if (o < 0) return new Uint8Array(0)
    let e = o
    while (e < b.length && b[e]) e++
    return b.slice(o, e)
  }
  const str = (v: number) => {
    const o = fo(v)
    if (o < 0) return ''
    let e = o
    while (e < b.length && b[e]) e++
    return cleanText(td.decode(b.subarray(o, e)))
  }

  // Refuse other builds instead of showing garbage.
  if (!TABLES.every(([, v, , first]) => i32(v + CARD_SIZE + 4) === first)) return null

  const cards: Card[] = []
  const cardStrings: GameDbRaw['cardStrings'] = new Map()
  const abilityStrings: GameDbRaw['abilityStrings'] = new Map()
  for (const [type, base, count] of TABLES) {
    for (let i = 1; i < count; i++) {
      const r = base + i * CARD_SIZE
      cardStrings.set(i32(r + 4), { name: cstr(i32(r + 8)), flavor: cstr(i32(r + 0x40)), text: cstr(i32(r + 0x44)) })
      cards.push({
        type,
        id: i32(r + 4),
        no: 0,
        name: str(i32(r + 8) >>> 0),
        nameCodes: codes(i32(r + 8) >>> 0),
        ap: i32(r + 0x0c),
        hp: i32(r + 0x10),
        range: i32(r + 0x14),
        move: i32(r + 0x18),
        cost: i32(r + 0x1c),
        soul: i32(r + 0x20),
        maintenance: i32(r + 0x24),
        attribute: i32(r + 0x28),
        rarity: u8(r + 0x2c),
        abilities: [i32(r + 0x30), i32(r + 0x34), i32(r + 0x38)],
        battleEffect: u8(r + 0x3e),
        mapEffect: u8(r + 0x3f),
        flavor: str(i32(r + 0x40) >>> 0),
        text: str(i32(r + 0x44) >>> 0),
      })
    }
  }
  // cardIdToIndex: units, then spells, then bases, then characters.
  let no = 0
  for (const t of ['unit', 'spell', 'base', 'chara'] as CardType[]) for (const c of cards) if (c.type === t) c.no = ++no

  const abilities = new Map<number, Ability>()
  for (let i = 0; i < 58; i++) {
    const r = ABILITIES + i * 0x20
    const id = i32(r + 4)
    if (!abilityStrings.has(id)) abilityStrings.set(id, { name: cstr(i32(r + 8)), description: cstr(i32(r + 0x1c)) })
    abilities.set(id, {
      id,
      name: str(i32(r + 8) >>> 0),
      nameCodes: codes(i32(r + 8) >>> 0),
      active: u8(r + 0x0c) !== 0,
      useCost: i32(r + 0x10),
      useSoul: i32(r + 0x14),
      category: i32(r + 0x18) & 0xffff,
      effect: i32(r + 0x18) >>> 16,
      description: str(i32(r + 0x1c) >>> 0),
    })
  }

  const decks: Deck[] = []
  for (let d = 0; d < 31; d++) {
    const r = DECKS + d * 62
    const s16 = (k: number) => (i32(r + k * 2) << 16) >> 16
    const cardsOf: number[] = []
    for (let k = 1; k <= 30; k++) cardsOf.push(s16(k))
    decks.push({ index: d, name: str(i32(DECK_NAMES + d * 4) >>> 0), dominator: s16(0), cards: cardsOf })
  }

  const ladder: number[] = []
  for (let i = 0; i < 20; i++) {
    const id = i32(LADDER + i * 4)
    if (i && id === ladder[0]) break
    ladder.push(id)
  }

  const voices = readVoiceLines(b, segs, i32)

  const maps: MapBoard[] = []
  for (let r = 0; r < 16; r++) {
    const base = TERRAIN + r * TERRAIN_SIZE
    const o = fo(base)
    if (o < 0 || o + TERRAIN_SIZE > b.length) break
    const area = b[o], variant = b[o + 1]
    const stage = u8(LAYOUT_IDS + (area - 1) * 2 + variant)
    maps.push({
      area,
      variant,
      width: dv.getInt16(o + 2, true),
      height: dv.getInt16(o + 4, true),
      starts: [[b[o + 6], b[o + 7]], [b[o + 8], b[o + 9]]],
      squares: b[o + 0x0a],
      attrCounts: [b[o + 0x0b], b[o + 0x0c], b[o + 0x0d], b[o + 0x0e]],
      goal: dv.getInt32(o + 0x10, true),
      land: new Int8Array(b.buffer.slice(b.byteOffset + o + 0x18, b.byteOffset + o + 0x18 + 1600)),
      stage,
      opponent: ladder[stage] ?? 0,
    })
  }

  const bytes = (v: number, len: number) => {
    const o = fo(v)
    return o < 0 ? new Uint8Array(0) : b.slice(o, Math.min(b.length, o + len))
  }
  return {
    cards,
    byId: new Map(cards.map((c) => [c.id, c])),
    abilities,
    decks,
    ladder,
    voices,
    maps,
    stories: readStories(b, fo, i32),
    rewards: readRewards(b, fo),
    raw: { bytes, cardStrings, abilityStrings },
  }
}

/**
 * Story text carries the voice clip as a `＠ｖN` tag (parsed by msgParseNextGlyph). The line itself is
 * referenced from a 0x14-byte event record {key, cmd, side, arg = speaker, arg2 = expression, text}
 * (the pointer is at +0x10; the speaker and expression sit 8 and 4 bytes before it).
 */
function readVoiceLines(b: Uint8Array, segs: { vaddr: number; off: number; size: number }[], i32: (v: number) => number) {
  const td = new TextDecoder('shift_jis')
  const toVaddr = (o: number) => {
    for (const s of segs) if (o >= s.off && o < s.off + s.size) return o - s.off + s.vaddr
    return -1
  }
  const lines = new Map<number, { id: number; text: string }>() // by string vaddr
  for (let o = 0; o < b.length - 4; o++) {
    // ＠ｖ = 81 97 82 96
    if (b[o] !== 0x81 || b[o + 1] !== 0x97 || b[o + 2] !== 0x82 || b[o + 3] !== 0x96) continue
    let s = o
    while (s > 0 && b[s - 1]) s--
    let e = o
    while (e < b.length && b[e]) e++
    const raw = td.decode(b.subarray(s, e))
    const m = /＠ｖ([０-９]+)/.exec(raw)
    const v = toVaddr(s)
    if (m && v >= 0) lines.set(v, { id: Number(m[1].normalize('NFKC')), text: cleanText(raw.replace(/＠ｖ[０-９]+/g, '')) })
    o = e
  }
  const voices = new Map<number, VoiceLine>()
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  for (const seg of segs) {
    for (let o = seg.off + ((4 - (seg.off & 3)) & 3); o + 4 <= seg.off + seg.size && o + 4 <= b.length; o += 4) {
      const line = lines.get(dv.getUint32(o, true))
      if (!line || voices.has(line.id)) continue
      const rec = toVaddr(o) - 12
      let speaker = i32(rec + 4)
      if (!(speaker >= 1001 && speaker <= 1021)) speaker = 0
      voices.set(line.id, { id: line.id, speaker, expression: speaker ? i32(rec + 8) : 0, text: line.text })
    }
  }
  // Lines whose record was not found still get their text.
  for (const l of lines.values()) if (!voices.has(l.id)) voices.set(l.id, { id: l.id, speaker: 0, expression: 0, text: l.text })
  return voices
}

/** Fullwidth letters to ASCII, `＠ｎ` to a line break; other `＠x` markup is kept as `[x]`. */
function cleanText(s: string): string {
  return s
    .replace(/＠ｎ/g, '\n')
    .replace(/＠([ａ-ｚ])([０-９]*)/g, (_, c: string, n: string) => `[${c}${n}]`)
    .normalize('NFKC')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
}

/** Spells reuse the ability slots as flags. */
export const spellBattleUsable = (c: Card) => c.type === 'spell' && c.abilities[0] === 1
export const spellAttachment = (c: Card) => c.type === 'spell' && c.abilities[1] === 1

const UNIT_MEMBERS: Record<number, string> = {
  1: 'card image, small',
  2: 'card image, medium',
  3: 'card image, large / duel portrait',
  10: 'unused',
  11: 'unused',
  12: 'board animation A',
  13: 'board animation B',
  20: 'duel: idle',
  21: 'duel: active',
  22: 'duel: attack',
  23: 'duel: hit',
  24: 'unused',
}

const ETC_ENTRIES: Record<number, string> = {
  1: 'window skin overrides',
  2: 'cursor and menu sprites',
  10: 'title screen',
  20: 'prologue backdrop',
  100: 'map HUD',
  110: 'map HUD (3D)',
  200: 'duel background',
  300: 'camp menu, deck edit, card list',
  310: 'area name plates',
  320: 'stage previews',
}
const ETC_MEMBERS: Record<string, string> = {
  '10/1': 'title background',
  '10/2': 'title menu',
  '10/10': 'retry screen (unused scene)',
  '300/1': 'deck edit',
  '300/2': 'camp menu background',
  '300/3': 'camp menu',
  '300/5': 'deck edit / card list',
  '300/6': 'stage select frame',
  '300/7': 'card list',
}

/**
 * Meaning of an archive entry (or CLC2 member), from the loaders in the executable
 * (docs/formats/database.md). Card and character names need the database; the rest does not.
 */
export function entryLabel(db: GameDb | null, archive: string, entry: number, member?: number | null): string | undefined {
  const a = archive.toLowerCase().replace(/\.one$/, '')
  const card = (id: number) => db?.byId.get(id)?.name
  const join = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(' · ') || undefined
  const hasMember = member !== undefined && member !== null

  if (a === 'unit') return join(hasMember ? undefined : card(entry), hasMember ? UNIT_MEMBERS[member] : undefined)
  if (a === 'card') {
    if (entry === 10000 || entry === 10001 || entry === 10010 || entry === 10020) {
      const kind = { 10000: 'card picture, small', 10001: 'card picture', 10010: 'board token', 10020: 'board token (unused)' }[entry]
      return hasMember ? (member === 1000 ? 'blank card' : card(member)) : kind
    }
    return card(entry)
  }
  if (a === 'chara') {
    const chara = (index: number) => (index >= 1 && index <= CHARA_COUNT ? card(1000 + index) : undefined)
    if (entry === 100) return hasMember ? (member === 1000 ? '"Winner" / "Draw" text' : join(chara(member), 'result screen')) : 'result screen art'
    if (entry === 1000) return hasMember ? join(chara(member), 'default face') : 'default faces'
    if (entry === 2000) return 'story background'
    if (entry === 3000) return 'event picture'
    if (entry > 1000 && entry <= 1021) return hasMember ? `expression ${member}` : card(entry)
    return undefined
  }
  if (a === 'etc') {
    if (entry === 310 && hasMember && member % 100 === 0) return `area ${member / 100} name`
    if (entry === 320 && hasMember) return `area ${Math.floor(member / 100)} preview`
    return hasMember ? ETC_MEMBERS[`${entry}/${member}`] : ETC_ENTRIES[entry]
  }
  if (a === 'option' && entry === 20) return 'window skin'
  if (a === 'effect' && entry >= 1000) {
    const id = entry - 1000
    if (hasMember) return undefined
    if (id === 0x36) return 'result screen: winner'
    if (id === 0x1d) return 'result screen: no winner'
    const users = db ? effectUsers(db).get(id) : undefined
    return join(`effect ${id}`, users?.length ? users.slice(0, 3).join(', ') + (users.length > 3 ? ` +${users.length - 3}` : '') : undefined)
  }
  if (a === 'map') {
    if (entry === 1) return hasMember ? `area ${Math.floor(member / 100)} decoration${member >= 300 ? ' (unused)' : ''}` : 'map decorations'
    if (entry >= 1000) {
      const variant = Math.floor((entry % 1000) / 100)
      return `area ${Math.floor(entry / 1000)}${variant ? `, variant ${variant}` : ''}, piece ${entry % 100}`
    }
  }
  return undefined
}

const usersCache = new WeakMap<GameDb, Map<number, string[]>>()
/** effect id → names of the cards/abilities that start it. */
export function effectUsers(db: GameDb): Map<number, string[]> {
  let m = usersCache.get(db)
  if (m) return m
  m = new Map()
  const add = (id: number, name: string) => {
    if (!id) return
    const l = m!.get(id) ?? []
    if (!l.includes(name)) l.push(name)
    m!.set(id, l)
  }
  // Spells: +3E in battle (battleApplySpellCard), +3F on the map. Units and characters: +3E is their
  // duel attack (battleDuelUpdate); their +3F is always 1 and not a real choice.
  for (const c of db.cards) {
    add(c.battleEffect, c.name)
    if (c.type === 'spell' || c.type === 'base') add(c.mapEffect, c.name)
  }
  for (const ab of db.abilities.values()) add(ab.effect, ab.name)
  usersCache.set(db, m)
  return m
}

// ---------------------------------------------------------------------------------------------
// message text as the game parses it (msgParseNextGlyph 0x08871570)

/** Codes returned by msgCodes besides Shift-JIS characters. */
export const MSG_SPACE = -1
export const MSG_WIDE_SPACE = -2
export const MSG_NEWLINE = -3

/** g_asciiToSjisTable (strAsciiToSjis) for 0x20..0x7E. */
const ASCII_SJIS = [
  0x8140, 0x8149, 0x814a, 0x8194, 0x8190, 0x8193, 0x8195, 0x814c, 0x8169, 0x816a, 0x8196, 0x817b, 0x8143, 0x817c, 0x8144, 0x815e,
  0x824f, 0x8250, 0x8251, 0x8252, 0x8253, 0x8254, 0x8255, 0x8256, 0x8257, 0x8258, 0x8146, 0x8147, 0x8183, 0x8181, 0x8184, 0x8148,
  0x8197, 0x8260, 0x8261, 0x8262, 0x8263, 0x8264, 0x8265, 0x8266, 0x8267, 0x8268, 0x8269, 0x826a, 0x826b, 0x826c, 0x826d, 0x826e,
  0x826f, 0x8270, 0x8271, 0x8272, 0x8273, 0x8274, 0x8275, 0x8276, 0x8277, 0x8278, 0x8279, 0x816d, 0x818f, 0x816e, 0x814f, 0x8151,
  0x814d, 0x8281, 0x8282, 0x8283, 0x8284, 0x8285, 0x8286, 0x8287, 0x8288, 0x8289, 0x828a, 0x828b, 0x828c, 0x828d, 0x828e, 0x828f,
  0x8290, 0x8291, 0x8292, 0x8293, 0x8294, 0x8295, 0x8296, 0x8297, 0x8298, 0x8299, 0x829a, 0x816f, 0x8162, 0x8170, 0x8150,
]
export const asciiToSjis = (c: number) => ASCII_SJIS[c - 0x20] ?? 0x8148

const isLead = (c: number) => (c >= 0x81 && c <= 0x9f) || (c >= 0xe0 && c <= 0xfc)

/**
 * Splits game text into drawable codes the way msgParseNextGlyph does: letters, digits, '-', '+'
 * and '.' are single bytes; any other byte starts a two-byte code, so an ASCII punctuation mark
 * swallows the byte after it (hence names like "Euro' s Shackles"). Markup (＠x…) is skipped.
 */
export function msgCodes(b: Uint8Array): number[] {
  const out: number[] = []
  let i = 0
  while (i < b.length && b[i]) {
    const c = b[i]
    if (c === 0x20) {
      out.push(MSG_SPACE)
      i++
    } else if (c === 0x0a) {
      out.push(MSG_NEWLINE)
      i++
    } else if (c === 0x2d || c === 0x2b || c === 0x2e || (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) {
      out.push(asciiToSjis(c))
      i++
    } else {
      const code = isLead(c) ? (c << 8) | (b[i + 1] ?? 0) : asciiToSjis(c)
      i += 2
      if (code === 0x8197) {
        // markup: a full-width letter, then full-width digits; ＠ｎ is a line break
        if (b[i] === 0x82 && b[i + 1] === 0x8e) out.push(MSG_NEWLINE)
        i += 2
        while (i + 1 < b.length && b[i] === 0x82 && b[i + 1] >= 0x4f && b[i + 1] <= 0x58) i += 2
      } else if (code === 0x8140) out.push(MSG_WIDE_SPACE)
      else out.push(code)
    }
  }
  while (out.length && (out[out.length - 1] === MSG_SPACE || out[out.length - 1] === MSG_WIDE_SPACE)) out.pop()
  return out
}

// ---------------------------------------------------------------------------------------------
// story event scripts (msgEventStart 0x08849388, msgEventUpdate 0x08849E74)

export type StoryTrigger = 'prologue' | 'stageStart' | 'afterWin' | 'afterLoss' | 'stageClear' | 'turnStart'

export interface StoryRecord {
  cmd: number
  /** 0 = upper-left speaker slot, 1 = lower-right. */
  side: number
  /** Speaker card id (cmd 0/2/9), picture member (3/6/12/14/20), BGM id (22), frames (18). */
  arg: number
  /** Expression 1–6 (cmd 0), CG scale % (6/20). */
  arg2: number
  /** Text as message codes; the ＠ｖ tag is in `voice`. */
  codes: number[]
  text: string
  voice: number
}

export interface StoryScript {
  trigger: StoryTrigger
  /** Stage number, 0 for the prologue, round for turn events. */
  key: number
  /** Turn events: the Dominator whose turn starts them. */
  dominator?: number
  records: StoryRecord[]
}

const STORY_TABLES: [StoryTrigger, number][] = [
  ['prologue', 0x088bc8d0],
  ['stageStart', 0x088c61ac],
  ['afterWin', 0x088ce568],
  ['afterLoss', 0x088d2644],
  ['stageClear', 0x088d5088],
  ['turnStart', 0x088d684c],
]

/** Splits each event table into scripts: a new one starts when the key changes or after a cmd 8. */
function readStories(b: Uint8Array, fo: (v: number) => number, i32: (v: number) => number): StoryScript[] {
  const td = new TextDecoder('shift_jis')
  const out: StoryScript[] = []
  for (const [trigger, table] of STORY_TABLES) {
    let cur: StoryScript | null = null
    let prevCmd = -1
    for (let a = table; ; a += 0x14) {
      const o = fo(a)
      if (o < 0 || o + 0x14 > b.length) break
      const key = i32(a)
      const cmd = (b[o + 4] << 24) >> 24
      if (cmd < 0) break
      const arg = i32(a + 8)
      const textAt = fo(i32(a + 0x10) >>> 0)
      let raw: Uint8Array = new Uint8Array(0)
      if (textAt >= 0) {
        let e = textAt
        while (e < b.length && b[e]) e++
        raw = b.subarray(textAt, e)
      }
      const decoded = td.decode(raw)
      const m = /＠ｖ([０-９]+)/.exec(decoded)
      const rec: StoryRecord = {
        cmd,
        side: b[o + 5],
        arg,
        arg2: i32(a + 0x0c),
        codes: cmd === 0 ? msgCodes(raw) : [],
        text: cmd === 0 ? cleanText(decoded.replace(/＠ｖ[０-９]+/g, '')) : '',
        voice: m ? Number(m[1].normalize('NFKC')) : 0,
      }
      if (!cur || key !== cur.key || prevCmd === 8) {
        cur = { trigger, key, records: [] }
        if (trigger === 'turnStart') cur.dominator = arg
        out.push(cur)
      }
      cur.records.push(rec)
      prevCmd = cmd
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// card rewards after a battle (duelRollRewardCards, docs/formats/save-menus.md "Card rewards")

export interface RewardRow {
  cardId: number
  base: number
  /** Multiplier per opponent Dominator 1002..1021. */
  mult: number[]
}

const REWARDS = 0x088b876c

function readRewards(b: Uint8Array, fo: (v: number) => number): RewardRow[] {
  const out: RewardRow[] = []
  const o0 = fo(REWARDS)
  if (o0 < 0) return out
  for (let i = 1; i < 207; i++) {
    const o = o0 + i * 0x18
    if (o + 0x18 > b.length) break
    out.push({ cardId: b[o] | (b[o + 1] << 8), base: b[o + 2], mult: Array.from(b.subarray(o + 3, o + 23)) })
  }
  return out
}

/** A card's weight against an opponent: base × mult[opponent − 1002]. */
export const rewardWeight = (r: RewardRow, opponent: number) => r.base * (r.mult[opponent - 1002] ?? 0)

/**
 * Chance that each card is among the rewards, by simulating duelRollRewardCards: every card scores
 * weight × U(1..100), the top N (ties: lower card number) with a nonzero score are awarded. N is 5–10
 * after a win and 1–3 after a loss. Ignores the rare bonus and cards already owned 10 times.
 */
const rewardOddsCache = new WeakMap<GameDb, Map<string, Map<number, number>>>()

export function rewardOdds(db: GameDb, opponent: number, won: boolean, runs = 20000): Map<number, number> {
  // the simulation is the same for every call with these inputs: keep the result per database
  let cache = rewardOddsCache.get(db)
  if (!cache) rewardOddsCache.set(db, (cache = new Map()))
  const key = `${opponent}:${won ? 1 : 0}:${runs}`
  const cached = cache.get(key)
  if (cached) return cached
  const rows = db.rewards.map((r, i) => ({ id: r.cardId, w: rewardWeight(r, opponent), i })).filter((r) => r.w > 0)
  const counts = new Float64Array(rows.length)
  const score = new Float64Array(rows.length)
  const taken = new Uint8Array(rows.length)
  for (let k = 0; k < runs; k++) {
    const n = Math.min(rows.length, won ? 5 + Math.floor(Math.random() * 6) : 1 + Math.floor(Math.random() * 3))
    for (let j = 0; j < rows.length; j++) score[j] = (Math.floor(Math.random() * 100) + 1) * rows[j].w
    // the n best scores (ties: the earlier table row), found by n scans instead of sorting the whole table
    taken.fill(0)
    for (let t = 0; t < n; t++) {
      let best = -1
      for (let j = 0; j < rows.length; j++) if (!taken[j] && (best < 0 || score[j] > score[best])) best = j
      taken[best] = 1
      counts[best]++
    }
  }
  const out = new Map<number, number>()
  rows.forEach((r, j) => {
    if (counts[j]) out.set(r.id, (out.get(r.id) ?? 0) + counts[j] / runs)
  })
  cache.set(key, out)
  return out
}
