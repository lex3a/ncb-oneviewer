/**
 * Real-time sound effects through the SAS model (sas.ts): 20 voices used round robin like
 * g_seNextVoice, key-off with the game's release rate, optional HALL wet path. Each clip is rendered
 * once through renderSasVoice (pitch 0x400, the game's ADSR and volumes) and then played from a
 * buffer; the wet path is a ConvolverNode with the reverb's impulse response (hallImpulseResponse).
 */
import { decodeVag, parseVagBank, type VagClip } from '../formats/vag'
import { GAME_SE_VOICE, SAS_ENV_MAX, SAS_RATE, hallImpulseResponse, renderSasVoice } from './sas'

export const SE_VOICES = 20

let sharedCtx: AudioContext | null = null
/** One AudioContext for every view that plays SAS sound effects. */
export function sharedAudioContext(): AudioContext {
  if (!sharedCtx) sharedCtx = new AudioContext()
  if (sharedCtx.state === 'suspended') void sharedCtx.resume()
  return sharedCtx
}

// ---- se.dat registry: App registers how to read snd/se.dat; views ask for the clips ----

let seLoader: (() => Promise<Uint8Array | null>) | null = null
let seClips: Promise<VagClip[] | null> | null = null
const listeners = new Set<() => void>()

export function setSeLoader(load: (() => Promise<Uint8Array | null>) | null) {
  if (load === seLoader) return
  seLoader = load
  seClips = null
  for (const f of listeners) f()
}

/** Called when a different se.dat loader is registered. */
export function onSeLoaderChange(f: () => void) {
  listeners.add(f)
  return () => void listeners.delete(f)
}

export function loadSeClips(): Promise<VagClip[] | null> {
  if (!seClips) seClips = seLoader ? seLoader().then((b) => (b ? parseVagBank(b) : null)) : Promise.resolve(null)
  return seClips
}

// ---- player ----

interface Voice {
  src: AudioBufferSourceNode
  /** Key-off envelope of the dry and effect-send paths. */
  gDry: GainNode
  gSend: GainNode
}

const irCache = new WeakMap<BaseAudioContext, AudioBuffer>()
function hallBuffer(ac: BaseAudioContext) {
  let b = irCache.get(ac)
  if (!b) {
    const [l, r] = hallImpulseResponse()
    b = ac.createBuffer(2, l.length, SAS_RATE)
    b.copyToChannel(l as Float32Array<ArrayBuffer>, 0)
    b.copyToChannel(r as Float32Array<ArrayBuffer>, 1)
    irCache.set(ac, b)
  }
  return b
}

export class SePlayer {
  readonly ac: BaseAudioContext
  private clips: VagClip[]
  private voices: (Voice | null)[] = Array(SE_VOICES).fill(null)
  private next = 0
  private dry = new Map<number, AudioBuffer>()
  private out: GainNode
  private wetIn: GainNode
  private convolver: ConvolverNode | null = null
  /** Log of played ids (for status lines). */
  last = 0

  constructor(ac: BaseAudioContext, clips: VagClip[], destination: AudioNode = ac.destination) {
    this.ac = ac
    this.clips = clips
    this.out = ac.createGain()
    this.out.connect(destination)
    this.wetIn = ac.createGain()
  }

  /** The HALL wet path (off in the game: sceSasSetEffect(1, fxsw = 0)). */
  set wet(on: boolean) {
    if (on && !this.convolver) {
      const c = this.ac.createConvolver()
      c.normalize = false
      c.buffer = hallBuffer(this.ac)
      this.wetIn.connect(c)
      c.connect(this.out)
      this.convolver = c
    } else if (!on && this.convolver) {
      this.wetIn.disconnect()
      this.convolver.disconnect()
      this.convolver = null
    }
  }
  get wet() {
    return !!this.convolver
  }

  set volume(v: number) {
    this.out.gain.value = v
  }

  /** Stereo dry render at 44.1 kHz, the voice's effect send in channels 2/3. */
  private buffer(id: number): AudioBuffer | null {
    let b = this.dry.get(id)
    if (b) return b
    const clip = this.clips[id - 1]
    if (!clip) return null
    const v = renderSasVoice(decodeVag(clip.data).samples, GAME_SE_VOICE)
    b = this.ac.createBuffer(4, Math.max(1, v.left.length), SAS_RATE)
    const put = (a: Float32Array, ch: number) => b!.copyToChannel(a.map((x) => x / 32768) as Float32Array<ArrayBuffer>, ch)
    put(v.left, 0)
    put(v.right, 1)
    put(v.sendLeft, 2)
    put(v.sendRight, 3)
    this.dry.set(id, b)
    return b
  }

  /** sndPlaySeUi(id): SetVoice + KeyOn on the next voice; returns the voice number. */
  play(id: number, when = 0): number {
    this.last = id
    const buf = this.buffer(id)
    const v = this.next
    this.next = (this.next + 1) % SE_VOICES
    this.cut(v, when)
    if (!buf) return v
    const src = this.ac.createBufferSource()
    src.buffer = buf
    const split = this.ac.createChannelSplitter(4)
    const dry = this.ac.createChannelMerger(2)
    const send = this.ac.createChannelMerger(2)
    const gDry = this.ac.createGain()
    const gSend = this.ac.createGain()
    src.connect(split)
    split.connect(dry, 0, 0)
    split.connect(dry, 1, 1)
    split.connect(send, 2, 0)
    split.connect(send, 3, 1)
    dry.connect(gDry).connect(this.out)
    send.connect(gSend).connect(this.wetIn)
    src.start(when || this.ac.currentTime)
    const voice: Voice = { src, gDry, gSend }
    this.voices[v] = voice
    src.onended = () => {
      if (this.voices[v] === voice) this.voices[v] = null
    }
    return v
  }

  /** sceSasSetKeyOff(voice): release at 0x10000000 per sample (about 4 samples to silence). */
  keyOff(v: number, when = 0) {
    const voice = this.voices[v]
    if (!voice) return
    const t = Math.max(when, this.ac.currentTime)
    const len = Math.ceil(SAS_ENV_MAX / GAME_SE_VOICE.adsr.releaseRate) / SAS_RATE
    for (const g of [voice.gDry, voice.gSend]) {
      g.gain.setValueAtTime(1, t)
      g.gain.linearRampToValueAtTime(0, t + len)
    }
    try {
      voice.src.stop(t + len + 0.001)
    } catch {
      // already stopped
    }
    this.voices[v] = null
  }

  /** A new SetVoice on a playing voice replaces it at once. */
  private cut(v: number, when: number) {
    const voice = this.voices[v]
    if (!voice) return
    try {
      voice.src.stop(when || this.ac.currentTime)
    } catch {
      // already stopped
    }
    this.voices[v] = null
  }

  /** se_stop / sndStopSeVoice1: always voice 1, whatever plays there. */
  stopVoice1() {
    this.keyOff(1)
  }

  /** sndStopAllSe: key-off on all 20 voices. */
  stopAll() {
    for (let i = 0; i < SE_VOICES; i++) this.keyOff(i)
  }

  dispose() {
    for (let i = 0; i < SE_VOICES; i++) this.cut(i, 0)
    this.out.disconnect()
  }
}

/**
 * A lazily created SE player on the shared context, for views that only need "play SE n" (map board,
 * deck editor). Returns null while se.dat is not loaded.
 */
let shared: { player: SePlayer; clips: VagClip[] } | null = null
export async function sharedSePlayer(): Promise<SePlayer | null> {
  const clips = await loadSeClips()
  if (!clips) return null
  if (!shared || shared.clips !== clips) {
    shared?.player.dispose()
    shared = { player: new SePlayer(sharedAudioContext(), clips), clips }
  }
  return shared.player
}

/** Fire-and-forget sndPlaySeUi for UI ports. */
export function playUiSe(id: number) {
  void sharedSePlayer().then((p) => p?.play(id))
}
