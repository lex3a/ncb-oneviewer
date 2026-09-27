/**
 * Play mode's audio: one AudioContext with master → {BGM, SE, voice} gain buses.
 *  - BGM: bgmPlay(0, id) streams at3/BGM_{id+1}.at3 (looped forever) through MusicPlayer (ffmpeg.wasm).
 *  - SE: sndPlaySeUi / the effect scripts' se_play through the SAS voice model (SePlayer, se.dat).
 *  - Voices: goc.dat clips played by the story player (libwave channel 0).
 * The context can only start after a user gesture (`resume`); a track requested before that starts then.
 * Volumes and mute are Play-mode preferences in localStorage (the game has no options menu).
 */
import { SePlayer } from '../audio/sePlayer'
import { MusicPlayer } from '../effect/music'
import { parseVagBank, type VagClip } from '../formats/vag'

export interface AudioSettings {
  master: number
  bgm: number
  se: number
  voice: number
  muted: boolean
}

export type AudioBus = 'bgm' | 'se' | 'voice'

const STORE_KEY = 'ncb.play.audio'
const DEFAULTS: AudioSettings = { master: 0.8, bgm: 0.7, se: 1, voice: 1, muted: false }

export interface AudioLoaders {
  /** Reads a file by name (at3/BGM_nn.at3, snd/se.dat, snd/goc.dat) from the loaded disc. */
  file: (name: string) => Promise<Uint8Array | null>
}

/** bgmPlay's file name for a BGM id (g_pBgmPaths[id]). */
export const bgmFile = (id: number) => `BGM_${String(id + 1).padStart(2, '0')}.at3`

export class AudioManager {
  ctx: AudioContext | null = null
  settings: AudioSettings
  private master: GainNode | null = null
  private buses: Partial<Record<AudioBus, GainNode>> = {}
  private music: MusicPlayer
  private se: SePlayer | null = null
  seClips: VagClip[] | null = null
  voices: VagClip[] | null = null
  /** The track the game wants (played once the context runs). */
  private wantBgm: string | null = null
  musicStatus = ''
  loadStatus = ''
  private loaders: AudioLoaders

  constructor(loaders: AudioLoaders) {
    this.loaders = loaders
    this.settings = { ...DEFAULTS }
    try {
      const s = localStorage.getItem(STORE_KEY)
      if (s) this.settings = { ...DEFAULTS, ...(JSON.parse(s) as Partial<AudioSettings>) }
    } catch {
      // storage blocked: defaults
    }
    this.music = new MusicPlayer((name) => this.loaders.file(name), (s) => (this.musicStatus = s))
  }

  /** se.dat and goc.dat (read once at boot, like sndSysInit / the voice bank). */
  async loadBanks() {
    this.loadStatus = 'loading sound banks…'
    try {
      const [se, goc] = await Promise.all([this.loaders.file('se.dat'), this.loaders.file('goc.dat')])
      this.seClips = se ? parseVagBank(se) : null
      this.voices = goc ? parseVagBank(goc) : null
      this.se = null
      this.loadStatus = [this.seClips ? `${this.seClips.length} SE` : 'no se.dat', this.voices ? `${this.voices.length} voices` : 'no goc.dat'].join(', ')
    } catch (e) {
      this.loadStatus = (e as Error).message
    }
  }

  /** Creates / resumes the AudioContext; call from a user gesture. */
  resume() {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext()
      } catch {
        return
      }
      const ac = this.ctx
      this.master = ac.createGain()
      this.master.connect(ac.destination)
      for (const b of ['bgm', 'se', 'voice'] as AudioBus[]) {
        const g = ac.createGain()
        g.connect(this.master)
        this.buses[b] = g
      }
      this.apply()
      if (this.wantBgm) {
        this.music.reset()
        void this.music.set(this.wantBgm, ac, this.buses.bgm)
      }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume()
  }

  get running() {
    return this.ctx?.state === 'running'
  }

  private apply() {
    const s = this.settings
    if (this.master) this.master.gain.value = s.muted ? 0 : s.master
    for (const b of ['bgm', 'se', 'voice'] as AudioBus[]) {
      const g = this.buses[b]
      if (g) g.gain.value = s[b]
    }
  }

  update(patch: Partial<AudioSettings>) {
    this.settings = { ...this.settings, ...patch }
    this.apply()
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(this.settings))
    } catch {
      // storage blocked
    }
  }

  /** bgmPlay(0, id). */
  playBgm(id: number) {
    this.playBgmFile(bgmFile(id))
  }

  /** A track by file name (the story player's cmd 22 gives the name); null = bgmStop. */
  playBgmFile(name: string | null) {
    if (name === this.wantBgm) return
    this.wantBgm = name
    if (this.ctx) void this.music.set(name, this.ctx, this.buses.bgm)
  }

  stopBgm() {
    this.playBgmFile(null)
  }

  get bgm() {
    return this.wantBgm
  }

  /** sndPlaySeUi(id). */
  playSe(id: number) {
    const ac = this.ctx
    if (!ac || !this.seClips || !this.buses.se) return
    if (!this.se) this.se = new SePlayer(ac, this.seClips, this.buses.se)
    this.se.play(id)
  }

  /** Options for an EffectScene (map effects, duel): its SE voices go to the SE bus. */
  effectAudio(): { seClips?: VagClip[]; audio?: AudioContext | null; seOut?: AudioNode } {
    if (!this.ctx || !this.seClips) return {}
    return { seClips: this.seClips, audio: this.ctx, seOut: this.buses.se }
  }

  /** Options for a StoryPlayer: goc.dat voices on the voice bus. */
  storyAudio(): { voices: VagClip[] | null; audio: AudioContext | null; voiceOut?: AudioNode } {
    return { voices: this.voices, audio: this.ctx, voiceOut: this.buses.voice }
  }

  dispose() {
    this.music.reset()
    this.se?.dispose()
    this.se = null
    void this.ctx?.close()
    this.ctx = null
  }
}
