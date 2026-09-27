/**
 * The title screen (titleScreenScene 0x08867528, scene 0x32) and the new game (newGamePrologueScene
 * 0x08835654, scene 500) with the name-entry keyboard (../nameEntry.ts), as the code does them.
 * The images come from the player's disc: etc.one 10/1 (title, 480×272), 10/2 (menu words, 192×160),
 * 20/1 (the name-entry backdrop, 480×272) and 2/2 (pointer hand).
 */
import type { Scene, SceneContext } from '../game'
import { GameScene, type GameSceneId } from '../gameScene'
import { NameEntry } from '../nameEntry'
import { decodeName, nameBytes } from '../profile'
import { BGM } from '../state'
import { drawNative, drawSprite } from '../sprite2d'
import { PAD } from '../input'
import { StoryRun } from './storyScenes'

/** TitleMenuResult (the values main() maps; the title only ever returns 1–4 and −1). */
export const TITLE_RESULT = { NONE: 0, NEW_GAME: 1, LOAD_GAME: 2, RESUME_TEMP: 3, BATTLE_MODE: 4, ATTRACT_TIMEOUT: -1 } as const

/**
 * titleScreenScene, state g_titleState (0x08B3D6D2):
 *  0 load etc.one 10/1 and 10/2, profileInitNewGame, winCloseAll → 1: idle timer 0, bgmStop(0) → 2:
 *  once the file queue is empty srand(g_saveHeader.dwPlayTime) (the game's only srand; play time is
 *  never advanced, so 0), bgmPlay(0, 0xE), "just started" flag → 100: the menu.
 *  100: ↑↓ (pad repeat) move the cursor over the four words with wrap-around (SE 1); ✕ → result
 *  cursor + 1 (SE 7) → 300, which returns it next frame. Any repeat input reloads the idle timer (900);
 *  it counts down every frame. The attract timeout only happens when the BGM is NOT playing: then
 *  (after the first frame's restart) an idle timer at 0 → 400 → result −1 (→ scene 0x1E, which plays
 *  nothing and comes back here), otherwise the timer is cleared and BGM 0xE restarted. BGM loops
 *  forever (sceAtracSetLoopNum −1), so on the console the title never times out.
 *  Draw (states 100 / 200): 10/1 at (0, 0) in screen pixels, 10/2 rect (0, 0)–(176, 128) at
 *  (0x100, 0x100) virtual, the pointer hand with its top-left at (0xD0, 0x100 + 32·cursor) (rotation 0;
 *  anchor 0x10 is only the rotation centre).
 *  State 200 (a 2- or 3-item submenu with ○ back to 100) is never entered; there is no "Press START"
 *  step and no Continue test: all four words are always there (Resume Game → resumeTempSaveScene,
 *  which handles "no data" itself).
 */
export class TitleScene implements Scene {
  readonly id = GameScene.TITLE
  st = 0
  cursor = 0
  /** g_titleItemCount: 3 (titleScreenReset); only the unreachable state 200 reads it. */
  itemCount = 3
  idleTimer = 0
  result = 0
  /** DAT_08B3DAE8: BGM just requested (restart once if it is not playing yet). */
  private bgmJustStarted = false
  private drew = false

  init() {
    this.st = 0
    this.cursor = 0
  }

  private finish(ctx: SceneContext, r: number): GameSceneId {
    const { audio, state } = ctx
    switch (r) {
      case TITLE_RESULT.NEW_GAME:
        audio.stopBgm()
        return GameScene.NEW_GAME
      case TITLE_RESULT.LOAD_GAME:
        // sceneSetSaveReturn(SCENE_CAMP, SCENE_TITLE)
        state.session.saveReturnScene = GameScene.CAMP
        state.session.saveCancelScene = GameScene.TITLE
        audio.stopBgm()
        return GameScene.LOAD_GAME
      case TITLE_RESULT.RESUME_TEMP:
        audio.stopBgm()
        return GameScene.RESUME_TEMP
      case TITLE_RESULT.BATTLE_MODE:
        audio.stopBgm()
        return GameScene.BATTLE_MODE
      case TITLE_RESULT.ATTRACT_TIMEOUT:
        return GameScene.OPENING_MOVIE
    }
    return this.id
  }

  update(ctx: SceneContext): GameSceneId {
    const { input, audio, state } = ctx
    this.drew = false
    switch (this.st) {
      case 400:
        this.cursor = 0
        this.st = 0
        return this.finish(ctx, TITLE_RESULT.ATTRACT_TIMEOUT)
      case 300:
        this.cursor = 0
        this.st = 0
        return this.finish(ctx, this.result)
      case 100: {
        if (input.repeat & PAD.DOWN) {
          audio.playSe(1)
          this.cursor = this.cursor === 3 ? 0 : this.cursor + 1
        } else if (input.repeat & PAD.UP) {
          audio.playSe(1)
          this.cursor = this.cursor === 0 ? 3 : this.cursor - 1
        }
        // Viewer convenience: the mouse over a word (rows of 32 at (0x100, 0x100 + 32·i), 0xB0 wide,
        // plus the pointer hand's column from 0xD0) moves the cursor; a click on it chooses it like ✕.
        const row = Math.floor((input.pointerY - 0x100) / 0x20)
        const onWord = row >= 0 && row < 4 && input.pointerIn(0xd0, 0x100, 0x100 + 0xb0, 0x180)
        if (onWord && input.pointerMoved && row !== this.cursor) {
          audio.playSe(1)
          this.cursor = row
        }
        const clicked = (input.pressed & PAD.POINTER) !== 0 && onWord
        if (clicked) this.cursor = row
        if (input.pressed & PAD.CROSS || clicked) {
          audio.playSe(7)
          this.result = this.cursor + 1
          this.st = 300
        }
        if (input.repeat) this.idleTimer = 900
        if (this.idleTimer) this.idleTimer--
        // bgmIsPlaying(): the AT3 thread's PLAYING flag, set as soon as bgmPlay starts it
        if (audio.bgm === null) {
          if (this.bgmJustStarted) {
            audio.stopBgm()
            audio.playBgm(BGM.title)
          } else if (this.idleTimer === 0) this.st = 400
          else {
            this.idleTimer = 0
            audio.playBgm(BGM.title)
          }
        } else this.bgmJustStarted = false
        this.drew = true
        break
      }
      case 2:
        // fileQueueWaitOrPending(1) == 0: the images are loaded
        state.rng.srand(state.header.playTime)
        audio.playBgm(BGM.title)
        this.bgmJustStarted = true
        this.st = 100
        break
      case 1:
        this.idleTimer = 0
        audio.stopBgm()
        this.st = 2
        break
      case 0:
        // spriteLoadOneMember(etc.one 10/1, 10/2); profileInitNewGame(); winCloseAll()
        state.newGame()
        this.st = 1
        break
    }
    return this.id
  }

  draw(ctx: SceneContext) {
    if (!this.drew) return
    const { assets } = ctx
    const gl = ctx.screen.use('wide')
    gl.depthTest = false
    gl.begin([0, 0, 0])
    drawNative(gl, assets.image('etc.one', 10, 1))
    drawSprite(gl, assets.image('etc.one', 10, 2), 0, 0, 0xb0, 0x80, 0x100, 0x100)
    // uiDrawPointerHand(0xD0, cursor·0x20 + 0x100, 0x7FFF, 0, 0, 0, 2D camera): frame uiAnimCounter(2)
    const hf = assets.deckTables.hand
    const f = ctx.ui.m2
    const u = hf.u[f] ?? 0, v = hf.v[f] ?? 0
    // Anchor 0x10 only moves the rotation / scale centre (spriteSetAnchor → spriteSetPivot keeps the
    // quad in place) and the sprite's offset is 0, so with rotation 0 the 48×32 frame's TOP-LEFT is
    // at (x, y): the hand spans y..y + 32, i.e. exactly the 32-px row of the word at 0x100 + 32·cursor.
    drawSprite(gl, assets.image('etc.one', 2, 2), u, v, u + 0x30, v + 0x20, 0xd0, this.cursor * 0x20 + 0x100)
    gl.end()
  }

  exit() {}

  debug() {
    return `title state ${this.st} · cursor ${this.cursor} · idle ${this.idleTimer}${ctxBgmNote(this)}`
  }
}

const ctxBgmNote = (t: TitleScene) => (t.st === 100 && t.idleTimer === 0 ? ' · idle (times out only if the BGM stops)' : '')

/**
 * newGamePrologueScene (g_newGameState 0x089B61B4):
 *  0: menuFullscreenBg(500, 0, 2) loads the backdrop etc.one 20/1, nameEntryInit(&g_playerProfile.name,
 *     "") → 1: wait for the file queue → 100: nameEntryUpdate(0) every frame; −1 (empty name, △) →
 *     backdrop freed → title; 1 → backdrop freed, g_gameMode 1, layout 0, msgEventReset → 200: once
 *     the file queue is empty msgEventStart(ctx, 0, 0, 0, 0) (the prologue) → 300: msgEventUpdate until
 *     it returns 1 → 9000: tutorial decks dbGetDeckByDominator(1001, flags 1) / (1004, flags 3) and the
 *     Dominators' names → 9999: stage 1, layout 1, map 1 block A, mode 1, 2 players → 0x50.
 *  Each frame: the backdrop (only while loaded, so the prologue runs on black), then
 *  menuWinUpdateAll (the name-entry windows) or msgEventDraw while an event runs.
 */
export class NewGameScene implements Scene {
  readonly id = GameScene.NEW_GAME
  st = 0
  private bg = false
  private story: StoryRun | null = null
  private entry: NameEntry | null = null

  init() {
    this.st = 0
  }

  update(ctx: SceneContext): GameSceneId {
    const { input, audio, state, assets } = ctx
    switch (this.st) {
      case 9999:
        state.session.stageNo = 1
        state.session.mapId = 1
        state.session.mapVariant = 0
        state.session.gameMode = 1
        state.session.numPlayers = 2
        this.st = 0
        return GameScene.MAP_BOARD
      case 9000:
        state.setupTutorial()
        this.st = 9999
        break
      case 300:
        if (!this.story || this.story.update(ctx) === 1) {
          this.story?.stop()
          this.story = null
          this.st = 9000
        }
        break
      case 200:
        this.story = StoryRun.find(ctx, 'prologue', 0)
        this.st = 300
        break
      case 100: {
        const ne = this.entry!
        const r = ne.update(input.pressed, input.repeat, audio, input)
        if (ne.result) {
          // state 4 ✕: sprintf(&g_playerProfile.name, "%s", name) — the bytes after the NUL stay
          const p = state.profile
          const b = nameBytes(p.name, p.nameRaw)
          b.set(ne.result.subarray(0, 23))
          b[Math.min(23, ne.result.length)] = 0
          p.nameRaw = b
          p.name = decodeName(b, 0)
          ne.result = null
        }
        if (r === -1) {
          this.bg = false
          this.st = 0
          return GameScene.TITLE
        }
        if (r === 1) {
          this.bg = false
          state.session.gameMode = 1 // (and g_mapLayoutId = 0, not modelled apart from the stage)
          this.st = 200
        }
        break
      }
      case 1:
        this.st = 100
        break
      case 0:
        this.bg = true
        this.entry = new NameEntry(state.db, assets.winTables)
        this.entry.mode = 0
        this.entry.init(new Uint8Array(0))
        this.st = 1
        break
    }
    // menuWinUpdateAll (while no event runs): dimming, then the draw
    if (this.st < 200) this.entry?.wins.tick()
    return this.id
  }

  draw(ctx: SceneContext) {
    if (this.st === 300 && this.story) return this.story.draw(ctx)
    const gl = ctx.screen.use('wide')
    gl.depthTest = false
    gl.begin([0, 0, 0])
    if (this.bg) drawNative(gl, ctx.assets.image('etc.one', 20, 1))
    this.entry?.wins.draw(gl, ctx.assets.painter)
    gl.end()
  }

  exit() {
    this.story?.stop()
  }

  debug() {
    const ne = this.entry
    const story = this.story ? ` · record ${this.story.player.index}/${this.story.player.script.records.length}` : ''
    return `newGame state ${this.st}${ne && this.st === 100 ? ` · entry state ${ne.state} · "${ne.nameText}" pos ${ne.cursorPos}/${ne.nameLen} · key (${ne.col}, ${ne.row})` : ''}${story}`
  }
}
