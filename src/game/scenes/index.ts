/**
 * The scene factory: GameScene id → Play-mode scene (a port, or a placeholder with the game's
 * transitions). See SCENE_TABLE in ../gameScene.ts and docs/formats/play-mode.md.
 */
import type { Scene, SceneContext } from '../game'
import { GameScene, SCENE_INFO, type GameSceneId } from '../gameScene'
import { MODE_FREE } from '../state'
import { CollectionScene, RulesHelpPlayScene } from './collectionScenes'
import { DuelPlayScene, MapBoardPlayScene } from './mapScene'
import { CampScene, StageSelectScene } from './campScenes'
import { MenuScene } from './placeholder'
import { ResumeTempScene, SaveLoadGameScene } from './saveScenes'
import { StageClearEventScene } from './storyScenes'
import { EndingStartScene, MemoryCardScene, endingPlayScene, logoScene, openingScene } from './movieScenes'
import { NewGameScene, TitleScene } from './titleScenes'

const S = GameScene

/** SCENE_BOOT (inline in main): system init, then the memory card step. Play mode loads the sound banks here. */
class BootScene implements Scene {
  readonly id = S.BOOT
  init(ctx: SceneContext) {
    void ctx.audio.loadBanks()
  }
  update(): GameSceneId {
    return S.MEMORY_CARD
  }
  draw() {}
  exit() {}
}

/** A scene that only offers its code's exits. */
function simpleScene(id: GameSceneId, title: string, lines: string[], exits: [string, GameSceneId][]) {
  return new MenuScene(id, {
    title,
    info: () => lines,
    items: () => exits.map(([label, to]) => ({ label, run: () => to })),
    cancel: () => exits[exits.length - 1][1],
  })
}

export function createScene(id: GameSceneId): Scene {
  switch (id) {
    case S.BOOT:
      return new BootScene()
    case S.MEMORY_CARD:
      return new MemoryCardScene()
    case S.LOGO_MOVIE:
      return logoScene()
    case S.OPENING_MOVIE:
      return openingScene()
    case S.ENDING_MOVIE_A:
    case S.ENDING_MOVIE_B:
      return new EndingStartScene(id)
    case S.ENDING_MOVIE_PLAY:
      return endingPlayScene()
    case S.TITLE:
      return new TitleScene()
    case S.NEW_GAME:
      return new NewGameScene()
    case S.CAMP:
      return new CampScene()
    case S.STAGE_SELECT:
      return new StageSelectScene()
    case S.MAP_BOARD:
      return new MapBoardPlayScene()
    case S.DUEL:
      return new DuelPlayScene()
    case S.DECK_EDIT:
    case S.CARD_LIST:
      return new CollectionScene(id)
    case S.RULES_HELP:
      return new RulesHelpPlayScene()
    case S.STAGE_CLEAR_EVENT:
      return new StageClearEventScene()
    case S.SAVE_GAME:
    case S.LOAD_GAME:
      return new SaveLoadGameScene(id)
    case S.RESUME_TEMP:
      return new ResumeTempScene()
    case S.BATTLE_MODE:
      // title → Versus Mode: battleModeMenuScene sets up an ad-hoc (wireless) session; Play mode will do
      // versus play over WebRTC (step 6.6), so for now this only leads back to the title
      return simpleScene(
        id,
        'Versus Mode (battleModeMenuScene)',
        ['Versus play comes later: the PSP ad-hoc wireless mode will be replaced by a', 'browser-to-browser connection (WebRTC, step 6.6 of the plan).', 'Nothing is lost: ○ or ✕ returns to the title.'],
        [['Back to title', S.TITLE]],
      )
    case S.ADHOC_LOBBY:
      return simpleScene(id, 'Ad-hoc lobby (adhocLobbyScene)', ['Step 6.6.'], [['Back to title', S.TITLE]])
    default: {
      const info = SCENE_INFO.get(id)
      return simpleScene(id, `${info?.name ?? 'Unknown scene'} (${info?.fn ?? '?'})`, [info?.note ?? 'Not a scene of main().', 'Unreachable in the game.'], [['Back to title', S.TITLE]])
    }
  }
}

/** For the debug overlay: free battle vs story of the current session. */
export const modeName = (m: number) => (m === 0 ? 'versus' : m === MODE_FREE ? 'free battle' : 'story')
