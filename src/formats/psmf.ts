/**
 * PSMF movies (Movie/*.pmf). See docs/formats/media.md.
 *
 * "PSMF0015" header; u32 BE at +8 = offset of an MPEG-2 program stream (0x800). Video is H.264 in
 * stream 0xE0. Audio is ATRAC3plus in private stream 1 (0xBD), sub-stream 0x00: every PES payload
 * starts with 4 bytes (sub-stream id, 0, u16 first-frame pointer), and the concatenated payloads
 * are a sequence of frames, each prefixed by an 8-byte header `0F D0 <config u16> 00 00 00 00`.
 *
 * ffmpeg's MPEG-PS demuxer does not recognise that audio stream, so it is extracted here and
 * wrapped in the same RIFF/WAVE container the game's .at3 files use.
 */
export interface PsmfAudio {
  /** RIFF WAVE (WAVE_FORMAT_EXTENSIBLE, ATRAC3plus GUID), decodable by ffmpeg. */
  riff: Uint8Array
  frames: number
  channels: number
  rate: number
  frameBytes: number
}

export const isPsmf = (b: Uint8Array) => b.length > 16 && String.fromCharCode(...b.subarray(0, 4)) === 'PSMF'

const AT3P_GUID = [0xbf, 0xaa, 0x23, 0xe9, 0x58, 0xcb, 0x71, 0x44, 0xa1, 0x19, 0xff, 0xfa, 0x01, 0xe4, 0xce, 0x62]
const RATES = [32000, 44100, 48000]
const SAMPLES_PER_FRAME = 2048

/** Collects the payloads of private-stream-1 sub-stream 0 from the program stream. */
function audioPayloads(b: Uint8Array): Uint8Array[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const out: Uint8Array[] = []
  let i = dv.getUint32(8)
  while (i + 6 < b.length) {
    if (b[i] !== 0 || b[i + 1] !== 0 || b[i + 2] !== 1 || b[i + 3] < 0xb9) {
      i++
      continue
    }
    const id = b[i + 3]
    if (id === 0xb9) break // program end
    if (id === 0xba) {
      i += 14 + (b[i + 13] & 7) // pack header
      continue
    }
    const len = dv.getUint16(i + 4)
    if (id === 0xbd) {
      const p = i + 9 + b[i + 8]
      if (b[p] === 0x00) out.push(b.subarray(p + 4, i + 6 + len))
    }
    i += 6 + len
  }
  return out
}

export function extractPsmfAudio(b: Uint8Array): PsmfAudio | null {
  const parts = audioPayloads(b)
  const total = parts.reduce((n, p) => n + p.length, 0)
  if (!total) return null
  const stream = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    stream.set(p, o)
    o += p.length
  }

  // Find the first frame header to learn the configuration.
  let pos = 0
  while (pos + 8 <= stream.length && !(stream[pos] === 0x0f && stream[pos + 1] === 0xd0)) pos++
  if (pos + 8 > stream.length) return null
  const cfg = (stream[pos + 2] << 8) | stream[pos + 3]
  const frameBytes = ((cfg & 0x3ff) + 1) * 8
  const channels = (cfg >> 10) & 7
  const rate = RATES[(cfg >> 13) & 3] ?? 44100

  const frames: Uint8Array[] = []
  while (pos + 8 + frameBytes <= stream.length) {
    if (stream[pos] === 0x0f && stream[pos + 1] === 0xd0) {
      frames.push(stream.subarray(pos + 8, pos + 8 + frameBytes))
      pos += 8 + frameBytes
    } else pos++ // resync
  }
  if (!frames.length) return null

  const dataLen = frames.length * frameBytes
  const riff = new Uint8Array(12 + 8 + 0x34 + 8 + 8 + 8 + dataLen)
  const dv = new DataView(riff.buffer)
  let w = 0
  const str = (s: string) => {
    for (const c of s) riff[w++] = c.charCodeAt(0)
  }
  const u16 = (v: number) => {
    dv.setUint16(w, v, true)
    w += 2
  }
  const u32 = (v: number) => {
    dv.setUint32(w, v, true)
    w += 4
  }
  str('RIFF')
  u32(riff.length - 8)
  str('WAVE')
  str('fmt ')
  u32(0x34)
  u16(0xfffe) // WAVE_FORMAT_EXTENSIBLE
  u16(channels)
  u32(rate)
  u32(Math.round((frameBytes * rate) / SAMPLES_PER_FRAME))
  u16(frameBytes) // block align = one ATRAC3plus frame
  u16(0)
  u16(0x22)
  u16(SAMPLES_PER_FRAME)
  u32(channels === 1 ? 0x4 : 0x3)
  for (const g of AT3P_GUID) riff[w++] = g
  u16(1) // version
  riff[w++] = cfg >> 8 // frame header config, big endian as in the stream
  riff[w++] = cfg & 0xff
  w += 8
  str('fact')
  u32(8)
  u32(frames.length * SAMPLES_PER_FRAME)
  u32(0)
  str('data')
  u32(dataLen)
  for (const f of frames) {
    riff.set(f, w)
    w += frameBytes
  }
  return { riff, frames: frames.length, channels, rate, frameBytes }
}
