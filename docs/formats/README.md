# Neverland Card Battles — data formats

Reverse-engineered from the USA PSP release (`PSP_GAME/USRDIR/data`): from the data files, validated
against **every** file in every archive, and from the decrypted executable in Ghidra (function
addresses refer to the USA EBOOT loaded at `0x08804000`). Statements are marked as:

- **code** — read from the game's own loader/renderer;
- **confirmed** / **data** — holds for all files in the game;
- **inferred** — consistent with the data but not proven (e.g. semantic meaning of a field);
- **unknown** — observed but not understood.

All integers are little endian. Offsets are in hex.

What is still unknown or not implemented is tracked in one place: [open-questions.md](open-questions.md).

| Document | Magic | Where |
| --- | --- | --- |
| [ONE archive](one.md) | `ONE1` | the 7 `*.one` files |
| [CLC2 container](clc2.md) | `CLC2` | entries inside ONE |
| [GBP image](gbp.md) | `GBP\0` | everywhere |
| [GAN animated sprite](gan.md) | `GAN\x10` | card.one, unit.one, effect.one |
| [CAS1 effect script](cas1.md) | `CAS1` | effect.one |
| [Effect runtime](effects.md) | — | how CAS1 runs and draws |
| [Sound banks](sound.md) | `VAGp` | snd/bgm.dat, se.dat, goc.dat |
| [Font](font.md) | — | gothic16.bin |
| [Music and movies](media.md) | `RIFF` / `PSMF` | at3/*.at3, Movie/*.pmf |
| [Game database and archive ids](database.md) | ELF | SYSDIR/BOOT.BIN |
| [Card info screen](card-screen.md) | ELF | the in-game card viewer: layout, sprites, text |
| [Deck editor and card list](deck-editor.md) | ELF | the collection screens: grids, NEW badges, type counts, windows, state machine |
| [Message windows](windows.md) | ELF | window draw styles, menu cursor, text/icon/digit glyphs, skins |
| [How to play and staff roll](extras.md) | ELF | the rules help screen (map Help, scene 400) with its texts; the staff roll (timetable, fades; images missing) |
| [Board rules and maps](rules.md) | ELF | turn structure, summoning, movement, the 16 boards |
| [Map board rendering](map-board.md) | ELF | the board as drawn: camera, scenery, tiles, tokens, seize walls, HUD |
| [Card effects](card-effects.md) | ELF | every spell, ability and base as implemented |
| [Computer opponent](ai.md) | ELF | the AI |
| [Story events](story.md) | ELF | story scripts, commands, windows, voices |
| [Save data, menus, ad-hoc](save-menus.md) | `CADATA.SAV` | save layout, scene flow, versus protocol |
| [Boot, title and new game](title-newgame.md) | ELF | the boot movies, `titleScreenScene`, `newGamePrologueScene` and the name-entry keyboard |
| [Camp and stage select](camp-stage-select.md) | ELF | `campMenuScene` (status windows, deck submenu, inline save / load) and `stageSelectScene` (areas, blocks, opponent, deck choice) |
| [Play mode](play-mode.md) | — | the game in the browser: main loop, GameScene machine, shared state, input, audio, how the ports plug in |

## Inventory

No other formats occur inside the archives. There are no nested containers, no gaps between members,
and all padding is zero (**confirmed**).

| Archive | Entries | Direct files | CLC2 members |
| --- | ---: | --- | --- |
| card.one | 147 | 143 GAN | 740 GBP |
| chara.one | 25 | — | 217 GBP |
| effect.one | 70 | — | 70 CAS1, 302 GBP, 8 GAN |
| etc.one | 12 | — | 124 GBP |
| map.one | 38 | 37 GBP | 21 GBP |
| option.one | 1 | — | 13 GBP |
| unit.one | 228 | — | 969 GBP, 1017 GAN |

Totals: 2422 GBP, 1168 GAN, 70 CAS1.

## Typical layouts

Member ids follow fixed conventions per archive (**confirmed** for the kinds and sizes listed).
What each id means was since read from the loaders: see [database.md](database.md#archive-ids-code).

- **card.one** — 143 direct GAN entries (ids `1…1021`, character sprite animations). CLC2 `10000` holds
  228 icons of 48×50, CLC2 `10001` 228 pictures of 80×100 (member id = card id, 1000 = blank). CLC2 `10010` and
  `10020` hold variously sized images.
- **chara.one** — CLC2 `100`: eleven 448×448 character illustrations plus one 256×224 image.
  CLC2 `1000+`: per-character portrait/expression sets (160–192 px wide) and a few full-screen images
  (480×272, 400×240, 640×448).
- **unit.one** — one CLC2 per unit (228). `/1` 48×50 icon, `/2` 80×100 picture, `/3` 240×300 portrait
  (missing in one unit), `/10` and `/11` GBP, `/12`–`/24` GAN battle animations.
- **effect.one** — one CLC2 per effect. Member `/1` is always the CAS1 script and CAS1 never appears
  elsewhere. The other members are the GBP/GAN assets the script uses.
- **map.one** — CLC2 `1` holds 256×256 tiles and a few smaller images. The direct GBP entries come in
  pairs or triples (`N000`/`N001`/`N002`) with the same height: large backgrounds split across
  several textures.
- **etc.one**, **option.one** — UI graphics.
