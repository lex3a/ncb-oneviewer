import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { GlRenderer } from '../effect/gl'
import { DuelSession } from '../effect/duel'
import { EffectScene, VIRTUAL_H, VIRTUAL_W, type MapEffectHooks } from '../effect/scene'
import { StoryPlayer } from '../effect/story'
import { loadSeClips, playUiSe, sharedAudioContext } from '../audio/sePlayer'
import type { VagClip } from '../formats/vag'
import { CardScreenClock, CardScreenRenderer, readCardScreenTables, type CardScreenAssets, type CardScreenState, type Img } from '../effect/cardScreen'
import {
  MapBoardScene,
  PAD_CIRCLE,
  PAD_CROSS,
  PAD_DOWN,
  PAD_L,
  PAD_LEFT,
  PAD_R,
  PAD_RIGHT,
  PAD_SELECT,
  PAD_SQUARE,
  PAD_START,
  PAD_TRIANGLE,
  PAD_UP,
  readMapBoardTables,
  SCREEN_H,
  SCREEN_W,
  STATE,
  type MapBoardAssets,
  type MapBoardOptions,
  type RangeOverlay,
} from '../effect/mapBoard'
import { ganSheetCache } from '../export'
import { type GameDb, type MapBoard } from '../formats/gamedb'
import { parseGan, type Gan } from '../formats/gan'
import { gbpToImage, parseGbp } from '../formats/gbp'
import type { OneArchive } from '../formats/one'
import { loadWinSkins } from '../effect/windows'
import type { RgbaImage } from '../formats/palette'

interface Props {
  db: GameDb
  archives: OneArchive[]
  board: MapBoard
  loadFont?: () => Promise<Uint8Array | null>
}

const FRAME_MS = 1000 / 60
/** Held pad bits (padGetHeld): the D-pad, Circle (faster cursor) and Square (list paging). */
const KEY_PAD: Record<string, number> = { ArrowUp: PAD_UP, ArrowDown: PAD_DOWN, ArrowLeft: PAD_LEFT, ArrowRight: PAD_RIGHT, Shift: PAD_CIRCLE, a: PAD_SQUARE }
/** Pressed pad bits (padGetPressed / padGetRepeat): browser key repeat gives the repeat. */
const KEY_PRESS: Record<string, number> = {
  ArrowUp: PAD_UP,
  ArrowDown: PAD_DOWN,
  ArrowLeft: PAD_LEFT,
  ArrowRight: PAD_RIGHT,
  Enter: PAD_CROSS,
  ' ': PAD_CROSS,
  z: PAD_CROSS,
  Shift: PAD_CIRCLE,
  Escape: PAD_CIRCLE,
  Backspace: PAD_CIRCLE,
  x: PAD_CIRCLE,
  a: PAD_SQUARE,
  q: PAD_TRIANGLE,
  e: PAD_START,
  w: PAD_L,
  r: PAD_R,
  PageUp: PAD_L,
  PageDown: PAD_R,
}
const MODE_NAMES: Record<number, string> = { 1: 'story (1)', 2: 'free battle (2)', 0: 'versus (0)' }

function gbp(archives: OneArchive[], name: string, entry: number, sub: number | null): RgbaImage | null {
  const a = archives.find((x) => x.name.toLowerCase() === name)
  const f = a?.entries.find((e) => e.id === entry)?.files.find((x) => x.subId === sub)
  if (!f || f.kind !== 'gbp') return null
  return gbpToImage(parseGbp(f.data))
}

function gan(archives: OneArchive[], name: string, entry: number, sub: number | null): Gan | null {
  const a = archives.find((x) => x.name.toLowerCase() === name)
  const f = a?.entries.find((e) => e.id === entry)?.files.find((x) => x.subId === sub)
  if (!f || f.kind !== 'gan') return null
  return parseGan(f.data)
}

/** A GBP member as a canvas with the GE alpha test (alpha > 0x28), for the card screen renderer. */
function toCanvas(img: RgbaImage | null): Img | null {
  if (!img) return null
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  const rgba = new Uint8ClampedArray(img.rgba)
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] <= 40) rgba[i] = 0
  c.getContext('2d')!.putImageData(new ImageData(rgba, img.width, img.height), 0, 0)
  return c
}

/**
 * The board as mapBoardScene runs it (docs/formats/map-board.md): 480×272, shown at 2×. The rules,
 * the turn flow, commands, spells, abilities and the CPU run from src/effect/map*.ts; map effects play
 * through the effect player (EffectScene) over the board, an attack runs the duel scene (DuelSession)
 * over the board, and the card screen is drawn on top of the frame (a stacked canvas).
 */
/** The board's sound switch (module state: read by the scene's and the effect factories' closures). */
const boardSound: { on: boolean; clips: VagClip[] | null } = { on: false, clips: null }
const seOpts = () => (boardSound.on && boardSound.clips ? { seClips: boardSound.clips, audio: sharedAudioContext() } : {})

export function MapBoardView({ db, archives, board, loadFont }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const duelRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const [font, setFont] = useState<Uint8Array | null>(null)
  useEffect(() => {
    let live = true
    loadFont?.().then((f) => live && setFont(f))
    return () => {
      live = false
    }
  }, [loadFont])

  const tables = useMemo(() => readMapBoardTables(db), [db])
  const effectArchive = useMemo(() => archives.find((a) => a.name.toLowerCase() === 'effect.one'), [archives])
  // Sound: the board's sndPlaySeUi calls and the effect scripts' se_play, through the SAS model.
  const [sound, setSound] = useState(false)
  const [seClips, setSeClips] = useState<VagClip[] | null>(null)
  useEffect(() => {
    boardSound.on = sound
    boardSound.clips = seClips
  }, [sound, seClips])
  useEffect(() => {
    if (sound) void loadSeClips().then(setSeClips)
  }, [sound])
  const assets: MapBoardAssets = useMemo(() => {
    const cache = new Map<string, RgbaImage | null>()
    const get = (name: string, entry: number, sub: number | null) => {
      const k = `${name}/${entry}/${sub}`
      if (!cache.has(k)) cache.set(k, gbp(archives, name, entry, sub))
      return cache.get(k) ?? null
    }
    const area = board.area
    return {
      background: Array.from({ length: tables.bgCounts[area] ?? 0 }, (_, i) => get('map.one', area * 1000 + board.variant * 100 + i, null)),
      deco: Array.from({ length: tables.decoCounts[area] ?? 0 }, (_, k) => get('map.one', 1, area * 100 + k + 1)),
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
      font,
      token: (id) => get('card.one', 10010, id),
      picture: (id) => get('unit.one', id, 1),
      ring: get('etc.one', 110, 1),
      handLabels: get('etc.one', 110, 2),
      cardPic: (id) => get('card.one', 10001, id || 1000),
      walk: (id) => [gan(archives, 'unit.one', id, 12), gan(archives, 'unit.one', id, 13)],
      winSkins: loadWinSkins((a, e, m) => get(a, e, m)),
      drawPicture: (id) => get('unit.one', id, 3),
      // effectStart: effect.one 1000 + id, member 1 (the CAS1 script), with the map's script hooks
      effect: (id: number, hooks: MapEffectHooks) => {
        const script = effectArchive?.entries.find((x) => x.id === 1000 + id)?.files.find((x) => x.kind === 'cas')?.data
        return script && effectArchive ? new EffectScene(effectArchive, script, { attackerSide: 0, snap: true, map: hooks, ...seOpts() }) : null
      },
      story: (script) => new StoryPlayer(script, { archives, db, font, voices: null, audio: null, autoDelay: null }),
      portrait: (i) => get('chara.one', 100, i),
      resultSheet: get('chara.one', 100, 1000),
      badge: get('etc.one', 2, 3),
    }
  }, [archives, board, tables, font, effectArchive, db])

  const charas = useMemo(() => db.cards.filter((c) => c.type === 'chara'), [db])
  const placeable = useMemo(() => db.cards.filter((c) => c.type === 'unit' || c.type === 'base' || c.type === 'chara').sort((a, b) => a.no - b.no), [db])
  const [doms, setDoms] = useState<[number, number]>([1001, board.opponent || 1002])
  const [extra, setExtra] = useState(0)
  const [seed, setSeed] = useState(0)
  const [seedIn, setSeedIn] = useState(0)
  const [gameMode, setGameMode] = useState(1)
  const [restart, setRestart] = useState(0)
  const [opts, setOpts] = useState<MapBoardOptions>({ statusHud: true, hoverPanel: true, cursorMarker: true, statOverlay: 0, overlay: 'none', menuZoom: false })
  const [placeId, setPlaceId] = useState(0)
  const [placePlayer, setPlacePlayer] = useState(0)
  const [smooth, setSmooth] = useState(true)
  const [cpu, setCpu] = useState(true)
  const [showDuel, setShowDuel] = useState(true)
  const [costIn, setCostIn] = useState(20)
  const [soulIn, setSoulIn] = useState(5)
  const [, setVersion] = useState(0)
  const [status, setStatus] = useState('')
  const [dueling, setDueling] = useState(false)

  // A new board resets the opponent to the stage's Dominator.
  const [shownBoard, setShownBoard] = useState(board)
  if (shownBoard !== board) {
    setShownBoard(board)
    setDoms([doms[0], board.opponent || 1002])
  }

  const scene = useMemo(() => {
    const s = new MapBoardScene(db, tables, assets, board)
    s.onSound = (id) => boardSound.on && playUiSe(id)
    s.playerNames = doms.map((id) => db.byId.get(id)?.name ?? `Player ${id}`)
    s.setController(1, gameMode === 0 ? 0 : 0xff)
    s.newGame(doms, extra, seed, gameMode)
    s.restarts = restart
    return s
  }, [db, tables, assets, board, doms, extra, seed, gameMode, restart])
  const sceneRef = useRef(scene)
  const showDuelRef = useRef(showDuel)
  const fontRef = useRef(font)
  useEffect(() => {
    sceneRef.current = scene
    showDuelRef.current = showDuel
    fontRef.current = font
    // dev builds: the live scene for debugging from the console
    if (import.meta.env.DEV) (window as unknown as { mapBoardScene?: MapBoardScene }).mapBoardScene = scene
  }, [scene, showDuel, font])
  useEffect(() => {
    sceneRef.current.opts = opts
  }, [scene, opts])
  useEffect(() => {
    // DuelPlayer.controller: 0 local pad, 0xFF CPU (modes 1/2 always have a CPU opponent in the game)
    sceneRef.current.setController(1, cpu ? 0xff : 0)
  }, [scene, cpu])
  // state readout for the controls line (4 Hz)
  useEffect(() => {
    const id = setInterval(() => {
      const s = sceneRef.current
      const p = s.players[s.turnPlayer]
      const res = s.result === STATE.win0 || s.result === STATE.win1 ? ` · ${s.playerNames[s.result === STATE.win0 ? 0 : 1]} wins` : s.result === STATE.draw ? ' · draw' : s.result === -1 ? ' · returned to title' : ''
      setStatus(`state 0x${s.state.toString(16)} · round ${s.game.round}: ${s.playerNames[s.turnPlayer] ?? s.turnPlayer}${(p?.controller ?? 0) >= 2 ? ' (CPU)' : ''} · Costs ${p?.cost ?? 0} Soul ${p?.soul ?? 0} · effect ${s.effectBusy() ? `0x${s.fxId.toString(16)} running` : 'idle'} · rng s=0x${s.game.rng.s.toString(16)}${res}`)
    }, 250)
    return () => clearInterval(id)
  }, [])

  // The card screen on top of the frame (cardInfoDrawUnit / cardInfoDrawCard, drawn after the windows).
  const csTables = useMemo(() => readCardScreenTables(db), [db])
  const csCommon = useMemo(
    () => ({
      digits: toCanvas(gbp(archives, 'etc.one', 2, 1)),
      hand: toCanvas(gbp(archives, 'etc.one', 2, 2)),
      ui: toCanvas(gbp(archives, 'etc.one', 2, 4)),
      frame: toCanvas(gbp(archives, 'etc.one', 2, 5)),
      icons: toCanvas(gbp(archives, 'etc.one', 1, 11)),
    }),
    [archives],
  )
  const csCache = useRef(new Map<string, CardScreenRenderer>())
  useEffect(() => {
    csCache.current = new Map()
  }, [csCommon, font, archives])
  const cardScreenRef = useRef<(id: number, att: number[]) => CardScreenRenderer>(() => null as unknown as CardScreenRenderer)
  useEffect(() => {
    cardScreenRef.current = (id: number, att: number[]) => {
      const key = `${id}:${att.join(',')}`
      let r = csCache.current.get(key)
      if (!r) {
        const a = archives.find((x) => x.name.toLowerCase() === 'card.one')
        const ganFile = id < 1000 ? a?.entries.find((e) => e.id === id)?.files.find((f) => f.subId === null) : undefined
        let g: CardScreenAssets['gan'] = null
        if (ganFile?.kind === 'gan') {
          const pg = parseGan(ganFile.data)
          g = { gan: pg, sheets: ganSheetCache(pg) }
        }
        const assetsCs: CardScreenAssets = {
          ...csCommon,
          font,
          preview: toCanvas(gbp(archives, 'unit.one', id, 3)),
          attachments: att.map((x) => toCanvas(gbp(archives, 'unit.one', x || 1000, 2))),
          gan: g,
          token: id > 2999 ? toCanvas(gbp(archives, 'card.one', 10010, id)) : null,
        }
        r = new CardScreenRenderer(db, csTables, assetsCs)
        csCache.current.set(key, r)
      }
      return r
    }
  }, [archives, csCommon, font, db, csTables])

  const glRef = useRef<GlRenderer | null>(null)
  const duelGlRef = useRef<GlRenderer | null>(null)
  useEffect(() => {
    if (glRef.current) glRef.current.smooth = smooth
    if (duelGlRef.current) duelGlRef.current.smooth = smooth
  }, [smooth])

  // 60 Hz game frames; only the last frame of a batch is drawn. A battle request runs the duel scene.
  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    if (!glRef.current) glRef.current = new GlRenderer(c, SCREEN_W, SCREEN_H)
    const gl = glRef.current
    let raf = 0
    let last = performance.now()
    let acc = FRAME_MS
    let duel: DuelSession | null = null
    let duelFor: object | null = null
    let hold = 0
    const csClock = new CardScreenClock()
    const startDuel = (s: MapBoardScene) => {
      const req = s.battleRequest!
      duelFor = req
      const { attacker, target } = req
      // battleDuelScene: the left side is the unit of team 0
      const leftIsAttacker = attacker.team === 0
      const left = leftIsAttacker ? attacker : target
      const right = leftIsAttacker ? target : attacker
      const entry = 1000 + (db.byId.get(attacker.cardId)?.battleEffect ?? 0)
      duel = null
      if (showDuelRef.current && effectArchive) {
        const d = new DuelSession(
          archives,
          { mode: 'attack', leftCard: left.cardId, rightCard: right.cardId, side: leftIsAttacker ? 0 : 1, effectEntry: entry, full: true, db, font: fontRef.current, context: [s.duelContext(left), s.duelContext(right)] },
          (attackerSide, e) => {
            const script = effectArchive.entries.find((x) => x.id === e)?.files.find((x) => x.kind === 'cas')?.data
            return script ? new EffectScene(effectArchive, script, { attackerSide, snap: true, ...seOpts() }) : null
          },
        )
        if (d.ready) duel = d
      }
      if (!duel) {
        // no duel assets (or duel display off): the battleCalcDamage outcome
        const [ha, ht] = s.game.battlePredict(attacker, target)
        s.battleResult(ha, ht)
        duelFor = null
        return
      }
      hold = 0
      setDueling(true)
      if (duelRef.current && !duelGlRef.current) duelGlRef.current = new GlRenderer(duelRef.current, VIRTUAL_W, VIRTUAL_H)
    }
    const drawOverlay = (s: MapBoardScene) => {
      const ov = overlayRef.current?.getContext('2d')
      if (!ov) return
      ov.setTransform(1, 0, 0, 1, 0, 0)
      ov.clearRect(0, 0, SCREEN_W, SCREEN_H)
      const v = s.cardInfoView()
      const card = v ? db.byId.get(v.cardId) : undefined
      if (!v || !card) return
      const u = v.unit
      const isBase = Math.trunc(card.id / 1000) === 3
      let st: CardScreenState
      if (!u) st = { card, mode: 3, tab: v.tab, cursor: -1, base: [card.ap, card.hp, card.range, card.move, card.attribute], eff: [0, 0, 0, 0, 0], showDf: false, attachments: [] }
      else {
        // cardInfoDrawUnit: base {0, HP, 0, 0, 0} (mode 2: {base AP, HP, 0, 0, attribute}); effective = the unit's stats (0 for bases)
        const base = v.mode === 2 ? [u.baseAp, u.hp, 0, 0, u.attribute] : [0, u.hp, 0, 0, 0]
        const eff = isBase ? [0, 0, 0, 0, 0] : [u.effAp, u.effDf, u.effRange, u.effMove, u.effAttr]
        st = { card, mode: v.mode === 2 ? 2 : 1, tab: v.tab, cursor: v.cursor, base, eff, showDf: true, attachments: [...u.attachments], name: s.playerNames[u.player] }
      }
      cardScreenRef.current(card.id, st.attachments).draw(ov, st, csClock, false)
    }
    const loop = (t: number) => {
      acc += Math.min(t - last, 100)
      last = t
      let steps = 0
      while (acc >= FRAME_MS && steps < 4) {
        acc -= FRAME_MS
        steps++
        const s = sceneRef.current
        if (s.battleRequest && duelFor !== s.battleRequest) startDuel(s)
        const d = duel as DuelSession | null
        if (d) {
          d.step()
          if (d.finished || d.error) {
            if (++hold > 20) {
              const req = s.battleRequest
              if (req) {
                const [hl, hr] = d.hps
                const leftIsAttacker = req.attacker.team === 0
                s.battleResult(leftIsAttacker ? hl : hr, leftIsAttacker ? hr : hl)
              }
              duel = null
              duelFor = null
              setDueling(false)
            }
          }
          const dg = duelGlRef.current
          if (dg && (acc < FRAME_MS || steps === 4)) {
            dg.depthTest = true
            dg.begin([0, 0, 0])
            d.render(dg)
            dg.end()
          }
          continue
        }
        csClock.tick()
        const drawNow = acc < FRAME_MS || steps === 4
        s.frame(drawNow ? gl : null)
        if (drawNow) drawOverlay(s)
      }
      if (steps === 4) acc = 0
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [archives, db, effectArchive])

  const onKey = (e: KeyboardEvent, down: boolean) => {
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
    const bit = KEY_PAD[key]
    const press = KEY_PRESS[key]
    const s = sceneRef.current
    if (bit) s.pad = down ? s.pad | bit : s.pad & ~bit
    if (down && press && !(e.repeat && !(press & (PAD_UP | PAD_DOWN | PAD_LEFT | PAD_RIGHT)))) s.pressed |= press
    if (bit || press) {
      e.preventDefault()
      return
    }
    if (!down) return
    if (key === 'Tab') {
      s.pressed |= PAD_SELECT
      setOpts((o) => ({ ...o, statOverlay: (o.statOverlay + 1) & 3 }))
    } else if (key === 'h') s.openHand()
    else if (key === 't') s.startTurn()
    else return
    e.preventDefault()
  }

  const cellFromMouse = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return sceneRef.current.cellAt(((e.clientX - r.left) * SCREEN_W) / r.width, ((e.clientY - r.top) * SCREEN_H) / r.height)
  }
  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    canvasRef.current?.focus()
    const cell = cellFromMouse(e)
    if (!cell) return
    const s = sceneRef.current
    const [x, y] = cell
    if (placeId) {
      s.placeCard(placeId, placePlayer, x, y)
      setVersion((v) => v + 1)
    }
    s.placeCursor(x, y)
  }
  const onContext = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const cell = cellFromMouse(e)
    if (!cell) return
    e.preventDefault()
    sceneRef.current.removeAt(cell[0], cell[1])
    setVersion((v) => v + 1)
  }
  const toggleActed = () => {
    const s = sceneRef.current
    const u = s.unitAt(s.cursor.x >> 6, s.cursor.y >> 6)
    if (u) u.actFlags = u.actFlags & 8 ? 0 : 0xf
    setVersion((v) => v + 1)
  }
  const applyCosts = () => sceneRef.current.setResources(costIn, soulIn)

  const missing = [
    !assets.tiles && 'etc.one',
    !assets.background.some(Boolean) && 'map.one',
    !assets.token(1001) && 'card.one',
    !assets.picture(1001) && 'unit.one',
    !font && 'gothic16.bin',
    !assets.winSkins?.[0] && 'option.one',
    !effectArchive && 'effect.one (map effects and the duel scene)',
    !assets.resultSheet && 'chara.one (result screen)',
  ].filter(Boolean)
  const set = <K extends keyof MapBoardOptions>(k: K, v: MapBoardOptions[K]) => setOpts((o) => ({ ...o, [k]: v }))
  // the overlays share .card-screen-canvas (size, scaling) but must stay see-through over the board
  const pointer = { position: 'absolute' as const, left: 0, top: 0, width: '100%', height: '100%', pointerEvents: 'none' as const, background: 'transparent' }

  return (
    <div className="card-screen">
      <div style={{ position: 'relative', display: 'inline-block' }}>
        <canvas
          ref={canvasRef}
          width={SCREEN_W}
          height={SCREEN_H}
          tabIndex={0}
          className="card-screen-canvas"
          onKeyDown={(e) => onKey(e, true)}
          onKeyUp={(e) => onKey(e, false)}
          onBlur={() => (sceneRef.current.pad = 0)}
          onClick={onClick}
          onContextMenu={onContext}
          title="Arrows: D-pad · Enter/Space/Z: Cross · Shift/Esc/X: Circle (held: faster cursor) · A: Square · Q: Triangle · E: START · W/R (PageUp/PageDown): L/R · Tab: SELECT (stats) · H: hand · T: start turn · click: jump to a square"
        />
        <canvas ref={overlayRef} width={SCREEN_W} height={SCREEN_H} className="card-screen-canvas" style={pointer} />
        <canvas ref={duelRef} width={VIRTUAL_W} height={VIRTUAL_H} className="card-screen-canvas" style={{ ...pointer, visibility: dueling ? 'visible' : 'hidden' }} />
      </div>
      <p className="muted small">
        Arrows = D-pad · Enter / Space / Z = Cross · Shift / Esc / X = Circle (cancel; held: faster cursor) · A = Square (check board, change view, list pages) · Q = Triangle (card details) ·
        W / R (PageUp / PageDown) = L / R (jump between units, step cards) · E = START (end turn, skip an event) · Tab = SELECT (stats) · H = hand · T = start the turn. {status}
      </p>
      {missing.length > 0 && <p className="muted small">Load {missing.join(', ')} for the full board.</p>}
      <div className="card-screen-controls">
        <label>
          You{' '}
          <select value={doms[0]} onChange={(e) => setDoms([Number(e.target.value), doms[1]])}>
            {charas.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Opponent{' '}
          <select value={doms[1]} onChange={(e) => setDoms([doms[0], Number(e.target.value)])}>
            {charas.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label title="g_gameMode: story (stage events, turn events, rewards, the CPU starts on stages 1 and 11), free battle (rewards) or versus (Dominator start squares picked by hand, ad-hoc generator, no rewards)">
          Mode{' '}
          <select value={gameMode} onChange={(e) => setGameMode(Number(e.target.value))}>
            {[1, 2, 0].map((m) => (
              <option key={m} value={m}>
                {MODE_NAMES[m]}
              </option>
            ))}
          </select>
        </label>
        <label title="DuelPlayer.controller of the opponent: 0xFF = CPU (aiMapTurnUpdate), 0 = the local pad">
          <input type="checkbox" checked={cpu} onChange={(e) => setCpu(e.target.checked)} /> opponent is CPU
        </label>
        <label title="srand(seed) for newlib rand() (the title screen seeds it with the save's play time, always 0); gameRandNext starts from its boot state. Same seed + same inputs = same game.">
          Seed <input type="number" min={0} value={seedIn} style={{ width: 90 }} onChange={(e) => setSeedIn(Math.max(0, Math.trunc(Number(e.target.value) || 0)))} />
        </label>
        <button
          onClick={() => {
            if (seedIn === seed) setRestart((v) => v + 1)
            else setSeed(seedIn)
          }}
          title="A new game from the seed: decks shuffled by playerShuffleDeck, opening hands, the start sequence (area name, conditions to win, events)"
        >
          New game
        </button>
        <label title="Viewer sample: deck units and bases placed around each start square at game start (0 = as the game starts)">
          Sample units{' '}
          <input type="number" min={0} max={12} value={extra} onChange={(e) => setExtra(Math.max(0, Math.min(12, Number(e.target.value) || 0)))} />
        </label>
      </div>
      <div className="card-screen-controls">
        <label title="Click a square to place this card (right-click removes a unit)">
          Click places{' '}
          <select value={placeId} onChange={(e) => setPlaceId(Number(e.target.value))}>
            <option value={0}>(nothing: move the cursor)</option>
            {placeable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <div className="seg" role="group" aria-label="Owner">
          <button className={placePlayer === 0 ? 'on' : ''} onClick={() => setPlacePlayer(0)}>
            You
          </button>
          <button className={placePlayer === 1 ? 'on' : ''} onClick={() => setPlacePlayer(1)}>
            Opponent
          </button>
        </div>
        <button onClick={toggleActed} title="actFlags of the unit under the cursor: 0xF (finished, dark token and the E marker) or 0">
          Acted
        </button>
        <label title="Viewer: set both players' Costs and Soul (the game computes them at turn start)">
          Costs <input type="number" min={0} max={99} value={costIn} style={{ width: 48 }} onChange={(e) => setCostIn(Number(e.target.value) || 0)} />
        </label>
        <label>
          Soul <input type="number" min={0} max={99} value={soulIn} style={{ width: 48 }} onChange={(e) => setSoulIn(Number(e.target.value) || 0)} />
        </label>
        <button onClick={applyCosts}>Set</button>
        <button onClick={() => sceneRef.current.openHand()} title="handSelectUpdate(player, 1): the hand panel of the turn player (H)">
          Hand
        </button>
        <button onClick={() => sceneRef.current.startTurn()} title="State 10: the turn banner, then mapTurnStartUpdate and the hand (T)">
          Start turn
        </button>
      </div>
      <div className="card-screen-controls">
        <label title={seClips || !sound ? "Sound effects (se.dat) through the SAS voice model: the board's sndPlaySeUi calls and the effect scripts" : "Load snd/se.dat (or the ISO) for sound"}>
          <input type="checkbox" checked={sound} onChange={(e) => setSound(e.target.checked)} /> sound
        </label>
        <label>
          <input type="checkbox" checked={opts.statusHud} onChange={(e) => set('statusHud', e.target.checked)} /> status HUD
        </label>
        <label>
          <input type="checkbox" checked={opts.hoverPanel} onChange={(e) => set('hoverPanel', e.target.checked)} /> hover panel
        </label>
        <label>
          <input type="checkbox" checked={opts.cursorMarker} onChange={(e) => set('cursorMarker', e.target.checked)} /> cursor hand
        </label>
        <label title="DAT_08A1BDA0: the camera zooms from 2.0 to 2.6 while the command menu is open on a unit (forced here)">
          <input type="checkbox" checked={opts.menuZoom} onChange={(e) => set('menuZoom', e.target.checked)} /> force zoom
        </label>
        <label title="Attacks run the duel scene (battleDuelScene) over the board; off: the battleCalcDamage outcome is applied at once">
          <input type="checkbox" checked={showDuel} onChange={(e) => setShowDuel(e.target.checked)} /> duel scene
        </label>
        <label title="SELECT in the game (Tab): numbers over the tokens">
          Stats{' '}
          <select value={opts.statOverlay} onChange={(e) => set('statOverlay', Number(e.target.value))}>
            <option value={0}>off</option>
            <option value={1}>AP</option>
            <option value={2}>HP</option>
            <option value={3}>DF</option>
          </select>
        </label>
        <label title="g_mapRangeGrid marks (the state machine's own marks take precedence)">
          Marks{' '}
          <select value={opts.overlay} onChange={(e) => set('overlay', e.target.value as RangeOverlay)}>
            <option value="none">none</option>
            <option value="summon">summon squares (turn player)</option>
            <option value="range">range of the unit under the cursor</option>
            <option value="forbidden">forbidden start squares (versus)</option>
          </select>
        </label>
        <label>
          <input type="checkbox" checked={smooth} onChange={(e) => setSmooth(e.target.checked)} /> bilinear
        </label>
      </div>
    </div>
  )
}
