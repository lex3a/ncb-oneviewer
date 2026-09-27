# Play mode

Play mode runs the game in the browser from the ports described in the other documents. The app is
shipped **without any game data**: the player loads their own disc image (the whole ISO, the
`PSP_GAME` folder, or single files) and presses **▶ Play** in the top bar. Play mode then covers the
window. The viewer underneath keeps its state, and **Exit** returns to it.

This document describes the game shell (step 6.1 of [open-questions.md](open-questions.md#6-play-mode-the-whole-game-in-the-browser)),
the progression and saves (step 6.4) and, briefly, the boot / title / new game (step 6.2, detailed in
[title-newgame.md](title-newgame.md)) and the camp / stage select (step 6.3, detailed in
[camp-stage-select.md](camp-stage-select.md)):
- the loop and the scene machine of `main`;
- the shared state;
- input and audio;
- how the existing ports plug in;
- rewards, counters and unlocks;
- saves (game data, continue data) in `localStorage`;
- what is still a placeholder.

Code: [`src/game/`](../../src/game) and [`src/components/PlayView.tsx`](../../src/components/PlayView.tsx).

## Architecture

| Module | Role |
| --- | --- |
| `game/game.ts` | `Game`: the main loop at a fixed 60 Hz, the scene switch, debug hooks. `Scene` interface and `SceneContext` |
| `game/gameScene.ts` | `GameScene` values (enum of `g_gameScene` 0x089B84BE) and `SCENE_TABLE`: the function, the possible next scenes and the Play-mode status of each scene |
| `game/state.ts` | `GameState`: the saved part (profile, decks, header) and the session globals; stage unlocking, the stage and tutorial setups, BGM ids |
| `game/profile.ts` | `PlayerProfile`, `PlayerDeck`, `SaveHeader` typed 1:1 like the save layout; `profileInitNewGame`, `dbGetDeckByDominator`, `cardIdToIndex`, `cardCountCollection`; the record codecs and `saveSerializeGameData` / `saveDeserializeGameData` (0x494 bytes), Shift-JIS names |
| `game/continueSave.ts` | `saveSerializeContinue` / `saveDeserializeContinue` (0x287CC bytes): header, profile, decks, DuelPlayer[4], MapUnit, the map state block, the scalars |
| `game/saves.ts` | the storage layer: `localStorage` keys, the SFO strings, export / import of raw `CADATA.SAV` files |
| `game/scenes/movieScenes.ts` | the movie scenes of `main` (MEMORY_CARD, LOGO, OPENING, ENDING A / B / PLAY): `GameState.movie` = `g_moviePlaying`, START skip once the first frame is shown |
| `game/movies.ts` | PMF → MP4 with ffmpeg.wasm once per session (blob URLs) |
| `game/scenes/titleScenes.ts` | `titleScreenScene` (`TitleScene`) and `newGamePrologueScene` (`NewGameScene`) |
| `game/nameEntry.ts` | the name-entry keyboard (`nameEntryInit` / `OpenWindows` / `Update`), player-name and deck-name modes |
| `game/winList.ts` | `WinList`, the game's window list for the 2D scenes: order, `winOpenMessage` / `winOpenFrame` / `winOpenMenu` / `winOpenFace`, `winUpdateInput` / `winGetCursor`, `winFadeClose`, `winBringToFront`, `winSetText`, `winApproachPos`, `winPrintAt` / `winPrintAtEx` glyphs, flag-0x800 dimming |
| `game/scenes/campScenes.ts` | `campMenuScene` (`CampScene`) and `stageSelectScene` (`StageSelectScene`) |
| `game/sprite2d.ts` | `spriteDraw` of virtual-space and `nativeCoords` sprites on the `wide` layer |
| `game/scenes/saveScenes.ts` | `saveDataScene` with a stand-in for the PSP savedata utility, scenes 1000 / 0x44C / 0x208, the camp's inline save / load, the map board's Temp save |
| `game/input.ts` | `PadInput`: keyboard and Gamepad API to PSP bits, and the port of `padUpdate` (held / pressed / repeat) |
| `game/audio.ts` | `AudioManager`: master → BGM / SE / voice buses, volumes and mute |
| `game/assets.ts` | `GameAssets`: archive members, decoded images and GANs, shared tables (windows, map, deck editor, card screen), card screen renderers |
| `game/screen.ts` | `Screen`: the stacked 480×272 layers |
| `game/scenes/*` | the scenes (ports and placeholders); `createScene(id)` is the factory |
| `components/PlayView.tsx` | the React host: toolbar, scaling, fullscreen, debug overlay |

### The loop

`main` (0x088477D4) runs one iteration per vblank:
1. `padUpdate`;
2. `uiAnimCounter(0)`;
3. the function of the current `g_gameScene`, whose return value becomes the next `g_gameScene`;
4. `mainFrameHook`;
5. the file queue;
6. `frameEndAndVsync`.

`Game.step()` does the same: `PadInput.update`, the UI clocks (`UiClock` = `uiAnimCounter`, and the card screen's own clock), then `scene.update(ctx)`. A different return value runs `exit` on the old scene and `init` on the new one.

Timing:
- `requestAnimationFrame` feeds an accumulator, and each callback runs as many 1/60 s steps as have elapsed (at most 8; the rest is dropped).
- Only the last step of a batch draws (`ctx.willDraw`, `scene.draw`).
- **Hidden-tab fallback:** a `setInterval` advances the loop when rAF has not fired for 100 ms (hidden, throttled or headless tab).
- A gap longer than 250 ms counts as a single frame, so after a stall the game slows down instead of catching up in a burst.
- In development, `window.__ncbGame` exposes the `Game`. `setPaused(true)` plus `step()` drives it frame by frame (used by the automated checks).

### Screen

The screen is three 480×272 buffers stacked in one element, scaled by CSS with `image-rendering: pixelated`. The scale is ×1, ×2, ×3 or the largest integer that fits the window, and there is a **Fullscreen** toggle.

| Layer | Space | Used by |
| --- | --- | --- |
| `main` | WebGL, 480×272 | the map board (`MapBoardScene` draws its sprites and windows here) |
| `wide` | WebGL, the game's 640×448 virtual 2D space rendered into 480×272 (as the GE does) | duel, story events, deck editor / card list, rules help |
| `overlay` | 2D canvas | card screen (`CardScreenRenderer`), placeholder menus, the "Converting…" line of a movie |

A movie plays in a `<video>` element that the movie scene adds to the same host, above the layers
(480×272, scaled with them).

A layer that was not drawn in a frame is hidden, so each scene shows exactly what it draws. The
**bilinear** toggle sets the texture filter: bilinear is the GE's `sceGuTexFilter(1, 1)`.
- It applies to the WebGL layers and to the card screen's scaled images on the 2D overlay (`CardScreenRenderer.smooth`).
- Most 2D sprites are drawn 1:1, so it mainly shows on scaled sprites: the card art, zoomed effects and the rotated board.

**smooth scaling** (ours) is separate. It decides how the 480×272 layers are scaled up to the window: off gives crisp pixels (`image-rendering: pixelated`), on lets the browser smooth them (`Screen.smoothScaling`, class `smooth`). The default is off.

## Scenes (from `main`)

Each scene function returns the next scene. The transitions below were read from the code; Ghidra
has them in `main`'s plate. Status in Play mode: **ported** = the game's logic; **partial** =
ported with a placeholder part; **placeholder** = a menu that offers the same exits; **dead** =
unreachable in the game.

| Id | Scene | Function | Next scenes (code) | Play mode |
| ---: | --- | --- | --- | --- |
| 0 | BOOT | main (inline) | 10 | ported (system init; loads se.dat and goc.dat) |
| 10 | MEMORY_CARD | `saveDataScene(-1)` | 0x14 (at once; LOGO.pmf starts) | ported |
| 0x14 | LOGO_MOVIE | movie `LOGO.pmf` | 0x1E (OP.pmf starts) | **ported** (MP4 via ffmpeg.wasm; START skips once the first frame is shown) |
| 0x1E | OPENING_MOVIE | movie `OP.pmf` | 0x32 | **ported** (after the title timeout nothing plays: straight back to the title) |
| 0x28 / 0x29 | ENDING_MOVIE_A / B | `movieInit`, stage 15 → 16, `ED000` / `ED001.pmf` | 0x2A | **ported** |
| 0x2A | ENDING_MOVIE_PLAY | `movieUpdate` | 0x834 | **ported** |
| 0x32 | TITLE | `titleScreenScene` | 500, 0x44C, 0x208, 600, 0x1E (attract timeout, only with the BGM stopped) | **ported** ([title-newgame.md](title-newgame.md#2-title-screen-titlescreenscene-0x08867528-scene-0x32)) |
| 0x50 | MAP_BOARD | `mapBoardScene` | 0x5A for a battle; then `g_mapExitScene`: 300, 0x834 after a story win, 0 → 0x32 | **ported** |
| 0x5A | DUEL | `battleDuelScene` | 0x50 | **ported** |
| 300 | CAMP | `campMenuScene` | 0x136, 0x140, 0x14A, 0x32 (save / load run inside the scene) | **ported** ([camp-stage-select.md](camp-stage-select.md#1-camp-campmenuscene-scene-300): windows, status, deck submenu with copy / rename (keyboard) / delete, System with the inline save / load) |
| 0x136 | STAGE_SELECT | `stageSelectScene` | 0x50, 300 | **ported** ([camp-stage-select.md](camp-stage-select.md#2-stage-select-stageselectscene-scene-0x136): area plates, previews, block A / B, land counts, record, opponent window with face, free-battle opponent choice, deck choice, confirmation) |
| 0x140 | DECK_EDIT | `deckEditScene` | 300 | **ported** (on the profile; a new deck is named with the keyboard, state 9) |
| 0x14A | CARD_LIST | `cardListScene` | 300 | **ported** (on the profile) |
| 400 | RULES_HELP | `rulesHelpScene` | 0x32 | **ported** (unreachable in the game; reachable through the debug scene jump) |
| 500 | NEW_GAME | `newGamePrologueScene` | 0x50, 0x32 | **ported** (name-entry keyboard, prologue event, tutorial setup) |
| 0x208 | RESUME_TEMP | `resumeTempSaveScene` | 0x50, 0x32 | **ported** (the game's windows; loads and deletes the continue data) |
| 600 | BATTLE_MODE | `battleModeMenuScene` | 4000, 0x32 | placeholder: title → Versus Mode shows "versus play comes later (WebRTC, 6.6)" and returns to the title |
| 1000 / 0x44C | SAVE_GAME / LOAD_GAME | `saveDataScene(1 / 0)` | `g_saveReturnScene` (done) / `g_saveCancelScene` (cancel), set by `sceneSetSaveReturn` | **ported** (`saveDataScene`; the utility dialog is a stand-in) |
| 0x834 | STAGE_CLEAR_EVENT | `stageClearEventScene` | 300, 0x28 (stage 15), 0x29 (stage 18) | **ported** |
| 4000 | ADHOC_LOBBY | `adhocLobbyScene` | 0x50, 0x32 | placeholder (6.6) |
| 340, 0x186, 0x5DC, 2000, 9000 | idle, test draw, retry, staff roll, debug menu | — | — | dead (generic placeholder back to the title) |

Rules read from the code on the way:
- The boot, the movies, the title and the new game are described in [title-newgame.md](title-newgame.md): no image logos (LOGO.pmf), the endings are the staff credits, the title has four fixed words and no "Press START", its attract timeout needs the BGM to stop (so it never fires on the console) and 0x1E then plays nothing; the name entry only shows the full-width Latin page and has no default name.
- **`profileInitNewGame` runs every time the title loads**, so entering the title always resets the profile; Load then overwrites it.
- After New Game, `curDeckSlot` is **0**. The stage select sets it when a deck is picked.
- The starter deck takes its **name** from the *first* deck of Galahad (`dbGetDeckNameByDominator`) and its **cards** from the *last* one (`dbGetDeckByDominator(1001, …, 1)`).
- `mapBoardScene` stops BGM channel 0 and returns 0x5A for a battle. `battleDuelScene` plays BGM 10 on channel 1 and returns 0x50. The board resumes at `MBS_DUEL_RETURN`.
- The result screen (`duelResultScreenUpdate`) returns 0x834 after a story-mode win and 300 otherwise (0x32 on ○ in versus mode); Play mode takes that value from the port (`MapBoardScene.resultExit`). To title and the temp save set `g_mapExitScene` to 0, which the scene turns into 0x32.
- The camp does not use scenes 1000 / 0x44C: its System menu calls `saveDataScene` itself (states 0xE / 0xF) and returns to the System menu. Only the title's Load goes through scene 0x44C (`sceneSetSaveReturn(300, 0x32)`).
- The camp and the stage select stop the BGM whenever they leave (`bgmStop(0)`), and each of the camp's target scenes starts BGM 0xF again. `curDeckSlot` is set by the camp's slot list (any deck action) and by the stage select's deck menu, even when the action is then refused.
- `stageClearEventScene` sets clear bit s − 1 at once (stage 18 also sets bit 16). It plays the stage-clear event only on the first clear of stages 15, 16 and 18. After an ending movie, main comes back to it, and since the bit is already set it goes straight to the camp.

## Shared state

`GameState` lives for the whole run.

**The saved part.** These are exactly the structures written to `CADATA.SAV` ([save-menus.md §1.3](save-menus.md#13-in-memory-structures-that-are-saved)):

| Field | Game | Type |
| --- | --- | --- |
| `profile` | `g_playerProfile` (0x2FC) | name, `unk18`, `cardCount[207]`, `cardNewFlags[207]`, `totalCards`, `cardKinds`, `stageClearMask`, `mapBattles[19]`, `mapWins[19]`, `charaBattles[19]`, `charaWins[19]`, `curDeckSlot` |
| `decks` | `g_playerDecks[3]` (0x60 each) | name, `cards` (s16[31], [0] = Dominator), `unk58`, `unk5C` |
| `header` | `g_saveHeader` (0x78) | player name, deck names, `unk60`, `playTime`, `clearMask`, `unk6C`, `totalCards`, `cardKinds` |

`serializeGameData` / `parseGameData` in `profile.ts` write and read the 0x494-byte game data file exactly as `saveSerializeGameData` / `saveDeserializeGameData` do (see [Saves](#saves)). Names are Shift-JIS (`encodeSjis`); the 24 raw bytes read from a file are kept while they still decode to the same name, so stale bytes after the NUL survive a round trip like the game's memcpy.

`GameState` also holds the two buffers the game reuses for every save and load (`gameDataBuf` = `g_saveGameDataBuf`, `continueBuf` = `g_saveContinueBufPtr`), `resumeLoaded` (`g_resumeLoaded`) and `pendingResume` (the loaded continue file until the map board starts).

**The session.** These are the globals the scenes hand to each other:

| Field | Globals |
| --- | --- |
| `mapId`, `mapVariant`, `stageNo`, `gameMode`, `numPlayers` | `g_mapId`, `g_mapVariant`, `g_mapStageNo` / `g_mapLayoutId`, `g_gameMode`, `g_numPlayers` |
| `duelDecks`, `playerNames`, `controllers` | `g_duelPlayers[p].pDeck`, `duelSetPlayerName`, `bController` |
| `saveReturnScene`, `saveCancelScene` | `sceneSetSaveReturn` |
| `seed` | the `srand` seed of the next board |
| `localPlayer` | `g_localPlayer` (0 outside versus) |
| `lastResult` | how the last board ended (debug overlay) |

Setups:
- `setupStageBattle(board, slot, opponent, stage)` is the end of `stageSelectScene`: mode 1 when the stage is not cleared, else 2; DuelPlayer 0 = the deck slot with Dominator 1001; DuelPlayer 1 = `dbGetDeckByDominator(opponent, mode 1 ? 3 : 1)`. Arth's stage 18 keeps `g_mapStageNo` = 18 (its opponent `g_charaLadderOrder[18]`) and is played on stage 17's board (same area and block).
- `setupTutorial()` is `newGamePrologueScene` 9000 / 9999: Galahad (flags 1) against Egma 1004 (flags 3) on stage 1, mode 1.
- `stageIfUnlocked(area, variant)` is `stageGetLayoutIfUnlocked`, with the unlock table of [save-menus.md §2.4](save-menus.md#24-camp-menu-300-and-stage-select-0x136); stage 18 replaces 17 when all six cards 2612–2617 are owned.
- The live `MapBoardScene` is kept in `state.live` across the DUEL round trip, like the game's globals.

## Input

`PadInput.update` is `padUpdate` (0x08884D74):
- **pressed** = `held & ~previous`;
- **repeat**: the timer restarts (1 frame, then a delay of 16) whenever no button stays held from the last frame. When the timer runs out, repeat = held, and the next delay is one frame shorter, down to 4. A held direction therefore repeats on the first frame, then after 16, 15, 14 … frames, then every 4 frames.
- The analog stick counts as the D-pad beyond 0x40 / 0xC0 (±0.5 here).

A key tapped for less than a frame is latched for one frame.

| PSP | Keyboard | Gamepad (standard mapping) |
| --- | --- | --- |
| D-pad | arrow keys | D-pad, left stick |
| ✕ | X, Enter | A (0) |
| ○ | O, Esc | B (1) |
| △ | T | Y (3) |
| □ | S | X (2) |
| L / R | Q / E | LB / RB (4 / 5), LT / RT (6 / 7) |
| START | P, Space | Start (9) |
| SELECT | Tab | Back (8) |

A left click on the screen sets `PAD.POINTER` (0x40000000, not a PSP button) for one frame. The map board reads it as an acknowledgement:
- the area name and "Conditions to win" at board start (START and a middle click close them too, ours: the game waits for ✕ / ○ and ✕);
- every message of the map flows that waits for ✕ / ○ (`MapFlows.ok`, e.g. the spell reports);
- the stage-clear window, the drawn card and the "no room" deploy message.

START or a middle click also cuts the turn banner ("…'s turn", state 10) short: its fade starts at once (ours).

The hand panel works with the mouse too (handSelectUpdate state 100). The cards sit at `panelX + 0x54·i`, 0x50 wide, from `panelY + 0x10` down. Pointing at a card moves the cursor to it (SE 1). A click on a card works as ✕: it takes a usable card, and an unusable one gets SE 10. The map scene hands the pointer to the board as `MapBoardScene.pointer`. Help labels in the board's windows are clickable: "△ Card details", "□ Check board", "○ End", "□ Return", "✕ Accept ○ Cancel" and so on.
- `MapBoardScene.helpClick` runs at the start of each frame and looks for a ＠ｂ icon zone under the click, in the windows' own text and in their printed lines. It checks the topmost window first (`effect/buttonZones.ts`).
- On a hit, the click becomes that button, and the click bit is dropped so it does not also count as an acknowledgement.
- **Square picks** (`MapBoardScene.mousePick`, called by mapCursorUpdate, so every state with the free cursor has it): the free cursor (state 0x14), move destinations (1000), attack targets (2000), deploy squares (0xC1C), the versus start square (7), check board (handSelectUpdate 0x44C) and the flows' square picks (spell / skill targets, `cursorStep`).
  - Pointing at a square, or at a unit's sprite (alpha-tested, topmost first), puts the cursor there. A left click does the same and presses ✕ on the next frame, when the state runs again with the cursor at rest there. So a click on your Dominator opens the command ring, a click on a marked square moves / attacks / deploys there.
  - Only between steps, never onto a missing square, and not through an open window, the status HUD or a hand panel. Only a mouse move or a click picks, from the grid and unit quads of the current frame.
  - Camera (ours): the game's camera always sits on the cursor (`mapSetupCameraMatrix(cursor)`). That scrolled the board under a still mouse after every pick, so the next move picked a square further on and some squares could not be reached. While the mouse drives the cursor, the camera focus now stays put. It follows the cursor only while the cursor's square is near the screen edges (x < 96 or > 544, y < 80 or > 368, or under the status HUD), a twelfth of the way per frame, which is the edge scrolling for far squares. When the pad or the game moves the cursor, or the state has no free cursor (the ring, walks, effects), the focus eases back onto the cursor, and it is the game's camera again.
  - A right click stays ○ (cancel, or the move preview in the free cursor). In check board it is □ (Return): `PAD.POINTER_RIGHT` (0x08000000) comes with the right click's ○, and this state swaps both for □.
- **Command ring** (mapCmdMenuUpdate, `ringMouse`): the icons' screen quads come from the last drawn ring. Pointing at an icon turns the ring to it one step per rest, as a held ←/→ does (no SE, as in the game). The target changes only when the pointer reaches a different icon, so the ring turning under a still mouse does not chase it. A click on an icon turns to it and chooses it like ✕. Clicks elsewhere do nothing.
- **Lists and menus** of the flows (winOpenList / winOpenMenu through `listInput`, e.g. the Cityscape Mirage attribute menu, the player and unit lists): hovering a visible row moves the cursor there (SE 1), and a click on a row chooses it like ✕.
- Card info (cardInfoUpdate state 2): a click on a tab selects it (`tabAt` from `cardScreen.ts`, SE 1).
- Yes / no questions on the board ("End turn", "Ending card usage", "Commencing attack", …):
  - A left click anywhere is ✕, and a right click is ○.
  - This applies when an open window's help has exactly the two labels ✕ and ○, the click missed both labels, and no free cursor ran in the last frame (`helpClick`). The last condition keeps it away from target picks that show "✕ Accept ○ Cancel" while the cursor moves.
- How to play (`RulesHelpScene.pointer`, both the map's Help command and scene 400): pointing at a topic moves the cursor to it (SE 1), and a click on a topic opens it. A click while a topic is shown closes it.
- A right click is ○ everywhere in Play mode (`PadInput.rightClick`), so it closes the card info, cancels and so on. The browser's context menu is suppressed over the game screen.
- The save / load dialog, its no-space question and the resume question show the same hover highlight (`SaveWindows.updateHover`). Clicks on their labels use the same zones and fall back to the window halves.
- Hover highlight (ours): the help label under the mouse gets the menu cursor's bar, drawn by `WindowPainter.drawCursorBar`, which is winDrawMenuCursor's bevelled rect. The window's text is then drawn again on top. This works on the board and in name entry (`WinList.hover`: the help line, "✕ Confirm", "✕ Yes ○ No").

The story players read a left click as ✕: it finishes the typing or moves the dialogue on, both in story scenes and in events the map board starts. A middle click sets `PAD.POINTER_MIDDLE` (0x10000000), which the story players read as START. It skips to the next cmd 21 / 8, as START does. The mouse position is kept in the game's 640×448 virtual space (`pointerX` / `pointerY`, `pointerMoved`, `pointerIn`). The title uses it: moving over a word moves the cursor (SE 1), and a click on a word chooses it like ✕. The save / load dialog uses it too:
- Hovering a slot selects it, and a click on a slot chooses it.
- Two-choice button windows: the left half of "✕ Enter ○ Back", "✕ Yes ○ No" or "Yes / Cancel" is ✕, the right half is ○.
- Yes / No: follows the pointer, and a click confirms.
- "Save completed." and similar messages: a click anywhere closes them.

The resume question and the no-space question work the same way.

Name entry, both the player's name and deck names:
- A click closes the intro ("✕ Confirm") and the "no name" message.
- Over the keyboard the pointer moves the key cursor (to cells that aren't blank), and a click types the key.
- On "✕ Yes ○ No", the left half is ✕ and the right half is ○.
- The help line: a click on a label presses its button. The labels are "✕ Enter", "□ Delete", "△ Return", "START Accept", "L Move cursor left" and "R Move cursor right".
  - `game/buttonZones.ts` splits a help window into zones, one per ＠ｂ icon, running up to the next icon on the same line. It uses the text layout.
  - Icon ids: 0 ✕, 1 △, 2 □, 3 ○, 7 L, 9 R, 11 START.
  - The same helper can serve other help lines.
- Backspace (`PAD.BACKSPACE`, 0x20000000, not a PSP button) is □ Delete on the keyboard page, with the pad repeat, so holding it keeps deleting. Other scenes ignore it.

The mouse wheel is ↑ / ↓ for one frame per notch (`PadInput.wheel`, 100 px or one line event), everywhere, like the pad (so it scrolls lists and steps counts; at a list's end the press wraps around as the pad does).

Menus and lists of the 2D scenes (`WinList.updateInput`, winUpdateInput's port, so every WinList menu has it): hovering a visible row that holds an item moves the cursor there (SE 1, the scroll position never changes: the wheel or the pad scrolls), and a click on a row becomes ✕. `WinList.helpMouse` (called by the scene before its state runs) gives the ＠ｂ help labels of the open windows the hover bar and turns a click on one into its button; with `clickAnywhere` a click that missed the labels is ✕. Name entry does not use either (it has its own pointer code), so the keyboard is handled once.

Camp (`CampScene`):
- Main menu, Build deck submenu, deck slot list, copy destination, System submenu: row hover / click. A right click is ○ (back one level).
- The messages ("✕ Confirm": no deck to edit, cannot delete your only deck, …) and the questions (delete "✕ Yes ○ No", back to title "✕ To title ○ Return"): the labels are clickable with the hover bar, and a left click elsewhere is ✕.
- Change deck name: the name-entry keyboard (above). Save / Load: the save dialog (above).

Stage select (`StageSelectScene.mouse`):
- Area list: row hover / click on the plates (✕ chooses the area). On a plate with two blocks, a click on its lower strip ("Block A →" / "← Block B", x 0x22–0xBA) picks block A (left half) or B (right half) instead of choosing. The wheel scrolls the list.
- Opponent: in free battle the side arrows are ← / → (click), a click elsewhere is ✕.
- Deck menu: row hover / click. The confirmation and "Returning to camp." ("✕ To camp ○ Cancel"): labels, and a left click elsewhere is ✕. "✕ Accept ○ Return" is clickable in every state.

Deck editor and card list (`CollectionScene.mouse`, grid cells from `DeckEditorRenderer.cellAt`, labels from `helpZones`):
- Grids (deck 6 × 2 view, collection 10 × 3 view, card list): hovering a card moves the cursor there (SE 1), a click is ✕ (count popup / card info). The wheel moves a row (the grid scrolls as with the pad).
- Deck editor: the Deck / Album tabs are □, the filter's side arrows L / R (the filter label R). With the count popup a click accepts it (the wheel sets the count).
- Card info: a click on a tab selects it (`tabAt`); a right click closes it.
- The help window's labels ("✕ Confirm", "△ Card details", "□ Change view", "○ End", "△ End" of the save prompt, …) get the hover bar and are clickable.

Everything else ignores the pointer.

Enter stays ✕ as in the viewer's views, so START is P or Space. F2 or ` toggles the debug overlay. The keys are read by `KeyboardEvent.code`, so the mapping does not depend on the keyboard layout.

The map board port reads its edges from `pressed`. Its menus expect the pad repeat on the D-pad, so the map scene gets `pressed | (repeat & D-pad)`. The deck editor and the rules help get the real pressed / repeat pair.

## Audio

`AudioManager` owns one `AudioContext` with master → {BGM, SE, voice} gain buses. The volumes and the mute switch are Play-mode preferences in `localStorage`; the game itself has no options.

The context starts on the first key or click, since browsers require a gesture. A track requested before that starts then.

- **BGM**: `bgmPlay(0, id)` = `at3/BGM_{id+1}.at3` through `MusicPlayer` (ffmpeg.wasm decode, looped forever, [story.md §4.1](story.md#41-bgm-looping-code--data)).

  | Scene | BGM id | File |
  | --- | --- | --- |
  | title | 0xE | BGM_15 |
  | camp, stage select, deck edit, card list | 0xF | BGM_16 |
  | map | `mapGetBgmId(area)` = area − 1 | BGM_01…10 |
  | duel | 10 (channel 1) | BGM_11 |
  | result, player 0 won | 0xB | BGM_12 |
  | result, otherwise | 0x10 | BGM_17 |

  Story events switch the track with cmd 22 / 23.
- **SE**: `sndPlaySeUi` of the scenes and the effect scripts' `se_play` go through the SAS model (`SePlayer`, [sound.md](sound.md#sound-effects-sas)), routed to the SE bus. `EffectScene` gained a `seOut` option for this.
- **Voices**: the goc.dat clips of story events (`StoryPlayer`, new `voiceOut` option) go to the voice bus.

## How the modules plug in

A Play-mode scene wraps a port and feeds it from the shared state instead of the viewer's sample state:

| Scene | Port | Fed from the state |
| --- | --- | --- |
| `MapBoardPlayScene` | `MapBoardScene` + `MapFlows` + `MapAi` | the board of `stageNo`, the session decks (`newGame(…, decks)`, a new optional parameter), names, mode, CPU controller; exit scene from the result; card screen on the overlay |
| `DuelPlayScene` | `DuelSession` + `EffectScene` | the battle request of the live board; the HP result goes back with `battleResult` |
| `CampScene`, `StageSelectScene` | `WinList`, `sprite2d`, `NameEntry` (deck mode), `SaveDataRunner` | the profile, decks and clear mask; etc.one 300 / 310 / 320, chara.one 1000 faces, BOOT.BIN texts; the stage select ends in `setupStageBattle` |
| `NewGameScene`, `StageClearEventScene` | `StoryPlayer` (+ `NameEntry`) | the prologue / stage-clear script of the database; voices and BGM through the AudioManager; the entered name into `PlayerProfile.name` |
| `TitleScene`, `NewGameScene` | `WindowPainter`, `sprite2d` | etc.one 10/1, 10/2, 20/1, 2/2 and the BOOT.BIN texts / keyboard pages |
| `MovieScene` | ffmpeg.wasm (`convertPmf`) | `GameState.movie` (`g_moviePlaying`) |
| `CollectionScene` | `DeckEditorSim` + `DeckEditorRenderer` + `CardScreenRenderer` | `cardCount`, `cardNewFlags`, `g_playerDecks`, `curDeckSlot`; a saved deck and the NEW flags are written back |
| `RulesHelpPlayScene` | `RulesHelpScene` | — |

The viewer's own views are unchanged. The only changes to shared modules are the optional parameters above (`newGame` decks, `seOut`, `voiceOut`, `MusicPlayer.set(…, destination)`) and, for the name entry, two optional `DuelWindow` fields in the window painter: `wide` (the full-width layout of `winPrintAtEx(…, narrow 0)`: advance glyph + 1, line glyph + 2, scale glyph/18, also used by the menu cursor) and `textY` (`winPrintAt`'s y). The text parser now lays out the text after ＠－ as `msgParseNextGlyphRaw` does (two-byte cells, a full-width space advances a whole cell) instead of approximating it with the normal parser.

## Rewards, counters and unlocks

The result screen is part of the map board port (`MapBoardScene`, `src/effect/mapBoard.ts`); Play
mode hands it the real profile (`m.profile = state.profile`, `m.stageNo`), the viewer an empty one.
Everything is a transcription of the code ([save-menus.md](save-menus.md#card-rewards)):

| Step | Code | Port |
| --- | --- | --- |
| roll (result state 1, modes 1 / 2) | `duelRollRewardCards(opponent)` | `rollRewards`: cardNewFlags[1..206] cleared, 5–10 / 3 / 1–3 cards, per-card score with the drop table, the insertion loop as written (including the empty entry a zero-score first card leaves), slots skip cards owned 10 times and stop at score 0, refill without flags, the rare bonus with the 10-copy test |
| copies (state 0xF → 0x10) | `duelResultScreenUpdate` | `cardCount + 1`, `cardNewFlags |= flags` while < 10 |
| counters and special cards (state 0x10) | `duelResultScreenUpdate` | `resultApplyCounters`: mapBattles / mapWins (stage 18 → 17, 0xFFFF cap), charaBattles / charaWins via `charaGetLadderIndex` of player 1's Dominator, 2613 / 2615 / 2617 / 2616 for story wins on 14 / 11 / 10 / 7, 2612 / 2614 in free battle; returns 0x834 / 300 |
| clear bit, story event, endings | `stageClearEventScene` | `StageClearEventScene` (bit s − 1, stage 18 also bit 16; first clear of 15 / 16 / 18 plays the event; 15 → ED000 → stage rewritten to 16 → its event and bit; 18 → ED001) |
| unlocks | `stageGetLayoutIfUnlocked` | `GameState.stageIfUnlocked` (stage 18 replaces 17 once 2612–2617 are owned) |
| camp status | `campDrawStatusWindows` → `cardCountCollection` | `GameState.recountProfile` (totalCards / cardKinds over cardCount[0..206]) |

The deck editor and the card list read the collection and the New / Get flags from the profile, so
the rewards show there at once.

## Saves

Saves are a separate layer (`src/game/saves.ts`) that stands in for the Memory Stick: the same
files, the same bytes as a decrypted `CADATA.SAV`, no encryption.

| Directory (as the game names it) | `localStorage` key | Bytes | Written by |
| --- | --- | --- | --- |
| `ULUS1038200`, `…01`, `…02` (gameName + `sprintf("%02d", i)`) | `ncb.save.ULUS1038200` … | 0x494, base64 | camp → System → Save (LISTSAVE) |
| `ULUS10382` (saveName "") | `ncb.save.ULUS10382` | 0x287CC, base64 | map board → Temp save (SAVE); deleted after a resume (AUTODELETE) |

Each save also has `ncb.save.<dir>.sfo`: the PARAM.SFO strings the game sets (`Neverland Card
Battles`, `Data of <name>` and the `Cards: n（k types）` / deck detail for game data, `NCB GAME DATA` /
`Temporary Data` for the continue data) and the time of the save. The toolbar's **Saves** panel
lists the four files and can export them (`<dir>_CADATA.SAV`, raw bytes: the viewer opens them in
its save view), import a decrypted `CADATA.SAV` (by size: 0x494 into the chosen slot, 0x287CC as
continue data) or delete them.

**Serializers.** `serializeGameData` is `saveSerializeGameData`: the profile field by field into
`g_saveGameDataBuf` (its pads keep the buffer's bytes), the decks by memcpy, and a memcpy of
`g_saveHeader` in which `sprintf` rewrites the names, with clearMask and the card totals recounted
over index 0..206; the profile's own totals are written unchanged. `serializeContinue` is
`saveSerializeContinue`: field by field into the persistent continue buffer, so everything it does
not write (profile slots 1–3, pads, MapUnit sides 2–3, the dead globals) keeps the buffer's bytes as
in the game. Fields the rule port does not model are kept from a loaded file: MapUnit posZ and
colours (default 0 and 0x80, as `unitInitFromCard`), DuelPlayer +0xA4. DuelPlayer 2 and 3 are kept by
the board (`MapBoardScene.sparePlayers`: `playerResetDeck` shuffles them in modes 1 / 2).

**Resume.** `loadContinue` restores the header, profile, decks and session (map, stage, mode,
players, names: the Dominators' card names outside versus); the map board scene then builds the
board with `MapBoardScene.resume`, which fills the map state block, MapUnits, DuelPlayers and
scalars from the file and enters state 1 with round ≥ 1, i.e. straight to the free cursor as the
game does. The random generators are not in the file and continue from their current state
(`saveDataScene` calls `rand()` every frame).

**The dialog.** `SaveDataRunner` is `saveDataScene` with its states and the game's own windows
(error / Back, "Delete data to create free space?" / Yes No); `ResumeTempScene` is
`resumeTempSaveScene` with its windows and the 60-frame "Temporary data will be deleted." timer.
`SavedataUtility` stands in for the firmware's dialog and is built from the game's windows: the slot
list (savedataTitle, detail, date and size; "No Data" for empty slots), the confirmation with the
Sony sample's texts from BOOT.BIN ("New data will be created…", "The data will be overwritten…",
"Erase data?"), "Save completed." / "Load completed.", and a no-data message. A full `localStorage`
maps to the utility's no-space result, which leads to the game's delete-for-space question and the
delete list (LISTALLDELETE).

Checked in headless Chrome (`scratchpad/play64.mjs`): new game → stage 1 won → the five rewards are
in `cardCount` / `cardNewFlags` exactly as the port predicts and show in the card list; mapBattles /
mapWins / charaBattles / charaWins counted; camp save → the stored 0x494 bytes equal the serialized
state; page reload → title → Load → the serialized profile equals the stored file byte for byte;
stage 2 → Temp save → title → Continue → the board comes back at the free cursor and re-serializes
to the same 0x287CC bytes, and the continue data is gone from `localStorage`; the exported file opens
in the viewer's save view.

## Debug overlay

Toggle it with **Debug**, F2 or `. It shows:
- the current scene (id, name, status) and the scene's own line (e.g. the board state, turn, Costs / Soul, running effect);
- the frame counters and fps;
- the `gameRandNext` state, the held pad bits;
- a profile summary (name, cards, kinds, cleared stages, deck slot and names) and the session (stage, mode, players, last result);
- the audio status and the scene history.

Controls: **jump to any scene** (like writing `g_gameScene`), pause / resume / single step, and "Unlock stages" (sets the clear bits of stages 1–17).

## Boot, title and new game (step 6.2)

Done: see [title-newgame.md](title-newgame.md). Checked in headless Chrome (`scratchpad/p62.mjs`,
`p62b.mjs`): boot → LOGO.pmf converts and plays → START → OP.pmf plays → START → title (BGM 0xE);
cursor wrap; 1000 idle frames with the BGM on → still the title; BGM stopped → next frame 0x1E → back
to the title (0x1E plays nothing); Resume Game without temp data → the resume question → "no data" →
title; Load Game without saves → the utility's no-data message → title; Versus Mode → stub → title;
New Game → intro → keyboard → START on an empty name → "You have not entered a name." → typed "Ｎｅｍｏ１",
□ deleted the "１", L / R caret → START → "The name you entered is “Ｎｅｍｏ”" → ✕ → windows fade →
`PlayerProfile.name` = "Ｎｅｍｏ" (82 6D 82 85 82 8D 82 8F 00…) → prologue on black → stage 1; the
debug jump to 0x28 / 0x29 plays ED000 / ED001 (stage 15 → 16) and returns to 0x834.

Fixed on 2026-09-27 after a comparison with the user's console screenshots (`scratchpad/fixdrive.mjs`):
- the title's pointer hand has its top-left, not its centre, at (0xD0, 0x100 + 32·cursor)
  ([title-newgame.md](title-newgame.md#2-title-screen-titlescreenscene-0x08867528-scene-0x32));
- window text is drawn 8 virtual px further right and down: the glyph cell's top-left is the draw point
  ([windows.md](windows.md#glyphs)). This moves all window text, in Play mode and in the viewer;
- the stage-start events on the board (the dungeon scene with Egma after the prologue) showed only
  their picture: the story background / CG had a different depth than the windows, and the board draws
  with the GE depth test on ([story.md](story.md#31-draw-order-per-frame-msgeventdraw-code)).

## Camp and stage select (step 6.3)

Done: see [camp-stage-select.md](camp-stage-select.md). `CampScene` and `StageSelectScene` replace the
placeholder menus; both are transcriptions of the scene functions (states, windows at the code's
coordinates and flags, BOOT.BIN texts, SE ids, pressed / repeat reads, etc.one 300 / 310 / 320 images,
the chara.one default faces). They share `WinList` with the name-entry keyboard, which the camp opens
over its own windows in deck-name mode (Change deck name); the deck editor's state 9 now runs the same
keyboard for a new deck. The camp's inline save / load (states 0xE / 0xF) run `SaveDataRunner` over the
camp's frame.

Checked in headless Chrome (`scratchpad/p63.mjs`): new game → tutorial won → camp (status: "Unsearched
map Forest of Dryad", 1 battle, 100 %) → Build deck → Change deck name → slot 1 → keyboard: □ deleted
"Basic-Deck", typed "ａｂｃｄ", START → "The name of the deck is “ａｂｃｄ”" → ✕ → deck 1 renamed, slot list
reopened → Copy slot 1 → slot 2 (name and cards copied) → Delete slot 2 (Yes) → Edit slot 1 → deck
editor; with the deck's name emptied, saving asked for a name (state 9) and the keyboard's "ＡＢ" became
the deck name → camp → Search → stage select (area plates, block header, preview, land counts,
record) → area 2 → opponent Shaia (face, deck name, HP / AP / Move, battles) → deck 1 → confirmation
"Map: Forest of Dryad - A / Opponent: Shaia / Deck used: AB" → the board of stage 2 (mode 1, decks:
slot 1 vs `dbGetDeckByDominator(1002, 3)`) → won → result → camp (clear mask 3, "Clamaton Desert") →
System → Save → Load → back to the System menu; Back to title question. Free battle (a cleared
stage): ← / → cycle the cleared stages' opponents with the side arrows.

The save / load stand-in dialog was re-laid out on the same day: its title, help and message windows
are auto-sized with the game's rule (w = text + 20, h = lines + 18 for style 7) plus the +10 the game's
callers add when they switch a window to style 10, and the three slot windows hold six 14-px lines
(title 6..54, slots 58..398, help 402..446). No other hand-sized window of our code had the problem:
the other stand-ins are 2D-canvas placeholders, and the duel's name / pop-up windows already use
text + 30 for style 10.

## Placeholders and gaps (step 6.6)

- **6.3** and **6.4** are done (above). What remains a stand-in: the PSP savedata utility's own dialog (its look and its firmware texts; the game only supplies the SFO strings), the save icons (ICON0 / PIC1 are in the EBOOT but not shown), and the play time (the game never advances it either).
- **6.6**: battle mode and the ad-hoc lobby.
- Smaller gaps:
  - story events started by the board itself (stage start, turn events) do not switch the BGM (the board's internal story player has no hook yet);
  - after the duel the map BGM restarts from the beginning (the game's `MBS_DUEL_RETURN` BGM call was not checked);
  - the map loads without a "Now loading" frame;
  - the card screen is not a scene of its own (it lives inside the board and the deck editor, as in the game).
