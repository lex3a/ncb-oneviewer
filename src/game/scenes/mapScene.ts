/**
 * Scene 0x50 (mapBoardScene) and scene 0x5A (battleDuelScene) of Play mode, driven by the shared
 * state: the board of session.stageNo, the DuelPlayer decks and names of the session, g_gameMode, the
 * CPU opponent. The board itself is MapBoardScene (src/effect/mapBoard.ts); like the game, it asks for
 * the duel scene when a battle starts (mapBattlePrepUpdate returns 0x5A) and resumes afterwards, so
 * the MapBoardScene object lives in state.live across the DUEL round trip.
 */
import type { CardScreenState } from '../../effect/cardScreen'
import { DuelSession } from '../../effect/duel'
import { MapBoardScene, STATE, type MapBoardAssets } from '../../effect/mapBoard'
import { EffectScene, type MapEffectHooks } from '../../effect/scene'
import { StoryPlayer } from '../../effect/story'
import type { MapBoard } from '../../formats/gamedb'
import type { GameAssets } from '../assets'
import type { Scene, SceneContext } from '../game'
import { GameScene, type GameSceneId } from '../gameScene'
import { PAD_DPAD } from '../input'
import { fillBoardFromContinue } from '../continueSave'
import { BGM, mapBgmId, MODE_VERSUS } from '../state'
import { TempSaveHook } from './saveScenes'

/** The MapBoardAssets of one board, from the disc (the same members MapBoardView loads). */
export function mapBoardAssets(a: GameAssets, ctx: SceneContext, board: MapBoard): MapBoardAssets {
  const t = a.mapTables
  const area = board.area
  const get = (n: string, e: number, m: number | null) => a.image(n, e, m)
  return {
    background: Array.from({ length: t.bgCounts[area] ?? 0 }, (_, i) => get('map.one', area * 1000 + board.variant * 100 + i, null)),
    deco: Array.from({ length: t.decoCounts[area] ?? 0 }, (_, k) => get('map.one', 1, area * 100 + k + 1)),
    tiles: get('etc.one', 100, 1),
    cursor: get('etc.one', 100, 2),
    wall: get('etc.one', 100, 3),
    status: get('etc.one', 110, 3),
    banner: get('etc.one', 110, 4),
    flag: get('etc.one', 110, 5),
    shadow: get('etc.one', 110, 6),
    acted: get('etc.one', 110, 7),
    digits: get('etc.one', 2, 1),
    hand: get('etc.one', 2, 2),
    icons: get('etc.one', 1, 11),
    font: a.font,
    token: (id) => get('card.one', 10010, id),
    picture: (id) => get('unit.one', id, 1),
    ring: get('etc.one', 110, 1),
    handLabels: get('etc.one', 110, 2),
    cardPic: (id) => get('card.one', 10001, id || 1000),
    walk: (id) => [a.gan('unit.one', id, 12), a.gan('unit.one', id, 13)],
    winSkins: a.winSkins,
    drawPicture: (id) => get('unit.one', id, 3),
    effect: (id: number, hooks: MapEffectHooks) => {
      const script = a.effectScript(1000 + id)
      const arc = a.archive('effect.one')
      return script && arc ? new EffectScene(arc, script, { attackerSide: 0, snap: true, map: hooks, ...ctx.audio.effectAudio() }) : null
    },
    story: (script) => new StoryPlayer(script, { archives: a.archives, db: a.db, font: a.font, autoDelay: null, ...ctx.audio.storyAudio() }),
    portrait: (i) => get('chara.one', 100, i),
    resultSheet: get('chara.one', 100, 1000),
    badge: get('etc.one', 2, 3),
  }
}

export class MapBoardPlayScene implements Scene {
  readonly id = GameScene.MAP_BOARD
  private map: MapBoardScene | null = null
  private resultBgm = false
  private error = ''
  private tempSave: TempSaveHook | null = null

  init(ctx: SceneContext) {
    const { state, assets, audio } = ctx
    const live = state.live
    const s = state.session
    if (live.map) {
      // back from the duel (MBS_DUEL_RETURN): the same board, its music again
      this.map = live.map
      audio.playBgm(mapBgmId(s.mapId))
      return
    }
    // the board of g_mapStageNo (Arth's stage 18 is played on stage 17's board: same area and block)
    const board = state.boardForStage(s.stageNo) ?? state.db.maps.find((b) => b.area === s.mapId && b.variant === s.mapVariant)
    if (!board) {
      this.error = `no board for stage ${s.stageNo}`
      return
    }
    const m = new MapBoardScene(state.db, assets.mapTables, mapBoardAssets(assets, ctx, board), board, s.stageNo)
    m.onSound = (id) => audio.playSe(id)
    m.playerNames = [...s.playerNames]
    // duelRollRewardCards and duelResultScreenUpdate work on g_playerProfile
    m.profile = state.profile
    const resume = state.pendingResume
    if (resume) {
      // saveDeserializeContinue restored the board globals; mapBoardScene state 0 skips the setup (g_mapRound ≥ 1)
      state.pendingResume = null
      m.resume(s.gameMode, (g, scene) => fillBoardFromContinue(resume, g, scene))
    } else {
      const [d0, d1] = s.duelDecks
      m.newGame([d0[0] || 1001, d1[0] || board.opponent || 1002], 0, s.seed, s.gameMode, [d0.slice(1), d1.slice(1)])
      // DuelPlayer.bController: the second player is the CPU outside versus mode
      m.setController(1, s.gameMode === MODE_VERSUS ? 0 : s.controllers[1] || 0xff)
    }
    // Temp save (state 6000): saveDataScene(SAVE_CONTINUE) over the board
    m.tempSave = () => {
      this.tempSave ??= new TempSaveHook(ctx)
      const r = this.tempSave.step()
      if (r !== 0) this.tempSave = null
      return r
    }
    live.map = m
    this.map = m
    // state MBS_LOAD: bgmPlay(0, mapGetBgmId(g_mapId))
    audio.playBgm(mapBgmId(board.area))
  }

  update(ctx: SceneContext): GameSceneId {
    const m = this.map
    if (!m) return ctx.input.pressed ? GameScene.TITLE : this.id
    const { input, state, audio, screen } = ctx
    // mapBoardScene returns 0x5A when the battle starts (bgmStop(0), MBS_DUEL_RETURN)
    if (m.battleRequest && m.battleRequest !== state.live.duel) {
      state.live.duel = m.battleRequest
      audio.stopBgm()
      return GameScene.DUEL
    }
    m.pad = input.held
    // the port reads edges from `pressed`; menus there expect the pad repeat on the D-pad
    m.pressed = input.pressed | (input.repeat & PAD_DPAD)
    m.pointer = { x: input.pointerX, y: input.pointerY, moved: input.pointerMoved }
    const gl = ctx.willDraw ? screen.use('main') : null
    m.frame(gl)
    if (gl && this.tempSave) {
      this.tempSave.draw(gl)
      gl.end()
    }
    if (!this.resultBgm && (m.state === STATE.win0 || m.state === STATE.win1 || m.state === STATE.draw)) {
      // duelResultScreenUpdate: bgmPlay(0, 0xB) for a win of player 0, else 0x10
      this.resultBgm = true
      audio.playBgm(m.state === STATE.win0 ? BGM.resultWin : BGM.resultLoss)
    }
    if (m.state === STATE.exit) return this.exitScene(ctx, m)
    return this.id
  }

  /**
   * g_mapExitScene: 0x32 after To title / temp save (exit 0), else the result screen's value: 0x834
   * (stage clear scene) after a story-mode win, 300 (camp) otherwise, 0x32 in versus mode.
   */
  private exitScene(ctx: SceneContext, m: MapBoardScene): GameSceneId {
    const s = ctx.state.session
    const winner = m.result === STATE.win0 ? 0 : m.result === STATE.win1 ? 1 : m.result === STATE.draw ? -1 : -2
    // g_mapExitScene: the result screen's return value (300 / 0x834 / 0x32), 0 → 0x32 after To title / temp save
    const exit = (m.resultExit || GameScene.TITLE) as GameSceneId
    s.lastResult = { stage: s.stageNo, mode: s.gameMode, winner, exit }
    return exit
  }

  draw(ctx: SceneContext) {
    const m = this.map
    if (!m) {
      const g = ctx.screen.overlay2d()
      g.fillStyle = '#fff'
      g.font = '12px sans-serif'
      g.fillText(this.error || 'no board', 12, 30)
      return
    }
    // the card screen on top (cardInfoDrawUnit / cardInfoDrawCard after the windows)
    const v = m.cardInfoView()
    const card = v ? ctx.state.db.byId.get(v.cardId) : undefined
    if (!v || !card) return
    const g = ctx.screen.overlay2d()
    const u = v.unit
    const isBase = Math.trunc(card.id / 1000) === 3
    let st: CardScreenState
    if (!u) st = { card, mode: 3, tab: v.tab, cursor: -1, base: [card.ap, card.hp, card.range, card.move, card.attribute], eff: [0, 0, 0, 0, 0], showDf: false, attachments: [] }
    else {
      const base = v.mode === 2 ? [u.baseAp, u.hp, 0, 0, u.attribute] : [0, u.hp, 0, 0, 0]
      const eff = isBase ? [0, 0, 0, 0, 0] : [u.effAp, u.effDf, u.effRange, u.effMove, u.effAttr]
      st = { card, mode: v.mode === 2 ? 2 : 1, tab: v.tab, cursor: v.cursor, base, eff, showDf: true, attachments: [...u.attachments], name: m.playerNames[u.player] }
    }
    const cs = ctx.assets.cardScreen(card.id, st.attachments)
    cs.smooth = ctx.screen.smooth
    cs.draw(g, st, ctx.cardClock, false)
  }

  exit(ctx: SceneContext, next: GameSceneId) {
    // the board survives only the trip to the duel scene
    if (next !== GameScene.DUEL) {
      ctx.state.live.map = null
      ctx.state.live.duel = null
    }
  }

  debug() {
    const m = this.map
    if (!m) return this.error
    const p = m.players[m.turnPlayer]
    return `board state 0x${m.state.toString(16)} · round ${m.game.round} · turn P${m.turnPlayer}${(p?.controller ?? 0) >= 2 ? ' (CPU)' : ''} · Costs ${p?.cost ?? 0} Soul ${p?.soul ?? 0} · effect ${m.effectBusy() ? `0x${m.fxId.toString(16)}` : 'idle'}`
  }
}

/**
 * Scene 0x5A: battleDuelScene for the battle the board asked for (DuelSession from src/effect/duel.ts,
 * over the wide layer), BGM 10 on channel 1, then back to the board with the HP result. Without the
 * duel assets the battleCalcDamage outcome is applied at once.
 */
export class DuelPlayScene implements Scene {
  readonly id = GameScene.DUEL
  private duel: DuelSession | null = null
  private hold = 0
  private done = false

  init(ctx: SceneContext) {
    const { state, assets, audio } = ctx
    const m = state.live.map
    const req = state.live.duel
    if (!m || !req) {
      this.done = true
      return
    }
    const { attacker, target } = req
    // battleDuelScene: the left side is the unit of team 0
    const leftIsAttacker = attacker.team === 0
    const left = leftIsAttacker ? attacker : target
    const right = leftIsAttacker ? target : attacker
    const entry = 1000 + (state.db.byId.get(attacker.cardId)?.battleEffect ?? 0)
    const arc = assets.archive('effect.one')
    if (arc) {
      const d = new DuelSession(
        assets.archives,
        { mode: 'attack', leftCard: left.cardId, rightCard: right.cardId, side: leftIsAttacker ? 0 : 1, effectEntry: entry, full: true, db: state.db, font: assets.font, context: [m.duelContext(left), m.duelContext(right)] },
        (attackerSide, e) => {
          const script = assets.effectScript(e)
          return script ? new EffectScene(arc, script, { attackerSide, snap: true, ...audio.effectAudio() }) : null
        },
      )
      if (d.ready) this.duel = d
    }
    if (!this.duel) {
      const [ha, ht] = m.game.battlePredict(attacker, target)
      m.battleResult(ha, ht)
      this.done = true
      return
    }
    // battleDuelScene state 2: bgmPlay(1, 10)
    audio.playBgm(10)
  }

  update(ctx: SceneContext): GameSceneId {
    if (this.done) return GameScene.MAP_BOARD
    const d = this.duel!
    d.step()
    if (d.finished || d.error) {
      // the end hold, then the HP of both units go back to the board (state 0x238C, bgmStop(1))
      if (++this.hold > 20) {
        const m = ctx.state.live.map
        const req = ctx.state.live.duel
        if (m && req) {
          const [hl, hr] = d.hps
          const leftIsAttacker = req.attacker.team === 0
          m.battleResult(leftIsAttacker ? hl : hr, leftIsAttacker ? hr : hl)
        }
        ctx.audio.stopBgm()
        return GameScene.MAP_BOARD
      }
    }
    return this.id
  }

  draw(ctx: SceneContext) {
    const d = this.duel
    if (!d) return
    const gl = ctx.screen.use('wide')
    gl.depthTest = true
    gl.begin([0, 0, 0])
    d.render(gl)
    gl.end()
  }

  exit() {}

  debug() {
    const d = this.duel
    return d ? `duel frame ${d.frame}${d.finished ? ' (finished)' : ''} · HP ${d.hps.join(' / ')}` : 'no duel'
  }
}
