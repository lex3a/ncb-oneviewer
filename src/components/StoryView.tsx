import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GlRenderer } from '../effect/gl'
import { VIRTUAL_H, VIRTUAL_W } from '../effect/scene'
import { MusicPlayer, type MusicLoader } from '../effect/music'
import { StoryPlayer, storyTitle } from '../effect/story'
import type { GameDb, StoryScript, StoryTrigger } from '../formats/gamedb'
import type { OneArchive } from '../formats/one'
import { parseVagBank, type VagClip } from '../formats/vag'

interface Props {
  db: GameDb
  archives: OneArchive[]
  loadFont?: () => Promise<Uint8Array | null>
  loadVoices?: () => Promise<Uint8Array | null>
  /** Reads at3/BGM_nn.at3 by file name. */
  loadMusic?: MusicLoader
}

const GROUPS: [StoryTrigger, string][] = [
  ['prologue', 'Prologue'],
  ['stageStart', 'Before the battle'],
  ['turnStart', 'During the battle (turn start)'],
  ['afterWin', 'After a win'],
  ['afterLoss', 'After a loss'],
  ['stageClear', 'Stage clear'],
]

let audioCtx: AudioContext | null = null

/** The story scenes of g_apMsgEventTables, replayed by StoryPlayer (docs/formats/story.md). */
export function StoryView({ db, archives, loadFont, loadVoices, loadMusic }: Props) {
  const [sel, setSel] = useState<StoryScript>(db.stories[0])
  const [font, setFont] = useState<Uint8Array | null>(null)
  const [voices, setVoices] = useState<VagClip[] | null>(null)
  const [playing, setPlaying] = useState(false)
  const [auto, setAuto] = useState(true)
  const [muted, setMuted] = useState(false)
  const [snap, setSnap] = useState({ frame: 0, index: 0, finished: false, bgm: null as string | null })
  const glRef = useRef<GlRenderer | null>(null)
  const playerRef = useRef<StoryPlayer | null>(null)
  const [glError, setGlError] = useState<string | null>(null)
  const [musicOn, setMusicOn] = useState(true)
  const [musicStatus, setMusicStatus] = useState('')
  const music = useMemo(() => new MusicPlayer(loadMusic ?? (async () => null), setMusicStatus), [loadMusic])
  const musicOnRef = useRef(musicOn)
  useEffect(() => {
    musicOnRef.current = musicOn
  })
  /** Follow the script's BGM commands (cmd 22 play, cmd 23 stop). */
  const syncMusic = useCallback(() => {
    const p = playerRef.current
    void music.set(musicOnRef.current && p ? p.bgm : null, audioCtx)
  }, [music])

  useEffect(() => {
    let cancelled = false
    loadFont?.().then((b) => !cancelled && setFont(b))
    loadVoices?.().then((b) => !cancelled && b && setVoices(parseVagBank(b)))
    return () => {
      cancelled = true
    }
  }, [loadFont, loadVoices])

  const refresh = useCallback(() => {
    const p = playerRef.current
    if (p) setSnap({ frame: p.frame, index: p.index, finished: p.finished, bgm: p.bgm })
  }, [])

  const draw = useCallback(() => {
    const gl = glRef.current, p = playerRef.current
    if (!gl || !p) return
    gl.depthTest = false
    gl.begin([0, 0, 0])
    p.render(gl)
    gl.end()
  }, [])

  const restart = useCallback(() => {
    playerRef.current?.stopVoice()
    music.reset()
    playerRef.current = new StoryPlayer(sel, { archives, db, font, voices, audio: muted ? null : audioCtx, autoDelay: auto ? 60 : null })
    draw()
    refresh()
  }, [sel, archives, db, font, voices, muted, auto, draw, refresh, music])

  useEffect(() => {
    const id = requestAnimationFrame(restart)
    return () => {
      cancelAnimationFrame(id)
      playerRef.current?.stopVoice()
      music.reset()
    }
  }, [restart, music])

  useEffect(() => {
    musicOnRef.current = musicOn
    syncMusic()
  }, [musicOn, syncMusic])

  const initCanvas = useCallback((c: HTMLCanvasElement | null) => {
    if (!c || glRef.current?.canvas === c) return
    try {
      glRef.current = new GlRenderer(c, VIRTUAL_W, VIRTUAL_H)
    } catch (e) {
      setGlError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    if (!playing) return
    let raf = 0, last = performance.now(), acc = 0, ui = 0
    const tick = (now: number) => {
      acc += ((now - last) / 1000) * 60
      last = now
      let n = 0
      while (acc >= 1 && n < 8) {
        acc -= 1
        n++
        const p = playerRef.current
        if (!p || p.finished) {
          setPlaying(false)
          break
        }
        p.step()
      }
      if (acc > 8) acc = 0
      if (n) {
        draw()
        syncMusic()
        if (++ui % 10 === 0) refresh()
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, draw, refresh, syncMusic])

  /** The AudioContext is made on the first user gesture (browsers keep it suspended otherwise). */
  const ensureAudio = () => {
    if (audioCtx) return
    try {
      audioCtx = new AudioContext()
    } catch {
      audioCtx = null
    }
  }

  const play = () => {
    ensureAudio()
    const p = playerRef.current
    if (!p || p.finished) restart()
    playerRef.current?.setAudio(muted ? null : audioCtx)
    // Pausing suspends the audio clock, so the voice and the music stop where they are.
    if (playing) void audioCtx?.suspend()
    else void audioCtx?.resume()
    setPlaying((x) => !x)
  }

  const groups = useMemo(() => GROUPS.map(([t, l]) => [l, db.stories.filter((s) => s.trigger === t)] as const), [db])
  const speaker = (id: number) => (id ? db.byId.get(id)?.name ?? `#${id}` : 'Narrator')
  const lines = sel.records.map((r, i) => ({ r, i })).filter(({ r }) => r.cmd === 0)

  return (
    <div className="split">
      <div className="stage">
        <div className="toolbar">
          <button className="primary" onClick={play} disabled={!!glError}>
            {playing ? 'Pause' : 'Play'}
          </button>
          <button onClick={() => playerRef.current?.press()} title="✕: finish the text, stop the voice, next line">
            Next ✕
          </button>
          <button onClick={() => playerRef.current?.skip()} title="START: skip to the end of the scene">
            Skip
          </button>
          <button
            onClick={() => {
              setPlaying(false)
              restart()
            }}
          >
            Restart
          </button>
          <label title="Advance speaker lines 60 frames after the text and the voice are done (narration uses the game's own timer)">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> auto
          </label>
          <label title={voices ? `${voices.length} clips from goc.dat` : 'Load snd/goc.dat (or the ISO) for voices'}>
            <input type="checkbox" checked={!muted && !!voices} disabled={!voices} onChange={(e) => setMuted(!e.target.checked)} /> voice
          </label>
          <label title="Story BGM (at3/BGM_nn.at3), decoded with ffmpeg on first use and looped">
            <input type="checkbox" checked={musicOn} onChange={(e) => setMusicOn(e.target.checked)} /> music
          </label>
        </div>
        {glError ? <p className="warn">{glError}</p> : <canvas ref={initCanvas} width={960} height={544} className="effect-canvas" />}
        <p className="muted">
          {storyTitle(sel, db)} · {(snap.frame / 60).toFixed(1)} s · record {Math.min(snap.index + 1, sel.records.length)}/{sel.records.length}
          {snap.finished ? ' · finished' : ''}
          {snap.bgm ? ` · BGM ${musicStatus || snap.bgm}` : ''}
          {!font && ' · load gothic16.bin for text'}
          {!voices && ' · load goc.dat for voices'}
        </p>
        <ol className="transcript">
          {lines.map(({ r, i }) => (
            <li key={i} className={snap.index === i ? 'on' : snap.index > i ? '' : 'muted'}>
              <strong>{speaker(r.arg)}</strong>
              {r.voice ? <span className="muted"> ({r.voice})</span> : null}: <span className="pre">{r.text || '(empty)'}</span>
            </li>
          ))}
        </ol>
      </div>
      <aside className="side db-side">
        {groups.map(([label, list]) => (
          <div key={label}>
            <h4>{label}</h4>
            <ul className="plain story-list">
              {list.map((s, i) => (
                <li key={i}>
                  <button
                    className={`link${s === sel ? ' on' : ''}`}
                    onClick={() => {
                      // picking a scene plays it at once (the click is the gesture that may start the audio)
                      ensureAudio()
                      void audioCtx?.resume()
                      if (s === sel) restart()
                      else setSel(s)
                      setPlaying(true)
                    }}
                  >
                    {storyTitle(s, db)}
                  </button>
                  <span className="muted small"> {s.records.filter((r) => r.cmd === 0).length} lines</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </aside>
    </div>
  )
}
