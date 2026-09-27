import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import {
  drawStaffRoll,
  PAD,
  plainText,
  readExtrasTables,
  RulesHelpScene,
  STAFF_DRAWN,
  STAFF_LOADED,
  STAFF_TIMEOUT,
  STAFF_VOICE,
  staffSchedule,
  StaffRollScene,
  type PadFrame,
} from '../effect/extras'
import { GlRenderer } from '../effect/gl'
import { VIRTUAL_H, VIRTUAL_W } from '../effect/scene'
import { loadWinSkins, readWinTables, WindowPainter } from '../effect/windows'
import type { GameDb } from '../formats/gamedb'
import { gbpToImage, parseGbp } from '../formats/gbp'
import type { OneArchive } from '../formats/one'
import type { RgbaImage } from '../formats/palette'
import { decodeVag, parseVagBank, type VagClip } from '../formats/vag'

interface Props {
  db: GameDb
  archives: OneArchive[]
  loadFont?: () => Promise<Uint8Array | null>
  loadVoices?: () => Promise<Uint8Array | null>
}

type Screen = 'help' | 'staff'

const FRAME_MS = 1000 / 60

/** Keyboard → PSP pad bit. */
const KEYS: Record<string, number> = {
  ArrowUp: PAD.UP,
  ArrowDown: PAD.DOWN,
  x: PAD.CROSS,
  Enter: PAD.CROSS,
  ' ': PAD.CROSS,
  o: PAD.CIRCLE,
  Escape: PAD.CIRCLE,
  Backspace: PAD.CIRCLE,
  s: PAD.SQUARE,
  p: PAD.START,
}

let audioCtx: AudioContext | null = null

/** The shared AudioContext, created on the first user gesture. */
function ensureAudio() {
  if (!audioCtx) {
    try {
      audioCtx = new AudioContext()
    } catch {
      audioCtx = null
    }
  }
  void audioCtx?.resume()
}

/** A labelled stand-in for etc.one 1000 member i+1 (the entry is not on the disc). */
function placeholder(i: number, sched: ReturnType<typeof staffSchedule>[number] | undefined): RgbaImage {
  const c = document.createElement('canvas')
  c.width = 480
  c.height = 272
  const g = c.getContext('2d')!
  const hue = (i * 47) % 360
  const grad = g.createLinearGradient(0, 0, 0, 272)
  grad.addColorStop(0, `hsl(${hue} 45% 22%)`)
  grad.addColorStop(1, `hsl(${hue} 45% 10%)`)
  g.fillStyle = grad
  g.fillRect(0, 0, 480, 272)
  g.strokeStyle = `hsl(${hue} 60% 60%)`
  g.lineWidth = 2
  g.strokeRect(12, 12, 456, 248)
  g.fillStyle = '#fff'
  g.textAlign = 'center'
  g.font = 'bold 26px sans-serif'
  g.fillText(`Staff roll image ${i + 1}`, 240, 100)
  g.font = '15px sans-serif'
  g.fillText(`etc.one entry 1000, member ${i + 1}`, 240, 135)
  g.fillStyle = `hsl(${hue} 70% 80%)`
  g.fillText('placeholder: this entry is not on the retail UMD', 240, 160)
  if (sched) {
    const s = sched.opaqueTo - sched.opaqueFrom
    g.fillStyle = '#ccc'
    g.fillText(s > 100000 ? `frames ${sched.first}– (until the fade), opaque from ${sched.opaqueFrom}` : `frames ${sched.first}–${sched.last}, opaque ${sched.opaqueFrom}–${sched.opaqueTo}`, 240, 200)
  }
  const d = g.getImageData(0, 0, 480, 272)
  return { width: 480, height: 272, rgba: new Uint8ClampedArray(d.data.buffer) as unknown as RgbaImage['rgba'] }
}

/**
 * Card database → Extras: the unreachable "How to play" viewer (rulesHelpScene, scene 400) and the
 * staff roll (staffRollScene, scene 2000), 480×272 at 2×, keyboard-driven like the PSP pad.
 */
export function ExtrasView({ db, archives, loadFont, loadVoices }: Props) {
  const [screen, setScreen] = useState<Screen>('help')
  const [font, setFont] = useState<Uint8Array | null>(null)
  const [voices, setVoices] = useState<VagClip[] | null>(null)
  const [glError, setGlError] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [log, setLog] = useState<string[]>([])
  const [restart, setRestart] = useState(0)
  const [paused, setPaused] = useState(false)
  const [glow, setGlow] = useState<'ge' | 'intended'>('ge')
  const [sound, setSound] = useState(true)
  const [showText, setShowText] = useState(false)
  const [jump, setJump] = useState(100)

  useEffect(() => {
    let live = true
    loadFont?.().then((f) => live && setFont(f))
    loadVoices?.().then((b) => live && b && setVoices(parseVagBank(b)))
    return () => {
      live = false
    }
  }, [loadFont, loadVoices])

  const image = useCallback(
    (archive: string, entry: number, member: number): RgbaImage | null => {
      const a = archives.find((x) => x.name.toLowerCase() === archive)
      const f = a?.entries.find((e) => e.id === entry)?.files.find((x) => x.subId === member)
      return f?.data.length && f.kind === 'gbp' ? gbpToImage(parseGbp(f.data)) : null
    },
    [archives],
  )
  const winTables = useMemo(() => readWinTables(db), [db])
  const tables = useMemo(() => readExtrasTables(db), [db])
  const painter = useMemo(() => new WindowPainter({ skins: loadWinSkins(image), font, tables: winTables }), [image, font, winTables])
  const schedule = useMemo(() => staffSchedule(tables.staffSeconds), [tables])
  // etc.one 1000 members 1..20 if a disc ever has them, else placeholders
  const staffImages = useMemo(
    () => Array.from({ length: STAFF_LOADED }, (_, i) => image('etc.one', 1000, i + 1) ?? placeholder(i, schedule[i])),
    [image, schedule],
  )
  const realImages = useMemo(() => staffImages.filter((_, i) => image('etc.one', 1000, i + 1)).length, [staffImages, image])

  const helpRef = useRef<RulesHelpScene | null>(null)
  const staffRef = useRef<StaffRollScene | null>(null)
  useEffect(() => {
    helpRef.current = new RulesHelpScene(tables, winTables)
    staffRef.current = new StaffRollScene(tables.staffSeconds)
  }, [tables, winTables, restart, screen])

  // ---- voice (sndPlayVoiceVag 500 / sndStopVoice) ----
  const voiceNode = useRef<AudioBufferSourceNode | null>(null)
  const stopVoice = useCallback(() => {
    try {
      voiceNode.current?.stop()
    } catch {
      // already stopped
    }
    voiceNode.current = null
  }, [])
  const voicesRef = useRef(voices)
  const soundRef = useRef(sound)
  useEffect(() => {
    voicesRef.current = voices
    soundRef.current = sound
  }, [voices, sound])
  const playVoice = useCallback(() => {
    stopVoice()
    const clip = voicesRef.current?.[STAFF_VOICE - 1]
    if (!clip || !soundRef.current || !audioCtx) return
    const s = decodeVag(clip.data).samples
    const buf = audioCtx.createBuffer(1, Math.max(1, s.length), clip.rate)
    const ch = buf.getChannelData(0)
    for (let i = 0; i < s.length; i++) ch[i] = s[i] / 32768
    const node = audioCtx.createBufferSource()
    node.buffer = buf
    node.connect(audioCtx.destination)
    node.start()
    voiceNode.current = node
  }, [stopVoice])
  useEffect(() => stopVoice, [stopVoice, screen, restart])

  const glRef = useRef<GlRenderer | null>(null)
  const initCanvas = useCallback((c: HTMLCanvasElement | null) => {
    if (!c || glRef.current?.canvas === c) return
    try {
      glRef.current = new GlRenderer(c, VIRTUAL_W, VIRTUAL_H)
    } catch (e) {
      setGlError((e as Error).message)
    }
  }, [])

  const queue = useRef<{ bit: number; repeat: boolean }[]>([])
  const held = useRef(0)
  const live = useRef({ painter, staffImages, glow, screen, paused, playVoice, stopVoice, db })
  useEffect(() => {
    live.current = { painter, staffImages, glow, screen, paused, playVoice, stopVoice, db }
  })

  // 60 Hz: one scene frame with the pad state, then the draw calls on a black frame (guClear).
  useEffect(() => {
    let raf = 0, last = performance.now(), acc = FRAME_MS, ui = 0
    const step = () => {
      const gl = glRef.current
      const L = live.current
      if (!gl) return
      const ev = queue.current.shift()
      const pad: PadFrame = { pressed: ev && !ev.repeat ? ev.bit : 0, repeat: ev ? ev.bit : 0, held: held.current | (ev ? ev.bit : 0) }
      gl.depthTest = false
      gl.begin([0, 0, 0])
      if (L.screen === 'help') {
        const h = helpRef.current
        if (h) {
          h.step(pad)
          if (h.exited) {
            h.exited = false
            setLog((l) => [...l.slice(-4), 'Circle: rulesHelpScene returns 1 → the title screen (scene 0x32); the viewer reopens the list'])
          }
          h.draw(gl, L.painter)
          if (++ui % 6 === 0) {
            const se = h.se.map((s) => `${s.ui ? 'sndPlaySeUi' : 'sndPlaySe'}(${s.id})`).slice(-3).join(', ')
            setStatus(`state ${h.state} · topic ${h.topic + 1} · cursor ${(h.list?.cursor ?? 0) + 1} · list brightness ${h.list?.win.bright ?? '-'}${se ? ` · SE: ${se}` : ''}`)
          }
        }
      } else {
        const s = staffRef.current
        if (s) {
          if (!L.paused || pad.pressed) s.step(pad.pressed)
          for (const e of s.events) {
            if (e === 'voice') L.playVoice()
            else L.stopVoice()
          }
          s.events = []
          if (s.done) {
            s.done = false
            setLog((l) => [...l.slice(-4), 'Roll over: g_mapStageNo = 0x10, scene 1000 (save game); the viewer restarts the roll'])
          }
          drawStaffRoll(gl, s, L.staffImages, { glow: L.glow })
          if (++ui % 6 === 0) {
            const shown = s.shown.map((x) => `${x.index + 1}${x.glow ? ` (α ${x.alpha})` : ''}`).join(', ')
            setStatus(`state ${s.state} · frame ${s.frameCount} / ${STAFF_TIMEOUT} · image ${shown || '—'}${s.fade ? ` · fade ${s.fade}/128` : ''}`)
          }
        }
      }
      gl.end()
    }
    const loop = (t: number) => {
      acc += Math.min(t - last, 100)
      last = t
      let n = 0
      while (acc >= FRAME_MS && n < 4) {
        step()
        acc -= FRAME_MS
        n++
      }
      if (n === 4) acc = 0
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  const push = (bit: number, repeat = false) => {
    ensureAudio()
    if (queue.current.length < 8) queue.current.push({ bit, repeat })
  }
  const onKey = (e: KeyboardEvent) => {
    const bit = KEYS[e.key] ?? KEYS[e.key.toLowerCase()]
    if (!bit) return
    e.preventDefault()
    // the staff roll only reads START; Enter / Space / X also skip there
    const b = screen === 'staff' && bit === PAD.CROSS ? PAD.START : bit
    held.current |= b
    push(b, e.repeat)
  }
  const onKeyUp = (e: KeyboardEvent) => {
    const bit = KEYS[e.key] ?? KEYS[e.key.toLowerCase()]
    if (bit) held.current &= ~(screen === 'staff' && bit === PAD.CROSS ? PAD.START : bit)
  }

  /** Viewer only: a click on a topic moves the cursor there, a click on the selected topic (or on the text) is ✕. */
  const onClick = (e: MouseEvent<HTMLCanvasElement>) => {
    e.currentTarget.parentElement?.focus()
    ensureAudio()
    if (screen !== 'help') return
    const h = helpRef.current
    if (!h) return
    const r = e.currentTarget.getBoundingClientRect()
    const vx = ((e.clientX - r.left) / r.width) * 640, vy = ((e.clientY - r.top) / r.height) * 448
    if (h.state === 2) {
      push(PAD.CROSS)
      return
    }
    const row = h.rowAt(vx, vy)
    if (row < 0) return
    if (row === h.list?.cursor) push(PAD.CROSS)
    else h.setCursor(row)
  }
  const onContext = (e: MouseEvent<HTMLCanvasElement>) => {
    if (screen !== 'help') return
    e.preventDefault()
    push(PAD.CIRCLE)
  }

  /** Viewer: run the roll forward to a frame (the scene has no seek; this steps it without drawing). */
  const seek = (frame: number) => {
    const s = new StaffRollScene(tables.staffSeconds)
    while (s.frameCount < frame && s.state !== 2) s.step(0)
    s.events = []
    staffRef.current = s
    stopVoice()
  }

  const btn = (label: string, bit: number, title: string) => (
    <button key={label} onClick={() => push(bit)} title={title}>
      {label}
    </button>
  )
  const voiceLine = db.voices.get(STAFF_VOICE)
  const missing = [!image('option.one', 20, 8) && 'option.one', !image('etc.one', 1, 4) && 'etc.one', !font && 'gothic16.bin'].filter(Boolean)
  const helpText = useMemo(() => tables.topics.map((t, i) => `${plainText(t)}\n${'-'.repeat(plainText(t).length)}\n${plainText(tables.texts[i])}`).join('\n\n'), [tables])

  return (
    <div className="card-screen">
      <div className="toolbar">
        <div className="seg" role="group" aria-label="Screen">
          <button className={screen === 'help' ? 'on' : ''} onClick={() => setScreen('help')} title="rulesHelpScene (map Help command; scene 400)">
            How to play
          </button>
          <button className={screen === 'staff' ? 'on' : ''} onClick={() => setScreen('staff')} title="staffRollScene (scene 2000, unreachable)">
            Staff roll
          </button>
        </div>
        <button onClick={() => { setRestart((n) => n + 1); setLog([]) }} title="Restart the scene (state 0)">
          Restart
        </button>
        {screen === 'staff' && (
          <>
            <button className={paused ? 'on' : ''} onClick={() => setPaused((p) => !p)} title="Viewer: pause the roll">
              {paused ? 'Paused' : 'Pause'}
            </button>
            <label title="Viewer: run the roll forward to this frame counter value (DAT_089B60A0)">
              frame{' '}
              <input type="number" min={1} max={STAFF_TIMEOUT + 130} value={jump} style={{ width: '6em' }} onChange={(e) => setJump(Number(e.target.value))} onKeyDown={(e) => e.key === 'Enter' && seek(jump)} />
            </label>
            <button onClick={() => seek(jump)} title="Viewer: run the roll forward to this frame">
              Go
            </button>
            <label title="Viewer: jump to an image">
              <select value="" onChange={(e) => e.target.value && seek(Number(e.target.value))}>
                <option value="">image…</option>
                {schedule.slice(0, 17).map((s) => (
                  <option key={s.index} value={s.opaqueFrom}>
                    {s.index + 1} (frame {s.opaqueFrom})
                  </option>
                ))}
                <option value={STAFF_TIMEOUT - 30}>the fade ({STAFF_TIMEOUT - 30})</option>
              </select>
            </label>
            <label title="The fade-in / fade-out copies: alpha a/10 has alpha nibble 1, which the GE alpha test (> 0x28) discards">
              glow{' '}
              <select value={glow} onChange={(e) => setGlow(e.target.value as 'ge' | 'intended')}>
                <option value="ge">as the GE draws it (invisible)</option>
                <option value="intended">as intended (additive copies)</option>
              </select>
            </label>
            <label title={voices ? `goc.dat clip ${STAFF_VOICE - 1}` : 'Load snd/goc.dat (or the ISO) for the voice'}>
              <input type="checkbox" checked={sound && !!voices} disabled={!voices} onChange={(e) => setSound(e.target.checked)} /> voice {STAFF_VOICE}
            </label>
          </>
        )}
        {screen === 'help' && (
          <button className={showText ? 'on' : ''} onClick={() => setShowText((v) => !v)} title="All 15 topics as plain text">
            Plain text
          </button>
        )}
      </div>
      {glError ? (
        <p className="warn">{glError}</p>
      ) : (
        <div tabIndex={0} onKeyDown={onKey} onKeyUp={onKeyUp} style={{ position: 'relative', width: 960, maxWidth: '100%', outline: 'none' }} className="extras-screen">
          <canvas ref={initCanvas} width={480} height={272} className="card-screen-canvas" onClick={onClick} onContextMenu={onContext} />
        </div>
      )}
      <div className="card-screen-controls">
        {screen === 'help' ? (
          <>
            {btn('↑', PAD.UP, 'Up (↑)')}
            {btn('↓', PAD.DOWN, 'Down (↓)')}
            {btn('✕', PAD.CROSS, 'Cross: X / Enter / Space')}
            {btn('○', PAD.CIRCLE, 'Circle: O / Esc / Backspace')}
          </>
        ) : (
          btn('START', PAD.START, 'START: P / Enter / Space / X')
        )}
        <span className="muted">{status}</span>
      </div>
      {screen === 'help' ? (
        <p className="muted">
          Click the screen, then: ↑/↓ choose a topic (hold S = □ to page), X / Enter / Space = ✕ opens it, ✕ or ○ closes it, ○ on the list leaves
          (the game goes to the title). A click on a topic moves the cursor, a click on the selected topic or on an open text is ✕, a right click ○
          (viewer convenience). In the game this screen is the map board's Help command (bit 8 of the command ring, state 7000; the board stays
          drawn behind it and ○ returns to the ring). Scene 400, the stand-alone version shown here on a black screen, is unreachable (only the
          title's unused result 5 leads to it).
          {missing.length > 0 && ` Load ${missing.join(', ')} for the windows.`}
        </p>
      ) : (
        <p className="muted">
          {realImages
            ? `${realImages} of the ${STAFF_LOADED} etc.one 1000 images were found.`
            : `etc.one has no entry 1000 on the retail disc (the game would stop with a fatal load error here), so the ${STAFF_DRAWN} drawn images are labelled placeholders.`}{' '}
          Timing, fades and the end are the game's: {tables.staffSeconds.slice(0, STAFF_DRAWN).join(', ')} seconds per image; after {STAFF_TIMEOUT} frames
          or START the screen fades to black over 127 frames and the game goes to the save screen (scene 1000). Both BGM channels are stopped; the
          only sound is voice clip {STAFF_VOICE}
          {voiceLine ? ` ("${voiceLine.text}", ${voiceLine.speaker ? (db.byId.get(voiceLine.speaker)?.name ?? `#${voiceLine.speaker}`) : 'narrator'})` : ''}.
          {!voices && ' Load snd/goc.dat for the voice.'}
        </p>
      )}
      {log.length > 0 && (
        <ul className="muted">
          {log.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
      {screen === 'help' && showText && <pre className="pre">{helpText}</pre>}
    </div>
  )
}
