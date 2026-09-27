/**
 * The shared game state of Play mode: the saved part (PlayerProfile, decks, header: profile.ts) and
 * the session globals the scenes pass to each other in the game (g_mapId, g_mapStageNo, g_gameMode,
 * g_duelPlayers[].pDeck, g_mapExitScene, g_saveReturnScene…). One GameState lives for the whole run.
 */
import { gameRng } from '../effect/gameRand'
import type { MapBoardScene } from '../effect/mapBoard'
import type { GameDb, MapBoard } from '../formats/gamedb'
import { GameScene, type GameSceneId } from './gameScene'
import { CO, CONTINUE_SIZE, parseContinue, serializeContinue } from './continueSave'
import { cardCountCollection, cardIdToIndex, dbGetDeckByDominator, GAME_DATA_SIZE, parseGameData, PLAYER_DOMINATOR, profileInitNewGame, serializeGameData, type PlayerDeck, type PlayerProfile, type SaveHeader } from './profile'

/** g_gameMode. */
export const MODE_VERSUS = 0
export const MODE_STORY = 1
export const MODE_FREE = 2

export interface SessionState {
  /** g_mapId: area 1..10. */
  mapId: number
  /** g_mapVariant: block A (0) / B (1). */
  mapVariant: number
  /** g_mapStageNo / g_mapLayoutId. */
  stageNo: number
  /** g_gameMode: 0 versus, 1 story, 2 free battle. */
  gameMode: number
  /** g_numPlayers. */
  numPlayers: number
  /** g_localPlayer (0 outside versus play). */
  localPlayer: number
  /** g_duelPlayers[p].pDeck: Dominator + 30 card ids. */
  duelDecks: [number[], number[]]
  /** duelSetPlayerName: the Dominators' card names in story / free battle. */
  playerNames: [string, string]
  /** DuelPlayer.bController (0 local pad, 0xFF CPU). */
  controllers: [number, number]
  /** g_saveReturnScene / g_saveCancelScene (sceneSetSaveReturn). */
  saveReturnScene: GameSceneId
  saveCancelScene: GameSceneId
  /** srand seed of the next board (the title seeds with the play time, always 0). */
  seed: number
  /** How the last board ended (debug overlay; 6.4 applies rewards and counters). */
  lastResult: { stage: number; mode: number; winner: number; exit: GameSceneId } | null
}

/** Objects that live across scene changes (the board survives a DUEL round trip, like the game's globals). */
export interface LiveObjects {
  map: MapBoardScene | null
  /** The battle the board asked for (mapBattlePrepUpdate → scene 0x5A). */
  duel: MapBoardScene['battleRequest']
}

export class GameState {
  readonly db: GameDb
  profile: PlayerProfile
  decks: [PlayerDeck, PlayerDeck, PlayerDeck]
  header: SaveHeader
  session: SessionState
  live: LiveObjects = { map: null, duel: null }
  /** newlib rand + gameRandNext (shared with the map rules and the effect scripts). */
  readonly rng = gameRng
  /** g_saveGameDataBuf (0x09DB6FAC): the game data file buffer, shared by save and load; bytes the serializer skips keep its contents. */
  gameDataBuf: Uint8Array = new Uint8Array(GAME_DATA_SIZE)
  /** g_saveContinueBufPtr: the continue file buffer, shared by the temp save and the resume. */
  continueBuf: Uint8Array = new Uint8Array(CONTINUE_SIZE)
  /** g_resumeLoaded: set when the continue data has been loaded (the resume scene then shows its "deleted" window). */
  resumeLoaded = 0
  /** g_moviePlaying: the PMF the movie player is playing (set by moviePlayFile, cleared when it ends). */
  movie: string | null = null
  /** The loaded continue file waiting for the map board (saveDeserializeContinue wrote the board globals; the board scene applies them). */
  pendingResume: Uint8Array | null = null

  constructor(db: GameDb) {
    this.db = db
    const s = profileInitNewGame(db)
    this.profile = s.profile
    this.decks = s.decks
    this.header = s.header
    this.session = defaultSession()
  }

  /** profileInitNewGame, including its session part (stage 1, map 1, mode 0, round / turn 0, controllers 0). */
  newGame() {
    const s = profileInitNewGame(this.db)
    this.profile = s.profile
    this.decks = s.decks
    this.header = s.header
    this.session = defaultSession()
  }

  /** saveSerializeGameData into g_saveGameDataBuf (the utility writes these bytes). */
  serializeGameData(): Uint8Array {
    this.gameDataBuf = serializeGameData({ profile: this.profile, decks: this.decks, header: this.header }, this.gameDataBuf)
    return this.gameDataBuf
  }

  /** saveDeserializeGameData after a successful LISTLOAD: profile, decks and header replaced. */
  loadGameData(b: Uint8Array) {
    this.gameDataBuf = b.slice()
    const d = parseGameData(this.gameDataBuf)
    this.profile = d.profile
    this.decks = d.decks
    this.header = d.header
  }

  /** campDrawStatusWindows: cardCountCollection into PlayerProfile.totalCards / cardKinds. */
  recountProfile() {
    const [t, k] = cardCountCollection(this.profile)
    this.profile.totalCards = t
    this.profile.cardKinds = k
  }

  /** saveSerializeContinue of the running board into g_saveContinueBufPtr (SetData_GameData(1)). */
  serializeContinue(): Uint8Array {
    const m = this.live.map
    if (!m) throw new Error('no board to save')
    const s = this.session
    serializeContinue(this.continueBuf, {
      header: this.header,
      profile: this.profile,
      decks: this.decks,
      session: { mapId: s.mapId, mapVariant: s.mapVariant, stageNo: s.stageNo, gameMode: m.game.gameMode, numPlayers: s.numPlayers, localPlayer: s.localPlayer, layoutId: m.layout },
      unitNames: [s.playerNames[0], s.playerNames[1]],
      map: m,
    })
    return this.continueBuf
  }

  /**
   * saveDeserializeContinue: header, profile, decks and the session globals now; the board part
   * waits in pendingResume until the map board scene starts (it restores g_mapUnits, the grids and
   * the DuelPlayers). Names: versus takes the profile slot names, the other modes the Dominators'
   * card names (duelSetPlayerName).
   */
  loadContinue(b: Uint8Array) {
    this.continueBuf = b.slice()
    const d = parseContinue(this.continueBuf)
    this.header = d.header
    this.profile = d.profile
    this.decks = d.decks
    const s = this.session
    s.mapId = d.session.mapId
    s.mapVariant = d.session.mapVariant
    s.stageNo = d.session.stageNo
    s.gameMode = d.session.gameMode
    s.numPlayers = d.session.numPlayers
    s.localPlayer = d.session.localPlayer
    const dv = new DataView(this.continueBuf.buffer)
    const dom = (side: number) => dv.getInt32(CO.units + side * 31 * 0x58, true)
    const deck = (k: number) => Array.from({ length: 31 }, (_, i) => dv.getInt16(CO.players + k * 200 + 2 + i * 2, true))
    s.duelDecks = [deck(0), deck(1)]
    s.controllers = [this.continueBuf[CO.players + 0xb8], this.continueBuf[CO.players + 200 + 0xb8]]
    s.playerNames = s.gameMode === MODE_VERSUS ? [...d.slotNames] : [this.cardName(dom(0)), this.cardName(dom(1))]
    this.live = { map: null, duel: null }
    this.pendingResume = this.continueBuf.slice()
  }

  cardName(id: number) {
    return this.db.byId.get(id)?.name ?? `#${id}`
  }

  /** The board of a stage (g_mapTerrainTable entry whose layout id is the stage). */
  boardForStage(stage: number): MapBoard | undefined {
    return this.db.maps.find((m) => m.stage === stage)
  }

  isCleared(stage: number) {
    return stage > 0 && (this.profile.stageClearMask & (1 << (stage - 1))) !== 0
  }

  /**
   * stageGetLayoutIfUnlocked(area, variant) (0x0881C17C): the stage of that area / block, or 0 while
   * it is locked (save-menus.md §2.4). Stage 18 replaces 17 once all six cards 2612–2617 are owned.
   */
  stageIfUnlocked(area: number, variant: number): number {
    const board = this.db.maps.find((m) => m.area === area && m.variant === variant)
    let stage = board?.stage ?? 0
    if (!stage) return 0
    if (stage === 17 && [2612, 2613, 2614, 2615, 2616, 2617].every((id) => this.profile.cardCount[cardIdToIndex(this.db, id)] > 0)) stage = 18
    const c = (s: number) => this.isCleared(s)
    let open: boolean
    switch (stage) {
      case 1:
        open = true
        break
      case 5:
        open = c(3)
        break
      case 6:
      case 7:
        open = c(4) && c(5)
        break
      case 8:
        open = c(6) && c(7)
        break
      case 10:
        open = c(8)
        break
      case 11:
        open = c(9) && c(10)
        break
      case 17:
      case 18:
        open = c(15)
        break
      default:
        open = c(stage - 1)
    }
    return open ? stage : 0
  }

  /**
   * The end of stageSelectScene for a chosen stage: g_mapId / variant / stage, mode 1 (story) or 2
   * (cleared → free battle), DuelPlayer 0 = the selected deck slot with Dominator 1001, DuelPlayer 1 =
   * dbGetDeckByDominator(opponent, mode 1 ? 3 : 1), names from the Dominator cards, 2 players.
   */
  setupStageBattle(board: MapBoard, deckSlot: number, opponent?: number, stage = board.stage) {
    const s = this.session
    s.mapId = board.area
    s.mapVariant = board.variant
    s.stageNo = stage
    // the stage's own opponent: charaGetLadderId(stage) (stage 18 → g_charaLadderOrder[18]); free battle may pick another
    if (opponent === undefined) opponent = this.db.ladder[stage < 0x13 ? stage : 0] ?? board.opponent
    s.gameMode = this.isCleared(stage) ? MODE_FREE : MODE_STORY
    this.profile.curDeckSlot = deckSlot
    const mine = [...this.decks[deckSlot - 1].cards]
    mine[0] = PLAYER_DOMINATOR
    s.duelDecks = [mine, dbGetDeckByDominator(this.db, opponent, s.gameMode === MODE_STORY ? 3 : 1)]
    s.playerNames = [this.cardName(s.duelDecks[0][0]), this.cardName(s.duelDecks[1][0])]
    s.controllers = [0, 0xff]
    s.numPlayers = 2
  }

  /** newGamePrologueScene states 9000 / 9999: the tutorial, Galahad (flags 1) vs Egma (flags 3) on stage 1. */
  setupTutorial() {
    const s = this.session
    s.duelDecks = [dbGetDeckByDominator(this.db, PLAYER_DOMINATOR, 1), dbGetDeckByDominator(this.db, 1004, 3)]
    s.playerNames = [this.cardName(s.duelDecks[0][0]), this.cardName(s.duelDecks[1][0])]
    s.controllers = [0, 0xff]
    s.stageNo = 1
    s.mapId = 1
    s.mapVariant = 0
    s.gameMode = MODE_STORY
    s.numPlayers = 2
  }

  /** Debug overlay: mark stages 1–17 cleared (every stage becomes selectable, as free battles). */
  debugUnlockStages() {
    this.profile.stageClearMask |= 0x1ffff
  }

  /** First non-empty deck slot (1..3), or 1. */
  firstDeckSlot() {
    const i = this.decks.findIndex((d) => d.name !== '' || d.cards.some((c, k) => k > 0 && c > 0))
    return i < 0 ? 1 : i + 1
  }
}

function defaultSession(): SessionState {
  return {
    mapId: 1,
    mapVariant: 0,
    stageNo: 1,
    gameMode: MODE_VERSUS,
    numPlayers: 2,
    localPlayer: 0,
    duelDecks: [[], []],
    playerNames: ['', ''],
    controllers: [0, 0],
    saveReturnScene: GameScene.TITLE,
    saveCancelScene: GameScene.TITLE,
    seed: 0,
    lastResult: null,
  }
}

/** mapGetBgmId(g_mapId): area 1..10 → BGM id area − 1, anything else 1. */
export function mapBgmId(area: number) {
  return area >= 1 && area <= 10 ? area - 1 : 1
}

/** BGM ids used by the scenes (bgmPlay(0, id) → at3/BGM_{id+1}.at3). */
export const BGM = {
  title: 0xe,
  camp: 0xf,
  duel: 10,
  resultWin: 0xb,
  resultLoss: 0x10,
} as const
