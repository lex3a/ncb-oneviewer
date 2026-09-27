# Card info screen

The full-screen card viewer the game opens from the card list, the deck editor, the duel result and
on a unit on the map. Everything here is **code** (Ghidra, USA EBOOT) unless marked otherwise. The
viewer reproduces it under **Card database → Cards → Game view** (`src/effect/cardScreen.ts`,
`src/components/CardScreenView.tsx`).

## Entry points and state

| Function | Address | Role |
| --- | --- | --- |
| `cardInfoUpdate(cardId, mode)` | 0x08821714 | Input and state machine (`g_cardInfoState`): 0 start (`cardPreviewSetCard`), 1 wait for the file queue, 2 browse tabs, 3 attachment cursor, 4 close. A new card id restarts at 0 (the tab is kept). |
| `cardInfoDrawCard(cardId)` | 0x088226E0 | Plain card (card list 0x0882C4FC, deck editor, duel result). Base stats = CardDef {AP +0C, HP +10, Range +14, Move +18, Attr +28}, effective stats all 0, no DF. |
| `cardInfoDrawUnit(unit)` | 0x08822554 | A `MapUnit`: base {0, cHp, 0, 0, 0} (mode 2: {cBaseAp, cHp, 0, 0, bAttribute}), effective = the unit's nEffAp/Df/Range/Move/Attribute (zero for bases), DF shown. Draws the attachments tab after `cardInfoDraw`. |
| `cardInfoDraw(cardId, base, eff, x, y)` | 0x08821C30 | Picture, tab bar, frame, name, attribute icon, active tab. `x, y` (0x1C, 0x10) are unused. |

**Modes and tabs.** `g_cardInfoTab` is one bit: 1 status (sprite label "Ability"), 2 attachments
("Enchant"), 4 flavor ("Detail"), 8 ability list ("Skill"). The tabs offered:

| `g_cardInfoMode` | Caller | Units, Dominators (id < 2000) | Spells, bases |
| --- | --- | --- | --- |
| 3 | card list, deck editor | 1, 4, 8 | 1, 4 |
| 1 | unit on the map | 1, 2, 8 | 1 |
| 2 | (caller not traced) | 1, 8 | 1 |

Left/Right shift the bit and skip the tabs that are not offered (wrapping). On the attachments tab
Cross (0x4000) enters the cursor (`g_cardInfoAttachCursor` 0..5): Left/Right wrap inside a row,
Up/Down swap rows, Circle (0x2000) leaves. Circle on the tab bar closes the viewer.

## Coordinates and sprites

All positions are 640×448 virtual pixels: `spriteDraw2D` maps each vertex with x·480/640 and
y·272/448 (truncated), and `spriteUpdateVertices` computes a vertex as
`position + offset + pivot + trunc(R·S·(corner − pivot))`. The offset is normally 0 unless
`spriteSetPos` or `spriteResetOffset` (offset = −pivot, which puts the pivot on the position) set it.
`spriteSetSrcRect(u0, v0, u1, v1)` resets the pivot to the top-left, so scaled sprites grow right and
down.

Sprites (all loaded at boot by `menuLoadCommonSprites` 0x0882CD28 and `menuWinSysInit` 0x08867B1C):

| Global | Source | Content |
| --- | --- | --- |
| `g_uiNumberFontSprite` | etc.one 2/1 (256×64) | digits (`uiDrawDigit` 0x08839694, table 0x088B9F94: style 0 cells 18×24 at (18·d, 40); 10 `+`, 11 `/`, 12 `−`) |
| `Sprite_089b4fe4` | etc.one 2/2 (144×64) | pointer hand, six 48×32 frames (u/v tables 0x088B8664 / 0x088B866C) |
| `g_cardInfoUiSprite` | etc.one 2/4 (256×256) | stat labels, kind banners, stars, underline, soul icon, Battle / Enchant badges |
| `g_cardInfoFrameSprite` | etc.one 2/5 (272×272) | tabs, frame, name plate |
| `g_winSkinSprites[10]` | etc.one 1/11 (224×64) | attribute / category icons, rects `g_attrIconRects` 0x088F4678 (13 × four corners) |
| `g_cardPreviewSprite` | unit.one `<id>`/3 (240×300) | the card picture (`cardPreviewSetCard` 0x0881FE50) |
| `g_mapInfoAttachSprites[6]` | unit.one `<id>`/2 (80×100), empty slot 1000/2 | attachments (`mapInfoLoadAttachmentImages` 0x08821668) |
| `g_cardMapAnims[no]` | card.one `<id>` (GAN) | the unit's map animation (flavor tab) |

### `cardInfoDraw`

- Picture at (0x1C, 0x10), scale 1.2.
- Tabs (frame sprite, scale 1.2 × 1, y 0x15): the offered tabs sit 0x4C apart in bit order at
  `x = trunc(pos·1.2 + 324)`. Rect index per bit 1 → 0, 2 → 2, 4 → 1, 8 → 3 in
  `g_cardInfoTabRects` (0x088B791C, 8 × {u0, v0, u1, v1}: 4 inactive, then 4 active). Inactive tabs
  are drawn right to left, then the frame, then the active tab on top.
- Frame from 32×32 pieces: corners at (0x144, 0x3B), (0x244, 0x3B), (0x144, 0x158), (0x244, 0x158);
  top and bottom edges ×7 from 0x164; left and right edges ×11.5 from y 0x5B; centre ×7 × 11.5. The
  right edge uses rows 0x9A–0xB0 (part of the corner), unlike the left edge (0xB0–0xC6).
- Name plate (0, 0x60)–(0xF2, 0x83) at (0x14A, 0x42); name with `fontDrawTextScaled` at (0x15A, 0x4C),
  size 21. In mode 1 it is `unitGetName`, which gives the **player's name** (`duelGetPlayerName`) for
  a Dominator (deck slot 0) and the card name otherwise.
- Attribute icon `g_attrIconRects[CardDef +28]` at (0x23E, 0x45) (spells: category icons 5–12).
- Tab 1 → `cardDrawDetailPanel`, 8 → `cardDrawAbilityList`, 4 → units (id < 1000): `g_cardMapAnims`
  at (0x220, 0x168) scale 1.8; bases (id ≥ 3000): the board token (`cardGetTokenSprite`, card.one
  10010) with anchor 2 (pivot (w/2, h)) and `spriteResetOffset` (offset = −pivot), so its **bottom
  centre** sits on (0x220, 0x168) and the 1.8 scale grows around that point; Dominators and spells
  draw nothing there. Then `cardDrawFlavorText` (0x08821040): +40 text at (0x154, 0x72), size 22.
  (Verified against the code 2026-09-27, like every coordinate on this page.)

### Status tab — `cardDrawDetailPanel` (0x088200A0), x = 0x144, y = 0x20

| Item | Source rect (etc.one 2/4) | Position | Value |
| --- | --- | --- | --- |
| Kind banner | unit (0,6E), Dominator (0,9A), spell (0,84), base (0,B0); 0xAC × 0x16 | (x+10, y+48) | id / 1000 |
| Stars | (15·f, 200)–(15·f+15, 0xD7) | (x+C0 + 15·i, y+4C) | CardDef +2C rarity |
| HP `cur/max` | (0,0)–(28,18); underline 0x72 at (x+20, y+78) | y+66; digits from x+26 | base[1] / CardDef +10 |
| DF (map units) | (28,0)–(50,18); underline 0x3C at (x+BE, y+78) | (x+AA, y+66) | eff[1] |
| AP, Move (units, Dominators) | (50,0), (A8,0) | next row, x+C / x+AA | base + eff |
| Range (bases) | (78,0)–(A8,18) | next row | base[2] + eff[2] |
| Cost, Soul | (0,18)–(40,30); soul icon (51,31)–(67,47) spinning 1°/frame (`uiAnimCounter(5)`) | next row | +1C, +20 |
| Keep cost (not spells) | (40,18)–(AD,30) | next row | +24 maintenance |
| Skill + 3 abilities (units, Dominators) | (50,48)–(B6,5D); icon = ability category | rows 0x20 apart | +30..+38; name in font colour 3 (yellow) when the ability is activated; "No powers " if the first is empty |
| Effect + text (spells, bases) | (C0,48)–(FC,5D); Battle (C8,6E), Enchant (C8,84) | text at (x+A, row+18), size 21 | +44; spell flags +30 / +34 |

Each value is drawn with a tens digit only when it is ≥ 10: the ones digit sits 0x12 after the
first digit position, which moves 0x12 right when a tens digit is present. Every row has an
underline (`cardInfoDrawUnderline` 0x08839368: caps (50,60)–(58,66) and (68,60)–(70,66), middle
column 0x58 stretched to width − 16).

**Stars** (`g_cardInfoStarTimer` / `g_cardInfoStarFrame`, advanced by each draw): rarity 6 cycles
three frames and rarity 4–5 two frames, changing every 9 draws; rarity 1–3 stay on frame 0.

### Ability list — `cardDrawAbilityList` (0x088210C0)

Units and Dominators only. From (x, y+0x4E), 0x56 per ability: name at x+6 (size 22, yellow when
activated), description at (x+0xD, +0x16), size 21. When the ability has a use cost or Soul (−1 = the
card's own), a Cost label, digits and the spinning Soul icon follow the name at
`x + 0x10 + (strlen(name) / 2)·0x12 + 8`.

### Attachments tab — `cardInfoDrawAttachments` (0x08820EC0)

A 3 × 2 grid of the six attachment pictures at scale 0.7, from (x+0x10, y+0x50) and
(x+0x10, y+0x98), 0x40 apart. With the cursor on: `uiDrawPointerHand` (0x0882EFEC) at
(slot x + 0x1C, slot y), rotated 135°, frame `uiAnimCounter(2)` (six frames, 4 vblanks each); the
attached card's name at (x+6, y+0xE8), size 22, and its effect text at (x+0xE, y+0x100), size 20.

## Text — `fontDrawTextScaled` (0x088390D4)

- Splits the string at `＠ｎ`, each next line `lineHeight` lower. No other markup is read (the card
  and ability texts contain only `＠ｎ`).
- `fullfontSetText` converts each ASCII byte to one full-width code (`strAsciiToSjis` 0x08878944); a
  space becomes the full-width space.
- `fullfontDraw` (0x0887851C) draws glyphs of scale (size/18)·0.8 × line/18 around the glyph centre,
  advancing `trunc(16·scaleX + charSpacing)` with `charSpacing` temporarily −5: 9 virtual pixels for
  sizes 20/21 and 10 for 22.
- Colour = font palette (`g_fontPaletteColors` 0x088F4C00): 0 white, 3 yellow (255, 252, 0); ink alpha
  0x80, 8-neighbour outline alpha 0x20.
- The line is copied into a 128-byte stack buffer; the longest card-text line is 162 bytes, so the
  game overruns it (harmless in practice). The viewer draws the whole line.

## In the viewer

- **Card list** mode is `cardInfoDrawCard`; **Map unit** mode is `cardInfoDrawUnit` for a sample unit
  whose HP, AP, DF and Move and up to six attachments (any attachable spell) can be set.
- Left/Right switch tabs, Enter enters the attachment cursor, arrows move it, Esc leaves.
- ◀ Prev / Next ▶ under the screen (or Up/Down, PageUp/PageDown while the attachment cursor is off)
  step through the card table in its current order and filter. This is a viewer convenience, not a
  game feature.
- The tabs drawn on the canvas can be clicked (`tabAt`: one 0x4C·1.2-wide slot per allowed tab at
  the position `cardInfoDraw` draws it). Also a viewer convenience; the game only uses Left/Right.
- The tables above (tab rects, icon rects, digit cells, font palettes, hand frames) are read from
  `BOOT.BIN`; the draw calls and coordinates are transcribed from the functions.
- Not reproduced: whatever the calling scene draws behind the viewer (the card-list grid and
  windows); the screen is drawn on black. The side arrows (`g_cardInfoShowArrows`) are never turned
  on by `cardInfoUpdate` and are left out.
- **Approximations**: the GAN of the flavor tab is scaled around its origin (the `AnmManager` scale
  pivot was not checked); canvas nearest-neighbour sampling stands in for the GE; the base token on
  the flavor tab is drawn although the board tokens are only loaded by the map scene
  (`cardInitSprites` from `mapInitCameras`), so in the card list the game probably shows no token
  (**inferred**).
