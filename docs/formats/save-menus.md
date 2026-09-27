# Save data, menus and ad-hoc play

How the game saves, the exact layout of its save files, the menu scenes and their rules, and the
ad-hoc versus protocol. Everything is read from the USA EBOOT (`Neverland_Card_Battles_USA.elf`, base
0x08804000). Function and global names are the ones given in Ghidra.

Board rules are in [rules.md](rules.md), card effects in [card-effects.md](card-effects.md), the AI in
[ai.md](ai.md). This document names the board globals only where they are written to the save file.

PSP button masks used below: ✕ = 0x4000 (confirm), ○ = 0x2000 (cancel), △ = 0x1000, □ = 0x8000,
L = 0x100, R = 0x200, d-pad up/right/down/left = 0x10/0x20/0x40/0x80.

## 1. Save data

### 1.1 Imports (NIDs resolved)

The EBOOT's stub names were missing; the stubs were named from their NIDs.

| Library | Functions used | Stubs |
| --- | --- | --- |
| sceUtility | LoadModule, UnloadModule, GetSystemParamString, MsgDialog{InitStart,Update,GetStatus,ShutdownStart}, Savedata{InitStart,Update,GetStatus,ShutdownStart}, Netconf{InitStart,Update,GetStatus,ShutdownStart} | 0x088A618C–0x088A6200 |
| sceNet | Init, Term, GetLocalEtherAddr, EtherNtostr | 0x088A635C |
| sceNetAdhocMatching | Init, Term, Create, Delete, Start, Stop, SelectTarget, CancelTargetWithOpt, SendData | 0x088A637C |
| sceNetAdhoc | Init, Term, PdpCreate, PdpDelete, PdpSend, PdpRecv, GetPdpStat | 0x088A63C4 |
| sceNetAdhocctl | Init, Term, AddHandler, DelHandler, Scan, Disconnect, GetState, GetPeerInfo, GetNameByAddr, GetParameter | 0x088A63FC |

### 1.2 How the game saves (code)

All saves go through one `SceUtilitySavedataParam` at `savedata_param` (0x09DB7444). The layer is
Sony's `sample/utility/savedata`, lightly modified: `SetData_Normal` (0x088A2894, ex saveSetupParams)
fills it, `CB_SaveData_Normal(op)` (0x088A274C, ex saveUtilStart) starts the utility and
`Savedata_Update` (0x088A229C, ex saveUtilUpdate) drives it every frame.

| Field | Value |
| --- | --- |
| gameName | `ULUS10382` |
| file name | `CADATA.SAV` (both kinds of save) |
| **key** (+0x5DC) | the 16 ASCII bytes `aOiupxRNZIFU2m6Q` (`g_saveGameKey` 0x08989B5C) |
| overwrite | 1 |
| SFO title | `Neverland Card Battles` |
| parental level | 5 |
| ICON0 | embedded PNG 0x088FDBC8 |
| PIC1 | embedded PNG 0x0890AC68 |
| SND0, ICON1 | none |
| new-slot icon | PNG 0x08983C30, title `No Data` |

**The data is encrypted.** The game passes a game key, so the savedata utility encrypts `CADATA.SAV`
(the keyed "secure" mode; the firmware chooses the version). The game itself adds **no checksum and no
encryption** of its own: after decryption the file is the raw structure described below.
`saveLogResult` only prints the utility's error codes ("Data Broken" is the utility's own hash check).

There are two kinds of save:

| Kind | Directory | Size | Modes | Written by |
| --- | --- | --- | --- | --- |
| **Game data** (3 slots) | `ULUS1038200`, `ULUS1038201`, `ULUS1038202` (saveNameList `"00"`,`"01"`,`"02"`) | 0x494 (1172) | LISTSAVE / LISTLOAD | camp menu → System → Save / Load, title → Load, battle mode |
| **Continue** (temporary / suspend) | `ULUS10382` (saveName `""`) | 0x287CC (165 836) | SAVE / LOAD, then AUTODELETE | map board → "Temp save"; title → resume |

- Game data: savedataTitle `Data of <player name>` (`s_saveDataOfFmt`, the name from the serialized
  header). Detail (`SetData_GameData`, ex saveSetDataBuffer, format `s_saveDetailFmt` 0x088FDAF0):
  `Cards: <n>（<k> types）` then `Deck　　1.<name>` / `2.<name>` / `3.<name>`, where n / k are the
  serialized **profile's** totalCards / cardKinds (+0x1BC / +0x1C0, not the header's) and the names
  the serialized decks. The text is converted from Shift-JIS to UTF-8 by `saveSjisToUtf8`.
- Continue: detail `Temporary Data` (message table 0x088A9244, entry 3).
- **After the continue save is loaded, it is deleted** at once: `Savedata_Update` calls
  `saveDeserializeContinue`, sets `g_resumeLoaded` and starts `CB_SaveData_Normal(10)` (AUTODELETE of
  `ULUS10382`). The title's "resume" screen warns about this.
- The continue save keeps the utility's current savedataTitle: `SetData_Paramsfo_String(…, 0)` only
  copies a title when its second argument is 1, so it is `NCB GAME DATA` (the `saveParamInit`
  default) or the last `Data of <name>`. The unused continue title `CARDINAL ARC CONTINUE DATA`
  belongs to the dead EXPORT.BIN path.

`CB_SaveData_Normal(op)` maps `op` to a mode through `g_saveModeTable` (0x088A9274):

| op | Mode | Use |
| ---: | --- | --- |
| 3 | LOAD (2) | load the continue save (`saveDataScene(2)`) |
| 4 | SAVE (3) | write the continue save (`saveDataScene(3)`) |
| 5 | LISTLOAD (4) | load game data (`saveDataScene(0)`, scene 0x44C) |
| 6 | LISTSAVE (5) | save game data (`saveDataScene(1)`, scene 1000) |
| 8 | LISTALLDELETE (7) | offered after a "no space" error ("Delete data to create free space?") |
| 10 | AUTODELETE (9) | delete the continue save after it was loaded |
| 9, 13 | SIZES, FILES | helper setups; not reached from the game's call sites |

`saveDataScene(op)` (0x088A148C) is the wrapper used by the scenes: 0 load game, 1 save game, 2 load
continue, 3 save continue, −1 returns 1 at once (the boot "memory card" step, scene 10). It returns
0 busy, 1 done, −1 cancel, and calls `rand()` on every call (**code**):

| State | What happens |
| --- | --- |
| 0 | `CB_SaveData_Normal(4 / 3 / 6 / 5)` for op 3 / 2 / 1 / 0 (the SAVE ops serialize the data here, in `SetData_GameData`); op 3 also sets the detail `Temporary Data` |
| 1 | busy until the utility has shut down (`GetUtilityType() == UType_None`); `Savedata_Update` has by then deserialized a good op-5 load, or deserialized a good op-3 load and started the AUTODELETE (so the scene stays busy during the delete). Result 0 → **done**; 2 → state 2; the no-space codes 0x80110383 / 0x80110323 → state 0x14; anything else (cancel 1, no data, broken data) → **cancel** |
| 2 | the game's own windows `An error has occurred.` (300, 136, size 22, flags 0xF000) and `＠ｂ３Ｂａｃｋ` (260, 180, size 18, 0x3000); ○ → cancel. **Unreachable**: the savedata utility never returns 2 |
| 0x14 | `Delete data to create free space?` (300, 136, 0xF000) and `＠ｂ０Ｙｅｓ ＠ｂ３Ｎｏ` (260, 180, 0x7000); ✕ → `CB_SaveData_Normal(8)` (LISTALLDELETE) and state 1, whose result 0 then returns **done although nothing was saved** (quirk); ○ → cancel |

Everything else the player sees (the slot list, "The data will be overwritten…", "Save completed.")
is the PSP firmware's dialog. The Sony sample's message strings are still in BOOT.BIN
(`g_mcConfirmMessages`: `New data will be created. Do you want to continue?`, `The data will be
overwritten. Do you want to continue?`, `Save completed.`, `Load completed.`, `Abort save?`, `Abort
load?`, `Erase data?`; `Processing cancelled.`, the no-space format and the empty-slot title `No
Data`), but only the dead MC dialog flow uses them.

**Dead code**: ops 0x02000000–0x06000000 and `saveExportDispatch` (0x088A34B4) read/write
`EXPORT.BIN` in `ULJM05365` (the Japanese release, *Cardinal Arc*) with the non-secure MAKEDATA /
WRITEDATA / READDATA modes and the title `CARDINAL ARC CONTINUE DATA`. Nothing calls them.

### 1.3 In-memory structures that are saved

| Global | Address | Type | Size |
| --- | --- | --- | --- |
| `g_playerProfile` | 0x089D184C | `PlayerProfile` | 0x2FC |
| `g_playerDecks` | 0x089C9F68 | `PlayerDeck[3]` | 3 × 0x60 |
| `g_saveHeader` | 0x089D1E68 | `SaveHeader` | 0x78 |
| `g_duelPlayers` | 0x089D1B48 | `DuelPlayer[4]` | 4 × 0xC8 (continue only) |

Each is copied field by field, with no padding changes, so the memory layout **is** the file layout.

#### PlayerProfile (0x2FC)

| Off | Type | Field | Notes |
| --- | --- | --- | --- |
| 000 | char[24] | name | Shift-JIS, NUL-terminated. Entered at New Game ("This name will be displayed for VS mode and save data"). |
| 018 | u32 | unk18 | Cleared at New Game, never read in story mode. Battle mode writes the chosen Dominator's card id into this field of its own profile copy. **inferred** |
| 01C | u8[207] | cardCount | **Owned copies** per card index 0–206 (index 0 unused, but counted by `cardCountCollection`; a reward slot of id 0 would add to it). This is the array named `g_cardKnownFlags` (0x089D1868) in older notes. Rewards only add a copy while the count is < 10, so the maximum is 10. |
| 0EB | u8[207] | cardNewFlags | Per card index. Bit 1 = got a first copy ("New"), bit 0 = got a copy ("Get"); drawn in the card list and deck editor. Indices 1–206 are cleared by each reward roll (index 0 is not); the special cards OR in 3. |
| 1BA | u8[2] | pad | |
| 1BC | u32 | totalCards | Sum of `cardCount[0..206]` (`cardCountCollection`, index 0 included); recomputed whenever the camp status window is drawn, not at save time. |
| 1C0 | u32 | cardKinds | Number of nonzero `cardCount[0..206]` entries (collection rate = kinds × 100 / 206). |
| 1C4 | u32 | stageClearMask | Bit `s−1` set when story stage `s` is won (see §2.4). |
| 1C8 | u32[19] | mapBattles | Battles fought on stage `s` at index `s−1` (stage 18 counts as 17); stops at 0xFFFF. Story and free battles only, counted when the result screen closes (state 0x10). |
| 214 | u32[19] | mapWins | Wins on stage `s` at index `s−1`; only counted while the battle counter is still below 0xFFFF. |
| 260 | u32[19] | charaBattles | Battles against player 1's Dominator, indexed by `charaGetLadderIndex(id)` (the last ladder index holding the id). |
| 2AC | u32[19] | charaWins | Wins against each opponent (same index). Camp status: win rate = Σwins × 100 / Σbattles. |
| 2F8 | u8 | curDeckSlot | Selected deck, 1–3. |
| 2F9 | u8[3] | pad | |

**Card index** (`cardIdToIndex` / `cardIndexToId`, see [database.md](database.md)):
1–122 units (the unit whose `CardDef.seqNo` equals the index), 123–190 spells (`g_cardDefSpells[i−122]`
in table order), 191–206 bases (`g_cardDefBases[i−190]`). Characters (207–227) are never collected and
are not in these arrays.

#### PlayerDeck (0x60)

| Off | Type | Field | Notes |
| --- | --- | --- | --- |
| 00 | char[24] | name | `""` = empty slot. |
| 18 | s16[31] | cards | `[0]` = Dominator card id (always 1001 Galahad in the player's decks), `[1..30]` = card ids. |
| 56 | u8[2] | pad | |
| 58 | u32 | unk58 | Written only by New Game (0), deck copy and load. **unknown** |
| 5C | u32 | unk5C | Same. **unknown** |

New Game creates deck 1 from the starter deck of Dominator 1001 (`dbGetDeckByDominator(1001, …, 1)`,
see `g_deckDefs`) and sets `cardCount` from its 30 cards; decks 2 and 3 are empty.

#### SaveHeader (0x78)

| Off | Type | Field | Notes |
| --- | --- | --- | --- |
| 00 | char[24] | playerName | Copy of `PlayerProfile.name`. |
| 18 | char[3][24] | deckNames | Copies of the 3 deck names. |
| 60 | u32 | unk60 | **unknown** (only cleared and copied) |
| 64 | u32 | playTime | Packed bitfield: bits 0–7 frames, 8–13 seconds, 14–19 minutes, 20–31 hours. The per-frame updater 0x088490F8 rewrites it unchanged in this build, so it stays 0. The title uses it as the random seed. **inferred** |
| 68 | u32 | clearMask | Copy of `stageClearMask`. |
| 6C | u8 | unk6C | **unknown** |
| 70 | u32 | totalCards | Σ cardCount. |
| 74 | u16 | cardKinds | Nonzero entries. |
| 76 | u8[2] | pad | |

The game never reads the header back into logic: it only feeds the save-list text. Loading game data
copies it to `g_saveHeader`.

#### Unused engine block (0x089CA08C)

The BSS between `g_playerDecks` (ends 0x089CA088) and `g_playerProfile` (0x089D184C) holds the
tables behind the script's "game" functions. It is an RPG-engine leftover (**code**):
- nothing initialises it, the game never writes it, and it is not saved;
- only the script builtins below access it, and no CAS1 script calls them;
- the message tags `＠ｄ`/`＠ｈ`/`＠ｋ` read it, but no game text uses those tags.

Everything in it therefore stays 0.

| Address | Content | Accessed by |
| --- | --- | --- |
| 0x089CA090 | s16 current party slot | 0x10E, `＠ｋ` |
| 0x089CA092 | u8[] item counts (0–99) | 0x12C–0x12E, window list mode 7 (`menuWinUpdateAll`) |
| 0x089CA104 | u32 packed date: year = bits 9–22, month = bits 5–8, day = bits 0–4 (DOS style) | 0x10F (returns year and month only) |
| 0x089CA550 / 552 | u16 sequence counter / lock | 0x106–0x108 |
| 0x089CA5A8 | party table, stride 0x3C: +0 u32 flag bits, +8 u8 character index, +9 u8 | 0x127/0x128, `＠ｋ` |
| 0x089CAAB8 | character table, stride 0x5C: +0 u16 flags (bit 0x4000), +2 name | 0x11B, `＠ｈ`, `＠ｋ` |
| 0x089CFE0C | item table, stride 0x3C: +0 name, +0x19 u8 icon | `＠ｄ`, list mode 7 |

### 1.4 Game data file (`ULUS103820x/CADATA.SAV`, decrypted, 0x494 bytes)

`saveSerializeGameData` (0x0882D6B8) / `saveDeserializeGameData` (0x0882D514). **code**

| Off | Size | Content |
| --- | --- | --- |
| 000 | 0x2FC | `PlayerProfile` |
| 2FC | 0x120 | `PlayerDeck[3]` |
| 41C | 0x078 | `SaveHeader`: a memcpy of `g_saveHeader`, in which `sprintf` rewrites the player name and the 3 deck names (the bytes after each NUL stay), `clearMask` = profile+0x1C4, and `totalCards` / `cardKinds` are recounted over `cardCount[0..206]` (index 0 included). `g_saveHeader` itself is not changed |

The profile is copied field by field, so its pads (+0x1BA, +0x2F9) keep the bytes of
`g_saveGameDataBuf`, the buffer shared by save and load. The decks and the header are memcpy'd.
The names go through `sprintf` as **format strings** (a `%` in a name would be interpreted).

There is **no checksum** inside the file. To edit a save, the viewer only has to keep the file
consistent: set `totalCards` / `cardKinds` (profile +0x1BC/+0x1C0 and header +0x70/+0x74) and the header
copies of the name, deck names and clear mask. The game recomputes the profile counts itself, so
stale values are harmless.

**Validation a parser can use** (no magic number exists):
- file size is exactly 0x494;
- `cardCount[i] ≤ 10`, `cardCount[0] == 0`, `curDeckSlot ∈ 1..3`;
- every non-empty deck has `cards[0]` in 1001–1021 and 30 card ids that `cardIdToIndex` accepts, with
  ≤ 3 copies of each card;
- the header name equals the profile name.

### 1.5 Continue file (`ULUS10382/CADATA.SAV`, decrypted, 0x287CC bytes)

`saveSerializeContinue` (0x0882D900) / `saveDeserializeContinue` (0x0882E1F8). It is a full snapshot of
a map battle in progress. **code** for the offsets; board-field meanings are in [rules.md](rules.md).

| Off | Size | Source | Content |
| --- | --- | --- | --- |
| 00000 | 0x78 | `g_saveHeader` | `SaveHeader` |
| 00078 | 0x2FC | `g_playerProfile` | profile slot 0 |
| 00374 | 0x2FC | — | profile slot 1: only the name (first 24 bytes) is written |
| 00670, 0096C | 2 × 0x2FC | — | profile slots 2 and 3: never written (stale buffer contents) |
| 00C68 | 0x120 | `g_playerDecks` | `PlayerDeck[3]` |
| 00D88 | 4 × 0xC8 | `g_duelPlayers` | `DuelPlayer[4]`: deck, deck state, draw order, hand, cost, Soul, maintenance, income, flags, `bController` (+0xB8: 0 local, 1 remote/CPU), panel |
| 010A8 | 0x2AA0 | `g_mapUnits` 0x089F3C20 | 4 sides × 31 `MapUnit` (0x58 each) |
| 03B48 | 0x1900 | `g_mapGrid` 0x089F66D0 | 800 × 8 bytes |
| 05448 | 0xC80 | `g_mapCellFlags` 0x089F7FD0 | 800 × u32 |
| 060C8 | 0x640 | `g_mapLandAttr` 0x089F8C50 | 800 × u16 |
| 06708 | 0x21340 | `g_mapBaseAuras` 0x089F9290 | 800 × 170 bytes |
| 27A48 | 0x640 | `g_mapRangeGrid` 0x08A1A5D0 | 800 × u16 |
| 28088 | 0x640 | `g_mapSeizeFx` 0x08A1AC10 | 800 × u16 |
| 286C8 | 6 × u8 | | `g_mapId`, `g_mapVariant`, `g_mapStageNo`, `g_gameMode`, `g_numPlayers`, `g_localPlayer` |
| 286D0 | 3 × u32 | | `g_mapLayoutId`, `g_mapRound`, `g_mapTurnPlayer` |
| 286DC | 5 × u16 | | `g_mapGoalPoints`, `g_mapWidth`, `g_mapHeight`, 0x08A1B26A, 0x08A1B26C |
| 286E8 | u32 | | `g_mapFirstTurn` |
| 286EC | 4 × u32 | | `g_mapConquestCount[4]` |
| 286FC | 0xA0 | | `g_mapSeizeTally` |
| 2879C | 4 × u8 | | `g_mapPlacedCount[4]` |
| 287A0 | 10 × u32 | | 0x08A1B328…, `g_mapDeployRules`, …, `g_mapCursorY` (0x08A1B328–0x08A1B34C) |
| 287C8 | u16 | | `g_mapActionFlags` |
| 287CA | 2 | | pad |

Details (**code**):
- Everything is copied **field by field** into `g_saveContinueBufPtr`, the buffer the resume also
  loads into, so every byte that is not written keeps the buffer's old contents: the header and
  profile pads, profile slots 1–3 (slot 1's name only in versus), the deck pad at +0x56, the
  DuelPlayer pads (+0x01, +0x7E, +0xA7, +0xB9..BB, +0xC5..C7) and MapUnit sides 2 and 3 (never
  initialised).
- Versus only: `sprintf(slot k name, unitGetName(side k's Dominator))` for k = 0, 1, which also
  overwrites slot 0's name.
- `g_mapFirstTurn` (0 on a new board, 1 once round 1 starts) is written and read back, nothing else
  reads it. 0x286E2 / 0x286E4 (`g_mapSavedUnused26A` / `26C`), 0x286FC `g_mapSeizeTally` (0xA0
  bytes), 0x287A0–0x287AF (`g_mapSavedUnused328`…`334`) and 0x287C4 (`g_mapSavedUnused34C`) are
  globals that only the save and the load touch: dead.
- 0x286EC–0x286FB is `g_mapConquestCount[4]`; 0x2879C–0x2879F is `g_mapPlacedCount[4]` (u8).
- DuelPlayer +0x98 `dwHandUsable` holds one nibble per hand slot (slot k at bits 4k; 1 usable, 2 not).
- The random generators are **not** saved: a resumed game continues from whatever state `rand` and
  `gameRandNext` have (the title seeds with `srand(playTime)` = 0, and `saveDataScene` calls `rand()`
  every frame).
- After the load, `mapBoardScene` state 0 skips the whole setup (deck reset, units, `mapInitGrid`,
  cursor reset) because `g_mapRound` ≥ 1, and state 1 goes straight to the free cursor (draw flags
  0x1F). The temp save is only reachable from the command ring of an empty square, on the local
  player's turn.

In versus mode (`g_gameMode` 0) the names of profile slots 0 and 1 are the two players' names; in
story mode the load takes the names from the Dominators' card names instead.

### 1.6 Play mode saves (localStorage)

Play mode stores what the utility would write, with the same bytes and no encryption
([play-mode.md](play-mode.md#saves)): `localStorage["ncb.save.ULUS1038200"]` … `…02` (game data,
0x494 bytes, base64) and `ncb.save.ULUS10382` (continue data, 0x287CC bytes), each with a
`….sfo` JSON of the SFO strings above. The serializers are ports of `saveSerializeGameData` /
`saveSerializeContinue` (one-viewer `src/game/profile.ts`, `src/game/continueSave.ts`). Our own
writer and reader round-trip both layouts byte for byte (checked: save → reload → load gives the
same 0x494 bytes; temp save → continue gives the same 0x287CC bytes), which confirms that the
offsets are consistent; the layout is **still not checked against a real PSP save** (open question
2.8). Exported files (`<dir>_CADATA.SAV`) open in the viewer's save view, and a decrypted real
`CADATA.SAV` can be imported.

### 1.7 Viewer recipe

1. **Decrypt first.** The file on the Memory Stick is encrypted with the savedata key
   `aOiupxRNZIFU2m6Q`. A browser tool can:
   - accept an already-decrypted `CADATA.SAV` (from a save tool that uses the game key, or PPSSPP with
     save encryption turned off), and recognise it by size (0x494 or 0x287CC); or
   - decrypt it itself with the PSP savedata algorithm (`sceChnnlsv` / KIRK: AES-128-CBC with the fixed
     KIRK keys and the game key, as in PPSSPP's `chnnlsv.cpp` or SED-PC). That is a few hundred lines of
     JS on top of WebCrypto AES.
2. **Game data (0x494):** read `PlayerProfile` at 0, the 3 `PlayerDeck` at 0x2FC and the header at 0x41C
   (tables above). Show the name, the collection (index → card id with `cardIndexToId`, joined with the
   card database), decks, cleared stages (`stageClearMask` bits 0–17), battle and win counters per stage
   and per opponent.
3. **Continue (0x287CC):** the header, profile and decks are at 0x000, 0x078 and 0xC68. The board
   snapshot can be shown with the field meanings from [rules.md](rules.md).
4. **Editing:** change the fields, keep the redundant copies consistent (§1.4), then re-encrypt. On
   re-encryption the PARAM.SFO hashes (`SAVEDATA_PARAMS`, file hash in `SAVEDATA_FILE_LIST`) must be
   updated, which the same chnnlsv code does. The game itself checks nothing more.

## 2. Menus and scene flow

### 2.1 Scene ids (`g_gameScene`, dispatched in `main` 0x088477D4)

| Id | Scene | Function |
| ---: | --- | --- |
| 0 | boot: init systems, archives, windows | (in main) → 10 |
| 10 | "memory card part": `saveDataScene(−1)` → 1 | → 0x14 |
| 0x14 | LOGO.pmf | → 0x1E |
| 0x1E | OP.pmf (opening movie); the title's attract timeout also returns 0x1E, but then nothing plays (only the LOGO scene starts OP.pmf) | → 0x32 |
| 0x28 / 0x29 | ED000.pmf / ED001.pmf (endings) | → 0x2A |
| 0x2A | after the ending movie | → 0x834 |
| 0x32 | title | `titleScreenScene` 0x08867528 |
| 0x50 | map board (the battle) | `mapBoardScene` 0x0884CDD4 |
| 0x5A | duel | `battleDuelScene` 0x0888A89C |
| 300 | camp menu | `campMenuScene` 0x0881AE60 |
| 0x136 | stage select | `stageSelectScene` 0x0881CF08 |
| 0x140 | deck edit | `deckEditScene` 0x0882ADB8 |
| 0x14A | card list | `cardListScene` 0x0882C4FC |
| 400 | rules help ("How to play") | `rulesHelpScene` 0x0884CC90 — scene 400 is unreachable; the same function runs for the map's Help command ([extras.md](extras.md)) |
| 500 | new game: name entry + prologue + tutorial setup | `newGamePrologueScene` 0x08835654 |
| 0x208 | resume the continue save | `resumeTempSaveScene` 0x08835928 |
| 600 | battle mode (ad-hoc versus setup) | `battleModeMenuScene` 0x08836B94 |
| 1000 | save game data (`saveDataScene(1)`) | returns to `g_saveReturnScene` / `g_saveCancelScene` |
| 0x44C | load game data (`saveDataScene(0)`) | same |
| 0x834 | post-battle story event, stage clear | `stageClearEventScene` 0x0883510C |
| 4000 | ad-hoc lobby | `adhocLobbyScene` 0x0889FE6C |
| 2000, 9000, 0x186, 0x5DC | staff roll, debug menu, test draw, retry | dead (see [database.md](database.md)) |

```
boot → 10 → LOGO 0x14 → OP 0x1E → title 0x32 ─┬─ New Game ──── 500 ── tutorial ─→ 0x50 map
                                               ├─ Load ─────── 0x44C ─ok→ 300 camp / cancel→ 0x32
                                               ├─ Continue ─── 0x208 ─ok→ 0x50 map / cancel→ 0x32
                                               └─ Battle mode ─ 600 ─→ 4000 lobby ─→ 0x50 map
camp 300 ─┬─ Stage select 0x136 ─→ 0x50 map ⇄ 0x5A duel ─ win → 0x834 event ─→ 300
          │                                  (stage 15 → 0x28 ED000, stage 18 → 0x29 ED001 → 0x834)
          ├─ Deck ─ edit/new → 0x140 ─→ 300 ; copy, rename, delete in place
          ├─ Card list 0x14A ─→ 300
          └─ System ─ Save (1000-style dialog), Load, Return to title 0x32
```

### 2.2 Title (0x32)

Four words from etc.one 10/2 (cursor 0–3 with wrap, ↑↓ on the pad repeat, ✕ confirms): **New Game**
(1 → 500), **Load Game** (2 → 0x44C, return 300 / cancel 0x32), **Resume Game** (3 → 0x208), **Versus
Mode** (4 → 600); all four are always selectable (no test for saves or temp data) and there is no
"Press START" step. The 900-frame idle timeout (→ −1 → 0x1E) is only tested while the BGM is **not**
playing, and every BGM loops forever, so it never fires on the console; if it did, 0x1E would play
nothing and return to the title. Details: [title-newgame.md](title-newgame.md#2-title-screen-titlescreenscene-0x08867528-scene-0x32).
The title never returns 5, 6, 99, 0x5A–0x5C or 2000, so the scenes mapped to those results in `main`
(400, 9000, 300, 0x5A, 0x50, 4000) cannot be reached from it.

There is **no options menu**: no option strings or option fields exist, and nothing else is stored.

### 2.3 New game (500) and resume (0x208)

- **New game**: `profileInitNewGame` (0x0882CE7C, run by the title) resets the profile and decks, then
  the name-entry keyboard into `PlayerProfile.name` (full-width Latin page only, at most 11 characters,
  no default name; △ with an empty name returns to the title; [title-newgame.md](title-newgame.md#4-name-entry-nameentryinit--nameentryopenwindows--nameentryupdate)),
  the prologue event 0 and a tutorial battle: Galahad (1001, deck variant 1)
  against Egma (1004, variant 3) on map 1, `g_gameMode` 1, stage 1.
- **Resume**: asks "This data will be deleted after loading", runs `saveDataScene(2)`, then goes
  straight to the map (0x50). The continue save is deleted after the load (§1.2).

### 2.4 Camp menu (300) and stage select (0x136)

The full state machines, windows, coordinates and draw calls of both scenes are in
[camp-stage-select.md](camp-stage-select.md); this section keeps the rules.

Camp menu (window 0x0898AE80, "Search / Build deck / Card list / System"): 0 **Search** (stage
select) → 0x136, 1 **Build deck** → submenu, 2 **Card list** → 0x14A, 3 **System** → submenu. The camp also shows the status windows (`campDrawStatusWindows`):
next unsearched map, number of battles and win rate, number of cards and collection rate, deck names.

- **Deck submenu** (acts on the slot chosen in a second list; sets `curDeckSlot`): 0 edit → 0x140 (needs a
  non-empty slot), 1 new → 0x140 (needs an empty slot: "Please create a new deck after deleting the old
  one"), 2 copy (into an empty slot), 3 rename (name entry), 4 delete ("You cannot delete your only
  deck" when only one deck exists; deleting writes `sprintf(name, "")`, which clears only the first
  name byte, and zeroes the 31 card ids and +0x58/+0x5C). Copying copies all 24 name bytes, the 31 card
  ids and +0x58/+0x5C. The slot list sets `curDeckSlot` before any of these checks.
- **System submenu**: 0 save (`saveDataScene(1)`), 1 load (`saveDataScene(0)`), 2 return to title.

**Stage select.** The player picks an area 1–10 and a block A/B (variant 0/1).
`stageGetLayoutIfUnlocked(area, variant)` (0x0881C17C) returns the stage (layout) id, or 0 when locked:

| Stage | Unlocked when these stages are cleared |
| ---: | --- |
| 1 | always |
| 2, 3, 4, 9, 12–16 | stage `s − 1` (bit `s − 2`) |
| 5 | 3 |
| 6, 7 | 4 and 5 |
| 8 | 6 and 7 |
| 10 | 8 |
| 11 | 9 and 10 |
| 17 | 15 |
| 18 | replaces 17 when all six cards 2612–2617 are owned (Arth, final battle) |

- `g_gameMode` = 1 (**story**) if the chosen stage is not cleared yet, 2 (**free battle**) if it is.
  In free battle the opponent can be changed (← / →) to the character of any cleared stage
  (`charaGetLadderId(stage)`); the board stays the chosen stage's.
- The player's Dominator is always Galahad (1001). The opponent's deck is
  `dbGetDeckByDominator(opponent, …, 3)` in story mode and variant 1 in free battle.
- **Clear bits** (`stageClearEventScene`): winning stage `s` sets bit `s − 1`; stage 18 also sets bit 16.
  Stage 15 is followed by ED000.pmf and stage 18 by ED001.pmf. Stages 15, 16 and 18 play an extra event
  the first time.
- **Special card rewards** (`duelResultScreenUpdate` state 0x10, win only, count 0 → 1, flags |= 3):

| Mode | Condition | Card |
| --- | --- | --- |
| story | clear stage 14 / 11 / 10 / 7 | 2613 / 2615 / 2617 / 2616 |
| free | beat character 1020 | 2614 |
| free | own 2615, 2616 and 2617, not 2612, and the running sum of `charaWins[charaGetLadderIndex(id)]` over id = 1002…1021 exceeds 49 (a counter shared by two ids is added twice) | 2612 |

In free battle 2614 is checked after 2612 and wins when both apply (one card per battle).

- **Normal rewards**: see [Card rewards](#card-rewards) below.

#### Card rewards

`duelRollRewardCards(opponentId)` (0x08832A94) runs when the result screen opens (`duelResultScreenUpdate`
state 1), in story and free battle only (**code**). Versus mode (`g_gameMode` 0) gives no rewards.
`opponentId` is the card id of the Dominator that is not Galahad (1001). The stage, the mode and
first clears play no part: the special cards above are the only stage-dependent rewards.

**Number of cards** (`g_rewardCount` 0x089B605D, max 10):

| Result (`g_resultWinnerSide`) | Cards |
| --- | --- |
| player won (0) | 5 + rand % 6 = 5–10 |
| no winner (< 0) | 3 |
| player lost | 1 + rand % 3 = 1–3 |

**Drop table** `g_rewardDropTable` (0x088B876C): 207 rows of 0x18 bytes. Row 0 is empty. Row *i* is
card number *i* (1–206, the order of `cardIndexToId`: units, spells, bases; characters have no row).

| Off | Type | Field |
| --- | --- | --- |
| 00 | u16 | card id |
| 02 | u8 | base weight (1–30) |
| 03 | u8[20] | opponent multiplier (0–5); column = `opponentId − 1002`, so 1002–1011 then the rematch Dominators 1012–1021 |
| 17 | u8 | padding (0) |

**Picking** (**code**):
0. `cardNewFlags[1..206]` are cleared (index 0 is not).
1. For every card number i = 1…206 (card id `cardIndexToId(i)`; the table row's own id is not read),
   `score = r × base × mult[(opponentId − 1002) & 0xFF]`, where
   `r = ((rand & 0xFFFF) + 1) % 100 + 1` (1–100, a new roll per card). The largest score is
   30 × 5 × 100 = 15000, so the u16 never overflows.
2. The cards are insertion-sorted by score, highest first. On a tie the lower card number stays first.
   The insertion walks two arrays ended by id 0 and swaps the carried entry into every slot whose
   score is lower than the **new** score; it tests the end marker only after advancing. So when card 1
   scores 0 (multiplier 0 against that opponent), an empty entry (id 0, score 0) stays at index 0 and
   can end a later walk early, which moves a card lower in the list than a clean sort would. Play mode
   ports the loop as written.
3. The reward slots take cards from the top of the list, skipping cards already owned 10 times. They
   stop at the first score of 0.
4. Slots still empty (fewer eligible cards than slots) are filled again from the top of the list,
   without "NEW" flags.
5. Each slot is `cardId | flags << 28`, with flags 1 = copy or 3 = first copy (bits for `cardNewFlags`).
6. **Rare bonus**, only when 5 or more cards are rolled:
   - `s = max(0, 30 − g_mapRound) + conquests(winner) / 5 + HP of the winner's Dominator + 2 × winner's Soul`;
   - `s ≥ 40 / 60 / 80` gives 1 / 2 / 3 rare picks;
   - rare pick *k* (0–2) is the highest-scoring card not yet owned 10 times among the (20*k*+1)-th to
     (20*k*+20)-th **lowest nonzero** scores;
   - rare pick *k* overwrites slot `count − 1 − k` (the last slots).
7. The copies are added when state 0x0F ("Clear") turns into 0x10: for each slot, `cardCount + 1` and
   `cardNewFlags |= flags` while the count is < 10 (a refill slot has no flags; a card already owned 10
   times is shown but not added). The battle counters and the special cards follow in state 0x10.

The multipliers make a card impossible against some opponents (multiplier 0). The six special cards
2612–2617 have 0 everywhere, so they only come from the special rewards. The number of cards that can
drop per opponent:

| 1002 | 1003 | 1004 | 1005 | 1006 | 1007 | 1008 | 1009 | 1010 | 1011 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 134 | 138 | 85 | 137 | 132 | 138 | 135 | 135 | 144 | 144 |

| 1012 | 1013 | 1014 | 1015 | 1016 | 1017 | 1018 | 1019 | 1020 | 1021 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 170 | 172 | 171 | 169 | 171 | 170 | 175 | 169 | 179 | 179 |

**Viewer recipe (reward odds per stage).**
- Read the 206 rows at file offset `0x088B876C − 0x08804000 + 0x54 + 0x18·i` (i = 1–206):
  `u16 id, u8 base, u8 mult[20]`.
- The stage's opponent is `charaGetLadderId(stage)`.
- The weight of a card is `base × mult[opp − 1002]`.
- Because the picks are the top N of `weight × U(1..100)`, the odds have no closed form. Simulate the
  algorithm above: 10⁵ rolls per N = 5…10 give stable percentages (e.g. against 1002 with N = 5, cards
  of weight 150 come up in about 30 % of battles).
- Ownership (maxed cards skipped) and the rare bonus depend on the save and the battle. Show them as
  notes, or simulate with an assumed score.

### 2.5 Deck edit (0x140) and card list (0x14A)

Deck rules (`deckEditScene`, **code**):
- a deck is the Dominator plus **exactly 30 cards**. The editor counts 1 (the Dominator) plus all
  copies and only saves at 31; otherwise it shows "Please prepare 30 cards for the deck." or "30 cards
  will fit into the deck.";
- **at most 3 copies** of a card, and never more than you own (`cardCount`);
- the running total may not exceed 42 while editing;
- there is no rarity or cost limit;
- the Dominator is fixed (1001 in story decks);
- a new deck asks for a name on save.

Both scenes list cards by index. The deck editor's collection view has 4 filters (L/R): all (1–206),
units (1–122), spells (123–190), bases (191–206), and hides cards with count 0; the card list has no
filter and shows unowned cards as blank cards. Both show NEW / Get markers from `cardNewFlags`. △ opens
the card detail. **code** Layout and state machine: [deck-editor.md](deck-editor.md).

### 2.6 Battle mode (600)

This is the setup for **ad-hoc versus** only (there is no local vs-CPU free battle here).

1. "Load save data?" ✕ → `saveDataScene(0)`: the player's game data is loaded into a separate
   profile copy (0x089B7060, one `PlayerProfile` per side). ○ → title.
2. Choose a Dominator: 1001, or any character whose stage is cleared.
3. Choose one of the 3 decks of that save; its 30 cards are copied (0x089B6F3C).
4. Choose **Host** or **Join** (`g_localPlayer` 0/1).
5. Host only: choose a map (area, block) among the maps unlocked in the loaded save, then confirm.
6. → scene 4000 with `g_gameMode` 0, `g_numPlayers` 2.

## 3. Ad-hoc multiplayer

### 3.1 Roles of scenes 400 and 4000 (open question 1.6)

- **Scene 4000** = `adhocLobbyScene` (0x0889FE6C): the ad-hoc lobby. The host shows "Recruiting…"; the
  joiner shows "Searching for players" and a **battle list** of hosts (`%s　MAP：%s`: player name and map
  area). On success it returns 0x50 (the normal map-board scene, run in versus mode); on exit or error it
  returns 600.
- **Scene 400** = `rulesHelpScene` (0x0884CC90): a "How to play" viewer with 15 topics
  (Conditions to win game, Conquest, Unit, Spell, Cost, Soul, Maintenance Cost, AP, HP, DF, How to
  obtain cards, Deck and Discard, Number of cards in hand, When you are drawing a card, Attributes).
  Only the title's unused result 5 leads to it, so scene 400 is **unreachable**; the same function
  is the map board's Help command ([extras.md](extras.md)). It has nothing to do with networking.

### 3.2 Session setup (code)

1. At boot `netInit` (0x0889DCDC): load the net modules, `sceNetInit`, `sceNetAdhocInit`,
  `sceNetAdhocctlInit`, `sceNetAdhocctlAddHandler`.
2. Connection: `netconfStart` (0x088A5008) opens the system **Netconf dialog** in ad-hoc mode (action 2
   connect; the create/join variants 4/5 exist in the table 0x088A91D4), no group name, timeout 60 s.
   The joiner scans first with `sceNetAdhocctlScan`.
3. `adhocMatchingInit` → `sceNetAdhocMatchingInit(0x8000)` and `adhocMatchingCreateStart`:
   `sceNetAdhocMatchingCreate(mode 3 = P2P, maxPeers 2, port 1, rxBuf 0x400, hello 1 s, keep-alive 1 s,
   initCount 60, rexmt 1 s, callback adhocMatchingCallback)` and
   `sceNetAdhocMatchingStart(evPri 0x36, evStack 0x1000, inPri 0x36, 0, helloLen 0xA4, hello)`.
4. The callback queues each event (NONE, HELLO, REQUEST, LEAVE, DENY, CANCEL, ACCEPT, ESTABLISHED,
   TIMEOUT, ERROR, BYE, DATA, DATA_ACK, DATA_TIMEOUT) into a message box. HELLO data (0xA4 bytes) fills
   `g_adhocPeers[4]` (0x09E1D414, 0xB0 each).
5. The joiner picks a host from the list → `sceNetAdhocMatchingSelectTarget`; the host accepts it. After
   the match, one side sends a random string of 1–16 letters with `sceNetAdhocMatchingSendData` (a
   DATA ping).
6. `adhocPdpOpen` (0x088A4AC0): `sceNetAdhocPdpCreate(own MAC, port 0x309, bufsize 0x400)`. Every
   later packet is a PDP datagram on **port 0x309**, sent to the broadcast MAC `FF:FF:FF:FF:FF:FF`
   and accepted only from the peer's MAC.

**Hello data** (`g_adhocHelloData` 0x09DB6118, 0xA4 bytes, built by `adhocLobbyInit`):

| Off | Type | Field |
| --- | --- | --- |
| 00 | char[0x80] | PSP nickname (`sceUtilityGetSystemParamString(1)`) |
| 80 | 4 | padding: always 0. Cleared by `netInit`/`adhocLobbyInit`; the nickname is fetched with length 0x80 (`sceUtilityGetSystemParamString(1, hello, 0x80)`, 0x088A4044). Nothing writes or reads hello+0x80 or the peers' copies (**code**) |
| 84 | char[24] | player name (from the loaded save) |
| 9C | u8 | role: 0 host (only hosts are listed), 1 joiner |
| 9D | u8 | map area − 1 |
| 9E | u8 | map variant |
| 9F | u8 | pad |
| A0 | s32 | chosen Dominator card id |

`g_adhocPeers` entry (0xB0): +0 state, +4 MAC[6], +0xC copy of the peer's hello (so hello+X = peer+0xC+X).
The "selected hello" pointer 0x09DB61BC (written by the matching callback on ACCEPT) is never read.

### 3.3 Packet formats (PDP port 0x309)

| Type | Size | Layout |
| --- | ---: | --- |
| control | 2 | `{u8 code, s8 arg}` (`adhocSendCtl`) |
| player record | 0xC9 | `u8 0x02` + a 200-byte `DuelPlayer` (deck, hand, …) |
| input | 0x5B | `u8 0x01`, `u8 seq`, 0x58 bytes of pad state, `u8 sum` |

**Input packet checksum**: `sum = (Σ bytes[0..0x59]) mod 256` (a plain 8-bit sum of type, seq and
payload). The receiver drops packets with the wrong size, type or sum, or a repeated `seq`, and answers
every valid one with the control packet `{0x09, seq}` (ACK). The sender resends the same packet every
3 frames until that ACK arrives.

The input payload is pad slot 1 (`g_padRemote` 0x09CC2FC4, 0x58 bytes). Only three words are used by
the receiver: held (+0x48), pressed (+0x4C) and repeat (+0x50).

### 3.4 Game synchronisation (`adhocNetUpdate` 0x0889E244, state `g_adhocState` 0x09DB6114)

The game is kept in sync by **input streaming**, not by sending game state. Both sides run the same
game logic from the same random seed. The player whose turn it is plays locally, and each new button
press is sent to the peer. The peer's `padUpdate` feeds its "remote" pad slot from a 512-entry queue
(`g_padQueue` 0x09CC302C, `padQueuePush` / `padQueuePop`), so both machines see the same inputs.

Handshake, in state order (each step resends until the peer answers; 300-frame timeout):

| State | Exchange | Purpose |
| --- | --- | --- |
| 0x2D | `{0x0C, 0x2D}` then `{0x0C, 1}` both ways | hello; each side then seeds its RNG with `rand()` |
| 0x2E → 0x30 | `{0x0D, 1}`, then player records (type 2); ack `{0x0D, 0}` | first player-record exchange. On the `{0x0D}` reply: **host** sets `bController` [0]=0/[1]=1, writes the joiner's save name (peer hello +0x84) into name slot 1 (`duelSetPlayerName`, 0x0889E7EC) and sends `{0x07, 4}`; **joiner** sets [0]=1/[1]=0, takes `g_mapId` = hello+0x9D + 1, `g_mapVariant` = hello+0x9E, `g_mapLayoutId` = `dbGetMapLayoutId()`, writes the host's name into slot 0 (0x0889E89C) and sends `{0x07, 2}`. Both then go to state 0x33 |
| 0x33 | — | leave the lobby: scene → 0x50 |
| 0x34 → 0x35 | `{0x0E, 0}` / `{0x0E, 1}` | map loaded on both sides |
| 0x36 | own `DuelPlayer` record (host slot 0, joiner slot 1) + `{0x10, 0}` | final decks; sets `bController` (0 local, 1 remote) |
| 0x39 | `{0x10, 0}` | wait until the board is running |
| 0x3B → 0x3D | host `{0x0F, seed \| 0x80}`, joiner `{0x0F, 0x80}` | **shared RNG seed**: 7 bits chosen by the host; both call the seed function with it |
| 0x3E | input packets (type 1) + ACK `{0x09, seq}` | in-game |
| 0x3F | wait for the ACK, resend every 3 frames | |
| 0x40–0x42 | `{0x0A, 100}` | end of game |
| 0x44–0x46 | `{0x0B, 0}` | leave; → disconnect (0x17/0x18: `sceNetAdhocctlDisconnect`) |

Timeouts and errors:
- no input from the acting peer for 10 800 frames (3 min) → "%s is not responding. The game will
  return to main menu";
- lost peer (`sceNetAdhocctlGetPeerInfo` fails), UMD removed, or a handshake timeout → disconnect;
- other messages: "The opponent has cancelled the operation", "The room is full. Could not connect",
  "The other player has left the game".

`{0x07, 4/2}` is sent once, without waiting for a reply (**code**). `adhocRecvCtl` (only caller
`adhocNetUpdate`) drains the receive queue each call and returns the first 2-byte packet from the peer on
port 0x309. No state compares the code with 7, so the peer always discards this packet: it has no
effect, and the meaning of the arguments 4 (host) and 2 (joiner) cannot be recovered. The reason for the
double player-record exchange (0x30 and 0x36) is still **inferred**.

**Names in versus play**: `battleModeMenuScene` puts the local save name into both slots of
`g_duelPlayerNames`; the handshake above then overwrites the opponent's slot with the peer's save name,
so each side shows its own name and the peer's.

## 4. Ghidra annotations made

- The stubs of sceUtility, sceNet, sceNetAdhoc, sceNetAdhocMatching and sceNetAdhocctl were named from
  their NIDs.
- Functions: `save*` (the sample layer now carries its original names: `CB_SaveData_Normal`, `SetData_*`, `Savedata_Update`; `saveSerialize*/Deserialize*`, `saveExport*`
  …), `profileInitNewGame`, `cardCountCollection`, `campDrawStatusWindows`, `stageDrawMapStats`,
  `duelRollRewardCards` (with `g_rewardDropTable`, `g_rewardCount`, `g_rewardCards` 0x089B6060,
  `g_rewardCardAnim` 0x089B6088), `rulesHelpScene`, `adhoc*` (`adhocLobbyScene`, `adhocNetUpdate`,
  `adhocSendInput`, `adhocRecvInput`, `adhocSendCtl`, …), `netInit`, `netconfStart`, `pad*`.
- Structs `PlayerProfile`, `PlayerDeck`, `SaveHeader`, applied at 0x089D184C, 0x089C9F68 and 0x089D1E68.
- Globals `g_saveParam`, `g_saveGameKey`, `g_saveModeTable`, `g_saveGameDataBuf`,
  `g_saveContinueBufPtr`, `g_adhocState`, `g_adhocHelloData`, `g_adhocPeers`, `g_padRemote`,
  `g_padQueue`, `g_inputPadIndex`, `g_resumeLoaded`.
- Plate comments on these.
- Step 6.4 (Play mode saves): plates rewritten on `duelRollRewardCards` (insertion hole, flag clearing),
  `duelResultScreenUpdate` (copies at 0xF → 0x10, counters and special cards in 0x10),
  `charaGetLadderIndex`, `saveDataScene`, `resumeTempSaveScene`, `saveSerializeGameData`,
  `saveSerializeContinue`, `saveDeserializeContinue`; labels `g_resultState`, `g_rewardShown`,
  `g_rewardCursor`, `g_rewardRevealTimer`, `g_resultBannerScale/Step`, `g_resultPortraitX`,
  `g_resultWinnerCharaId`, `g_resumeState`, `g_resumeTimer`, `g_mapSavedUnused*`, and the save strings
  `s_saveErrorOccurred`, `s_saveBack`, `s_saveNoSpaceAsk`, `s_saveYesNo`, `s_saveDataOfFmt`,
  `s_saveDetailFmt`, `s_resumeAsk`, `s_resumeYesCancel`, `s_resumeDeleted`, `s_mc*`, `s_saveEmptyTitle`,
  `s_saveTemporaryData`, `s_saveGameTitle`, `s_saveDataTitleDefault`, `s_saveContinueTitleJp`.

## 5. Open points

| # | Point |
| --- | --- |
| 1 | `PlayerProfile.unk18`, `PlayerDeck` +0x58/+0x5C, `SaveHeader` +0x60/+0x6C: written, never used. |
| 2 | The play-time field is never advanced (the updater is a no-op). Not checked whether another place writes it. |
| 6 | The save layout is round-tripped by Play mode's own writer and reader, but not yet compared with a real (decrypted) PSP save (open question 2.8). |
| 3 | ~~Reward weighting tables~~: decoded, see [Card rewards](#card-rewards). |
| 4 | Resolved: hello +0x80..+0x83 is padding (always 0); `{0x07, 4/2}` is sent once and ignored by the receiver. |
| 5 | Encryption version (the firmware picks it) and PARAM.SFO hashes: follow the standard PSP savedata scheme, not verified against a real save. |
