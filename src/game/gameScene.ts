/**
 * The GameScene state machine of `main` (0x088477D4): the values of `g_gameScene` (0x089B84BE, enum
 * GameScene in Ghidra) and what each scene function returns. See docs/formats/play-mode.md.
 *
 * main() runs one scene function per 60 Hz frame and stores its return value in g_gameScene, so a
 * scene "transition" is just a different return value. The table below lists, per scene, the scenes
 * its function can return (read from the code), and how far Play mode implements it.
 */

export const GameScene = {
  BOOT: 0,
  MEMORY_CARD: 10,
  LOGO_MOVIE: 20,
  OPENING_MOVIE: 30,
  ENDING_MOVIE_A: 40,
  ENDING_MOVIE_B: 41,
  ENDING_MOVIE_PLAY: 42,
  TITLE: 50,
  MAP_BOARD: 80,
  DUEL: 90,
  CAMP: 300,
  STAGE_SELECT: 310,
  DECK_EDIT: 320,
  CARD_LIST: 330,
  IDLE_154: 340,
  DEBUG_TEST_DRAW: 390,
  RULES_HELP: 400,
  NEW_GAME: 500,
  RESUME_TEMP: 520,
  BATTLE_MODE: 600,
  SAVE_GAME: 1000,
  LOAD_GAME: 1100,
  RETRY_STAGE: 1500,
  STAFF_ROLL: 2000,
  STAGE_CLEAR_EVENT: 2100,
  ADHOC_LOBBY: 4000,
  DEBUG_MENU: 9000,
} as const

export type GameSceneId = (typeof GameScene)[keyof typeof GameScene]

/** How a scene exists in Play mode: a port of the game's function, a placeholder menu, or dead in the game. */
export type SceneStatus = 'ported' | 'partial' | 'placeholder' | 'dead'

export interface SceneInfo {
  id: GameSceneId
  /** Enum name in Ghidra (without the SCENE_ prefix). */
  name: string
  /** The function main() calls for it (or "main" when the scene is handled inline). */
  fn: string
  addr?: number
  /** Scenes the function can return (besides itself), from the code. */
  next: GameSceneId[]
  status: SceneStatus
  note: string
}

const S = GameScene

export const SCENE_TABLE: SceneInfo[] = [
  { id: S.BOOT, name: 'BOOT', fn: 'main (inline)', next: [S.MEMORY_CARD], status: 'ported', note: 'sndSysInit, at3StreamInit, menuWinSysInit, titleScreenReset, sprites, msgEventInit, saveSysInit, movieInit; Play mode starts loading se.dat / goc.dat here' },
  { id: S.MEMORY_CARD, name: 'MEMORY_CARD', fn: 'saveDataScene(-1)', next: [S.LOGO_MOVIE], status: 'ported', note: 'returns 1 at once; LOGO.pmf starts in the same frame' },
  { id: S.LOGO_MOVIE, name: 'LOGO_MOVIE', fn: 'main (movieUpdate)', next: [S.OPENING_MOVIE], status: 'ported', note: 'LOGO.pmf (converted to MP4 by ffmpeg.wasm once per session); START skips once the first frame is shown; then OP.pmf starts' },
  { id: S.OPENING_MOVIE, name: 'OPENING_MOVIE', fn: 'main (movieUpdate)', next: [S.TITLE], status: 'ported', note: 'OP.pmf after the logo; the title timeout also returns here, but then no movie is playing and main goes straight back to the title' },
  { id: S.ENDING_MOVIE_A, name: 'ENDING_MOVIE_A', fn: 'main', next: [S.ENDING_MOVIE_PLAY], status: 'ported', note: 'movieInit; stage 15 is rewritten to 16; ED000.pmf (after stage 15)' },
  { id: S.ENDING_MOVIE_B, name: 'ENDING_MOVIE_B', fn: 'main', next: [S.ENDING_MOVIE_PLAY], status: 'ported', note: 'movieInit; ED001.pmf (after stage 18)' },
  { id: S.ENDING_MOVIE_PLAY, name: 'ENDING_MOVIE_PLAY', fn: 'main (movieUpdate)', next: [S.STAGE_CLEAR_EVENT], status: 'ported', note: 'the ending movie (START skips once shown); then the stage clear scene again (its event has already run, so it goes to the camp)' },
  { id: S.TITLE, name: 'TITLE', fn: 'titleScreenScene', addr: 0x08867528, next: [S.NEW_GAME, S.LOAD_GAME, S.RESUME_TEMP, S.BATTLE_MODE, S.OPENING_MOVIE], status: 'ported', note: 'etc.one 10/1 + 10/2 + pointer hand; profileInitNewGame + srand(playTime) on load, BGM 0xE; New Game / Load Game / Resume Game / Versus Mode; the attract timeout needs the BGM to stop; the debug results (400, 9000, 300, 0x5A, 0x50, 4000) are never returned' },
  { id: S.MAP_BOARD, name: 'MAP_BOARD', fn: 'mapBoardScene', addr: 0x0884cdd4, next: [S.DUEL, S.CAMP, S.STAGE_CLEAR_EVENT, S.TITLE], status: 'ported', note: 'returns 0x5A for a battle, then g_mapExitScene: 300 (result), 0x834 (story win), 0 → 0x32 (To title, temp save)' },
  { id: S.DUEL, name: 'DUEL', fn: 'battleDuelScene', addr: 0x0888a89c, next: [S.MAP_BOARD], status: 'ported', note: 'the attack between two units; back to the board (MBS_DUEL_RETURN)' },
  { id: S.CAMP, name: 'CAMP', fn: 'campMenuScene', addr: 0x0881ae60, next: [S.STAGE_SELECT, S.DECK_EDIT, S.CARD_LIST, S.TITLE], status: 'ported', note: 'etc.one 300/2 + 300/3, status windows (campDrawStatusWindows), menu Search / Build deck (edit, create, copy, rename with the keyboard, delete) / Card list / System (save and load run saveDataScene inside the scene, back to title); BGM 0xF' },
  { id: S.STAGE_SELECT, name: 'STAGE_SELECT', fn: 'stageSelectScene', addr: 0x0881cf08, next: [S.MAP_BOARD, S.CAMP], status: 'ported', note: 'area list (etc.one 310 plates, 320 previews), block A / B, land counts and record, opponent window with face (free battle: ← → the opponent of any cleared stage), deck choice, confirmation; mode 1 story / 2 free; DuelPlayer decks: slot vs dbGetDeckByDominator(opponent, 3 or 1); BGM 0xF' },
  { id: S.DECK_EDIT, name: 'DECK_EDIT', fn: 'deckEditScene', addr: 0x0882adb8, next: [S.CAMP], status: 'ported', note: 'DeckEditorSim on the profile; a new deck is named with the name-entry keyboard (state 9)' },
  { id: S.CARD_LIST, name: 'CARD_LIST', fn: 'cardListScene', addr: 0x0882c4fc, next: [S.CAMP], status: 'ported', note: 'DeckEditorSim in card-list mode on the profile' },
  { id: S.IDLE_154, name: 'IDLE_154', fn: '(none)', next: [], status: 'dead', note: 'main does nothing in this scene; never set' },
  { id: S.DEBUG_TEST_DRAW, name: 'DEBUG_TEST_DRAW', fn: 'debugTestDrawScene', next: [], status: 'dead', note: 'never returns a scene; unreachable' },
  { id: S.RULES_HELP, name: 'RULES_HELP', fn: 'rulesHelpScene', addr: 0x0884cc90, next: [S.TITLE], status: 'ported', note: 'unreachable in the game (the title never returns 5); reachable in Play mode through the debug overlay scene jump' },
  { id: S.NEW_GAME, name: 'NEW_GAME', fn: 'newGamePrologueScene', addr: 0x08835654, next: [S.MAP_BOARD, S.TITLE], status: 'ported', note: 'name entry keyboard (nameEntryUpdate) on etc.one 20/1 → prologue event 0 → tutorial decks 1001 (flags 1) vs 1004 (flags 3) → stage 1, mode 1; △ (empty name) → title' },
  { id: S.RESUME_TEMP, name: 'RESUME_TEMP', fn: 'resumeTempSaveScene', addr: 0x08835928, next: [S.MAP_BOARD, S.TITLE], status: 'ported', note: '"This data will be deleted after loading" → saveDataScene(2): loads the continue save (localStorage ULUS10382), deletes it (AUTODELETE), "Temporary data will be deleted." 60 frames → map; no data / cancel → title' },
  { id: S.BATTLE_MODE, name: 'BATTLE_MODE', fn: 'battleModeMenuScene', addr: 0x08836b94, next: [S.ADHOC_LOBBY, S.TITLE], status: 'placeholder', note: 'ad-hoc versus setup (title → Versus Mode); a stub back to the title until step 6.6 (WebRTC)' },
  { id: S.SAVE_GAME, name: 'SAVE_GAME', fn: 'saveDataScene(SAVEOP_SAVE_GAME)', next: [], status: 'ported', note: 'g_saveReturnScene on success, g_saveCancelScene on cancel (sceneSetSaveReturn); game data slots ULUS1038200-02 in localStorage; the PSP utility dialog is a stand-in' },
  { id: S.LOAD_GAME, name: 'LOAD_GAME', fn: 'saveDataScene(SAVEOP_LOAD_GAME)', next: [], status: 'ported', note: 'same return rule; the title sets (CAMP, TITLE); saveDeserializeGameData on success' },
  { id: S.RETRY_STAGE, name: 'RETRY_STAGE', fn: 'retryStageScene', next: [S.CAMP, S.TITLE], status: 'dead', note: 'never set by any scene' },
  { id: S.STAFF_ROLL, name: 'STAFF_ROLL', fn: 'staffRollScene', next: [], status: 'dead', note: 'never set by any scene (the port exists under Card database → Extras)' },
  { id: S.STAGE_CLEAR_EVENT, name: 'STAGE_CLEAR_EVENT', fn: 'stageClearEventScene', addr: 0x0883510c, next: [S.CAMP, S.ENDING_MOVIE_A, S.ENDING_MOVIE_B], status: 'ported', note: 'first clear of stage 15 / 16 / 18 plays the stage-clear event; sets the clear bit (stage 18 also bit 16); 15 → ED000, 18 → ED001' },
  { id: S.ADHOC_LOBBY, name: 'ADHOC_LOBBY', fn: 'adhocLobbyScene', addr: 0x0889fe6c, next: [S.MAP_BOARD, S.TITLE], status: 'placeholder', note: 'ad-hoc lobby. Step 6.6' },
  { id: S.DEBUG_MENU, name: 'DEBUG_MENU', fn: 'debugMenuScene', next: [], status: 'dead', note: 'unreachable debug menu' },
]

export const SCENE_INFO = new Map<number, SceneInfo>(SCENE_TABLE.map((s) => [s.id, s]))

export function sceneName(id: number): string {
  return SCENE_INFO.get(id)?.name ?? `0x${id.toString(16)}`
}
