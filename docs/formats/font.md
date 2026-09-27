# Font (`gothic16.bin`)

A 16×16 bitmap font for Shift-JIS text, loaded by `fullfontLoad` (EBOOT 0x08877740).

## Layout

- 8127 glyphs (0x1FBF) × 32 bytes = 0x3F7E0 bytes, no header.
- 1 bit per pixel, 16 rows of 2 bytes, **most significant bit = leftmost pixel**.

## Loading (**code**)

`fullfontLoad` expands every glyph to 4 bpp (0x80 bytes): index 1 = glyph pixel, index 2 = an
8-neighbour outline around it. It sets up 16 palettes from `g_fontPaletteColors`. `fullfontGet`
then copies glyphs on demand into a 256-slot texture atlas.

## Shift-JIS → glyph index (**code**, `fullfontInit` 0x088773f0)

| Codes | Glyph index |
| --- | --- |
| 0x8140–0x84BF | `(lead − 0x81) × 189 + (trail − 0x40)` (symbols, kana, Greek, Cyrillic) |
| 0x889F–0x9FFF | `code − 0x43 × (lead − 0x81) + 0x7D46` (mod 0x10000) (JIS level-1 kanji and the first level-2 rows) |
| 0xE040–0xEABF | `code − 0x43 × (lead − 0xE0) + 0x3529` (mod 0x10000) (rest of level 2) |
| anything else | glyph 0x3E |

189 = number of trail bytes 0x40–0xFC per row, including the unused 0x7F.

Single-byte ASCII is first converted to the full-width form by `strAsciiToSjis` (table
`g_asciiToSjisTable`), so all text is drawn with these 16×16 glyphs.

## Unreachable glyphs (**data**)

471 glyphs contain ink but no code maps to them:

- **756–848** — the NEC row 0x87 (circled numbers ①…, Roman numerals). They sit between rows 0x84 and
  0x88, but `fullfontInit` sends codes 0x85–0x87 to the fallback glyph.
- **7560–7949** — about two more rows after 0xEA (extended kanji).

Reference implementation: [`src/formats/font.ts`](../../src/formats/font.ts).
