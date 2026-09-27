# Story events

The game's story scenes: where the scripts are, what each command does and how a scene is drawn. The
viewer replays them (Card database → Story) with [`src/effect/story.ts`](../../src/effect/story.ts); the
BGM of cmd 22 is decoded from `at3/BGM_nn.at3` with ffmpeg.wasm ([`src/effect/music.ts`](../../src/effect/music.ts)).

Source: `Neverland_Card_Battles_USA.elf` (= `PSP_GAME/SYSDIR/BOOT.BIN`), read from code in Ghidra.
Confidence tags: **code** (read from the decompiler/assembly), **data** (checked on all records),
**inferred** (reasoned, not proven), **?** (open).

All frame counts are at the game's 60 Hz (one update + one draw per vblank).

Coordinates:
- **virtual** = the 640×448 space of windows, faces and glyphs; the GE maps it to the screen with
  `x·480/640`, `y·272/448` (`spriteDraw2D`, when sprite+0x1F4 == 0).
- **native** = 480×272 screen pixels. Story backgrounds and CGs are drawn native
  (`msgEventDrawBg`/`msgEventDrawCg` set sprite+0x1F4 = 1 before drawing) (**code**).

---

## 0. Functions and globals (as annotated in Ghidra)

| Address | Name | Role |
| --- | --- | --- |
| 0x08849388 | `msgEventStart(ctx, key, a, b, mode)` | picks a script (was `FUN_08849388`) |
| 0x08849E74 | `msgEventUpdate(ctx)` | per-frame interpreter; returns 1 when the script is over |
| 0x0884AAFC | `msgEventDraw(ctx)` | per-frame: window slide-in, bg, CG, then `menuWinUpdateAll` |
| 0x08849948 | `msgEventShowText(ctx)` | cmd 0: opens the windows if needed, sets the text |
| 0x08849518 | `msgEventOpenWindows(ctx, win)` | window geometry of a line |
| 0x08849AC4 / 0x08849D60 | `msgEventBgFadeIn` / `msgEventCgFadeIn` | cmd 3 / cmd 20 |
| 0x08849BA0 | `msgEventBgScrollStart` | cmd 17 |
| 0x08849C5C | `msgEventCgZoom` | cmd 19 (no data uses it) |
| 0x08849188 | `msgEventFreePictures` | cmd 16, and part of cmd 8 |
| 0x08849320 | `msgEventReset` | |
| 0x0884A7F8 / 0x0884A9EC | `msgEventDrawBg` / `msgEventDrawCg` | |
| 0x08870260 | `winOpenFace` | face window (style 10, 160×160) |
| 0x0886FF9C | `winFadeClose(win, step)` | alpha −step per frame, unlink at < 0 |
| 0x0886918C | `winCloseAll` | unlink every window at once |
| 0x0886FD10 | `winFinishText` | ✕ during typing: parse the rest at once |
| 0x089F2010 | `g_msgEventCtx` | the single event context (one script at a time) |
| 0x088D6C2C | `g_apMsgEventTables[13]` | record list per trigger mode |
| 0x088D6BD0 | `g_dwMsgEventWinPos` | window target positions (floats, table in §3.2) |
| 0x089F25A4 / 0x089F2DB4 | `g_msgBgSprites[4]` / `g_msgCgSprites[4]` | sprites 0x204 B each |
| 0x089F35D4 / 0x089F35D8 | `g_msgBgCount` / `g_msgCgCount` | slots used |
| 0x089F35C4 / C8 / CC / D0 | `g_msgBgScrollTimer`, `g_msgAutoAdvanceCounter`, `g_msgFadeHoldCounter`, `g_msgSkipArmed` | |
| 0x088ECCA8 | `g_pBgmPaths[17]` | `at3/BGM_01.at3` … `BGM_17.at3` |
| 0x08B47290 / 0x08B496E0 | `g_winFaceCacheSprites[18]` / `g_winFaceCacheKeys[18]` | face cache |
| 0x08869358 | `winDrawNextArrow` | "next" arrow (§3.8) |
| 0x088A57BC / 0x088A5878 / 0x088A5998 | `at3StreamThread` / `at3StreamOpen` / `at3StreamDecodeLoop` | BGM streaming (§4.1) |
| 0x08834198 | `duelResultScreenDraw` | result-screen layers; under the after-win/loss event only `msgEventDraw` (§3.1) |
| 0x088514C4 / 0x08831DB4 / 0x08859A60 | `mapDrawTerrain` / `mapDrawAllUnits` / `mapDrawStatusHud` | map layers 1 / 2 / 8 of `g_mapDrawFlags` 0x08A1BD98 |

---

## 1. Where the scripts are

### 1.1 Record — 0x14 bytes (**code** + **data**)


| Off | Type | Field | Notes |
| --- | --- | --- | --- |
| 0x00 | s32 | `key` | script key: stage number, 0 for the prologue, round number for turn events |
| 0x04 | s8 | `cmd` | < 0 = end of the table |
| 0x05 | u8 | `side` | 0 = upper-left speaker slot, 1 = lower-right slot (cmd 0 and 2). cmd 19 uses it as the start scale |
| 0x06 | u16 | pad | always 0 (**data**) |
| 0x08 | s32 | `arg` | speaker card id (cmd 0/2/9), image member (12/14/20/6/3), BGM id (22), frames (18) |
| 0x0C | s32 | `arg2` | expression 1–6 (cmd 0; 0 = none), 100 (cmd 6/20: CG scale %), 0 otherwise |
| 0x10 | char* | `text` | Shift-JIS text; points at `""` (0x088BB9A4) when unused. Read only by cmd 0 |

Values like 0x6E (110), 0x2711 (10001), 0x2716 (10006) are **arg values**, not commands.

### 1.2 Tables

`g_apMsgEventTables` (0x088D6C2C) = 13 pointers, indexed by the trigger mode passed to `msgEventStart`.
Each pointer is the start of one flat list of records; several scripts are stored back to back in one
list, told apart by `key`. The list ends at the first record with `cmd < 0` (0xFF).

| Table vaddr | Modes | Trigger | Caller | Key |
| --- | --- | --- | --- | --- |
| 0x088BC8D0 | 0 (also 2, 10, 11, 12: no caller) | new game, after name entry, before the tutorial battle | `newGamePrologueScene` (scene 500) | 0 |
| 0x088C61AC | 1 (also 6) | stage start, story mode only (`g_gameMode`=1, stage not cleared yet), before the area-name window | `mapBoardScene` | stage (`g_mapLayoutId` = `g_mapStageNo`) |
| 0x088CE568 | 3 (also 7) | after a **won** story battle, on the result screen after the reward cards | `duelResultScreenUpdate` state 0xB/0xC | stage |
| 0x088D2644 | 4 (also 8) | after a **lost** story battle, same place | `duelResultScreenUpdate` | stage |
| 0x088D5088 | 5 | stage-clear scene 0x834, only for stages 15, 16, 18 and only on the first clear (bit not yet set) | `stageClearEventScene` | stage |
| 0x088D684C | 9 | start of a turn in story mode (step 200 of `mapTurnStartUpdate`) | `mapTurnStartUpdate` | `key` = `g_mapRound`, **and** `arg` = card id of the turn player's Dominator |

`mapSpellCastUpdate` calls `msgEventReset` + `msgEventUpdate` but never `msgEventStart`: no event can
start during a spell (dead hook) (**code**).

### 1.3 Selecting and running a script (`msgEventStart`, **code**)

```
list = g_apMsgEventTables[mode]
modes 0–5:  first rec with rec.key == key
mode 9:     first rec with rec.arg == dominatorId && rec.key == round
not found (cmd < 0 reached) → no event; msgEventUpdate returns 1 immediately.
```
Then records play one after another (`rec += 0x14`). The script ends at **cmd 8**. The interpreter also
forces cmd 8 when the next record belongs to another script:
- modes 0–5: `next.key != key`;
- mode 9: `next.arg != dominatorId || next.key != round`. Because the trailing cmd 21/8 records of a
  turn script have `arg = 0`, the cmd 21 there is replaced by the forced end (harmless).

### 1.4 Extraction recipe (viewer, from BOOT.BIN)

```
fileOffset(v) = v − 0x08804000 + 0x54
for each distinct table pointer T in u32[13] at 0x088D6C2C:
  for (a = T; ; a += 0x14):
    key = s32(a), cmd = s8(a+4); if cmd < 0 break
    side = u8(a+5), arg = s32(a+8), arg2 = s32(a+12), text = sjis(u32(a+16))
    start a new script when key changes (turn table: when a cmd-0 record follows a cmd 8)
```
Totals (**data**): 1326 records + 6 terminators; 1081 dialogue records: 1080 with a distinct `＠ｖN`,
one with empty text (see the quirk in §1.5).
Command counts: 0×1081, 21×64, 8×61, 2×16, 7×14, 12×12, 20×12, 6×12, 9×10, 22×9, 23×9, 14×7, 3×5,
4×5, 18×4, 16×2, 11×2, 17×1. Commands 5, 10, 13, 15, 19 never occur in the data.

### 1.5 All scripts (**data**; "vag" = voice ids of the lines)

Stage → opponent: see rules.md (stage 1 Egma 1004, 2 Sha-ee-ah 1002, 3 Iglus 1003, 4 Refina 1005,
5 Sheriela 1009, 6 Simmon 1006, 7 Sha-ee-ah#2, 8 Fellunder 1007, 9 Wise 1008, 10 Sheriela#2,
11 Iglus#2, 12 Wise#2, 13 Refina#2, 14 Egma#2, 15 Hellgaia 1010, 17/18 Arth 1011). Speakers in the
scripts are always the base ids 1001–1011.

| Trigger | Key | First record | Recs | Lines | vag | Speakers | Pictures / BGM |
| --- | --- | --- | ---: | ---: | --- | --- | --- |
| Prologue | 0 | 0x088BC8D0 | 93 | 53 | 1–58 | narr, 1004, 1005, 1010 | bg 1,2,3 (scroll), 4, 9; CG 10006, 10001; BGM 12, 16, 8 |
| Stage start | 1 | 0x088C61AC | 49 | 39 | 59–97 | 1001, 1004 | bg 6; CG 10003 |
| | 2 | 0x088C6580 | 35 | 33 | 147–179 | 1001, 1002 | — |
| | 3 | 0x088C683C | 31 | 29 | 215–244 | 1001, 1003 | — |
| | 4 | 0x088C6AA8 | 27 | 25 | 264–289 | 1001, 1005 | — |
| | 5 | 0x088C6CC4 | 29 | 27 | 317–343 | 1001, 1009 | — |
| | 6 | 0x088C6F08 | 31 | 29 | 369–397 | 1001, 1006 | — |
| | 7 | 0x088C7174 | 27 | 25 | 432–456 | 1001, 1002 | — |
| | 8 | 0x088C7390 | 31 | 29 | 499–527 | 1001, 1007 | — |
| | 9 | 0x088C75FC | 29 | 27 | 550–576 | 1001, 1008 | — |
| | 10 | 0x088C7840 | 31 | 26 | 604–629 | 1001, 1009 | CG 10011 |
| | 11 | 0x088C7AAC | 29 | 24 | 659–682 | 1001, 1003 | CG 10010 |
| | 12 | 0x088C7CF0 | 32 | 30 | 719–748 | 1001, 1008 | — |
| | 13 | 0x088C7F70 | 26 | 24 | 782–805 | 1001, 1005 | — |
| | 14 | 0x088C8178 | 30 | 25 | 851–875 | 1001, 1004 | CG 10012 |
| | 15 | 0x088C83D0 | 41 | 39 | 908–946 | 1001, 1010 | — |
| | 17 | 0x088C8704 | 8 | 6 | 1017–1024 | 1001, 1011 | — |
| | 18 | 0x088C87A4 | 15 | 13 | 1039–1051 | 1001, 1011 | — |
| After win | 1 | 0x088CE568 | 24 | 22 | 98–119 | 1001, 1004 | — |
| | 2 | 0x088CE748 | 23 | 20 | 180–199 | 1001, 1002 | — |
| | 3 | 0x088CE914 | 15 | 12 | 245–256 | 1001, 1003 | — |
| | 4 | 0x088CEA40 | 21 | 18 | 290–307 | 1001, 1005 | — |
| | 5 | 0x088CEBE4 | 18 | 14 | 344–357 | 1001, 1009 | — |
| | 6 | 0x088CED4C | 31 | 29 | 398–426 | 1001, 1006 | — |
| | 7 | 0x088CEFB8 | 34 | 29 | 457–485 | 1001, 1002 | CG 10014 |
| | 8 | 0x088CF260 | 16 | 14 | 528–541 | 1001, 1007 | — |
| | 9 | 0x088CF3A0 | 23 | 20 | 577–596 | 1001, 1008 | — |
| | 10 | 0x088CF56C | 26 | 21 | 630–650 | 1001, 1009 | CG 10011 |
| | 11 | 0x088CF774 | 35 | 29 | 683–711 | 1001, 1003 | CG 10010 |
| | 12 | 0x088CFA30 | 26 | 24 | 749–772 | 1001, 1008 | — |
| | 13 | 0x088CFC38 | 41 | 39 | 806–844 | 1001, 1005 | — |
| | 14 | 0x088CFF6C | 26 | 23 | 876–898 | 1001, 1004 | — |
| | 17 | 0x088D0174 | 9 | 7 | 1025–1031 | 1001, 1011 | — |
| After loss | 1 | 0x088D2644 | 9 | 7 | 120–126 | 1001, 1004 | — |
| | 2 | 0x088D26F8 | 8 | 6 | 200–205 | | — |
| | 3 | 0x088D2798 | 10 | 7 | 257–263 | | — |
| | 4 | 0x088D2860 | 12 | 9 | 308–316 | | — |
| | 5 | 0x088D2950 | 14 | 11 | 358–368 | | — |
| | 6 | 0x088D2A68 | 7 | 5 | 427–431 | | — |
| | 7 | 0x088D2AF4 | 16 | 13 | 486–498 | | — |
| | 8 | 0x088D2C34 | 10 | 8 | 542–549 | | — |
| | 9 | 0x088D2CFC | 10 | 7 | 597–603 | | — |
| | 10 | 0x088D2DC4 | 10 | 8 | 651–658 | | — |
| | 11 | 0x088D2E8C | 10 | 7 | 712–718 | | — |
| | 12 | 0x088D2F54 | 12 | 9 | 773–781 | | — |
| | 13 | 0x088D3044 | 8 | 6 | 845–850 | | — |
| | 14 | 0x088D30E4 | 11 | 9 | 899–907 | | — |
| | 15 | 0x088D31C0 | 9 | 7 | 983–991 | 1001, 1010 | — |
| | 17 | 0x088D3274 | 9 | 7 | 1032–1038 | 1001, 1011 | — |
| | 18 | 0x088D3328 | 7 | 5 | 1089–1093 | 1001, 1011 | — |
| Stage clear | 15 | 0x088D5088 | 55 | 36 | 947–982 | 1001, 1005, 1010 | bg 10; CG 10004; BGM 8, 1, stopped by cmd 23 before the end. Then ED000.pmf |
| | 16 | 0x088D54D4 | 34 | 25 | 992–1016 | 1001, 1011 | BGM 8. **Unreachable** (stage 16 cannot be selected) |
| | 18 | 0x088D577C | 59 | 37 | 1052–1088 | narr, 1001, 1011 | CG 10009, 10005; BGM 9, 12, 1, stopped by cmd 23 before the end. Then ED001.pmf |
| Turn start (Egma 1004, tutorial) | round 1 | 0x088D684C | 8 | 6 | 127–129, 133–135 | 1004 | — |
| | round 2 | 0x088D68EC | 5 | 3 | 131, 132, 130 | | — |
| | round 3 | 0x088D6950 | 5 | 3 | 136–138 | | — |
| | round 4 | 0x088D69B4 | 6 | 4 | 139–142 | | — |
| | round 5 | 0x088D6A2C | 5 | 3 | 144–146 | | — |
| Turn start (Sha-ee-ah 1002) | round 1 | 0x088D6A90 | 7 | 5 | 206–210 | 1002 | — |
| | round 2 | 0x088D6B1C | 4 | 2 | 211, 212 | | — |
| | round 3 | 0x088D6B6C | 4 | 2 | 213, 214 | | — |

Notes:
- No stage-start script for 16, no after-win script for 15/16/18 (those use the stage-clear table).
- Turn events are keyed by Dominator and round, not by stage; they fire on the **CPU's** turns
  (Egma/Sha-ee-ah are player 1). The first CPU turn of stage 1 is **round 1** (**code**): a new board
  sets `g_mapRound` = 0 and `g_mapTurnPlayer` = 0 (0x0884D4E8), then `g_mapRound` = 1 (0x0884D9AC);
  the turn advance (0x08850ED4) increments the turn player and increments the round only when it
  wraps back to 0. So player 0 plays round 1, then the CPU plays round 1; turn events 1…5 fire on the
  CPU's turns 1…5. A resumed game keeps its saved round.
- Order in play: stage start → turn events → battle → result screen → after-win/loss →
  (stage-clear event for 15/16/18) → ending movie for 15/18.
- Data quirk (**data**): in stage-start 1, record 0x088C6440 is a cmd 20 (CG 10003 fade-in) that
  carries the text of voice 88 ("Exactly. Those are the cards …"). cmd 20 ignores text, so line 88 is
  never shown or heard; the next Egma record 0x088C647C shows an **empty** window (text = `""`) that
  still waits for ✕. Replay it that way; optionally offer "show orphan line 88".
- Voice ids 1–1093 never played by any dialogue record: 9, 10, 11, 13, 14, 88 (orphan above), 143,
  233, 266, 984, 985, 1021, 1022 (and all of 1094+).

---

## 2. Commands (`msgEventUpdate`, **code**)

Per-frame loop: execute the current command; if it reports *done*, step to the next record and reset
`g_msgAutoAdvanceCounter` and `g_msgFadeHoldCounter` to 0; then apply the "next record belongs to
another script → cmd 8" rule (§1.3). Commands marked *instant* complete on their first frame (the
next command starts on the following frame).

| cmd | Name | Fields | Semantics and timing |
| ---: | --- | --- | --- |
| 0 | TEXT | side, arg = speaker card id (0 = narrator), arg2 = expression, text | `msgEventShowText`, then wait (see §2.1). Arms START-skip. |
| 2 | CLOSE SPEAKER | arg (0 = narrator), side | arg == 0: fade-close the narrator window. Else fade-close that side's text, name and face windows. `winFadeClose(win, 10)`: alpha −10/frame from 128 → gone after 13 frames; done when all are closed. |
| 3 | BG FADE-IN | arg = background id | Selects the loaded bg slot whose id == arg (none → nothing drawn, timing unchanged). Alpha += 1/frame (from its current value, 0 after a reset or cmd 4) up to 128, then a 61-frame hold → done. From alpha 0: **189 frames**. ✕: alpha < 128 → snap to 128; else end. |
| 4 | BG FADE-OUT | — | Alpha −2/frame → 0 (64 frames from 128), then the current bg is cleared. ✕ → 0 at once. |
| 5 | CG HOLD | arg | Not in the data. Alpha +1/frame to 128; ✕ afterwards opens a centred window. Skip. |
| 6 | CG FADE-OUT | arg, arg2 (ignored) | Alpha −2/frame → 0 (64 frames), then no CG. ✕ → 0 at once. |
| 7 | CLOSE ALL | — | Fade-close all 8 event windows (−10/frame, 13 frames); done when all are closed. |
| 8 | END | — | Like 7; when all closed: free bg/CG slots, `winCloseAll`, stop the voice, script over (host scene continues on the same frame). |
| 9 | PRELOAD FACES | arg = card id, arg2 = expression (0 = all 6) | `msgLoadFaces`. *Instant*. The viewer can ignore it (load faces on demand). |
| 10 | WAIT LOADS | — | Not in the data. |
| 11 | FREE FACES | — | *Instant* in practice. Ignore. |
| 12 | LOAD CG | arg = chara.one 3000 member | Loads into the next of 4 CG slots (ignored when 4 are used or arg ≤ 0); waits for the load (1+ frames). Not drawn until cmd 20. |
| 14 | LOAD BG | arg = chara.one 2000 member (1–10) | Next of 4 bg slots; waits for the load. Not drawn until cmd 3. Debug string "CMsgBackLoad". |
| 16 | FREE PICTURES | — | Frees all bg and CG slots, counts = 0, clears the current bg/CG and scroll mode. *Instant*. |
| 17 | BG SCROLL | — | `msgEventBgScrollStart`, see §3.6. *Instant*. |
| 18 | AUTO TIMER | arg = frames | Sets the text auto-advance delay (0 = wait for ✕). *Instant*. Data: 110 (prologue narration), 80 (stage-18 ending narration), 0 to switch back. |
| 19 | CG ZOOM | arg, side = start %, arg2 = end % | Not in the data. Scale +1 %/frame from `side` until it equals arg2. |
| 20 | CG FADE-IN | arg = CG id, arg2 = 100 | Selects the CG slot with that id, scale 100 %, alpha 0 → +1/frame → 128, then 61-frame hold → done (**189 frames**). ✕ snaps / ends. The text field is ignored. |
| 21 | SYNC | — | Waits until every event window's voice lock (win+0x74) is 0 (≤ 30 frames after the last voice started), then stops the voice if it is still playing → done. Always just before 7/8. |
| 22 | BGM PLAY | arg = BGM id | `bgmPlay(0, arg)` = `at3/BGM_{arg+1:02}.at3`, streamed and **looped forever** (see §4.1). *Instant*. |
| 23 | BGM STOP | — | `bgmStop(0)`, no fade. *Instant*. |
| other | — | — | *Instant* no-op. |

There are **no** commands for screen shake, flashes, colour fades of the whole screen, sound effects,
face positions or waits other than the above: "fades" exist only as bg/CG alpha (over whatever is
behind them) and window alpha.

**START (skip)**: once a cmd 0 has run, pressing START jumps to the next record with cmd 21 (or to cmd 8
→ treated as 21), i.e. skips to the end of the script; the windows then close normally.

### 2.1 Waiting on a text line (cmd 0 → state 1)

Manual (timer 0, all speaker lines):
1. The text window of the record's side is polled with `winUpdateInput` each frame (this also enables
   the "next" arrow).
2. ✕ while typing → `winFinishText` (rest of the text appears at once).
3. ✕ when the text is complete (or at a page break) and the voice is still playing → the voice is
   stopped, but only once the voice lock (30 frames after it started) has run out; nothing else.
4. ✕ when complete and the voice is idle → advance (stop voice). At a page break: SE + next page.

Auto (timer T > 0; used only for narrator lines):
- Every frame where the narrator window's text is complete **and** the voice is idle,
  `g_msgAutoAdvanceCounter += 1`; advance when it reaches T. So: line appears → voice + typing →
  voice ends → T frames → next line.
- The auto check looks only at the narrator window (win2). No arrow is drawn in auto mode.

A new line on a side whose windows are still open does **not** reopen them: the text is replaced
(old glyphs vanish, new ones type in), the face image switches instantly to the new expression, and
the name plate stays (the data never changes the speaker of an open side — **data**).

---

## 3. Rendering

### 3.1 Draw order per frame (`msgEventDraw`, **code**)

1. The host scene underneath (**code**). Every frame starts cleared to black (`sceGuClear(0x17)` in
   `main` at 0x0884821C, clear colour 0 from `guInitDisplay`).
   - **Prologue** (`newGamePrologueScene`): black. The etc.one 20/1 backdrop belongs to the name entry
     and is freed (`menuFullscreenBg(…, −1)`) before `msgEventStart`; the per-frame draw call then
     finds the sprite unloaded and draws nothing.
   - **Stage start** (`mapBoardScene`): the map board. On a new board the layer flags
     `g_mapDrawFlags` (0x08A1BD98) are 3, so only the terrain (`mapDrawTerrain`) and the units
     (`mapDrawAllUnits`) are drawn: no status HUD, cursor or hand panels. The area-name window
     opens after the event.
   - **Turn events** (`mapTurnStartUpdate`): the running map board with whatever layers are on.
   - **After win/loss** (`duelResultScreenUpdate` states 0xD/0xE): black. When the event starts, the
     result screen's layer flags are reduced to 0x40, so `duelResultScreenDraw` draws only
     `msgEventDraw`: the portraits, banner, stats and reward cards disappear, and the map board is not
     drawn either. The result BGM (BGM_12 after a win, BGM_17 after a loss) keeps playing.
   - **Stage clear** (`stageClearEventScene`): black (it draws nothing but `msgEventDraw`).

   For a stand-alone viewer, black is correct for everything except the stage-start and turn events.
2. Background (`msgEventDrawBg`).
3. CG (`msgEventDrawCg`).
4. Windows, in window-list order (later = on top): each window's frame, then its glyphs, then its face.

Background and CG are drawn with `spriteDraw(…, z 0, …)` (`msgEventDrawBg` / `msgEventDrawCg`; the
CG's z is ctx+0x64, 0 in practice) and the windows with depth 0, so everything has GE z 0x7FFF. The
host's depth test is GEQUAL (on for the map board, which calls `gfxClearDepth(1)` before its windows),
so equal depths pass and painter's order decides. (The viewer used a different depth for the
picture than for the windows until 2026-09-27; on the map board, where the test is on, the windows of
every stage-start event disappeared as soon as its background or CG faded in. The stand-alone story
view and the prologue draw without a depth test and were not affected.)

### 3.2 Event windows

`g_msgEventCtx` + 0x74 holds 8 windows of 0xA4 bytes: win0 text side 0, win1 text side 1,
win2 narrator, win3 unused, win4 name side 0, win5 face side 0, win6 name side 1, win7 face side 1.

Target positions (`g_dwMsgEventWinPos` 0x088D6BD0, floats): text0 (168, 82), text1 (8, 306),
name0 (168, 32), face0 (8, 32), name1 (8 → set at run time to 472−30−161 = **281**, 256), face1 (472, 256).

Geometry (virtual px). "Start" is where the window opens; each frame while the side's text window is
open, `pos −= (pos − target)/8` (`winApproachPos`, float) and alpha += 8 (max 128). Face x is then
rounded (`(int)(x+0.5)`).

Modes 0–8 (all scripts except turn events):

| Window | Size | Start | Target | Style | Alpha at open |
| --- | --- | --- | --- | --- | --- |
| text, side 0 | 464×110 | (232, 18) | (168, 82) | 10 | 128 |
| name, side 0 | 191×50 | (232, −32) | (168, 32) | 10 | 0 (→ +8/frame, 16 frames) |
| face, side 0 | 160×160 | (−56, 32) | (8, 32) | 10, chamfer 16 | 0 (→ +8/frame) |
| text, side 1 | 464×110 | (−56, 370) | (8, 306) | 10 | 128 |
| name, side 1 | 191×50 | (217, 320) | (281, 256) | 10 | 0 |
| face, side 1 | 160×160 | (536, 256) | (472, 256) | 10, chamfer 16 | 0 |
| narrator | 640×130 | (0, 318) | fixed | 1, chamfer 0 | 128 |

Mode 9 (turn events, all on side 0): face (−64, 288) → (0, 288); name (224, 274) → (160, 288);
text 464×110 (224, 324) → (160, 342).

General width rules (`msgEventOpenWindows`): text w = 640 − 2·8 = 624, minus 160 when the line has a
face (expression > 0); text h = 160, or 110 when there is a name plate (speaker > 1000). Every speaker
line in the data has both (**data**), so the table above is all that occurs.

Result on screen (virtual): side 0 = face top-left, name plate above the text box to its right;
side 1 = face bottom-right, name plate right-aligned above the text box, touching the face.

**Dimming** (**code**): text windows have flag 0x800. Each line brings its text window to the front of
the window list; a flagged window that is not last loses 8 brightness per frame down to 0x38 (56/128)
and the front one gains 8 up to 0x80. The same side's name plate and face copy the text window's
brightness every frame. So the side that is not speaking fades to 44 % grey in 9 frames. Brightness
multiplies RGB of the frame, glyphs and face; alpha is unchanged.

**Closing**: alpha −10/frame (13 frames), glyphs are clamped to the window alpha, so everything fades
together. No movement on close.

### 3.3 Window look

Every window style is described in [windows.md](windows.md).

- **Style 10** (speaker text, name plate, face panel) = the duel window look (effects.md "Duel
  windows", `winStateDrawFramed`): octagon fill RGB (32,32,32) → 4-bit (34,34,34), alpha 0x70/128 ×
  window alpha/128 (221/255 when opaque), chamfer = win+0x20 (5 for text/name, 16 for faces); 9-slice
  frame from the top-left 64×64 cell of skin 13 = etc.one 1/14 (corners 20×16); frame colour
  (bright, bright, bright, windowAlpha).
- **Style 1** (narrator): the fill only, chamfer 0 → a plain translucent rectangle (0,318)–(640,448).
  No frame, no arrow.

### 3.4 Text layout

All event windows use glyph size 22 (`winOpenMessage(…, glyphW 22, lineH 22, …)`):
- advance `(22+1)>>1` = **11** px per glyph or ASCII space; full-width space 0x8140 = 5 px;
- line height **22**; lines per page = floor(h/22): 5 (text 110), 5 (narrator 130);
- glyph scale x = 22/18·0.8 = 0.9778, y = 22/18 = 1.2222 of the 16×16 gothic16 cell;
- glyph **centre** (virtual) = `(trunc(0.9778 + winX + offX + cursorX), trunc(1.2222 + winY + offY + lineY))`,
  where `off` = (15, 15) for style 10, (10, 10) for style 1 (`g_winTextOffsetByState` 0x088F3FD0);
- narrator only: `cursorX` and the line-start x (win+0x4E) are set to **100**, so its text starts
  100 px in; speaker windows start at 0;
- colour = palette 0 (white) with the fullfont halo, RGB × brightness, alpha from 0 +4/frame
  (32 frames) clamped to the window alpha.
- Parsing = `msgParseNextGlyph` (database.md / effects.md): letters, digits and `- + .` are 1 byte; any
  other byte < 0x41, 0x5B–0x60 or ≥ 0x7B takes **two** bytes (ASCII punctuation swallows the next
  space — the texts are written with double spaces for that reason); `＠ｎ` new line; `＠ｖN` voice.
  Only `＠ｖ` and `＠ｎ` occur in story text (**data**: the 1081 lines).

**Typewriter** (`menuWinUpdateAll` with typeDelay 4, set by `winSetText(win, text, 4, 0)`):
the first parse step happens on the frame the line appears, then one step every **4 frames**
(15 per second). A step is: one glyph, or one ASCII space, or one `＠ｖ` tag; `＠ｎ` costs no step
(the glyph after it comes in the same step). A page break (more than 5 lines) waits for ✕ — does not
occur in the data (max 3 lines).

### 3.5 Face portrait

- Image: chara.one entry = speaker card id (1001–1011), member = expression (1–6)
  (`winOpenFace` key = expr·100 + charaIdToIndex; `msgLoadFaces` fills the cache from chara.one).
- Sizes (**data**): 160×176 (1001–1003, 1005, 1006, 1011), 160×192 (1004, 1007, 1009), 192×192 (1008),
  192×208 (1010) — virtual pixels, so taller than the 160×160 panel.
- Placement (**code**, `menuWinUpdateAll`): anchor bottom-centre (`spriteSetAnchor(2)`), scale
  (w/160, h/160) = 1.0, drawn at **(win.x + win.w/2 + 8, win.y + win.h − 8)** = (x+88, y+152) virtual.
  Not mirrored on either side (flag 0x20000 is never set). The image sticks out above the panel.
- Colour (bright, bright, bright, α) with α = min(faceFade, window alpha); faceFade starts at 0 when
  the window opens and grows +8/frame. On an expression change the new image appears at once.
- Draw order: after the panel's fill/frame; before later windows.

### 3.6 Background (chara.one 2000/1–10, 480×272)

- Native, top-left at (0,0), colour (128,128,128, α) = unmodulated with alpha α (fade over what is
  behind). α per cmd 3/4.
- Scroll mode (cmd 17, prologue only): the loaded bgs are stacked top to bottom starting with the
  current one; y starts at 0; every 7 frames y −= 1 until y = −(bgCount−1)·272. Prologue: bgs 1,2,3 →
  544 px in 3808 frames (63.5 s); alpha from cmd 3 still applies. cmd 16 ends scroll mode.

### 3.7 CG (chara.one 3000/10001–10015)

- Native, centred (anchor 0x10) at **(240, 136)**, scale arg2/100 = 1.0, colour (128,128,128, α).
- Sizes (**data**): 480×272 (10001, 10002, 10004–10006, 10009), 400×240 (10010–10015), 256×128
  (10003), 640×448 (10007, unused).

### 3.8 "Next" arrow (`winDrawNextArrow`, style ≥ 7 windows)

Shown when the window is being polled for input (manual mode), the voice is idle and the text is
complete (or at a page break). Sprite: skin 6 = option.one 20/7, frame f = `(t>>2) mod 6`
(`uiAnimCounter(4)`: 4 frames per image, 24-frame loop), source rect (24f, 0)–(24f+24, 32), colour
(128,128,128, windowAlpha), scale 1, drawn with its **top-left** corner at **(x + w − 42, y + h − 40)**
virtual (**code**). Skin 6 is sprite 0x08B3EFE8 (`g_winSkinSprites` + 6·0x204). Nothing ever sets its
position offset (+0x10C) or pivot: `spriteInit` clears them, loading does not touch them, and the only
code that uses the sprite is `menuWinSysInit` and `winDrawNextArrow`. `spriteUpdateVertices` puts the
corners at offset + (0|w, 0|h), and the pivot only moves the centre of scale and rotation, so the draw
position is the top-left corner. The general formula is x + w − 32 (−10 more for style ≥ 7), using
x − w/2 instead of x for centred windows (flag 0x4000) and minus 100 more when flag 0x40000 is set and
(short)win+0x6C ≠ 0. Neither case applies to event windows.

---

## 4. Voice

- The `＠ｖN` tag is the first thing in every spoken line, so the voice starts on the **first frame the
  line appears**, before the first glyph (**code**: parsed by the first typewriter step).
- N is the vagId directly: `sndPlayVoiceVag(N)` → goc.dat clip N−1 (`g_vocGocClipTable`).
- At the tag the parser **stalls** (retries each frame) while a file load is pending or the previous
  voice is still playing. Replays never hit this because advancing already requires an idle voice.
- It also sets the window's voice lock win+0x74 = 30 (−1 per frame).
- Text keeps typing while the voice plays; the line **cannot advance until the voice has finished**
  (auto mode waits; manual ✕ first stops the voice, and only after the 30-frame lock).
- Voice stops at: ✕ as above, advancing (stop if still playing), cmd 21, cmd 8, START skip.
- If `winFinishText` (✕ while typing) runs before the tag was parsed, the tag is skipped
  (flag 0x100000); irrelevant since tags come first.
- Voice volume: `_DAT_08b3c5d8` (channel 0); BGM keeps playing under the voice (no ducking seen **?**).

### 4.1 BGM looping (**code** + **data**)

- `bgmPlay(ch, id)` → `at3StreamStart(g_pBgmPaths[id], 0, flags 0)` starts the streaming thread
  `at3StreamThread` (0x088A57BC). `at3StreamOpen` (0x088A5878) reads the first buffer, calls
  `sceAtracSetDataAndGetID`, then **`sceAtracSetLoopNum(id, −1)`** (0x088A5944): loop forever.
  `at3StreamDecodeLoop` (0x088A5998) decodes and refills (`sceAtracAddStreamData` when the remaining
  frames drop to half, unless `GetRemainFrame` returns −1/−2) until sceAtrac reports the end, which
  never happens with loop count −1. The track stops only on `bgmStop` or a new `bgmPlay`. There is no
  manual restart: `bgmRestart` just calls `at3StreamStart` again from the start.
- sceAtrac takes the loop points from the RIFF `smpl` chunk. All 17 `BGM_nn.at3` files have exactly
  one loop, from sample `fact.skip` (the encoder delay, 2213–4070) to `skip + fact.samples − 1`. That
  is the whole track, so it restarts seamlessly from its first real sample. A player that drops the
  encoder delay and loops the whole decoded track (the viewer) matches the game.
- If a file had no loop info, `SetLoopNum` would fail with only a debug print and the track would play
  once. No BGM file is like that.

---

## 5. Replaying without input

Exact behaviour needs ✕ presses only for speaker lines (cmd 0 with timer 0) and optionally to shorten
cmd 3/20 holds. Suggested auto-play, derived from the game's own timings:

```
lineReady  = typing finished && voice ended
advance when lineReady has held for D frames
  D = the script's timer when cmd 18 set one (110 / 80, exact)
  D = 60 for speaker lines (suggestion; the game's own auto delays are 80–110, cmd 3/20 hold 61)
cmd 3 / 20: play the full 189-frame fade + hold (exact without input)
```
Per-line duration ≈ max(4·steps, voiceLength) + D. A skip button = START (jump to the next cmd 21).

### 5.1 Player state machine (reference)

```ts
type Rec = { key: number; cmd: number; side: number; arg: number; arg2: number; text: string }
state: { i, timer=0, autoCnt=0, holdCnt=0,
         bg: { slots: number[], cur: 0, alpha: 0, scroll: null|{y, target, t} },
         cg: { slots: number[], cur: 0, alpha: 0, scale: 100 },
         wins: EventWindow[8], voice }
each frame:
  switch (rec.cmd) {
    case 0:  if first frame: showText(rec)            // §3.2–3.4, starts voice at step 0
             done = timer ? (lineReady && ++autoCnt >= timer)   // auto
                          : userOrAutoplayAdvance()           // §2.1 / §5
    case 2:  fadeClose(side windows or narrator); done = all closed
    case 3:  bg.cur = slotOf(arg); if (bg.alpha < 128) bg.alpha++ ; else if (++holdCnt > 60) done
    case 4:  bg.alpha = max(0, bg.alpha-2); if 0 { bg.cur = 0; done }
    case 6:  cg.alpha = max(0, cg.alpha-2); if 0 { cg.cur = 0; done }
    case 7:  fadeClose(all); done = all closed
    case 8:  fadeClose(all); if all closed { freePictures(); stopVoice(); END }
    case 12: cg.slots.push(arg) (≤4); done
    case 14: bg.slots.push(arg) (≤4); done
    case 16: freePictures(); done
    case 17: bg.scroll = { y: 0, target: -(bg.slots.length-1)*272, t: 0 }; done
    case 18: timer = arg; done
    case 20: cg.cur = slotOf(arg); cg.scale = 100; (first frame alpha = 0)
             if (cg.alpha < 128) cg.alpha++ ; else if (++holdCnt > 60) done
    case 21: done = voiceLock == 0 (then stopVoice())
    case 22: playBgm(arg + 1); done
    case 23: stopBgm(); done
    default: done
  }
  if done { i++; autoCnt = holdCnt = 0; if (next belongs to another script) next.cmd := 8 }
  draw: windows approach targets (/8), alpha +8; bg (scroll: every 7th frame y-- until target), CG, windows
```
Note cmd 3 increments alpha then clamps at 128 and counts the hold on the same frame; from alpha 0 the
command lasts 128 + 61 = 189 frames. The bg/CG alpha is kept between commands (only 4/6/16 clear it).

---

## 6. Open points

- Exact look of the event text window vs. the duel windows: same draw function (style 10), but the
  skin/fill values are the ones effects.md derived for the duel; not compared with a screenshot.
- Resolved from code: the next-arrow origin is top-left (§3.8), the BGM loops (§4.1), the first
  stage-1 turn event is round 1 (§1.5), and the host-scene underlay is known (§3.1).
