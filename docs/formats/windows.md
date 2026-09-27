# Message windows

How the game draws its message, menu and panel windows: the per-style draw functions, the text,
icon and digit glyphs, the menu cursor and the "next" arrow. Everything here is **code** (Ghidra, USA
EBOOT, struct `Window` 0xA4 and `WinGlyph` 0x30) unless marked otherwise. The viewer draws windows
with [`src/effect/windows.ts`](../../src/effect/windows.ts) (duel, story) and shows every style under
**Card database → Windows** ([`src/components/WindowsView.tsx`](../../src/components/WindowsView.tsx)).

Coordinates are the 640×448 virtual space. Sprites go through `spriteUpdateVertices`/`spriteDraw2D`:
vertex = position + pivot + trunc(scale·(corner − pivot)), then x·480/640 and y·272/448 truncated.
`spriteSetSrcRect` resets the pivot to the top-left, so every skin sprite below grows right and down
from the given position. Untextured quads are `Prim2D` (see [Prim2D](#prim2d-and-the-line-quirk)).
All windows use depth 0 (GE z 0x7FFF) unless a caller sets `win+0x24`.

## Per-frame loop — `menuWinUpdateAll` (0x08867E14)

For each window in list order (`g_winListHead`; later = on top):

1. Voice lock `win+0x74` −1.
2. Dimming (flag 0x800): the last window gains 8 brightness up to 0x80, the others lose 8 down to 0x38.
3. Typewriter (flag 2): until the text is complete or at a page break, `typeTimer` counts down; at 0
   it is set to `typeDelay` and `msgParseNextGlyph` runs once. With delay 0 the whole text is parsed
   in one frame. `＠ｗN` sets the timer to N after a step, `＠ｓN` sets delay and timer.
4. List modes (flag 4, `listMode` 1–7): re-lay out the visible rows (numbers via `winPrintNumber`,
   item icons via `winPrintIcon`).
5. `g_winStateDrawFuncs[drawStyle](win)` (0x088F4040, 14 entries).
6. `winDrawGlyphs`: every glyph's draw callback (text, icon or digit).
7. The face (face key `win+0x6C`, sprite from the face cache): colour (b, b, b, min(faceAlpha, alpha)),
   faceAlpha +8 per frame, anchor 2 (bottom centre), scale (w/160, h/160), at
   (x + w/2 + 8, y + h − 8). Flag 0x20000 (never set) mirrors it at (x + 100, y).
8. Flags 0x80, 0x100, 0x200 and 0x400 are cleared.

Colours use the game's 0..128 = 1.0 convention. `spriteSetColor` keeps ((c·255) >> 11) & 15 for RGB
(so 129..143 wrap to black) and ((a·255) >> 7) >> 4 for alpha. `prim2DSetColor` takes RGB as 0..255
(top nibble) and alpha as 0..128; a negative component keeps the old value. The GE alpha test
discards fragments with alpha ≤ 0x28. Brightness `win+0x6E` multiplies frames, glyphs and faces, never
the fill.

## Draw styles

| Style | Function | Look | Used by |
| ---: | --- | --- | --- |
| 0 | `winStateDraw00` 0x0886A65C | nothing (only `callback(win, 0)`) | stage-select face window (`stageSelectOpenState`, only the face shows); story cmd 5 window (no data uses it) |
| 1 | `winDrawFillOctagon` 0x0886A66C | fill only | story narrator (chamfer 0) |
| 2 | `winStateDraw02` 0x0886A998 | fill, black outline, white outline inset 2 px | nothing (only via `＠ｔ`) |
| 3 | `winStateDraw03` 0x0886B024 | fill + skin 0 frame | nothing |
| 4 | `winStateDraw04` 0x0886B3CC | fill + skin 1 frame (tiled) | nothing |
| 5 | `winStateDraw05` 0x0886B7A4 | 30-px band + skin 2 caps | nothing |
| 6 | `winStateDraw06Bubble` 0x0886B9E8 | white speech bubble with shadow and tail | nothing |
| 7 | `winStateDraw07` 0x0886C6B8 | fill + skin 3 frame (+ dividers with flag 8) | default of `winOpenMessage`, `winOpenMenu`, `winOpenList` (so every script window), camp frames, stage select, battle-mode prompt, hand-select top bar |
| 8 | `winStateDraw08Hexagon` 0x0886CCE4 | radar hexagon with labels "Str Vit Agi Cha Men Int" | nothing (RPG-engine leftover) |
| 9 | `winStateDraw09Bars` 0x0886F12C | a growing row of bars | nothing |
| 10 | `winStateDrawFramed` 0x0886F364 | fill + 9-slice of skin 13 cell (0, 0) (+ tail) | nearly everything: map/deck/spell/ability messages and help, duel names and pop-ups, story speakers, name plates and faces (`winOpenFace`), name entry, camp messages |
| 11 | same | skin 13 cell (64, 0) (+ tail) | nothing |
| 12 | same | skin 13 cell (0, 64), centre filled | nothing |
| 13 | same | skin 13 cell (64, 64) | nothing |

"Nothing" means no code writes that value to `drawStyle` (checked on every function), and no text in
BOOT.BIN contains a `＠ｔ` tag, the only other way to set it (`msgParseNextGlyph`). Tails: `tailIdx`
1 (spell/ability target messages, `g_deckWinMsg`) and 4 (`deckUpdateHelpWin`, `spellPush` help).

Every style starts with x −= w/2 when flag 0x4000 is set and y −= h/2 with flag 0x8000 (integers).
Below, X, Y, W, H are those truncated values, c = (int)chamfer, b = brightness, a = alpha.

### Fill — `winDrawFillOctagon`

Three quads (left strip, middle, right strip) with 45° chamfers of c: (0,c)(c,0)(0,H−c)(c,H),
(c,0)(W−c,0)(c,H)(W−c,H), (W−c,0)(W,c)(W−c,H)(W,H−c). Colour fillR/G/B (default 0x20, 0x20, 0x20:
nibble 2), alpha `(char)(int)(fillA · a/128)` with fillA 0x70, so 221/255 when opaque. A product above
127 turns negative and keeps the previous alpha (no default window reaches it). Dithering is on.
Then `callback(win, 0)` (always the empty `winCallbackDefault`).

### Style 2

Fill, then with the same Prim2D "lines" (see below): black at (X, Y) along (c,0)→(0,c)→(0,H−1−c)→
(c,H−1)→(W−1−c,H−1)→(W−1,H−1−c)→(W−1,c)→(W−1−c,0)→(c,0); white at (X+2, Y+2) along the same path
with H−5 / W−5. Alpha a.

### Style 3 — skin 0 (option.one 20/1, 128×128)

Colour (b, b, b, a). Corners 39×39: (0,0)–(39,39) at (X, Y), (41,0)–(80,39) at (X+W−39, Y),
(0,41)–(39,80) at (X, Y+H−39), (41,41)–(80,80) at (X+W−39, Y+H−39). Edges: (39,0)–(40,7) scaled
(W−78, 1) at (X+39, Y) and (39,74)–(40,80) at (X+39, Y+H−6); (0,39)–(7,40) scaled (1, H−78) at
(X, Y+39) and (74,39)–(80,40) at (X+W−6, Y+39).

### Style 4 — skin 1 (etc.one 1/2, 128×128)

`menuWinSysInit` gives skin 1 blend 1, but this function sets it to 0 whenever it rebinds the skin,
so it draws with the normal blend. Colour (b, b, b, a), scale 1, corners 32×32 from the image corners.
Top/bottom edges: from X+32, 64-px pieces (32,0)–(96,32) / (32,96)–(96,128); the last piece
(rem ≤ 64 px) uses (96−rem, …)–(96, …). Left/right edges the same way down from Y+32.

### Style 5 — skin 2 (option.one 20/3, 128×64)

The fill is drawn with h = 30 and chamfer 0 (restored afterwards). Colour (b, b, b, a):
(0,0)–(48,48) at (X−38, Y−5), (48,0)–(96,48) at (X+W−10, Y−5), and the column (48,0)–(49,48)
scaled (W−20, 1) at (X+10, Y−5).

### Style 6 — speech bubble

Body = the three fill quads, tail = a triangle toward (pointX, pointY), absolute coordinates:

- point above the window (py < Y): side 1, base on the top edge; below (py > Y+H): side 2; else left
  (px < X): side 3; right (px > X+W): side 4; inside: no tail.
- Top/bottom: base x s6 = clamp(px + 30, X + c, X + W − c − 40), base from (s6, edge) to
  (s6 + 40, edge). Left/right: s7 = clamp(py + 30, Y + c, Y + H − c − 40), base 40 px down.
- Drawn: shadow of body and tail in black with alpha max(0, a − 0x40) at +8, +10; tail and body in
  (0xF0, 0xF0, 0xF0, a); `callback`; outline in black alpha a (Prim2D "lines", the edge with the tail
  split around the base, plus the two tail sides); the next arrow (flag 2).

### Style 7 — skin 3 (etc.one 1/4, 32×32)

Fill; the menu cursor (flag 4) or the next arrow (flag 2); colour (b, b, b, a): corners 8×8
(0,0), (0,11), (11,0), (11,11); edges (8,0)–(9,8) / (8,11)–(9,19) scaled W−16, (0,8)–(8,9) /
(11,8)–(19,9) scaled H−16.

**Flag 8 = dividers** (this answers open question 3.9). pointX / pointY are relative here:
- 0 < px < W: caps (21,0)–(31,8) at (X+px−5, Y) and (21,12)–(31,20) at (X+px−5, Y+H−8), line
  (23,8)–(29,9) scaled (1, H−16) at (X+px−3, Y+8);
- 0 < py < H: caps (0,21)–(8,31) at (X, Y+py−5) and (12,21)–(20,31) at (X+W−8, Y+py−5), line
  (8,23)–(9,29) scaled (W−16, 1) at (X+8, Y+py−3);
- both: the crossing (21,21)–(31,31) at (X+px−5, Y+py−5).

### Style 8 — radar hexagon

Centre (X, Y); unit u = chamfer (a float). Axes clockwise from the top at 0°, ±60°, … (the code uses
0.866026 and 0.866025). Six values and six deltas live in unrelated Window fields: values col,
lineInPage, originX, originY, maxCol, linesPerPage; deltas cursorOffX, cursorOffY, scrollTop,
visibleRows, itemCount, cursorRow. **Each draw first moves all twelve one step toward 0** and uses the
new values, so a caller has to re-set them every frame (no caller exists).
1. spokes to 50u ("lines" from the centre, which draw nothing), white alpha a;
2. rings at 10u, 20u, 30u, 40u in white alpha a − 0x40 ("lines": each segment becomes a fan triangle
   to the centre, so the rings render as four stacked translucent hexagons);
3. value triangles: centre (0,0,0,0), value points (0, 0x80, 0xFF, a), Gouraud-shaded;
4. delta bands between value and value + delta in (0xFF, 0x40, 0, a);
5. labels from skin 11 (option.one 20/12, blend 1) at 60u, (128,128,128,a): "Str" (0,0)–(32,16) top,
   "Vit" (32,0)–(64,16) upper right, "Agi" (32,16)–(64,48) lower right, "Cha" (64,16)–(104,32) bottom
   (y −12 instead of −8), "Men" (64,0)–(104,16) lower left, "Int" (0,16)–(32,32) upper left, each at
   (X − 16 + trunc(60u·dx), Y − 8 + trunc(60u·dy)).

### Style 9 — bars

No fill. `cursorRow` quads of w×h at (i·(w + cursorW) + x, y) in the cursor colour, alpha
cursorA·a/128. After drawing, when `cursorFlash` is 0 the count grows by one (up to `scrollTop`) and
`cursorFlash` is reset to `visibleRows`; otherwise it counts down.

### Styles 10–13 — `winStateDrawFramed`

Fill; menu cursor (flag 4) or next arrow (flag 2); **the next arrow a second time** when flag 2 is set
(the flag is tested twice). Then a 9-slice from skin 13 (etc.one 1/14, 128×128) at cell (u0, v0) =
10 (0,0), 11 (64,0), 12 (0,64), 13 (64,64): corners 20×16 at (0,0), (44,0), (0,48), (44,48); edges
column u0+20 scaled W−40 and row v0+16 scaled H−32; style 12 also stretches the centre texel
(20,16) over (W−40)×(H−32). Styles 10/11 with `tailIdx` ≠ 0 draw skin 14 (etc.one 1/15) rect
`g_winTailRects[tailIdx]` (0x088F3F78, 11 × {u0,v0,u1,v1}) at (X+20, Y+H−rectH). In the USA data
etc.one 1/15 is **fully transparent**, so tails 1 and 4 show nothing (**data**, checked
2026-09-27: a 112-byte 128×128 4 bpp GBP whose pixel data is one fill run of index 0 over all 16384
pixels; palette entry 0 has alpha 0, the other 15 entries are opaque greys that no pixel uses, so the
maximum alpha is 0 and nothing reaches the GE alpha test 0x28).

## Prim2D and the "line" quirk

`prim2DDraw` (0x08881E00) always submits a 4-vertex `GU_TRIANGLE_STRIP` (prim 4, count 4), whatever
`prim2DInit`'s kind says (0 point, 1 line, 2 triangle, 3/4 quad). `prim2DInit` zeroes all four
corners but not the colours, and `prim2DSetColor` only colours the first `vertexCount` vertices. So:

- a "line" (kind 1) is drawn as the triangle (v0, v1, (0,0)) plus a degenerate one, with v2's colour
  left over from the last full use of the same Prim2D (for the bubble outline: the body's white; for
  the hexagon rings: the previous frame's orange). Lines through the origin (the hexagon spokes, the
  style-2 left edge) vanish; the others become fans that shade the window from its top-left corner;
- a triangle (kind 2) draws its area twice, the second time with v3's leftover colour at the origin.

Shading is smooth (`sceGuShadeModel(1)`), blending SRC_ALPHA / ONE_MINUS_SRC_ALPHA, the alpha test
cuts faded edges at 0x28. The viewer keeps the four Prim2D objects (0x08B3E210, 280, 2F0, 360) between
draws like the game and reproduces this; its "lines: as intended" option draws 1-px lines instead.
Only the unused styles 2, 6 and 8 are affected. **Not checked on hardware.**

## Menu cursor — `winDrawMenuCursor` (0x0886965C)

Drawn by styles 7 and 10–13 when flag 4 is set. Cursor colours from `winSetColor` (table 0x08B3E1FC):
0 = (0x10, 0x80, 0xF0, 0x40), 1 = (0x10, 0x80, 0x80, 0x40), 2 = (0x80, 0x80, 0x80, 0).

- Flash: flag 0x400 (cursor moved) sets `cursorFlash` = 8, else −1 per frame down to 0.
- Bar: W' = cursorW (−16 with a scroll bar), H' = lineH + 1; inner rectangle x01 = (W' − flash)/8,
  y00 = (H' − flash)/3, x = W' − x01, y2 = H' − y00. Five Gouraud quads at
  (x + cursorOffX − 1, y + cursorOffY + cursorRow·lineH − 1) (window x, not centred): top, bottom, left
  and right bands fade from the cursor colour (alpha cursorA·a/128) on the inner edge to
  (0x80, 0x80, 0x80, 0) outside; the centre is solid. winOpenMenu/List: offsets (10, 8), cursorW w−20.
- Flag 0x20: pointer, skin 4 (option.one 20/5) (0,0)–(32,32), (128,128,128,a), at
  (cursorW + x + cursorOffX − 8, lineH/2 − 30 + y + cursorOffY + row·lineH).
- Flag 0x10: scroll bar at x + w − 24 (−10 more for style ≥ 10): up arrow skin 5 (option.one 20/6)
  (16,0)–(32,16) when scrollTop = 0 else (0,0)–(16,16), scale (1, −1) at y + 23; down arrow the same
  test against itemCount − visibleRows at y + 24 + track, track = h − 49; the track is a (16, track+1)
  quad in (0x10,0x10,0x10,a) at y + 24; the thumb a (12, track·visibleRows/itemCount + 1) quad in
  (0xD0,0xD0,0xD0,a) at (x + w − 22 [−32 for style ≥ 10], y + 24 + trunc(track/itemCount·scrollTop)).

## Next arrow — `winDrawNextArrow` (0x08869358)

Only when flag 0x80 (polled by `winUpdateInput`), the voice is idle and the text is complete or at a
page break. Skin 6 (option.one 20/7): frame f = `uiAnimCounter(4)` (6 frames of 4 vblanks),
(24f, 0)–(24f+24, 32), colour (128,128,128,a), top-left at (x + w − 32 [−10 for style ≥ 7] + dx,
y + h − 40); dx = −100 with flag 0x40000 and a face; centred windows use x − w/2.

## Text — `msgParseNextGlyph` (0x08871570)

One call = one typewriter step. Single bytes: 0 ends; space advances `advance` (a step); `-`, `+`,
`.`, digits and letters are one glyph; `\n` is a new line (a step). Any other byte takes two bytes as
one code (so ASCII punctuation swallows the next byte); 0x8140 advances advance/2 (a step).
`＠` + full-width letter (+ full-width digits, each 0x824A–0x8259 read as c − 0x824F):

| Tag | Digits | Effect | Ends the step |
| --- | ---: | --- | --- |
| ＠ｎ | – | new line (flag 0x2000 grows h) | no |
| ＠ｂN | 2 | icon, skin 7 (option.one 20/8): 0–6 ✕ △ □ ○ ◎ ○ ✕, 7 L, 8 SELECT, 9 R, 10 blank, 11 START, 12 SEL | yes |
| ＠ｍN | 2 | icon, skin 10 (etc.one 1/11): the 13 attribute/category icons (`g_attrIconRects`), drawn at scale 0.5625 | yes |
| ＠ｅN | 2 | icon, skin 9 (option.one 20/10): 49 RPG item icons (no text uses it) | yes |
| ＠ｐN | 2 | icon, skin 8 (option.one 20/9): 28 icons animated over 4 frames 18 px apart, 8 draws per frame (lastFrame 3, delay 8) | yes |
| ＠ｃN | 2 | text colour (font palette `g_fontPaletteColors`) | no |
| ＠ａN | 3 | glyph fade step | no |
| ＠ｓN | 2 | typing delay (and timer) | no |
| ＠ｔN | 2 | **drawStyle** | no |
| ＠ｗN | 3 | wait N frames | yes |
| ＠ｖN | 4 | voice (waits for the file queue and an idle voice; skipped with flag 0x100000) | yes |
| ＠ｆN | 3 | face key (faceAlpha restarts) | yes |
| ＠ｇN | 3 | game variable as digits, one per step (the RPG block: always 0) | per digit |
| ＠ｄN, ＠ｈN, ＠ｋ | 3 / 3 / – | item / character names from the unused RPG block (empty) | no |
| ＠－ | – | the rest at once via `msgParseNextGlyphRaw` (name-entry keyboard) | – |
| other | – | only the ＠ is skipped | – |

Tags used in BOOT.BIN texts (**data**): ＠ｂ 0, 1, 2, 3, 7, 9, 11 (help and prompt lines like
"＠ｂ０Accept ＠ｂ３Cancel", the name-entry help), ＠ｍ 0–12 (a table of 13 single-icon strings), ＠ｐ 11–14 (card-screen / deck-editor tab help), ＠ｃ 0/1, ＠ｖ, ＠ｎ, one ＠ｗ without digits. No ＠ｔ,
＠ｅ or ＠ａ.

### Glyphs

`winEmitGlyph`, `winEmitIcon` and `winEmitDigitGlyph` take a record from `g_winGlyphPool` (600, record
0 unused) and append it to the window's chain. Every glyph fades in: alpha starts at 0 and gains
`glyphFadeStep` (default 4; 0x7F for re-laid-out list rows) per draw, clamped to the window alpha.
Text origin per style: `g_winTextOffsetByState` (0x088F3FD0) = 0 (0,0), 1 (10,10), 2 (10,10),
3 (20,20), 4 (30,30), 5 (4,4), 6 (10,10), 7 (10,10), 8 (0,0), 9 (0,0), 10–13 (15,15). A window with a
face and without flag 0x40000 shifts text and icons 100 px right.

- **Text** (`winGlyphDraw` 0x08873690): fullfont glyph (palette = text colour), scale
  (glyphW/18·0.8, lineH/18), colour (b, b, b, alpha), drawn by `spriteDrawFontGlyph` at
  p = (trunc(sx + left + x + off.x), trunc(sy + top + y + off.y)) with left/top as floats. The 256
  glyph sprites of the fullfont atlas get `spriteSetAnchor(0x10)` in `fullfontLoad`; the anchor only
  moves the pivot (the scale centre) to (8, 8) and keeps the quad in place (`spriteSetPivot`), and the
  offset is 0, so vertex = p + 8 + trunc(s·(corner − 8)): **the 16×16 cell has its top-left at p and is
  scaled about its centre p + 8**. So p is the top-left of the glyph cell, like an icon's top-left, and
  text and ＠ｂ icons share one baseline ("✕ Confirm"). (Until 2026-09-27 the viewer centred the glyph
  on p, i.e. 8 px too far left and up; the user's real-console screenshots of the name entry, the title
  and a story scene confirmed the corrected rule, which closed open question 3.12.)
- **Icon** (`winIconGlyphDraw` 0x088739E8): rect from `g_winIconRectTables` (0x088F472C, pointers per
  skin: 7 → 0x088F40D8 (13), 8 → 0x088F41A8 (28), 9 → 0x088F4368 (49), 10 → 0x088F4678 (13); records
  of four corners, TL and BR used), shifted down 18 px per animation frame. Position y − 1 at emit;
  top-left at (trunc(1.2 + L + x + off.x), trunc(1.2 + T + y + off.y)) with L, T integers; scale 1
  (skin 10: 0.5625). Advance = rect width + 3 (not the glyph advance).
- **Digit** (`winDigitGlyphDraw` 0x08873FA8, `winPrintNumber` 0x08873460): record code 0xC = skin 12
  (option.one 20/13, 256×64, blend 1 = additive), rect `g_winDigitUVs[style][digit]` (0x088F4758,
  4 × 15 × 4 shorts, read as u0, v0, u1, v1), top-left at (trunc(L + x + off.x − 4), trunc(T + y +
  off.y)); with a face (and no flag 0x40000) +104 / +4. Only style 3 holds valid rects (10×20 cells at
  (10d, 0): 0–9, 10 '/', 11 '+', 12 '−', 13 blank); styles 0–2 are stored as {w, h, u, v}, which the
  code reads as degenerate rects (**data**; unused: the only caller, the list modes of
  `menuWinUpdateAll`, prints style 3). `winPrintNumber` prints right to left from x − 12, 12 px apart,
  at most maxDigits, then the sign glyph (11 '+', 12 '−', 13 for zero) when asked. Colour = brightness
  + `g_winTintOffsets[attr]` (0x088F4938: 0 none, 1–3 ±(10, −100), 4–6 ±(10, −60)); a channel above
  0x100 zeroes **red** (a copy-paste slip), and 129..143 wraps in `spriteSetColor`. Callers pass attr 0.

## Skins — `menuWinSysInit` (0x08867B1C)

`g_winSkinSprites[i]` = member i+1 of etc.one entry 1 for i ∈ {1, 3, 10, 13, 14}, else of option.one
entry 20. Blend 1 (ONE_MINUS_DST_ALPHA, additive on the RGB565 frame buffer) for skins 1, 11, 12.

| Skin | Member | Size | Content |
| ---: | --- | --- | --- |
| 0 | option 20/1 | 128×128 | gold frame (style 3) |
| 1 | etc 1/2 | 128×128 | ornate blue frame (style 4) |
| 2 | option 20/3 | 128×64 | gold band caps (style 5) |
| 3 | etc 1/4 | 32×32 | thin grey frame and dividers (style 7) |
| 4 | option 20/5 | 128×64 | quill pointer (menu flag 0x20) |
| 5 | option 20/6 | 128×64 | two jewel buttons (scroll-bar arrows) |
| 6 | option 20/7 | 192×32 | next arrow, 6 frames |
| 7 | option 20/8 | 128×128 | PSP buttons (＠ｂ) |
| 8 | option 20/9 | 512×72 | animated icons (＠ｐ) |
| 9 | option 20/10 | 128×128 | RPG item icons (＠ｅ) |
| 10 | etc 1/11 | 224×64 | attribute icons (＠ｍ, card screen) |
| 11 | option 20/12 | 128×48 | "Str Vit Men Int Agi Cha" (style 8) |
| 12 | option 20/13 | 256×64 | digits "0123456789/+−" |
| 13 | etc 1/14 | 128×128 | four frame cells (styles 10–13) |
| 14 | etc 1/15 | 128×128 | tails (empty in the USA data) |

## In the viewer

- `WindowPainter` draws all 14 styles, the menu cursor, scroll bar, pointer, dividers, next arrow,
  text with every tag above, icons (animated) and digit glyphs. The tables (text offsets, tail rects,
  icon rects, digit rects, tints, font palettes) are read from BOOT.BIN (`readWinTables`).
- Duel and story windows use it (styles 10 and 1, exactly the styles the game sets for them); no story
  script can request another style (`msgEventOpenWindows` hard-codes them, and no text has `＠ｔ`).
- Card database → **Windows** is a gallery with presets taken from the game's own windows and
  controls for style, rect, chamfer, point (click the canvas), tail, face, brightness, alpha, text
  colour, typewriter, flags, menu cursor, numbers, hexagon values and bars.
- The painter uses GE z 0x7FFF (depth 0) for everything; story backgrounds and CGs use the same z
  (`msgEventDrawBg` / `msgEventDrawCg` draw at z 0), which matters on the map board, where the GEQUAL
  depth test is on when the event is drawn ([story.md §3.1](story.md#31-draw-order-per-frame-msgeventdraw-code)).
- **Approximations**: the GE's dithering is not emulated; bilinear filtering and blending come from
  WebGL; `＠－` is laid out with the normal parser; paging (`linesPerPage`) is not applied; list modes
  1–7 are not reproduced (the gallery's menu uses plain lines); styles 8 and 9 compute their per-frame
  count-down from the frame number instead of mutating the window; the Prim2D quirk (above) follows the
  code but has not been compared with a real screen.
