import { useEffect, useMemo, useState } from 'react'
import { download } from '../export'
import { convertPmf, CORE_BYTES, decodeAt3, isFfmpegLoaded, type Progress } from '../media/ffmpeg'

type Stage = 'idle' | 'working' | 'done' | 'error'

/** at3 (ATRAC3plus) and pmf (PSMF movie) — both need ffmpeg.wasm, fetched on demand. */
export function MediaView({ data, name, kind }: { data: Uint8Array; name: string; kind: 'at3' | 'pmf' }) {
  const [stage, setStage] = useState<Stage>('idle')
  const [progress, setProgress] = useState<Progress | null>(null)
  const [error, setError] = useState('')
  const [out, setOut] = useState<Uint8Array | null>(null)
  const mime = kind === 'at3' ? 'audio/wav' : 'video/mp4'
  const url = useMemo(() => (out ? URL.createObjectURL(new Blob([out as BlobPart], { type: mime })) : ''), [out, mime])
  useEffect(() => () => { if (url) URL.revokeObjectURL(url) }, [url])
  const stem = name.replace(/\.[^.]+$/, '')

  const start = async () => {
    setStage('working')
    setError('')
    try {
      const result = await (kind === 'at3' ? decodeAt3 : convertPmf)(data, setProgress)
      setOut(result)
      setStage('done')
    } catch (e) {
      setError((e as Error).message)
      setStage('error')
    }
  }

  // Once the core is in memory, decoding is quick: start right away.
  useEffect(() => {
    if (isFfmpegLoaded()) void start()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="viewer">
      <div className="toolbar">
        <button onClick={() => download(data, name)}>Raw</button>
        {out && <button onClick={() => download(out, `${stem}.${kind === 'at3' ? 'wav' : 'mp4'}`, mime)}>Save {kind === 'at3' ? 'WAV' : 'MP4'}</button>}
        <span className="muted">
          {kind === 'at3' ? 'ATRAC3plus in RIFF WAVE' : 'PSMF: H.264 video + ATRAC3plus audio in MPEG-PS'} · {(data.length / 1048576).toFixed(1)} MB
        </span>
      </div>
      <div className="scroll-pane">
        {stage === 'idle' && (
          <div className="media-box">
            <p>
              No browser can play {kind === 'at3' ? 'ATRAC3plus' : 'PSMF'} directly, so it is converted with ffmpeg compiled to
              WebAssembly{isFfmpegLoaded() ? '.' : ` (a one-time ${(CORE_BYTES / 1048576).toFixed(0)} MB download, then cached for the session).`}
              {kind === 'pmf' && ' The video stream is copied, the audio is re-encoded to AAC.'}
            </p>
            <button className="btn primary" onClick={start}>
              {kind === 'at3' ? 'Decode audio' : 'Convert movie'}
            </button>
          </div>
        )}
        {stage === 'working' && (
          <div className="media-box">
            <p>
              {progress?.stage === 'download' ? 'Fetching ffmpeg core' : 'Converting'}…{' '}
              {progress ? `${Math.round(progress.ratio * 100)}%` : ''}
            </p>
            <progress max={1} value={progress?.ratio ?? 0} style={{ width: 320 }} />
          </div>
        )}
        {stage === 'error' && (
          <div className="media-box">
            <div className="warn">Could not convert: {error}</div>
            <button onClick={start}>Retry</button>
          </div>
        )}
        {stage === 'done' && url && (
          kind === 'at3' ? (
            <audio controls autoPlay src={url} style={{ width: '100%', maxWidth: 560 }} />
          ) : (
            <video controls autoPlay src={url} style={{ maxWidth: '100%', width: 720, background: '#000' }} />
          )
        )}
      </div>
    </div>
  )
}
