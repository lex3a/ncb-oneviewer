# Deck editor and card list

The two camp screens that show the card collection: the **deck editor** (`deckEditScene` 0x0882ADB8,
scene 0x140) and the **card list** (`cardListScene` 0x0882C4FC, scene 0x14A). They share their draw
functions, which take the scene id as a `mode` argument (0x140 or 0x14A). Everything here is **code**
(Ghidra, USA EBOOT) unless marked otherwise. The viewer reproduces both under **Card database → Deck
editor** ([`src/effect/deckEditor.ts`](../../src/effect/deckEditor.ts),
[`src/components/DeckEditorView.tsx`](../../src/components/DeckEditorView.tsx)). Deck rules are also
summarised in [save-menus.md](save-menus.md#25-deck-edit-0x140-and-card-list-0x14a).

Coordinates are the 640×448 virtual space (see [card-screen.md](card-screen.md#coordinates-and-sprites)
for `spriteDraw2D`). All sprites here use the 2D-sorted camera with depth 0, so the GE depth test
(GEQUAL on z 0x7FFF) lets later draws win: **the draw order is the code order**. Texture filtering is
bilinear (`guInitDisplay` calls `sceGuTexFilter(1, 1)`).

## Functions and globals

| Name | Address | Role |
| --- | --- | --- |
| `deckEditScene` | 0x0882ADB8 | logic (state machine below), then the draw calls |
| `cardListScene` | 0x0882C4FC | the same for the card list; its state bytes are separate (0x089AFB10 state, +1 view, +2 col, +4 row) |
| `deckEditLoadDeck(slot)` | 0x08827FE4 | clears the counts and the list, copies `g_playerDecks[slot−1].cards[1..30]` into `g_deckEditCards[1..30]` and counts them |
| `deckEditRebuildList()` | 0x088283C8 | rebuilds `g_deckEditCards[1..]` sorted by card number from the counts, recounts; returns count + 1 (`g_deckEditNextSlot`) |
| `deckEditSaveDeck(slot)` | 0x08828174 | writes the cards in card-number order into the slot (consumes the counts; the rest of the slot is not cleared) |
| `deckCopyCards` | 0x08828240 | copies a 31-entry deck list (stage select, not used here) |
| `deckGridPosToCardNo(pos, filter, mode)` | 0x08829D3C | grid position → card number; deck editor: only owned cards occupy positions, 0 past the end; card list: range start + pos |
| `deckUpdateHelpWin` | 0x08829098 | opens and fills the button-help window |
| `cardDrawNameAbilityWindow` | 0x088288F0 | the name and ability-name windows |
| `deckDrawFrame` | 0x08829658 | top bar, view tabs, deck name, filter selector, card count |
| `deckDrawDeckGrid` | 0x08829E14 | deck view: 2 of 7 rows × 6 |
| `deckDrawCardGrid` | 0x0882A258 | collection view / card list: 3 rows × 10 |
| `cardDrawStatPanel` | 0x08828BD8 | AP/HP/Move (Range), Cost, Soul, Keep cost over the name window |
| `deckDrawTypeCounts` | 0x08828594 | Unit / Spell / Base counts |
| `uiDrawDigit` | 0x08839694 | number font digit (etc.one 2/1, style 0 cells 18×24 at (18·d, 40); 11 = "/") |
| `uiDrawNewBadge` | 0x088398A8 | the New / Get badge |
| `uiDrawSideArrows` | 0x08839C80 | the bobbing ◀ ▶ around the filter |
| `uiDrawPointerHand` | 0x0882EFEC | the pointing hand (etc.one 2/2, 48×32 frames) |
| `cardPicDrawScaled` / `cardPicDrawDimmed` | 0x0881F248 / 0x0881F65C | card pictures (below) |
| `uiAnimCounter(mode)` | 0x08848E7C | shared UI animation counters (below) |

| Global | Address | Content |
| --- | --- | --- |
| `g_deckEditCardCounts` | 0x089AF7D4 | u8[207], copies in the edited deck per card number |
| `g_deckEditCards` | 0x089AF8A4 | s16[43], [1..42] the edited list (7 rows × 6) |
| `g_deckEditNextSlot` / `g_deckEditPickCount` | 0x089AF8FA / 0x089AF8FB | count + 1 / the count popup value |
| `g_deckHelpCardId`, `…DetailPage`, `…CardCount` | 0x089AFB00 / 04 / 05 | help-window refill cache |
| `g_deckGridScrollRow` | 0x089AFB06 | first visible deck row |
| `g_cardGridScrollRow` | 0x089AFB08 | u8, first visible collection row (shared by both scenes) |
| `g_deckEditState` / `View` / `Filter` | 0x089AFB09 / 0A / 0B | state 0–11, view (0 none, 1 deck, 2 collection, 4 switching), filter 0–3 |
| `g_deckEditCursorCol` / `Row` | 0x089AFB0C / 0E | cursor |
| `g_deckWinMsg`, `TypeCount`, `Help`, `Menu`, `Info`, `Top` | 0x08A1B354 + 0xA4·i | the six windows (`Top` is not used by these scenes) |
| `g_deckTypeLabelUV` | 0x088B831C | u8 [4][2]: (72,160) (0,160) (0,182) (72,182); entries 1–3 = Unit, Spell, Base |
| `g_deckFilterLabelUV` | 0x088B8548 | the same bytes: filter 0 All, 1 Unit, 2 Spell, 3 Base |
| `g_attributeIconStrings` | 0x088B8398 | 13 × "＠ｍNN" |

**Card numbers** (`cardIndexToId` order): units 1–122, spells 123–190, bases 191–206. Owned counts and
NEW flags are `PlayerProfile.cardCount` / `cardNewFlags` by card number (0x089D184C + 0x1C / + 0xEB).

## Sprites

| Sprite | Source | Content |
| --- | --- | --- |
| `Sprite_0898b4e8` | etc.one 300/1 (deck editor) or **300/7** (card list), 256×256 | top-bar tile (0,0)–(64,60); bottom panel (64,0)–(185,57) "Deck" (300/7: "Number"); "Change" (192,0)–(248,24); name plate (0,64)–(242,99); filter box halves (0,99)–(79,149) and (137,99)–(216,149); labels 72×22 at the UV tables; □ button 32×32 at (160 + 32f, 160); cursor corner (0,208)–(23,231); count popup (176,208)–(256,240) |
| `Sprite_089af8fc` | etc.one 300/5, 256×128 | view tabs "Deck" (0,0)–(128,128), "Album" (128,0)–(256,128) |
| `g_cardPicSprites[no]` | card.one 10000/<card id> (0 → 1000, the blank card back), 48×50 | loaded by `cardPicResetAll(1)` → `cardPicLoadRef` (size 0) |
| `Sprite_089b51e8` | etc.one 2/3, 64×48 | badge row 0 "New", row 1 "Get" |
| `g_cardInfoUiSprite` | etc.one 2/4 | stat labels, side arrows (0,48)–(32,102) / (32,48)–(64,102), Soul icon |
| `g_uiNumberFontSprite` | etc.one 2/1 | digits |

**Card pictures.** `cardPicDrawScaled(id, x, y, z, scale)`: anchor 9 (top-left), colour 0x80, scale
`scale · 80 / width` where a 48-px-wide picture counts as 40 (the card art is 40 px wide inside the
48-px image). So scale 1.0 draws the picture 80×100 (96-px quad), 0.7 → 56×70, 0.8 → 64×80.
`cardPicDrawDimmed(id, x, y, z, pct)` is the same with scale pct/100 and colour (0x40, 0x40, 0x40, 0x80).
Character cards (1000–1999) and 0 draw the blank card.

**`uiAnimCounter`** (mode 0 advances everything once per frame): 1 = 0..21 bouncing ±1 (−1 at the
bottom turn); 2 = frame 0..5 (4 frames each: pointer hand); 5 = angle −180..180 (Soul icon); 6 = −13..13
bouncing, returned halved toward zero (side arrows); 7 = 0/1, toggling every 16 frames (□ button).

## Screen layout

In draw order (after the scene logic, only while `view` ≠ 0):

### `deckDrawFrame(cardId, mode, state, filter, view)`

1. Top bar: tile (0,0)–(64,60) at x = 0, 64, … 576, y 0 (anchor 9, scale 1).
2. Deck editor only: in states 4/5 "Album" (bright) at (16, 0) and "Deck" (colour 0x40) at (80, 0); in
   states 2/3 "Deck" bright at (16, 0) and "Album" dim at (80, 0) (so the active view is always the left
   tab), scale 0.5. In states 2/4 also the □ button frame `uiAnimCounter(7)` at (80, 8) and "Change" at
   (112, 16).
3. Bottom panel (64,0)–(185,57) at (0, 384).
4. Deck editor: name plate at (192, 14); the deck name (`g_playerDecks[slot−1].name`) with
   `fontDrawTextScaled` at (200, 22), size 22 (not in states 6/7). View 2: filter box halves at (458, 7)
   and (537, 7), the filter label at (501, 27), and in state 4 `uiDrawSideArrows(537, 32, 0, 80, 3, 1)`:
   left arrow at (x − 32 − 40 + a, 5), right arrow at (x + 40 − a, 5), a = `uiAnimCounter(6)`.
   Then "N/30": N = non-empty entries of `g_deckEditCards[0..42]`, tens at (15, 409) only when ≥ 10,
   ones at (33, 409), "/" (51), "3" (69), "0" (87).
5. Card list: the owned count of the card under the cursor (max 99), tens at (33, 409) when > 9, ones
   at (51, 409).

### `deckDrawDeckGrid` (view 1)

- Scroll: row 0 → scroll 0; otherwise the cursor row stays in the two visible rows (scroll = row − 1
  when it moves below, = row when above).
- Cards `g_deckEditCards[scroll·6 + 1 …]` at x = 32 + 96·c, y = 68 + 108·r, `cardPicDrawScaled(…, 1.0)`
  (empty slots show the blank card).
- Cursor: four corners (0,208)–(23,231) with **anchor 0x10** (pivot (11, 11)), scale (±1, ±1) at
  (x, y), (x + 57, y), (x, y + 77), (x + 57, y + 77); the pointer hand at (x + 32, y) rotated 135°.
- State 3: the popup (176,208)–(256,240) at (x, y + 100) when the cursor is on the top visible row,
  else (x, y − 32); digits pick, "/", min(owned, 3) at x + 13, 31, 49 and y + 104 / y − 28.
- Debug leftover: START prints the deck list with `printf`.

### `deckDrawCardGrid` (view 2 and the card list)

- Last card number: filter 1 → 122, 2 → 190, else 206. Scroll keeps the cursor row within 3 rows.
- First card: deck editor `deckGridPosToCardNo(scroll·10)`; card list `scroll·10 + 1`.
- Cells at x = 16 + 60·c, y = 64 + 74·r. Deck editor: unowned cards are skipped (take no cell). Card
  list: unowned cards take a cell and show the blank card, dimmed.
- Deck editor greying: dimmed when the deck already holds 3 copies or all owned copies; else scale 0.7.
- Badges: `pCardNewFlags` bit 1 → "New" (row 0), else bit 0 → "Get" (row 1), via
  `uiDrawNewBadge(trunc(x + 28 − 32), trunc(y + 64.4 − 24), 0, 70, 70, kind)`: 64×24, centre pivot,
  scale (70 + `uiAnimCounter(1)`)/100 (0.69–0.91).
- The cursor card is drawn last at (x − 4, y − 5), scale 0.8 (dimmed by the same rule), with its badge
  at the unshifted position, and four corners with **anchor 9** (pivot (0,0)) at (x', y'), (x' + 64, y')
  flipped X, (x', y' + 80) flipped Y, (x' + 64, y' + 80) flipped both. No pointer hand.
- State 5: the popup at (x' − 8, y' − 32) when the cursor is on the third visible row, else (x' − 8,
  y' + 80); digits at +13, +31, +49, popup y + 4.

### Windows (`menuWinUpdateAll`, in list order)

All are style 10 (framed, skin 13) with default fill; chamfer 16 for `winOpenFrame` windows and 5 for
`winOpenMessage` ones. `winPrintAt` text is laid out at once at (15, 15) + (x, y) with fade step 0x7F.

| Window | Rect | Content |
| --- | --- | --- |
| Help | (363, 380, 277, 68), tail 4 (transparent in the data) | states 2/4 (reprinted every frame): "＠ｂ０Confirm" (0,0), "＠ｂ１Card details" (114,0), "＠ｂ３End" (0,19), "＠ｂ２Change view" (114,19); card list "＠ｂ０＠ｂ１Card details" / "＠ｂ３To camp". States 3/5: "＠ｐ１１＠ｐ１２Change" (0,0), "＠ｂ０Decide" (133,0), "＠ｂ３Cancel" (133,19). State 7 by card-screen tab: 1 → "＠ｐ１３Special Powers" / "＠ｐ１４Comments" (non-units "＠ｐ１３＠ｐ１４Comments"), 4 → "…Basic powers" / "…Special powers", 8 → "＠ｐ１３Comments" / "＠ｐ１４Basic powers". Size 18. |
| Type count | (117, 380, 246, 68) = left of the help window | closed in states 6, 7, 9; opened in views 1–3 |
| Info | (0, 285, 434, 95) | card name (size 20) at (0, 0), attribute/category icon string at (252, 0) size 16; only for owned cards; closed in 6, 7, 9 |
| Menu | (434, 285, 206, 95) | units and Dominators: up to 3 ability names (size 20, line 22, 22 apart; yellow = activated); stops at the first empty one after the first ("No powers" shows for none) |
| Msg | centred at (320, 224), auto size + 10 | state 8: "Please prepare 30 cards for the deck." (< 30), "30 cards will fit into the deck." (> 30), or at 30 "What would you like to do with the edits to the deck? ＠ｎ ＠ｂ０Apply edit ＠ｎ ＠ｂ３Return to deck edit ＠ｎ ＠ｂ１Cancel and return to camp"; size 22, fade step 4 |
| Help (state 8, not 30) | top-left (320, 250), auto size + 10 | "＠ｂ０Confirm ＠ｂ１End", size 18 |

The name and ability texts are freed and reprinted every frame (so their glyphs always show the
first-frame alpha, 0x7F).

### `cardDrawStatPanel` (not in states 0, 1, 7; owned cards only)

Origin (x, y) = (info.x + 15, info.y + 15) = (15, 300); labels from etc.one 2/4, values `"%2d"` with
`fontDrawTextScaled` size 20:

| Item | Label rect | Label at | Value at |
| --- | --- | --- | --- |
| AP (not spells) | (80,0)–(120,24) | (x, y + 20) | (x + 44, y + 24) |
| HP (not spells) | (0,0)–(40,24) | (x + 84, y + 20) | (x + 128, y + 24) |
| Move (units) / Range (bases) | (168,0)–(216,24) / (120,0)–(168,24) | (x + 168, y + 20) | (x + 218, y + 24) |
| Cost | (0,24)–(64,48) | (x, y + 46) | (x + 68, y + 50) |
| Soul (if > 0) | icon (81,49)–(103,71), centre pivot, rotating `uiAnimCounter(5)`° | (x + 108, y + 46) | (x + 134, y + 50) |
| Keep cost (not spells) | (64,24)–(173,48) | (x + 190, y + 46) | (x + 303, y + 50) |

### `deckDrawTypeCounts`

Inside the type-count window at (x, y) = (win.x + 15, win.y + 15), three columns 72 apart: the label
(72×22 from `g_deckTypeLabelUV[1..3]`) at (x, y) and the count right-aligned with its last digit at
(x + 46, y + 22). Deck editor: copies in the edited deck by type (card id / 1000: 0 unit, 2 spell, 3
base); card list: number of **distinct** owned cards.

### Card details (states 6/7)

`cardInfoDrawCard(cardId)` is drawn last, over everything, without clearing ([card-screen.md](card-screen.md));
the frame, grid and help window stay visible around it. `cardInfoUpdate(cardId, 3)`: ←/→ tabs, ○ closes
(tab reset to 0, so the next card opens on the status tab).

## State machine (`deckEditScene`)

Pad bits: ↑ 0x10, → 0x20, ↓ 0x40, ← 0x80, L 0x100, R 0x200, △ 0x1000, ○ 0x2000, ✕ 0x4000, □ 0x8000,
SELECT 1. Arrows use `padGetRepeat`, buttons `padGetPressed`.

| State | Meaning | Input |
| ---: | --- | --- |
| 0 | load sprites, `deckEditLoadDeck(curDeckSlot)`, cursor/filter/view 0, rebuild | → 1 |
| 1 | wait for the file queue, BGM 0 | → 2 |
| 2 | deck grid (view 1) | ←/→ wrap 0..5; ↓ while (row + 2)·6 < 43 (rows 0–6); ↑ while row > 0. ✕ on a card → 3 (pick = its count); △ on a card → 6; □ → collection (view 4 for one frame, state 4, cursor 0); ○ → 8; SELECT rebuilds |
| 3 | count popup (deck) | ↑ +1 while pick < 3, pick < owned and pick + (count+1 − its count) < 43; ↓ −1; ✕ sets the count and rebuilds → 2; ○ → 2 |
| 4 | collection grid (view 2) | n = owned cards in the filter range. ←/→ wrap 0..9, clamped to n (← from 0 on the last row goes to (n mod 10) − 1); ↑/↓ within ⌊(n + 9)/10⌋ rows. L/R filter −1/+1 (wraps, cursor 0). ✕ on an owned card → 5; △ → 6; □ → deck view (state 2); ○ → 8 |
| 5 | count popup (collection) | as 3, → 4 |
| 6 | `cardPreviewSetCard` → 7 | |
| 7 | card details | `cardInfoUpdate`; −1 → 2 or 4; while open, L/R move to the previous/next card: deck view = the previous/next **different** card id, collection = the previous/next position (then back to 6) |
| 8 | end prompt | total = 1 + all copies. Total 31 (30 cards): ✕ → 10, ○ → back, △ → 11. Otherwise: ✕ or ○ → back, △ → 11. An empty deck name opens name entry (9) before saving |
| 9 | `nameEntryUpdate(1)` | cancel → back, OK → 10 |
| 10 | `deckEditSaveDeck` → 11 | |
| 11 | close the six windows, free sprites → camp | |

So the edited deck may temporarily hold up to **42** cards (the 7 × 6 grid), 3 copies per card at
most and never more than owned; only exactly 30 can be saved.

## `cardListScene`

States 0 → 1 (load, etc.one 300/7) → 4 (view 3). State 4: ←/→ wrap 0..9 (the last row, 201–206, has
columns 0–5), ↑/↓ over rows 0–20; ✕ or △ on an owned card → 6/7 details (L/R: previous/next **owned**
card); ○ → 11 (camp). There is **no filter** in the card list (it always passes 0), and it shows all
206 cards, unowned ones as dimmed blank cards. The help window shows "✕△ Card details / ○ To camp".

## In the viewer

- **Card database → Deck editor**: both scenes at 480×272, shown 2× (`image-rendering: pixelated`). The
  scene logic is `DeckEditorSim.frame` (one call per 60 Hz frame with the pad bits), the drawing
  `DeckEditorRenderer` (WebGL, the same GE-style vertex math as the windows) with `WindowPainter` for
  the windows; the card details are `CardScreenRenderer` on a canvas stacked on top.
- Keys: arrows = D-pad, X / Enter / Space = ✕, O / Esc / Backspace = ○, T = △, S = □, Q / PageUp = L,
  E / PageDown = R (keyboard auto-repeat stands in for `padGetRepeat`). On-screen buttons do the same.
  A click on a grid card moves the cursor there, a click on the cursor card is ✕ (viewer convenience).
- Collection: a decrypted `CADATA.SAV` (owned counts, NEW flags, the three decks, `curDeckSlot`), or
  samples: every card ×3, or a new game (only the starter deck, `g_deckDefs` of Galahad). The samples
  set a few NEW / Get flags (card number divisible by 11 / 7) so the badges show; this is not game data.
- Editing works in memory with the game's limits; ✕ on "Apply edit" saves into the slot and the scene
  restarts (the game returns to the camp there). "Export deck JSON" writes the deck being edited.
- The tables (label UVs, attribute strings, help and message strings, hand frames, digit cells) are
  read from BOOT.BIN; the positions are transcribed from the functions.
- **Approximations**: in the viewer the name-entry keyboard (state 9) is skipped (an empty name becomes
  "Deck N"); Play mode runs it (`nameEntryUpdate(1)`, the keyboard over the editor, then state 10);
  winPrintAt text with a line height different from its glyph size (the
  ability names, 20/22) is drawn with 20/20, 1 px shorter; the pad repeat rate is the keyboard's; the
  file queue is instantaneous, so the one-frame loading states pass at once.
