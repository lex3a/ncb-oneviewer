# Board game rules (map scene)

How a card battle is played on the map: the board, turns, Costs and Soul, summoning, movement and
land seizing, attacks, deaths and the win conditions. It is all read from `mapBoardScene` (0x0884CDD4,
scene 0x50) and the functions it calls in the USA EBOOT.

Related files:
- the duel itself (damage, stats, animation): [effects.md](effects.md#duel-scene);
- what each spell, attachment and activated ability does: card-effects.md;
- how the CPU plays: ai.md;
- menus, save data and ad-hoc play: save-menus.md.

Tags: **code** = read from code; **data** = checked against the tables in the ELF; **inferred** = a
reasoned guess; **unknown** = not solved.

## Game modes

`g_gameMode` (0x08A1B253) decides who plays and where the board comes from (**code**).

| Mode | Set by | Meaning |
| ---: | --- | --- |
| 0 | `battleModeMenuScene` | Versus, two humans over ad-hoc. Each player picks his Dominator's start square. The deck shuffle uses the synchronised RNG (`FUN_088a06cc`). There is no Save command. |
| 1 | `newGamePrologueScene`, `stageSelectScene` | Campaign battle against the CPU, with stage events (`FUN_08849388`). The Dominators start on the stage's fixed squares. |
| 2 | `stageSelectScene` | Rematch of an already cleared stage (the stage's bit is set in `g_stageClearMask`). Same rules as mode 1. |

Other globals:
- `g_numPlayers` (0x08A1B254) is always 2. The board code loops over up to 4 players, but several
  places (death processing, `unitSumMaintenance`, the Dominator checks) only look at players 0 and 1.
- `g_localPlayer` (0x08A1B255) is the local side in mode 0.

**Controller** (`DuelPlayer.controller`, +0xB8; `ctrlKind` 0x08839C1C):

| Value | Controller |
| ---: | --- |
| 0 | local human |
| 1 | the remote human of an ad-hoc game. Only `battleModeMenuScene` writes it (the side that is not `g_localPlayer`); `ctrlGetPad` maps it to pad slot 1, which `padGetPressed(1)` reads from the network input queue (`padQueuePop`, `g_padRemote`), not from a second pad |
| ≥ 2 (0xFF in modes 1/2) | CPU (state 0x13, ai.md) |

## Stages: areas, variants and opponents

`stageSelectScene` (0x0881D4E0) picks the stage, and the board scene reads it back (**code**, table
contents **data**):

| Global | Meaning |
| --- | --- |
| `g_mapId` (0x08A1B250) | area 1–10 |
| `g_mapVariant` (0x08A1B251) | 0 or 1; shown as "Block A" / "Block B" |
| `g_mapLayoutId` (0x08A1B258) and `g_mapStageNo` (0x08A1B252) | the stage number from `g_mapLayoutIds` (0x088B9E5C, `u8[10][2]`) via `dbGetMapLayoutId` |

The stage number is also the opponent: `charaGetLadderId(stage)` indexes `g_charaLadderOrder`.
The opponent's deck comes from `dbGetDeckByDominator`:
- in mode 1 with flags 3, which takes the **last** deck of that Dominator;
- in mode 2 with flags 1, which takes the first.

The player always plays Galahad (1001) with the selected deck slot.

| Area | Name | Variant 0: stage → opponent | Variant 1: stage → opponent |
| ---: | --- | --- | --- |
| 1 | Underground shrine | 1 → 1004 Egma | 14 → 1014 Egma (rematch) |
| 2 | Forest of Dryad | 2 → 1002 Shaia | — |
| 3 | Clamaton Desert | 3 → 1003 Iglus | — |
| 4 | Ruins of Runica | 4 → 1005 Refina | 5 → 1009 Sheriela |
| 5 | Juneilink Island | 6 → 1006 Simmon | 7 → 1012 Shaia (rematch) |
| 6 | Dark Marsh | 8 → 1007 Fellunder | — |
| 7 | Umally Island Volcano | 9 → 1008 Wise | 10 → 1019 Sheriela (rematch) |
| 8 | Ogline Ravine | 11 → 1013 Iglus (rematch) | — |
| 9 | Heavenly Altar | 12 → 1018 Wise (rematch) | 13 → 1015 Refina (rematch) |
| 10 | Shadow Heaven Ship | 15 → 1010 Hellgaia | 17 → 1011 Arth, or 18 → 1021 Arth (rematch) once cards 2612–2617 are all known |

**Unlocking** (`stageGetLayoutIfUnlocked` 0x0881C17C). Bit `n − 1` of `g_stageClearMask` (0x089D1A10)
means stage `n` is cleared.

| Stage | Needs cleared |
| --- | --- |
| 1 | always open |
| 2–4, 9, 12–16 | stage n − 1 |
| 5 | 3 |
| 6, 7 | 4 and 5 |
| 8 | 6 and 7 |
| 10 | 8 |
| 11 | 9 and 10 |
| 17 | 15 |

Stage 16 (1020 Hellgaia, rematch) is not reachable from the table.

**Who starts.** Player 0 (the human) moves first, except in mode 1 on stages 1 and 11, where the
turn player is flipped after the intro event (state 5).

**Music.** BGM = `mapGetBgmId(area)` = `area − 1`.

## The board

### Terrain table (answers open question 1.4)

Every playable board is a record in `g_mapTerrainTable` at **vaddr 0x088E616C** (file offset
0x000E21C0). There are 16 records of **0x658 bytes**, read by `mapLoadTerrain` (0x088572F0)
(**code + data**).

| Off | Type | Field |
| --- | --- | --- |
| 00 | u8 | area (`g_mapId`) — search key 1 |
| 01 | u8 | variant (`g_mapVariant`) — search key 2 |
| 02 | s16 | width (squares) |
| 04 | s16 | height |
| 06, 07 | u8, u8 | player 0 Dominator start x, y |
| 08, 09 | u8, u8 | player 1 Dominator start x, y |
| 0A | u8 | number of squares (land ≥ 0) |
| 0B–0E | u8[4] | number of earth / water / fire / air squares |
| 0F | u8 | 0 |
| 10 | s32 | conquest goal = ⌊squares × 0.8⌋ |
| 14 | s32 | 0. The code would fill it with ⌊2·squares/3⌋ but then overwrites it with 0 |
| 18 | s8[40×40] | land, row-major, always 40 wide: −1 no square, 0 plain, 1 earth, 2 water, 3 fire, 4 air |

Coordinates are `x` = column, `y` = row. Only the top-left `width × height` corner is used.

| Rec | Area/var | Size | P0 start | P1 start | Squares | Earth/water/fire/air | Goal |
| ---: | --- | --- | --- | --- | ---: | --- | ---: |
| 0 | 1/0 | 12×13 | (6,0) | (5,12) | 58 | 0/0/0/0 | 46 |
| 1 | 2/0 | 13×18 | (10,17) | (10,2) | 114 | 9/10/3/6 | 91 |
| 2 | 3/0 | 20×20 | (19,17) | (7,6) | 178 | 8/13/0/12 | 142 |
| 3 | 4/0 | 11×20 | (7,3) | (3,16) | 118 | 0/0/12/12 | 94 |
| 4 | 5/0 | 24×21 | (1,1) | (23,19) | 148 | 0/18/0/17 | 118 |
| 5 | 6/0 | 14×16 | (6,4) | (7,13) | 116 | 50/0/0/0 | 93 |
| 6 | 7/0 | 24×23 | (3,0) | (19,15) | 113 | 12/0/9/0 | 90 |
| 7 | 8/0 | 39×13 | (8,5) | (29,6) | 161 | 16/10/0/8 | 129 |
| 8 | 9/0 | 13×20 | (5,5) | (7,14) | 160 | 19/19/17/17 | 128 |
| 9 | 10/0 | 19×16 | (18,9) | (0,5) | 155 | 30/24/15/20 | 124 |
| 10 | 1/1 | 12×13 | (9,2) | (2,10) | 112 | 12/12/12/12 | 90 |
| 11 | 4/1 | 11×20 | (4,2) | (6,17) | 150 | 15/16/13/13 | 120 |
| 12 | 5/1 | 24×15 | (4,10) | (23,13) | 133 | 0/8/0/8 | 106 |
| 13 | 7/1 | 22×27 | (7,2) | (17,17) | 151 | 15/7/5/9 | 121 |
| 14 | 9/1 | 13×20 | (6,0) | (6,19) | 180 | 24/24/24/24 | 144 |
| 15 | 10/1 | 19×18 | (17,1) | (1,15) | 158 | 22/24/25/23 | 126 |

Areas 2, 3, 6 and 8 have no variant 1 board, in line with the stage table. When no record matches,
the search falls back to record 0 (**inferred** from the loop).

Example, record 0 (area 1 variant 0; `.` = no square):

```
....0000....
....0000....
....0000....
.....00.....
.....00.....
.00.0000.00.
.0000000000.
.00.0000.00.
.....00.....
.....00.....
....0000....
....0000....
....0000....
```

**Extraction recipe for the viewer** (node, on `BOOT.BIN`):

```js
const base = 0x088E616C - 0x08804000 + 0x54;         // file offset 0xE21C0
for (let r = 0; r < 16; r++) {
  const o = base + r * 0x658;
  const area = elf[o], variant = elf[o + 1];
  const w = elf.readInt16LE(o + 2), h = elf.readInt16LE(o + 4);
  const start = [[elf[o + 6], elf[o + 7]], [elf[o + 8], elf[o + 9]]];
  const goal = elf.readInt32LE(o + 0x10);
  const land = (x, y) => elf.readInt8(o + 0x18 + y * 40 + x); // -1 none, 0..4
}
```

The 3D scenery of an area is separate: the map.one background and decorations
([database.md](database.md#mapone)). The terrain record only decides the squares. How the board,
scenery, units and HUD are drawn (camera, tiles, tokens, draw order) is in [map-board.md](map-board.md).

### Map state block

Everything about the running board sits in one block at `g_mapGrid` (0x089F66D0, 0x24C74 bytes). It
is cleared when the scene exits, and the suspend save copies it (save-menus.md) (**code**).

| Off (vaddr) | Type | Content |
| --- | --- | --- |
| +0x0000 (0x089F66D0) | u32[40×40] | **cell word** (see below), 0 = empty |
| +0x1900 (0x089F7FD0, `g_mapCellFlags`) | u16[40×40] | **conquest**: bits 0–7 path step of a pending seize, 8–11 pending seize by team, 12–15 owned by team (one bit per team) |
| +0x2580 (0x089F8C50, `g_mapLandAttr`) | s8[40×40] | land attribute, copied from the terrain table and changed by the Summon Earth… cards and abilities |
| +0x2BC0 (0x089F9290, `g_mapBaseAuras`) | u8[40×40][85] | base-aura counters: 17 bytes (index = base id − 3000) for "any team", then 17 bytes per team |
| +0x23F00 (0x08A1A5D0, `g_mapRangeGrid`) | u8[40×40] | UI marks: 0x10 move start, 0x11–0x14 move line, 0x20 attack range, 0x40 base aura, 0x80 deploy square, 1 forbidden start square |
| +0x24540 (0x08A1AC10) | u8[40×40] | "square newly seized" markers for the effect |
| +0x24B80 | u8 ×6 | `g_mapId`, `g_mapVariant`, `g_mapStageNo`, `g_gameMode`, `g_numPlayers`, `g_localPlayer` |
| +0x24B88 | s32 | `g_mapLayoutId` |
| +0x24B8C | s32 | `g_mapRound` (turn counter, +1 each time player 0 comes round) |
| +0x24B90 | s32 | `g_mapTurnPlayer` |
| +0x24B94 | s16 | `g_mapGoalPoints` |
| +0x24B96 / +0x24B98 | s16 | `g_mapWidth` / `g_mapHeight` (copies at +0x24B9A / +0x24B9C) |
| +0x24BA0 | s32 | `g_mapFirstTurn` |
| +0x24BA4 (0x08A1B274) | s32[4] | `g_mapConquestCount`: squares owned per team |
| +0x24BB4 | s32[4][10] | squares seized per team and move leg (for undo) |
| +0x24C54 (0x08A1B324) | u8[4] | `g_mapPlacedCount`: units + bases with state > 0 and HP > 0, per **team** (+0x0C), Dominator included (`mapCountDeployed` 0x0882F3BC, see below) |
| +0x24C68 (0x08A1B338) | u32 | `g_mapDeployRules` = 0x1C |
| +0x24C6C | u32 | `g_mapSoulRules` = 1 |
| +0x24C70 | u32 | `g_mapCostRules` = 3 |

**`g_mapCellFlags` bit 12 + t** means "owned by team t": `unitPlaceOnGrid` writes `1 << (12 + team)`
over the whole word and `mapCommitConquest` shifts the pending bits 8–11 up by 4. Teams equal player
indices (a unit's team starts as its player; only Rise of the Betrayer changes it, and never on a
Dominator), so the AI's test of bit `12 + turnPlayer` means "not yet owned by my side".

**`g_mapPlacedCount`** is recounted only by `mapCountDeployed`, which is called from the first
placement of a card (`unitPlaceOnGrid`), the three revival paths, `spellConfirmTarget`,
`mapSpellCastUpdate` and `mapTurnStartUpdate`. `unitDestroy` does not recount, so a unit that died
this turn still counts until the next recount. Only entries 0 and 1 are cleared before counting.
The limit 16 is applied by the summon menu ("Number of allowed deployment: 16 − count") and the AI.

The cursor `g_mapCursorX/Y` (0x08A1B344 / 0x08A1B348) and `g_mapActionFlags` (0x08A1B350) follow.
Positions are in "square × 64" units, so a unit stands exactly on a square when `(pos & 0x3F) == 0`.

The **cell word** is written by `unitPlaceOnGrid` (0x0882F464):

```
cell = cardId | (deckSlot & 0xFF) << 16 | (team + 1) << 24 | (player + 1) << 28
```

- The deck slot byte is written as `(byte)deckSlot`, so the Dominator (slot 0) has slot field **0**; no writer (`unitPlaceOnGrid`, `spellMirrorReflection`, `spellChickBugCurse`, `scrfn_gameMapPlaceCurUnit`) ever produces 0xFF. The readers (`mapDrawUnit`, `mapCursorUpdate`, `mapFloodMovePreview`, the AI, the spells) still map a slot field of 0xFF to 0, a defensive leftover (**code**; an earlier version of this page said the Dominator is stored as 0xFF).
- `mapGetCell(grid, x, y, 1)` (0x088576E0) returns it, or −1 outside the board or on land −1.
- The unit is `g_mapUnits[(cell >> 28) − 1][(cell >> 16) & 0xFF]`.

## Units on the board — `MapUnit`, 0x58 bytes

`g_mapUnits` (0x089F3C20) is `MapUnit[4][31]`: one row of 31 per player, indexed by deck slot. Slot 0
is the Dominator and slots 1–30 are the deck cards. `unitInitFromCard` (0x0882F244) fills a record
from its card at the start of the game and again whenever a card leaves the board. The struct is
created in Ghidra (**code**).

| Off | Type | Field | Notes |
| --- | --- | --- | --- |
| 00 | s32 | cardId | |
| 04 | s32 | deckSlot | 0 = Dominator |
| 08 | s32 | player | row in `g_mapUnits` / `g_duelPlayers` |
| 0C | u8 | team | side for friend/foe and for land; changed by Rise of the Betrayer (2108) |
| 0E, 10 | s16 | cellX, cellY | |
| 14, 18 | s32 | posX, posY | square × 64; animated while walking |
| 1C | s32 | posZ | Dead: written 0 by `unitInitFromCard` and never read (instruction scan of all loads/stores at +0x1C) |
| 20 | u8 | actFlags | Activity bits, see [below](#activity-flags-0x20) |
| 21 | s8 | maxHp | |
| 22 | s8 | hp | ≤ 0 = dead |
| 23 | s8 | baseAp | card AP, +1 per Bless of Training (49) |
| 24 | s8 | dfBonus | +1 per Bless of Training |
| 25 | u8 | attribute | 0–4 |
| 26 | u16[6] | attachments | spell card ids attached (`unitAttachmentOp` 0x08830604) |
| 34–44 | s32 ×5 | effAp, effDf, effRange, effMove, effAttribute | computed by `unitRecalcStats` |
| 48 | u16 | statusFlags | 1 Boost active (+2/+1, cleared after the battle), 2 Foot Stamp (finished), 4 move 1 (Euro's Shackles) |
| 4A | u8 | facing | 0 down, 1 right, 2 left, 3 up (**inferred** from `unitStepToward`). Only the unit being moved is drawn with it; units standing on the board are drawn facing 0 |
| 4B | s8 | scalePct | Display scale in percent, 0 at `unitInitFromCard`/`unitPlaceOnGrid`. `mapDrawAllUnits` (0x08831DB4) grows it by 10 per frame up to 100 while state = 1 (summon pop-in) and shrinks it by 10 per frame while state = 4; at ≤ 0 it sets state 6. `mapDrawUnit` (0x0883156C) scales the token, the shadow and the markers by it |
| 4C–52 | u16 ×4 | (colour) | Dead: set to 0x80 each by `unitInitFromCard`, never read (no load at +0x4C…+0x52 in the map code). The order is therefore meaningless; the token colour comes from constants in `mapDrawUnit` |
| 54 | s32 | state | −1 not in play yet, 0 off the board, 1 on the board, 2 moving, 3 has moved, 4 dying (death effect running, shrinking), 6 shrunk away (not drawn, waiting for `unitDestroy`). 5 is skipped by the drawing code but never written |

### Activity flags (+0x20)

Every reader and writer, **code**:

| Bit | Meaning | Read by |
| --- | --- | --- |
| 1 | cannot move | command menu (Move offered only when clear, and when `g_mapActionFlags` bit 0 "moved during this action" is clear), `aiMoveSearch` (flags & 9) |
| 2 | cannot use an ability | command menu (Ability), `aiPickActivatedAbility` |
| 4 | cannot attack | command menu (Attack), `aiMoveSearch` |
| 8 | finished | grey token (`mapDrawUnit` colour 0x40) and the "finished" marker; skipped by the L/R cursor jump (`mapCursorCycleUnits` 0x0882FE80); the end-of-action check "does any own unit still have bit 8 clear?"; `aiSelectNextUnit`, `aiMoveSearch` (flags & 9) |

`aiEvalSnipe` and `aiEvalSummonElement` read the whole byte (non-zero = has done something).

"Moved" is not a unit bit: the move of the current action is `g_mapActionFlags` (0x08A1B350) bit 0.
Writers:
- **0**: `unitInitFromCard`, `mapTurnEndUpdate` step 100 (all units of the ending team), Mirror
  Reflection (target), and Double Action (below). `mapDeathRevival` keeps the old value.
- **|= 0x0F**: end of every unit action (0x08850B50 CPU, 0x08850C20 human); Foot Stamp status bit and
  a Foot-stopper (2103) attachment (`unitRecalcStats`, every recalculation); `abilityFootStamp` on its
  target.
- **|= 6**: a Lurk (2104) attachment (`unitRecalcStats`).
- **Double Action (2608)**: right after `|= 0x0F`, if `unitAttachmentOp(unit, 2608, remove)` succeeds,
  the flags are set to **0**, so the unit gets a full second set of actions, move included.

No code sets a single bit 1, 2 or 4 on its own: the individual bits only come from Lurk and from the
checks above.

## Players — `DuelPlayer`, 200 bytes

`g_duelPlayers` (0x089D1B48) is `DuelPlayer[4]` (**code**; struct created in Ghidra).

| Off | Type | Field | Notes |
| --- | --- | --- | --- |
| 00 | u8 | index | |
| 02 | s16[31] | deck | [0] = Dominator card id, [1..30] = the 30 deck cards |
| 40 | u8[31] | deckState | 0 in the deck, 1 in hand, 2 face up, 4 has been on the board, 8 discard pile (see below) |
| 5F | u8[31] | drawOrder | [1..30] = shuffled deck slots (`playerShuffleDeck`) |
| 80 | s32[6] | hand | deck slot per hand position, 0 = empty |
| 98 | u32 | handUsable | 4 bits per hand position: 1 usable, 2 not usable (`handMarkUsableCards`) |
| 9C | s32 | selectedSlot | card chosen in the hand panel |
| A0 | s32 | handCursor | position × 32 |
| A4 | u8 | (unused) | Dead: only copied by the suspend save (`saveSerializeContinue` / `saveDeserializeContinue`); no other load or store |
| A5 | u8 | handCount | |
| A6 | u8 | deckCount | number of slots 0–30 whose deckState is 0, i.e. cards still in the deck. Recounted by every `playerDrawCard` / `playerDrawCardUpdate` call; Winter Preparation adds the returned cards. Read by the AI's spell choice and `FUN_08859A60` (HUD) |
| A8 | s32 | **cost** | Costs available this turn |
| AC | s32 | **soul** | 0–99 |
| B0 | u16 | maintenance | sum of the card maintenance of the team's units (`unitSumMaintenance`) |
| B2 | u16 | income | last turn's income |
| B4 | u32 | flags | see below |
| B8 | u8 | controller | see [Game modes](#game-modes) |
| BC, C0 | s32 | panelX, panelY | hand panel animation |
| C4 | u8 | panelVisible | |

**Deck state** bits (+0x40), **code**:
- **1 in hand, 2 face up.** A card drawn with `playerDrawCardUpdate` mode 1 (the turn draw) gets
  state 1 only. `handPanelDraw` (0x08856A74) shows it face down, plays the flip animation and then sets
  bit 2; the cursor ignores it until then, and `handSelectUpdate` pre-loads its picture. Cards that go
  to the hand already face up get state 3: the opening hand, draw mode 2, and cards returned to the
  hand (Evasion, Homesick, Shard of Life, Divine Light of Koriah).
- During the opening draw the Dominator's slot is set to 2 so that it cannot be drawn, then reset
  to 0; `unitPlaceOnGrid` later sets bit 4 on it. So `deckCount` never counts the Dominator.
- 4 = has been on the board (set once, on the first `unitPlaceOnGrid`; not for spells), 8 = discard.

**Player flags** (+0xB4), set by spells (card-effects.md):

| Bit | Source | Effect |
| --- | --- | --- |
| 0x002 | Return from Shadows (2204) | the next unit that dies comes back |
| 0x004 | Ambush (2507) | the next summon may go on any empty square; cleared after the summon |
| 0x008 | Cause for Civil War (2605) | no land seizing |
| 0x010 | Dried-up Well (2607) | no card is usable |
| 0x020 | Janess' Shadow (2613) | maintenance ×2 |
| 0x040 | Breath of Hellgaia (2614) | all units +1 AP / +1 DF |
| 0x080 | Wings of Mercedoa (2616) | move +1 |
| 0x100 | Epsilon's Protection (2617) | Soul ×2 |
| 0x200 | Cast Spell (ability 9) | next card costs 2 less; cleared on use |

## Turn structure

The scene state is `g_mapBoardState` (0x08A1BD6C). The full state list is in the plate comment of
`mapBoardScene`. One turn goes like this (**code**):

1. **Turn announcement** (state 0x0A): "%s's turn".
2. **Start of turn** (0x0B, `mapTurnStartUpdate` 0x0885B430). The steps run in this order:

   | Step | What happens |
   | ---: | --- |
   | 0 | Pending seizes become owned (`mapCommitConquest`). `income = g_mapConquestCount[team]`. |
   | 10 | +3 for each own unit with Blind Faith (22). |
   | 11 | +3 for each own Magic Mine (3006). |
   | 20 | Units with Sure-Kill (2308) attached lose HP. |
   | 21 | Deaths. |
   | 22 | TNT Clock Tower (3012): both Dominators lose 1 HP per tower. |
   | 23 | Dominator check. |
   | 24 | Deaths. |
   | 25 | Trap Zone (3013): −1 HP per zone to every unit in its area. |
   | 26 | Dominator check. |
   | 30 | Deaths. |
   | 40 | Regeneration (25): +2 HP, up to max HP. |
   | 41 | Healing Spring (3002): +1 HP per spring covering the unit. |
   | 50 | Dominator check. |
   | 100 | **Upkeep.** If `income < maintenance`, the player must destroy his own units (steps 0x65/0x66, HP set to 0, no Soul and no death abilities) until it fits. The CPU destroys the unit with the highest maintenance (`unitFindMaxMaintenance`). |
   | 200 | Stage event 9, then `cost = income − maintenance`. |
   | 201 | Draw 1 card (`playerDrawCardUpdate` mode 1, hand limit 6). |

   - Annul Base (16) makes a unit immune to all the base effects above.
   - Unused Costs do **not** carry over: `cost` is overwritten every turn.
3. **Main phase.**
   - A human starts in the hand panel (state 0x10, "Please select the card to use"); cancelling leads
     to the free cursor (0x14). The CPU runs its own state (0x13, ai.md).
   - O on a square opens the command menu (0x1E, `mapCmdMenuUpdate`). The chosen bit is
     `g_mapCommand`:

   | Bit | Command | Offered on |
   | --- | --- | --- |
   | 0x001 | Move | own unit that has not moved (`actFlags & 1 == 0`) |
   | 0x002 | Card (hand) | empty square / anywhere |
   | 0x004 | End turn | empty square |
   | 0x008 | Rules help (`rulesHelpScene`) | always |
   | 0x010 | Quit to title | empty square |
   | 0x020 | Save | empty square, modes 1/2 only |
   | 0x040 | Ability | own unit, `actFlags & 2 == 0` |
   | 0x080 | Attack | own unit, `actFlags & 4 == 0` |
   | 0x100 | Stand by | own unit, only when Move is **not** offered (after a move, or when it cannot move) |

   - A finished own unit (`actFlags & 8`) gets no menu.
   - The menu is drawn as a ring of icons turning in 3D around the cursor (`mapCmdMenuDrawRing`
     0x088326EC, etc.one 110 #1). That ring is the only user of `g_mapHudCam3D` (0x08A1C190), a copy
     of the default 3D camera with eye (128, 256, −640) set up by `mapInitCameras`.
   - Bases and enemy units only show their range (`mapMarkAttackRange`, 0x40 marks).
   - Triangle toggles the move preview of the unit under the cursor (`mapFloodMovePreview`).
4. **Action finished** (0x2328 → 0x238C).
   - After any unit command except card use and End turn, the acting unit gets `actFlags |= 0x0F`.
     If it carries Double Action (2608), the attachment is removed and `actFlags` is reset to 0.
   - If another own-team unit or Dominator (card id < 2000, so not a base) still has `actFlags & 8`
     clear, play returns to the cursor. Otherwise End turn is chosen automatically.
   - A move alone does not finish the unit: after moving, the menu offers attack, ability and stand
     by, and Cancel undoes the move.
5. **End turn** (0x2328 with command 4) asks "Ending turn. Is it all right?".
   - The "Standing by." window is dead code: the test compares the scene state instead of the
     command with 0x100. So Stand by ends the unit's action without a prompt.
6. **Hand limit** (0x26AC/0x26B6): with 6 cards in hand the player must discard one ("You can only
   have five cards in hand"). `handSelectUpdate` mode 0x400; the card goes to the discard pile.
7. **End of turn** (0x26C0, `mapTurnEndUpdate` 0x0885C01C):
   - Step 1, `mapTurnEndClearStatus` (0x0885BEFC): the turn player loses player flags 0x08 (Cause for
     Civil War) and 0x10 (Dried-up Well); every unit whose **team** equals the turn player's index
     loses status bit 2 (Foot Stamp) and every Foot-stopper (2103) attachment.
   - Step 100: `actFlags = 0` for every unit of that team.
   - Then the next player whose Dominator is alive gets the turn; `g_mapRound` goes up when player 0
     comes round.

There is no turn limit and no limit on the number of cards played per turn, apart from Costs.

## Game start

State 0, **code**:

- **Decks.**
  - `playerResetDeck` clears the deck state and the hand. `playerShuffleDeck` fills `drawOrder[1..30]`
    with a random permutation of slots 1–30; the Dominator (slot 0) is never drawn.
  - Every card gets a `MapUnit` (`unitInitFromCard`, state −1).
- **Board.** `mapInitGrid` loads the terrain, sets the goal and size, and writes the two start squares
  into `g_mapUnits[p][0].pos`. `cost` and `soul` start at 0.
- **Opening hand.** 3 cards (`playerDrawCard(p, 5)` three times), marked revealed.
- **Dominators.**
  - Modes 1/2: placed on the terrain record's start squares.
  - Mode 0: each player chooses his square in states 7–9 ("Please select the initial location of the
    dominator"). After the first placement every square within Manhattan distance 5 of it is marked
    forbidden (`mapFillDiamond(x, y, 5, 1)`, "You cannot select this location").
- **Start of play.** Stage event 1, the area name and the "Conditions to win" window, then player 0's
  turn (or the CPU's, see [Who starts](#stages-areas-variants-and-opponents)).

## Deck, hand and drawing

`playerDrawCard` (0x0885445C) and `playerDrawCardUpdate` (0x08853FAC), **code**:

- **Drawing.** A draw takes the first slot of `drawOrder` whose `deckState` is 0.
  - The hand has 6 places. A draw is refused when the hand already holds the limit (5 for the
    opening, 6 at the start of a turn).
- **Empty deck.**
  - The player's Dominator loses 5 HP, down to 0.
  - Every card in the discard pile (state 8) goes back into the deck, and the deck is reshuffled:
    "There are no cards left in the deck. %d discarded cards have been returned to the deck…".
  - With an empty discard pile too, only the damage applies.
  - A Dominator killed this way loses the game.
- **Discard pile.** Destroyed units, used spells and discarded cards get `deckState |= 8`.
- **Card usability** (`handMarkUsableCards` 0x088547F0).
  - A card is usable when `playerCalcPayment` leaves Cost ≥ 0 and Soul ≥ 0.
  - During a duel (mode 0x10) only spells with `abilityIds[0] = 1` count.
  - The counter cards 2401 / 2403 / 2405 are only usable in their reaction windows (modes 0x20 /
    0x40, card-effects.md).
  - Dried-up Well makes nothing usable.

## Costs and Soul

**Paying** (`playerCalcPayment` 0x08853880, **code**):

```
cost' = card.cost
      − (own Traveler's Tavern 3014 count)            ; unit/base summon (flag 2)
      − (own units with Assist Summon (34) next to the target square)
      − (own Toneriko Tree 3009 count)                ; spell (flag 8)
      − 2 if player flag 0x200 (Cast Spell)
cost' = max(cost', 1)            ; not for maintenance-type calls (flag 4), which double it with Janess' Shadow
remaining cost = player.cost − cost'
remaining soul = player.soul − card.soul              ; g_mapCostRules bit 1
if remaining cost < 0 and remaining soul + remaining cost ≥ 0:   ; bit 2
    remaining soul += remaining cost; remaining cost = 0       ; Soul pays the shortfall
```

**Income.** `income = squares owned + 3 × (Blind Faith units + Magic Mines)`, then
`cost = income − maintenance`.
- Maintenance is `CardDef.maintenance` summed over the team's living units and bases, doubled by
  Janess' Shadow.
- The Dominator itself costs 0.

**Soul** comes from losses. When `unitDestroy(unit, 1)` removes a unit or base that had been on the
board, the unit's **own** team gains 1 Soul (2 with Epsilon's Protection), up to 99. The flag is set
in `mapProcessDeaths(1)`, i.e. after battles, abilities and spells. It is clear for the upkeep
sacrifice and for `mapProcessDeaths(−1)`.

## Summoning units and bases

Choosing a unit or base card goes 0xBC2 → 0xC1C → 0xC26 → 0xC30 (**code**):

- **Unit limit.** At most **16** living units and bases per team, the Dominator included: "Number of
  allowed deployment: 16 − `g_mapPlacedCount[team]`".
- **Legal squares** (`mapCanDeployAt` 0x0885F098, marked 0x80 by `mapMarkSummonCells`). The square
  must exist and be empty. With the default `g_mapDeployRules` = 0x1C, it must also be one of:
  - orthogonally next to an own unit or base;
  - land whose attribute equals the card's attribute (non-zero), provided it is unseized or own land;
  - anywhere, while the Ambush flag is set.

  Rule bits 0x01 (own land) and 0x02 (unseized land) exist but are off.
- **`unitSummonUpdate`** (0x0882F5F0, mode 0) then runs:
  1. A card already discarded (state 8) fails.
  2. The opponent may answer with Negotiation Trouble (`FUN_088467D0`, card-effects.md). A cancelled
     summon still discards the card.
  3. The Cost and Soul are paid.
  4. The unit is placed (`unitPlaceOnGrid`), and its square becomes owned by the team.
  5. Maintenance is recomputed and the card leaves the hand.
  6. Trench Mortar (3015): 2 damage per enemy mortar covering the square, unless the unit has Annul
     Base.
- **Mode 1** places without payment (Dominators at the start, Revival, story scripts).
- A newly summoned unit can act in the same turn: `actFlags` starts at 0 (**code**).

## Movement and land seizing

Move is command 1, states 0x28 → 0x3E8 → 0x3F2 → 0x44C (**code**). A move is a chain of up to **10
straight legs** (`g_mapMovePath` 0x08A1BDF0, `g_mapMoveSegCount`), paid from `effMove` points
(`g_mapMovePoints`).

1. **Lifting the unit.** On the first leg the unit is taken off its square. Move points =
   `effMove`, which Veda (2102) +3, Protection of Wind (2110) +1, Wings of Mercedoa +1, Euro's
   Shackles and Labyrinth Marsh change; the cap is 9.
2. **Marking the legs.** `mapMarkMoveLines` (0x08857788) marks, in each of the 4 directions, up to
   the remaining points. A line stops:
   - at the board edge or a square with land −1;
   - **before** a square held by another team (a unit or base). With Spy (21) a unit may pass enemy
     bases;
   - **on** the first square inside any Labyrinth Marsh (3004) area, unless the unit has Annul Base.
     A unit that starts inside a marsh has only 1 point.

   Own units do not stop a line, but the target square must be empty. There are no other terrain
   costs: every square costs 1 point.
3. **Walking.** The player picks a marked empty square. The unit walks there square by square
   (`unitStepToward`), and every square it enters is seized (`mapSeizeCell`, below).
   - Entering a Labyrinth Marsh area spends all the remaining points.
   - With points left and fewer than 10 legs, a new leg starts from the new square.
4. **Ending the move.** Picking the unit's own square, running out of points or reaching 10 legs ends
   the move (0x44C). Veda is consumed.
5. **Undo.** Cancel steps back one leg at a time (0x4B0), which also undoes that leg's seizes
   (`mapUndoSeize`). Cancel in the command menu right after a move puts the unit back.

**Seizing** (`mapSeizeCell` 0x0885903C):
- A square entered during the move becomes *pending* for the team (bits 8–11) unless one of these
  holds:
  - the unit has Wandering Citizen (41), which seizes only where it stops (**inferred**);
  - the player is under Cause for Civil War;
  - the square lies in an enemy Symbolic Flag (3011) area and the unit lacks Annul Base.
- Enemy-owned squares are taken over, and the per-leg tallies move the counts between the teams.
- `mapCommitConquest` (0x08859384) turns pending bits into ownership bits (12–15) and recounts
  `g_mapConquestCount`. It runs at the end of each action and at the start of a turn.

## Attacking

Attack is command 0x80, states 0x7D0 → 0x7DA → 0x834 → 0x83E (**code**).

- **Targets.**
  - `mapMarkAttackRange` marks every square with |dx| + |dy| ≤ `CardDef.range`, which is 1 for all
    units and Dominators, so only the four orthogonal neighbours.
  - The target must be marked (0x20) and belong to another team: an enemy unit, Dominator or base.
    An own target beeps.
- **Who attacks.** Units and Dominators with `actFlags & 4 == 0`. Bases never attack.
- **The duel.**
  1. After "Commencing attack", `mapBattlePrepUpdate` (0x0885C560) runs `mapBattlePreCheck`
     (0x0885C1B0), which is exactly Evasion (32) and nothing else:
     - Without Evasion on the target, the duel starts.
     - With it: effect of ability 32, target HP := 0, then the hand of the target's **original
       owner** (+0x08) is counted. Fewer than 5 cards: `unitDestroy(target, 0)` (no Soul) and the
       card goes into the first free hand slot, face up (deckState 3). 5 or 6 cards: "…has been
       destroyed"; the unit stays at HP 0 and dies in the following death processing, with Soul and
       death triggers (Revival, Last Flower…).
     - The battle is cancelled: the attacker's Boost bit is cleared and the board goes 0x8FC →
       deaths (0xB54) → action end, so the attacker's action is used up.
  2. The board scene returns scene 0x5A, the duel `battleDuelScene`, with `g_duelAttackerUnit` and
     `g_duelTargetUnit` set.
  3. The duel resolves damage and the battle spells ([effects.md](effects.md#duel-flow-scene-states-and-battleduelupdate-steps)).
- **After the duel** (0x898 → 0x8A2, `mapBattleAfterUpdate` 0x0885D4B4), in this order:
  1. Word Psalm (47, `mapWordPsalmUpdate`).
  2. Bankruptcy Seed (58, `mapAfterBankruptcySeed`).
  3. Gaugabur Farm (3016: +2 HP to its Dominator, `mapAfterGaugaburFarm`). The duel's left side
     is the unit of team 0 (`battleDuelScene`: left = attacker if the attacker's team is 0, else the
     target), and the farm heals `g_mapUnits[side][0]`, so it always heals the Dominator of the team
     that currently holds the farm (card-effects.md).
  4. The Boost flag is cleared.
  5. Bless of Training (49: the survivor gets +1 AP / +1 DF permanently).

  Then deaths are processed with Soul (0xB54).

## Deaths

`mapProcessDeaths` (0x0885EC04), **code**. For every placed unit with HP ≤ 0:

| Step | Check |
| ---: | --- |
| 10 | Return from Shadows (player flag 2): the unit is re-placed at full strength (not a Dominator) |
| 11 | Doll of Living Being (2206 attached): revived |
| 12 | Revival (4): pay the card's Cost again to revive |
| 20 | Last Flower (40): 2 damage to the orthogonal neighbours |
| 30 | death effect 0x35 (skipped for Dominators) |
| 40 | Memento Talisman (12): draw if the hand has ≤ 4 cards |
| 41 | Destiny of Healing (30): own Dominator +2 HP |
| 100 | `unitDestroy`: discard pile, Soul, clear the square, remove the base aura |

A dead Dominator stops the processing at once.

## Bases

A base (card id 3001–3016) is a unit with move 0 that never attacks. Its effect covers the diamond
|dx| + |dy| ≤ `CardDef.range`: `mapAddBaseAura` (0x088585FC) increments the per-square counters and
`mapCountBaseAuras(grid, x, y, teamMask, id)` reads them.

Where each effect is applied:

| Base | Effect | Applied in |
| --- | --- | --- |
| 3001 Goblin Watchtower | enemies −1/−1 | `unitRecalcStats` |
| 3002 Healing Spring | +1 HP | turn start |
| 3003 Elemental Shrine | +2/+1 for units with an attribute | `unitRecalcStats` |
| 3004 Labyrinth Marsh | move 1; stops movement | movement, `unitRecalcStats` |
| 3005 Anti-magic Barrier | no spell targeting | card-effects.md |
| 3006 Magic Mine | +3 income | turn start |
| 3008 Statue of Hero | +1/+1 | `unitRecalcStats` |
| 3009 Toneriko Tree | spells −1 Cost | payment |
| 3010 Makeshift Fortress | DF +1 | `unitRecalcStats` |
| 3011 Symbolic Flag | no seizing by enemies | seizing |
| 3012 TNT Clock Tower | both Dominators −1 HP | turn start |
| 3013 Trap Zone | −1 HP | turn start |
| 3014 Traveler's Tavern | summons −1 Cost | payment |
| 3015 Trench Mortar | 2 damage to enemy summons | summoning |
| 3016 Gaugabur Farm | Dominator +2 HP when attacked | after battle |

Annul Base (16) ignores all of them.

## Land attributes

Land affects play in three ways (**code**):

1. A unit whose attribute equals the land it stands on gets +1 AP and +1 DF (`unitRecalcStats`
   flag 4).
2. Land of the card's attribute is a legal summoning square (deploy rule 0x08).
3. Land −1 is not part of the board.

The Summon Earth / Water / Fire / Air cards (2502–2505, 2509) and abilities (35–38) rewrite
`g_mapLandAttr`.

## Win, loss and draw

- **Dominator KO.** After every action (state 0x2328) the game builds a mask of the players whose
  Dominator (slot 0) has HP > 0:

  | Mask | Result |
  | --- | --- |
  | 1 | player 0 wins (0x2710) |
  | 2 | player 1 wins (0x2AF8) |
  | 0 | draw (0x2CEC) |

  The turn-start steps, deck-out damage and death processing also stop as soon as a Dominator is
  down.
- **Conquest.** At the end of the acting player's action (0x238C), if `g_mapGoalPoints ≠ 0` and
  `g_mapConquestCount[turn player] ≥ goal`, the window "Conquest %d points gained Goal points (%d)
  achieved" opens and the turn player wins. The goal is ⌊80 % of the board's squares⌋.
- **Result screen.** The result goes to `duelResultScreenUpdate` (result screen and save data,
  save-menus.md).
- **Quitting** (0x1388) returns to the title without a result.

"Conditions to win" lists "Lower enemy dominator's HP to 0" and "Gather %d in conquest".

## Where card and ability effects hook in

Only the hooks are listed here; the effects themselves are in card-effects.md.

| Hook | Function | When |
| --- | --- | --- |
| Passive stats | `unitRecalcStats` 0x08830760 → `abilityDispatch(0,0)` | after every change |
| Activated abilities | `abilityDispatch(0,1)` 0x08863AE8, state 0xFA0. Returns −1 cancel, 0x834 attack (Boost), 1 done → deaths | Ability command |
| Map spells | `FUN_08845B0C`, state 0xC80, with `g_mapSpellState` | a spell chosen from the hand |
| Summon reactions | `FUN_088467D0` (Negotiation Trouble and others) | during `unitSummonUpdate` |
| Turn-start bases and attachments | `mapTurnStartUpdate` steps 10–41 | start of turn |
| Death triggers | `mapProcessDeaths` steps 10–41 | after actions |
| Battle triggers | `mapBattlePreCheck` (Evasion), `mapBattleAfterUpdate` | around the duel |
| Stage events | `FUN_08849388(event, stage, …, trigger)` (1 stage start, 9 turn start), `msgEventUpdate` | modes 1/2 |

## Open points

- The fall-back terrain record when no area/variant matches.
- Whether a CPU-only 3- or 4-player game was ever meant: the loops go to 4, but deaths, maintenance
  and the victory checks only cover players 0/1.
