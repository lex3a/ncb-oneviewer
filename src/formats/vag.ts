/**
 * Sound banks (snd/bgm.dat, se.dat, goc.dat): Sony VAG files concatenated back to back, each
 * starting on a 2048-byte boundary. See docs/formats/sound.md.
 *
 * VAG header (0x30 bytes, big endian):
 *   0x00 "VAGp", 0x04 version (4), 0x0C data size, 0x10 sample rate, 0x20 char[16] name
 * followed by `size` bytes of PSX ADPCM: 16-byte blocks of 28 mono samples.
 */
export interface VagClip {
  index: number
  name: string
  offset: number
  rate: number
  /** ADPCM data (the first block is the usual all-zero lead-in). */
  data: Uint8Array
}

export function isVagBank(b: Uint8Array): boolean {
  return b.length >= 0x30 && b[0] === 0x56 && b[1] === 0x41 && b[2] === 0x47 && b[3] === 0x70
}

export function parseVagBank(bytes: Uint8Array): VagClip[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const dec = new TextDecoder('latin1')
  const clips: VagClip[] = []
  let o = 0
  while (o + 0x30 <= bytes.length) {
    if (!(bytes[o] === 0x56 && bytes[o + 1] === 0x41 && bytes[o + 2] === 0x47 && bytes[o + 3] === 0x70)) {
      o += 16 // padding between clips (they are sector aligned)
      continue
    }
    const size = dv.getUint32(o + 12)
    const rate = dv.getUint32(o + 16)
    const raw = bytes.subarray(o + 32, o + 48)
    const end = raw.indexOf(0)
    const name = dec.decode(end < 0 ? raw : raw.subarray(0, end))
    clips.push({ index: clips.length, name, offset: o, rate, data: bytes.subarray(o + 0x30, Math.min(bytes.length, o + 0x30 + size)) })
    o += 0x30 + size
  }
  return clips
}

const F0 = [0, 60, 115, 98, 122]
const F1 = [0, 0, -52, -55, -60]

export interface DecodedVag {
  samples: Int16Array
  /** Loop points in samples, if the clip carries loop flags. */
  loopStart?: number
  loopEnd?: number
}

/** Decodes PSX ADPCM. Block flags: bit0 = end, bit1 = repeat, bit2 = loop start; 7 = silent end. */
export function decodeVag(data: Uint8Array): DecodedVag {
  const blocks = Math.floor(data.length / 16)
  const out = new Int16Array(blocks * 28)
  let n = 0
  let s1 = 0
  let s2 = 0
  let loopStart: number | undefined
  let loopEnd: number | undefined
  for (let b = 0; b < blocks; b++) {
    const o = b * 16
    const shift = data[o] & 0x0f
    const filter = Math.min(4, data[o] >> 4)
    const flags = data[o + 1]
    if (flags === 7) break
    if (flags & 4) loopStart = n
    for (let i = 0; i < 28; i++) {
      const byte = data[o + 2 + (i >> 1)]
      const nib = i & 1 ? byte >> 4 : byte & 0x0f
      let s = ((nib << 28) >> 28) << 12 >> shift
      s += (s1 * F0[filter] + s2 * F1[filter] + 32) >> 6
      s = s < -32768 ? -32768 : s > 32767 ? 32767 : s
      out[n++] = s
      s2 = s1
      s1 = s
    }
    if (flags & 1) {
      if (flags & 2) loopEnd = n
      break
    }
  }
  return { samples: out.subarray(0, n), loopStart, loopEnd }
}

/** 16-bit mono PCM WAV. */
export function encodeWav(samples: Int16Array, rate: number): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2)
  const dv = new DataView(out.buffer)
  const str = (o: number, s: string) => [...s].forEach((c, i) => (out[o + i] = c.charCodeAt(0)))
  str(0, 'RIFF')
  dv.setUint32(4, 36 + samples.length * 2, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  dv.setUint32(16, 16, true)
  dv.setUint16(20, 1, true)
  dv.setUint16(22, 1, true)
  dv.setUint32(24, rate, true)
  dv.setUint32(28, rate * 2, true)
  dv.setUint16(32, 2, true)
  dv.setUint16(34, 16, true)
  str(36, 'data')
  dv.setUint32(40, samples.length * 2, true)
  new Int16Array(out.buffer, 44, samples.length).set(samples)
  return out
}
