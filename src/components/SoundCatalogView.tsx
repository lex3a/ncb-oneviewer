import { useEffect, useMemo, useRef, useState } from 'react'
import { download } from '../export'
import { effectUsers, type GameDb } from '../formats/gamedb'
import { decodeVag, type VagClip } from '../formats/vag'
import { ADSR_CURVE_LABEL, GAME_SAS_EFFECT, GAME_SE_VOICE, SAS_ENV_MAX, SAS_RATE, renderSe } from '../audio/sas'
import { SE_CODE_FUNCS, SE_CODE_SITES, SE_EFFECT_USES, SE_ROLES } from '../audio/seCatalog'
import { SePlayer, loadSeClips, onSeLoaderChange, sharedAudioContext } from '../audio/sePlayer'

const hex = (n: number, w = 0) => '0x' + n.toString(16).toUpperCase().padStart(w, '0')

interface Row {
  id: number
  clip?: VagClip
  seconds: number
  name: string
  role?: string
  code: { addr: number; func: number; ids: number[]; plain?: boolean }[]
  effects: { effect: number; arg: number; line: number; kept: boolean }[]
}

/** 16-bit stereo WAV at 44.1 kHz from ±32768-scale channels. */
function stereoWav(l: Float32Array, r: Float32Array): Uint8Array {
  const n = l.length
  const out = new Uint8Array(44 + n * 4)
  const dv = new DataView(out.buffer)
  const str = (o: number, s: string) => [...s].forEach((c, i) => (out[o + i] = c.charCodeAt(0)))
  str(0, 'RIFF')
  dv.setUint32(4, 36 + n * 4, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  dv.setUint32(16, 16, true)
  dv.setUint16(20, 1, true)
  dv.setUint16(22, 2, true)
  dv.setUint32(24, SAS_RATE, true)
  dv.setUint32(28, SAS_RATE * 4, true)
  dv.setUint16(32, 4, true)
  dv.setUint16(34, 16, true)
  str(36, 'data')
  dv.setUint32(40, n * 4, true)
  for (let i = 0; i < n; i++) {
    dv.setInt16(44 + i * 4, Math.max(-32768, Math.min(32767, Math.round(l[i]))), true)
    dv.setInt16(46 + i * 4, Math.max(-32768, Math.min(32767, Math.round(r[i]))), true)
  }
  return out
}

/** Waveform of the SAS render with the ADSR height over it. */
function Scope({ clip, wet }: { clip: VagClip; wet: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const r = renderSe(decodeVag(clip.data).samples, GAME_SE_VOICE, { wet })
    const g = c.getContext('2d')!
    const W = c.width
    const H = c.height
    g.clearRect(0, 0, W, H)
    const css = getComputedStyle(c)
    g.fillStyle = css.getPropertyValue('--accent') || '#48f'
    const n = r.left.length
    for (let x = 0; x < W; x++) {
      let lo = 0
      let hi = 0
      const a = Math.floor((x * n) / W)
      const b = Math.max(a + 1, Math.floor(((x + 1) * n) / W))
      for (let i = a; i < b; i++) {
        const v = r.left[i]
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
      const y0 = H / 2 - (hi / 32768) * (H / 2)
      const y1 = H / 2 - (lo / 32768) * (H / 2)
      g.fillRect(x, y0, 1, Math.max(1, y1 - y0))
    }
    g.strokeStyle = css.getPropertyValue('--muted') || '#888'
    g.beginPath()
    const e = r.voice.envelope
    for (let x = 0; x < W; x++) {
      const i = Math.min(e.length - 1, Math.floor((x * n) / W))
      const y = H - 2 - ((i < e.length ? e[i] : 0) / SAS_ENV_MAX) * (H - 4)
      if (x === 0) g.moveTo(x, y)
      else g.lineTo(x, y)
    }
    g.stroke()
  }, [clip, wet])
  return <canvas ref={ref} width={520} height={90} style={{ width: '100%', maxWidth: 520, height: 90, border: '1px solid var(--border)' }} />
}

/**
 * Sounds tab: every se.dat clip with where the game plays it (code call sites and effect scripts),
 * played through the SAS voice model with the game's parameters.
 */
export function SoundCatalogView({ db }: { db: GameDb }) {
  const [clips, setClips] = useState<VagClip[] | null>(null)
  const [gen, setGen] = useState(0)
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(1)
  const [wet, setWet] = useState(false)
  const [filter, setFilter] = useState<'all' | 'ui' | 'effect' | 'unused'>('all')
  const playerRef = useRef<SePlayer | null>(null)

  useEffect(() => onSeLoaderChange(() => setGen((g) => g + 1)), [])
  useEffect(() => {
    let cancelled = false
    loadSeClips().then((c) => {
      if (!cancelled) setClips(c)
    })
    return () => {
      cancelled = true
    }
  }, [gen])
  useEffect(() => () => playerRef.current?.dispose(), [])
  useEffect(() => {
    if (playerRef.current) playerRef.current.wet = wet
  }, [wet])

  const users = useMemo(() => effectUsers(db), [db])
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (let id = 1; id <= 49; id++) {
      const clip = clips?.[id - 1]
      const code = SE_CODE_SITES.filter((s) => s[2].includes(id)).map(([addr, func, ids, plain]) => ({ addr, func, ids, plain: !!plain }))
      const effects = SE_EFFECT_USES.filter((e) => e[1] === id).map(([effect, , arg, line, kept]) => ({ effect, arg, line, kept: !!kept }))
      const role = SE_ROLES[id]
      const effIds = [...new Set(effects.map((e) => e.effect))]
      const cardNames = [...new Set(effIds.flatMap((e) => users.get(e) ?? []))]
      const name = role?.name ?? (effIds.length ? `Effect sound (${cardNames.slice(0, 2).join(', ') || `effect ${effIds[0]}`}${cardNames.length > 2 ? ' …' : ''})` : 'Unused')
      out.push({ id, clip, seconds: clip ? decodeVag(clip.data).samples.length / clip.rate : 0, name, role: role?.role, code, effects })
    }
    return out
  }, [clips, users])

  const q = query.trim().toLowerCase()
  const shown = rows.filter((r) => {
    if (filter === 'ui' && !r.code.length) return false
    if (filter === 'effect' && !r.effects.length) return false
    if (filter === 'unused' && (r.code.length || r.effects.length)) return false
    if (!q) return true
    if (String(r.id) === q || `se${r.id}` === q || r.name.toLowerCase().includes(q) || r.role?.toLowerCase().includes(q)) return true
    if (r.code.some((s) => SE_CODE_FUNCS[s.func].name.toLowerCase().includes(q) || SE_CODE_FUNCS[s.func].context.toLowerCase().includes(q))) return true
    return r.effects.some((e) => String(e.effect) === q || (users.get(e.effect) ?? []).some((n) => n.toLowerCase().includes(q)))
  })
  const row = rows[sel - 1]

  const player = () => {
    if (!clips) return null
    const ac = sharedAudioContext()
    if (!playerRef.current || playerRef.current.ac !== ac) {
      playerRef.current?.dispose()
      playerRef.current = new SePlayer(ac, clips)
      playerRef.current.wet = wet
    }
    return playerRef.current
  }
  const play = (id: number) => {
    setSel(id)
    player()?.play(id)
  }
  const exportWav = (r: Row) => {
    if (!r.clip) return
    const s = renderSe(decodeVag(r.clip.data).samples, GAME_SE_VOICE, { wet })
    download(stereoWav(s.left, s.right), `se${r.id}_sas${wet ? '_hall' : ''}.wav`, 'audio/wav')
  }

  const used = rows.filter((r) => r.code.length || r.effects.length).length
  const a = GAME_SE_VOICE.adsr

  return (
    <div className="viewer">
      <div className="toolbar">
        <input type="search" placeholder="id, name, function, card" value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: 200 }} />
        <div className="seg">
          {(['all', 'ui', 'effect', 'unused'] as const).map((f) => (
            <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
              {f === 'ui' ? 'code' : f === 'effect' ? 'effects' : f}
            </button>
          ))}
        </div>
        <label title="sndSysInit selects the HALL reverb but calls sceSasSetEffect(1, fxsw = 0): the wet path is off in the game">
          <input type="checkbox" checked={wet} onChange={(e) => setWet(e.target.checked)} /> HALL reverb (off in the game)
        </label>
        <button onClick={() => player()?.stopVoice1()} disabled={!clips} title="se_stop: key-off on voice 1 only (the game's behaviour)">
          se_stop
        </button>
        <button onClick={() => player()?.stopAll()} disabled={!clips} title="se_stop_all: key-off on all 20 voices">
          se_stop_all
        </button>
        <span className="muted">
          {clips ? `${clips.length} clips in se.dat · ${used} played by the game · ${SE_CODE_SITES.length} code call sites · ${SE_EFFECT_USES.filter((e) => e[1] > 0).length} se_play in ${new Set(SE_EFFECT_USES.map((e) => e[0])).size} effects` : 'Load snd/se.dat (or the ISO) to play the sounds'}
        </span>
      </div>
      <div className="split">
        <div className="stage scroll-pane">
          <table className="grid db-grid">
            <thead>
              <tr>
                <th></th>
                <th>SE</th>
                <th className="left">clip</th>
                <th>length</th>
                <th className="left">name</th>
                <th>code</th>
                <th>effects</th>
                <th className="left">used in</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className={r.id === sel ? 'on' : ''} onClick={() => setSel(r.id)}>
                  <td>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        play(r.id)
                      }}
                      disabled={!r.clip}
                      title="Play through the SAS voice model"
                    >
                      ▶
                    </button>
                  </td>
                  <td>{r.id}</td>
                  <td className="left mono">{r.clip?.name ?? `se${r.id}.wav`}</td>
                  <td>{r.clip ? `${r.seconds.toFixed(2)} s` : ''}</td>
                  <td className="left">{r.name}</td>
                  <td>{r.code.length || ''}</td>
                  <td>{new Set(r.effects.map((e) => e.effect)).size || ''}</td>
                  <td className="left wrap">
                    {[...new Set(r.code.map((s) => SE_CODE_FUNCS[s.func].context))].slice(0, 4).join('; ')}
                    {new Set(r.code.map((s) => s.func)).size > 4 ? ' …' : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <h4>SAS setup (sndSysInit 0x0885F5F4, sndPlaySeUi 0x0885FA90)</h4>
          <dl className="props">
            <dt>Voices</dt>
            <dd>20 of 32 used round robin (g_seNextVoice 0x08B3C344); a new sound on a busy voice cuts it</dd>
            <dt>Grain / output</dt>
            <dd>sceSasInitWithGrain(0x400), 44100 Hz stereo, sceSasCore → sceWaveAudioWriteBlocking(2, 0x8000, 0x8000)</dd>
            <dt>Pitch</dt>
            <dd>{hex(GAME_SE_VOICE.pitch)} (0x1000 = 1.0 at 44.1 kHz) → 11025 Hz, the clips' own rate; linear interpolation</dd>
            <dt>ADSR rates</dt>
            <dd className="mono">
              flag 0xF · A {hex(a.attackRate)} · D {a.decayRate} · S {a.sustainRate} · R {hex(a.releaseRate)}
            </dd>
            <dt>ADSR curves</dt>
            <dd>
              {ADSR_CURVE_LABEL[a.attackCurve]} / {ADSR_CURVE_LABEL[a.decayCurve]} / {ADSR_CURVE_LABEL[a.sustainCurve]} / {ADSR_CURVE_LABEL[a.releaseCurve]}, SL 0 (sceSasCore defaults, never
              set): full level after the ~32-sample key-on delay, −100 per sample (−0.4 % per second), release to 0 in 4 samples
            </dd>
            <dt>Volume</dt>
            <dd>dry L/R {hex(GAME_SE_VOICE.volLeft)} / {hex(GAME_SE_VOICE.volRight)} (centre, full), effect send {hex(GAME_SE_VOICE.effectLeft)} / {hex(GAME_SE_VOICE.effectRight)}</dd>
            <dt>Reverb</dt>
            <dd>
              HALL (type {GAME_SAS_EFFECT.type}), effect volume {hex(GAME_SAS_EFFECT.volLeft)} / {hex(GAME_SAS_EFFECT.volRight)}, but sceSasSetEffect(dry 1, wet fxsw = {GAME_SAS_EFFECT.wet}): no reverb is heard
            </dd>
            <dt>Voices (speech)</dt>
            <dd>goc.dat, 1270 clips at 44.1 kHz, streamed on libwave channel 0 at volume 0x7F; stopping fades out over 0x70 samples. Open snd/goc.dat in the file list, or the Story tab.</dd>
          </dl>
        </div>
        <aside className="side db-side">
          {row && (
            <div className="clip-card">
              <h3>
                SE {row.id}: {row.name}
              </h3>
              {row.role && <p style={{ margin: 0 }}>{row.role}</p>}
              {row.clip ? (
                <>
                  <Scope clip={row.clip} wet={wet} />
                  <div>
                    <button onClick={() => play(row.id)}>▶ Play (SAS)</button> <button onClick={() => exportWav(row)}>Download WAV (SAS render)</button>
                  </div>
                  <dl className="props">
                    <dt>Clip</dt>
                    <dd className="mono">
                      {row.clip.name} · se.dat {hex(row.clip.offset)} · {row.clip.rate} Hz · {row.clip.data.length} bytes
                    </dd>
                    <dt>Length</dt>
                    <dd>
                      {row.seconds.toFixed(3)} s ({Math.round(row.seconds * row.clip.rate)} samples; {Math.round(row.seconds * SAS_RATE) + 9} SAS output samples at pitch 0x400, key-on delay 9)
                    </dd>
                  </dl>
                </>
              ) : (
                <p className="muted">se.dat not loaded.</p>
              )}
              {row.code.length > 0 && (
                <>
                  <h4>Code ({row.code.length})</h4>
                  <table className="grid">
                    <tbody>
                      {row.code.map((s) => (
                        <tr key={s.addr}>
                          <td className="mono">{hex(s.addr, 8)}</td>
                          <td className="left mono">{SE_CODE_FUNCS[s.func].name}</td>
                          <td className="left wrap">
                            {SE_CODE_FUNCS[s.func].context}
                            {s.ids.length > 1 ? ` (variable: ${s.ids.join(' / ')})` : ''}
                            {s.plain ? ' (sndPlaySe)' : ''}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
              {row.effects.length > 0 && (
                <>
                  <h4>Effect scripts ({new Set(row.effects.map((e) => e.effect)).size})</h4>
                  <table className="grid">
                    <tbody>
                      {row.effects.map((e, i) => (
                        <tr key={i}>
                          <td>effect {e.effect}</td>
                          <td className="mono">line {e.line}</td>
                          <td className="left wrap">{(users.get(e.effect) ?? []).join(', ') || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
              {!row.code.length && !row.effects.length && <p className="muted">Never played: no code call site and no effect script uses this clip.</p>}
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}
