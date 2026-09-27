/**
 * ATRAC3plus audio (at3/*.at3) and PSMF movies (Movie/*.pmf), via ffmpeg compiled to WebAssembly.
 * No browser decodes either format. The core (~31 MB) is served from node_modules, fetched on
 * first use with progress, and shared for the session. One ffmpeg instance runs one job at a time,
 * so jobs are queued.
 */
import coreURL from '@ffmpeg/core?url'
import wasmURL from '@ffmpeg/core/wasm?url'
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { extractPsmfAudio } from '../formats/psmf'

export const CORE_BYTES = 31 * 1024 * 1024

export interface Progress {
  stage: 'download' | 'convert'
  /** 0..1 */
  ratio: number
}

let instance: Promise<FFmpeg> | null = null
let listener: ((p: Progress) => void) | undefined
/** ffmpeg's log lines for the last job (shown when a conversion fails). */
let log: string[] = []
export const lastLog = () => log.join('\n')

async function fetchCore(onProgress?: (p: Progress) => void): Promise<string> {
  const res = await fetch(wasmURL)
  if (!res.ok) throw new Error(`could not fetch the ffmpeg core (${res.status})`)
  const total = Number(res.headers.get('content-length')) || CORE_BYTES
  const reader = res.body?.getReader()
  if (!reader) return URL.createObjectURL(new Blob([await res.arrayBuffer()], { type: 'application/wasm' }))
  const chunks: Uint8Array[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    loaded += value.length
    onProgress?.({ stage: 'download', ratio: Math.min(1, loaded / total) })
  }
  return URL.createObjectURL(new Blob(chunks as BlobPart[], { type: 'application/wasm' }))
}

function load(onProgress?: (p: Progress) => void): Promise<FFmpeg> {
  instance ??= (async () => {
    try {
      const ffmpeg = new FFmpeg()
      ffmpeg.on('log', ({ message }) => log.push(message))
      ffmpeg.on('progress', ({ progress }) => listener?.({ stage: 'convert', ratio: Math.max(0, Math.min(1, progress)) }))
      await ffmpeg.load({ coreURL, wasmURL: await fetchCore(onProgress) })
      return ffmpeg
    } catch (e) {
      instance = null // do not cache a failed load
      throw e
    }
  })()
  return instance
}

export const isFfmpegLoaded = () => instance !== null

let queue: Promise<unknown> = Promise.resolve()
let nextId = 0

interface Input {
  data: Uint8Array
  ext: string
}

async function run(inputs: Input[], outExt: string, args: string[], onProgress?: (p: Progress) => void) {
  const ffmpeg = await load(onProgress)
  const id = nextId++
  const names = inputs.map((inp, i) => `in${id}_${i}.${inp.ext}`)
  const output = `out${id}.${outExt}`
  listener = onProgress
  log = []
  try {
    // writeFile transfers the buffer; hand over a copy so the caller's data stays usable
    for (let i = 0; i < inputs.length; i++) await ffmpeg.writeFile(names[i], inputs[i].data.slice())
    const code = await ffmpeg.exec([...names.flatMap((n) => ['-i', n]), ...args, output])
    if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`)
    const result = await ffmpeg.readFile(output)
    if (typeof result === 'string' || result.length === 0) throw new Error('ffmpeg produced no output')
    return result
  } finally {
    listener = undefined
    for (const n of names) await ffmpeg.deleteFile(n).catch(() => undefined)
    await ffmpeg.deleteFile(output).catch(() => undefined)
  }
}

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const p = queue.then(job)
  queue = p.catch(() => undefined) // one failure must not stall later jobs
  return p
}

/** ATRAC3plus RIFF → 16-bit PCM WAV. */
export const decodeAt3 = (data: Uint8Array, onProgress?: (p: Progress) => void) =>
  enqueue(() => run([{ data, ext: 'at3' }], 'wav', [], onProgress))

/**
 * PSMF → MP4. The H.264 stream is copied. The ATRAC3plus audio, which ffmpeg cannot find in the
 * program stream, is extracted by extractPsmfAudio, decoded to PCM first (a direct ATRAC3plus → AAC
 * mux produces broken timestamps), then muxed with the video as AAC.
 */
export function convertPmf(data: Uint8Array, onProgress?: (p: Progress) => void) {
  const audio = extractPsmfAudio(data)
  return enqueue(async () => {
    if (!audio) return run([{ data, ext: 'pmf' }], 'mp4', ['-map', '0:v:0', '-c:v', 'copy', '-movflags', '+faststart'], onProgress)
    const wav = await run([{ data: audio.riff, ext: 'at3' }], 'wav', [], onProgress)
    return run(
      [{ data, ext: 'pmf' }, { data: wav, ext: 'wav' }],
      'mp4',
      ['-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart'],
      onProgress,
    )
  })
}
