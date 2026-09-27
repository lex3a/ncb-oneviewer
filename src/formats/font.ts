/**
 * gothic16.bin — the game's 16×16 Shift-JIS font. See docs/formats/font.md.
 *
 * 8127 glyphs × 32 bytes, 1 bit per pixel, 2 bytes per row, most significant bit = leftmost pixel.
 * fullfontInit (EBOOT 0x088773f0) maps Shift-JIS codes to glyph indices; fullfontLoad expands each
 * glyph to 4bpp and adds an 8-neighbour outline (index 2 around every set pixel).
 */
export const GLYPH = 16
export const GLYPH_BYTES = 32
export const FALLBACK_GLYPH = 0x3e

export function isFont(name: string, b: Uint8Array): boolean {
  return /gothic16\.bin$/i.test(name) && b.length % GLYPH_BYTES === 0
}

export const glyphCount = (font: Uint8Array) => Math.floor(font.length / GLYPH_BYTES)

const validTrail = (t: number) => t >= 0x40 && t <= 0xfc && t !== 0x7f

/** Same arithmetic as fullfontInit; returns FALLBACK_GLYPH for codes outside the font. */
export function sjisToGlyph(code: number): number {
  const lead = code >> 8
  if (code >= 0x8140 && code <= 0x84bf) return ((code - 0x43 * (lead - 0x81) + 0x7ec0) & 0xffff)
  if (code >= 0x889f && code <= 0x9fff) return ((code - 0x43 * (lead - 0x81) + 0x7d46) & 0xffff)
  if (code >= 0xe040 && code <= 0xeabf) return ((code - 0x43 * (lead - 0xe0) + 0x3529) & 0xffff)
  return FALLBACK_GLYPH
}

let tables: { glyphToCode: Map<number, number>; charToCode: Map<string, number>; codeToChar: Map<number, string> } | null = null

/** Glyph → first Shift-JIS code, and Unicode char ↔ Shift-JIS code (built with TextDecoder). */
export function fontTables() {
  if (tables) return tables
  const glyphToCode = new Map<number, number>()
  const charToCode = new Map<string, number>()
  const codeToChar = new Map<number, string>()
  let dec: TextDecoder | null = null
  try {
    dec = new TextDecoder('shift_jis', { fatal: true })
  } catch {
    dec = null
  }
  for (let lead = 0x81; lead <= 0xef; lead++) {
    if (lead > 0x9f && lead < 0xe0) continue
    for (let trail = 0x40; trail <= 0xfc; trail++) {
      if (!validTrail(trail)) continue
      const code = (lead << 8) | trail
      const g = sjisToGlyph(code)
      if (g !== FALLBACK_GLYPH || code === 0x817e) {
        if (!glyphToCode.has(g)) glyphToCode.set(g, code)
      }
      if (dec) {
        try {
          const ch = dec.decode(new Uint8Array([lead, trail]))
          if (ch.length === 1 && ch !== '�') {
            codeToChar.set(code, ch)
            if (!charToCode.has(ch)) charToCode.set(ch, code)
          }
        } catch {
          /* unmapped code */
        }
      }
    }
  }
  tables = { glyphToCode, charToCode, codeToChar }
  return tables
}

/** Text → glyph indices, converting ASCII to full-width like strAsciiToSjis does. */
export function textToGlyphs(text: string): number[] {
  const { charToCode } = fontTables()
  return [...text].map((ch) => {
    let c = ch
    const cp = ch.codePointAt(0) ?? 0
    if (cp === 0x20) c = '　'
    else if (cp > 0x20 && cp < 0x7f) c = String.fromCodePoint(cp + 0xfee0)
    const code = charToCode.get(c)
    return code === undefined ? FALLBACK_GLYPH : sjisToGlyph(code)
  })
}

/** 16×16 glyph as 0 (empty) / 1 (ink) / 2 (outline, if requested). */
export function glyphPixels(font: Uint8Array, index: number, outline = false): Uint8Array {
  const px = new Uint8Array(GLYPH * GLYPH)
  const o = index * GLYPH_BYTES
  for (let y = 0; y < GLYPH; y++) {
    const row = (font[o + y * 2] << 8) | font[o + y * 2 + 1]
    for (let x = 0; x < GLYPH; x++) if (row & (0x8000 >> x)) px[y * GLYPH + x] = 1
  }
  if (outline) {
    for (let y = 0; y < GLYPH; y++)
      for (let x = 0; x < GLYPH; x++) {
        if (px[y * GLYPH + x] !== 1) continue
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx
            const ny = y + dy
            if (nx >= 0 && ny >= 0 && nx < GLYPH && ny < GLYPH && px[ny * GLYPH + nx] === 0) px[ny * GLYPH + nx] = 2
          }
      }
  }
  return px
}
