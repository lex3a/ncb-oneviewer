# GAN animated sprite

A 4 bpp sprite sheet plus an animation: a list of timed steps, each showing a frame composed of
rectangles cut from the sheet. There are 1168 files in the game, and every one parses to exactly its
declared size.

This document follows the game's own code in the USA EBOOT:

| Function | Role |
| --- | --- |
| `FUN_08878ad4` | `ganLoadBuffer()`, the parser. Named by its error strings |
| `FUN_08879ff8` | draws the current frame |
| `FUN_0887a300` | shadow/silhouette pass |
| `FUN_08879b70` | animation timer |
| `FUN_0888cf84` | battle routine (uses the markers) |
| `FUN_08891af0` | script-object renderer (shadow + normal pass) |
| `FUN_08880e60` | sprite vertex transform |

Facts marked **code** come from those functions. Facts marked **data** were checked against all files.

## Layout

| Offset | Type | Description |
| --- | --- | --- |
| 0x00 | char[4] | `"GAN\x10"` (the loader checks only `G`, `A`, `N`) |
| 0x04 | u32 | total size in bytes |
| 0x08 | u8 | bits per pixel (4) |
| 0x0A | u8 | `0x20`. Copied into the object (G+0x25D) but never read (**code**, program-wide scan) |
| 0x0C | u32 | 1 (not read) |
| 0x10 | u32 | palette count *P*. The image count is `P >> 4` (**code**) |
| 0x14 | u8 len, u8[len] | skipped field, `0B` + 11 × `FF` in all files. With len = 0 the loader skips 1 byte |
| … | palette[P] | *P* × 16 colors × 4 bytes (RGBA) |
| … | image[P/16] | see below |
| … | steps | animation sequence |
| … | frames | frame definitions |
| … | u32 + bytes | trailing list: `u32 count`, then `count − 1` bytes that the loader skips without reading. The count is 0 in all files, so the entry format is unknowable and irrelevant (**code**) |
| size − 4 | u32 | 1 (not read) |

All files have one image and P = 16 (**data**), so the image starts at 0x420.

### Palettes

16 colors each, stored as `R, G, B, A`. Palette *n* belongs to image `n >> 4` and is slot `n & 15`
within it. While uploading, `ganLoadBuffer` changes them (**code**):

- Any non-zero alpha becomes 0xFF. Translucency comes from the part's blend mode, not from the palette.
- Slot **12** is cleared to all-transparent. Parts using it are *markers*, see below.
- Slot **15** is replaced by a silhouette: entry 0 transparent, entries 1–15 = `(1, 1, 1)` opaque black.

### Image

| Offset | Type | Description |
| --- | --- | --- |
| 0x00 | u32 | image id, 1 (skipped) |
| 0x04 | u16 | width (256 in all files) |
| 0x06 | u16 | height (64, 128 or 256) |
| 0x08 | u8 len, u8[len] | skipped field, `07` + 7 × `FF` |
| … | u8[64] | a 16-color palette, **ignored by the loader** (always equal to palette 0) |
| … | u8[w·h·bpp/8] | pixels, low nibble = left pixel, no row padding |

### Steps

| Offset | Type | Description |
| --- | --- | --- |
| 0x0 | u16 (+2 pad) | step count *S* |
| 0x4 | step[S] | 16 bytes each |

| Offset | Type | Description |
| --- | --- | --- |
| 0x0 | u8 | frame index |
| 0x2 | u8 | duration in ticks (1 tick = 1 game frame = 1/60 s, see below). **255 = forever**: the loader stores 0x10000000 (**code**) |
| 0x4 | i8 | x value, **unused** |
| 0x6 | i8 | y value, **unused** |
| 0x8 | — | `FF FF 00 00 00 00 00 00` in all files, not read |

The timer adds 1 tick per draw call and wraps modulo the total duration, so animations loop (**code**,
`FUN_08879b70`). A step of 255 ticks therefore ends the animation on that frame. It only occurs on the
last step (**data**: 738 animations).

The x/y bytes are copied into the object, but nothing in the engine reads them: not the renderer, the
timer, the battle code or the script VM (**code**, program-wide scan of all byte loads). They are
probably left over from the authoring tool. The viewer ignores them.

### Frames

| Offset | Type | Description |
| --- | --- | --- |
| 0x0 | u16 (+2 pad) | frame count *F* |
| 0x4 | frame[F] | `u16 partCount` (+2 pad, at most 32 — the loader reports "n_sprite over") followed by parts |

### Part (20 bytes)

| Offset | Type | Description |
| --- | --- | --- |
| 0x00 | u16 | image index (clamped to the image count) |
| 0x02 | u16 | palette index *n* (clamped to *P*): image `n >> 4`, slot `n & 15` |
| 0x04 | u8 | source x in the sheet |
| 0x05 | u8 | source y |
| 0x06 | u8 | destination x + 128 |
| 0x07 | u8 | destination y + 128 |
| 0x08 | u16 | width |
| 0x0A | u16 | height |
| 0x0C | u8 | flags, see below |
| 0x0D | u8 | 0 |
| 0x0E | u16 | angle, signed 12-bit: values ≥ 0x800 are negative. Degrees = angle × 360 / 4096 |
| 0x10 | i16 | scale x, 4.12 fixed point. **Negative values mirror** (157 parts do) |
| 0x12 | i16 | scale y |

The destination is relative to the sprite's origin: `(dx − 128, dy − 128)`. It is the **top-left**
corner of the unrotated part (**code**: vertex = position + pivot + R·S·(corner − pivot)).

### Part flags (u8)

| Bits | Meaning |
| --- | --- |
| 0x01 | enable blend mode (bits 4–5). Without it the part is drawn opaque with normal alpha blending |
| 0x04 | rotate by `angle` around the part's centre |
| 0x08 | scale by `scale x/y` around the part's centre |
| 0x30 | blend mode, used only when 0x01 is set |

The 0x10/0x20 bits on parts without 0x01 have no effect (they are common on plain card sprites).

Blend modes (**code**: `ganLoadBuffer`, `FUN_08879ff8`, `FUN_0887f1d0`):

| Mode | Vertex alpha | GE blend | Effect | Parts |
| --- | --- | --- | --- | ---: |
| 0 | 0x40 | `src·α + dst·(1−α)` | 50% translucent | 99 |
| 1 | 0x7F | `src·α + dst·(1−dstα)` | additive | 739 |
| 2 | 0 | normal | invisible | 0 |
| 3 | 0x20 | `src·α + dst·(1−dstα)` | 25% additive | 270 |

Odd modes use destination factor `ONE_MINUS_DST_ALPHA`. The PSP frame buffer's alpha is 0 here, so
this is additive blending (**inferred** from the GE setup). The vertex alpha is additionally multiplied
by the object's global alpha.

### Markers (palette slot 12) — the hit frame

A part whose palette slot is 12 gets a zero-size rectangle and is never visible (**code**). The loader
collects the first 4 frames that contain such a part and remembers up to 4 steps that show them
(object field G+0x254, 0x7F = none). 143 animations have markers (**data**), all battle attack
animations (`/22` in unit.one).

How the game uses them (**code**):

- The battle routine `FUN_0888cf84` asks `FUN_08875b44(anim, 2, 12)` for the marker steps of the
  attack animation (index 2 in the unit's animation set; 0/1 are idle, 3 is "hurt"). When the attacker
  reaches the **first** marker step, it computes the damage (`FUN_0888cc9c`) and starts the effect script
  (`FUN_0888ef48` → effect id + 1000). One or five frames later, depending on the effect, it switches the
  defender to the hurt animation.
- Effect scripts can read the marker step too: script call 0x1C5 (`FUN_08895e78` → `FUN_0887a574`)
  returns marker step *n* of an animation object.
- The marker's *position* (its dx/dy) is never read. Effects position themselves.

### Ground shadow

The script-object renderer `FUN_08891af0` draws every animation object twice (**code**):

1. **Shadow pass** (`FUN_08875870` → `FUN_0887a300`). The whole animation is rotated by +90° around X, so
   it lies flat on the floor. It is placed at y = −1 (ground level) and shifted by the unit's height. Every
   part that is not additive is drawn with image 0's **palette 15** (the black silhouette CLUT), normal
   blending, and the object's RGBA. The animation timer does not advance in this pass.
2. **Normal pass** (`FUN_088756a4` → `FUN_08879ff8`): the visible sprite, which also advances the timer.

So palette 15 is the shadow palette, and additive glow parts cast no shadow.

Seen through the effects' usual camera (pitched 45°), the flat copy has the same screen length as the
upright body, so the shadow looks like the body mirrored below its feet. The viewer's "shadow" option
draws it that way. Only script animation objects have a shadow; duel units and board units do not.

## Runtime behaviour

- **Tick rate.** The main loop (`FUN_088477d4`) updates and draws once per iteration, then waits for
  exactly one vertical blank (`FUN_08848da4` → `sceDisplayWaitVblankStartCB`). The GAN timer advances
  one tick per draw, so **1 tick = 1 frame = 1/60 s**. There is no frame skipping: if the game drops
  frames, animations slow down.
- **Looping.** The timer wraps modulo the total duration (`FUN_08879b70`), so every animation loops.
  "One-shot" animations are handled by callers: they poll the "on last step" flag and switch to another
  animation. A 255-tick last step effectively holds the frame.
- **Animation sets.** A unit's animations are loaded into a manager object (`FUN_08874754`), and
  switching (`FUN_08874a38`) restarts the new animation from tick 0.
- **Mirroring.** There is no flip flag in the file. The left-hand combatant is mirrored by rotating the
  whole sprite by −π around Y (`FUN_0888dea8`).
- **Object color and scale.** The object color defaults to `80 80 80 FF` (neutral) and multiplies the
  vertex color. Its alpha scales every part's blend alpha. An object scale moves the part offsets
  around the sprite pivot.

## Rendering a frame

```ts
for (const p of frame) {
  if ((p.clut & 15) === 12) continue                       // marker
  const { alpha, additive } = blend(p)                     // table above
  ctx.globalAlpha = alpha
  ctx.globalCompositeOperation = additive ? 'lighter' : 'source-over'
  ctx.translate(originX + p.dx + p.w / 2, originY + p.dy + p.h / 2)   // dx already includes +128
  if (p.flags & 4) ctx.rotate(p.angleDegrees * Math.PI / 180)
  if (p.flags & 8) ctx.scale(p.scaleX, p.scaleY)           // may be negative
  ctx.drawImage(sheet[p.image][p.clut], p.sx, p.sy, p.w, p.h, -p.w / 2, -p.h / 2, p.w, p.h)
}
```

Reference implementation: [`src/formats/gan.ts`](../../src/formats/gan.ts).
