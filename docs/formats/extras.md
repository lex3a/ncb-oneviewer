# How to play and staff roll

Two screens the game has code for but rarely or never shows. Everything is **code** (Ghidra, USA
EBOOT) unless marked otherwise. The viewer shows both under **Card database → Extras**
([`src/effect/extras.ts`](../../src/effect/extras.ts),
[`src/components/ExtrasView.tsx`](../../src/components/ExtrasView.tsx)); the map board's Help command
runs the same "How to play" code. Coordinates are the 640×448 virtual space
([windows.md](windows.md)).

## How to play — `rulesHelpScene` (0x0884CC90)

**Where it runs.**
- The map board's **Help** command (command bit 8, offered in the unit command ring; state 7000,
  [map-board.md](map-board.md)): `mapBoardScene` sets `g_mapDrawFlags` = 7 and calls
  `rulesHelpScene` every frame (call at 0x088505EC). The board stays drawn behind it. When it returns
  1, `g_mapDrawFlags` = 0x1F and the board goes back to the command ring (state 0x1E). So the screen
  **is reachable** in the retail game.
- **Scene 400**: `main` calls `rulesHelpScene` (0x088488CC) then `menuWinUpdateAll` on a black frame;
  a return of 1 sets scene 0x32 (title). Only the title's result 5 leads to scene 400 and the title
  never returns it, so this stand-alone version is unreachable ([save-menus.md](save-menus.md)).

**State machine** (`DAT_089F3C18`; topic `DAT_089F3C14`):

| State | Per frame |
| ---: | --- |
| 0 | topic = 0, `rulesHelpOpenWindow(1)` (the list), → 1 |
| 1 | `winUpdateInput(&g_deckWinMenu)`; **✕** (0x4000): topic = `winGetCursor`, `sndPlaySeUi(7)`, `rulesHelpOpenWindow(2)`, → 2; else **○** (0x2000): `sndPlaySeUi(9)`, → 3 |
| 2 | **✕ or ○** (0x6000): `winClose(&g_deckWinInfo)`, `sndPlaySeUi(9)`, → 1 (the list keeps its cursor) |
| 3 | `winCloseAll`, state 0, **returns 1** |

`winUpdateInput` (0x0886F9A8) moves the list: ↑/↓ with pad auto-repeat, a fresh press on the first
(last) row wraps to the last (first), □ held pages by `visibleRows`, `sndPlaySe(1)` when the cursor
changes. The window is inert on its opening frame (flag 0x100).

**`rulesHelpOpenWindow(1)`** (0x0884CB4C):
`winOpenList(16, 16, maxLen·21 + 20, 350, &g_deckWinMenu, 15, 20, 20, topics, 0x20, 0x800)` with
maxLen = max over the 15 topics of `strlen(topic) >> 1` (14, from "When you are drawing a card ", so
w = 314).
- `winOpenList` (0x08870C00): style 7 (skin 3 frame, etc.one 1/4), chamfer 5, fill (0x20, 0x20,
  0x20, 0x70), list mode 1 (row i = `items + (scrollTop + i)·0x20`), cursor bar at (10, 8), width
  w − 20, colour (0x10, 0x80, 0xF0, 0x40), visibleRows = clamp((350 − 10)/20, 1, 15) = 15, so there is
  no scrolling. Rows are laid out by `menuWinUpdateAll` with glyph fade step 0x7F (they appear at once).
- Flag 0x800 = **dimming**: while the text window is open (the list is not the last window) the list's
  brightness drops by 8 per frame to 0x38, and rises back by 8 to 0x80 after it closes.
- Topic names: 15 × 0x20 bytes at **0x088DCD50** (ASCII, trailing space).

**`rulesHelpOpenWindow(2)`**: `winClose(&g_deckWinInfo)` then
`winOpenMessage(320, 224, 0, 0, &g_deckWinInfo, 20, 20, texts[topic], 0, 0, 0xF000)` (0x0887049C):
style 7, chamfer 5, the whole text parsed at once (typeDelay 0), glyphs fade in by 4 per frame
(32 frames), size from the text (0x1000: width = max(cursorX + 20); 0x2000: height = lines·20 + 18),
centred on (320, 224) (0x4000 / 0x8000). It never gets `winUpdateInput`, so it shows no "next" arrow.
Text pointers: 15 × u32 at **0x088DCD10** (texts 0x088DBABC … 0x088DCB60).

Windows: `g_deckWinMenu` (0x089DB540) and `g_deckWinInfo` (0x089DB5E4), the deck editor's windows.

### In the viewer

- Extras → How to play: scene 400 on a black screen. ↑/↓, X/Enter/Space = ✕, O/Esc/Backspace = ○,
  S held = □; a click on a topic moves the cursor, a click on the selected topic or on an open text is
  ✕, a right click is ○. The SE ids are shown in the status line. **Plain text** lists all topics.
- Map board → Help: the same `RulesHelpScene` runs inside the board and returns to the command ring
  (its SE ids go to the map's SE log).
- **Exact**: window rects, styles, flags, glyph sizes, dimming, fade steps, input, SE ids and texts.
  **Approximations**: those of the window painter ([windows.md](windows.md#in-the-viewer)); list rows
  use the painter's text layout; `g_mapDrawFlags` 7 during Help is not modelled (the board keeps the
  viewer's flags).

### Texts (0x088DCD50 / 0x088DCD10)

Exported as stored, with `＠ｎ` as line breaks (the double spaces and "' s" are in the data).

### 1. Conditions to win game

```text
To win the game,  your objective will be met
when you destroy the opponent' s Dominator
( the unit marked with a flag) .

It is difficult to reduce a powerful Dominator' s
HP to 0,  but please use the powers of the
cards effectively.
```

### 2. Conquest

```text
This is the total number of squares of land that you have
seized. When you move a unit,  the land that it has moved
along is seen as conquered,  and will turn to the same color
as the flag of the Dominator you are using.

This is the number of Costs you will gain at the beginning
of every turn.

However,  units with a special power called
“Wandering Citizen”can only seize the land square that
they stop on.
```

### 3. Unit

```text
The term “Units”refers both to Unit Cards and Base Cards
that can be summoned and placed on the Board.
In other words,  the Dominator itself is a Unit.

You need Costs to put a Unit out and keep it maintained.
Maintenance Costs are the amount of Costs needed to keep
Units on the board.
```

### 4. Spell

```text
The effects brought forth by Spell Cards can
affect various targets such as Units,  the Dominator,
and land squares.

Unlike Units,  Spells are gone after they are used.
But all Spells are worth its one-time usage.

Also,  some cards require Soul to use them.
```

### 5. Cost

```text
You will be able to use Cards by spending these.

At the beginning of each turn,  this will heal for the
Conquest value minus the Maintenance Costs value.
Furthermore,  Unit powers can add to the total.

Leftover Costs cannot be carried over to the next turn.
```

### 6. Soul

```text
If an allied Unit on the board is destroyed,
the Soul value will increase.  Unlike Costs,  the Soul value
will not decrease until you use it.

Some powerful cards require Soul to use;
you can also use Soul as replacement for Costs when you
don' t have enough Costs.

However,  you cannot use Soul as a replacement for
Maintenance Costs.
```

### 7. Maintenance Cost

```text
Units require Costs just for being out on the board.
That requirement is called the Maintenance Cost.

If at the beginning of a turn,  the Maintenance Cost total
is more than the replenished Costs supply,  you will need to
delete units until you can pay the full Maintenance Costs.
```

### 8. AP

```text
AP is your offensive power.
It will increase or decrease with changes such as
the effects of Spells.
```

### 9. HP

```text
HP is your life power.
When it is reduced to 0, that unit will be destroyed.
HP can be regained with Spell or Base effects.
```

### 10. DF

```text
DF is your defensive power.
The damage you sustain when you are attacked is
dependent on your DF. All units start with 0,  but
the value can be changed by Attribute/ Base effects,
Special Powers,  Spells e.t.c. However,  damage from
Spells and Special Powers cannot be reduced by DF.
```

### 11. How to obtain cards

```text
When you win a battle against an enemy Dominator,
you will gain 5 to 10 Cards.

Depending on the Dominator you face,  the type of Cards
gained will differ.

You have a chance of obtaining a Card that the opponent
used,  so if you defeat a Dominator that uses the Card that
you want,  you will eventually be able to get it.
```

### 12. Deck and Discard

```text
A Deck is a set of 30 Cards.  During the game,  you will
draw a card from the Deck one at a time.
You can put up to 3 of the same Cards in each Deck.

The discard pile is where used Spell Cards,
destroyed Unit Cards,  and unused cards end up.
When you must draw a card and no cards are left in the Deck,
the Discard pile will be reshuffled to recreate the Deck.
```

### 13. Number of cards in hand

```text
At the beginning of the game,  you will have 3 random Cards
selected from the Deck as your Hand.

The maximum number of cards you can have in your hand is 6,
but if you have 6 Cards in your hand at the end of a turn,
you will have to discard one.
```

### 14. When you are drawing a card

```text
At the beginning of each turn,  you must draw one card.
Also,  depending on the Spell or Power, there are times
that you may draw more than 1 card in a single turn.

When there are no cards left in the Deck,  the Deck will be
rebuilt from all Cards other than Unit Cards currently
summoned as well as your Hand.  If that happens,
the Dominator' s HP will be reduced by 5.
```

### 15. Attributes

```text
Some Units have Attributes. There is a total of four
different Attributes;  Earth, Water, Fire, and Air.

Units with Attributes can be dispatched not only next to
ally units, but to land squares of the same Attribute
that have not been seized by the opponent.

Furthermore, when the Unit is on a land square that is the
same Attribute as itself, its powers are given a bonus
of AP+1 and DF+1.
```

## Staff roll — `staffRollScene` (0x08834AE8, scene 2000)

**Reachability.** Nothing sets scene 2000 (the title's 2000 result is mapped to 4000, the ad-hoc
lobby; the endings play `ED000`/`ED001.pmf`). The scene loads **etc.one entry 1000**, which the
retail etc.one does not have (its entries are 1, 2, 10, 20, 100, 110, 200, 300, 310, 320, 330, 340),
so `fileQueueEnqueue` would stop the game with a fatal error. There is **no credits text** in
BOOT.BIN: the credits were images, and they are not on the disc.

**State machine** (`DAT_089B6098`; the frame counter `DAT_089B60A0` is incremented at the top of
every call, including state 0; fade `DAT_089B609C`; sprites `PTR_089B60A4`):

1. **State 0** (one frame): `gmalloc(0x4080)` = 32 sprites of 0x204 bytes; `spriteInit` +
   `spriteLoadOneMember(&g_oneEtc, 1000, i + 1, 0)` for i = 0..19; `fileQueueWaitOrPending(0)`; for all
   32 slots `spriteSetRenderContext(g_camDefault3D)` (0x0909E6D0; eye (320, 224, −768), focal 768, so a
   point at z = 0 lands where a 2D draw would) and the counters `c[0] = 0`, `c[i] = c[i−1] − 60·sec[i−1]`
   (`DAT_089B60A8[32]`); `bgmStop(0)`, `bgmStop(1)`, **`sndPlayVoiceVag(500)`** (goc.dat clip 499 =
   `8_2.wav`, Fellunder: "Hey, nice to meet ya!", apparently a placeholder); → 1.
2. **State 1**: for i = 0..**17** (loop bound 0x12: images 19 and 20 are loaded but never drawn),
   len = `sec[i]·60`, `c[i]++`, by mode `DAT_089B6128[i]` (.bss, never written, so always 0):
   - **mode 0**, drawn while 0 < c < len + 64: a = 2c before len, 2·(len + 64 − c) from len on,
     clamped to 0..0x80. `spriteSetVramMode(1)`, `spriteSetColor(−1, −1, −1, a)`, then
     - a = 0x80: blend 0, colour (0x80, 0x80, 0x80, 0x80), `spriteDraw(0, 0, 0)`;
     - otherwise: blend 1 (additive), colour (0x80, 0x80, 0x80, a/10), ten `spriteDrawProjected`
       copies at (trunc(r·cos θ), trunc(r·sin θ), 0), θ = 0°, 36°, … 324° (× 0.017453292),
       r = (0x80 − a)/20.0;
   - **mode 1** (dead code): drawn while 0 < c < len, blend 0, alpha min(0x80, len − c), at
     y = max(0, trunc(380 − 0.5c)) with `spriteDrawProjected(0, y, 0)`: a scroll-up variant.

   Then START (0x8) or a frame counter above **6000** starts the fade once (fade = 1); a nonzero fade
   gains 1 per frame (2 on its first frame); a black `Prim2D` (kind 3, 640×448 at (0, 0), depth
   −0x8000, alpha = fade, texturing off with `sceGuDisable(9)`) covers the screen; fade > 0x7F → 2.
3. **State 2**: `spriteUnload` ×20, `gfree`, `g_mapStageNo` (0x08A1B252) = 0x10, counters and state
   0, `sndStopVoice`, **returns 1000** (the save scene).

**Timetable** `sec[]` at **0x088B9B18** (32 × s32): 8, then 6 ×15, then **10000**, 6, 6, 6, then zeros.
Image 1 has 8 s, images 2–16 have 6 s each, image 17 has 10000 s (it stays until the 6000-frame
timeout) and image 18 never starts. In frame-counter values (the loading frame is 1, image i's counter
is F − 1 − start):

| Image | Start | Drawn (frame counter) | Opaque |
| ---: | ---: | --- | --- |
| 1 | 0 | 2 – 544 | 65 – 481 |
| n = 2…16 | 480 + 360·(n − 2) | start + 2 … start + 424 | start + 65 … start + 361 |
| 17 | 5880 | 5882 – the fade | from 5945 |
| 18 | 605880 | never | — |

The fade starts at frame 6001; state 2 is reached at frame 6127 (about 102 s).

**On the PSP the glow is invisible.** `spriteSetColor` keeps alpha as the nibble
`((a·255) >> 7) >> 4`; a/10 ≤ 12 gives nibble 1 (17/255), and the GE alpha test (> 0x28, see
[windows.md](windows.md)) discards every fragment of the ten copies. So each image **pops in** at
counter 64 and **pops out** after counter len, with 63 black frames between two images, instead of
the intended blurred cross-fade. The black fade is quantised the same way (16 steps, visible from
fade 25).

### In the viewer

- Extras → Staff roll: the roll with the game's timing, the black fade and the end (where the game
  goes to scene 1000 the viewer restarts the roll). START = P / Enter / Space / X or the button. Viewer
  extras: pause, jump to a frame (the scene is stepped forward without drawing) or to an image, voice
  clip 500 (needs goc.dat), and a **glow** option: "as the GE draws it" (the invisible copies, default)
  or "as intended" (the additive copies drawn with colour·alpha and alpha 1, which passes the test).
- **Placeholders**: etc.one 1000 members, if a file had them, would be used as they are; none exist,
  so each image is a labelled placeholder covering the whole screen (the size of the real images is
  unknown; full-screen images drawn at (0, 0) is **inferred**).
- No BGM: the scene stops both BGM channels, so `MusicPlayer` is not used.

### Credits text

None exists in the executable or in the archives: the credits were the 20 images of etc.one entry
1000, which the retail disc does not contain.
