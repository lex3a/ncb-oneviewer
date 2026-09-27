# Camp and stage select

The camp (`campMenuScene` 0x0881AE60, scene 300) and the stage select (`stageSelectScene` 0x0881CF08,
scene 0x136), as the code does them. Everything here is **code** (Ghidra, USA EBOOT) unless marked
otherwise. Coordinates are the 640×448 virtual space; "g22" is a glyph size of 22 (`winOpenMessage`
/ `winOpenMenu` glyphW = lineH = 22). Window styles, text origins and the auto-size rule are in
[windows.md](windows.md). Play mode ports both scenes in
[`src/game/scenes/campScenes.ts`](../../src/game/scenes/campScenes.ts) on the window list of
[`src/game/winList.ts`](../../src/game/winList.ts) (see [play-mode.md](play-mode.md#camp-and-stage-select-step-63)).

The save / load that run inside the camp are in [save-menus.md](save-menus.md#12-how-the-game-saves-code),
the deck editor and card list the camp opens in [deck-editor.md](deck-editor.md), the name-entry
keyboard in [title-newgame.md](title-newgame.md).

## 1. Camp (`campMenuScene`, scene 300)

### Assets and draw

`campMenuLoadAssets` (0x0881A490): `winReset` of the ten camp windows (so every cursor starts at 0 each
time the camp is entered), etc.one 300/2 (`g_campBgSprite`, 480×272) and 300/3 (`g_campCharaSprite`,
Galahad, 448×448), and once per stay the card GANs (`g_campCardGansLoaded`).

Every frame except while loading (states 0 / 1):
1. the background at (0, 0) in screen pixels (`nativeCoords`);
2. Galahad at virtual (0xC0, 0) with colour (b, b, b, a) = the main menu window's brightness and alpha,
   so he dims with the main menu;
3. `menuWinUpdateAll` (all windows, list order).

Before the state switch (state ≠ 0) the three status frames and the unused `g_campUnusedWin4` take
the main menu's brightness: the main menu has flag 0x800 (it dims to 0x38 when another window is
last in the list), and the status frames follow it.

### Windows

| Window (Ghidra) | Opened by | Rect / text |
| --- | --- | --- |
| `g_campMainMenuWin` | state 2 | `winOpenMenu(16, 48, g22, "Search ＠ｎBuild deck ＠ｎCard list ＠ｎSystem ")` \| 0x800; w = (maxCol + 1) · 11 = 132: `msgParseNextGlyph` counts every glyph, ASCII space, full-width space and icon as a column, so the trailing space of "Build deck " counts (11 columns) |
| `g_campUnsearchedMapWin` | state 2 | `winOpenFrame(16, 168, 250, 20, 5, style 7)`, h set by the status (64 / 87 / 110) |
| `g_campRecordWin` | state 2 | `winOpenFrame(16, 0, 251, 146, 5, style 7)`, y = 448 − h − 16 |
| `g_campDeckListWin` | state 2 | `winOpenFrame(0, 0, 273, 89, 5, style 7)`, x = 640 − w − 8, y = 448 − h − 8 |
| `g_campSubMenuWin` | states 3 / 0xD | deck submenu `(16, 168, g22) "Edit ＠ｎCreate new ＠ｎCopy ＠ｎChange deck name ＠ｎDelete "` or system submenu `"Save ＠ｎLoad ＠ｎBack to title "`, \| 0x800 |
| `g_campDeckSlotWin` | state 4 | `winOpenMenu(184, 168, g22, "1.%s ＠ｎ2.%s ＠ｎ3.%s ")` \| 0x800 |
| `g_campMsgWin`, `g_campPromptWin` | messages | see below |

The deck and system submenus share **one** Window. `winOpenMenu` does nothing when the window is
still open, and a closed submenu fades out over 13 frames (`winFadeClose(…, 10)` in states 2 / 3): a
submenu reopened during that fade keeps the other menu's text, its cursor and its reduced alpha
(quirk, reproduced).

Messages are `winOpenMessage(320, 224, g22, text, 0xF000)` (auto-sized style 7, centred) with the
prompt "＠ｂ０Confirm " or "＠ｂ０Yes ＠ｂ３No " as `winOpenMessage(320, msg.y + msg.h / 2, g20, …, 0x7000)`
(centred on x, its top at the message's bottom edge). The quit question switches both to style 10 and
adds 10 to w and h, the game's usual pattern for style-10 message windows.

### Status windows (`campDrawStatusWindows` 0x0881A598)

- **Unsearched map**: the first area index i (0..9) whose block A or B is unlocked
  (`stageGetLayoutIfUnlocked`) and not cleared. Without one, i = 10, and unless stage 18 is cleared
  (clear bit 17) i is forced back to 9 (Shadow Heaven Ship). "Unsearched map " at (0, 0) g20, then
  " %s" with the area name (or "All maps cleared " for i = 10) at (−11, 0x15) g22. h = 64; +23 when
  area i + 1 has a block B: "Block B " at (0x73, 0x2C) when block A is done, else "Block A " there
  and, when B is also open, "Block B " at (0x73, 0x43) and +23 more. In the forced case the bits of
  the last loop pass are stale (0), so "Block B" shows.
- **Record**: battles and wins summed over `charaBattles` / `charaWins[0..18]`; rate = wins·100 /
  battles and two decimals floor(wins·100.0f / battles · 100) % 100 (0 and 0 without wins);
  "Number of battles: ＠ｎ%14d battles ＠ｎWinning rate: %3d, %02d ％ " at (0, 0) g20. The ASCII ","
  is a two-byte code for `msgParseNextGlyph`, so it swallows the space after it. Then
  `cardCountCollection` writes the profile's card totals and "Number of cards: ＠ｎ%16d cards＠ｎCollection
  rate: %4d ％ " (kinds·100 / 206, at least 1) at (0, 0x3F).
- **Deck list**: the three deck names at y 0, 23, 46, g22 (`sprintf(buf, name)`: the name is the
  format).

### States (`g_campMenuState` 0x0898BAF4)

| State | What happens |
| ---: | --- |
| 0 | `g_nowLoading` = 1, `campMenuLoadAssets` → 1 |
| 1 | once loaded: `campMenuOpenState(2)`, `bgmPlay(0, 0xF)` → 2 |
| 2 | `winFadeClose` of the submenu and slot list; input only once both are closed. ✕ (SE 7 for every item): Search → 0x136, Build deck → 3, Card list → 0x14A, System → 0xD |
| 3 | deck submenu (waits for the slot list's fade). ✕ → slot list, 4 (SE 7); ○ → 2 (SE 9) |
| 4 | slot list (waits for the message / prompt fade). ✕ sets `curDeckSlot` = cursor + 1 **before** any check. Create new needs an **empty** slot (name ""): else "Please create a new deck after deleting the old one." (SE 10, state 10). The others need a used slot: "There are no decks to edit." / "…to copy." / "You have not created a deck." (rename) / "There are no decks to delete." (SE 10, state 10). Edit and Create new → 0x140; Copy → 7; Change deck name → `nameEntryInit(&deck, deck.name)`, 8; Delete: fewer than two decks → "You cannot delete your only deck." (SE 10, 10), else "Is it all right to delete ＠ｎ%s? " with Yes / No (SE 7, 9). ○ → 3 |
| 7 | "Where would you like to copy ＠ｎ%s to? " (184, 48, g22, 0x3000) over the slot list (brought to front). ✕ on an empty slot copies the 24 name bytes, the 31 card ids and +0x58 / +0x5C, reopens the slot list → 4; on a used slot "There is a saved deck in the copy destination. …" (SE 10, 10). ○ → 4. The status is redrawn when leaving |
| 8 | `nameEntryUpdate(1)` every frame; the keyboard's windows join the camp's list (so the camp windows dim). −1 (△ with an empty name) → 4; 1 → the slot list is reopened with the new name → 4. `nameEntryTerm` (empty) is called in the draw part while in state 8 |
| 9 | delete question: ✕ → `sprintf(name, "")` (only byte 0 becomes NUL), the 31 card ids and +0x58 / +0x5C cleared, slot list reopened → 4; ○ → 4 |
| 10, 11 | ✕ or ○ closes the message and prompt (SE 9) → 4 |
| 0xD | system submenu: Save → 0xE, Load → 0xF, Back to title → the quit question (style 10), 0x11; ○ → 2 |
| 0xE, 0xF | `saveDataScene(SAVE_GAME / LOAD_GAME)` every frame until DONE or CANCEL, then `campDrawStatusWindows` → 0xD |
| 0x11 | "Returning to title screen. …" ✕ → 0x32; ○ → 0xD |
| 0x12 | the frame after a scene was chosen: sprites freed (the card GANs too when leaving for the stage select or the title), `winCloseAll`, `bgmStop(0)`, the scene is returned |

Leaving for a scene thus takes one extra frame (0x12), and every exit stops the BGM; the deck editor,
card list and stage select start BGM 0xF again themselves.

## 2. Stage select (`stageSelectScene`, scene 0x136)

### Assets

`stageSelectLoadAssets` (0x0881BF0C): etc.one 300/6 (`g_stageSelFrameSprite`, 128×40: "Block A" /
"Block B" labels and an arrow), 310/(i + 1)·100 for the ten areas (`g_stageSelAreaPlateSprites`,
208×70 name plates; members …01 / …02 exist but are not loaded), and for every (area, block) with a
layout id: 320/(i·100 + block + 101) (`g_stageSelPreviewSprites`, 400×240 picture of the board) and
+111 (`g_stageSelPreviewOverlaySprites`, the board's grid, 400×240), then `msgLoadFaces(0, 0)`.

### Windows

| Window | Rect / text |
| --- | --- |
| `g_stageSelAreaTitleWin` | area name (`mapFormatAreaName`), (320, 32), g24, 0xF000 (auto, centred); closed and reopened whenever the area changes |
| `g_stageSelHelpWin` | "＠ｂ０Accept ＠ｂ３Return " at (244, 402) 0x3000 (state 0), then at (244, 448 − h) (state 2), (320, 402) 0x7000 (state 3); state 7 sets its text to "＠ｂ０To camp ＠ｂ３Cancel "; ○ in state 7 reopens it as "＠ｂ０Accept ＠ｂ３Cancel " |
| `g_stageSelAreaListWin` | `winOpenFrame(4, 106, 232, 338, 0, style 7)` \| 0x10014 (menu, scroll bar, no wrap), listMode 0: the rows are the plate sprites; cursor bar at (8, 9), w 200, lineH 0x48; itemCount = the number of consecutive areas whose **block A** is unlocked (max 10), 4 visible |
| `g_stageSelBlockWin` | (4, 64, 232, 38) flag 0x800: "B%dF " (area + 1) at x 0 and "Block A/B/C " at x 100, g22 |
| `g_stageSelTerrainWin` | (list.x + w + 8, 288, 196, 112): "Total land: %5d ＠ｎEarth: %d ＠ｎWater: %d ＠ｎFire: %d Air: %d " (terrain bytes +0x0A..+0x0E), glyph 21×22 |
| `g_stageSelRecordWin` | (terrain.x + w + 4, 288, 196, 112): "No.of battles: ＠ｎ%8d battles ＠ｎNo.of wins: ＠ｎ%8d wins " (mapBattles / mapWins of the layout; layout 17 adds stage 18's) |
| `g_stageSelCharaWin` | `winOpenFrame(320, 206, 480, 196)` \| 0x4800 (centred on x, dimming); `charaDrawInfoWindow` |
| `g_stageSelFaceWin` | `winOpenFace(96, 224, 160, 160, 1002, expr 1, 0x800)` with drawStyle 0: only the face (bottom centre at (184, 376), scale 1) |
| `g_stageSelDeckWin` | `winOpenMenu(240, 64, g22, "1.%s ＠ｎ2.%s ＠ｎ3.%s ")` \| 0x800 |
| `g_stageSelConfirmWin` | "Map： %s- %s ＠ｎOpponent： %s ＠ｎDeck used： %s " at (320, 224) g22 0xE000 (auto height, centred), w forced to 350; or "Returning to camp. " at (244, 124) 0x3000 |

`charaDrawInfoWindow(id)`: x = w/2 − 48 = 192; the card name at (x, 1) g32, the deck name
(`dbGetDeckNameByDominator`) at (x, 0x21), "HP: %2d AP: %d ＠ｎMove %d " at (x, 0x38), "No.of battles:
%6d " (`charaBattles[charaGetLadderIndex(id)]`) at (x, 0x7D), all g22; the face key becomes
`charaIdToIndex(id)` + 100. `msgLoadFaces(0, 0)` filled the face cache with chara.one entry 1000
members 1..11 under keys 101..111, so this is the character's **default face** (entry 1000, member =
index); a rematch opponent (1012–1021) shows the same face as its base character. The face alpha is not reset,
so stepping through opponents swaps the face without a fade.

Dead code: `stageSelectOpenState(2)` prints " ＠ｎ ＠ｎ ＠ｎEarth / Water / Fire / Air" labels into the terrain
window, but `stageDrawMapStats` frees that window's glyphs right after, so they never show.

### States (`g_stageSelState` 0x089928EC)

Before the switch, every frame: in states 2 / 7 the area list, terrain and record windows take the
block window's brightness, otherwise the four fade out (`winFadeClose(…, 10)`); in states 2 / 7 the
character and face windows fade, otherwise the character window takes the face window's brightness;
the confirmation fades outside 5 / 6 / 7, the deck menu outside 4 / 5 / 6.

| State | What happens |
| ---: | --- |
| 0 | cursor, scroll, area, block, opponent = 0; `winReset` of the eleven windows; area title and help; `stageSelectLoadAssets`; falls into 1 |
| 1 | returns at once while the files load (no windows drawn); then `bgmPlay(0, 0xF)`, `stageSelectOpenState(2)` → 2 |
| 2 | `winUpdateInput` on the area list (no wrap). A new cursor → block 0 and the area title reopened. The block falls back to A when locked; when block B exists, **pressed** ← / → switch A / B (SE 1). The block header and `stageDrawMapStats` are reprinted every frame, the block window is brought to front. ✕: `g_mapId` = area + 1, `g_mapVariant` = block, `g_mapLayoutId` = `g_mapStageNo` = `stageGetLayoutIfUnlocked`, `g_gameMode` 1, or 2 when that stage is cleared; opponent index = stage − 1, opponent = `charaGetLadderId(stage)`; cursor / scroll saved; state 3 (SE 7). ○ → 7 (SE 9) |
| 3 | waits for the deck menu to close; the face window to front. **Free battle** (mode 2): pad-repeat → / ← step the opponent index to the next / previous **cleared** stage (SE 1 when it moved); ← with no cleared stage below walks the index down to 0 without a sound (quirk). Opponent = `charaGetLadderId(index + 1)`, `charaDrawInfoWindow`. ✕ → 4 (deck menu, SE 7); ○ → state 2 reopened (SE 9) |
| 4 | deck menu. ✕ sets `curDeckSlot` = cursor + 1 even when refused; an empty slot → SE 10; else the confirmation, 5 (SE 7). ○ → 3 |
| 5 | ✕ → 8 (SE 7); ○ → 4 (SE 9). State 6 is the same with ✕ → 4 and is never entered |
| 7 | "Returning to camp.": ✕ → camp (SE 7); ○ → 2 (SE 9) |
| 8 | (and 7 on ✕) the assets freed, `winCloseAll`, `bgmStop(0)`; for the map: `deckCopyCards(g_playerDecks[curDeckSlot − 1] → DuelPlayer 0)` with card 0 = 1001, `dbGetDeckByDominator(opponent, mode 1 ? 3 : 1)` for DuelPlayer 1, `duelSetPlayerName` of both Dominators, `g_numPlayers` 2 → 0x50 |

So there is no separate rematch menu: a **free battle** is a cleared stage, played on that stage's
board against any cleared stage's opponent (with that character's variant-1 deck). The player's
Dominator is always Galahad (1001), whatever the saved deck holds.

### Draw

States 2 / 7:
- the area plates of the four visible rows at (0xD, 0x6F + 72·row), stopping at the first area with
  neither block open; colour 0x80 for the cursor row, 0x20 for the others (all 0x20 in state 7).
  They and the block labels are drawn with `spriteDraw(…, z −0x8000, …)`: in front of the area
  list window that `menuWinUpdateAll` draws later (depth 0), so its fill and menu cursor bar stay
  hidden under the opaque plates and the selection shows only as brightness (Play mode draws them
  after the windows);
- for an area with a block B, the block labels from 300/6 in the plate's colour: "Block A"
  (0, 0)–(70, 20) at (0x22, row + 0x99) and the arrow (70, 0)–(128, 40) at (0x80, row + 0x8F); with
  block B selected, "Block B" (0, 20)–(70, 40) at (0x80, row + 0x99) and the arrow mirrored
  (anchor 0x10, scale −1: flipped in place) at (0x22, row + 0x8F);
- the preview of the area under the cursor and its grid overlay, anchor 9 + `spriteResetOffset`:
  top-left at (0xF4, 0x40), colour = the area list's brightness and alpha (the 400-px picture reaches
  x 644, past the screen edge).

States 3–6: in free battle (state 3 only) `uiDrawSideArrowsLarge(0x140, 0x150, 0, 0x200, mask, 1)`
(etc.one 2/4 cells (0xBE, 0xA0) / (0xDE, 0xA0), 32×54, at x − 32 − 256 + bob and x + 256 − bob, y − 27,
bob = `uiAnimCounter(6)`; left when index > 0, right when a higher clear bit exists); the chosen
area's preview at scale 0.5 centred on (0x140, 0x80) (anchor 0x10 + `spriteResetOffset`) with the
character window's brightness. Then `menuWinUpdateAll`.

## 3. In Play mode

- `CampScene` and `StageSelectScene` are transcriptions of the two functions: same states, windows,
  coordinates, flags, texts (read from BOOT.BIN at the addresses above), SE ids and pad reads
  (pressed vs repeat as in the code), the same assets, and the scene switches through state 0x12 /
  8 with `bgmStop`.
- `WinList` ([`src/game/winList.ts`](../../src/game/winList.ts)) is the window list both use (and the
  name-entry keyboard): list order, `winOpenMessage` / `winOpenFrame` / `winOpenMenu` (no-op when open,
  first frame without input) / `winOpenFace`, `winUpdateInput` (wrap-around with the pad repeat timer
  reset to 0x10 / 8, □ paging, SE 1, cursor flash), `winFadeClose`, `winBringToFront`, `winSetText`,
  flag-0x800 dimming and the per-frame flag clearing of `menuWinUpdateAll`.
- The keyboard in the camp shares the camp's `WinList`, so the camp windows dim under it as in the game.
  `NameEntry.init` now closes only its own windows.
- The deck editor's state 9 (a new deck is named on save) runs the same keyboard in deck mode
  (`DeckEditorSim.externalNameEntry` in Play mode; the viewer still names the deck "Deck N").
- **Approximations**: the load waits (`fileQueueWaitOrPending`) take one frame; the card GANs and
  sprites are not freed (they are cached for the run); `winOpenMenu`'s list-mode re-layout is drawn
  as one print with glyph fade 0x7F (as in the map board port); the stand-in savedata dialog darkens
  the camp behind it (ours). Nothing of the camp or stage select was compared with the real console
  yet.
