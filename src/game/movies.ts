/**
 * The PMF movies of Play mode (Movie/LOGO.pmf, OP.pmf, ED000.pmf, ED001.pmf): no browser plays PSMF
 * (H.264 + ATRAC3plus in MPEG-PS), so each movie is converted once per session to MP4 with the
 * viewer's ffmpeg.wasm path (convertPmf: the H.264 stream copied, the ATRAC3plus audio decoded and
 * re-encoded to AAC; docs/formats/media.md) and kept in memory as a blob URL.
 */
import { convertPmf, lastLog, type Progress } from '../media/ffmpeg'
import type { GameAssets } from './assets'

export interface MovieJob {
  name: string
  /** Conversion progress (ffmpeg core download, then the two conversion passes). */
  progress: Progress | null
  /** The MP4 as a blob URL once converted. */
  url: string | null
  /** Why the movie cannot be played (file missing, ffmpeg failure). */
  error: string | null
  done: Promise<void>
}

const jobs = new Map<string, MovieJob>()

/** The movie's conversion job (started on first request, shared for the session). */
export function movieJob(assets: GameAssets, name: string): MovieJob {
  let j = jobs.get(name)
  if (j && !j.error) return j
  const job: MovieJob = { name, progress: null, url: null, error: null, done: Promise.resolve() }
  job.done = (async () => {
    try {
      const data = await assets.file(name)
      if (!data) throw new Error(`${name} is not loaded (load the whole disc or its PSP_GAME/USRDIR/data/Movie folder)`)
      const mp4 = await convertPmf(data, (p) => (job.progress = p))
      job.url = URL.createObjectURL(new Blob([mp4 as BlobPart], { type: 'video/mp4' }))
    } catch (e) {
      job.error = (e as Error).message
      console.warn(`Play mode: movie ${name} cannot be played:`, job.error, lastLog().split('\n').slice(-5).join('\n'))
    }
  })()
  j = job
  jobs.set(name, j)
  return j
}
