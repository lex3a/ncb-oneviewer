/**
 * A software model of one PSP SAS voice (sceSasCore) and of the SAS reverb, used to play se.dat the
 * way the game does. See docs/formats/sound.md ("SAS voice").
 *
 * What the game sets (sndPlaySeUi 0x0885FA90, identical in sndPlaySe / sndPlaySeEx):
 *   sceSasSetVoice(v, clip data after the 0x30-byte VAG header, size − 0x30, loop 0)
 *   sceSasSetPitch(v, 0x400)                       0x1000 = one source sample per 44.1 kHz output
 *   sceSasSetADSR(v, 0xF, 0x40000000, 100, 100, 0x10000000)   rates only; modes and SL keep the
 *                                                  sceSasCore defaults (the libsas defaults loop in
 *                                                  sceSasInitWithGrain never runs, a Sony bug)
 *   sceSasSetVolume(v, 0x1000, 0x1000, 0x1000, 0x1000)       dry L/R and effect-send L/R at maximum
 *   sceSasSetKeyOn(v)
 * sndSysInit: grain 0x400, 44100 Hz stereo, sceSasSetEffectType(4 = HALL), sceSasSetEffect(dry 1,
 * wet fxsw = 0), sceSasSetEffectVolume(0xC00, 0xC00). fxsw is never written again, so the reverb is
 * configured but its wet path is switched off: the game's sound effects are dry.
 *
 * The mixing arithmetic, the key-on delay and the ADSR curves follow PPSSPP's reverse-engineered
 * sceSas (Core/HW/SasAudio.cpp); the reverb is the PSX SPU reverb formula (nocash psx-spx) with the
 * PSP's own HALL constants, as in PPSSPP's SasReverb.cpp. Both are emulations, not Sony code.
 */

export const SAS_RATE = 44100
export const SAS_PITCH_BASE = 0x1000
export const SAS_VOL_MAX = 0x1000
export const SAS_ENV_MAX = 0x40000000

/** SCE_SAS_ADSR_MODE_* (sceSasSetADSRMode). */
export const AdsrCurve = {
  LinearIncrease: 0,
  LinearDecrease: 1,
  LinearBent: 2,
  ExponentDecrease: 3,
  ExponentIncrease: 4,
  Direct: 5,
} as const
export type AdsrCurve = (typeof AdsrCurve)[keyof typeof AdsrCurve]
export const ADSR_CURVE_LABEL = ['linear increase', 'linear decrease', 'linear bent', 'exponent decrease', 'exponent increase', 'direct']

export interface SasAdsr {
  attackRate: number
  decayRate: number
  sustainRate: number
  releaseRate: number
  attackCurve: AdsrCurve
  decayCurve: AdsrCurve
  sustainCurve: AdsrCurve
  releaseCurve: AdsrCurve
  /** Decay ends when the height drops below this (sceSasSetSL; default 0). */
  sustainLevel: number
}

export interface SasVoiceParams {
  /** 0x1000 = 1.0 (one source sample per output sample at 44.1 kHz). */
  pitch: number
  adsr: SasAdsr
  volLeft: number
  volRight: number
  /** Effect (reverb) send volumes. */
  effectLeft: number
  effectRight: number
}

/** sceSasCore defaults for a voice: curves linear increase / decrease / decrease / decrease, SL 0. */
export const SAS_DEFAULT_ADSR: SasAdsr = {
  attackRate: 0,
  decayRate: 0,
  sustainRate: 0,
  releaseRate: 0,
  attackCurve: AdsrCurve.LinearIncrease,
  decayCurve: AdsrCurve.LinearDecrease,
  sustainCurve: AdsrCurve.LinearDecrease,
  releaseCurve: AdsrCurve.LinearDecrease,
  sustainLevel: 0,
}

/** The voice every sound effect is played with (sndPlaySeUi / sndPlaySe / sndPlaySeEx). */
export const GAME_SE_VOICE: SasVoiceParams = {
  pitch: 0x400,
  adsr: { ...SAS_DEFAULT_ADSR, attackRate: 0x40000000, decayRate: 100, sustainRate: 100, releaseRate: 0x10000000 },
  volLeft: 0x1000,
  volRight: 0x1000,
  effectLeft: 0x1000,
  effectRight: 0x1000,
}

/** sndSysInit's reverb setup. */
export const GAME_SAS_EFFECT = { type: 4 /* HALL */, dry: 1, wet: 0 /* fxsw */, volLeft: 0xc00, volRight: 0xc00 }

// ---------------------------------------------------------------------------------------------
// ADSR

const EnvState = {
  KeyOnStep: -42,
  KeyOn: -2,
  Off: -1,
  Attack: 0,
  Decay: 1,
  Sustain: 2,
  Release: 3,
} as const
type EnvState = (typeof EnvState)[keyof typeof EnvState]

const MAX_BIG = BigInt(SAS_ENV_MAX)

export class AdsrEnvelope {
  private state: EnvState = EnvState.Off
  private h = 0
  private a: SasAdsr

  constructor(adsr: SasAdsr) {
    this.a = adsr
  }

  /** Current height, 0 … 0x40000000. */
  get height() {
    return this.h > SAS_ENV_MAX ? SAS_ENV_MAX : this.h
  }
  get stateName() {
    return ({ [-42]: 'key on', [-2]: 'key on', [-1]: 'off', 0: 'attack', 1: 'decay', 2: 'sustain', 3: 'release' } as Record<number, string>)[this.state]
  }
  get ended() {
    return this.state === EnvState.Off
  }

  keyOn() {
    this.setState(EnvState.KeyOn)
  }
  keyOff() {
    this.setState(EnvState.Release)
  }
  end() {
    this.setState(EnvState.Off)
    this.h = 0
  }

  private setState(s: EnvState) {
    if (this.h > SAS_ENV_MAX) this.h = SAS_ENV_MAX
    this.state = s
  }

  private walk(curve: AdsrCurve, rate: number) {
    switch (curve) {
      case AdsrCurve.LinearIncrease:
        this.h += rate
        break
      case AdsrCurve.LinearDecrease:
        this.h -= rate
        break
      case AdsrCurve.LinearBent:
        this.h += this.h <= (SAS_ENV_MAX * 3) / 4 ? rate : Math.trunc(rate / 4)
        break
      case AdsrCurve.ExponentDecrease: {
        // 64-bit arithmetic: the product does not fit a double exactly.
        let d = BigInt(this.h) - MAX_BIG
        d += (-d * BigInt(rate)) >> 32n
        this.h = Number(d + MAX_BIG - (BigInt(rate >>> 0) + 3n) / 4n)
        break
      }
      case AdsrCurve.ExponentIncrease: {
        let d = BigInt(this.h) - MAX_BIG
        d += (-d * BigInt(rate)) >> 32n
        this.h = Number(d + 0x4000n + MAX_BIG)
        break
      }
      case AdsrCurve.Direct:
        this.h = rate
        break
    }
  }

  /** One output sample. */
  step() {
    const a = this.a
    switch (this.state) {
      case EnvState.Attack:
        this.walk(a.attackCurve, a.attackRate)
        if (this.h >= SAS_ENV_MAX || this.h < 0) this.setState(EnvState.Decay)
        break
      case EnvState.Decay:
        this.walk(a.decayCurve, a.decayRate)
        if (this.h < a.sustainLevel) this.setState(EnvState.Sustain)
        break
      case EnvState.Sustain:
        this.walk(a.sustainCurve, a.sustainRate)
        if (this.h <= 0) {
          this.h = 0
          this.setState(EnvState.Release)
        }
        break
      case EnvState.Release:
        this.walk(a.releaseCurve, a.releaseRate)
        if (this.h <= 0) {
          this.h = 0
          this.setState(EnvState.Off)
        }
        break
      case EnvState.KeyOn:
        this.h = 0
        this.setState(EnvState.KeyOnStep)
        break
      case EnvState.KeyOnStep:
        // The first ~32 samples after a key-on stay silent.
        this.h++
        if (this.h >= 31) {
          this.h = 0
          this.setState(EnvState.Attack)
        }
        break
    }
  }
}

// ---------------------------------------------------------------------------------------------
// voice

export interface SasVoiceRender {
  /** Dry output, 16-bit scale (±32768), 44.1 kHz. */
  left: Float32Array
  right: Float32Array
  /** Effect-send output (what the voice adds to the reverb input), same scale. */
  sendLeft: Float32Array
  sendRight: Float32Array
  /** Output samples before the first source sample (key-on delay). */
  delay: number
  /** Envelope height per output sample (0 … 0x40000000), for plots and checks. */
  envelope: Float32Array
}

/**
 * Renders one key-on of a voice sample by sample (SasInstance::MixVoice). `pcm` is the decoded VAG
 * (the whole clip, lead-in block included). `keyOffAt` = output sample of the key-off (se_stop), if
 * any. The render ends when the source runs out (the voice stops at the end of that grain, but the
 * rest of the grain is silent) or when the envelope has released.
 */
export function renderSasVoice(pcm: Int16Array, p: SasVoiceParams, keyOffAt = -1): SasVoiceRender {
  const env = new AdsrEnvelope(p.adsr)
  env.keyOn()
  // VAG voices wait (32 × pitch >> 12) + 1 samples before reading.
  const delay = ((32 * p.pitch) >> 12) + 1
  const srcOut = Math.ceil((pcm.length * SAS_PITCH_BASE) / p.pitch) + 1
  const total = keyOffAt >= 0 ? Math.min(delay + srcOut, keyOffAt + 1 + Math.ceil(SAS_ENV_MAX / Math.max(1, p.adsr.releaseRate)) + 1) : delay + srcOut
  const left = new Float32Array(total)
  const right = new Float32Array(total)
  const sendLeft = new Float32Array(total)
  const sendRight = new Float32Array(total)
  const envelope = new Float32Array(total)
  const interp = p.pitch !== SAS_PITCH_BASE
  let frac = 0
  let n = 0
  for (; n < total; n++) {
    if (n === keyOffAt) env.keyOff()
    if (n < delay) {
      envelope[n] = env.height
      env.step()
      continue
    }
    const i = frac >>> 12
    const s0 = i < pcm.length ? pcm[i] : 0
    const s1 = i + 1 < pcm.length ? pcm[i + 1] : 0
    let sample = s0
    if (interp) sample = s0 - (((s0 - s1) * (frac & 0xfff)) >> 12)
    frac += p.pitch
    let e = env.height
    envelope[n] = e
    env.step()
    e = (e + (1 << 14)) >> 15
    sample = (sample * e + (1 << 14)) >> 15
    left[n] = (sample * p.volLeft) >> 12
    right[n] = (sample * p.volRight) >> 12
    sendLeft[n] = (sample * p.effectLeft) >> 12
    sendRight[n] = (sample * p.effectRight) >> 12
    if (env.ended) {
      n++
      break
    }
  }
  const cut = (a: Float32Array) => a.subarray(0, n)
  return { left: cut(left), right: cut(right), sendLeft: cut(sendLeft), sendRight: cut(sendRight), delay, envelope: cut(envelope) }
}

// ---------------------------------------------------------------------------------------------
// reverb

interface ReverbPreset {
  name: string
  size: number
  // dAPF1 dAPF2 vIIR vCOMB1 vCOMB2 vCOMB3 vCOMB4 vWALL vAPF1 vAPF2 mLSAME mRSAME mLCOMB1 mRCOMB1
  // mLCOMB2 mRCOMB2 dLSAME dRSAME mLDIFF mRDIFF mLCOMB3 mRCOMB3 mLCOMB4 mRCOMB4 dLDIFF dRDIFF mLAPF1
  // mRAPF1 mLAPF2 mRAPF2
  v: number[]
}

const s16 = (x: number) => (x << 16) >> 16

/** The PSP HALL preset (SCE_SAS_FX_TYPE_HALL = 4), as tabulated by PPSSPP. */
export const HALL_PRESET: ReverbPreset = {
  name: 'Hall',
  size: 0xade0,
  v: [
    0x01a5, 0x0139, 0x6000, 0x5000, 0x4c00, 0xb800, 0xbc00, 0xc000, 0x6000, 0x5c00, 0x15ba, 0x11bb, 0x14c2, 0x10bd, 0x11bc, 0x0dc1,
    0x11c0, 0x0dc3, 0x0dc0, 0x09c1, 0x0bc4, 0x07c1, 0x0a00, 0x06cd, 0x09c2, 0x05c1, 0x05c0, 0x041a, 0x0274, 0x013a,
  ].map(s16),
}

const REV_BUFSIZE = 0x20000
const clamp16 = (x: number) => (x < -32768 ? -32768 : x > 32767 ? 32767 : x)
/** C `>> 15` on a value that may exceed 32 bits. */
const shr15 = (x: number) => Math.floor(x / 32768)

/**
 * The SAS reverb: runs at 22.05 kHz on a 0x20000-sample work area, one step per input frame.
 * `volLeft/Right` = sceSasSetEffectVolume values (0 … 0x1000).
 */
export class SasReverb {
  private buf = new Int16Array(REV_BUFSIZE)
  private pos: number
  private readonly p: ReverbPreset

  constructor(preset: ReverbPreset = HALL_PRESET) {
    this.p = preset
    this.pos = REV_BUFSIZE - preset.size
  }

  /** Processes 22.05 kHz stereo frames in place of PPSSPP's ProcessReverb; returns the wet output. */
  process(inL: ArrayLike<number>, inR: ArrayLike<number>, volLeft: number, volRight: number): [Float32Array, Float32Array] {
    const [dAPF1, dAPF2, vIIR, vCOMB1, vCOMB2, vCOMB3, vCOMB4, vWALL, vAPF1, vAPF2, mLSAME, mRSAME, mLCOMB1, mRCOMB1, mLCOMB2, mRCOMB2, dLSAME, dRSAME, mLDIFF, mRDIFF, mLCOMB3, mRCOMB3, mLCOMB4, mRCOMB4, dLDIFF, dRDIFF, mLAPF1, mRAPF1, mLAPF2, mRAPF2] = this.p.v
    const size = this.p.size
    const base = REV_BUFSIZE - size
    const buf = this.buf
    let pos = this.pos
    const at = (k: number) => {
      let a = pos + k
      if (a >= REV_BUFSIZE) a -= size
      if (a < base) a += size
      return a
    }
    const b = (k: number) => buf[at(k)]
    const set = (k: number, v: number) => (buf[at(k)] = clamp16(v))
    // The caller passes vol << 3 (0x1000 → 0x8000) and the ME return is one bit louder still.
    const vl = ((volLeft << 3) & 0xffff) << 1
    const vr = ((volRight << 3) & 0xffff) << 1
    const n = inL.length
    const outL = new Float32Array(n)
    const outR = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      // The send enters at a quarter of the mix level.
      const Lin = s16(inL[i] >> 2)
      const Rin = s16(inR[i] >> 2)
      set(mLSAME, Lin + ((b(dLSAME) * vWALL) >> 15) - ((b(mLSAME - 1) * vIIR) >> 15) + b(mLSAME - 1))
      set(mRSAME, Rin + ((b(dRSAME) * vWALL) >> 15) - ((b(mRSAME - 1) * vIIR) >> 15) + b(mRSAME - 1))
      set(mLDIFF, Lin + ((b(dRDIFF) * vWALL) >> 15) - ((b(mLDIFF - 1) * vIIR) >> 15) + b(mLDIFF - 1))
      set(mRDIFF, Rin + ((b(dLDIFF) * vWALL) >> 15) - ((b(mRDIFF - 1) * vIIR) >> 15) + b(mRDIFF - 1))
      let Lout = shr15(vCOMB1 * b(mLCOMB1) + vCOMB2 * b(mLCOMB2) + vCOMB3 * b(mLCOMB3) + vCOMB4 * b(mLCOMB4))
      let Rout = shr15(vCOMB1 * b(mRCOMB1) + vCOMB2 * b(mRCOMB2) + vCOMB3 * b(mRCOMB3) + vCOMB4 * b(mRCOMB4))
      set(mLAPF1, Lout - ((vAPF1 * b(mLAPF1 - dAPF1)) >> 15))
      Lout = b(mLAPF1 - dAPF1) + ((b(mLAPF1) * vAPF1) >> 15)
      set(mRAPF1, Rout - ((vAPF1 * b(mRAPF1 - dAPF1)) >> 15))
      Rout = b(mRAPF1 - dAPF1) + ((b(mRAPF1) * vAPF1) >> 15)
      set(mLAPF2, Lout - ((vAPF2 * b(mLAPF2 - dAPF2)) >> 15))
      Lout = b(mLAPF2 - dAPF2) + ((b(mLAPF2) * vAPF2) >> 15)
      set(mRAPF2, Rout - ((vAPF2 * b(mRAPF2 - dAPF2)) >> 15))
      Rout = b(mRAPF2 - dAPF2) + ((b(mRAPF2) * vAPF2) >> 15)
      outL[i] = clamp16(shr15(Lout * vl))
      outR[i] = clamp16(shr15(Rout * vr))
      pos++
      if (pos >= REV_BUFSIZE) pos -= size
    }
    this.pos = pos
    return [outL, outR]
  }
}

/**
 * SasInstance::ApplyWaveformEffect around the reverb: the 44.1 kHz send is decimated to 22.05 kHz by
 * keeping the even frames, and the wet output comes back on the even frames with zeros between.
 */
export function applySasReverb(sendL: Float32Array, sendR: Float32Array, volLeft: number, volRight: number, tail: number, preset = HALL_PRESET) {
  const frames = Math.ceil((sendL.length + tail) / 2)
  const dl = new Float32Array(frames)
  const dr = new Float32Array(frames)
  for (let i = 0; i < frames && i * 2 < sendL.length; i++) {
    dl[i] = clamp16(Math.trunc(sendL[i * 2]))
    dr[i] = clamp16(Math.trunc(sendR[i * 2]))
  }
  const [wl, wr] = new SasReverb(preset).process(dl, dr, volLeft, volRight)
  const outL = new Float32Array(frames * 2)
  const outR = new Float32Array(frames * 2)
  for (let i = 0; i < frames; i++) {
    outL[i * 2] = wl[i]
    outR[i * 2] = wr[i]
  }
  return [outL, outR] as const
}

/** Reverb tail rendered after the source ends (HALL decays below −60 dB in about 3 s). */
export const REVERB_TAIL = SAS_RATE * 4

export interface SeRender {
  left: Float32Array
  right: Float32Array
  voice: SasVoiceRender
}

/**
 * The full SAS output of one sound effect: voice → dry mix (+ wet reverb when `wet`), clipped to
 * 16 bits like sceSasCore, then sceWaveAudioWriteBlocking(2, 0x8000, 0x8000) (unity). Values are on
 * the ±32768 scale.
 */
export function renderSe(pcm: Int16Array, p: SasVoiceParams = GAME_SE_VOICE, opts: { wet?: boolean; keyOffAt?: number; effect?: typeof GAME_SAS_EFFECT } = {}): SeRender {
  const voice = renderSasVoice(pcm, p, opts.keyOffAt ?? -1)
  const fx = opts.effect ?? GAME_SAS_EFFECT
  const wet = opts.wet ?? fx.wet !== 0
  const n = voice.left.length + (wet ? REVERB_TAIL : 0)
  const left = new Float32Array(n)
  const right = new Float32Array(n)
  const dry = fx.dry !== 0
  let wl: Float32Array | null = null
  let wr: Float32Array | null = null
  if (wet) [wl, wr] = applySasReverb(voice.sendLeft, voice.sendRight, fx.volLeft, fx.volRight, REVERB_TAIL)
  for (let i = 0; i < n; i++) {
    let l = dry && i < voice.left.length ? voice.left[i] : 0
    let r = dry && i < voice.right.length ? voice.right[i] : 0
    if (wl && wr) {
      l += wl[i] ?? 0
      r += wr[i] ?? 0
    }
    left[i] = clamp16(l)
    right[i] = clamp16(r)
  }
  return { left, right, voice }
}

/**
 * The HALL reverb's response to a unit send at an even frame, for a ConvolverNode (1.0 = full
 * scale). Halved, because the real path drops the odd send frames (a convolution cannot), so a
 * convolution with the even-frame response would be 6 dB too loud on average.
 */
export function hallImpulseResponse(volLeft = GAME_SAS_EFFECT.volLeft, volRight = GAME_SAS_EFFECT.volRight, length = REVERB_TAIL): [Float32Array, Float32Array] {
  const A = 16384
  const sendL = new Float32Array(2)
  const sendR = new Float32Array(2)
  sendL[0] = sendR[0] = A
  const [l, r] = applySasReverb(sendL, sendR, volLeft, volRight, length)
  const k = 0.5 / A
  return [l.map((x) => x * k), r.map((x) => x * k)]
}

// ---------------------------------------------------------------------------------------------
// libwave (voices, goc.dat)

/**
 * sceWaveSetVoice fade length: sceWaveStop / a re-play fades the channel out linearly over 0x70
 * samples (44.1 kHz, no resampling) before it stops. sceWavePlay volumes are 0 … 127 (→ 0 … 0x1000);
 * sndPlayVoiceVag plays at 0x7F (full).
 */
export const WAVE_FADE_SAMPLES = 0x70
