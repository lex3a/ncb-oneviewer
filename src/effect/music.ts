/**
 * BGM for story events: bgmPlay(0, n) streams at3/BGM_{n+1}.at3 (docs/formats/story.md, cmd 22/23).
 * The ATRAC3plus file is decoded once with ffmpeg.wasm and then looped.
 */
import { decodeAt3, type Progress } from '../media/ffmpeg'

export type MusicLoader = (fileName: string) => Promise<Uint8Array | null>

export class MusicPlayer {
  current: string | null = null
  private cache = new Map<string, AudioBuffer>()
  private node: AudioBufferSourceNode | null = null
  private token = 0
  private load: MusicLoader
  private onStatus: (s: string) => void
  volume = 0.7

  constructor(load: MusicLoader, onStatus: (s: string) => void) {
    this.load = load
    this.onStatus = onStatus
  }

  /** Switch to a track (null = stop). Calling again with the same name does nothing. `destination` defaults to the context's output. */
  async set(name: string | null, ac: AudioContext | null, destination?: AudioNode) {
    if (name === this.current) return
    this.current = name
    this.stop()
    const token = ++this.token
    if (!name || !ac) {
      this.onStatus(name ? `${name} (sound off)` : '')
      return
    }
    try {
      let buf = this.cache.get(name)
      if (!buf) {
        const bytes = await this.load(name)
        if (token !== this.token) return
        if (!bytes) {
          this.onStatus(`${name}: load the at3 folder (or the ISO) for music`)
          return
        }
        this.onStatus(`${name}: decoding…`)
        const wav = await decodeAt3(bytes, (p: Progress) => {
          if (token === this.token) this.onStatus(`${name}: ${p.stage === 'download' ? 'loading ffmpeg' : 'decoding'} ${Math.round(p.ratio * 100)} %`)
        })
        buf = await ac.decodeAudioData(wav.slice().buffer)
        this.cache.set(name, buf)
      }
      if (token !== this.token) return
      const gain = ac.createGain()
      gain.gain.value = this.volume
      gain.connect(destination ?? ac.destination)
      const node = ac.createBufferSource()
      node.buffer = buf
      node.loop = true
      node.connect(gain)
      node.start()
      this.node = node
      this.onStatus(`${name} ♪`)
    } catch (e) {
      if (token === this.token) this.onStatus(`${name}: ${(e as Error).message}`)
    }
  }

  stop() {
    try {
      this.node?.stop()
    } catch {
      // already stopped
    }
    this.node = null
  }

  /** Forget the current track so the next set() starts it again. */
  reset() {
    this.token++
    this.stop()
    this.current = null
  }
}
