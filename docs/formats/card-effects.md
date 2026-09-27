# Card effects: spells, abilities, attachments and bases

What every spell card, ability and base card does, taken from the code of the USA EBOOT (ULUS10382).
The card and ability tables themselves are described in [database.md](database.md). The duel scene and
its HP pass are in [effects.md](effects.md). The turn structure, movement and land seizing are in
[rules.md](rules.md), the computer player in [ai.md](ai.md), menus and rewards in
[save-menus.md](save-menus.md).

Everything here is **code** unless it is marked **inferred** or **unknown**. "Text" means the card's
`effectText` (`CardDef` +44) or the ability description (`AbilityDef` +1C). Effect ids are
`CardDef` +3E (duel) / +3F (map) and `AbilityDef` +1A; `effectStart(n)` plays effect.one entry
`1000 + n`.

## Terms and data used below

**Map unit record** (`g_mapUnits`, 0x58 bytes, 31 per player: slot 0 is the Dominator; bases are
ordinary slots 1–30).

| Off | Field | Notes |
| --- | --- | --- |
| 00 | cardId | |
| 04 | slot | 0 = Dominator. |
| 08 | original owner | Hand/discard owner. Kept by Rise of the Betrayer. |
| 0C | u8 current owner | Controls the unit. |
| 14 / 18 | x, y | Cell × 64. |
| 20 | u8 activity flags | 1 cannot move, 2 no ability, 4 no attack, 8 finished; 0xF = all actions used. Lurk sets 6, Foot-stopper and Foot Stamp 0xF, Double Action resets to 0 (every writer: [rules.md](rules.md#activity-flags-0x20)). |
| 21 / 22 | max HP, HP | s8. |
| 23 | base AP | Card AP; changed by Kodama, Attack Castle, Evolution, Bless of Training. |
| 24 | DF bonus | 0 at summon; Bless of Training +1. |
| 25 | attribute | 0 none, 1 earth, 2 water, 3 fire, 4 air. |
| 26 | u16[6] attachments | Spell card ids, compacted (`unitCompactAttachments` 0x08830580). |
| 34 / 38 / 3C / 40 | effective AP, DF, range, move | Computed by `unitRecalcStats` (0x08830760). |
| 48 | u16 status | Bit 0 Boost, bit 1 Foot Stamp, bit 2 Euro's Shackles (see [Status bits](#status-bits-0x48)). |
| 54 | state | > 0 while on the board (4 dying, 6 shrunk away, see [rules.md](rules.md)). |

**Player flag word** (`g_duelPlayers[p]` + 0xB4, record 200 bytes at 0x089D1B48):

| Bit | Set by | Effect | Cleared |
| --- | --- | --- | --- |
| 0x002 | 2204 Return from Shadows | Next own non-Dominator death is revived | When used |
| 0x004 | 2507 Ambush | Next summon may go on any empty land cell (`mapCanDeployAt` 0x0885F098) | After the next summon, even a countered one |
| 0x008 | 2605 Cause for Civil War | No land seizing (`mapSeizeCell` 0x0885903C) | End of that player's turn |
| 0x010 | 2607 Dried-up Well | Every hand card greyed (`handMarkUsableCards` 0x088547F0), so no spells, duel spells or counter spells | End of that player's turn |
| 0x020 | 2613 Janess' Shadow | `unitSumMaintenance` doubles every unit's maintenance; it ORs **both** players' words, so both players pay double | Never |
| 0x040 | 2614 Breath of Hellgaia | +1 AP / +1 DF to all own units and the Dominator (bases are skipped by `unitRecalcStats`) | Never |
| 0x080 | 2616 Wings of Mercedoa | Move +1 (max 9) to all own units | Never |
| 0x100 | 2617 Epsilon's Protection | `unitDestroy` (0x0882FC34) gives the Soul for a destroyed own unit twice | Never |
| 0x200 | Cast Spell (ability 9) | Next spell or summon costs 2 less | When a card is paid (`playerPaySelectedCard` 0x0883C9DC) or a unit is summoned |

Flags 8 and 0x10 are cleared by `mapTurnEndClearStatus` (0x0885BEFC), which also clears status bit 1
and removes Foot-stopper attachments of the player whose turn ends. Because the bits are only ORed in,
"the effects of this card do not accumulate" holds for all the permanent cards.

**Areas.** All areas are diamonds (`|dx| + |dy| ≤ r`, `mapFillDiamond` 0x08858020). "Neighbouring"
always means the 4 orthogonal cells. Base auras use the base's `CardDef.range` as r; the per-cell,
per-player counters are kept by `mapAddBaseAura` / `mapRemoveBaseAura` and read by
`mapCountBaseAuras` (0x088595A0).

**Costs** (`playerCalcPayment` 0x08853880, flags per use):
- summon (flag 2): −1 per own Traveler's Tavern (3014) on the board, −1 per own unit with Assist
  Summon (34) on a cell next to the target cell;
- spell (flag 8): −1 per own Toneriko Tree (3009);
- spell or summon: −2 with player flag 0x200 (Cast Spell);
- the result is clamped to **1**, not 0 (only a card that already costs 0 stays at 0);
- activated abilities and Revival use flag 0x10: no modifier at all.

A countered spell or summon is still paid.

## Map spells

`mapSpellCastUpdate` (0x08845B0C) runs the spell cast on the map. Its state `g_mapSpellState`
(0x089B7984) steps through:

| State | What happens |
| --- | --- |
| 1000 | Target selection, `spellSelectTarget(card, mode)` (0x0883A514) |
| 2000 | Confirmation and legality, `spellConfirmTarget(card, mode)` (0x0883B7B8) |
| 3000 | `mapCounterSpellWindow(card, 0x20)` (0x088467D0), then the handler's effect id: the handler returns 1 for `CardDef` +3F, or its own id (Cityscape Mirage), or 0 for none |
| 4000 | The effect is applied |
| 5000 | Wait for the player to confirm |
| 9000 | Pay the card (`playerPaySelectedCard`), recompute stats and maintenance |

The per-card handler is chosen by card id; the handler names are `spell*` (table below).

**Target modes** (`spellSelectTarget`):

| Mode | Target |
| --- | --- |
| 1 | Any occupied cell: unit, base or Dominator |
| 2 | Unit or Dominator (id < 2000), no base |
| 3 | Base |
| 4 | Land cell (attribute ≥ 0) |
| 5 / 6 | Area centre (land cell) / area confirmation |
| 7 | Choose a player |
| 8 | The opponent, automatically |
| 10 / 12 | No target (caster) |
| 11 | List of the own discard pile |
| 9 | Validation-only mode of the attachment cards (target as mode 2) |

**Common legality checks** (`spellConfirmTarget`):
- 2001, 2003–2006, 2009, 2010 are refused on a unit with **Annul Attack** (19).
- 2301–2399 are refused on a unit with **Unable to Buff** (20).
- 2003–2006 are refused on a unit with **Death Defense** (29). Every base has ability 29, and the
  Dominator ability (53) counts as 20 and 29, so bases and Dominators are never valid there.
- Unit targets inside any player's **Anti-magic Barrier** (3005) are refused unless the unit has
  **Annul Base** (16). Land targets (mode 4) inside a barrier are always refused.
- Attachment cards (mode 9) are refused on a unit that already has 6 attachments. True Guise needs at
  least one.

**Counter spells and Magic Barrier** (`mapCounterSpellWindow`, kind 0x20 for spells, 0x40 for
summons):
- The opponent of the caster may answer if he holds Reverse Magic (2405, any card), Defuse Spellpower
  (2401, spells) or Negotiation Trouble (2403, summons). The CPU declines 40 % of the time
  ([ai.md](ai.md)).
- A successful counter is paid by the opponent and plays effect 0x45 (69) when the counter card has a
  map effect (all three do); the window flow and texts are in map-board.md "Counter window". Reverse
  Magic also deals 2 damage to the caster's Dominator.
- If nobody counters a spell whose target mode is 1 or 2 (or either unit of Relocation), and the
  target carries a **Magic Barrier** (2402), the spell is nullified automatically and the barrier is
  removed. This happens whoever cast the spell, so it also eats the owner's own buffs and heals.
- A countered Shard of Life / Divine Light puts the chosen cards back into the discard pile.

### Spell table

Cost is cost/Soul. **B** = usable in a duel (`CardDef.abilityIds[0] = 1`), **A** = attaches
(`abilityIds[1] = 1`). Effects are duel/map ids. HP never goes below 0, and heals are capped at max HP.

| Id | Name | Cost | B/A | Eff | Handler | Target | Effect as implemented | Text vs code |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2001 | Magic Bolt | 3/0 | B | 55/7 | `spellMagicBolt` 0x0883CA94 | 1 | HP −3, DF ignored | Bases can be targeted. |
| 2002 | Firestorm | 7/0 | – | 0/35 | `spellFirestorm` 0x0883CC00 | 5 | Every living unit, base and Dominator (both sides) within 3 of the cell: HP −2. Skips Annul Attack, units inside Anti-magic Barrier without Annul Base, and Magic Barrier (consumed). | Hits own units, bases and Dominators. |
| 2003 | Guidance of Dusk | 8/0 | B | 60/19 | `spellGuidanceOfDusk` 0x0883D5BC | 1 | HP = 0 | "Bases cannot be destroyed" works only through their Death Defense. |
| 2004 | Homesick | 6/0 | – | 0/24 | `spellHomesick` 0x0883D70C | 1 | The unit goes back to its original owner's hand if that hand has < 5 cards; otherwise HP = 0 | Also refused on any unit with Death Defense or Annul Attack. |
| 2005 | Strength Atonement | 6/0 | B | 60/19 | `spellStrengthAtonement` 0x0883DA0C | 1 | HP = 0 | Code: AP **≥ 4** (map `AP < 4` refused, duel `3 < AP`). Text: "more than 4". |
| 2006 | Collapsed Heart | 6/0 | B | 60/19 | `spellCollapsedHeart` 0x0883DB5C | 1 | HP = 0 | Code: HP + DF **≥ 5** (`< 5` refused; duel `4 < HP+DF`). Text: "more than 5". In a duel an invalid target is not refused: the card is spent for nothing. |
| 2007 | Earth Nova | 10/3 | – | 0/36 | `spellEarthNova` 0x0883DCAC | 12 | All living units, bases and Dominators of both players: HP −4, with the same exclusions as Firestorm | ✓ |
| 2008 | Magic Dragon Gaze | 12/3 | – | 0/40 | `spellMagicDragonGaze` 0x0883DF2C | 5 | Within 5 of the cell: HP = 0, except Annul Attack, Death Defense (so bases and Dominators), Anti-magic Barrier area, Magic Barrier (consumed) | ✓ |
| 2009 | Reversal of Power | 5/0 | B | 64/18 | `spellReversalOfPower` 0x0883E8FC | 1 | HP −(target effective AP), DF ignored | ✓ |
| 2010 | Side-Effect | 1/0 | B | 64/18 | `spellSideEffect` 0x0883EA6C | 1 | HP −2 × attachments | ✓ |
| 2101 | Push | 6/0 | – | 0/24 | `spellPush` 0x0883EBE8 | 1 | Move the unit to an empty cell within 3 of it | Bases and Dominators can be pushed. |
| 2102 | Veda | 3/0 | A | 0/16 | `spellAttachCard` 0x08845144 | 2 | Attachment: move +3; removed after the unit moves (`mapBoardScene`) | ✓ |
| 2103 | Foot-stopper | 4/0 | A | 0/18 | attach | 2 | Attachment: activity 0xF (cannot act); removed by `mapTurnEndClearStatus` (0x0885BEFC) at the end of the turn of the player whose index equals the unit's current team, i.e. on an enemy unit it costs that enemy one turn | ✓ |
| 2104 | Lurk | 3/0 | A | 0/26 | attach | 2, not Dominator | Attachment: activity \|= 6, so the unit can only move; permanent | The duel code handles 2104, but the card is not battle-usable. |
| 2105 | Mask of Change | 10/0 | – | 0/23 | `spellMaskOfChange` 0x0883F218 | 1: own unit, not Dominator, not base, still owned by its original owner | Pick a unit card in hand; the target goes to the hand, the hand card is placed on the same cell (free, no counter window, no Trench Mortar) | ✓ |
| 2106 | Mirror Reflection | 7/1 | – | 0/23 | `spellMirrorReflection` 0x0883F720 | 2, not Dominator/base | Then pick any other unit on the board (not base/Dominator). The target takes its card id, max HP **and full HP**, base AP and attribute; all attachments are removed; activity flags are reset (it may act again) | Side effects not in the text: the unit is healed and refreshed. |
| 2107 | Relocation | 5/1 | – | 0/24 | `spellRelocation` 0x0883FECC | 1 twice, no Dominator | Swap two units' cells | Bases are **not** refused. The barrier test on the 2nd cell uses the 1st unit's Annul Base (bug). |
| 2108 | Rise of the Betrayer | 7/1 | – | 0/26 | `spellRiseOfTheBetrayer` 0x088407F0 | 1: enemy, not Dominator, caster has ≤ 15 units | Current owner flips; the original owner keeps the card (discard pile) | Enemy bases can be taken. |
| 2109 | Chick Bug Curse | 1/0 | – | 0/23 | `spellChickBugCurse` 0x0884097C | 2, not Dominator | Becomes card 55 Chick Bug (AP 0, HP 1/1) | Attachments and activity flags are **kept** (Mirror Reflection clears them). |
| 2110 | Protection of Wind | 1/0 | A | 0/16 | attach | 2 | Attachment: move +1, permanent | ✓ |
| 2201 | Healing Drop | 3/0 | B | 59/20 | `spellHealingDrop` 0x08840C54 | 1 | HP +2 | In a duel it does nothing on a unit at 0 HP. |
| 2202 | Healing of Divine Maiden | 8/0 | B | 59/20 | `spellHealingOfDivineMaiden` 0x08840DC8 | 1 | HP +5 | Same. |
| 2203 | True Guise | 7/0 | B | 63/34 | attach (op "remove all") | 9 | Removes all attachments; True Guise itself is not attached | ✓ |
| 2204 | Return from Shadows | 6/0 | – | 0/20 | `spellSetCasterFlag` 0x088455B8 | 10 | Player flag 2. `mapDeathReturnFromShadows` (0x0885DC90): the first own non-Dominator unit or base that dies is re-created from its card on the same cell | Bases are revived too. |
| 2205 | Shard of Life | 7/1 | – | 0/20 | `spellShardOfLife` 0x08840F3C | 11 | One unit or base card from the own discard pile is placed on a deploy square (`mapMarkDeployCells`) at full HP; refused at 16 units on the board | ✓ |
| 2206 | Doll of Living Being | 6/1 | BA | 59/20 | attach | 2, not Dominator | Attachment. `mapDeathDollOfLiving` (0x0885DEA8): on death the unit is re-created on its cell (full HP, attachments gone, current owner kept) | Checked before Revival (see [Death order](#death-order)). |
| 2207 | Blessing Light | 4/0 | BA | 68/17 | attach | 2 | Counts as Death Defense (29) in `unitCountAbility` | ✓ |
| 2208 | Green Noa | 10/2 | – | 0/37 | `spellGreenNoa` 0x08841760 | 12 | All own living units, bases and the Dominator: HP +3. Skips units inside Anti-magic Barrier (no Annul Base) and units with Magic Barrier, which **consumes** the barrier | Bug: a heal uses up the owner's own Magic Barrier. |
| 2301 | Toy Sword | 4/0 | BA | 64/18 | attach | 2 | AP = 1 after every other modifier (Kodama still overrides it) | ✓ |
| 2302 | Grace of Treasured Sword | 5/0 | BA | 57/14 | attach | 2 | AP +4, DF +1 | ✓ |
| 2303 | Gush of Power | 6/0 | BA | 57/14 | attach | 2 | AP +3, DF +2 | ✓ |
| 2304 | Guardian Ward | 4/0 | BA | 58/15 | attach | 2 | DF +3 | ✓ |
| (2305) | — | | | | | | `unitRecalcStats` and the dispatcher handle id 2305 as AP +2, DF +2, but no card 2305 exists | Cut card. |
| 2306 | Premonition of Battle | 4/0 | BA | 68/17 | attach | 2 | Counts as First Attack (2) | ✓ |
| 2307 | Vow of Comrade | 4/0 | BA | 68/17 | attach | 2 | Counts as Support Attack (24): the unit's adjacent allies get AP +1 | ✓ |
| 2308 | Sure-Kill | 5/2 | BA | 57/14 | attach | 2 | AP +6 and counts as First Attack. `mapTurnSureKillDamage` (0x08859F94): at the start of the owner's turn HP −1 per Sure-Kill | ✓ |
| 2309 | Curse of Aging | 4/0 | BA | 64/18 | attach | 2 | HP −2 at once; attachment AP −2, DF −1 (clamped to 0 with the rest of the stats) | ✓ |
| 2310 | Piercing Shock | 6/0 | BA | 68/17 | attach | 2 | Counts as Fierce Attack (46) | ✓ |
| 2401 | Defuse Spellpower | 6/0 | – | 70/69 | `mapCounterSpellWindow` | reaction | Nullifies a spell | Only usable in the counter window. |
| 2402 | Magic Barrier | 5/0 | A | 58/15 | attach | 2 | Nullifies the next targeted spell, area damage spell or Green Noa that would affect the unit, then disappears. In a duel the spell plays effect 70 instead | Automatic, not optional. |
| 2403 | Negotiation Trouble | 4/0 | – | 70/69 | counter | reaction | Nullifies a summon; the summoned card goes to the discard pile | ✓ |
| 2405 | Reverse Magic | 4/1 | – | 70/69 | counter | reaction | Nullifies a spell or a summon; the caster's Dominator takes 2 damage | ✓ |
| 2501 | Strategic Retreat | 1/0 | – | 0/39 | `spellStrategicRetreat` 0x088419F0 | 12 | A random own land cell without a unit becomes unowned (random key per cell, highest wins); Cost +3 | ✓ |
| 2502–2505 | Summon Earth / Water / Fire / Air | 7/0 | – | 0/30–33 | `spellSummonLand` 0x08841D84 | 4 | Cell attribute (`g_mapLandAttr`) = 1 / 2 / 3 / 4 | ✓ |
| 2506 | Earthquake | 7/0 | B | 62/39 | `spellEarthquake` 0x08841EF8 | 3 | Base HP = 0. Death Defense is not checked. Own bases are allowed (with a warning) | ✓ |
| 2507 | Ambush | 5/2 | – | 0/24 | `spellSetCasterFlag` | 10 | Player flag 4 (see above) | ✓ |
| 2508 | Lord of Blanks | 9/1 | – | 0/39 | `spellLordOfBlanks` 0x08842048 | 4 | Every land cell within 2 with no unit and outside Anti-magic Barrier loses its owner | ✓ (the barrier exemption is not in the text) |
| 2509 | Cityscape Mirage | 11/0 | – | 0/30 | `spellCityscapeMirage` 0x08842340 | 4 + menu | Attribute of choice; plays effect 30–33 to match | ✓ |
| 2510 | Flames of Invasion | 4/0 | – | 0/23 | `spellFlamesOfInvasion` 0x088427D4 | 4, empty cell | The cell and its 4 neighbours, if empty and outside Anti-magic Barrier, become the caster's land | ✓ |
| 2601 | Memory Slip | 3/0 | – | 0/0 | `spellMemorySlip` 0x08842AE8 | 7 | The player discards up to 3 random hand cards | ✓ |
| 2602 | Unexpected Guest | 3/0 | – | 0/0 | `spellUnexpectedGuest` 0x08842E70 | 7, hand < 5 | Draws until 5 cards (`playerDrawCardUpdate` 0x08853FAC) | ✓ |
| 2603 | Turn Over a New Leaf | 6/0 | – | 0/0 | `spellTurnOverANewLeaf` 0x088430E8 | 7 | Discards the whole hand, then draws 5 | ✓ |
| 2604 | Destruction of Future | 5/0 | – | 0/0 | `spellDestructionOfFuture` 0x088435CC | 7 | 7 deck cards to the discard pile | ✓ |
| 2605 | Cause for Civil War | 4/0 | – | 0/0 | `spellSetTargetPlayerFlag` 0x08845930 | 8 | Player flag 8 on the opponent (refused if already set) | Always the opponent (mode 8), not a chosen player. |
| 2606 | Starving the Enemy | 4/0 | – | 0/0 | `spellStarvingTheEnemy` 0x088437E8 | 7, hand > 0 | Mills as many deck cards as the player has cards in hand | ✓ |
| 2607 | Dried-up Well | 3/1 | – | 0/0 | `spellSetTargetPlayerFlag` | 8 | Player flag 0x10 on the opponent | Also stops his duel spells and counter spells. |
| 2608 | Double Action | 8/2 | A | 0/17 | attach | 2 | When the unit has used all its actions (activity = 0xF), the attachment is removed and the activity flags are reset: a full second set of actions (`mapBoardScene`) | ✓ |
| 2609 | Battlefield Scales | 7/1 | – | 0/46 | `spellBattlefieldScales` 0x08843B3C | 12, counts differ | The player with more units + bases (Dominator not counted) loses random ones (HP = 0, no Death Defense check) until the counts match | ✓ |
| 2610 | Running Wind | 5/1 | – | 0/24 | `spellRunningWind` 0x08844044 | 1, own | To any empty own land cell | Own Dominator and bases are not refused. |
| 2611 | Winter Preparation | 3/0 | – | 0/0 | `spellWinterPreparation` 0x088445E8 | 10, discard not empty | Whole discard pile back to the deck, then shuffle | ✓ |
| 2612 | Divine Light of Koriah | 10/2 | – | 0/41 | `spellDivineLightOfKoriah` 0x08844818 | 11 | Up to 4 unit/base cards from the discard pile, each placed on a summon cell | ✓ |
| 2613 | Janess' Shadow | 5/2 | – | 0/42 | `spellSetCasterFlag` | 10 | Flag 0x20: both players' maintenance doubled | ✓ |
| 2614 | Breath of Hellgaia | 11/3 | – | 0/28 | `spellSetCasterFlag` | 10 | Flag 0x40: own units and Dominator +1/+1 | ✓ |
| 2615 | Euro's Shackles | 9/1 | – | 0/44 | `spellSetCasterFlag` | 10 | Status bit 2 on every living unit of both players, Dominators included. Their card move becomes 1, but attachments and Wings still add (Veda → 4) | Only units on the board at cast time; permanent until the unit is re-created. |
| 2616 | Wings of Mercedoa | 10/2 | – | 0/45 | `spellSetCasterFlag` | 10 | Flag 0x80: own units move +1 (max 9) | ✓ |
| 2617 | Epsilon's Protection | 10/2 | – | 0/43 | `spellSetCasterFlag` | 10 | Flag 0x100: double Soul from own destroyed units (Soul rules: [rules.md](rules.md)) | ✓ |

Handlers named "attach" are `spellAttachCard` (0x08845144): it adds the card id to the first free
attachment slot (`unitAttachmentOp` 0x08830604, op 1), or removes them all for 2203, then calls
`unitRecalcStats`. 2612–2617 are story rewards ([save-menus.md](save-menus.md)).

`spellGetTargetMode` (0x088475E8) is **not** the selection mode above: it sets `g_mapSpellTargetMode`
for the CPU's casts and the counter window (Magic Barrier is tested only in modes 1 and 2): 7 for the
player spells (2601-2604, 2606, 2607, 2605 through 2611 and Divine Light 2612), 4 for the land spells
(2501-2505, 2508-2510), 10 for the caster spells (2204, 2205, 2507, 2613-2617), 12 for Battlefield
Scales, Green Noa and Earth Nova, 6 for Double Action, Firestorm and Magic Dragon Gaze, and **1 for
everything else** (every unit spell and attachment).

### Handler details (decompiled for the viewer)

Texts are quoted as the game has them (＠ｎ = new line).

- **Homesick** pays the card first (so on an own unit the hand is counted without it), sets HP 0, then
  either `unitDestroy(unit, 0)` and puts the card face up into the first empty place of the owner's hand
  ("%s ＠ｎhas returned to owner' s hand. ") or leaves it to the deaths ("Because there are more than 5
  cards in hand, ...has been destroyed, unable to return. "), glyph size 20.
- **Chick Bug Curse / Mirror Reflection**: a 283 x 99 (96) frame centred, the old name centred on 11
  cells ((5.5 - len/4) * 23), a down arrow at (0x73, 0x17), the new name at y 0x2E; the grid word is
  rewritten with the new card id, then `unitRecalcStatsAll` and the maintenance. Mirror Reflection asks
  "Which unit to switch to? ＠ｎPlease select from the board. ", refuses a base or a Dominator ("This
  cannot become a base. " / "This cannot become a Dominator. ") and confirms "Before change: %s ＠ｎAfter
  chagne: %s ＠ｎIs it all right to use the card? " (typo in the game). The target itself may be picked;
  an empty square reuses the last occupied square's word (a register left from an earlier frame).
- **Rise of the Betrayer** pays first, removes the aura, flips the team and puts the unit back through
  `unitSummonUpdate` ("%s ＠ｎhas changed alliances. ").
- **Mask of Change**: legal only with an own-row unit (slots 1-30) on the board ("There are no target
  units on the board. ") and a unit card in hand ("There are no unit cards in your hand. "); the target
  must be of the own team, not a Dominator or base, and still owned by its original owner ("You cannot
  select this unit ＠ｎbecause it cannot return to your hand. "). After the hand pick "Is it all right to
  use the card on this unit? "; at 4000 the target shrinks (state 4), the hand card is placed with
  `unitSummonUpdate(..., 1)` on its square and the target goes face up into the swapped card's hand
  place: "Trade successful between ＠ｎ%sand ＠ｎ%s. " (no space before "and").
- **Relocation**: "Please select the units ＠ｎthat you wish to switch locations of. ", "This cannot be
  used ＠ｎon dominators. ", "Due to %s' s effects, targeting is not possible. ", "Is it all right to
  switch locations? " with Yes / No, then "Switched positions of ＠ｎ%s and ＠ｎ%s. ". Relocation never
  calls `spellConfirmTarget` (its own checks replace it), so the 2107 branch there (always 0) is dead.
- **Shard of Life / Divine Light of Koriah**: the discard list (`spellSelectTarget` mode 11), then a
  deploy square; the picks are placed with `unitSummonUpdate(..., 1)` (no counter, no payment) and listed
  in a 324-wide report, 21 px per row (Divine Light keeps a row per pick, so a refused pick leaves a
  gap). Shard of Life sets the pick's deck state to 3 before placing. See
  [map-board.md](map-board.md) "Spells with a second step".
- **Cityscape Mirage**: "Please select the new attribute. " with the attribute menu (`winOpenMenu`),
  then "Is it all right to turn ＠ｎthis land' s attribute to Fire? " (per attribute) with Accept /
  Cancel, effect 0x1E + attribute - 1, "The attribute of this land ＠ｎis now : Fire. ".
- **Summon Earth ... Air, Lord of Blanks, Flames of Invasion**: no message (only the card name). Lord of
  Blanks and Flames mark their diamond (radius 2 / 1) while selecting and clear it on the answer; Flames
  writes (turn player + 1) * 0x1000 into the conquest word.
- **Strategic Retreat** pays and picks at the confirmation: every own empty square draws
  `(gameRandNext() & 0xFFFF) % 100 + 1`, the strictly highest wins (row order) and the cursor moves
  there; at 4000 the square is unowned, Cost + 3, conquest count and income - 1: "Gained 3 Cost ＠ｎby
  relinquishing one allied land ".
- **Earth Nova**: "All units: HP-4 " (no report, **no Death Defense check**). **Green Noa**: "All allied
  units ＠ｎheal 3 HP ".
- **Firestorm / Magic Dragon Gaze**: the two-sided report ("Unit name ", "HP ", rows "%2d => %2d" - Gaze
  with a trailing space, Firestorm without - or the protecting ability / card name); Square switches the
  side.
- **Memory Slip** pays first, then per card `((r & 0xFFFF) + 1) % n` over the compacted hand, "%s ＠ｎHand
  -> Discard " (one message per card, Cross between them), up to three.
- **Unexpected Guest / Turn Over a New Leaf** pay first; the draws are face up with
  `playerDrawCardUpdate(p, 2, 5)`, each "%s ＠ｎhas drawn ＠ｎ%s. "; Turn Over first discards card by card
  ("%s ＠ｎhas been discarded. "), then draws five times.
- **Destruction of Future** (pays at 9000) / **Starving the Enemy** (pays first; "There are no cards in
  hand. "): `playerDrawCardUpdate(p, 5, 0)` per card, "Deck -> Discard ＠ｎ%s ".
- **Winter Preparation**: the discard flags of slots 1-30 are cleared and the deck reshuffled
  (`playerShuffleDeck`): "Returned %d discards back to deck. " / "There were no discards. ".
- **Battlefield Scales**: the bigger side's units (slots 1-30 of both rows, by team) each get a key
  `(((r & 0xFFFF) + 1) & 0x7F) + 1`, insertion-sorted into 16 places (ties: earlier first); the first
  (difference) of them get HP 0, listed in a 353-wide report headed by that side's Dominator name.
- **Push**: no confirmation step (so none of the Annul Attack / Death Defense checks); "Where would you
  like this moved to? " with the radius-3 diamond, then "Is it all right to move this here? ".
  **Running Wind**: the confirmation returns at once for an own unit; "Select target location. ", an
  empty own square, "Moving to this location. ＠ｎIs it all right? ".
- The player spells (Memory Slip, Unexpected Guest, Turn Over a New Leaf, Destruction of Future,
  Starving the Enemy), Winter Preparation, Cause for Civil War and Dried-up Well jump from 3000 to 4000
  themselves: **they play no effect**.

**After-battle triggers** (`mapBattleAfterUpdate` 0x0885D4B4, steps 1, 2, 10, 20, 21):
- Word Psalm (`mapWordPsalmUpdate`): pass 0 the attacker's hits the target, pass 1 the target's hits the
  attacker, whenever the other unit survived (the holder may itself be dead); the effect plays on the
  victim, then "%s ＠ｎHP %2d => %2d" or, with Death Defense, "%s ＠ｎ%s " (the ability name) and no kill.
- Bankruptcy Seed: per holder the opposing Dominator gets the cursor, the effect plays and one deck card
  goes to the discard pile: "From the deck of ＠ｎ%s ＠ｎ%s ＠ｎhas been discarded. ".
- Gaugabur Farm: a farm on battle side i (left = the team-0 unit) gives **player i's** Dominator 2 HP.
- Boost is cleared, then Bless of Training for the first flagged side only: "%s ＠ｎAP %2d => %2d ＠ｎDF
  %2d => %2d".

## Duel spells

Before the exchange, each side may play one hand card whose `CardDef.abilityIds[0]` is 1 (21 spells,
listed with **B** above).
- **Selection** (`battleSpellSelectUpdate` 0x0888C118): the card goes on either combatant. It is
  refused when the target:
  - is inside an Anti-magic Barrier (no Annul Base);
  - has Annul Attack and the card is 2001–2099;
  - has Unable to Buff and the card is 23xx;
  - has 6 attachments, or is a base, and the card attaches;
  - is not a base, for Earthquake;
  - is a Dominator, for Lurk or the Doll;
  - has Death Defense, for 2003–2006.
- **Resolution** (`battleSpellPhaseUpdate`): the defender's spell first, then the attacker's.
- **Effect** (`battleApplySpellCard` 0x0888E830): a target carrying Magic Barrier gets effect 70 and
  loses the barrier. Otherwise effect +3E plays, then step 100:
  - attach: 23xx, 2206, 2207 (2104 is dead code); 2203 strips all attachments;
  - `unitRecalcStats`;
  - new HP: 2001 −3, 2003 0, 2005 0 if AP > 3, 2006 0 if HP + DF > 4, 2009 −AP, 2010 −2 per
    attachment, 2201 +2, 2202 +5 (not on a dead unit), 2309 −2, 2506 0 if the target is a base.

The HP bar drain and timing are in [effects.md](effects.md).

## Activated abilities

Activated abilities are run by `abilityDispatch(id, 1)` (0x08863AE8):
1. **Cost check.** `abilityConfirmUse` (0x088601C0) checks the cost: `AbilityDef` use cost/Soul
   through `playerCalcPayment` flag 0x10, so no reductions.
2. **Target.** `abilitySelectTarget` (0x088608E8) marks the range (`mapMarkAttackRange`: cells with
   `|dx| + |dy| < r`). `abilityConfirmTarget` (0x08860E90) validates the target.
3. **Resolution.** The handler resolves at state 3000, then the ability effect `AbilityDef` +1A
   plays.
4. **Payment.** Cost and Soul are paid last.

**None of them check Annul Attack, Anti-magic Barrier or Magic Barrier.** Only Assassinate checks
Death Defense. Friendly targets are allowed, with a warning line.

| Id | Name | Cost | Eff | Handler | Target | Effect as implemented | Text vs code |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 6 / 51 / 52 | Snipe LV1 / LV2 / LV3 | 5 / 7 / 9 | 51 | `abilitySnipe` 0x08861714 | Any other occupied cell within 2 / 3 / 4 | HP −(user's effective AP), DF ignored; bases allowed | ✓ |
| 7 | Foot Stamp | 6+1 Soul | 18 | `abilityFootStamp` 0x08861910 | Occupied cell within 1 | Status bit 1 and activity 0xF on the target until the end of its owner's turn | ✓ |
| 8 | Assassinate | 7+1 Soul | 19 | `abilityAssassinate` 0x08861A90 | Within 3, no Death Defense | HP = 0 | ✓ |
| 9 | Cast Spell | 1 | 17 | `abilityCastSpell` 0x08861C34 | Self | Player flag 0x200: next spell **or summon** −2, min 1 | Text says "next card"; it also covers summons. |
| 11 | Destroy Outpost | 2 | 39 | `abilityDestroyOutpost` 0x08861D78 | Any base, **no range** | User HP = 0 and base HP = 0 (Death Defense ignored); own bases allowed | ✓ |
| 26 | Berserk | 3 | 47 | `abilityBerserk` 0x08861F48 | Self | User HP −2; every occupied neighbour −2 | Allies are hit too. |
| 27 | Boost | 4 | 47 | `abilityBoost` 0x088623A0 | Enemy in attack range | Starts a battle with status bit 0: +2 AP, +1 DF in `unitRecalcStats`; cleared by `mapBattleAfterUpdate` (or when Evasion cancels the battle) | ✓ |
| 31 | Mind Read | 5 | 48 | `abilityMindRead` 0x08862514 | Self | Draw 1; refused with 6 cards in hand | ✓ (≤ 5) |
| 35–38 | Summon Earth / Water / Fire / Air | 4 | 30–33 | `abilitySummonLand` 0x088626C0 | **Any** land cell, no range | Attribute 1–4 | Unlike the spells, the barrier and range are not checked. |
| 39 | Breath | 5 | 0 | — | — | `abilityConfirmUse` always refuses it | Unusable; no card has it. |
| 48 | Base Repair | 3 | 20 | `abilityBaseRepair` 0x08862908 | Any base, no range, either side | HP +3 | ✓ |
| 54 | Evolution | 4+1 Soul | 47 | `abilityEvolution` 0x08862AAC | Self | Base AP +2, permanent, repeatable (max 99) | ✓ |
| 55 | Rotating Slash | 4 | 47 | `abilityRotatingSlash` 0x08862C38 | Self; needs ≥ 1 neighbour | Every occupied neighbour −2 | Allies too. |
| 56 | Pick Pocket | 3 | 18 | `abilityPickPocket` 0x08862FC4 | Adjacent unit or Dominator | A random attachment moves to the user; fails if the user has 6 | ✓ |
| 57 | Domination Call | 5 | 48 | `abilityDominationCall` 0x088632E8 | Self | Every empty land neighbour becomes the user's land (enemy land too) | Occupied cells are skipped. |

## Passive abilities

"Card" means the unit card's own ability slots (`mapUnitCountCardAbility`); "+att" means
`unitCountAbility(…, 1)`, which also counts attachments and Dominator 53.

| Id | Name | Where | Effect as implemented | Text vs code |
| --- | --- | --- | --- | --- |
| 1 | Support Defense | `abilityApplySupportDefense` 0x08863638 | Each unit or Dominator gets DF +1 per adjacent own unit whose card has 1 | Possible bug: the right/bottom bounds test is `< 63`, not the map size. On a 40-wide map, x = 39 reads (0, y+1). |
| 2 | First Attack | `battleDuelUpdate` step 2 (+att: 2306, 2308) | Sole holder (attacker or target) strikes and takes its HP pass first; the other strikes back only if still alive. Both or neither → the attacker strikes first and both hits land in one HP pass, so a unit killed by it still strikes back ([effects.md](effects.md#exchange-order)) | ✓ |
| 3 | Mutual Death | `battleDuelUpdate` step 9 | If the holder dies in a battle, the surviving opponent is destroyed unless it has Death Defense | Revenge kill, in battle only. |
| 4 | Revival | `mapDeathRevival` 0x0885E124 | On death the owner may pay the card cost + Soul (no reductions) to re-create it on its cell; the CPU accepts | ✓ |
| 5 | Poison attack | — | Never read | Not implemented; no card has it. |
| 10 | Attack Castle | `battleShowAbilityPopup` 0x0888A4E8 | Base AP +5 for the duel if the opponent is a base; reset after the duel | ✓ |
| 12 | Memento Talisman | `mapDeathMementoTalisman` 0x0885E6F0 | On death, the current owner draws 1 if his hand has ≤ 4 cards | ✓ |
| 13 | Kodama | `battleShowAbilityPopup` + `unitRecalcStats` | Base AP := opponent's effective AP at duel start, and effective AP = base AP, ignoring attachments, auras, land and Toy Sword | ✓ |
| 14 / 15 | Defense Skills / Ironclad | `abilityDispatch(0,0)` | DF +1 / +2 (card) | ✓ |
| 16 | Annul Base | `unitRecalcStats` and all base code | Ignores every base aura (good and bad), Healing Spring, Trap Zone, Trench Mortar, Labyrinth and Symbolic Flag. May be targeted inside Anti-magic Barrier | ✓ |
| 17 | Mutual Fight | `abilityApplyMutualFight` 0x0886378C | n = number of units with the same card id on the board (**both** players, itself included); if n ≥ 2 **every** copy gets AP +2(n−1), DF +(n−1) | Text: only the "extra" units gain. |
| 18 | Boost Buffs 1.5x | `unitRecalcStats` | Sum of attachment AP and DF × 1.5, rounded up (arithmetic shift, so debuffs round toward −∞: −2 → −3) | Also scales Curse of Aging. |
| 19 | Annul Attack | `spellConfirmTarget`, area spells, duel selection | Immune to 2001–2010 (map) / 2001–2099 (duel) | Not immune to Snipe and other abilities. |
| 20 | Unable to Buff | same | Immune to 2301–2399 | Veda, Lurk, Blessing Light, Doll, Magic Barrier, Double Action are not covered. |
| 21 | Spy | `mapMarkMoveLines` 0x08857788 | Movement may pass enemy **bases** (not enemy units) | ✓ |
| 22 | Blind Faith | `mapIncomeBlindFaith` 0x0885AE88 | Start of owner's turn: +3 Cost each | ✓ |
| 23 | Counter | `abilityDispatch(0,0)` | AP +3 whenever the unit's owner is not the turn player | ✓ |
| 24 | Support Attack | `abilityApplySupportAttack` (+att 2307) | AP +1 per adjacent own unit with it | ✓ |
| 25 | Regeneration | `mapTurnRegeneration` 0x0885B104 | Start of owner's turn: HP +2 | ✓ |
| 29 | Death Defense | many (+att 2207) | Refuses 2003–2006 (also Homesick), 2008, Assassinate, Word Psalm, Mutual Death. All bases have it | Earthquake, Battlefield Scales and Destroy Outpost ignore it. |
| 30 | Destiny of Healing | `mapDeathDestinyOfHealing` 0x0885E98C | On death, the current owner's Dominator HP +2 | ✓ |
| 32 | Evasion | `mapBattlePreCheck` 0x0885C1B0 | When attacked, before the duel: HP set to 0; back to the **original** owner's (+0x08) hand, face up, if that hand has < 5 cards (removed without Soul); otherwise it stays at HP 0 and dies in the following death processing (Soul and death triggers apply). The battle does not happen, the attacker's Boost is cleared and its action is spent | ✓ |
| 33 | Rush | — | Never read | Not implemented; no card has it. |
| 34 | Assist Summon | `playerCalcPayment` | −1 summon cost per adjacent own holder of the target cell; stacks; min 1 | ✓ |
| 40 | Last Flower | `mapDeathLastFlower` 0x0885D6B8 | On death, **every** occupied neighbour −2 (allies too) | Text: "a neighboring unit". |
| 41 | Wandering Citizen | `mapSeizeCell` | No seizing of cells passed through | ✓ |
| 42–45 | Resist Earth / Water / Fire / Air | `battleCalcDamage` | Damage 0 if the attacker's card attribute (+0x25, not its land) matches | ✓ |
| 46 | Fierce Attack | `battleCalcDamage` (+att 2310) | Damage goes straight to HP; DF untouched | ✓ |
| 47 | Word Psalm | `mapWordPsalmUpdate` 0x0885C6C0 | After the battle, the surviving opponent is destroyed unless it has Death Defense | ✓ |
| 49 | Bless of Training | `mapAfterBlessOfTraining` 0x0885D100 | After a battle in which the holder survived and its opponent died: base AP +1, DF bonus +1, permanent | Text: "each time a unit is destroyed". Code: only its own battle kills. |
| 50 | Reflect Big Swings | `battleCalcDamage` | Damage 0 if the attacker's effective AP > 3 | ✓ (4 or more) |
| 53 | Dominator | `unitCountAbility` | Counts as Death Defense (29) and Unable to Buff (20) | ✓ |
| 58 | Bankruptcy Seed | `mapAfterBankruptcySeed` 0x0885CA28 | After a battle, for each combatant with it, the opposing player mills 1 deck card | ✓ |

### Timing

**Start of turn** (`mapTurnStartUpdate` 0x0885B430, turn player only). Deaths are processed between
the steps.
1. Income = land (`mapCommitConquest`).
2. Blind Faith, then Magic Mine.
3. Sure-Kill damage.
4. TNT Clock Tower.
5. Trap Zone.
6. Regeneration, then Healing Spring.
7. Maintenance, then the draw.

**Battle** (`mapBattlePrepUpdate`, the duel scene, then `mapBattleAfterUpdate` 0x0885D4B4):
1. Before the duel: Evasion.
2. Duel intro: Attack Castle, Kodama.
3. Duel spells.
4. The exchange, with First Attack and Mutual Death.
5. After the duel: Word Psalm, Bankruptcy Seed, Gaugabur Farm, clear Boost, Bless of Training.

<a id="death-order"></a>**Deaths** (`mapProcessDeaths` 0x0885EC04, slots 1–30; a dead Dominator ends
the game):
1. Return from Shadows, then Doll of Living Being, then Revival. If any of them revived the unit, stop.
2. Last Flower.
3. Death effect 0x35.
4. Memento Talisman, then Destiny of Healing.
5. `unitDestroy`.

A unit dismissed at turn start to pay maintenance (`mapProcessDeaths(-1)`) skips steps 1, 2 and 4.

## Base cards

All bases carry ability 29. `unitRecalcStats` returns at once for bases, so bases never receive
auras, land bonuses or player-flag bonuses. Aura counts stack: two Watchtowers give −2/−2.

| Id | Name | Range | Mapeff | Implementation | Owner mask | Text vs code |
| --- | --- | --- | --- | --- | --- | --- |
| 3001 | Goblin Watchtower | 3 | 0 | `unitRecalcStats` flag 2: AP −1, DF −1 per tower | Enemy towers | ✓ (clamped at 0) |
| 3002 | Healing Spring | 3 | 0 | `mapTurnHealingSpring` 0x0885A21C: at the owner's turn start, every unit and Dominator (both sides) in range gets HP + (number of the owner's springs covering it) | Owner's springs | Enemy units in range are healed too; the text only exempts "your base". |
| 3003 | Elemental Shrine | 3 | 0 | AP +2, DF +1 per shrine for a unit with attribute ≠ 0 | Any player's | ✓ |
| 3004 | Labyrinth Marsh | 4 | 0 | Move = 1 as the last override (after Veda, Wings, …). Movement stops on entering a marsh cell (`mapMarkMoveLines`) | Any player's | ✓ |
| 3005 | Anti-magic Barrier | 3 | 0 | `spellConfirmTarget`, area spells, Green Noa, Push/Relocation, duel selection: units inside cannot be targeted or affected; land cells inside cannot be targeted | Any player's | Applies to the owner's own spells too; abilities ignore it. |
| 3006 | Magic Mine | 0 | 0 | `mapIncomeMagicMine` 0x0885A5E0: +3 Cost per mine at the owner's turn start | — | ✓ |
| 3007 | Obstructive Wall | 0 | 0 | No code | — | ✓ |
| 3008 | Statue of Hero | 3 | 0 | AP +1, DF +1 per statue | Own | ✓ |
| 3009 | Toneriko Tree | 0 | 0 | `playerCalcPayment` flag 8: spells −1 per own tree | — | Minimum cost 1, not 0 as the text says. |
| 3010 | Makeshift Fortress | 3 | 0 | DF +1 per fortress | Own | ✓ |
| 3011 | Symbolic Flag | 4 | 0 | `mapSeizeCell`: no seizing of passed-through cells inside an enemy flag's range | Other players' flags | ✓ |
| 3012 | TNT Clock Tower | 0 | 0 | `mapTurnTntClockTower` 0x0885A81C: at the owner's turn start, **both** Dominators HP − (number of the owner's towers) | — | Only on the owner's turns, not "every turn". |
| 3013 | Trap Zone | 3 | 0 | `mapTurnTrapZone` 0x0885AADC: at the owner's turn start, every unit and Dominator (both sides, not bases) in range HP − count | Owner's zones | Own units are hit too. |
| 3014 | Traveler's Tavern | 0 | 0 | `playerCalcPayment` flag 2: summons −1 per own tavern | — | Minimum 1, not 0. |
| 3015 | Trench Mortar | 4 | 52 | Unit placement (0x0882F5F0, fresh summons only): HP −2 per enemy mortar covering the cell | Enemy mortars | Revived, swapped or moved units are not hit. |
| 3016 | Gaugabur Farm | 0 | 20 | `mapAfterGaugaburFarm` 0x0885CE3C: after a battle it took part in (bases never attack, so: when attacked), the Dominator `g_mapUnits[side][0]` of its battle side (0 left / 1 right) HP +2, up to max HP. Runs before the deaths, so a farm destroyed in that battle still heals | — | Left is always the team-0 unit (`battleDuelScene` 0x0888A89C picks the side from the attacker's team +0x0C), and team t's Dominator is player t's. So the farm heals the Dominator of the team that holds it now: a farm taken with Rise of the Betrayer heals its new holder. Not a bug. |

## Stats: `unitRecalcStats` summary

Only units and Dominators are recomputed, and only when they stand exactly on a cell.
1. **Attachments.** AP/DF start from the attachments: 2302 +4/+1, 2303 +3/+2, 2304 DF +3, (2305
   +2/+2), 2308 AP +6, 2309 −2/−1. Move: Veda +3, Wind +1. Activity: Lurk \|6, Foot-stopper \|0xF.
2. **Boost Buffs 1.5x** scales the attachment sum.
3. **Base values.** + base AP (+0x23) and DF bonus (+0x24); + card move (1 under Euro's Shackles),
   range and attribute.
4. **Bases in range** (skipped with Annul Base): Watchtower, Shrine, Statue, Fortress.
5. **Land.** A unit whose attribute equals the land attribute gets +1/+1.
6. **Passive abilities** (`abilityDispatch(0,0)`): Support Defense, 14, 15, Mutual Fight, Counter,
   Support Attack; then status bit 0 (Boost) +2/+1.
7. **Player flags.** 0x40 +1/+1, 0x80 move +1.
8. **Overrides.** Toy Sword AP = 1; Labyrinth Marsh move = 1; Kodama AP = base AP.
9. **Clamps.** AP and DF 0–99, move ≤ 9. Status bit 1 (Foot Stamp) sets activity 0xF.

## Status bits (+0x48)

| Bit | Set by | Effect | Cleared by |
| --- | --- | --- | --- |
| 0 (1) | `abilityBoost` | +2 AP / +1 DF for the battle | `mapBattleAfterUpdate` step 20, `mapBattlePrepUpdate` (Evasion cancel) |
| 1 (2) | `abilityFootStamp` | Activity 0xF (no action) | `mapTurnEndClearStatus` at the end of the unit owner's turn |
| 2 (4) | Euro's Shackles (`spellSetCasterFlag`) | Card move counts as 1 | Only `unitInitFromCard` (revival, re-summon) |

## CardDef +3C / +3D (open question 1.1)

No code reads them. The only accesses to `CardDef.bF3c` / `bF3d` in the whole decompiled program are
the copies in `cardGetDef` and `unitCountAbility`. The only `lbu …, 0x3d(…)` instructions are in a
sprite colour routine (0x0884A7F8) that has nothing to do with cards. They are dead data.

## Open points

- The Soul economy behind Epsilon's Protection: [rules.md](rules.md).
- The CPU's use of counter spells and Revival: [ai.md](ai.md).
