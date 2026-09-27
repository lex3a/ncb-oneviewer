import { useEffect, useMemo, useState } from 'react'
import { download, zipAsync } from '../export'
import { VOICE_EPISODES, type GameDb } from '../formats/gamedb'
import { decodeVag, encodeWav, parseVagBank, type VagClip } from '../formats/vag'

const stem = (n: string) => n.replace(/\.wav$/i, '')

function useWavUrl(clip: VagClip | undefined) {
  const decoded = useMemo(() => (clip ? decodeVag(clip.data) : null), [clip])
  const wav = useMemo(() => (decoded && clip ? encodeWav(decoded.samples, clip.rate) : null), [decoded, clip])
  const url = useMemo(() => (wav ? URL.createObjectURL(new Blob([wav as BlobPart], { type: 'audio/wav' })) : ''), [wav])
  useEffect(() => () => { if (url) URL.revokeObjectURL(url) }, [url])
  return { decoded, wav, url }
}

/** `db` is passed for goc.dat: clip i is voice id i + 1, whose line comes from the story text. */
export function VagBankView({ data, name, db }: { data: Uint8Array; name: string; db?: GameDb }) {
  const clips = useMemo(() => parseVagBank(data), [data])
  const [query, setQuery] = useState('')
  const [current, setCurrent] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const line = (c: VagClip) => db?.voices.get(c.index + 1)
  const speaker = (c: VagClip) => {
    const l = line(c)
    return l ? (l.speaker ? db!.byId.get(l.speaker)?.name ?? `#${l.speaker}` : 'Narrator') : undefined
  }
  const q = query.toLowerCase()
  const shown = clips.filter(
    (c) => !q || c.name.toLowerCase().includes(q) || !!line(c)?.text.toLowerCase().includes(q) || !!speaker(c)?.toLowerCase().includes(q),
  )
  const clip = clips[current]
  const { decoded, wav, url } = useWavUrl(clip)
  const bankName = name.replace(/\.dat$/i, '')

  const exportAll = async () => {
    setBusy('Decoding…')
    const files: Record<string, Uint8Array> = {}
    for (let i = 0; i < shown.length; i++) {
      const c = shown[i]
      files[`${bankName}/${stem(c.name)}.wav`] = encodeWav(decodeVag(c.data).samples, c.rate)
      if (i % 50 === 0) {
        setBusy(`Decoding ${i}/${shown.length}…`)
        await new Promise((r) => setTimeout(r))
      }
    }
    download(await zipAsync(files), `${bankName}_wav.zip`, 'application/zip')
    setBusy(null)
  }

  return (
    <div className="viewer">
      <div className="toolbar">
        <input type="search" placeholder={db ? 'name, speaker or text' : 'filter by name, e.g. 3_'} value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: 220 }} />
        <button onClick={exportAll} disabled={!!busy}>
          Export {shown.length === clips.length ? 'all' : shown.length} as WAV (zip)
        </button>
        <span className="muted">
          {busy ?? `${clips.length} VAG clips · PSX ADPCM · ${[...new Set(clips.map((c) => c.rate))].join('/')} Hz`}
        </span>
      </div>
      <div className="split">
        <div className="stage">
          {clip && (
            <div className="clip-card">
              <h3 className="mono">{clip.name}</h3>
              {db && (
                <div>
                  {line(clip) ? (
                    <>
                      <strong>{speaker(clip)}</strong>
                      {line(clip)!.expression > 0 && <span className="muted"> (expression {line(clip)!.expression})</span>}
                      <p className="pre" style={{ margin: '4px 0 0' }}>{line(clip)!.text}</p>
                    </>
                  ) : (
                    <span className="muted">Not referenced by the story text.</span>
                  )}
                </div>
              )}
              <audio key={url} controls autoPlay src={url} style={{ width: '100%', maxWidth: 520 }} />
              <dl className="props">
                <dt>Rate</dt>
                <dd>{clip.rate} Hz</dd>
                <dt>Duration</dt>
                <dd>{decoded ? (decoded.samples.length / clip.rate).toFixed(2) : '—'} s</dd>
                <dt>Samples</dt>
                <dd>{decoded?.samples.length.toLocaleString()}</dd>
                <dt>Loop</dt>
                <dd>
                  {decoded?.loopStart !== undefined
                    ? `${decoded.loopStart} → ${decoded.loopEnd ?? 'end'}`
                    : 'none'}
                </dd>
                {db && (
                  <>
                    <dt>Voice id</dt>
                    <dd>{clip.index + 1}</dd>
                    <dt>Episode</dt>
                    <dd>{VOICE_EPISODES[Number(clip.name.split('_')[0])] ?? '—'}</dd>
                  </>
                )}
                <dt>Offset</dt>
                <dd className="mono">0x{clip.offset.toString(16)}</dd>
              </dl>
              {wav && <button onClick={() => download(wav, `${bankName}_${stem(clip.name)}.wav`, 'audio/wav')}>Download WAV</button>}
            </div>
          )}
        </div>
        <aside className="side">
          <h4>Clips</h4>
          <ol className="steps clip-list">
            {shown.map((c) => (
              <li key={c.index}>
                <button className={c.index === current ? 'on' : ''} onClick={() => setCurrent(c.index)}>
                  <span className="mono">{c.name}</span>
                  {speaker(c) && <span className="muted"> {speaker(c)}</span>}
                </button>
              </li>
            ))}
          </ol>
        </aside>
      </div>
    </div>
  )
}
