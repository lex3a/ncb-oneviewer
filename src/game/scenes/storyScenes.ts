/**
 * Scenes built around the story event player (msgEventStart / msgEventUpdate / msgEventDraw,
 * src/effect/story.ts): the shared StoryRun (also used by newGamePrologueScene in titleScenes.ts) and
 * stageClearEventScene (0x834).
 */
import { StoryPlayer } from '../../effect/story'
import type { StoryTrigger } from '../../formats/gamedb'
import type { Scene, SceneContext } from '../game'
import { GameScene, type GameSceneId } from '../gameScene'
import { PAD } from '../input'
import { movieJob } from '../movies'

/** A running story event with the pad (✕ next / START skip) and its BGM commands. */
export class StoryRun {
  readonly player: StoryPlayer

  constructor(ctx: SceneContext, trigger: StoryTrigger, key: number) {
    const { state, assets, audio } = ctx
    const sc = state.db.stories.find((s) => s.trigger === trigger && s.key === key)
    if (!sc) throw new Error(`no ${trigger} event ${key}`)
    this.player = new StoryPlayer(sc, { archives: assets.archives, db: state.db, font: assets.font, autoDelay: null, ...audio.storyAudio() })
  }

  static find(ctx: SceneContext, trigger: StoryTrigger, key: number): StoryRun | null {
    return ctx.state.db.stories.some((s) => s.trigger === trigger && s.key === key) ? new StoryRun(ctx, trigger, key) : null
  }

  /** msgEventUpdate: 1 when the script ended. */
  update(ctx: SceneContext): number {
    const p = this.player
    if (ctx.input.pressed & (PAD.CROSS | PAD.POINTER)) p.press()
    if (ctx.input.pressed & (PAD.START | PAD.POINTER_MIDDLE)) p.skip()
    p.step()
    // cmd 22 / 23: bgmPlay(0, arg) / bgmStop(0)
    ctx.audio.playBgmFile(p.bgm)
    return p.finished ? 1 : 0
  }

  draw(ctx: SceneContext) {
    const gl = ctx.screen.use('wide')
    gl.depthTest = false
    gl.begin([0, 0, 0])
    this.player.render(gl)
    gl.end()
  }

  stop() {
    this.player.stopVoice()
  }
}

/**
 * stageClearEventScene (0x0883510C, scene 0x834, after a won story battle): the first clear of stage
 * 15, 16 or 18 plays the stage-clear event (msgEventStart(ctx, stage, 0, 0, 5)); the clear bit s − 1 is
 * set (stage 18 also sets bit 16); then stage 15 → 0x28 (ED000), 18 → 0x29 (ED001), else the camp.
 */
export class StageClearEventScene implements Scene {
  readonly id = GameScene.STAGE_CLEAR_EVENT
  private st = 0
  private story: StoryRun | null = null

  init() {
    this.st = 0
  }

  update(ctx: SceneContext): GameSceneId {
    const p = ctx.state.profile
    const stage = ctx.state.session.stageNo
    if (this.st === 0) {
      if ((stage === 18 || stage === 16 || stage === 15) && !(p.stageClearMask & (1 << (stage - 1)))) {
        this.story = StoryRun.find(ctx, 'stageClear', stage)
        if (this.story) this.st = 2
        // Play mode: start converting the ending movie while the event runs
        if (stage === 15 || stage === 18) movieJob(ctx.assets, stage === 15 ? 'ED000.pmf' : 'ED001.pmf')
      }
      if (stage !== 0) p.stageClearMask |= 1 << (stage - 1)
      if (stage === 18) p.stageClearMask |= 0x10000
      if (this.st === 0) return GameScene.CAMP
      return this.id
    }
    if (this.st === 2 && this.story && this.story.update(ctx) === 1) this.st = 99
    if (this.st === 99) {
      this.story?.stop()
      if (stage === 15) return GameScene.ENDING_MOVIE_A
      if (stage === 18) return GameScene.ENDING_MOVIE_B
      return GameScene.CAMP
    }
    return this.id
  }

  draw(ctx: SceneContext) {
    this.story?.draw(ctx)
  }

  exit() {
    this.story?.stop()
  }
}
