import { useCallback, useEffect, useRef, useState } from 'react'
import { AudioManager } from '../game/audio'
import { GameAssets } from '../game/assets'
import { Game } from '../game/game'
import { GameScene, SCENE_TABLE, sceneName, type GameSceneId } from '../game/gameScene'
import { PadInput, padNames } from '../game/input'

/** A pointer event on the play screen → the game's 640×448 virtual coordinates. */
function toVirtual(e: React.PointerEvent<HTMLElement>): [number, number] {
  const r = e.currentTarget.getBoundingClientRect()
  return [((e.clientX - r.left) / r.width) * 640, ((e.clientY - r.top) / r.height) * 448]
}
import { createScene, modeName } from '../game/scenes'
import { CONTINUE_DIR, deleteSave, exportName, GAME_SLOTS, importSave, readSave, slotDir } from '../game/saves'
import { PSP_H, PSP_W, Screen } from '../game/screen'
import { GameState } from '../game/state'
import type { GameDb } from '../formats/gamedb'
import type { OneArchive } from '../formats/one'

interface Props {
  db: GameDb
  archives: OneArchive[]
  loadFont: () => Promise<Uint8Array | null>
  /** Reads a loose disc file by name (se.dat, goc.dat, BGM_nn.at3). */
  loadFile: (name: string) => Promise<Uint8Array | null>
  onExit: () => void
}

type Scale = 1 | 2 | 3 | 'fit'

const PREFS_KEY = 'ncb.play.view'

function loadPrefs(): { scale: Scale; smooth: boolean; smoothScaling?: boolean; debug: boolean; saves?: boolean } {
  try {
    const s = localStorage.getItem(PREFS_KEY)
    if (s) return { scale: 'fit', smooth: true, debug: false, ...(JSON.parse(s) as object) }
  } catch {
    // storage blocked
  }
  return { scale: 'fit', smooth: true, debug: false }
}

/**
 * Play mode: the game from the boot sequence on, full window, 480×272 scaled ×1 / ×2 / ×3 / to fit
 * with crisp pixels. Game logic lives in src/game (Game loop, GameScene machine, shared GameState);
 * this component only hosts the screen, the toolbar and the debug overlay.
 */
export function PlayView({ db, archives, loadFont, loadFile, onExit }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const gameRef = useRef<Game | null>(null)
  const [game, setGame] = useState<Game | null>(null)
  const [prefs, setPrefs] = useState(loadPrefs)
  const [fit, setFit] = useState(2)
  const [error, setError] = useState<string | null>(null)
  const [, setTick] = useState(0)
  const [audioOn, setAudioOn] = useState(false)

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
    } catch {
      // storage blocked
    }
    if (gameRef.current) {
      gameRef.current.ctx.screen.smooth = prefs.smooth
      gameRef.current.ctx.screen.smoothScaling = !!prefs.smoothScaling
    }
  }, [prefs])

  // the game: created once per disc
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let game: Game | null = null
    let detach = () => {}
    let cancelled = false
    void loadFont().then((font) => {
      if (cancelled) return
      try {
        const screen = new Screen(host)
        const assets = new GameAssets({ db, archives, font, file: loadFile })
        const audio = new AudioManager({ file: loadFile })
        const input = new PadInput()
        const state = new GameState(db)
        game = new Game({ state, assets, input, audio, screen }, createScene)
        screen.smooth = loadPrefs().smooth
        screen.smoothScaling = !!loadPrefs().smoothScaling
        detach = input.attach(window, (e) => {
          if (e.code === 'F2' || e.code === 'Backquote') {
            e.preventDefault()
            setPrefs((p) => ({ ...p, debug: !p.debug }))
          }
        })
        gameRef.current = game
        setGame(game)
        if (import.meta.env.DEV) (window as unknown as { __ncbGame?: Game }).__ncbGame = game
        game.start(GameScene.BOOT)
      } catch (e) {
        setError((e as Error).message)
      }
    })
    return () => {
      cancelled = true
      detach()
      if (game) {
        game.stop()
        game.ctx.audio.dispose()
        game.ctx.screen.dispose()
      }
      gameRef.current = null
      setGame(null)
      if (import.meta.env.DEV) delete (window as unknown as { __ncbGame?: Game }).__ncbGame
    }
  }, [db, archives, loadFont, loadFile])

  // the viewer underneath must not scroll while Play mode covers the window
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [])

  // the AudioContext may only start after a user gesture
  useEffect(() => {
    const wake = () => {
      const g = gameRef.current
      if (!g) return
      g.ctx.audio.resume()
      setAudioOn(g.ctx.audio.running)
    }
    window.addEventListener('keydown', wake)
    window.addEventListener('pointerdown', wake)
    return () => {
      window.removeEventListener('keydown', wake)
      window.removeEventListener('pointerdown', wake)
    }
  }, [])

  // fullscreen: the toolbar hides and slides in when the mouse reaches the top edge
  const [fullscreen, setFullscreen] = useState(false)
  const [barShown, setBarShown] = useState(false)
  const barRef = useRef<HTMLDivElement | null>(null)
  const onRootMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!fullscreen) return
      const barH = barRef.current?.offsetHeight ?? 40
      if (e.clientY <= 4) setBarShown(true)
      else if (e.clientY > barH + 8) setBarShown(false)
    },
    [fullscreen],
  )

  // integer scale that fits the window (in fullscreen the toolbar overlays the screen, so it takes no room)
  useEffect(() => {
    const measure = () => {
      const el = rootRef.current
      const fs = !!document.fullscreenElement
      setFullscreen(fs)
      if (!fs) setBarShown(false)
      const w = el?.clientWidth ?? window.innerWidth
      const h = (el?.clientHeight ?? window.innerHeight) - (fs ? 0 : 40)
      setFit(Math.max(1, Math.min(Math.floor(w / PSP_W), Math.floor(h / PSP_H))))
    }
    measure()
    window.addEventListener('resize', measure)
    document.addEventListener('fullscreenchange', measure)
    return () => {
      window.removeEventListener('resize', measure)
      document.removeEventListener('fullscreenchange', measure)
    }
  }, [])

  // debug overlay refresh (4 Hz)
  useEffect(() => {
    if (!prefs.debug) return
    const id = setInterval(() => setTick((t) => t + 1), 250)
    return () => clearInterval(id)
  }, [prefs.debug])

  const toggleFullscreen = useCallback(() => {
    const el = rootRef.current
    if (!el) return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void el.requestFullscreen?.()
  }, [])

  const scale = prefs.scale === 'fit' ? fit : prefs.scale
  const audio = game?.ctx.audio

  return (
    <div className={fullscreen ? 'play-root fs' : 'play-root'} ref={rootRef} onMouseMove={onRootMouseMove}>
      <div className={barShown ? 'play-toolbar shown' : 'play-toolbar'} ref={barRef}>
        <strong>Play</strong>
        <div className="seg" role="group" aria-label="Scale">
          {([1, 2, 3, 'fit'] as Scale[]).map((s) => (
            <button key={s} className={prefs.scale === s ? 'on' : ''} onClick={() => setPrefs((p) => ({ ...p, scale: s }))}>
              {s === 'fit' ? `fit (×${fit})` : `×${s}`}
            </button>
          ))}
        </div>
        <button onClick={toggleFullscreen}>Fullscreen</button>
        <label title="The GE filters textures bilinearly (sceGuTexFilter(1, 1)); off = nearest">
          <input type="checkbox" checked={prefs.smooth} onChange={(e) => setPrefs((p) => ({ ...p, smooth: e.target.checked }))} /> bilinear
        </label>
        <label title="How the 480×272 picture is scaled up to the window: off = crisp pixels, on = smoothed (like a PSP screen photo or a video capture)">
          <input type="checkbox" checked={!!prefs.smoothScaling} onChange={(e) => setPrefs((p) => ({ ...p, smoothScaling: e.target.checked }))} /> smooth scaling
        </label>
        {audio && (
          <>
            <label>
              <input type="checkbox" checked={!audio.settings.muted} onChange={(e) => (audio.update({ muted: !e.target.checked }), setTick((t) => t + 1))} /> sound
            </label>
            {(['master', 'bgm', 'se', 'voice'] as const).map((k) => (
              <label key={k} className="play-vol" title={`${k} volume`}>
                {k}
                <input type="range" min={0} max={1} step={0.05} value={audio.settings[k]} onChange={(e) => (audio.update({ [k]: Number(e.target.value) }), setTick((t) => t + 1))} />
              </label>
            ))}
            {!audioOn && <span className="muted small">press a key to start the sound</span>}
          </>
        )}
        <button className={prefs.saves ? 'on' : ''} onClick={() => setPrefs((p) => ({ ...p, saves: !p.saves }))} title="Save data in this browser: export / import CADATA.SAV files">
          Saves
        </button>
        <button className={prefs.debug ? 'on' : ''} onClick={() => setPrefs((p) => ({ ...p, debug: !p.debug }))} title="F2 or ` (backquote)">
          Debug
        </button>
        <span className="spacer" />
        <span className="muted small hide-sm">Arrows D-pad · X/Enter ✕ · O/Esc ○ · T △ · S □ · Q/E L/R · P/Space START · Tab SELECT</span>
        <button onClick={onExit}>Exit</button>
      </div>
      {error && <p className="warn">{error}</p>}
      <div className="play-stage">
        <div
          className="play-screen"
          ref={hostRef}
          style={{ width: PSP_W * scale, height: PSP_H * scale }}
          onPointerDown={(e) => {
            if (e.button === 2) {
              // right click: ○ (the browser's context menu is suppressed below)
              game?.ctx.input.rightClick()
              return
            }
            if (e.button === 1) {
              // middle click: skip dialogue like START (and no autoscroll)
              e.preventDefault()
              game?.ctx.input.middleClick()
              return
            }
            if (e.button !== 0) return
            const [x, y] = toVirtual(e)
            game?.ctx.input.click(x, y)
          }}
          onMouseDown={(e) => {
            if (e.button === 1) e.preventDefault()
          }}
          onContextMenu={(e) => e.preventDefault()}
          onPointerMove={(e) => {
            const [x, y] = toVirtual(e)
            game?.ctx.input.point(x, y)
          }}
          onPointerLeave={() => game?.ctx.input.point(null)}
          onWheel={(e) => game?.ctx.input.wheel(e.deltaY, e.deltaMode)}
        />
        {prefs.debug && game && <DebugOverlay game={game} />}
        {prefs.saves && <SavesPanel />}
      </div>
    </div>
  )
}

function DebugOverlay({ game }: { game: Game }) {
  const { state, input, audio } = game.ctx
  const p = state.profile
  const s = state.session
  const cleared = Array.from({ length: 18 }, (_, i) => i + 1).filter((k) => state.isCleared(k))
  let total = 0, kinds = 0
  for (let i = 1; i < p.cardCount.length; i++) {
    total += p.cardCount[i]
    if (p.cardCount[i]) kinds++
  }
  const info = SCENE_TABLE.find((x) => x.id === game.sceneId)
  const jump = (id: GameSceneId) => game.jump(id)
  return (
    <div className="play-debug">
      <div>
        <strong>
          {sceneName(game.sceneId)} (0x{game.sceneId.toString(16)})
        </strong>{' '}
        {game.scene.placeholder ? <span className="play-tag">placeholder</span> : <span className="play-tag ok">{info?.status ?? ''}</span>}
      </div>
      <div className="muted">{game.scene.debug?.() ?? ''}</div>
      <div>
        frame {game.frame} · in scene {game.sceneFrame} · {game.fps} fps{game.paused ? ' · PAUSED' : ''}
      </div>
      {game.error && <div className="warn">{game.error}</div>}
      <div>
        rand: gameRandNext s=0x{state.rng.s.toString(16)} t=0x{state.rng.t.toString(16)}
      </div>
      <div>
        pad held [{padNames(input.held)}]{input.gamepad ? ` · ${input.gamepad.slice(0, 24)}` : ''}
      </div>
      <div>
        profile "{p.name}" · {total} cards / {kinds} kinds · clear {cleared.length ? cleared.join(',') : '—'} · deck slot {p.curDeckSlot}
      </div>
      <div>decks: {state.decks.map((d, i) => `${i + 1}:${d.name || '—'}`).join(' · ')}</div>
      <div>
        session: stage {s.stageNo} (area {s.mapId}
        {s.mapVariant ? 'B' : 'A'}) · {modeName(s.gameMode)} · {s.playerNames.join(' vs ') || '—'}
        {s.lastResult ? ` · last: stage ${s.lastResult.stage} winner ${s.lastResult.winner} → ${sceneName(s.lastResult.exit)}` : ''}
      </div>
      <div className="muted">
        audio: {audio.running ? 'on' : 'waiting for a gesture'} · {audio.loadStatus} · BGM {audio.bgm ?? '—'} {audio.musicStatus}
      </div>
      <div className="muted">history: {game.history.slice(-6).map((h) => sceneName(h.to)).join(' → ')}</div>
      <div className="play-debug-row">
        <select value="" onChange={(e) => e.target.value && jump(Number(e.target.value) as GameSceneId)}>
          <option value="">Jump to scene…</option>
          {SCENE_TABLE.map((x) => (
            <option key={x.id} value={x.id}>
              0x{x.id.toString(16)} {x.name} ({x.status})
            </option>
          ))}
        </select>
        <button onClick={() => game.setPaused(!game.paused)}>{game.paused ? 'Resume' : 'Pause'}</button>
        <button onClick={() => game.step()} title="One frame (while paused)">
          Step
        </button>
        <button onClick={() => state.debugUnlockStages()} title="Debug: set the clear bits of stages 1–17">
          Unlock stages
        </button>
      </div>
    </div>
  )
}

/**
 * The save data kept in this browser (localStorage, CADATA.SAV layout, not encrypted): the three game
 * data slots and the continue data. Export writes the raw file (it opens in the viewer's save view);
 * import takes a decrypted CADATA.SAV (0x494 bytes into the chosen slot, 0x287CC bytes as continue data).
 */
function SavesPanel() {
  const [, setTick] = useState(0)
  const [msg, setMsg] = useState('')
  const refresh = () => setTick((t) => t + 1)
  const dirs = [...Array.from({ length: GAME_SLOTS }, (_, i) => slotDir(i)), CONTINUE_DIR]
  const download = (dir: string) => {
    const e = readSave(dir)
    if (!e) return
    const url = URL.createObjectURL(new Blob([e.bytes as BlobPart], { type: 'application/octet-stream' }))
    const a = document.createElement('a')
    a.href = url
    a.download = exportName(dir)
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const upload = (slot: number, f: File | undefined) => {
    if (!f) return
    void f.arrayBuffer().then((buf) => {
      try {
        const dir = importSave(new Uint8Array(buf), slot)
        setMsg(`Imported ${f.name} as ${dir}/CADATA.SAV.`)
      } catch (err) {
        setMsg((err as Error).message)
      }
      refresh()
    })
  }
  return (
    <div className="play-debug play-saves">
      <div>
        <strong>Save data</strong> <span className="muted">(this browser; CADATA.SAV layout, not encrypted)</span>
      </div>
      {dirs.map((dir, i) => {
        const e = readSave(dir)
        const cont = dir === CONTINUE_DIR
        return (
          <div key={dir} className="play-debug-row">
            <code>{dir}</code>
            <span className={e ? '' : 'muted'}>{e ? `${e.sfo?.savedataTitle ?? ''} · ${(e.sfo?.detail ?? '').split('\n')[0]}${e.sfo?.saved ? ` · ${new Date(e.sfo.saved).toLocaleString()}` : ''}` : cont ? 'no temporary data' : 'No Data'}</span>
            <button disabled={!e} onClick={() => download(dir)}>
              Export
            </button>
            <label className="button-like" title={cont ? 'A 0x287CC-byte file becomes the continue data' : 'A 0x494-byte file goes into this slot (a 0x287CC-byte one becomes the continue data)'}>
              Import
              <input type="file" accept=".sav,.bin" hidden onChange={(ev) => upload(cont ? 0 : i, ev.target.files?.[0])} />
            </label>
            <button
              disabled={!e}
              onClick={() => {
                if (window.confirm(`Delete ${dir}/CADATA.SAV from this browser?`)) {
                  deleteSave(dir)
                  refresh()
                }
              }}
            >
              Delete
            </button>
          </div>
        )
      })}
      {msg && <div className="muted">{msg}</div>}
    </div>
  )
}
