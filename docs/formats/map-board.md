# The map board as the game draws it

How `mapBoardScene` (scene 0x50, 0x0884CDD4) draws the board: camera, background and scenery, square
tiles, marks, units, cell decorations, seize walls, cursor, status HUD and hover panel, and the parts of
its state machine: the command ring, movement (move lines, move preview, walking animation, seizing),
the hand panel, the map windows, and the flows between commands (turn start, attack, skills, map
spells, discard, the CPU). All of it is
**code** (read from the functions named below) unless marked otherwise. The rules behind the board
(cells, units, flags) are in [rules.md](rules.md); the archive entries in
[database.md](database.md#mapone). The viewer draws it under Card database → Maps → **Game view**
(`src/effect/mapBoard.ts`, `src/components/MapBoardView.tsx`).

## Frame order

Each frame of `mapBoardScene`, when the board is active and `g_mapDrawFlags` = 0x1F (free cursor):

1. `mapDrawTerrain` (flag 1, 0x088514C4): background pieces, scenery (`mapDrawDecorations`), square
   tints, attribute frames, square frames, the pulsing frame overlay, move preview, range marks, cursor.
2. `mapDrawAllUnits` (flag 2, 0x08831DB4): per square in row order (y outer, x inner): seize walls
   (`mapDrawSeizeFx`), the unit (`mapDrawUnit`), the lifted unit, the cell decoration
   (`mapDrawCellDecoration`).
3. The state machine (cursor update, menus, AI …).
4. `mapSetupCameraMatrix` (0x08852338) updates `g_mapCamera`. Steps 1–2 therefore use **last
   frame's** camera, and the cursor draws one frame behind while it moves.
5. `mapDrawCursorMarker` (flag 4), `mapDrawStatusHud` (flag 8), `mapDrawUnitHoverPanel` (flag 0x10,
   when the cursor is exactly on a unit).
6. `gfxClearDepth`, then `handPanelDraw` of `g_mapHandPlayer` when the turn player's `bPanelVisible` is
   set, and of the other player when its own flag is set; `mapCmdMenuDrawRing` when `DAT_08A1BDE4` is set
   (state 0x1E); `menuWinUpdateAll` (every window, [windows.md](windows.md); `msgEventDraw` instead while
   a story event is active), `cardInfoDrawUnit` (the card screen, when open), `(*g_effectState)()` and
   `scrObjRenderAll(0)`, `scrObjRenderAll(6)` ([Map effects](#map-effects--effectstart--effectisbusy)).
   While `duelResultScreenDraw` is active it replaces steps 4–6 ([Result screen](#result-screen--duelresultscreenupdate-0x08833094--duelresultscreendraw)).

## Camera

`mapInitCameras` (0x08852B74) copies `g_camDefault2DSorted` into `g_mapCamera` (0x08A1BE80): render
mode 1, focal 32768, centre (320, 224). Every frame `mapSetupCameraMatrix(g_mapCamera, cursorX,
cursorY, 0)` sets:

| | Value |
| --- | --- |
| eye | (cursorX − 0x8926, cursorY − 0xEDA5, −0x8000) = (cursorX − 35110, cursorY − 60837, −32768) |
| rotation | X = −65°, Y = 0, Z = −30° (`(deg · 3.1415927) / 180`); the `param_4 ≠ 0` branch (−65°, 0, −29°) is never used |
| zoom | `camSetZoom(z, z)` with z = 1 + k/100; k (byte 0x088DD257, initial 100) steps by 5 per frame toward 100, toward 160 while `DAT_08A1BDA0` > 0, toward 50 while it is < 0 |

- `DAT_08A1BDA0` is set to 1 in state 0x1E (command menu) when the cursor square holds a unit, and
  reset to 0 only by the free cursor (0x14), the action end (0x238C) and the result screens; it is
  never negative. So the zoom is 2.0, easing to **2.6** once the menu opens on a unit, and it **stays**
  at 2.6 while the unit picks its move and walks (the move states do not reset it). After a move the
  unit is off the grid, so the menu that follows does not set it again (but it is still 1). There is
  **no rotation or free zoom control**: the camera only follows the cursor.
- View (`camBuildViewMatrix` + `sceVfpuCameraMatrix`): M = Rz·Ry·Rx, q = Mᵀ(P − eye). Projection
  (`sceVfpuViewScreenMatrix(f, zx, zy, 2048 + cx − 320, 2048 + cy − 224, …)`): virtual
  x = 320 + f·z·q.x/q.z, y = 224 + f·z·q.y/q.z.
- World: the board lies in the plane z = 0, square (x, y) covers [64x, 64x+64] × [64y, 64y+64]
  (cursor and unit positions are square × 64; `>> 6` gives the square). World +y is screen-down on the
  board and −z points toward the camera's screen-down, so things that **stand** on the board extend
  toward **+z**.
- Derived: the view axis meets the board at cursor + (25.6, 19.6), 77 536 units away, so a world unit
  is 0.845 virtual px at zoom 2 (a square ≈ 54 × 0.75 ≈ 41 screen px wide) and 1.10 at zoom 2.6. The
  perspective is almost orthographic.

## Sprites, projection and depth

- **Geometry** (`spriteUpdateVertices` 0x08880E60): vertex = pivot + offset + trunc(R·S·corner'),
  where corner' = corner − pivot. `sceVfpuMatrix4Rot` applies Z, then Y, then X (R = Rx·Ry·Rz). With
  this order the "billboard" rotation (−65°, 30°, −12°) (`-1.134464, 0.5235988, -0.20943952`) is within
  4° of the camera's own basis (Mᵀ·R ≈ I), so billboards face the camera.
- `spriteSetSrcRect` resets the pivot to (0, 0) and rebuilds the corners from the current offset; it
  returns early when the rect is unchanged. `spriteSetAnchor` moves only the pivot, so an anchor set
  **before** a new src rect is lost.
- **Projection** (`spriteDraw2D` 0x0887F6AC, `spriteDrawBoundTex` 0x088800B8): world = vertex + (x, y, 0)
  (the draw call's z is a depth, not a position), homogeneous transform with the view-projection matrix
  and divide, `vf2in` to an integer GE coordinate, then x − 1728, y − 1824 and x·480/640, y·272/448
  truncated toward zero. `spriteDraw2DRounded` (0x0887FA04) keeps floats: ·0.75, ·0.60714287, +0.5,
  truncated. The quad goes out as a through-mode triangle strip, so textures are mapped **affinely** on
  screen. `spriteDrawBoundTex` skips a quad whose four corners are all off one screen edge.
- **Depth**: mode 1 sends GE z = 0x7FFF − depth; every board draw passes depth 0x7FFF → z = 0, the HUD
  passes 0 → z = 0x7FFF, text (2D-front font atlas) 0xFFFF. With the depth test GEQUAL and the buffer
  cleared to 0, everything passes: the board is **pure painter's order**.
- Colour: `spriteSetColor` RGBA4444 (see [effects.md](effects.md)); blend bit 0 = additive
  (SRC_ALPHA, ONE_MINUS_DST_ALPHA with no destination alpha).

## Background and scenery

**Background** (loaded by `mapInitCameras`): map.one entry `area·1000 + variant·100 + i`,
`i < g_mapBgCounts[area·2]` (0x088E5E26: 2 pieces for areas 1–7, 3 for 8–10). In state 1 of the
scene each loaded piece gets `g_mapCamera`, the billboard rotation and scale
`g_mapDecoScale · 2 · 1.5` = 3.18 (`g_mapDecoScale` 0x088DCF50 = 1.06).

`mapDrawTerrain` draws piece i with `spriteSetPivot(−off, 0)` at (off − 0x420 + bx, by − 0x132) with
`spriteDraw2DRounded`, off = i·step. The pivot makes all pieces turn and scale around the same point
(bx − 0x420, by − 0x132), so they form one picture standing in the scene, facing the camera.

| Area | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| (bx, by) variant 0 (`g_mapBgPosVariant0` 0x088DD258) | 0, 0 | −52, 146 | 176, 20 | −152, 186 | 228, 140 | 38, 155 | −6, 48 | 267, −87 | −419, −148 | 43, −85 |
| variant 1 (`g_mapBgPosVariant1` 0x088DD280) | same | | | | | | | | | −35, 24 |
| step | 0x168 | 0x160 | 0x160 | 0x160 | 0x160 | 0x160 | 0x160 | 0x140 | 0x110 | 0x110 |
| piece width (data) | 368 | 368 | 368 | 368 | 368 | 368 | 368 | 336 | 288 | 288 |

The pieces overlap by 8–16 texels. Pieces are hidden by the cursor square (culling): area 10 piece 2
while cursorX < 10; area 9 piece 2 while cursorX < 8 and cursorY > 5; area 8 piece 0 while
cursorX ≥ 21 and piece 2 while cursorX < 21.

**Scenery** (`mapDrawDecorations(−1, −1)` 0x088526F8): `g_mapDecoLayouts` (0x088DFB28), 18 layouts ×
8 records × 0xB0, indexed by `g_mapLayoutId − 1` (= the stage number, `dbGetMapLayoutId`). The list is
walked from the first record of the current area while records match and +4 < 0.

| Off | Field |
| --- | --- |
| +0 | area (0 ends the list) |
| +1 | animation slot (frame counter `0x08A1BE60[slot]`, frame `0x08A1BE50[slot]`) |
| +2 | frame count |
| +4 | −1 (a value ≥ 0 would stop the list; none in the data) |
| +C, +10 | x, y in the picture plane |
| +14, +18 | scale x, y (× `g_mapDecoScale`) |
| +1C | blend |
| +1D | delay: the frame advances when the counter exceeds delay (+ `DAT_08A1BDC0`, always 0), i.e. every delay + 1 frames |
| +1E + f | sprite index of frame f (into the area's decoration sprites) |
| +2E + 8f | u, v, w, h of frame f |

Each record is drawn with the billboard rotation, `spriteSetPivot(−x, −y)` and `spriteDraw2DRounded`
at (x + bx − 0x400, y + by − 0x140). The decoration sprites are map.one entry 1, member
`area·100 + k + 1`, `k < g_mapDecoSpriteCounts[area]` (0x088E5E3B: 3 for area 1, 4 for area 2, 0 for
the rest). Data: layouts 1 and 14 (Underground shrine) have 5 records (two animated pieces, scale 3, and
three flickering lights, additive, 5 visible frames of 16); layout 2 (Forest of Dryad) has 3 (scale 2,
3–4 frames every 13 frames). No other area has scenery.

## Squares — `mapDrawTerrain`

All passes use `Sprite_08A1E6D8` = etc.one 100/1 (256×256) with `g_mapCamera`, position 0, anchor
centre, drawn with `spriteDrawBoundTex` at (64x, 64y) for squares with land ≥ 0, except pass 5 and the
0x10 / 0x80 marks, which do not test the land (verified against the code 2026-09-27):

| Pass | Rect (u0, v0, u1, v1) | Colour | For |
| --- | --- | --- | --- |
| 1 tint | 0x80, 0xC0, 0xC0, 0x100 (white square) | (0x80, 0x80, 0x80, 0x40); when `g_mapCellFlags` & 0xFF00 (owned / pending): (0x40, 0x40, 0x40, 0x60), and the first set bit of 0x100, 0x200, 0x400, 0x800, 0x1000, 0x2000, 0x4000 raises blue, red, green, nothing (team 3 stays grey), blue, red, green to 0x80 (0x8000 is not tested) | every square; the cursor square with a unit is drawn again additively with alpha min(pulse, 0x80) |
| 2 attribute | ((land−1)·64, 0, land·64, 64) | white | every land > 0 (1–4: earth, water, fire, air frames) |
| 3 frame | 0xC0, 0xC0, 0x100, 0x100 | white | every square |
| 4 glow | same | additive, alpha pulse/2 | every square |
| 5 move preview | 0x80, 0xC0, 0xC0, 0x100 | additive, alpha pulse/2 | `g_mapMovePreview` ≠ 0 and `g_mapDrawFlags` 0x40, any land (see [Movement](#movement)) |
| 6 marks | see below | white | `g_mapRangeGrid` |

The pulse (`DAT_089B5A24`) runs 0 → 0x88 → 0 in steps of 2 while the cursor is free
(`DAT_08A1BD9C`, set by `mapCursorUpdate`), else it is 0.

**Marks** (`g_mapRangeGrid`, [rules.md](rules.md#map-state-block)):

| Value | Rect | Notes |
| --- | --- | --- |
| 0x10 (move start) | circle 0x40, 0x40, 0x80, 0x80 | the whole 0x10–0x1F class is drawn only on an empty square (cell word 0), any land |
| 0x11–0x14 (move line) | triangle 0, 0x40, 0x40, 0x80, anchor centre, Z rotation −90°, 90°, 0, 180° | also only on an empty square |
| 0x20 (attack range) | purple 0x40, 0x80, 0x80, 0xC4 when empty or own team (cell bits 24–27 = turn player + 1), red 0, 0x80, 0x40, 0xC4 otherwise | the cursor square pulses (additive, pulse/2) when occupied and the cell word's **low nibble** ≠ turn player + 1; that nibble is part of the card id, not the team, so own units usually pulse too (**code**, quirk) |
| 0x40 (base aura) | gold coin 0, 0xC4, 0x40, 0x100 | |
| 0x80 (summon square) | gold coin | any other value with bit 7; any land; the cursor square pulses |
| 1 (forbidden start square) | red 0, 0x80, 0x40, 0xC0 | |

`mapMarkAttackRange` and `mapFillDiamond` mark the diamond |dx| + |dy| ≤ r including the centre
(r = card range; 0x40 for bases).

**Cursor**: etc.one 100/2 (64×64 bracket), anchor centre, at (cursorX, cursorY).

## Units — `mapDrawUnit` (0x0883156C)

Tokens are card.one 10010 / card id (`cardInitSprites`, `cardGetTokenSprite` 0x08830F04; Dominators
1012–1021 use 1002–1011). Unit and Dominator tokens hold two views side by side: the left half for
facings 0/1, the right half for 2/3. s = scalePct/100.

`mapDrawAllUnits` walks the squares (y outer, x inner). For a square with a grid word it animates the
unit's scale (state 1: +10 per frame up to 100, the summon pop-in; state 4: −10, then state 6 = gone)
and calls `mapDrawUnit` with **facing 0** (0x20 for an enemy on an attack-range square, which the unit
code masks away). Then, if the **lifted unit** `g_mapActiveUnit` has state > 0 and its position lies in
this square, it is drawn again with **its own facing** (state 2 draws it once). The active unit at rest
is also on the grid, so it is drawn twice in the same place (its shadow is darker); a moving unit is
lifted off the grid (state 0x28 clears its word), so it is drawn only as the lifted unit.

The token goes to the square passed by `mapDrawAllUnits` (so a lifted token snaps to the square its
position is in); the shadow, the cursor highlight, the flag, "E" and the digits use the unit's own
position. The cursor highlight is skipped while the unit walks (state 2).

| Part | Sprite | Placement |
| --- | --- | --- |
| shadow | etc.one 110/6 (32×32) | anchor centre, `spriteResetOffset`, scale s (1.5·s when the half-token is ≥ 64 wide), flat at (posX + 32, posY + 32) |
| token | card.one 10010/id | src = half W/2 × H; anchor 2 (bottom centre); rotation (−90°, 30°, 0) (−150° for odd facings), so it stands up (+z) and turns 30° toward the camera; scale s; colour 0x80 (0x40 when acted, actFlags 8); at (0x22 − W/4 + x, 0x24 − H + y). Bases (id ≥ 3001): full token at (0x10 + x, y); their tint by owner (player 0 (0x60, 0x60, 0x8F), player 1 (0x8F, 0x60, 0x60)) is overwritten by the colour call that follows, so bases show untinted |
| cursor highlight | the token again | additive, alpha min(pulse, 0x80), when the cursor is exactly on the unit; also sets the hover unit `DAT_08A1BD8E` |
| Dominator flag | etc.one 110/5 | slot 0 only: 32×32 frame `uiAnimCounter(3)` (8 frames × 8 vblanks, counting down), row 0 player 0 / row 32 player 1, anchor 2, billboard, scale s, at (posX + ox − 64, posY + oy − 96) |
| "E" (acted) | etc.one 110/7 | same place, when actFlags bit 8 |
| stat digits | etc.one 2/1 cells (d·18, 40, +18, 64) | `DAT_089B5A27` 1 AP, 2 HP, 3 DF (SELECT cycles it in modes 1/2); two digits (tens only if > 0), billboard, pivot (−18i, 0) at (posX + 18i − 64, posY − 96) |

State 2 (moving) draws the walking GAN instead of the token (`mapDrawUnitWalkAnim`, see
[Walking animation](#walking-animation)).

**Cell decorations** (`mapDrawCellDecoration` 0x08852534): `g_mapCellDecoTable` (0x088DD2A8),
`[layout − 1][16]` × 0x24: +0 active, +2 sprite index, +4/+8 square, +C/+10 offset, +14/+18 scale
(× `g_mapDecoScale`), +1C..+22 rect (u0, v0, u1, v1). Walked with a running index in the unit pass, so
the entries must be in draw order. Billboarded, `spriteDraw2DRounded` at (64x + dx, 64y + dy)
(`g_mapDecoOffsetX/Y` 0x08A1BDB8/BC are never written: 0). Only layouts 1 and 14 have entries: eight
pyramids and pedestals of map.one 1/103 at squares (3, 2), (8, 2), (0, 3), (11, 3), (3, 7), (8, 7),
(0, 8), (11, 8), scale 2.

**Seize walls** (`mapDrawSeizeFx` 0x088596CC): per square, marker +0x24540 = 1 grows
`g_mapSeizeFxAnim` by 2 per frame; at ≥ 0x28 the marker becomes 2 and it shrinks back to 0 (a ~40-frame
rise and fall). Height = min(anim, 0x20) rows of etc.one 100/3, additive, blue for `g_mapHandPlayer`
0, red for 1. The anchor is set before `spriteSetSrcRect(0, 0, 64, h)`, so the pivot is the top-left
corner: rotation (0, 90°, 90°) gives a wall along the left edge (drawn 4 times) and at x + 64 (twice),
rotation (90°, 0, 0) the top edge and y + 64 (twice each). The repeated additive draws brighten them.

## Cursor

`mapCursorUpdate` (0x0882EB0C): the D-pad moves the cursor 8 world units per frame (10 while Circle is
held), one square at a time; a move stops at the board edge or before a square with land −1. The
camera follows every step. Triangle on a unit opens the card info screen (see
[card-screen.md](card-screen.md)).

**Cursor hand** (`mapDrawCursorMarker` 0x0882F180): etc.one 2/2 frame 0 (48×32 pointer), anchor 2,
rotation (−90°, 30°, 90°), at (cursorX − 0x70, cursorY − 0xC0, 0) with the current camera.

## Status HUD — `mapDrawStatusHud` (0x08859A60)

etc.one 110/3 at (0x178, 6), scale 1.33333 (2D camera). Per player (y = 0x0C, then 0x46):

- turn player: Prim2D 0xF0 × 0x0D at (0x180, y + 2), left vertices (0x10, 0x10, 0xF0) blue / (0xF0,
  0x10, 0x10) red, right vertices grey, alpha 0x60; the Dominator flag (32×26 frame) at (600, y − 6);
- name (`duelGetPlayerName`) at (0x180, y) with `fullfontDraw` at scale 1 (16×16 glyphs, 16 apart);
- "%3d" cost at (0x1B4, y + 0x13), conquest count at (0x1F5, y + 0x13) in palette 0xE, maintenance at
  (0x240, y + 0x13) in palette 0xD; then y + 0x27: "%2d" soul (0x1B4), "%2d" deck (0x208), "%d" hand
  (0x260).

## Hover panel — `mapDrawUnitHoverPanel` (0x0881F81C)

- Prim2D 0xC0 × 0x16 at (0x1B0, 0xB3), team colour (0, 0, 0x80) / (0x80, 0, 0), alpha 0x4F;
- banner etc.one 110/4 rows (0, 0x22)–(0xD8, 0x44) team 0 or (0, 0)–(0xD8, 0x22) team 1 at (0x1A3, 0xA7);
- the card name with `fontDrawTextScaled` size 22 at (0x1BB, 0xB1);
- Prim2D 0xC0 × 0x60 at (0x1B0, 0xC9), (0x10, 0x10, 0x10, 0x60);
- the picture unit.one id/1 (48×50: `cardLoadUnitImage(…, mode 1, size 0)`) at scale (1.6,
  100/h · 0.8) = 1.6 at (0x1BA, 0xCD); the card back (`cardPicDrawScaled`) while it loads;
- "ＡＰ %d", "ＨＰ %d", "ＤＦ %d" (after `unitRecalcStats(unit, 0xF)` for cards < 2000) at
  (0x1BA + 72, 0xCD / 0xE1 / 0xF5), size 22;
- attribute icons (etc.one 1/11, `g_attrIconRects` fields 0, 1, 4, 5) at y 0x11F: the card's attribute
  at x 0x1B0, then one icon per bit of the mask of the attached cards' `CardDef.attribute` (the spell
  categories 5–12), ascending from bit 1, 0x20 apart, up to five; the loop stops after the highest set
  bit and fills the rest with icon 0. Two attachments of the same category show one icon.

## Buttons

The USA build confirms with **Cross** (0x4000) and cancels with **Circle** (0x2000); the help lines agree
("＠ｂ０Accept ＠ｂ３Cancel": icon 0 is ✕, 3 is ○). Circle is also the "faster cursor" button while held
(`mapCursorUpdate` reads it with `padGetHeld`). Square (0x8000) is "Check board" / "Change view",
Triangle (0x1000) the card details, START (8) End turn in the free cursor, SELECT (1) the stat digits.
`mapCursorUpdate` returns 1 only while the cursor is at rest (both step counters 0); every state below
that takes a square acts only then, on a whole square.

## State machine (the parts that draw)

`g_mapBoardState` (0x08A1BD6C). The full list is in the plate comment of `mapBoardScene`; these are the
states whose effects are on screen.

| State | What happens |
| ---: | --- |
| 10 | Turn banner: `g_mapDrawFlags` = 0x1F, range grid cleared, active unit = cursor = the turn player's Dominator; `winOpenMessage(320, 224, …, 24, "%s' s turn ", 0xF000)` (centred, auto size), style 10, w/h + 10. Once the window alpha is > 0x7F a counter runs to 0x41 (64 frames), then `winFadeClose(8)`; closed → 0xB |
| 0xB | `mapTurnStartUpdate`: income, upkeep, draw, and the start-of-turn field effects (`turnReportShow`, below) → 0x10 (human) / 0x13 (CPU) |
| 0x10 | `handSelectUpdate(player, 1)`: 1 → 0xBC2 (return state 0x10), −1 → 0x14 |
| 0x14 | Free cursor. On a whole square: **Cross** clears the range grid and preview; with a preview shown on a square that is not the turn player's, it only hides it. Otherwise: empty square → menu 0x1E with bits 0x1E (versus, `g_gameMode` 0) or 0x3E; a base → its range marks (`mapMarkAttackRange`) and flag 0x40; an own unit (< 2000) not finished (actFlags 8 clear) → menu with Help 8, Move 1 (not moved: actFlags 1 and `g_mapActionFlags` 1 clear) else Standby 0x100, Attack 0x80 (actFlags 4 clear), Skills 0x40 (actFlags 2 clear). The menu opens with the bits **minus Card (2)**. **Circle** toggles flag 0x40: a base shows its range, a unit its move preview (`mapFloodMovePreview(pos, move + 1)`). **START** → End turn (9000, command 4) |
| 0x1E | Command menu (`mapCmdMenuUpdate`, below), `DAT_08A1BDE4` = 1 (ring drawn). Command → 0x28; Circle → 0x14, or after a move: undo the last leg (`mapUndoSeize`, the unit back to the path entry, state 2) → 0x4B0 |
| 0x28 | Dispatch `g_mapCommand`: Move (1) → on the first leg the unit's grid word is cleared, move points = `nEffMove`, `mapFloodMovePreview(pos, points + 1)`; the walk GANs are loaded unless the unit is already in state 2; `mapMarkMoveLines(points)` → 1000. End turn / Standby → 9000; Attack 2000, Skills 4000, To title 5000, Temp save 6000, Help 7000 |
| 1000 | Pick the leg target: unit state = 2 (it walks in place, the walking GAN plays), flag 0x40; window (8, 8) "Please specify the movement target. " size 22, style 10, w/h + 10. Cross on the unit's own square → 0x44C; on an occupied square: error; on a move-line square (mark 0x1x): lines cleared, the unit's square pushed on `g_mapMovePath`, → 0x3F2 (window closed). Circle: no leg yet → the unit goes back on the grid, lines and preview off, GANs freed → 0x14; else undo the last leg → 0x4B0 |
| 0x3F2 | Walk: flag 0x40, `unitStepToward(unit, cursor)`, `mapSeizeCell(unit, team, leg)`. Arrived → points −= squares walked; 0 left or 10 legs → 0x44C, else → 0x28 (new lines from the new square) |
| 0x4B0 | Undo: points += the last leg's squares (nibble stack `g_mapMoveSteps`) → 0x28 |
| 0x44C | Move done: unit state 3 (token again, with its facing), lines cleared, flag 0x40 off, `g_mapActionFlags` 1 → menu 0x1E with Help + Standby 0x108 (+ Attack 0x80, + Skills 0x40 by actFlags) |
| 0xBC2 / 0xC1C / 0xC26 / 0xC30 | Deploy the chosen card: windows (8, 8) "Please select the location to deploy. " (or "You cannot deploy any more units. ") size 22 and below it "Number of allowed deployment: %d " size 20 (16 − placed); `mapMarkSummonCells`. Cross on an allowed empty square → (8, 8) "Is it all right to deploy? " with "＠ｂ０Accept ＠ｂ３Cancel " size 18 below; Cross → `unitSummonUpdate` places it (state 1, scale 0 → grows) → back to 0x10. Spells → 0xC80 |
| 9000 | Action end. Command 4 (End turn): (8, 8) "Ending turn. ＠ｎIs it all right? " size 22 and (8, h + 8) "＠ｂ０Accept ＠ｂ３Cancel " size 20; Circle → 0x14. **Standby** is meant to open "Standing by." the same way, but the code tests `g_mapBoardState == 0x100` inside state 9000, which is never true, so Standby is confirmed at once (**code**, a game bug). Confirmed: the unit back on the grid (`unitSummonUpdate(−1, −1)`), `mapCommitConquest`, GANs freed → 0x238C |
| 0x238C | Action end: actFlags \|= 0xF (Double Action clears it); another own unit (< 2000) without actFlags 8 → 0x14, else End turn (9000, command 4). End turn → discard to five (0x26AC) → `mapTurnEndUpdate` → next player → 10 |

## Command ring — `mapCmdMenuOpen` / `mapCmdMenuUpdate` / `mapCmdMenuDrawRing`

`g_mapCmdMenu` (0x08A1BDC4): +0 item count n, +4 bits, +8 selected, +0xC shown, +0x10 angle (short,
degrees). Labels (`mapCmdMenuUpdate`, pointer table 0x088B86E8) and icons (etc.one 110/1, 64×64 cells,
u table 0x088B870C, v table 0x088B873C), by bit:

| Bit | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Label | Move | Card | End turn | Help | To title | Temp save | Skills | Attack | Standby |
| Icon (u, v) | 0, 0 | 64, 64 | 192, 64 | 192, 0 | 128, 0 | 128, 64 | 0, 64 | 64, 0 | 0, 128 |

- **Open** (0x088321BC): n = bits set; selected = shown = angle = 0. When Standby is offered and Move is
  not (the menu after a move), the ring starts on Attack if offered, else Skills, else Standby: i = the
  number of bits below it, selected = shown = i, angle = −360·i/n.
- **Update** (0x088322EC), with selected = shown: `winApproachPos(96, 176, 8, g_deckWinMenu, 8)` moves the
  label window 1/8 of the way to (96, 176) and adds 8 alpha (max 0x80); if it is not open,
  `winOpenFrame(128, 128, 150, 52, 16, style 10)` with alpha 0 (so it slides in from (128, 128)). The
  label is reprinted every frame at x = 55 − (strlen/2 · 22)/2, size 22. Cross returns the bit, Circle
  −1 (both close the window); **held** Left adds 1 to selected, held Right subtracts 1. While selected ≠
  shown: no label; 20/n steps per frame of one degree each toward the new item (Left turns the angle
  down), until angle mod (360/n) = 0; then selected wraps into 0..n−1 and shown = selected. A turn takes
  18 frames when n divides 20, more otherwise (n = 3: 6 steps a frame, 120° → 20 frames).
- **Draw** (0x088326EC): sprite 0x08A1BF80 through `g_mapHudCam3D` = `g_camDefault3D` (perspective,
  render mode 0) with eye (128, 256, −640) and no rotation (`mapInitCameras`). Item k (bit order) sits at
  j = angle + (360/n)·k wrapped to −180..180: `spriteSetSrcRect(u, v, u + 64, v + 64)`, anchor centre,
  **world rotation** Z = j, own rotation Z = −j (the icon stays upright), `spriteSetPos(−24, 80)`, colour
  alpha 0x80 at j = 0 else 0x60, `spriteDraw(0, 0, |j|·2.5)` (the z adds depth, so icons behind shrink).
  `spriteSetSrcRect` builds the corners from the current offset, which is still (−24, 80) from the
  previous icon, so every icon but the very first draw carries that offset twice (**code**). The ring
  stands in the top-left quarter of the screen with the selected icon at its bottom; the label window
  sits below it.
- With world rotation (`spriteSetWorldRotation`, flag 2) `spriteUpdateVertices` computes pivot + offset +
  R·S·(corner − pivot) in floats, rotates that by the world rotation and truncates.
  `spriteDrawProjected` adds (x, y, z), projects and converts with (X − 2048 + 320)·480/640 truncated.

## Movement

- **Move lines** (`mapMarkMoveLines` 0x08857788): 0x10 on the unit's square; along each direction (0 +x,
  1 −x, 2 +y, 3 −y) mark 0x11 + dir up to `points` squares, stopping before the board edge, a square of
  another team (a base may be crossed with Spy, 21) or a missing square; a Labyrinth Marsh (3004) aura
  stops the line on its first square, and starting inside one limits the points to 1 (unless Annul Base,
  16). Own units do not block a line, but an occupied square cannot be the target. So a unit moves in
  **straight legs**, up to 10 legs, until its points are spent.
- **Move preview** (`mapFloodMovePreview` 0x08857B6C): recursive flood from the unit with `move + 1`,
  writing the remaining count into `g_mapMovePreview` on empty squares only. An enemy square stops the
  flood (a base can be crossed with Spy); a square of another own unit is passed **straight through
  only** (the recursion keeps the direction flag: 1 left, 2 up, 4 right, 8 down), a Marsh aura stops it
  after one more square. Drawn by pass 5 of `mapDrawTerrain` while flag 0x40 is set, additive white with
  alpha pulse/2. The pulse only runs while `mapCursorUpdate` is called (`DAT_08A1BD9C`), so the preview
  and the pulsing glow are **visible while the target is picked and invisible while the unit walks**;
  the lines are cleared before the walk and re-marked from the new square after it.
- **Walk** (`unitStepToward` 0x088301F8): up to four one-unit steps per frame (4 world units, a square
  in 16 frames) along a straight line (−1 if the target is not in line); the facing byte +0x4A becomes 0
  (+y, down), 1 (+x), 2 (−x), 3 (−y, up). Each whole square reached counts one step; on arrival the
  count is pushed on the nibble stack `g_mapMoveSteps` (undo pops it).
- **Seize** (`mapSeizeCell` 0x0885903C) every walk frame: on a whole square that is empty or the team's
  own, whose leg byte (low byte of the conquest word +0x1900) is 0, start the seize walls (marker
  +0x24540 = 1, SE 0x1D) and set the word to pending (0x100 << team) + leg. Not with Wandering Citizen
  (41), Cause for Civil War (player flag 8), or inside an enemy Symbolic Flag (3011) aura without Annul
  Base. The walk step runs before the seize call, so the square the leg starts on is not seized. The tint
  pass shows pending squares in the team colour at once. `mapUndoSeize(leg)` clears the whole range grid
  and resets every word of that leg to its owned bits; `mapCommitConquest` (action end) turns pending
  into owned.

## Walking animation — `mapDrawUnitWalkAnim` (0x08831428)

`mapLoadUnitBoardAnim` loads unit.one `<id>/12` and `/13` into the one shared AnmManager
`g_mapUnitWalkAnm` (0x08A42BE8). Drawn from `mapDrawUnit` only for a unit in state 2:

- animation 0 (/12) for facings 0/1, 1 (/13) for 2/3; `anmSwitch` restarts the GAN when it changes;
- `anmSetOffset(0x20, 0x24, 0)`, the map camera, `anmSetRotation(−π/2, yaw, 0)` with yaw 30° for even
  facings and 210° → −150° for odd ones, `anmDrawAndTick(posX, posY, 0x7FFF)` (the z is a depth);
- `ganDrawFrame`: each part is its own sprite (anchor centre, the part's rotation and scale), position
  (dx − 128, dy − 128), and the GAN rotation as the sprite's **world rotation**; colour (0x80, 0x80, 0x80),
  alpha from the part's blend byte (0x7F, 0x40 for mode 0, 0x20 for mode 3; odd modes additive) × the
  object alpha 0xFF; `spriteDraw2D` at (posX + 0x20, posY + 0x24). One tick per draw, looping.

So the moving unit lies in the board plane like the token and turns 180° for odd facings; /12 serves
down/right, /13 left/up.

## Hand panel — `handSelectUpdate` / `handPanelDraw`

**`handSelectUpdate(player, mode)`** (0x08854AF8; mode 1 on the map). For a human:

- state 0: cursor 0, `handMarkUsableCards`, panel at (x, y) = (−480, 320), hidden; state 1: a newly
  drawn card (deck state 1 without 2) first plays the draw animation (states 10–0x32: the unit.one /3
  picture of the card slides down, `Sprite_08A42C98` at (160, y), a "%s" message); else visible → 0x50;
- 0x50: up to 40 one-pixel steps per frame: y down to 320, then x up to 16 → 100 (slides in from the
  left in 13 frames);
- 100 (select): window `g_deckWinTypeCount` (0, 8) "Please select the card to use. " (or "There are no
  cards that can be selected. ") size 22, style 10, w/h + 10; the help frame `winOpenFrame(0, 0, 180, 0, 8,
  style 10, 0x1000)` under it, reprinted every frame with size 18 lines 19 px apart: "＠ｂ０Accept " (card
  usable), "＠ｂ１Card details " (slot not empty), "＠ｂ２Check board ", "＠ｂ３End ", h = lines·19 + 30
  (flag 0x1000 widens it to the longest line + 20); the name window `winOpenFrame(0, 0, 0, 41, 8, style
  7)` with the card name ("%s", size 20), w = strlen/2 · 21 + 20, y = panel y − 8 − h. Left/Right
  (`padGetRepeat`) move over non-empty slots with wrap-around (only with two or more cards). Cross on a
  usable card → 0x6E (selected slot) → 0x78 → 9000; Triangle → card details (200); Square → check board
  (0x44C, the panel drops to y 400); Circle → 9000;
- 9000: all windows closed; with a card chosen → 0x233C; else "Ending card usage. ＠ｎIs it all right? "
  (320, 224, size 22, centred) and "＠ｂ０Accept ＠ｂ３Cancel " (size 20) under it → 0x2332: Cross → 0x233C,
  Circle → 100;
- 0x233C: x −40 per frame until below −0x27F → 9999: hidden, returns 1 (chosen) or −1.

**`handPanelDraw(player)`** (0x08856A74), with (x, y) = the panel position (+0xBC, +0xC0):

- Prim2D 640 × 140 at (x − 16, y − 8), (0x10, 0x10, 0x40, 0x60) for player 0, (0x40, 0x10, 0x10, 0x60)
  for player 1 (dithering off);
- etc.one 110/2 at scale 1.3333 (2D camera): (0, 0)–(0x62, 0x15) "Cost" at (x, y − 6), (0, 0x15)–(0x62,
  0x2A) "Soul" at x + 0x92, (0, 0x2A)–(0x78, 0x3F) "Keep cost" at x + 0x123, (0, 0x3F)–(0x76, 0xA0)
  "Number of Cards" at x + 0x1CB;
- for the selected card (hidden while it is still face down): cost, soul and maintenance with
  `uiDrawDigitBound` style 0 (etc.one 2/1, 18 × 24 cells at (18d, 40), `g_uiDigitBoundCells` 0x088B9F88),
  y − 4; ones at x + 0x41 (cost), x + 0xD3 (soul), x + 0x182 (maintenance), tens and hundreds before
  them 0x12 apart; red (0x80, 0x10, 0x10) when the card cannot be used;
- cards left in the deck (deck state 0 over all 31 slots) in style 1 (24 × 32 cells at (24d, 0)) at
  (x + 0x213, y + 0x18) (two digits from x + 0x213, 0x18 apart), and "3", "0" at (x + 0x230 / 0x248,
  y + 0x4E);
- six card pictures (card.one 10001, 80 × 100, `cardPicLoadRef` size 1; scale 80/width, a 48-wide
  picture counts as 40) with the top-left at (x + 0x54·i, y + 0x18), the selected one at y + 0x10:
  usable (1) normal, not usable (2) darkened (0x40), empty (0) the card back darkened; a card being
  revealed flips around Y (`cardPicDrawRotated`, 3° per frame);
- on the selected card `uiDrawPointerHand(x + 0x20, y, rotation 135°)` (etc.one 2/2, six frames of four
  vblanks).

## Windows

All map windows are `g_deckWin*` globals drawn by `menuWinUpdateAll` in the order they were opened
([windows.md](windows.md)). The callers open them with `winOpenMessage(…, flags)` (0x1000/0x2000 = size
to the text, 0x4000/0x8000 = centre) and then set drawStyle 10 and add 10 to w and h. `winOpenMessage`
starts with chamfer 5, alpha 0x80, glyph fade 4 and type delay 0 (the whole text at once);
`winPrintAt` prints with fade step 0x7F. Besides the ones in the tables above:

- **Start-of-turn report** (`turnReportShow(player, 1)` 0x0883A0F0, used by Healing Spring, Sure Kill,
  Trap Zone and Regeneration): the handler opens the title (320, 16) with the base's name (size 22, flags
  0x7000); the report is `winOpenFrame(320, 101, 391, 0, 16, style 10, 0x4000)` and
  `winOpenFrame(160, 67, 391, 49, 16, style 10, 0x4000)` (the player's Dominator name, size 18, w =
  strlen/2 · 19 + 30), plus the help "＠ｂ２Change view " at (480, 67) (size 18, 0x7000). Rows (size 18):
  "Unit name" at x 0 and "HP" at x 0xE4, then up to 16 rows 19 px apart (`turnReportAdd`: unit name and
  e.g. "%2d ⇒ %2d"), or "No target "; h = rows·19 + 49. Square switches the side, Cross/Circle closes.
  The name window is opened after the report, so it covers the report's header line (**code**).
- `%s' s turn ` has an apostrophe: `msgParseNextGlyph` reads any other ASCII byte as the first byte of a
  two-byte code, so the "'" swallows the space after it and the banner reads "Galahad's turn".

## Turn start, commands and CPU (the flows)

Read from `mapBoardScene` and the functions it calls; the viewer runs them from `src/effect/mapFlows.ts`
(**code** unless marked).

**Turn start** (`mapTurnStartUpdate` 0x0885B430, state 0xB). A step counter (`g_mapTurnStartStep`)
walks 0 (commit conquest, total = own squares), 10 Blind Faith, 11 Magic Mine (both open a title window
at (320, 32) / (320, 24) and "%d Costs obtained " centred and wait for ✕/○), 20 Sure-Kill, 21 deaths,
22 TNT Clock Tower, 23 Dominator check, 24 deaths, 25 Trap Zone, 26 check, 30 deaths, 40 Regeneration,
41 Healing Spring, 50 check, 100 upkeep, 200 `cost = total − maintenance`, 201 draw
(`playerDrawCardUpdate(p, 1, 6)`). Any other value becomes (step / 10 + 1) · 10, so the order is fixed
by the numbers; a dead Dominator ends the machine at once.
- The handlers return −1 when nothing applies (the step is skipped without a window). Sure-Kill and
  Regeneration list the rows with `turnReportShow(player, 0)` (no help, no side switch); Trap Zone and
  Healing Spring fill the rows **one team per frame** (team 0 rows, then team 1, from both players'
  units), then `turnReportShow(player, 1)`: Square switches the side, ✕/○ closes. A unit with Annul Base
  gets a row with the ability's name instead of "%2d ⇒ %2d". `turnReportAdd` files rows by the unit's
  **team** (team 0 → list 0, else list 1). The title window is size 22 (Healing Spring, Trap Zone) or 20
  (Sure-Kill, Regeneration, Magic Mine).
- TNT Clock Tower: `winCloseAll`, the tower's name at (320, 32) and one centred window with both
  Dominators ("%s ＠ｎHP %2d ⇒ %2d " joined by ＠ｎ).
- Upkeep (step 100): `income < maintenance` opens "You do not have enough Costs. ＠ｎPlease destroy a
  unit. …" at (0, 8) (0x088EC738); the cursor picks an own unit (not the Dominator: slot field 0 / 0xFF
  is refused with SE 10), "Is it all right to destroy this unit? " + ✕/○, HP := 0,
  `mapProcessDeaths(−1)` (no Soul, no death triggers), repeat. The CPU waits 32 frames, then
  `unitFindMaxMaintenance` (slots 1–30 of both players with that team, strictly highest
  `CardDef.maintenance`) puts the cursor on it and sets HP 0, then 64 more frames.
- Draw (`playerDrawCardUpdate` 0x08853FAC): an empty deck runs `playerRecycleUsedCards` and opens
  "There are no cards left in the deck. ＠ｎ%d discarded cards have been returned …" (or "There are no
  cards in deck, ＠ｎnor in the discards pile. …") with the Dominator's HP − 5; a full hand (6) refuses
  the draw. The turn draw gives deck state 1 (face down).
- In modes 1/2 `ctrlGetPad` always returns pad 0, so the human presses ✕ to advance the CPU's messages
  too.

**Hand** (`handSelectUpdate`, besides the states above): state 1 looks for a hand card with deck state 1
and not 2; its unit.one /3 picture is loaded into `Sprite_08A42C98` (`cardLoadUnitImage(…, 2, 2)`),
y = −150 (0xFF6A) → state 10: SE 3, "%s ＠ｎhas been drawn. " (0x088E5F7C) centred, panel visible →
0x14: y + 1 up to 16 per frame until 8 while the panel slides in → 0x15 waits for ✕/○ (the CPU goes on)
and sets `bPanelVisible` = 0x30 → 0x16: the message fades (8), y runs on to 0x1E0 (16 per frame) and the
state waits for `bPanelVisible` = 1 → 0x32 fade-close → state 1 again (the next new card).
`handPanelDraw` draws the sprite at (160, y) before the panel and, while bit 0x20 of `bPanelVisible` is
set, turns the face-down card: `cardPicDrawRotated` with the back for angles 0–89 and the face at
angle + 180 for 90–180, 3° per frame (three steps per draw); at 180 the card gets deck state 2 and
`bPanelVisible` = 1. Triangle opens the card details (state 200, `cardInfoUpdate(card, 2)`; Left/Right
step through the hand), Square "Checking board. " (states 1000 / 0x44C: the panel drops to y 400, the
cursor runs, Circle shows the move preview / base range, Square returns via 0x76C / 0x122).
Discard (mode 0x400, states 0x26AC / 0x26B6 when all six slots are full): "You can only have five cards
in hand. ＠ｎPlease discard a card. " (0x088E5F94), every card usable, Circle refused (SE 10); ✕ →
state 4000 "Discarding this card. ＠ｎIs it all right? " → 0xFAA → 0x1004 (deck state |= 8) → 9000,
which repeats until fewer than six cards are held. The CPU (`aiChooseDiscard`) waits 32 frames and
drops the first card.

**`handMarkUsableCards`** (0x088547F0) tests every card with `playerCalcPayment(…, 8)`, the **spell**
flag, even units and bases: Toneriko Tree lowers the test for summons too, while Traveler's Tavern and
Assist Summon (flag 2, read at the cursor square) only count when the summon is paid. Dried-up Well
greys everything except in the swap / discard modes. Since Soul pays a shortfall (cost rules bit 2), a
card is usable while Cost + Soul covers it.

**Attack** (command 0x80): 0x28 marks `mapMarkAttackRange(unit, 0)` (|dx| + |dy| < range + 1, 0x20) →
2000 "Please specify the target to attack. " (8, 8): ✕ on the unit itself or an own unit beeps (SE 10),
a square without a 0x20 mark is ignored, Circle clears the range and returns to the ring → 0x7DA
"Commencing attack. " + ✕/○ → 0x834: marks off, `g_mapActionFlags` |= 4, the unit back on the grid →
0x83E `mapBattlePrepUpdate` (step 1 = `mapBattlePreCheck`, Evasion) → scene 0x5A (the duel) → 0x898 →
0x8A2 `mapBattleAfterUpdate` (Word Psalm, Bankruptcy Seed, Gaugabur Farm, Boost cleared, Bless of
Training) → 0x8FC → 0xB54 `mapProcessDeaths(1)` → 9000. In the duel both units strike before the HP
pass unless exactly one has First Attack (then it strikes, the HP pass runs, and the other strikes back
only if alive), so a unit killed by a normal attack still hits back.

**Skills** (command 0x40): `abilitySetCurrentUnit(unit, 1)` takes the **last** active ability of the
card → 4000 `abilityDispatch(0, 1)`: below 1000 `abilityConfirmUse` (the cost window centred: "Cost
usage: %d /  %d ＠ｎCosts: %3d ⇒ %2d ＠ｎSoul: %3d ⇒ %2d", the ability name above it, its description at
the bottom, "＠ｂ０Use ＠ｂ３Cancel " or "＠ｂ３Return "; Breath is always refused, Mind Read with six
cards); 1000 `abilitySelectTarget(mode, range)` (range ≥ 0 marks |dx| + |dy| < range around the user;
the self-target abilities pass mode 11 and skip the cursor); 0x44C `abilityConfirmTarget` ("＠ｎ( This
unit is an ＠ｃ１Ally unit＠ｃ０.)" on friends, Assassinate refuses Death Defense, Rotating Slash needs a
neighbour); 2000 → 0x834 `effectStart(AbilityDef.effect)` → 3000 the handler resolves and opens its
message (the ability name at (320, 8) if no title is open) → 9999, then ✕/○ closes and the cost is paid
(`playerCalcPayment(…, 0x10)`). The board goes to 0xB54 with `g_mapActionFlags` |= 2; Boost returns
0x834 (a battle with status bit 0); −1 returns to the ring. The range arguments: Snipe 3 / 4 / 5
(LV1/2/3, so within 2 / 3 / 4), Foot Stamp 2, Assassinate 4, Pick Pocket 2; Destroy Outpost, Base Repair
and the Summon Land abilities pass −1 (no range).

**Map spells** (state 0xC80, `mapSpellCastUpdate` 0x08845B0C): 0 init (the card under the hand cursor;
`g_mapDeployRules` bit 0x10 is cleared, so Ambush does not apply during a spell; the CPU jumps to 3000
with `spellGetTargetMode`), 1000 `spellSelectTarget` (windows: card name (8, 8) size 20, the prompt below
size 22, the effect text at the bottom; modes 10/12/8 return at once), 2000 `spellConfirmTarget` (the
legality checks and "＠ｂ０Accept ＠ｂ３Cancel " / "＠ｂ３Return "), 3000 `mapCounterSpellWindow`, then
`effectStart(CardDef +3F)` (0xBC2 waits), 4000 the handler applies the effect and opens its message,
the card name at (320, 16) in a frame, recount, 5000 ✕/○ (Firestorm: Square switches the report side via
0xFAA), 9000 `playerPaySelectedCard` (flag 8, clamp 0, Cast Spell cleared, discard), 9999 deaths → the
hand again (0x10, or 0x13 for the CPU; 9000 if a Dominator died). The state number drives
`mapSpellCastUpdate` by thousands after the handler ran: a handler that moves its own state (for
example to 0x4B0, 0x834 or 0xFAA) decides which block runs (0x4B0 counts as 1000, 0xFAA as 4000). At 3000
a return of 0 skips the effect, 1 plays `CardDef +3F`, any other value is the effect id; the draw flags
lose 0x18 while it plays, 9999 sets 0x1C again. Some handlers pay in state 4000 themselves (Homesick,
Rise of the Betrayer, the player spells; Strategic Retreat at its confirmation), so 9000 does not pay
twice. See [Counter window](#counter-window--mapcounterspellwindow-0x088467d0) and [Spells with a second
step](#spells-with-a-second-step-lists-menus-second-picks).

**To title** (5000): "Returning to title screen. ＠ｎCurrent game details ＠ｎwill disappear without
saving. …" (0x088DD160) centred with "＠ｂ０Yes ＠ｂ３No " → 0x1392: ✕ ends the board (12000), ○ back to
0x1E. **Temp save** (6000) runs `saveDataScene(SAVEOP_SAVE_CONTINUE)` (the PSP save dialog,
[save-menus.md](save-menus.md)). **Help** (7000) runs `rulesHelpScene` (the "How to play" viewer,
[extras.md](extras.md)) with `g_mapDrawFlags` = 7; when it returns 1, flags 0x1F and back to 0x1E.

**Action end** (9000): the Dominator-alive mask decides a result first (1 → 10000, 2 → 11000, 0 →
0x2CEC); End turn asks "Ending turn. …" (human only), everything else is confirmed at once; the unit
goes back on the grid (`unitSummonUpdate(−1, −1)` = `unitPlaceOnGrid`, which **owns its square and
commits every pending seize**), Veda is removed after a move, `mapCommitConquest`. 0x238C checks the
conquest goal ("Conquest ＠ｎ%d points gained ＠ｎGoal points ( %d)  achieved ", size 24; ✕ → the turn
player wins), then actFlags |= 0xF with Double Action, and for the CPU `g_aiUnitSlot` + 1 → 0x13 until
the Dominator (slot 0) has acted. 0x26C0 `mapTurnEndUpdate`: flags 8 / 0x10, Foot Stamp and
Foot-stopper of the ending team, actFlags 0, then the next player with a living Dominator
(`g_mapRound` + 1 when player 0 comes round).

**CPU** (state 0x13, `aiMapTurnUpdate`, [ai.md](ai.md)): the card phase goes through the same
`handSelectUpdate` (the panel slides in and out; `aiChooseHandCard` records the usable cards over six
frames and plays the first that passes), summons with `aiPlaceSummon` → `unitSummonUpdate`, spells with
`mapSpellCastUpdate` from state 3000; each unit then walks its 2-bit path (`unitStepToward` one square at
a time, `mapSeizeCell(…, player, leg 0)` on every square), waits 64 frames, and attacks (0x834 after 32
frames) or uses its ability (`abilitySetActive(…, 2000)`, so the cost window and the target choice are
skipped). **Code reading:** `aiMoveSearch` stores the search depth as the step count, and a square
inside a Labyrinth Marsh sets the depth to `move` for the next square, so a marsh path can count more
steps than it has path bits; the extra steps read 0 bits (x − 1).

**Other code facts found for the port:** `unitPlaceOnGrid` writes the deck slot's low byte into the cell
word, so the Dominator's slot field is 0 (readers map 0xFF to 0 as well); `mapCountBaseAuras` reads only
the per-team counters (the "any team" block is written but never read); `mapAddBaseAura` clips the rows only
at the top (the bottom-edge test has an empty body, so rows below a short board are counted in unused rows of the array) and not the columns, so an aura near the left edge also counts on the far right end of the
row above in the 40-wide array (only visible on boards 37 or more squares wide); `mapFloodMovePreview`
ends the flood on a Labyrinth Marsh square except for one more square from the unit's own square.

## Start of a board (states 0–10)

`mapBoardScene` states before the first turn (**code**):

- **0** init: `playerResetDeck` for **all four** DuelPlayers in modes 1/2 (each shuffles, see
  [Random numbers](#random-numbers)), `unitInitFromCard` for the 31 slots, three opening draws
  (`playerDrawCard(p, 5)` with deck state |= 2), and in modes 1/2 the Dominators go on the layout's start
  squares (`unitSummonUpdate(…, 0)`: slot 0 is placed at once, scale 0, so it pops in). The cursor starts
  on player 0's Dominator (modes 1/2) or on the first square with land ≥ 0, row by row (versus).
- **1** (after the loads): the billboard sprites, `g_mapDrawFlags` = 3 (board only); a new board sets
  `g_mapRound` = 1, starts the **stage-start event** in story mode (`msgEventStart(ctx, layout,
  opponent, 0, 1)`) → 2. A resumed game (round > 0) goes to the free cursor.
- **2**: the area name (`mapFormatAreaName(area, 0)`: "%s" of the name table 0x088B9F2C) centred, size 22
  → **3** waits for ✕/○ (versus: also for the ad-hoc sync) → **5**: `msgEventUpdate` until the event ends
  (1), then the "Conditions to win" frame (style 4, chamfer 0, centred; w = (longest line + 2) · 23 / 2 +
  60, h = lines · 23 + 60): "Conditions to win " at (0, 0), "Lower enemy dominator' s HP to 0 " at
  (23, 23) and, with a conquest goal, "Gather %d in conquest " at (23, 46), size 22. In story mode on
  layouts 1 and 11 the turn player flips to player 1 (**the CPU moves first on stages 1 and 11**) → **6**
  waits for ✕ → 10 when player 0's Dominator is already placed, else 7.
- **7–9** (versus only): "Please select the initial location ＠ｎof the dominator. " (0x088DCFC8) at (8, 8);
  ✕ on an empty square: a square marked 1 answers "You cannot select this location. " (SE 10), otherwise
  "Is this location all right? " with "＠ｂ０Accept ＠ｂ３Cancel " (SE 7) → 8: ✕ → 9, ○ → 7 → 9:
  `unitSummonUpdate(Dominator of g_mapHandPlayer, cursor, 0)`, the next player, `mapFillDiamond(first
  Dominator, 5, 1)` (the address `g_msgCgSprites + p · 0xAA8 + 0x3D8` is `g_mapUnits[(p − 1) · 31].posX`)
  → 7, or 10 after the last player.
- **Stage events** use the story player's `msgEventUpdate` / `msgEventDraw` ([story.md](story.md)).
  `msgEventStart` marks the event active at once (ctx + 0x6C), and `mapBoardScene` then calls
  `msgEventDraw` **instead of** `menuWinUpdateAll`; `msgEventDraw` draws the event background, the CG and
  then `menuWinUpdateAll` (every window, the board's included). Turn events start in step 100 of
  `mapTurnStartUpdate` (story mode: `msgEventStart(ctx, layout, turn Dominator, g_mapRound, 9)`) and step
  200 waits for `msgEventUpdate` > 0 before the Costs are set. `mapSpellCastUpdate` state 0xC1C waits for
  an event that nothing starts (dead).

## Map effects — `effectStart` / `effectIsBusy`

- `effectStart(id)` (0x0888EF48) allocates 64 KB and queues the load of effect.one entry 1000 + id,
  member 1, **only while `g_effectState` is the idle state and nothing is loading** (a second start is
  ignored; returns −2 when not idle, −3 while a load is queued, −4 if the allocation fails, 0 when
  queued; the callers ignore it). It does not change the state: the idle handler (`effectStateIdle`
  0x0888F008) sees
  `g_effectLoadCount` > 0 and switches to `effectWaitLoadAndStart`, which on the frame the load is done
  runs the init pass and arms entry 15; the script's first frame runs on the frame after that.
  `effectRunFrame` runs the scripts and tweens and, when slot 0 died, sets `effectFinish`, which frees the
  buffer on the next frame; `effectIsBusy` is true until then.
- `mapBoardScene` calls `(*g_effectState)()` at the end of the frame (after the hand panels, ring, windows
  and the card screen), then `scrObjRenderAll(0)` and `scrObjRenderAll(6)`. The depth buffer was cleared
  (`gfxClearDepth`) before the hand panels, so camera-0 sprites (GE z = 65535 / view depth, small) are
  hidden behind the panels, ring, windows and card screen drawn after the clear and pass over the board,
  HUD and cursor; camera-6 sprites (z 0xFFFF) pass over everything ([effects.md](effects.md)).
- The map's effect scripts centre themselves on the screen (the camera follows the cursor, which the
  callers move onto the target first). Script functions: 0x385 `map_get_cam_pos` (g_mapCamPos =
  (cursorX − 0x8926, cursorY − 0xEDA5, −0x8000)), 0x386 the camera rotation (−65, 0, −30), 0x388 writes
  `g_mapCurUnit`'s grid word, scale 0, state 1 (the summon effect makes the unit pop in), 0x389 clears
  its grid word, scale 100, state 4 (the death effect starts the shrink), 0x384 the result winner.
- Who starts what: summons 0x26 (after the counter window; `unitSummonUpdate` clears `g_mapDrawFlags`
  0x1C while it runs), deaths 0x35 (`mapProcessDeaths` step 30 with `g_mapCurUnit` = the dead unit),
  spells `CardDef.bMapEffectId` or the handler's own id at state 3000 (Cityscape Mirage 0x1E–0x21 by the
  chosen attribute; the player-target draw / discard spells and Winter Preparation skip the effect:
  their state 3000 jumps to 4000 themselves), abilities `AbilityDef.effect` (state 0x834), Evasion, Last
  Flower, Destiny of Healing, Trench Mortar (`CardDef(3015).bMapEffectId`), the after-battle triggers
  (Word Psalm, Bankruptcy Seed, Gaugabur Farm, Bless of Training), the counter 0x45 (only when the counter
  card has a map effect) and the result screen 0x36 (0x1D without a winner). The turn-start handlers
  start no effect.

## Counter window — `mapCounterSpellWindow` (0x088467D0)

Called with the card and 0x20 (a map spell, `mapSpellCastUpdate` state 3000, also for the CPU's casts)
or 0x40 (a summon, `unitSummonUpdate` step 10). The opponent of the turn player answers; returns 1
(countered), −1 (not), 0 (busy). States (`g_counterWinState`):

- **0** `handMarkUsableCards(opponent, mode)` (0x20: Defuse Spellpower 2401 and Reverse Magic 2405;
  0x40: Negotiation Trouble 2403 and 2405) and count the usable ones; none → 5 (spell) or −1 (summon).
- **1** "＠ｂ０Use  ＠ｂ３Cancel " (0x088BB4C4) centred, "You can use a passive spell ＠ｎagainst %s' s ＠ｎ%s. "
  (the caster's Dominator, the card) above the centre, and at the bottom the card's effect text (spells
  and bases) or "AP %2d ＠ｎHP %2d ＠ｎMove %2d " (0x088BB518) → **2**: the CPU waits 48 frames and declines
  when `(((gameRandNext() & 0xFFFF) + 1) / 11) % 10 < 4` (SE 9), else goes on (SE 7); a human ✕ goes on,
  ○ declines. Declining a spell → 5, a summon → −1.
- **3** `handSelectUpdate(opponent, mode)` with `g_mapDrawFlags` |= 0x18 (the opponent's panel slides in;
  the help lists "＠ｂ２Check target " (0x088E606C): Square shows the card being used above the panel,
  states 3000 / 0xC1C; the CPU takes the first usable card): −1 → 5 / −1, 1 → 10.
- **10** "Now using ＠ｎ%s. ＠ｎIs it all right? " (0x088BB588) centred with "＠ｂ０Accept ＠ｂ３Cancel " → **20**:
  ✕ (the CPU after 48 frames) → 30, ○ → 3 (back to the hand).
- **5** Magic Barrier: with spell target mode 1 or 2, a target (or Relocation's second unit) carrying
  2402 → 30 with the counter card 2402, else −1.
- **30** `winCloseAll`, `g_mapDrawFlags` &= ~0x18, `effectStart(0x45)` when the counter card has a map
  effect → **40** after the effect: Reverse Magic costs the caster's Dominator 2 HP ("%s' s ＠ｎsummoning has
  been eradicated. ＠ｎ%sHP  %2d ⇒ %2d " / "%s. ＠ｎhas been eradicated ＠ｎ%sHP  %2d ⇒ %2d "), the others
  "%s' s ＠ｎsummoning has been eradicated. " (0x088BB644) / "%s. ＠ｎhas been eradicated " (0x088BB624),
  size 20 centred, the counter card's name at (320, 16) → **50**: any button on pad 0 or 1 → 1.
- On 1 the counter card is paid (`playerPaySelectedCard(opponent)`) or, for Magic Barrier, one 2402 is
  removed (Relocation: from the first of the two units that has one). A countered spell goes to 9000
  (paid, no effect; Shard of Life and Divine Light return their picks to the discard pile); a countered
  summon is still paid (step 20) but its card goes to the discard pile (deck state |= 8) and it is not
  placed.
- **Dead code:** the state-10 text for Magic Barrier ("The targeted unit has ＠ｎ“%s”vattached to it.
  ＠ｎWould you like to use it? ", 0x088BB538) and the ○ branch of state 20 for 2402 are unreachable, since
  state 5 jumps straight to 30.

## Spells with a second step (lists, menus, second picks)

All **code** (the handlers in [card-effects.md](card-effects.md) give each one's texts):

- **Player list** (mode 7 of `spellSelectTarget`): `winOpenList(64, 160, 251, n · 21 + 20, g_deckWinMenu, n,
  20, 20, names, 0x40, 0x800)` with the living Dominators' names; `winUpdateInput` moves the bar; ✕
  takes `g_mapUnits[cursor · 31]` (the row is used as the player index).
- **Discard-pile list** (mode 11, Shard of Life and Divine Light of Koriah): the unit and base cards in
  the discard pile that are not already picked, `winOpenList(0, 0, 272, n · 21 + 20 (125 with a scroll bar
  from 6 rows, flags 0x810), …, 0x20, 0x800)` centred; "There are no revivable cards in the discard pile. "
  / "You cannot place any more units. " (placed + picks > 15). Help: "＠ｂ０Accept ＠ｎ＠ｂ３Cancel " (first
  pick), "＠ｂ０Accept ＠ｎ＠ｂ３Return ＠ｎ＠ｂ２End selection " (later picks), ○ undoes the last pick, Square
  ends the selection (Divine Light, up to four picks). Each pick is placed on a square marked by
  `mapMarkDeployCells(player, slot)` ("Please select the location for revival. " / "There are no places to
  deploy units. "); Divine Light unmarks the squares of earlier picks.
- **Attribute menu** (Cityscape Mirage, inside `spellConfirmTarget`): `winOpenMenu(0, 0, g_deckWinMenu,
  22, 22, "Earth attribute ＠ｎWater attribute ＠ｎFire attribute ＠ｎAir attribute ")` centred
  (list mode 2: h = rows · 22 + 14, w = (maxCol + 1) · 11); ✕ sets `g_mapSpellChosenAttr` = cursor + 1.
- **Second board pick** (`spellSelectCell`): Relocation (the second unit, not a Dominator; Anti-magic
  Barrier at the second square is tested with the **first** unit's Annul Base), Mirror Reflection (any
  unit square, "This cannot become a base. " / "This cannot become a Dominator. "; the target itself is
  allowed), Push (a marked square within 3), Running Wind (an empty own square, no marks).
- **Swap** (Mask of Change): `handSelectUpdate(player, 0x200)` ("Please select the card to swap. ", only
  unit cards usable, help "＠ｂ３Return "), then the hand cursor and selected slot are swapped back so the
  spell card is paid at 9000.

## Result screen — `duelResultScreenUpdate` (0x08833094) / `duelResultScreenDraw`

States 10000 (player 0 wins), 11000 (player 1) and 0x2CEC (no winner) call
`duelResultScreenUpdate(side)`; `duelResultScreenDraw` runs in the draw path and, while
`g_resultDrawFlags` ≠ 0, replaces the HUD, panels and windows of the board (the board itself is still
drawn underneath). A nonzero return (the exit scene) ends the board (state 12000).

- **0** winner / loser recorded, BGM 0xB (won in modes 1/2, or any winner in versus) or 0x10,
  `effectStart(0x36)` (0x1D without a winner) → **1** after the effect: portraits chara.one 100 /
  `charaIdToIndex` of both Dominators, the sheet chara.one 100 / 1000, banner scale 200 %, and in modes
  1/2 `duelRollRewardCards` ([save-menus.md](save-menus.md#card-rewards)) → **2** → **3** flag 1 (the
  screen dims: Prim2D (16, 16, 16, 0x60)), flag 2: the banner shrinks 4 % per frame to 100 % → **4** flag
  4: the portrait slides in 10 px per frame from x −512 to −128 → **5** flag 8 (stats) → 10 (versus) /
  0xB (story) / 0xC (free).
- **7** the reward cards appear one every 17 frames (✕: all), then turn over (3° per frame, each after the
  previous passed 45°; ✕: all at once); then "＠ｂ１Card details ＠ｎ＠ｂ０End " at the bottom → **8**: Left /
  Right in a row of five, Up / Down between the rows, Triangle → **9** (`cardInfoUpdate(card, 2)`, L / R
  step), ✕ → 0xB / 0xC.
- **0xB / 0xC** flags 0x2F; rewards still hidden → 7; else the after-win (3) / after-loss (4) event in
  story mode → **0xD / 0xE**: flag 0x40, `msgEventUpdate` from the next frame; the first frame with 0x40
  draws everything once and resets the flags to 0x40, so **during the event only the event is shown**
  → 0x80 → **0xF** (won): the area name and "Clear " in a frame, ✕/○ → **0x10** (at once when not won);
  the reward copies are added (count < 10) in the frame the state becomes 0x10; state 0x10 then counts
  the battles and gives the special cards, exit 300 (0x834 after a story win: the stage-clear scene).
- **10** (versus) "＠ｂ３Back to title " (0x088B9AD4) at the bottom right (centred without a winner); ○ on
  pad 0 → exit 0x32 (and the ad-hoc disconnect).
- **Draw**: 1 dim; 4 the winner's portrait at (x, 0) (without a winner both, the second at 128 − x);
  2 the banner (sheet (0, 0)–(256, 72) at (0x130, 0x18), without a winner (0, 0x98)–(256, 0xE0) at
  (0xC0, 0x18)), centre anchor, scale %; 8 the winner's name plate (etc.one 110/4, team row) at (0x140,
  0x68) with the name (size 19, line 22) at (0x158, 0x72), the sheet's "Total turns / Conquest" rows
  (0, 0x48)–(0xE0, 0x90) at (0x140, 0x8E) and `g_mapRound` / the conquest count right-aligned at 0x21C
  (`uiDrawDigit`, 18 px apart; **a value of 0 prints nothing**); without a winner both players' plates at
  x 0x30 / 0x170, y 0xE0, their conquest rows at y 0x108 and the rounds at (…0x1AC, 0x66); 0x20 the reward
  cards from (0xDC, 0xE0) (without a winner centred at y 0x14C), 0x52 apart, the sixth starting a second
  row 0x69 lower, NEW badge (`uiDrawNewBadge`, flag bit 1) at (x + 8, y + 0x44) and the pointer hand on
  the cursor; the card screen (`cardInfoDrawCard`) while open; then `menuWinUpdateAll`, or the event.

## Card screen on the board

Triangle on a unit (only while the cursor rests, inside `mapCursorUpdate`, so in every state that moves
the cursor) loads the attachment pictures and sets `DAT_08A1BD8C`; `mapCursorUpdate` then returns 0
(everything waits). Each frame the draw path calls `cardInfoUpdate(unit card, 1)` until it returns −1
(Circle; Left / Right switch the tabs, ✕ on the attachment tab moves the 2×3 cursor), hides the cursor
hand, HUD and hover panel, and draws `cardInfoDrawUnit` **after** the windows (before the effects) —
over the board, like the deck editor. The hand's Triangle (state 200) uses `cardInfoUpdate(card, 2)`
(L / R, the shoulder buttons, step through the hand; `handSelectUpdate` returns 2 while it is open).

## Random numbers

- `rand()` / `srand()` are newlib's (64-bit LCG, bits 32–62). The only `srand` call is on the title
  screen with the save header's play time, which this build never advances (0: `mainFrameHook` loads
  the packed word, re-packs the same fields and stores it back, the increment was stripped). `playerShuffleDeck`
  uses `rand() % 30` in modes 1/2 (`adhocSyncRand() & 0xFFFF` in versus): for k = 1…31 up to 10001 tries
  until a free slot, so the 31st round always burns 10001 draws; state 0 shuffles all four DuelPlayers.
  `polySystemInit`, `scrfn_randJitter2D`, the save dialog and the font cache (`fullfontGet`, only when all
  256 glyph slots are in use) also draw from `rand()`.
- `gameRandNext` (0x0887B544) is the only other generator, never re-seeded (s = t = 0x3427 / 0x1654 at
  boot). Callers: the CPU (`aiChooseMapSpell` Earthquake, `aiPlaceSummon` for Anti-magic Barrier and
  Symbolic Flag), `mapCounterSpellWindow` (the CPU's decline), `duelRollRewardCards`, the effect
  scripts' `rand(n)` (`scrfn_rand`), and in modes 1/2 `spellMemorySlip`, `spellStrategicRetreat`,
  `spellBattlefieldScales` and `abilityPickPocket` (versus: `adhocSyncRand`).
- So the sequence depends on everything that ran since boot (effects, menus); a fresh session from a
  seed is reproducible, a real console session is not.

## In the viewer

Card database → Maps → **Game view** (the flat grid stays under **Flat**). The board of the selected
stage is drawn at 480×272 with the game camera and the game's own sprites, 60 frames per second, and it
runs the game: `src/effect/mapRules.ts` (the map state block, MapUnit / DuelPlayer records and the
rules), `src/effect/mapFlows.ts` (the step machines above, the spells and the counter window),
`src/effect/mapAi.ts` (the CPU), `src/effect/gameRand.ts` (the game's generators) and
`src/effect/mapBoard.ts` (drawing, `mapBoardScene`'s state machine, effects, list windows, the result
screen). `node scripts/map-rules-check.ts` runs headless checks (payment, usability, stats and auras,
seizing, move lines, deploy squares, Soul, conquest, the battle outcome, `rand` / `gameRandNext` /
`adhocSyncRand`, the shuffle, the CPU's counter decision, Magic Barrier, `spellGetTargetMode`, Earth Nova
through `mapSpellCastUpdate`).

- **Controls**: arrows = D-pad; Enter / Space / Z = Cross; Shift / Esc / Backspace / X = Circle (held:
  faster cursor); A = Square (check board, report side, held: list pages); Q = Triangle (card details);
  W / R or PageUp / PageDown = L / R (jump between units, step cards in the card screen); E = START (End
  turn, skip an event); Tab = SELECT (stat digits); H = open the turn player's hand; T = start the turn;
  click = jump the cursor to a square (viewer only). Panel: the two Dominators, the **game mode** (story,
  free battle, versus = `g_gameMode` 1 / 2 / 0), "opponent is CPU" (DuelPlayer.controller 0xFF / 0), the
  **seed** (srand) and New game, sample units around the start squares (viewer, default 0),
  click-to-place any card for either side, "Acted", both players' Costs and Soul, the mark overlays,
  "duel scene" (off: the outcome is applied at once), HUD / hover panel / cursor hand / zoom / bilinear
  toggles. Under the canvas: the state, round, Costs, Soul, the running effect and the generator state.
- **Exact (from code)**: everything of the drawing listed in the sections above; the start of a board
  (states 1–10: area name, the stage-start event through the story player, "Conditions to win", the CPU
  moving first on stages 1 and 11, the versus start squares); the turn events (step 100 / 200); the rules
  of `unitRecalcStats`, `playerCalcPayment`, `handMarkUsableCards`, `mapCanDeployAt` / `mapMarkSummonCells`
  / `mapMarkDeployCells`, move lines and preview, `mapSeizeCell`, `unitPlaceOnGrid` /
  `mapCommitConquest` / `mapUndoSeize`, base auras, `unitDestroy`, `mapProcessDeaths` with its triggers
  and the death effect; `mapTurnStartUpdate`; `playerDrawCardUpdate` (modes 1, 2, 5); the hand (draw
  animation, flip, card details, check board, check target, swap, discard); the command-ring flows
  Attack, Skills (every activated ability), To title; **map effects** (every `effectStart` above,
  effect.one scripts run by the effect player over the board with the game's depth order, the load /
  run / finish timing, `effectIsBusy` as the end condition, the map script functions 0x384–0x389);
  **the counter window** (Defuse Spellpower, Negotiation Trouble, Reverse Magic for both a human and the
  CPU, Magic Barrier); **every map spell handler** decompiled for this port, with its texts read from
  BOOT.BIN or the code (Mask of Change, Relocation, Shard of Life, Cityscape Mirage, Divine Light of
  Koriah, Mirror Reflection with the board pick, Homesick, Chick Bug Curse, Rise of the Betrayer, Magic
  Dragon Gaze and Firestorm with the report, Earth Nova and Green Noa with their one-line messages, the
  land spells, Lord of Blanks, Flames of Invasion, Strategic Retreat, Memory Slip, Unexpected Guest, Turn
  Over a New Leaf, Destruction of Future, Starving the Enemy, Winter Preparation, Battlefield Scales,
  Push, Running Wind), `spellSelectTarget` / `spellConfirmTarget` / `spellSelectCell` /
  `spellGetTargetMode`; the list and menu windows (`winOpenList`, `winOpenMenu`, `winUpdateInput`);
  summons through `unitSummonUpdate` (counter, effect 0x26, payment, Trench Mortar, deaths); the
  after-battle triggers (`mapWordPsalmUpdate`, `mapAfterBankruptcySeed`, `mapAfterGaugaburFarm`,
  `mapAfterBlessOfTraining`) with their effects and texts; action end, conquest goal, Double Action,
  discard, `mapTurnEndUpdate`; `g_mapDrawFlags`; the card screen over the board (`cardInfoUpdate` modes 1
  and 2, `cardInfoDrawUnit` after the windows); `mapCursorCycleUnits` (L / R); the result screen
  (`duelResultScreenUpdate` / `Draw`, `duelRollRewardCards`); the random numbers (`rand`, `gameRandNext`,
  `adhocSyncRand`, `playerShuffleDeck`, one generator shared with the effect scripts); the CPU:
  `aiMapTurnUpdate`, `aiFloodDistMap`, `aiSelectNextUnit`, `aiMoveSearch` / `aiEvalAttackTarget`,
  `aiCommitPlan`, `aiDecideAction`, `aiPickActivatedAbility`, `aiEvalAbility` with every evaluator
  (Snipe, Berserk, Assassinate, Rotating Slash, Summon Element, Evolution, Boost), `aiChooseHandCard`,
  `aiChooseMapSpell` / `aiSpellTargetOk`, `aiPlaceSummon`, `aiChooseDiscard`, and the CPU's counter card.
  The duel scene (DuelSession) runs over the board with the combatants' board context and its HP go
  back to the board.
- **Approximated** (small): the effect load takes one frame (`fileQueueWaitOrPending` depends on the
  disc); the card screen is drawn on a stacked canvas, so a camera-6 effect never covers it (no effect
  runs while it is open); the viewer's Game view rolls the rewards against an empty scratch profile (Play mode
  passes the real one: copies, counters and special cards are stored); the session starts from `srand(seed)` and the
  boot state of `gameRandNext`, not from the draws a real session made before the board; the viewer
  stops a CPU walk before a missing or occupied square (see the marsh note above); Temp save shows a
  note in the viewer (Play mode runs the save: [play-mode.md](play-mode.md#saves)), Help runs the ported `rulesHelpScene` ([extras.md](extras.md)); after To title or the result
  screen's exit the board stays black (the title scene is not part of the viewer); the rotated card of
  the flip turns about its vertical centre line; texture filtering is a viewer toggle; the ring's
  `g_camDefault3D` focal length (768) is the one the effect player uses; list rows use the window
  painter's text layout (the list-mode glyph re-layout of `menuWinUpdateAll` is not ported
  glyph-for-glyph).
- **Sound**: the recorded `sndPlaySeUi` ids and the map / duel effect scripts' `se_play` play through the
  SAS model when the "sound" switch is on and se.dat is loaded ([sound.md](sound.md#sound-effects-sas)).
- **Not modelled**: ad-hoc play (versus runs both sides on one pad), BGM.
- **Not compared with a real screen** (open question 3.11): the background alignment looks right on
  the boards checked (stages 1, 2, 9, 11, 15: the squares sit on the painted floors), but nothing has
  been checked against an emulator.
