/**
 * The Play-mode main loop: a port of main()'s frame (padUpdate, uiAnimCounter(0), one scene function,
 * g_gameScene = its result) at a fixed 60 Hz.
 *
 * Timing: requestAnimationFrame feeds an accumulator and runs as many 1/60 s steps as have elapsed
 * (at most MAX_STEPS per callback, the rest is dropped); only the last step of a batch draws. A
 * setInterval fallback advances the loop when rAF has not fired for 100 ms (hidden tab, throttled or
 * headless browser); a gap longer than 250 ms counts as one frame, so the game slows down instead of
 * bursting after a stall.
 */
import { CardScreenClock } from '../effect/cardScreen'
import { UiClock } from '../effect/deckEditor'
import type { AudioManager } from './audio'
import type { GameAssets } from './assets'
import { GameScene, sceneName, type GameSceneId } from './gameScene'
import type { PadInput } from './input'
import type { Screen } from './screen'
import type { GameState } from './state'

export const FRAME_MS = 1000 / 60
const MAX_STEPS = 8
const STALL_MS = 250
const FALLBACK_AFTER_MS = 100

/** What every scene gets. */
export interface SceneContext {
  game: Game
  state: GameState
  assets: GameAssets
  input: PadInput
  audio: AudioManager
  screen: Screen
  /** uiAnimCounter (advanced once per frame by the loop, like main). */
  ui: UiClock
  /** The card screen's own counters (star blink, Soul icon). */
  cardClock: CardScreenClock
  /** True during the step that will be drawn (scenes that draw inside their update check it). */
  willDraw: boolean
}

/**
 * One GameScene. `update` is the scene function's logic and returns the next g_gameScene (its own id
 * to stay); `draw` renders the frame into the screen layers; `init` / `exit` run on entry and exit
 * (the game resets each scene's static state to 0 when it returns another scene).
 */
export interface Scene {
  readonly id: GameSceneId
  /** Clearly marked stand-in for a scene that is not ported yet. */
  readonly placeholder?: boolean
  init(ctx: SceneContext): void
  update(ctx: SceneContext): GameSceneId
  draw(ctx: SceneContext): void
  exit(ctx: SceneContext, next: GameSceneId): void
  /** One line for the debug overlay. */
  debug?(): string
}

export type SceneFactory = (id: GameSceneId) => Scene

export class Game {
  readonly ctx: SceneContext
  private factory: SceneFactory
  scene: Scene
  sceneId: GameSceneId = GameScene.BOOT
  /** Frames since start (main loop iterations). */
  frame = 0
  /** Frames spent in the current scene. */
  sceneFrame = 0
  /** Scene changes, newest last (debug overlay). */
  history: { frame: number; from: GameSceneId; to: GameSceneId }[] = []
  paused = false
  /** Measured steps per second (debug). */
  fps = 0
  error: string | null = null
  private raf = 0
  private timer = 0
  private last = 0
  private lastTick = 0
  private acc = 0
  private fpsCount = 0
  private fpsAt = 0
  private running = false

  constructor(parts: Omit<SceneContext, 'game' | 'ui' | 'cardClock' | 'willDraw'>, factory: SceneFactory) {
    this.factory = factory
    this.ctx = { ...parts, game: this, ui: new UiClock(), cardClock: new CardScreenClock(), willDraw: false }
    this.scene = factory(GameScene.BOOT)
  }

  start(first: GameSceneId = GameScene.BOOT) {
    this.sceneId = first
    this.scene = this.factory(first)
    this.scene.init(this.ctx)
    this.running = true
    this.last = this.lastTick = this.fpsAt = performance.now()
    this.raf = requestAnimationFrame(this.onRaf)
    this.timer = window.setInterval(this.onTimer, FRAME_MS)
  }

  stop() {
    this.running = false
    cancelAnimationFrame(this.raf)
    clearInterval(this.timer)
    try {
      this.scene.exit(this.ctx, this.sceneId)
    } catch {
      // shutting down
    }
  }

  private onRaf = (now: number) => {
    if (!this.running) return
    this.advance(now)
    this.raf = requestAnimationFrame(this.onRaf)
  }

  private onTimer = () => {
    const now = performance.now()
    if (now - this.lastTick > FALLBACK_AFTER_MS) this.advance(now)
  }

  private advance(now: number) {
    this.lastTick = now
    let dt = now - this.last
    this.last = now
    if (dt > STALL_MS) dt = FRAME_MS
    if (this.paused) return
    this.acc += dt
    let n = Math.floor(this.acc / FRAME_MS)
    if (n > MAX_STEPS) {
      n = MAX_STEPS
      this.acc = 0
    } else this.acc -= n * FRAME_MS
    for (let i = 0; i < n; i++) this.step(i === n - 1)
    if (now - this.fpsAt >= 1000) {
      this.fps = Math.round((this.fpsCount * 1000) / (now - this.fpsAt))
      this.fpsCount = 0
      this.fpsAt = now
    }
  }

  /** One main() iteration; `draw` renders it. Public for automation (window.__ncbGame in dev). */
  step(draw = true) {
    const c = this.ctx
    this.fpsCount++
    c.input.update()
    c.ui.tick()
    c.cardClock.tick()
    c.willDraw = draw
    if (draw) c.screen.beginFrame()
    let next: GameSceneId = this.sceneId
    try {
      next = this.scene.update(c)
      if (draw && next === this.sceneId) this.scene.draw(c)
    } catch (e) {
      this.error = `${sceneName(this.sceneId)}: ${(e as Error).message}`
      console.error(e)
      this.paused = true
    }
    if (draw) c.screen.endFrame()
    this.frame++
    this.sceneFrame++
    if (next !== this.sceneId) this.change(next)
  }

  private change(next: GameSceneId) {
    const from = this.sceneId
    this.scene.exit(this.ctx, next)
    this.history.push({ frame: this.frame, from, to: next })
    if (this.history.length > 20) this.history.shift()
    this.sceneId = next
    this.sceneFrame = 0
    this.scene = this.factory(next)
    this.scene.init(this.ctx)
  }

  setPaused(v: boolean) {
    this.paused = v
  }

  /** Debug: leave the current scene for another one (like writing g_gameScene). */
  jump(id: GameSceneId) {
    this.error = null
    this.paused = false
    this.change(id)
  }
}
