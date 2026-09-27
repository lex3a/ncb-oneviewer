import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DuelSession, type DuelMode, type UnitContext } from '../effect/duel'
import { UnitContextEditor } from './UnitContextEditor'
import { GlRenderer, type Vertex } from '../effect/gl'
import { EffectScene, VIRTUAL_H, VIRTUAL_W, type ObjectInfo } from '../effect/scene'
import { canvasToPng, download } from '../export'
import type { Card, GameDb } from '../formats/gamedb'
import type { OneArchive } from '../formats/one'
import { parseVagBank, type VagClip } from '../formats/vag'

interface Props {
  data: Uint8Array
  name: string
  /** effect.one entry of the script (1000 + effect id). */
  entryId: number
  /** effect.one: the script loads its images from here. */
  archive: OneArchive
  /** Reads snd/se.dat when it was loaded, for se_play. */
  loadSe?: () => Promise<Uint8Array | null>
  /** Reads gothic16.bin when it was loaded, for the duel windows. */
  loadFont?: () => Promise<Uint8Array | null>
  /** All loaded archives: the duel scene reads etc.one and unit.one. */
  archives: OneArchive[]
  db?: GameDb
}

interface Snapshot {
  frame: number
  status: string
  threads: { thread: number; pc: number; depth: number }[]
  log: string[]
  objects: ObjectInfo[]
}

interface Setup {
  mode: DuelMode
  left: number
  right: number
  side: 0 | 1
  /** Spell mode: the spell card whose HP change follows the effect. */
  spell: number
}

const SPEEDS = [0.25, 0.5, 1, 2]
const BACKGROUNDS: Record<string, [number, number, number]> = { black: [0, 0, 0], grey: [0.25, 0.25, 0.28], blue: [0.1, 0.14, 0.26] }
const FLAG_NAMES = ['pos', 'rgba', 'rot', 'scale']
const EMPTY: Snapshot = { frame: 0, status: 'paused', threads: [], log: [], objects: [] }

let audioCtx: AudioContext | null = null

function snapshot(s: DuelSession | null, playing: boolean): Snapshot {
  if (!s) return EMPTY
  const e = s.effect
  let status = playing ? 'playing' : 'paused'
  if (s.error) status = `error: ${s.error}`
  else if (s.finished) status = 'finished'
  else if (s.opts.mode !== 'none') status += ` · ${s.stage}`
  else if (e?.finished) status += ' · effect ended'
  return {
    frame: s.frame,
    status,
    threads: e?.vm.threads() ?? [],
    log: [...(e?.sounds ?? []), ...(e?.vm.log ?? [])].slice(-30),
    objects: e?.objectList() ?? [],
  }
}

/** Which card plays this effect: an attacking unit, a spell, or neither (map and result effects). */
function defaultSetup(db: GameDb | undefined, effectId: number): Setup {
  const users = db?.cards.filter((c) => c.battleEffect === effectId) ?? []
  const attacker = users.find((c) => c.type === 'unit' || c.type === 'chara')
  const spell = users.find((c) => c.type === 'spell')
  const foe = (id: number) => (id === 1 ? 2 : 1)
  if (attacker) return { mode: 'attack', left: attacker.id, right: foe(attacker.id), side: 0, spell: 0 }
  if (spell) return { mode: 'spell', left: 1001, right: 2, side: 1, spell: spell.id }
  return { mode: 'none', left: 1, right: 2, side: 0, spell: 0 }
}

/**
 * Runs a CAS1 script with the effect library and draws it at 60 frames per second. In duel modes the
 * duel scene is drawn behind it and its attack or spell timeline starts the effect, as in the game.
 */
export function EffectPlayer({ data, name, entryId, archive, loadSe, loadFont, archives, db }: Props) {
  const effectId = entryId - 1000
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const glRef = useRef<GlRenderer | null>(null)
  const sessionRef = useRef<DuelSession | null>(null)
  const [setup, setSetup] = useState<Setup>(() => defaultSetup(db, effectId))
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [loop, setLoop] = useState(true)
  const [bg, setBg] = useState('grey')
  const [markers, setMarkers] = useState(true)
  const [smooth, setSmooth] = useState(true)
  const [depth, setDepth] = useState(true)
  const [seClips, setSeClips] = useState<VagClip[] | null>(null)
  const [font, setFont] = useState<Uint8Array | null>(null)
  const [full, setFull] = useState(true)
  const [context, setContext] = useState<[UnitContext, UnitContext]>([{}, {}])
  const [muted, setMuted] = useState(false)
  const [glError, setGlError] = useState<string | null>(null)
  const [snap, setSnap] = useState<Snapshot>(EMPTY)
  const [missing, setMissing] = useState<string[]>([])
  const opts = useRef({ bg, markers, muted, smooth, depth, playing })
  useEffect(() => {
    opts.current = { bg, markers, muted, smooth, depth, playing }
  })

  useEffect(() => {
    let cancelled = false
    loadSe?.().then((b) => {
      if (!cancelled && b) setSeClips(parseVagBank(b))
    })
    return () => {
      cancelled = true
    }
  }, [loadSe])

  useEffect(() => {
    let cancelled = false
    loadFont?.().then((b) => {
      if (!cancelled) setFont(b)
    })
    return () => {
      cancelled = true
    }
  }, [loadFont])

  const draw = useCallback(() => {
    const gl = glRef.current
    const s = sessionRef.current
    if (!gl || !s) return
    gl.smooth = opts.current.smooth
    gl.depthTest = opts.current.depth
    gl.begin(BACKGROUNDS[opts.current.bg] ?? [0, 0, 0])
    if (s.opts.mode === 'none' && opts.current.markers && s.effect) drawMarkers(gl, s.effect, s.opts.side)
    s.render(gl)
    gl.end()
  }, [])

  const refresh = useCallback(() => setSnap(snapshot(sessionRef.current, opts.current.playing)), [])

  const restart = useCallback(() => {
    sessionRef.current?.effect?.stopSound()
    const all = archives.includes(archive) ? archives : [...archives, archive]
    const s = new DuelSession(
      all,
      { mode: setup.mode, leftCard: setup.left, rightCard: setup.right, side: setup.side, effectEntry: entryId, full, spellCard: setup.spell, db, font, context },
      (attackerSide, entry) => {
        const script = entry === entryId ? data : archive.entries.find((e) => e.id === entry)?.files.find((x) => x.kind === 'cas')?.data
        if (!script) return null
        return new EffectScene(archive, script, {
          attackerSide,
          seClips: seClips ?? undefined,
          audio: opts.current.muted ? null : audioCtx,
          snap: true,
        })
      },
    )
    sessionRef.current = s
    setMissing(s.missing)
    draw()
    refresh()
  }, [archive, archives, data, db, entryId, seClips, setup, full, font, context, draw, refresh])

  const initCanvas = useCallback((c: HTMLCanvasElement | null) => {
    canvasRef.current = c
    if (!c || glRef.current?.canvas === c) return
    try {
      glRef.current = new GlRenderer(c, VIRTUAL_W, VIRTUAL_H)
    } catch (e) {
      setGlError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    const id = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(id)
  }, [smooth, bg, markers, depth, draw])

  // A new script, setup or sound bank restarts the scene.
  useEffect(() => {
    const id = requestAnimationFrame(restart)
    return () => {
      cancelAnimationFrame(id)
      sessionRef.current?.effect?.stopSound()
    }
  }, [restart])

  useEffect(() => {
    sessionRef.current?.effect?.setAudio(muted ? null : audioCtx)
  }, [muted])

  useEffect(() => {
    if (!playing) return
    let raf = 0
    let last = performance.now()
    let acc = 0
    let pauseFrames = 0
    let uiCounter = 0
    const tick = (now: number) => {
      acc += ((now - last) / 1000) * 60 * speed
      last = now
      let steps = 0
      while (acc >= 1 && steps < 8) {
        acc -= 1
        steps++
        const s = sessionRef.current
        if (!s) break
        if (s.finished || s.error) {
          if (loop && !s.error) {
            if (++pauseFrames > 40) {
              pauseFrames = 0
              restart()
            }
          } else {
            setPlaying(false)
            refresh()
          }
          continue
        }
        s.step()
        s.effect?.setAudio(opts.current.muted ? null : audioCtx)
      }
      if (acc > 8) acc = 0
      if (steps) {
        draw()
        if (++uiCounter % 6 === 0) refresh()
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, speed, loop, draw, restart, refresh])

  const play = () => {
    if (!audioCtx && !muted) {
      try {
        audioCtx = new AudioContext()
      } catch {
        audioCtx = null
      }
    }
    void audioCtx?.resume()
    const s = sessionRef.current
    if (!s || s.finished || s.error) restart()
    setPlaying((p) => !p)
  }

  const stepOnce = () => {
    setPlaying(false)
    sessionRef.current?.step()
    draw()
    refresh()
  }

  const savePng = () => {
    if (canvasRef.current) download(canvasToPng(canvasRef.current), `${name}_f${snap.frame}.png`, 'image/png')
  }

  const fighters = useMemo(() => (db?.cards ?? []).filter((c) => c.type !== 'spell').sort((a, b) => a.no - b.no), [db])
  const cardPicker = (value: number, onChange: (v: number) => void, filter: (c: Card) => boolean) =>
    db ? (
      <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {fighters.filter(filter).map((c) => (
          <option key={c.id} value={c.id}>
            {c.name} ({c.id})
          </option>
        ))}
      </select>
    ) : (
      <input type="number" value={value} style={{ width: 70 }} onChange={(e) => onChange(Number(e.target.value) || 1)} title="unit.one card id" />
    )
  const canAttack = (c: Card) => c.type !== 'base'
  const set = (patch: Partial<Setup>) => {
    setPlaying(false)
    if (patch.left !== undefined) setContext((c) => [{}, c[1]])
    if (patch.right !== undefined) setContext((c) => [c[0], {}])
    setSetup((s) => ({ ...s, ...patch }))
  }
  const users = db?.cards.filter((c) => c.battleEffect === effectId || (c.mapEffect === effectId && (c.type === 'spell' || c.type === 'base')))

  return (
    <div className="viewer">
      <div className="toolbar">
        <button className="primary" onClick={play} disabled={!!glError}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <button onClick={stepOnce} disabled={!!glError}>
          Step
        </button>
        <button
          onClick={() => {
            setPlaying(false)
            restart()
          }}
        >
          Restart
        </button>
        <div className="seg">
          {SPEEDS.map((s) => (
            <button key={s} className={speed === s ? 'on' : ''} onClick={() => setSpeed(s)}>
              {s}×
            </button>
          ))}
        </div>
        <label>
          <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> loop
        </label>
        <label title={seClips ? `${seClips.length} clips from se.dat` : 'Load snd/se.dat (or the ISO) for sound'}>
          <input type="checkbox" checked={!muted && !!seClips} onChange={(e) => setMuted(!e.target.checked)} disabled={!seClips} /> sound
        </label>
        <button onClick={savePng}>PNG</button>
      </div>
      <div className="toolbar">
        <div className="seg" title="What is drawn behind the effect">
          {(
            [
              ['none', 'Effect only'],
              ['attack', 'Duel: attack'],
              ['spell', 'Duel: spell'],
            ] as const
          ).map(([m, l]) => (
            <button key={m} className={setup.mode === m ? 'on' : ''} onClick={() => set({ mode: m })}>
              {l}
            </button>
          ))}
        </div>
        {setup.mode === 'attack' && (
          <label title="Intro, ability pop-ups, counter-attack, HP drain, death and the end hold">
            <input type="checkbox" checked={full} onChange={(e) => { setPlaying(false); setFull(e.target.checked) }} /> full duel
          </label>
        )}
        {setup.mode === 'spell' && db && (
          <label title="Spell card: its HP change follows the effect">
            spell{' '}
            <select value={setup.spell} onChange={(e) => set({ spell: Number(e.target.value) })}>
              <option value={0}>(none)</option>
              {db.cards.filter((c) => c.type === 'spell').map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {setup.mode !== 'none' && (
          <>
            <label>
              left {cardPicker(setup.left, (v) => set({ left: v }), setup.mode === 'attack' && setup.side === 0 ? canAttack : () => true)}
            </label>
            <label>
              right {cardPicker(setup.right, (v) => set({ right: v }), setup.mode === 'attack' && setup.side === 1 ? canAttack : () => true)}
            </label>
          </>
        )}
        <label title={setup.mode === 'spell' ? 'Target of the spell' : 'battle_get_defender_side: which side attacks'}>
          {setup.mode === 'spell' ? 'target' : 'attacker'}{' '}
          <select value={setup.side} onChange={(e) => set({ side: Number(e.target.value) as 0 | 1 })}>
            <option value={0}>left</option>
            <option value={1}>right</option>
          </select>
        </label>
        {setup.mode === 'none' ? (
          <>
            <label>
              background{' '}
              <select value={bg} onChange={(e) => setBg(e.target.value)}>
                {Object.keys(BACKGROUNDS).map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </label>
            <label title="Where the two combatants stand (battle_get_side_pos), seen through camera 0">
              <input type="checkbox" checked={markers} onChange={(e) => setMarkers(e.target.checked)} /> combatants
            </label>
          </>
        ) : (
          <label title="GE depth buffer: 3D effects are hidden behind the solid pixels of the units and the HUD (derived from code, not compared with the real screen)">
            <input type="checkbox" checked={depth} onChange={(e) => setDepth(e.target.checked)} /> depth test
          </label>
        )}
        <label title="The GE samples textures bilinearly">
          <input type="checkbox" checked={smooth} onChange={(e) => setSmooth(e.target.checked)} /> bilinear
        </label>
      </div>
      <div className="split">
        <div className="stage">
          {glError ? <p className="warn">{glError}</p> : <canvas ref={initCanvas} width={960} height={544} className="effect-canvas" />}
          <p className="muted">
            frame {snap.frame} · {(snap.frame / 60).toFixed(2)} s · {snap.status}
            {!seClips && ' · load snd/se.dat for sound'}
          </p>
          {setup.mode !== 'none' && (
            <div className="ctx-row">
              {([0, 1] as const).map((s) => (
                <UnitContextEditor
                  key={`${s}-${s ? setup.right : setup.left}`}
                  label={s ? 'Right' : 'Left'}
                  card={db?.byId.get(s ? setup.right : setup.left)}
                  db={db}
                  value={context[s]}
                  onChange={(v) => {
                    setPlaying(false)
                    setContext((c) => (s ? [c[0], v] : [v, c[1]]))
                  }}
                />
              ))}
            </div>
          )}
          {missing.length > 0 && <p className="warn">Not loaded: {missing.join(', ')}. Open the ISO or the data folder for the duel scene.</p>}
          {users && users.length > 0 && <p className="muted">Played by: {users.map((c) => c.name).join(', ')}</p>}
        </div>
        <aside className="side effect-side">
          <h4>Threads</h4>
          <div className="mono small">
            {snap.threads.length ? (
              snap.threads.map((t) => (
                <div key={t.thread}>
                  #{t.thread} pc {t.pc} depth {t.depth}
                </div>
              ))
            ) : (
              <span className="muted">none</span>
            )}
          </div>
          <h4>Objects ({snap.objects.length})</h4>
          <table className="grid mono small">
            <thead>
              <tr>
                <th>#</th>
                <th className="left">type</th>
                <th>cam</th>
                <th className="left">x d h</th>
                <th className="left">rgba</th>
                <th className="left">tween</th>
              </tr>
            </thead>
            <tbody>
              {snap.objects.map((o) => (
                <tr key={o.index} className={o.visible ? '' : 'muted'}>
                  <td>{o.index}</td>
                  <td className="left">{o.type}</td>
                  <td>{o.camera}</td>
                  <td className="left">{o.pos.map((v) => Math.round(v)).join(' ')}</td>
                  <td className="left">{o.rgba.map((v) => Math.round(v)).join(' ')}</td>
                  <td className="left">{FLAG_NAMES.filter((_, i) => o.tweens & (1 << i)).join(' ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h4>Sound and log</h4>
          <div className="mono small">
            {snap.log.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  )
}

/** Small diamonds where the attacker (red) and defender (blue) stand, projected with camera 0. */
function drawMarkers(gl: GlRenderer, scene: EffectScene, attacker: 0 | 1) {
  const pos = attacker === 0 ? [[-40, 32, 0], [40, -16, 16]] : [[40, 32, 0], [-40, -16, 16]]
  pos.forEach(([x, d, h], i) => {
    const p = scene.projectWorld(scene.cams[0], [x, -h, -d])
    if (!p) return
    const r = 6
    const v = (dx: number, dy: number): Vertex => ({ x: p.x + dx, y: p.y + dy, w: 1, d: 1, u: 0, v: 0 })
    const col: [number, number, number, number] = i === 0 ? [1, 0.3, 0.3, 0.8] : [0.3, 0.6, 1, 0.8]
    gl.triangles(null, 'alpha', [v(0, -r), v(r, 0), v(0, r), v(0, -r), v(0, r), v(-r, 0)], col)
  })
}
