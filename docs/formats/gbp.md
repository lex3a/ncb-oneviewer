# GBP image

Paletted bitmap, 8 or 4 bits per pixel, optionally compressed. 2422 files in the game.

The game's loader is `FUN_0887bff8` (`spriteLoadBuffer()` in its error strings). Facts marked
**code** come from it; the rest were checked against every file.

## Layout

| Offset | Type | Description |
| --- | --- | --- |
| 0x00 | char[4] | `"GBP\0"` |
| 0x04 | u32 | always 0 |
| 0x08 | u32 | total size in bytes: header + palette + pixel data |
| 0x0C | u32 | always 0 |
| 0x10 | u16 | width |
| 0x12 | u16 | height |
| 0x14 | u8 | pixel format: `0x13` = 8 bpp, `0x14` = 4 bpp. The loader also accepts `0` = 32-bit RGBA, `1` = 24-bit RGB and `2` = 16-bit (**code**), but the game data never uses them |
| 0x15 | u8 | always 0 |
| 0x16 | u16 | always 1 |
| 0x18 | u8 | compression: `0` raw, `1` RLE, anything else fill runs (**code**; only 2 occurs) |
| 0x1C | u32 | always 0 |
| 0x20 | palette | 256 × 4 bytes (8 bpp) or 16 × 4 bytes (4 bpp) |
| … | — | pixel data up to `size` |

The "always" values hold for every file in the game (**confirmed**).

| Format | Compression 0 | Compression 1 | Compression 2 |
| --- | ---: | ---: | ---: |
| 8 bpp (`0x13`) | 855 | 41 | 859 |
| 4 bpp (`0x14`) | 183 | 252 | 232 |

## Palette

Each entry is `R, G, B, A`, one byte each. Alpha uses the PS2/PSP GE range: `0x80` is fully opaque and
`0x00` fully transparent. The loader scales it with `(a * 255) >> 7` (**code**). In practice index 0 is usually the
transparent color.

**256-color palettes are CLUT-swizzled** (the PS2 layout): inside every block of 32 entries, entries
8–15 and 16–23 are swapped. Equivalently, swap bits 3 and 4 of the index:

```ts
const unswizzle = (i: number) => (i & 0xe7) | ((i & 0x08) << 1) | ((i & 0x10) >> 1)
palette[i] = raw[unswizzle(i)]
```

**Confirmed** by the loader, which copies the 256-color CLUT in blocks of 8 entries into slots
+8/−8/0 (**code**), and statistically: after unswizzling, adjacent pixels are more similar in 1139 of
1140 8 bpp images. 16-color palettes are not swizzled.

## Pixel data

Rows are stored top to bottom, with no row padding. The decompressed stream is
`ceil(width × height × bpp / 8)` bytes. In 4 bpp images the **low nibble is the left pixel**.

All compression schemes work on this packed byte stream, not on pixels. In 4 bpp a "byte" is therefore
two pixels.

### Compression 0 — raw

The stream is stored as is.

### Compression 1 — RLE

A sequence of `(value u8, count u8)` pairs. Each pair writes `value` `count` times. The counts sum
exactly to the stream length (**confirmed**, all 293 files).

### Compression 2 — fill runs

Designed for sprites with large transparent areas.

| Offset | Type | Description |
| --- | --- | --- |
| 0x0 | u32 | run count *R* |
| 0x4 | u32 | fill byte (low 8 bits are used) |
| 0x8 | run[R] | `{u32 position, u32 length}`, sorted by position |
| 0x8 + 8R | u8[] | literal bytes |

Decoding: walk the output from 0. Before each run, copy literal bytes up to `position`. Then write the
fill byte `length` times. After the last run, copy literals to the end of the stream.
`literals + Σ length == stream length` in 1088 of 1091 files (**confirmed**). The remaining 3 files
are short. In all three the last run ends before the end of the stream, so the missing bytes are the
final literals:

| File | Size | Last run ends | Stream | Missing | Bytes that follow in the archive |
| --- | --- | ---: | ---: | ---: | --- |
| card.one `10020/109` | 96×56, 4 bpp | 2679 | 2688 | 9 | CLC2 alignment zeros |
| unit.one `109/11` (same image) | 96×56, 4 bpp | 2679 | 2688 | 9 | CLC2 alignment zeros |
| etc.one `310/402` | 208×70, 8 bpp | 12192 | 14560 | 200 | 1 zero, then the header and palette of member 500 |

**What the game does** (**code**, `spriteLoadBuffer` 0x0887BFF8):
- The decoder always writes exactly `stream length` bytes and never checks the input size, so it
  **reads past the end**.
- The whole ONE entry is read into `g_fileReadBuffer`, and `clc2FindMember` returns a pointer into it.
  The bytes read past the end are therefore the next bytes of the entry.
- For the two 96×56 images that gives 0 (index 0 in the last 18 pixels). For `310/402` it gives the
  next member's header and palette bytes as pixel indices in the last 200 pixels of the bottom row.
- The viewer fills the tail with the fill byte instead (0xEE and 0x01 here).

None of this is visible in the game: all three images are in data the game never loads (card.one
10020, unit.one `/11`, and the etc.one 310 plates other than `area*100`; see
[database.md](database.md#never-loaded-data-how-it-was-checked)).

Other details of the game's decoder:
- The run table is first copied to a fixed buffer (0x0909E8E0) with a `{0, 0}` terminator. The buffer
  size is not checked. The most runs in any file is 1157.
- It advances at most one run per output byte: when the position reaches the end of the current run
  and that run is non-empty. A zero-length run would stall the walk, so every later byte would be a
  literal. None of the 1091 fill-run files has zero-length or overlapping runs (**confirmed**).
- The first literal is read right after the run table.

The fill byte is not always 0: some card pictures use the background color's index (e.g. `0x0A`).

The loader also accepts PlayStation TIM images (4 bpp, magic `10 00`). They do not occur in the
game data.

Reference implementation: [`src/formats/gbp.ts`](../../src/formats/gbp.ts),
[`src/formats/palette.ts`](../../src/formats/palette.ts).
