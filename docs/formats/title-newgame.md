# Boot, movies, title screen and new game

How the game gets from power-on to the first battle: the boot scenes and PMF movies of `main`, the
title screen `titleScreenScene`, and the new game `newGamePrologueScene` with the name-entry keyboard.
Everything is **code** (Ghidra, USA EBOOT) unless marked. Play mode runs all of it (step 6.2 of
[open-questions.md](open-questions.md#6-play-mode-the-whole-game-in-the-browser)); code in
[`src/game/scenes/movieScenes.ts`](../../src/game/scenes/movieScenes.ts),
[`src/game/scenes/titleScenes.ts`](../../src/game/scenes/titleScenes.ts) and
[`src/game/nameEntry.ts`](../../src/game/nameEntry.ts).

Coordinates are the 640×448 virtual space unless a sprite has `nativeCoords` (480×272 screen pixels).

## 1. Boot and movies (`main` 0x088477D4)

| Scene | What main does | Next |
| --- | --- | --- |
| 0 BOOT | `sndSysInit`, `at3StreamInit`, `menuWinSysInit`, `titleScreenReset`, sprites, `msgEventInit`, `saveSysInit`, `movieInit` | 10 |
| 10 MEMORY_CARD | `saveDataScene(−1)` returns 1 at once; `moviePlayFile("LOGO.pmf")` in the same frame sets `g_moviePlaying` | 0x14 |
| 0x14 LOGO | `movieUpdate` until the movie ends; START stops it once `g_movieFrameShown` is set (the first frame was drawn). Then `movieShutdown`, `movieInit`, `moviePlayFile("OP.pmf")` | 0x1E |
| 0x1E OPENING | the same loop; when `g_moviePlaying` is false: `movieShutdown` | 0x32 |
| 0x28 / 0x29 | `movieInit`; stage 15 is rewritten to 16; `moviePlayFile("ED000.pmf" / "ED001.pmf")` | 0x2A |
| 0x2A | the same loop, then `movieShutdown` | 0x834 |

- There are only four `moviePlayFile` calls. **There are no image logos**: the publisher / developer
  logos are LOGO.pmf (16 s: the Yuke's logo, **data**); OP.pmf is the 99 s opening.
- **The endings are the staff credits** (ED000 / ED001, 90 s each, **data**: "CREDITS / IDEA FACTORY /
  Producer …" over artwork). This is why the unreachable `staffRollScene` has no credits text of its own
  ([extras.md](extras.md)).
- Skip rule: START (`0x8`, `padGetPressed(0)`) and `g_movieFrameShown == 1`. No other button skips.
- A movie that cannot be opened (`moviePlayFile` fails) leaves `g_moviePlaying` false, so its scene ends
  on the next frame.
- The movie scenes neither start nor stop the BGM. The stage-clear events of 15 and 18 do stop it
  themselves: both scripts end with cmd 23 (`bgmStop(0)`) right before cmd 8 (**data**: records 53 and
  57), so the endings play without BGM.
- The title's attract timeout returns 0x1E, but nothing starts OP.pmf then (only the LOGO scene does):
  0x1E sees `g_moviePlaying` false, shuts the idle player down and returns to the title, which reloads
  (state 0). See §2 for why the timeout never happens on the console anyway.

### Play mode

`GameState.movie` is `g_moviePlaying` (with the file name). The PMF is converted to MP4 with
ffmpeg.wasm (`convertPmf`: H.264 copied, the ATRAC3plus audio extracted, decoded and re-encoded to AAC;
[media.md](media.md#moviepmf-psmf)) once per session and kept as a blob URL
([`src/game/movies.ts`](../../src/game/movies.ts)); a `<video>` element over the screen layers plays it
at 480×272. The MEMORY_CARD scene starts converting LOGO.pmf and OP.pmf (ffmpeg runs one job at a
time, so OP converts while the logo plays), the stage-clear event of 15 / 18 starts ED000 / ED001.
While a movie is still converting the screen is black with a small "Converting …" line, and START
skips that wait (both ours: the game has no wait). If the file is missing or ffmpeg fails, the movie
is skipped like a failed `moviePlayFile` (the reason goes to the console and the debug overlay). The
movie's volume follows Play mode's master volume and mute. Measured in headless Chrome: LOGO converts
in about 1 s, OP, ED000 and ED001 in 1–3 s each (after the 31 MB ffmpeg core is loaded).

## 2. Title screen (`titleScreenScene` 0x08867528, scene 0x32)

Images (etc.one entry 10): **10/1** 480×272 title picture (`nativeCoords`), **10/2** 192×160 menu words
in five 32-px rows: *New Game, Load Game, Resume Game, Versus Mode, Option*.

| State (`g_titleState`) | Frame |
| --- | --- |
| 0 | load 10/1 and 10/2, **`profileInitNewGame`**, `winCloseAll` |
| 1 | idle timer 0, `bgmStop(0)` |
| 2 | when the file queue is empty: **`srand(g_saveHeader.dwPlayTime)`** (the game's only `srand`; the play time never advances, so the seed is 0), `bgmPlay(0, 0xE)` (BGM_15), "just started" flag |
| 100 | the menu (below) |
| 300 | returns `g_titleResult`, back to state 0 and cursor 0 |
| 400 | returns −1 (attract timeout), back to state 0 |

State 100:
- ↓ / ↑ on the pad **repeat** move the cursor 0..3 with wrap-around (SE 1). ✕ (pressed) sets the result
  cursor + 1 (SE 7) → 300.
- Results, as main maps them: 1 New Game → `bgmStop`, 500; 2 Load Game → `sceneSetSaveReturn(300, 0x32)`,
  `bgmStop`, 0x44C; 3 Resume Game → `bgmStop`, 0x208; 4 Versus Mode → `bgmStop`, 600; −1 → 0x1E.
- **No "Press START" step, no condition on Resume Game / Load Game.** All four words are always there;
  `resumeTempSaveScene` and the savedata dialog deal with missing data. The fifth word "Option" is cut
  off by the source rect (the game has no options).
- Idle timer: any repeat input sets it to 900; it counts down by one per frame.
- **Attract timeout**: only tested when `bgmIsPlaying()` is false. If the "just started" flag is set
  (the stream thread has not started yet) the BGM is restarted; else an idle timer of 0 → state 400,
  otherwise the timer is cleared and BGM 0xE restarted. `bgmIsPlaying` is the AT3 thread's PLAYING
  flag, which is set when the thread starts and cleared only when the stream stops; every BGM loops
  forever ([story.md §4.1](story.md#41-bgm-looping-code--data)). **So on the console the title never
  times out**, and if it did, 0x1E would play nothing (§1).
- Draw (states 100 / 200): 10/1 at (0, 0) in screen pixels; 10/2 rect (0, 0)–(176, 128) at (0x100, 0x100)
  (virtual: 132×78 screen pixels at (192, 155)); `uiDrawPointerHand(0xD0, 0x100 + 32·cursor)` with
  rotation 0 (etc.one 2/2, a 48×32 frame `uiAnimCounter(2)`). Its anchor 0x10 only moves the pivot
  (the rotation / scale centre) to (24, 16): `spriteSetAnchor` → `spriteSetPivot` keeps the quad where
  it is, and the sprite's offset is 0, so **the frame's top-left is at (0xD0, 0x100 + 32·cursor)**: the
  hand spans x 208–256 (screen 156–192, its tip just left of the words at 192) and exactly the 32-px row
  of the word. (Play mode centred it on that point until 2026-09-27, half a row too high and 24 px too
  far left; the user's console screenshot showed the real position.) Nothing is drawn in states 0–2.
- State 200 (a 2- or 3-item submenu, `g_titleItemCount`, ○ back to 100) and state 0x32 (`fullfontFrameTick`)
  are dead: nothing writes 200 or 0x32. `titleScreenReset` sets the item count to 3; only state 200
  reads it. `g_titleUnusedCounter` (0x08B3D6DC) is decremented and never read.

Play mode (`TitleScene`): the same states and draws. `bgmIsPlaying()` is "a track is requested"
(`AudioManager.bgm`), which is true from `bgmPlay` on, as the thread's flag is. Versus Mode leads to a
stub scene (600) that says versus play comes with WebRTC (step 6.6) and goes back to the title.

## 3. New game (`newGamePrologueScene` 0x08835654, scene 500)

| State (`g_newGameState`) | |
| --- | --- |
| 0 | `menuFullscreenBg(500, 0, 2)`: etc.one **20/1** (480×272 backdrop, `nativeCoords`); `nameEntryInit(&g_playerProfile.name, "")` |
| 1 | wait for the file queue |
| 100 | `nameEntryUpdate(0)`: −1 → backdrop freed → title; 1 → backdrop freed, `g_gameMode` 1, `g_mapLayoutId` 0, `msgEventReset` |
| 200 | when loaded: `msgEventStart(ctx, 0, 0, 0, 0)` (the prologue) |
| 300 | `msgEventUpdate` until 1 |
| 9000 | decks `dbGetDeckByDominator(1001, flags 1)` / `(1004, flags 3)`, the Dominators' names |
| 9999 | stage 1, layout 1, map 1 block A, mode 1, 2 players → 0x50 |

Each frame the backdrop is drawn while loaded (so the prologue runs on black), then `menuWinUpdateAll`
(the name-entry windows) or `msgEventDraw` while an event is active. There is no BGM during the name
entry (main stopped it when leaving the title).

## 4. Name entry (`nameEntryInit` / `nameEntryOpenWindows` / `nameEntryUpdate`)

Struct `NameEntry` (0x550, `g_nameEntry`): `pDest` (the destination char[24]), state, `retState`,
`keyCol` / `keyRow` / `keyScroll`, `savedKanjiPos`, `cursorPos`, `nameLen`, `name[24]`, `nameOrig[24]`,
`work[128]`, `keyboardPage`, seven windows (name, prompt, keyboard, win3 (unused), help, confirm,
confirmOpt).

**Texts** (BOOT.BIN): 0x088DB9A4 "Please input your name. ＠ｎThis name will be displayed for VS mode
and save data. ", 0x088DB8FC "Please input your name. " / 0x088DB918 "Please input deck name. ",
0x088DB934 "＠ｂ０Enter ＠ｂ２Delete ＠ｂ１Return ＠ｂ１１Accept ＠ｎ＠ｂ７Move cursor left ＠ｎ＠ｂ９Move cursor
right ", 0x088DB9F8 "＠ｂ０Confirm ", 0x088DBA08 "You have not entered a name. ", 0x088DBA28 "The name you
entered is   ＠ｎ“%s” ＠ｎIs that all right? " (deck: 0x088DBA68 "The name of the deck is …"),
0x088DBAA8 "＠ｂ０Yes ＠ｂ３No ".

**Keyboard pages** (`g_nameEntryPages` 0x088D7034, 4 pointers; each page = 6 rows of 38 bytes: a
4-byte tag (＠－ for the first row, ＠ｎ for the others) and 17 two-byte cells). Page 0 hiragana, 1 katakana,
**2 full-width Latin**, 3 kanji index (whose cells open the 76 sub-pages of 0x088DB6F8, state 3).
`nameEntryInit` sets page 2 and **nothing changes it**, so the USA game only shows page 2:

```
１２３４５　６７８９０　＋－×÷＝
ＡＢＣＤＥ　ＦＧＨＩＪ　ＫＬＭＮＯ
ＰＱＲＳＴ　ＵＶＷＸＹ　Ｚ∽♂♀♪
ａｂｃｄｅ　ｆｇｈｉｊ　ｋｌｍｎｏ
ｐｑｒｓｔ　ｕｖｗｘｙ　ｚ　！？．
(row 5: all full-width spaces)
```

**Windows** (`nameEntryOpenWindows`; all style 10, alpha 0 at first):
- prompt at (0, 8), size 22, flags 0x3000 (sized to the text), +10 / +10;
- name box `winOpenFrame(8, prompt.y + h, 321, 54)`, x = 320 − w/2; `winPrintAt(8, 1, 24)` the name and
  `winPrintAt(8, 12, 24)` the caret line `g_nameEntryCaretStrs[cursorPos]` (0x088DB8C4: n half-width
  spaces + "−"; entry 11 = entry 10) — narrow text, 12 px per character;
- help at (320, 448 − h), size 20, flags 0x7000 (centred on x);
- keyboard `winOpenFrame(0, 180, 480, 180)`, flag 0x800 (dimming), x = 320 − 240;
  `winPrintAtEx(0, 0, 24, 24, narrow 0)`: full-width layout (advance 25, line 26, scale 24/18) and the
  rows go through `msgParseNextGlyphRaw` (after ＠－), where a full-width space advances a whole cell.
  Menu cursor (flags 0x14: bar + scroll bar) at (12 + 25·col, 10 + 26·row), cursorW 0x30, 6 rows.
- Every frame of states 2–5 `winApproachPos` (1/8 of the way, alpha +8) moves prompt → (0, 8), name →
  (0, prompt.y + h), help → (320, 448 − h), keyboard → (95, 448 − help.h − kb.h); the others copy the
  keyboard's brightness, so while a confirmation window is last in the list the whole screen dims to 0x38.

**States of `nameEntryUpdate`** (SE ids at the end of the frame):

| State | Input |
| --- | --- |
| 0 → 1 | (player name) the intro message at (320, 224), size 22, centred, and "Confirm" under it; ✕ → the keyboard windows → 2 (SE 7). A deck name goes straight to 2 |
| 2 | START (SE 7): empty name → "You have not entered a name." + Confirm → 5; else the "%s" question + Yes / No → 4. L / R move the caret (SE 1). ✕ inserts the key at the caret (SE 7): caret 11 → 10, the characters from the caret shift right (the 11th is lost), caret and length +1 up to 11. □ deletes (SE 9): the character at the caret when the caret is inside the name (the rest shifts left), else the one before it. △ clears the name → 6 → returns −1 (back to the title) (SE 9). ↑↓ / ←→ (repeat) move over rows 0–5 / columns 0–16 with wrap-around, skipping full-width-space cells (SE 1). ○ does nothing |
| 3 | kanji sub-page (unreachable in the USA game) |
| 4 | ✕ `sprintf(pDest, "%s", name)` → 6 (SE 7); ○ back to 2 (SE 9) |
| 5 | ✕ back to 2 (SE 7) |
| 6 | `winFadeClose(10)` on all windows; when all are closed: 1 if the name is not empty, else −1 |

Limits: 11 full-width characters (22 bytes + NUL in char[24]); only the characters of page 2 can be
typed; there is **no default name** (`nameEntryInit(&name, "")`; START on an empty name is refused).

Play mode (`NameEntry` + `WinList`): the states, cursor rules, buffer shifts, windows, positions,
slides, fades and dimming as above, with the texts and pages read from the disc. The name goes into
`PlayerProfile.name` as Shift-JIS bytes (the bytes after the NUL stay, like `sprintf`). The deck-name
mode (1) is ready for the camp's deck submenu (step 6.3).

## 5. What is approximated

- The movie decoder: MP4 via ffmpeg.wasm instead of the PSP's `sceMpeg`; the AAC re-encode (160 kb/s)
  is lossy; the conversion wait and its START skip are ours.
- `bgmIsPlaying` is "a track is requested": a track whose file cannot be loaded still counts as playing
  (on the console a failed stream would clear the flag, and the title would restart the BGM every frame).
