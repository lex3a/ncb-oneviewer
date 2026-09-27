# Game database and archive ids

The card, ability and deck tables, the story text and the loaders that decide which archive entry is
read, all from the executable. The UMD carries the plain ELF as `PSP_GAME/SYSDIR/BOOT.BIN`, which is
byte-identical to the decrypted `EBOOT.BIN`. The viewer reads the tables from it
(`src/formats/gamedb.ts`) when an ISO or a `BOOT.BIN` / `.elf` is loaded.

## Reading the ELF

There is one `PT_LOAD` segment: file offset `0x54`, vaddr `0x08804000`, size `0x186330`.

```
fileOffset = vaddr - 0x08804000 + 0x54
```

String fields are absolute pointers to NUL-terminated **Shift-JIS**. English text is plain ASCII.
Character names are full-width (`Ｇａｌａｈａｄ`), and most names end with a space.

Text markup is a full-width `＠` (`81 97`) followed by a full-width letter (`82 81` = ａ… ) and optional
full-width digits `N` (`82 4F`–`82 58`) (**code**: `msgParseNextGlyph` 0x08871570). Counts are the uses in
the ELF text.

| Tag | Uses | Meaning |
| --- | ---: | --- |
| `＠ｎ` | 3034 | line break |
| `＠ｖN` | 1081 | voice clip N (see [Voices](#voices)); waits until the previous voice is idle; skipped when the window has flag 0x100000 |
| `＠ｂN` | 88 | icon kind 7 (`winEmitIcon`): button glyph (**inferred**) |
| `＠－` | 76 | the rest of the text is laid out at once (see below) |
| `＠ｍN` | 13 | icon kind 10: attribute icon N (`g_attributeIconStrings` 0x088B8398, 13 icons) |
| `＠ｐN` | 12 | icon kind 8 |
| `＠ｃN` | 8 | text colour (window +0x41) |
| `＠ｅN` | 0 | icon kind 9 |
| `＠ｗN` | 0 | pause the typewriter for N updates (+0x43) |
| `＠ｓN` | 0 | typing delay (+0x42/+0x43) |
| `＠ｔN` | 0 | window draw style (+0x06) |
| `＠ａN` | 0 | glyph fade-in step (+0x44) |
| `＠ｆN` | 0 | face key (+0x6C, `expr*100 + charaIndex`) |
| `＠ｇN` | 0 | decimal value of script game variable N (`g_scrGameVars`) |
| `＠ｄN`, `＠ｈN`, `＠ｋ` | 0 | name of item N, character N, character of the current party slot: they read the unused RPG-engine tables at 0x089CA08C–0x089D184B (see [save-menus.md](save-menus.md#unused-engine-block-0x089ca08c)), which are always empty |

Any other `＠` letter skips only the `＠`, so the letter is printed.

**`＠－`** (**code**): `msgParseNextGlyph` calls `msgParseNextGlyphRaw` (0x088726AC) in a loop until the
end of the text, so the whole remainder is laid out in one call, with no typing delay. The raw parser
reads strictly 2-byte codes (no ASCII) and only knows NUL, the full-width space, `＠ｎ`, `＠ｃ`, the four
icon tags and `＠ｘ` (skips 6 bytes). All 76 uses are the pages of the name-entry keyboard
(`g_nameEntryPages` 0x088D7034, drawn by `nameEntryUpdate` 0x0884B29C: hiragana, katakana, Latin and
kanji grids), which must appear at once.

## Cards — `CardDef`, 0x48 bytes

`cardGetDef(out, cardId)` (0x0881E164) picks the table by id range (**code**). Record 0 of each table is
a dummy.

| Table | vaddr | Records | Card ids | Lookup |
| --- | --- | ---: | --- | --- |
| `g_cardDefUnits` | 0x088AD7A8 | 123 | 1–123 (no 80) | linear search on `cardId` |
| `g_cardDefCharas` | 0x088B0220 | 22 | 1001–1021 | linear search |
| `g_cardDefSpells` | 0x088B3CE8 | 69 | 2001–2010, 2101–2110, 2201–2208, 2301–2310, 2401–2405, 2501–2510, 2601–2617 (with gaps) | linear search |
| `g_cardDefBases` | 0x088B5B8C | 17 | 3001–3016 | index `id − 3000` |

Ids below 0 or from 4000 up return the unit dummy. That makes 227 cards: 122 units, 21 characters,
68 spells and 16 bases.

| Off | Type | Field | Notes |
| --- | --- | --- | --- |
| 00 | s32 | seqNo | Units: card number. Others: equals the id. |
| 04 | s32 | cardId | Search key. |
| 08 | char* | name | |
| 0C | s32 | ap | Copied to the unit by `unitInitFromCard` (0x0882F244). |
| 10 | s32 | hp | Max and current HP. |
| 14 | s32 | range | Units: always 1. Bases: area-of-effect radius. |
| 18 | s32 | move | |
| 1C | s32 | cost | |
| 20 | s32 | soul | Extra Soul cost. |
| 24 | s32 | maintenance | Summed by `unitSumMaintenance`. |
| 28 | s32 | attribute | Units: 0 none, 1 earth, 2 water, 3 fire, 4 air. Spells: category icon 5–12. |
| 2C | u8 | rarity | 1–6; characters 0. |
| 30 | s32[3] | abilityIds | Ids into the ability table. **Spells** reuse the slots as flags: `[0] = 1` usable in battle, `[1] = 1` attaches to a unit. |
| 3C | u8 | ? | 0x40 for non-spells, 0 for spells. **unknown** |
| 3D | u8 | ? | 0x60 for non-spells, 0 for spells. **unknown** |
| 3E | u8 | battleEffectId | Spells: `battleApplySpellCard` calls `effectStart(+3E)`. Units and characters: the duel attack effect (`battleDuelUpdate` 0x0888D818). |
| 3F | u8 | mapEffectId | Spells and bases: effect played on the map. Units: always 1. |
| 40 | char* | flavorText | |
| 44 | char* | effectText | Rules text of spells and bases; `""` otherwise. |

**Card number.** `cardIdToIndex` (0x0881EBC8) and `cardIndexToId` (0x0881EA70) convert between the id
and a card number 1–227. Units come first, then spells, bases and characters. The number indexes
the owned-copies array of the player profile (0x089D1868, called `g_cardKnownFlags` in older notes; see [save-menus.md](save-menus.md)) and the per-card map animations `g_cardMapAnims` (0x089AFB18).

### Abilities — `AbilityDef`, 0x20 bytes

`g_abilityDefs` (0x088B71B0) has 58 records, ids 1–58 with no 28. `dbGetAbilityDef` (0x0881ECEC)
searches on +04; when the id is not found it returns record 0, "No powers".

| Off | Type | Field |
| --- | --- | --- |
| 00 | s32 | sort number |
| 04 | s32 | abilityId |
| 08 | char* | name |
| 0C | u8 | activated (1) or passive (0) |
| 10 | s32 | use cost (−1 = the card's cost) |
| 14 | s32 | use Soul |
| 18 | u16 | category (5–11) |
| 1A | u16 | effect id |
| 1C | char* | description |

### Decks and the ladder

- `g_deckDefs` (0x088B7B98): 31 decks of 62 bytes each, `s16 dominatorCardId, s16 cards[30]`.
  - Names are in `g_deckNames` (0x088B7B1C, `char*[31]`).
  - Decks 21–30 are rematch versions for Dominators 1012–1021.
- `g_charaLadderOrder` (0x088B9FA0): the single-player opponent order, 19 character ids terminated by
  a repeat of 1001.

### Characters

There is no separate character table: the Dominator cards 1001–1021 are the characters.

- `charaIdToIndex` maps them to 1–11: Galahad, Shaia, Iglus, Egma, Refina, Simmon, Fellunder, Wise,
  Sheriela, Hellgaia, Arth.
- 1012–1021 are rematch versions of 2–11, with higher HP.

## Archive ids (code)

Every loader call site was traced. **H** means read from code, **M** means the load is in code but the
role is inferred from use.

### unit.one — entry = card id

| Member | Role | |
| --- | --- | --- |
| /1, /2, /3 | Card image 48×50, 80×100, 240×300. `cardLoadUnitImage` (0x0881EF5C) maps size 0/1/2 to the member; card id 0 → entry 1000. | H |
| /3 | Also the duel portrait (scale 0.8 at (8,128) / (440,128) virtual); cropped from the bottom only when the unit dies at the end of the duel. | H |
| /12, /13 | Walking animations on the map board, see below. | H |
| /20–/23 | Duel animations: idle, active, attack, hit (`battleLoadUnitAnims` 0x0888A29C). Bases load /20 four times. | M |
| /10, /11, /24 | Never loaded. /10 is pixel-identical to the board token card.one `10010/<id>` and /11 to card.one `10020/<id>` (all 133 shared ids). | H |

**/12 and /13** (**code**). `mapLoadUnitBoardAnim` loads both into one shared animation object
`g_mapUnitWalkAnm` (0x08A42BE8) for the unit that is about to move: `mapBoardScene` for the player,
`aiMapTurnUpdate` for the computer. The only `anmSwitch` on it is in `mapDrawUnitWalkAnim` (0x08831428),
called from `mapDrawUnit` (0x0883156C) **only while the unit's state is 2 (moving)**. Otherwise the
unit is drawn as the flat card token (card.one 10010). The facing byte `MapUnit` +0x4A picks the
animation (the direction names are the **inferred** ones from [rules.md](rules.md)):

| Facing (+0x4A) | Animation | Yaw |
| --- | --- | ---: |
| 0 down, 1 right | /12 (front, **inferred**) | 30°, 210° |
| 2 left, 3 up | /13 (back, **inferred**) | 30°, 210° |

The GAN is laid into the board plane (X rotation −90°) and turned 180° for odd facings, so each
animation serves two directions. The flat token does the same: its left half is used for facings 0/1,
the right half for 2/3. No other screen (unit detail, card list) shows /12 or /13.

Spells only have /1–/3. Bases have /1–/3 and /20.

### card.one

| Id | Meaning | |
| --- | --- | --- |
| 1–123 (direct GAN) | Animated card art of the units, entry = card id (`cardGanLoadAll` 0x088312FC loads card numbers 1–122) | H |
| 1001–1021 (direct GAN) | The same for the characters: never loaded | H |
| 10000 / 10001 | Card picture 48×50 / 80×100; member = card id; 1000 = blank (`cardPicLoadRef` 0x0881F040) | H |
| 10010 | Map-board token; member = card id (`cardInitSprites` 0x088311D4) | H |
| 10020 | 96×56 images, same members; never loaded (identical to unit.one `/11`) | H |

### chara.one

| Id / member | Meaning | |
| --- | --- | --- |
| 100 / 1–11 | 448×448 character art on the result screen (member = character index) | H |
| 100 / 1000 | "Winner" / "Draw" text | H |
| 1000 / 1–11 | Default face of each character (`msgLoadFaces` 0x08868D18) | H |
| 1000 / 101–411 | Copies of the dialogue faces numbered like the face-cache key (`expr*100 + charaIndex`, expressions 1–4). Never loaded: every load of entry 1000 uses members 1–11, and a face-cache miss in `menuWinUpdateAll` loads option.one `key+100` instead | H |
| 1001–1021 / 1–6 | Dialogue faces: entry = speaker card id, member = expression | H |
| 2000 / 1–10 | Story backgrounds 480×272 (`msgEventUpdate` command 0x0E) | H |
| 3000 / 10001–10015 | Event pictures (command 0x0C) | H |

### map.one

- `g_mapId` (0x08A1B250) = area 1–10, `g_mapVariant` (0x08A1B251) = 0/1. Loaded by `mapInitCameras`
  (0x08852B74).
- **Background** entry = `area*1000 + variant*100 + piece`. Areas 1–7 have 2 pieces, areas 8–10 have 3
  (byte table `g_mapBgCounts`).
- **Decorations**: entry 1, member `area*100 + k`. The count table only has 3 and 4 for areas 1 and 2,
  so members 301 and up are never loaded. `mapInitCameras` is the only reader of entry 1 (**code**).

### etc.one and option.one

| Entry / member | Screen |
| --- | --- |
| etc 1 | Window-skin overrides (`menuWinSysInit` 0x08867B1C) |
| etc 2 / 1–6 | Cursor and menu sprites: 1 digits, 2 pointer hand, 4 and 5 the card info screen ([card-screen.md](card-screen.md)) |
| etc 10 / 1, 2, 10 | Title background, title menu, retry screen |
| etc 20 / 1 | Prologue backdrop |
| etc 100, 110 | Map HUD, map HUD 3D |
| etc 200 / 1, 2 | Duel background (480×272) / duel HUD atlas (panels, HP bars, digits) |
| etc 300 | Camp menu (2, 3), deck edit (1, 5), card list (7, 5), stage-select frame (6) |
| etc 310 / area*100 | Area name plates |
| etc 320 / area*100 + variant + 1, +11 | Stage previews |
| etc 1000 / 1–20 | Staff roll: **the entry is not on the disc** (the scene is never entered) |
| option 20 / 1–15 | Window skin |

Never referenced: etc 10/20, 100/4 (64×64 4 bpp, fully transparent: every pixel is index 0, alpha 0), 110/9, 300/4, 330, 340, and the etc 310 plates other than
`area*100` (101, 102, 401, 402, 501, 502, 701, 702, 901, 902, 1001, 1002). 330 and 340 are two more
sets of 400×240 stage previews keyed `area*10 + n` (an older numbering than 320's).

### Never-loaded data: how it was checked

All archive reads go through `oneLoadEntry`/`fileQueueEnqueue`. Their only callers are
`spriteLoadOneMember`, `spriteLoadOneEntry`, `anmLoadCD`, `anmLoadCollection` (and `effectStart`,
`scr_LoadData`). Every call site of these (about 90, **code**) passes a constant archive and entry. The
only computed values are:
- members from card ids / card numbers, character index 1–11, expression 1–6 and area/variant;
- the face-cache fallback: option.one `key+100`.

None of them can produce the ids listed as never loaded above. There is no gallery or loop over
archive entries. Script loads can reach any archive, but all 206 `scr_LoadSprite`/`scr_LoadAnm`
calls in all CAS1 scripts use archive 7 (effect.one) with constant entries, and no script calls
`scr_LoadData`. So these ids are **dead data**.

### effect.one

`effectStart(n)` loads entry `1000 + n`, member 1 (the CAS1 script). `n` comes from:
- `CardDef` +3E (spells in battle, and the attack of units and characters);
- `CardDef` +3F (spells and bases on the map);
- `AbilityDef` +1A.

Fixed ids: 0x36 is the winner result screen and 0x1D the no-winner one. The viewer labels every effect
entry with the cards and abilities that start it.

## Voices

The goc.dat prefixes are **story episodes, not characters** (**code** plus data):

- `sndPlayVoiceVag(vagId)` indexes `g_vocGocClipTable` (0x088ED0C0): 1270 records of
  `{startSector, sectorCount, byteSize, 0, 0}`.
- Record `vagId − 1` is clip `vagId − 1` in goc.dat order. This was checked for all 1270 clips: each
  record points at a `VAGp` header.
- vagId = `base[prefix] + n − 1`, where `n` is the number in `<prefix>_<n>.wav`:

| Prefix | Base | Episode |
| ---: | ---: | --- |
| 0 | 1 | Prologue (narrator, Hellgaia, Refina, Egma) |
| 1 | 59 | Egma |
| 2 | 147 | Sha-ee-ah |
| 3 | 215 | Iglus |
| 4 | 264 | Refina |
| 5 | 317 | Sheriela |
| 6 | 369 | Simmon |
| 7 | 432 | Sha-ee-ah, 2nd meeting |
| 8 | 499 | Fellunder |
| 9 | 550 | Wise |
| 10 | 604 | Sheriela, 2nd |
| 11 | 659 | Iglus, 2nd |
| 12 | 719 | Wise, 2nd |
| 13 | 782 | Refina, 2nd |
| 14 | 851 | Egma, 2nd |
| 15 | 908 | Hellgaia (and Refina) |
| 16 | 992 | Arth, first meeting |
| 17 | 1017 | Arth, cards not complete |
| 18 | 1039 | Arth, final battle |
| 100 | 1094 | never referenced (177 clips) |

**Where the ids come from.**
- The story text starts each spoken line with `＠ｖN`. There are 1081 tags, all distinct, with ids
  1–1093.
- Each line is referenced from a 0x14-byte event record
  `{s32 key, s8 cmd, u8 side, u16 pad, s32 arg, s32 arg2, char* text}`.
  - `cmd` 0 is a dialogue line: `arg` is the speaker's character card id (0 = narrator), `arg2` the
    expression.
  - The record tables and every command are described in [story.md](story.md).
- The viewer uses this to show the speaker and text of every goc.dat clip.
- Script function 0x14F `voice_play` is not used by any effect. The unreachable staff-roll scene plays
  vag 500.

## Development leftovers

- The `one/...` debug paths are read only by `spriteLoadFromPath` (0x0887BD90).
  - It opens a loose file with `sceIoOpen`; a missing file is fatal ("Can't open file").
  - The `one/` folder is not on the UMD.
- **Debug menu** `debugMenuScene` (0x088672AC, scene 9000):
  - The menu is in Japanese: map test, menu test, battle test, effect test, effect test 2 and a 3D test.
  - The menu test loads `one/etc/MENU.gbp` and `one/map/ma02000.gbp`.
  - Both effect tests run `shardDebugTestEffect2` ("TestEffect2").
  - The scene is unreachable: main enters it only for title results 6 or 99, and the title never
    returns those.
- **Test scene** `debugTestDrawScene` (0x08864D54, scene 0x186):
  - It loads `one/chara/L001.gbp`, `one/map/test4.gbp` and `Fcolor.gbp`.
  - Nothing ever sets the scene.
- **Other dead scenes:**
  - `retryStageScene` 0x5DC has an untranslated retry prompt.
  - `staffRollScene` 2000 would crash on the missing etc.one 1000.
