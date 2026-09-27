/**
 * The movie scenes of main() (0x088477D4), which handles them inline:
 *  - MEMORY_CARD (10): saveDataScene(−1) returns at once; moviePlayFile("LOGO.pmf") in the same frame
 *    sets g_moviePlaying → LOGO (0x14);
 *  - LOGO (0x14): movieUpdate() until the movie ends; START (0x8) stops it once the first frame has been
 *    shown (g_movieFrameShown); then movieShutdown, movieInit, moviePlayFile("OP.pmf") → OPENING (0x1E);
 *  - OPENING (0x1E): the same, then movieShutdown → TITLE (0x32). The title's attract timeout also
 *    returns 0x1E, but nothing plays OP.pmf then (g_moviePlaying is false): main shuts the (idle)
 *    player down and goes straight back to the title;
 *  - ENDING_MOVIE_A / B (0x28 / 0x29): movieInit, stage 15 → 16, moviePlayFile("ED000" / "ED001.pmf")
 *    → ENDING_MOVIE_PLAY (0x2A): the same loop, then movieShutdown → STAGE_CLEAR_EVENT (0x834).
 * A movie that cannot be opened (moviePlayFile fails) leaves g_moviePlaying false, so the scene ends at
 * once; Play mode does the same when the file is missing or ffmpeg cannot convert it.
 *
 * GameState.movie is g_moviePlaying (with the file name). While the MP4 is being converted Play mode
 * shows a small "Converting…" line (ours); START skips that wait too (ours: the game has no wait).
 */
import type { Scene, SceneContext } from '../game'
import { GameScene, type GameSceneId } from '../gameScene'
import { PAD } from '../input'
import { movieJob, type MovieJob } from '../movies'
import { PSP_H, PSP_W } from '../screen'

/** A movie being played in a <video> over the screen layers. */
class MoviePlayback {
  readonly job: MovieJob
  video: HTMLVideoElement | null = null
  /** g_movieFrameShown: the first frame is on screen. */
  frameShown = false
  ended = false
  error: string | null = null

  constructor(ctx: SceneContext, name: string) {
    this.job = movieJob(ctx.assets, name)
  }

  private start(ctx: SceneContext) {
    const v = document.createElement('video')
    v.className = 'play-layer'
    v.style.zIndex = '4'
    v.style.objectFit = 'fill'
    v.style.background = '#000'
    v.playsInline = true
    v.src = this.job.url!
    const s = ctx.audio.settings
    v.volume = s.muted ? 0 : Math.max(0, Math.min(1, s.master))
    v.addEventListener('playing', () => (this.frameShown = true))
    v.addEventListener('timeupdate', () => {
      if (v.currentTime > 0) this.frameShown = true
    })
    v.addEventListener('ended', () => (this.ended = true))
    v.addEventListener('error', () => {
      this.error = 'the browser cannot play the converted movie'
      this.ended = true
    })
    ctx.screen.host.appendChild(v)
    this.video = v
    v.play().catch(() => {
      // autoplay with sound refused (no user gesture yet): play muted rather than not at all
      v.muted = true
      v.play().catch((e: Error) => {
        this.error = e.message
        this.ended = true
      })
    })
  }

  /** movieUpdate + main's START test: true when the movie is over (ended, stopped or unplayable). */
  update(ctx: SceneContext): boolean {
    const j = this.job
    if (!this.video) {
      if (j.error) return true
      if (!j.url) return !!(ctx.input.pressed & (PAD.START | PAD.POINTER)) // ours: skip the conversion wait (START or a click)
      this.start(ctx)
      return false
    }
    if (this.ended) return true
    // movieStop once the first frame is shown
    return !!(ctx.input.pressed & (PAD.START | PAD.POINTER)) && this.frameShown // a click works as START (ours)
  }

  draw(ctx: SceneContext) {
    if (this.video) return
    // black screen; Play mode's own note while the MP4 is prepared
    const g = ctx.screen.overlay2d()
    g.fillStyle = '#000'
    g.fillRect(0, 0, PSP_W, PSP_H)
    const p = this.job.progress
    const what = p?.stage === 'download' ? 'Loading the movie decoder' : `Converting ${this.job.name}`
    const pct = p ? ` ${Math.round(p.ratio * 100)} %` : ''
    g.font = '9px sans-serif'
    g.textBaseline = 'bottom'
    g.fillStyle = '#6a7390'
    g.fillText(`${what}…${pct}   (START or click skips)`, 8, PSP_H - 6)
  }

  stop() {
    const v = this.video
    if (v) {
      v.pause()
      v.removeAttribute('src')
      v.load()
      v.remove()
    }
    this.video = null
  }

  debug() {
    const j = this.job
    if (this.error || j.error) return `${j.name}: ${this.error ?? j.error}`
    if (!this.video) return `${j.name}: converting ${j.progress ? `${j.progress.stage} ${Math.round(j.progress.ratio * 100)} %` : '…'}`
    return `${j.name}: ${this.video.currentTime.toFixed(1)} / ${Number.isFinite(this.video.duration) ? this.video.duration.toFixed(1) : '?'} s${this.frameShown ? '' : ' (no frame yet)'}`
  }
}

/** Scenes 0x14, 0x1E and 0x2A: the movie in GameState.movie until it ends, then `next`. */
export class MovieScene implements Scene {
  readonly id: GameSceneId
  private next: (ctx: SceneContext) => GameSceneId
  private playback: MoviePlayback | null = null

  constructor(id: GameSceneId, next: (ctx: SceneContext) => GameSceneId) {
    this.id = id
    this.next = next
  }

  init(ctx: SceneContext) {
    const m = ctx.state.movie
    this.playback = m ? new MoviePlayback(ctx, m) : null
  }

  update(ctx: SceneContext): GameSceneId {
    if (this.playback && !this.playback.update(ctx)) return this.id
    // g_moviePlaying = false → movieShutdown
    this.playback?.stop()
    this.playback = null
    ctx.state.movie = null
    return this.next(ctx)
  }

  draw(ctx: SceneContext) {
    this.playback?.draw(ctx)
  }

  exit() {
    this.playback?.stop()
    this.playback = null
  }

  debug() {
    return this.playback?.debug() ?? 'no movie playing (g_moviePlaying false)'
  }
}

/** MEMORY_CARD (10): saveDataScene(−1) → 1 at once; LOGO.pmf starts in the same frame. */
export class MemoryCardScene implements Scene {
  readonly id = GameScene.MEMORY_CARD
  init() {}
  update(ctx: SceneContext): GameSceneId {
    ctx.state.rng.rand() // saveDataScene calls rand() on every call
    ctx.state.movie = 'LOGO.pmf'
    // convert both boot movies now (one ffmpeg job at a time: OP converts while the logo plays)
    movieJob(ctx.assets, 'LOGO.pmf')
    movieJob(ctx.assets, 'OP.pmf')
    return GameScene.LOGO_MOVIE
  }
  draw() {}
  exit() {}
}

/** LOGO (0x14) → movieShutdown, movieInit, moviePlayFile("OP.pmf") → 0x1E. */
export function logoScene() {
  return new MovieScene(GameScene.LOGO_MOVIE, (ctx) => {
    ctx.state.movie = 'OP.pmf'
    return GameScene.OPENING_MOVIE
  })
}

/** OPENING (0x1E) → TITLE. */
export function openingScene() {
  return new MovieScene(GameScene.OPENING_MOVIE, () => GameScene.TITLE)
}

/** ENDING_MOVIE_A / B (0x28 / 0x29): movieInit; stage 15 → 16; ED000 / ED001.pmf → 0x2A. */
export class EndingStartScene implements Scene {
  readonly id: GameSceneId
  constructor(id: GameSceneId) {
    this.id = id
  }
  init() {}
  update(ctx: SceneContext): GameSceneId {
    if (ctx.state.session.stageNo === 15) ctx.state.session.stageNo = 16
    ctx.state.movie = this.id === GameScene.ENDING_MOVIE_A ? 'ED000.pmf' : 'ED001.pmf'
    return GameScene.ENDING_MOVIE_PLAY
  }
  draw() {}
  exit() {}
}

/** ENDING_MOVIE_PLAY (0x2A) → movieShutdown → STAGE_CLEAR_EVENT. */
export function endingPlayScene() {
  return new MovieScene(GameScene.ENDING_MOVIE_PLAY, () => GameScene.STAGE_CLEAR_EVENT)
}
