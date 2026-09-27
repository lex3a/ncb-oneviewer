# Computer opponent (AI)

How the CPU player plays a map turn, from the code of the USA EBOOT. Everything here is **code** unless
marked **inferred** or **unknown**. Addresses are in the program loaded at `0x08804000`. The functions
and globals are named `ai*` / `g_ai*` in the Ghidra project.

For related topics, see the other documents:
- The map rules the AI plays under (summon cells, movement, bases, land, turn order): rules.md.
- What each card and ability does once it is played: card-effects.md.
- The duel it predicts: [effects.md](effects.md#duel-scene), in particular `battleCalcDamage`.

## Summary

- **One AI for everyone.** There is no difficulty setting, no per-character weight table and no
  per-ladder parameter. The AI code reads only the board, the hands and the player records. Opponents
  differ only in their deck and their Dominator card (see [Difficulty](#difficulty-and-opponents)).
- **Greedy, one unit at a time.** Each unit is planned alone:
  - an exhaustive search over the cells it can reach finds the best destination and the best attack;
  - a fixed priority ladder then picks between attacking, using an ability, or only moving.
  - There is no look-ahead and no coordination between units.
- **Almost deterministic.** Randomness is used in only three places: placing some bases, targeting
  Earthquake, and the 40 % chance to skip a counter-spell.
- **Never plays duel spells.** In the duel spell phase the CPU always passes.

## Who is a CPU

Each player record (`g_duelPlayers`, 200 bytes) has a controller byte at +0xB8:

| +0xB8 | Controller |
| --- | --- |
| 0 | Local pad |
| 1 | Remote ad-hoc player (pad slot 1 = network input queue; rules.md) |
| ≥ 2 | CPU |

- `ctrlKind` (0x08839C1C) returns 1 / 0 / −1 for these values.
- At the start of each board frame, `mapBoardScene` sets `g_mapTurnIsCpu` (0x08A1BD84) for the player
  whose turn it is.
- When the turn begins (board state 0x0B → 0x13), a CPU player enters the AI. A human player enters
  the manual hand menu (0x10) instead.

## Main state machine — `aiMapTurnUpdate` (0x08822B38)

`mapBoardScene` calls it once per frame while `g_mapBoardState` (0x08A1BD6C) is 0x13.
- The state is in `g_aiState` (0x089AE4DC).
- `g_aiTimer` (0x089AE4DD) counts frames and is reset whenever the state changes.
- `g_aiUnitSlot` (0x089AE4DE) is the unit slot being worked on.
- A nonzero return value becomes the new board state, and `g_aiState` goes back to 0.

| State | Name | Action | Next |
| ---: | --- | --- | --- |
| 0 | INIT | Point `g_aiCurUnit` (0x089AF7C4) at the own unit array and `g_aiEnemyUnits` (0x089AF7C8) at the enemy's. If `g_aiUnitSlot == 0` (start of turn): `aiClassifyUnitRole` for all 31 slots, then `aiResetPlans`. | 1 at turn start, else 3 |
| 1 | DISTMAP | `aiFloodDistMap` from the enemy Dominator's cell, run in 4 successive frames | 4 |
| 4 | CARD | `handSelectUpdate(player, 1)`, which calls `aiChooseHandCard` for a CPU. Card chosen → 6 for a spell, 5 for a unit or base (after `mapMarkSummonCells`). Nothing chosen → 3. | 5 / 6 / 3 |
| 5 | PLACE | `aiPlaceSummon`; the placement runs the opponent's counter window (below) | 4 on success, 3 on failure |
| 6 | SPELL | `mapSpellCastUpdate` (0x08845B0C) with the target chosen by `aiChooseMapSpell` | 4; returns 9000 if a Dominator is dead |
| 3 | SELECT | `aiSelectNextUnit` | 7, or 14 when no unit is left |
| 7 | PLAN | `aiPlanUnit` (search) + `aiCommitPlan` | 10 if 0 steps, else 8 |
| 8 | MOVE START | Take the unit off the grid, set +0x54 = 3, start the board animation | 9 (10 if already there) |
| 9 | MOVE STEP | Walk one cell per step along `g_aiMovePath` (0x089AF7A0). At the end: +0x54 = 3, drop Veda (2102), put the unit back on the grid. | 10 |
| 10 | PAUSE | Wait 64 frames | 11 |
| 11 | DECIDE | `aiDecideAction`: 1 attack, 2 ability, 0 nothing | 12 / 13 / 14 |
| 12 | ATTACK | Wait 32 frames, return 0x834 (the board opens the duel) | — |
| 13 | ABILITY | `abilityDispatch(0, 1)`: 0x834 → duel, > 0 → return 0xB54, < 0 → 14 | — |
| 14 | DONE | Return 9000 (the board goes to its end-of-action state 0x2328) | — |

**After each unit** (board state 0x238C):
- The unit gets flags +0x20 |= 0xF, which marks it as done.
- If Double Action (2608) is attached, it is consumed, the flags are cleared and the same unit goes
  again.
- Otherwise `g_aiUnitSlot` is incremented and the board re-enters the AI. State 0 then skips the card
  phase and goes to SELECT.
- After the Dominator has acted (slot 0, always last), the turn goes on to the end-of-turn discard.

**Order of a CPU turn.**
1. All card plays (state 4 loops until nothing more is played).
2. Units in slot order 1…30.
3. The Dominator (slot 0) last.

Each unit does move → act → next unit.

**Movement path.**
- The path is packed as 2 bits per step: 0 = x−1, 1 = y−1, 2 = x+1, 3 = y+1.
- It is read from the low bits up.
- A u32 holds at most 16 steps; moves are capped at 9 by `unitRecalcStats`.

## Per-unit plan — `g_aiPlans` (0x089ADE14, 31 × 0x38)

The table is indexed by unit slot (unit +0x04).

| Off | Type | Field |
| --- | --- | --- |
| 00 | u8 | flags: 1 = move plan found, 2 = attack plan found |
| 02 | s16 | best move score |
| 04 | u16 | move destination `y<<8 | x` |
| 08 | u32 | move path (2 bits per step) |
| 0D | u8 | move steps |
| 10 | s32 | best attack score |
| 14 | u16 | cell from which to attack (`y<<8 | x`) |
| 18 | u32 | attack path (includes the final step into the target) |
| 1C | u8 | `newCells` of the attack path |
| 1D | u8 | steps to the attack cell |
| 1E | u16 | target `owner<<8 | slot` |
| 20 | u8 | activated ability the AI may use (`aiPickActivatedAbility`) |
| 24 | s32 | ability priority (`aiEvalAbility` probe) |
| 32 | u16 | ability target `owner<<8 | slot` |
| 34 | u8 | role from `aiClassifyUnitRole`; **written but never read** |

**Scratch data:**
- `g_aiDistMap` (0x089AEB20): u8[40][40].
- `g_aiMoveDest` (0x089AF7A4), `g_aiSteps` (0x089AF7A8).
- `g_aiDestDist` (0x089AF7A6): written but never read.

**Map unit fields the AI reads** (unit = `g_mapUnits + owner*0xAA8 + slot*0x58`):

| Off | Field |
| --- | --- |
| +00 | card id |
| +04 | slot (0 = Dominator) |
| +0C | owner |
| +14 / +18 | x / y in 1/64 cell |
| +20 | flags. The AI tests bit 8 (has acted / cannot act), 9 (cannot move: bits 1\|8), 4 (cannot attack) and 2 (no abilities). |
| +21 / +22 | max HP / HP |
| +23 | base AP |
| +25 | attribute |
| +34 | AP |
| +38 | DF |
| +40 | move |
| +54 | active state; must be ≥ 1 to act |

## Unit roles — `aiClassifyUnitRole` (0x08823290)

It runs for every slot at the start of the turn and for every hand card, but the result is never used
(**dead code**). It is kept here because it shows the designers' categories.

| Role | Rule (the last rule that matches wins) |
| ---: | --- |
| 8 / 6 / 7 | Dominator / spell / base |
| 0 | default unit |
| 2 | Defense Skills (14), Ironclad (15), or HP > 4 |
| 3 | move ≥ 4 and no Wandering Citizen (41) |
| 1 | if not role 3: AP > 3, or First Attack (2) and AP > 2 |
| 5 | Counter (23), before everything else |
| 4 | Support Defense (1), before everything else |

## Distance map — `aiFloodDistMap` (0x088228A4)

This is a recursive flood fill from the enemy Dominator's cell.

- **Values.** `g_aiDistMap[y][x]` = number of steps + 1.
  - Crossing a cell that holds an enemy non-Dominator unit sets bit 0x80 on every value behind it.
  - 0xFF means not reached.
- **Where it stops.** At void land (`g_mapLandAttr < 0`), at the map edge, and after 31 steps.
- **Direction rule.** It never steps back the way it came, and keeps the minimum value per cell.
- **Friendly units** of the AI are not obstacles.

## Movement — `aiMoveSearch` (0x08825C70)

`aiPlanUnit` (0x0882694C) resets the unit's plan, then starts a depth-first search from the unit's cell
with depth 0 and all four directions allowed.

**What the search visits:**
- **Every path.** Each path with up to `move` (+0x40) steps is visited, in the direction order W, N, E,
  S. It is exhaustive, with no pruning of cells already seen.
- **Cells with a unit:**
  - An enemy unit blocks the path. The exception is an enemy base, which a unit with Spy (21) can pass.
  - A friendly unit can be passed only by continuing straight on. The unit cannot stop on it or attack
    from it.
- **Labyrinth Marsh.** A cell inside a Labyrinth Marsh (3004) aura, for a unit without Annul Base (16),
  lets the path go on for exactly one more step.
- **Units that cannot move.** A unit with activity flags & 9 (cannot move or finished, rules.md) only
  evaluates its own cell.

**`newCells`** counts the path cells that are not repeats of earlier path cells and whose bit
`12 + turnPlayer` is clear in `g_mapCellFlags` (0x089F7FD0, u16[40][40]). Bit 12 + t is "owned by
team t" (written by `unitPlaceOnGrid` and `mapCommitConquest`), and a player's team equals his
index, so `newCells` counts the squares the move would newly seize for the AI (rules.md). Pending
seizes of the current move (bits 8–11) are not tested, only the repeat check within the path.

### Destination score (s16)

The start cell has score 0. Any other empty cell is scored as follows. `D = g_aiDistMap[y][x]`,
`E` = HP of the enemy Dominator, `A` = the moving unit's AP, `W`/`H` = map size (`g_mapWidth`
0x08A1B266, `g_mapHeight` 0x08A1B268).

| Case | Score |
| --- | --- |
| `D == 0xFF` (enemy Dominator not reachable) | `newCells·256 + (W − |xE − x|) + (H − |yE − y|)` |
| The unit is the Dominator, own HP ≥ 7 **and** `g_mapRound` (0x08A1B25C) ≥ 3 | `newCells·256 + (255 − D)` (advance) |
| The unit is the Dominator, otherwise | `newCells·256 + D` (keep away) |
| `A ≥ E` (one hit could kill the Dominator) | `newCells + 16·(255 − D)` |
| `A < E` and `E ≤ 10`, with `D ≤ 2·move` | `newCells + 4·(255 − D)` |
| `A < E` and `E ≤ 10`, with `D > 2·move` | `newCells + (255 − D)` |
| `A < E` and `E ≥ 11` | `newCells·256 + (255 − D)` (explore first) |

**How the result is kept:**
- The best score wins. A tie keeps the first path found.
- The score is 16-bit, so `newCells·256` can overflow on long paths (**inferred**, harmless in
  practice).
- From every cell where the unit may stop (including its start cell, and unless flags & 4), the four
  neighbours are passed to `aiEvalAttackTarget`.

## Attack evaluation — `aiEvalAttackTarget` (0x08825518)

This predicts the exchange with the enemy unit T on a neighbouring cell, for the moving unit M. It is
the [battleCalcDamage](effects.md#duel-flow-scene-states-and-battleduelupdate-steps) model without
spells.

**Effective values.**
1. `atkM = M.AP`, `atkT = T.AP`, `dfM = M.DF`, `dfT = T.DF`.
2. **Attack Castle.** T is a base and M has Attack Castle (10): `atkM += 5`, `dfM += 1`.
3. **Kodama.** M has Kodama (13): `atkM = T.AP`. T has Kodama: `atkT = atkM`.
4. **Fierce Attack.** M has Fierce Attack (46): `dfT = 0`. T has it: `dfM = 0`.
5. **Reflect Big Swings.** An attack > 3 against a unit with Reflect Big Swings (50) becomes 0.
6. **Resist.** An attack against a unit that resists the attacker's attribute (42–45) becomes 0.
7. **HP left.** `hpM' = M.HP + dfM − atkT` and `hpT' = T.HP + dfT − atkM`.

**Score.**

| Condition | Score |
| --- | --- |
| `hpT' ≤ 0` (kill) | 0x100; 0x4100 if T is the Dominator |
| No kill and `atkM ≤ dfT` | target ignored (no damage) |
| No kill, T is the Dominator | 0x40 + 0x10; 0x101 + 0x10 if `hpT' < 10` |
| No kill, other target | 0x10 |
| M takes no damage (`atkT ≤ dfM`) | +0x1000, unless T is a base |
| M takes damage and survives | +0x80 |
| M would die | penalty 1 (only if M is not the Dominator) |

**Vetoes (score 0).**
- M is the Dominator and T is the Dominator: `hpM' < 10` and `hpM' < hpT'`.
- M is the Dominator and T is not: `hpM' < 5`.
- T has First Attack (2), M does not, and M would die.

**Overrides and penalties.**
- **Evasion.** M has Evasion (32): the score is set to 5. That is below the attack threshold, so units
  with Evasion **never attack**.
- **Death Defense.** M has Death Defense (29): penalty +1 if T has Mutual Death (3) and dies, and +1 if
  T has Word Psalm (47). Penalising your own Death Defense looks like a design slip (**inferred**).

**Keeping the best.**
- The score is `score − penalty`, which replaces the plan when it is higher.
- On a tie it replaces the plan when it has more `newCells`, or the same `newCells` and a path that is
  not longer.

## Commit and decision

**`aiCommitPlan` (0x08826550).**
- If `attackScore < 11`, the attack is dropped and the move plan is used.
- Otherwise the unit walks the attack path up to the cell next to the target.

**`aiDecideAction` (0x08826B48)** runs at the destination, after the 64-frame pause.
1. `aiPickActivatedAbility` (0x08827A00) picks the unit's activated ability. That is the **last**
   activated ability among the card's three slots, and none if flags & 2 or if the MP/Soul cost is not
   affordable (`playerCalcPayment` 0x08853880).
2. `aiEvalAbility` (0x08827B64) probes it and gives a priority `pri` (−1 when there is none). `atk` is
   the committed attack score.

| Order | Test | Action |
| ---: | --- | --- |
| 1 | `pri ≥ 6` | ability |
| 2 | `atk ≥ 0x1000` (attacks without taking damage) | attack |
| 3 | `pri ≥ 4` | ability |
| 4 | `atk ≥ 0x100` (a kill) | attack |
| 5 | `pri ≥ 1` | ability |
| 6 | `atk ≥ 1` | attack |
| 7 | — | nothing |

An attack sets `g_duelAttackerUnit` / `g_duelTargetUnit` and opens the duel.

### Activated abilities (`aiEvalAbility`)

| Ability | Evaluator | Priority |
| --- | --- | --- |
| Snipe LV1/2/3 (6/51/52) | `aiEvalSnipe` 0x08826E78 | Targets enemies within radius 2/3/4. Base value 4, Dominator 6 (7 if HP < 10); +1 if own AP ≥ target HP; +1 if target AP > 4. The best target is used. |
| Assassinate (8) | `aiEvalAssassinate` 0x0882715C | Marks the radius-3 diamond (`mapFillDiamond`), scans x−3…x+2, y−3…y+2 and takes the marked enemy without Death Defense with the strictly highest AP + maintenance (4), then clears the marks |
| Berserk (26) | `aiEvalBerserk` 0x08827400 | The last adjacent enemy checked (W, N, E, S) decides: its Dominator with HP ≤ 2 → 4; own HP < 3 → −1; it has Reflect Big Swings → 3; own HP < 7 → 3 if ≥ 3 adjacent enemies, else −1; otherwise 3 if ≥ 2 adjacent enemies, else −1 |
| Boost (27) | inline | 3 if an attack plan exists; used on the attack target |
| Summon Earth/Water/Fire/Air (35–38) | `aiEvalSummonElement` 0x08827664 | 1 if the unit's cell is not already that element (1–4), else 0 |
| Evolution (54) | inline | 1 unless Soul (+0xAC) < 2 or base AP > 29 |
| Rotating Slash (55) | `aiEvalRotatingSlash` 0x08827808 | −1 if its own Dominator is adjacent with HP < 2; 4 if an adjacent enemy has Reflect Big Swings; 3 if ≥ 2 adjacent enemies; else −1 |

The AI never uses the other activated abilities: Foot Stamp, Cast Spell, Destroy Outpost, Mind Read,
Breath, Base Repair, Pick Pocket and Domination Call. The effects themselves are in card-effects.md.

## Unit selection — `aiSelectNextUnit` (0x08826694)

The scan starts at slot `g_aiUnitSlot` (slot 1 when it is 0), goes up to slot 30, then ends with
slot 0. It takes the first own unit that meets all of these:
- a unit or Dominator card (bases and spells never act);
- HP > 0;
- +0x54 ≥ 1;
- not flags & 8.

When slot 0 cannot act, the result is −1 and the turn ends.

## Card play

### Choosing the card — `aiChooseHandCard` (0x08824EF4)

`handSelectUpdate` (0x08854AF8, the shared hand picker) calls it for a CPU in mode 1. The usable flags
come from `handMarkUsableCards` (0x088547F0): the cost is checked and the nibble in +0x98 is 1 when the
card is affordable.

1. **Frames 0–5.** One hand slot per frame is recorded into `g_aiHandCards` (0x089AF7B4) if it is
   usable. The roles go into `g_aiHandRoleMask`, which is never read.
2. **Frame 6.** The hand is walked **in slot order** and the **first** card that passes is played:

| Card | Condition |
| --- | --- |
| Unit | `g_mapPlacedCount[player] < 16` (0x08A1B324: units and bases with HP > 0 on the board per team, Dominator included; recounted by `mapCountDeployed` at placement, revival, spell casting and turn start, not at deaths — rules.md) |
| Base | Same limit. Never Healing Spring (3002), Labyrinth Marsh (3004) or Trap Zone (3013). TNT Clock Tower (3012) is not played when the enemy Dominator has less HP than the own one and more than 15. |
| Spell | `aiChooseMapSpell(id)` returns nonzero (see below) |

3. When no card passes, the function returns −1 and the card phase ends.

After each card has resolved, the state machine returns to state 4. The hand is marked again (costs
change) and the choice is repeated. As a result, the AI plays cards in hand order until none is
affordable or wanted. There is no cost/value comparison between cards.

### Placing units and bases — `aiPlaceSummon` (0x0882523C)

- **Candidate cells.** `mapMarkSummonCells` (0x08858C1C) sets bit 0x80 on the byte grid
  `g_mapGrid + 0x23F00` for every legal summon cell. The legality rule is `FUN_0885F098`, see rules.md.
- **Chosen cell.** The AI takes the candidate with the lowest `g_aiDistMap`, which is the cell closest
  to the enemy Dominator. The scan is row-major with a strict comparison, so the first cell wins ties.
- **Bases that go the other way.** Magic Mine (3006), Toneriko Tree (3009), TNT Clock Tower (3012) and
  Traveler's Tavern (3014) take the **highest** distance.
- **Random bases.** Anti-magic Barrier (3005) and Symbolic Flag (3011) toss a coin with
  `((gameRandNext() & 0xFFFF) + 1) / 11 & 1`.
- The cell is kept in `g_aiSummonCell` (0x088B795C) until the placement is done.

### Map spells — `aiChooseMapSpell` (0x08823450)

This returns the card id to cast, or 0.
- The target is in `g_aiSpellTargetCell` (0x089AF7AC) and `g_duelAttackerUnit`.
- The target defaults to the AI's own Dominator; `g_aiCurUnit` is also set to it on entry.
- Scores are compared **unsigned** (strict `<`, so the first unit of the best score wins); the loops run
  over both rows (`g_mapUnits[0]`, then `[1]`) and pick by team (+0x0C).
- When a card is scored, it is cast if the best score is nonzero.
- Targets must pass `aiSpellTargetOk` (0x08827DE4, mask in parentheses). Every mask requires the unit to
  be alive with +0x54 ≥ 1:

| Mask bit | Excludes a unit that… |
| --- | --- |
| 1 | stands in an Anti-magic Barrier (3005) aura (unless it has Annul Base) |
| 2 | has Annul Attack (19) |
| 4 | has Unable to Buff (20) |
| 8 | has Death Defense (29) |
| 0x10 | has Magic Barrier (2402) attached |
| 0x20 | already has 6 attachments |
| 0x40 | is a Dominator |
| 0x80 | is a base |

Player record fields used below:
- +0xA5 hand size;
- +0xA6 cards left in the deck: the number of deck slots whose state is 0, recounted by every draw
  (rules.md). "Unexpected Guest" checks `5 − hand ≤ +0xA6`;
- +0xB4 flag word;
- `own`/`enemy` = the AI player / its opponent.

| Spell | Cast when / on |
| --- | --- |
| 2001 Magic Bolt, 2009 Reversal of Power | the enemy Dominator, if targetable (mask 3) |
| 2003 Guidance of Dusk, 2004 Homesick, 2005 Strength Atonement, 2006 Collapsed Heart | The enemy unit (mask 0x1B) with the highest score. Score: if `g_aiDistMap` at the unit ≤ its reach (move, +2/+3/+4 with Snipe 1/2/3, as a byte): `0x40000000`, plus `0x80000000` if the AI Dominator's HP ≤ its AP (byte) - the second bit is only tested inside the reach test; then `+ (HP+DF)` if ≥ 2; `+ AP` if > 3. Strength Atonement scores 0 unless AP ≥ 5, Collapsed Heart unless HP+DF ≥ 5. The distance map measures distance to the *enemy's own* Dominator, so the 0x40000000 test really means "within reach of its Dominator" (**inferred** design slip). |
| 2007 Earth Nova | Counts units with HP < 5 on each side (mask 0x13). Enemy Dominator targetable with HP ≤ 4 → on it. Otherwise, if the own Dominator is not targetable or has HP > 4, and there are more weak own units than weak enemy units → on the own Dominator. |
| 2103 Foot-stopper | never |
| 2109 Chick Bug Curse | the enemy unit with the highest AP + maintenance, if > 10 (mask 0xD1) |
| 2110 Protection of Wind | the own Dominator if it passes mask 0xB1 and carries ≤ 2 copies; otherwise the own unit with move ≤ 8 and no Wandering Citizen, maximising `move·256 + AP` (mask 0xB1) |
| 2201 Healing Drop (+2), 2202 Healing of Divine Maiden (+5) | the own Dominator if HP < 11 and targetable (mask 0x11; the score is set to the card id); else the own unit with HP + heal ≤ max HP and the highest effective AP (+0x1000 for the Dominator; no +1) (mask 0x11) |
| 2203 True Guise | the enemy unit with the most attachments (score = count << 16; 0 for one carrying Foot-stopper 2103) (mask 0x91). The loop runs `g_numPlayers` times over the **enemy row only**, so a unit that changed sides is missed. |
| 2204 Return from Shadows | the own Dominator, if player flag 2 is clear |
| 2206 Doll of Living Being | the own unit with maintenance ≥ 10 and the highest maintenance, not already carrying one (mask 0xF1) |
| 2207 Blessing Light | the own unit without Death Defense, maintenance ≥ 10, maximising maintenance + AP (mask 0xF1) |
| 2208 Green Noa | more than 2 damaged own units (Dominator counts when HP < max − 3), or own Dominator HP < 1 → on the own Dominator |
| 2301 Toy Sword | the enemy unit with the highest AP, if AP > 2 (mask 0xB5) |
| 2302, 2303, 2306, 2307, 2308, 2310 (attachments) | Own unit (mask 0xB5). Score: `0x8000` if `g_aiDistMap ≤ move` (can reach the enemy Dominator) + `0x1000` if HP > 2. |
| 2304 Guardian Ward | Own unit. Score: `0x80` if `g_aiDistMap ≤ move` + `0x1000` if AP ≥ 5 + `0x100` if HP > 2. |
| 2402 Magic Barrier | the own unit with the highest maintenance (the Dominator counts as 100) (mask 0xB1) |
| 2506 Earthquake | Enemy **bases** (mask 1). Score = `HP · (((gameRandNext() & 0xFFFF) + 1) % 10 + 1)`, the best one. |
| 2601 Memory Slip | enemy hand > 2 |
| 2602 Unexpected Guest | Enemy Dominator HP < 6 and enemy deck < 6 → enemy. Otherwise own hand < 3 and own deck ≥ 5 − hand → self. |
| 2603 Turn Over a New Leaf | Enemy Dominator HP < 6 and enemy deck < 6 → enemy. Otherwise own hand < 3, except when own deck < 6 and own Dominator HP < 11 → self. |
| 2604 Destruction of Future | always, on the enemy |
| 2605 Cause for Civil War | enemy flag 8 clear |
| 2606 Starving the Enemy | enemy hand > 3 |
| 2607 Dried-up Well | enemy hand > 1 |
| 2609 Battlefield Scales | enemy `g_mapPlacedCount` > 3 and own < enemy |
| 2611 Winter Preparation | own deck < 10 |
| 2613, 2614, 2616, 2617 (Janess' Shadow, Breath of Hellgaia, Wings of Mercedoa, Epsilon's Protection) | own flag 0x20 / 0x40 / 0x80 / 0x100 not yet set |
| 2615 Euro's Shackles | whenever the two `g_mapPlacedCount` values differ (unsigned difference ≠ 0) |
| All others (2002, 2008, 2010, 2101, 2102, 2104–2108, 2205, 2309, 2401–2405, 2501–2505, 2507–2510, 2608, 2610, 2612) | never cast on the map |

**How the cast runs.** `mapSpellCastUpdate` skips the manual targeting for a CPU and jumps to the
counter window (state 3000). `spellGetTargetMode` (0x088475E8) sets `g_mapSpellTargetMode` (it only
decides whether Magic Barrier can nullify the spell: modes 1 and 2); see card-effects.md.

## Counter spells and the duel spell phase

**Counter window — `mapCounterSpellWindow` (0x088467D0).**
- **When it opens.** After a map spell (mode 0x20) or a summon (mode 0x40), the opponent may answer.
  - Mode 0x20 accepts Reverse Magic (2405) or Defuse Spellpower (2401).
  - Mode 0x40 accepts Reverse Magic (2405) or Negotiation Trouble (2403).
- **When the CPU is the one answering:**
  1. It waits 48 frames.
  2. It declines if `(((gameRandNext() & 0xFFFF) + 1) / 11) % 10 < 4`, which is about 40 %.
  3. Otherwise it plays the first usable counter card in its hand (hand order, `handMarkUsableCards`).
- **When the CPU is the caster** and the human counters, the CPU waits 48 frames on the announcement,
  then accepts.

**Duel spell phase (`battleSpellSelectUpdate` → `handSelectUpdate(player, 0x10)`).** For a CPU, the
picker goes straight to "done" without choosing a card, so the CPU **never casts a spell in a duel**.

**End-of-turn discard.** When all 6 hand slots are full, `handSelectUpdate(player, 0x400)` runs.
`aiChooseDiscard` (0x088251E8) waits 32 frames, then discards the first occupied slot. This repeats
while hand > 5.

## Randomness

`gameRandNext` (0x0887B544) is used by the AI only here:

| Where | Formula | Effect |
| --- | --- | --- |
| `aiPlaceSummon` | `((r & 0xFFFF) + 1) / 11 & 1` | Anti-magic Barrier / Symbolic Flag: nearest or farthest cell |
| `aiChooseMapSpell` (Earthquake) | `((r & 0xFFFF) + 1) % 10 + 1` | multiplier 1–10 on each base's HP |
| `mapCounterSpellWindow` | `((r & 0xFFFF) + 1) / 11 % 10 < 4` | 40 % chance to skip a counter-spell |

Everything else is deterministic for a given board. Ties go to the first slot, the first cell in
row-major order, or the first path found in W-N-E-S order.

## Difficulty and opponents

- **No difficulty variables.** No AI function reads the stage, the ladder position, the opponent's
  character id or any table of weights.
- **Deck.** `stageSelectScene` picks the opponent with `charaGetLadderId(stage)` (ladder
  `g_charaLadderOrder` 0x088B9FA0, s32 entries). It loads the deck with
  `dbGetDeckByDominator(id, …, flags)`:
  - A first fight in story mode passes flags 3. Bit 2 stops at the **first** matching deck, which is
    one of decks 11–20.
  - Replaying a cleared stage passes flags 1. That takes the **last** match: the rematch decks 21–30
    for Dominators 1012–1021.
  - The earlier Ghidra comment said the opposite. The loop was traced, and the comment is corrected.
- **What makes opponents differ** is only:
  - their deck and card order;
  - their Dominator card (1012–1021 have more HP);
  - the map.

## Known quirks

**Design slips:**
- Units with Evasion never attack, because their score is 5 and the threshold is 11.
- Units with Death Defense are penalised against Mutual Death / Word Psalm targets.
- Units are never retreated to heal. Only the Dominator stays back, and only while HP < 7 or before
  round 3.

**Dead code:**
- The unit and hand roles are computed but never read.
- `g_aiDestDist` is written but never read.

**Wasted work:**
- `aiFloodDistMap` runs 4 times with identical input. A single pass already converges, because the
  fill keeps the minimum.
