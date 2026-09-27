# Effect runtime: VM, script objects and rendering

How the game runs a [CAS1](cas1.md) effect script and draws it. Everything is taken from the code of
the USA EBOOT and implemented by the viewer's effect player:
- [`src/effect/vm.ts`](../../src/effect/vm.ts) — interpreter;
- [`src/effect/scene.ts`](../../src/effect/scene.ts) — objects, tweens, drawing;
- [`src/effect/gl.ts`](../../src/effect/gl.ts) — WebGL back end;
- [`src/effect/duel.ts`](../../src/effect/duel.ts) — the duel scene behind attack and spell effects;
- [`src/effect/windows.ts`](../../src/effect/windows.ts) — message windows (duel, story; [windows.md](windows.md)).

All 70 effects in effect.one run to their `exit` in the player without an error, and all of them free
every object they created.

## Driver and frame order

`effectStart(n)` (0x0888EF48) loads effect.one entry `1000 + n`, member 1, into a fresh 64 KB buffer.
The globals live inside that buffer and are changed in place, so every run starts from a clean copy.

| Frame | What happens |
| --- | --- |
| F | `scrSetBuffer` runs the init pass at once (`set_entry(15, L1); return(0)`), then `scrTriggerEntry(0, 15)` |
| F+1… | `effectRunFrame` (0x0888F0E0): scripts (slot 0), then `scrObjUpdateTweens`, then the scene draws `scrObjRenderAll(0)` and `scrObjRenderAll(6)` |
| exit | `exit` returns −1 and the slot dies. The effect counts as finished when `bState == 0`, not when all threads stop. Objects and cameras are **not** touched. |

- The game runs at 60 Hz, one effect frame per vblank, with no frame skipping.
- `scrObjUpdateTweens` works in two passes:
  1. It pushes every object's colour to its sprite.
  2. For each object that is not paused, it steps the position, scale, rotation and colour tweens,
     then advances the animation by one tick.
- As a result, a colour tween becomes visible one frame late.

## VM details (scrExecSlot 0x0889CE10)

**Per-slot vs per-thread state.**
- Shared by all 13 threads of a slot: the value stack (128 entries), the type-tag stack, the result
  ring (128 cells) and the `call_func` argument list.
- Per thread: the call stack (8 deep) and the 32 int + 32 float locals.
- `wait_frame` sets sp = 0, pushes 0 and yields for exactly one frame; its argument is ignored.

**References and types.**
- Stack entries are references. A literal points at its own argument field in the code, and a result
  lives in the ring.
- The pop helpers check the tag and never convert. The compiler always inserts `itof`/`ftoi`.
- The operators convert themselves: int if both sides are int, otherwise float. Comparisons and
  `|| &&` give an int 0/1.
- Assignment to an int destination truncates a float source first, and pushes the result as a float.

**Control flow.**
- Jumps store `L − 1` and rely on the interpreter's `pc++`.
- `return(v)` returns ints only. At depth 0 it ends the thread, not the script.
- `call_func(L, args…)` pops arguments until it reaches the label. `arg_int(k)` / `arg_float(k)` read
  them back without converting.
  - The callee shares the thread's locals.
  - The argument list belongs to the slot, so a nested call overwrites it.

**Threads.**
- A thread started by a lower-numbered thread runs in the same frame.
- Starting a thread that is already running is fatal.
- `stop_thread(-1)` stops the current thread.

**Misc.**
- `rand(n)` is `((s + 1) / 11) % n`, where `s` comes from the game's RNG (0x0887B544). The game draws
  from that RNG in many places, so the exact sequence cannot be reproduced.
- There is no instruction budget: a loop without `wait_frame` hangs the game. The player stops after
  2,000,000 instructions in one frame.

## Script objects (ScrObject, 0x140 bytes, 384 slots)

A slot is empty (type −1), a sprite (1, one GBP), an animation (2, a list of GANs) or a poly mesh (4).
**Types and coordinates:**

- **Sprite.** `scr_LoadSprite` loads the whole GBP with palette 0 as one quad of W×H world units. The
  top-left corner starts at the object position.
- **Animation.** Each `scr_LoadAnm` appends a GAN. No animation plays until `anim_switch`. Animations
  advance one tick per frame and loop; a step of 255 ticks holds.
- **Coordinates.** Positions are passed as `(x, d, h)`:
  - 3D objects (coordMode 0, camera 0) store `(x, −h, −d)`;
  - 2D objects (camera 6) store `(x, d, h)`, which is top-left-origin 640×448 pixels.

**Lifecycle:**
- **Visibility.** A new object is hidden until `obj_set_state(o, 0)`. Op 0 also restarts the
  animation.
- **Clone.** `obj_clone` copies the whole record and shares the texture (**code**,
  `scrfn_objClone`).
  - A sprite gets a new sprite via `spriteCopy(…, 1)`.
  - An animation gets a new AnmManager filled by `anmCloneOrDefer(dst, src, 2)`. The clone is deferred
    until the source has loaded.
  - `anmClone` mode 2 allocates a new GanObject per animation and copies the step table, colour,
    rotation, offsets, scale and timer. `pImages[]` and `pFrames[]` are copied as pointers, so the
    frame records, and with them the **part sprites** (`GanFrameRec.pSprites`), are **shared** with
    the source (clone GanObject `shareMode` = 1, so freeing it keeps them).
  - The shared sprites are harmless: the GAN draw sets each part sprite's position, colour, scale and
    rotation right before drawing it, so source and clone animate and draw independently. Only mode 3
    (unused) makes a deep copy with new part sprites.
  - No effect clones an animation.
- **Free.** `obj_free` resets the slot.

**Colour and blending.** 128 means 1.0.
- The colour becomes an RGBA4444 vertex colour:
  - rgb nibble = `((c·255) >> 11) & 15`;
  - alpha nibble = `((a·255) >> 7) >> 4`.
  - Values above 128 wrap, so 129–143 come out black.
- The GE alpha test discards alpha ≤ 40/255, so a fade vanishes once alpha is below about 25.
- Blend bit 0 selects `ONE_MINUS_DST_ALPHA` (`spriteDraw2D`/`spriteDrawProjected`:
  `sceGuBlendFunc(ADD, SRC_ALPHA, 5)`). Every blend call in the scripts uses mode 1. This is **additive**
  (`src·α + dst`), established from the GE setup (**code**):
  - `guInitDisplay` calls `sceGuDrawBuffer(psm 0 = GU_PSM_5650, 0, 512)`. The display buffer is at 0x44000
    = 512·272·2, so the buffers are 16-bit. GE command 0xD2 (pixel format) is written only there and in
    `sceGuStart` (0x0880683C), which re-sends the same saved value 0.
  - So the frame buffer is **RGB565 and has no alpha channel**. No code can write destination alpha;
    pixel masks, stencil operations and clear flags do not matter. Stencil (state 3) is never enabled:
    `sceGuEnable` is only called with 0, 1, 2, 4, 6, 8 and 9. The per-frame `sceGuClear(0x17)` clears to
    colour 0.
  - With a 565 target the GE reads destination alpha as 0, so `1 − dstα` = 1. That is PSP hardware
    behaviour and PPSSPP emulates it the same way; it is not visible in the game code.
  - Still not compared against a real screen.

**Sprite geometry** (`spriteUpdateVertices`).
- The vertex is `pivot + offset + R·S·(corner − pivot) + pos`, with R applied Z, then Y, then X.
- `sprite_anchor` moves the pivot:
  - 0x10 centres it;
  - 1 puts it at the top, 2 at the bottom;
  - 8 at the left, 4 at the right.
- `sprite_reset_offset` sets offset = −pivot, which puts the pivot on the position.
- `sprite_src_rect` takes right/bottom texel coordinates, not width/height.

**Tweens.**
- Speeds are units, colour steps or radians per second; the per-frame step is speed/60.
- The number of frames is distance ÷ step. The value interpolates for `t = 1…⌊F⌋` and snaps to the
  target at `⌊F⌋ + 1`, which also clears the flag (1 pos, 2 colour, 4 rot, 8 scale).
- A speed of 0 never finishes, so a script waiting on it hangs.

**GAN parts.**
- Parts are drawn as in [gan.md](gan.md), with part z = −index in 3D.
- A part's alpha is `((a · base) >> 6) >> 1`, where base comes from the blend byte: 0 → 0x40, 1 → 0x7F,
  2 → 0, 3 → 0x20.
- `obj_set_blend` overrides every part.
- Unless the shadow is disabled (offset 0x7FFFFFFF), non-additive parts are also drawn as a flat
  silhouette.

**Poly meshes** (`polySystemInit`, `polyDraw`).
- Pattern 0 is a UV sphere of 8 latitude bands × 16 longitude segments (224 triangles).
- Patterns 1–7 are open tubes with 32/16/8/6/5/4/3 sides. The tube rises upward from the position, and
  its texture bottom is on the ground ring.
- Triangles are stored relative to their centroid:
  - `spread` pushes a triangle along the centroid direction;
  - `spin` multiplies a fixed random tumble per triangle.
- The mesh takes colour, blend and camera from its **source sprite**, not from the poly object.
- Meshes are double-sided and draw after the other camera-0 objects.

## Cameras and projection

Eight cameras are set up once at boot. Only cameras 0 and 6 are ever drawn.

| Camera | Eye | Focal | Mode |
| --- | --- | --- | --- |
| 0 (–2) | (320, 224, −768) | 768 | 3D |
| 6 (, 7) | (320, 224, −32768) | 32768 | 2D front (near-orthographic) |

**Projection.**
- `q = Mᵀ(P − eye)` with `M = Rz·Ry·Rx`, then `screen = (320, 224) + focal · q.xy / q.z` on a 640×448
  virtual screen.
- That screen is squeezed to 480×272 (x × 0.75, y × 272/448).
- A 3D sprite is dropped if any of its corners is behind the camera.
- `camSetProjection(f, sx, sy, cam, cx, cy)` (0x0887B634) treats 0 / 0x7FFF as "keep the stored
  value". It has a real bug, confirmed in the assembly: the sy == 0 branch at 0x0887B6A8 is
  `lwc1 f21, 0xC4(s2)`. That loads the stored sy into f21 (sx) instead of f20 (sy), so sx is
  overwritten and sy stays 0. The bug is **harmless**: the only caller is `camInitDefault` (0x0887B5E4),
  which passes sx = sy = 1.0, and no function pointer refers to it.

**Camera use.**
- `cam_set_pos` uses the same `(x, −h, −d)` mapping as objects.
- Scripts save camera 0, move it (typically eye (0, −320, −320) tilted −45°) and restore it at the end.

**Draw order within a pass.** Objects are sorted by z, far to near, and ties keep index order. 2D
background objects go first, and polys and 2D-front objects go last.

## Battle data

| Query | Value |
| --- | --- |
| `battle_get_defender_side` | `(attackerSide + 1) & 1` |
| `battle_get_side_pos`, left attacks | attacker (−40, 32, 0), defender (40, −16, 16) |
| `battle_get_side_pos`, right attacks | attacker (40, 32, 0), defender (−40, −16, 16) |
| `map_get_cam_rot` | (−65, 0, −30), integer degrees |

The triples are `(x, d, h)`. The duel recomputes them every frame in `battleSetupCombatantFacing`.

## Sound

- `se_play(id, _)` plays se.dat clip `id − 1` at its own rate (SAS pitch 0x400), round robin over 20
  voices, at full volume, dry (the HALL reverb's wet path is off); the second argument is ignored. The
  player renders it through the SAS voice model ([sound.md](sound.md#sound-effects-sas)).
- `se_stop` always stops voice 1, whatever plays there (a game bug).
- `se_stop_all` stops all 20 voices.

## Duel scene

`battleDuelScene` (0x0888A89C, scene 0x5A) draws the duel behind attack and spell effects. The player
implements this in [`src/effect/duel.ts`](../../src/effect/duel.ts).

### Frame order

1. **State update.** `battleDuelUpdate` (attacks) or `battleApplySpellCard` (spells) calls
   `effectStart`, switches animations and sets `g_battleAttackerSide`.
2. **Background.** etc.one 200/1 (480×272) is copied 1:1 onto the frame buffer. The duel angle does not
   move it.
3. **HUD.** `battleDrawHud` (0x0888E4E4) draws panels, HP bars (HP·152/maxHP) and digits from the
   etc.one 200/2 atlas, plus the animated player flags from etc.one 110/5.
4. **Units.** `battleSetupCombatantFacing` (0x0888DEA8) draws both combatants, then advances each by one
   tick.
5. **Portraits.** unit.one `/3` at scale 0.8, at (8, 128) and (440, 128). They are not cropped by HP
   during a duel.
6. **Effect.** The effect state runs, then script cameras 0 and 6 are drawn.
7. **After the effects.** Message windows (unit names), the hand panel and the card-detail overlay.

### Units

- **Animations.** unit.one entry = card id:
  - `/20` idle, `/21` active (turn owner), `/22` attack (contains the palette-12 hit marker), `/23` hit;
  - bases load `/20` four times and never attack.
- **Camera and pose.**
  - Scale 1.8, with the GAN's own colours and blend modes, and no shadow.
  - Drawn with the duel camera (2D-sorted, rotated about Z by the duel angle). The net effect is that the
    left unit is mirrored and the right one drawn as authored.
- **Placement.** At angle 0 (left attacks) the left unit stands at virtual (256, 320) and the right one
  at (384, 256). At 90 (right attacks) the heights swap. The attacker is always the lower unit and is in
  front.
- **Side positions** (used by the scripts): the attacker is at `(±40, 32, 0)` and the defender at
  `(±40, −16, 16)`. Seen through the scripts' camera 0, these land 55–70 px above each unit's feet, in
  its column. The two projections were laid out to agree.

### Attack timeline (`battleDuelUpdate`)

1. The attacker plays `/21` for 33 frames, then switches to `/22`.
2. On the frame when the drawn step of `/22` is the marker step: `effectStart(CardDef +3E)` and
   `g_battleAttackerSide = attacker`.
   - `battleDuelUpdate` would use `g_duelAttackEffectOverride` (0x088F6224) instead of +3E when it is
     nonzero. It is 1 in the binary's initial data, but duel init stores 0 into it (0x0888AEE8) before
     any read, and nothing else writes it. So it never takes effect: a debug leftover.
3. The effect loads on the next frame; its script first runs one frame later.
4. The defender switches to `/23` one frame after the start, or five frames after it for effects 1 and 6
   (`g_battleHitDelay`).
5. After the script exits, the duel waits for the attack animation to reach its last step, then turns
   (30 frames) or ends the exchange.
6. The HUD still shows the pre-attack HP during the effect.

### Spells (`battleApplySpellCard`)

- The duel scene is the same, with both units on idle animations.
- `g_battleAttackerSide = (target + 1) & 1`, so the scripts' "defender" is the target.
- A protected target (card or status 0x962) gets effect 70 instead.

### Duel flow (scene states and `battleDuelUpdate` steps)

| Stage | Frames | What happens |
| --- | --- | --- |
| Intro (`battleIntroUpdate`, state 3) | 177 | Portraits at 1.3×. x goes −320 → 8 (≤ +16 per frame), holds until frame 149, then the scale drops to 0.8 (−0.02 per frame) while y goes 16 → 128 (≤ +5 per frame). A second emblem ("VS") sits at (292, 188). HUD and units are static and idle. Portraits are drawn with depth 0 here, so they appear in front of the units. Four windows are open on frames 0–175 (see below). |
| Ability pop-ups (states 4/5) | 64 each | Attack Castle (10) and Kodama (13) only, and they change AP when they open: +5 against a base; Kodama copies the opponent's AP. |
| Spell phase | — | Skipped by the player. |
| Exchange steps 0–2 | 3 + 64 per pop-up | Step 1 shows each side's pop-ups for First Attack (2), Fierce Attack (46), Poison (5), Resist (42–45) and Reflect Big Swings (50), 64 frames each, both sides at once. Step 2: First Attack decides the order (see **Exchange order** below). |
| Attack | — | See the attack timeline above. |
| Turn (steps 3–5) | 1 + 30 | The angle moves by 3° per frame; animations switch at 45°. |
| Counter-attack | — | The other unit uses its own card's effect. Bases never attack. |
| HP pass (steps 7/8) | ≥ 32 | DF ticks down by 1 per frame. Then the bar drains by `(300 div maxHP) · ΔHP / 100` px per frame, about 52 frames whatever the damage. The HP digit follows the bar. |
| Portrait wipe | 101 | Each dead unit's portrait loses 3 source rows per frame from the bottom. The unit keeps idling. |
| End hold | 65 | The last frame shows only the background. |

**Stats** (`unitRecalcStats` 0x08830760). The HUD's "shield" is DF and "attack" is effective AP.
- The player computes them from the two cards alone:
  - AP = card AP, +3 for Counter (23) when defending;
  - DF = Defense Skills (14) +1 and Ironclad (15) +2.
- The game also adds land (+1/+1 on a matching attribute), attachments, bases in range and adjacent
  allies.

**Damage** (`battleCalcDamage` 0x0888CC9C).
- Damage is 0 if the defender resists the attacker's card attribute (42–45), or has Reflect Big
  Swings (50) against AP > 3.
- Otherwise DF absorbs first, unless the attacker has Fierce Attack (46).
- Every ability test here and in the exchange uses `unitCountAbility(…, 1)`: attachments count
  (2306 / 2308 First Attack, 2310 Fierce Attack, 2207 Death Defense) and a Dominator (53) has Death
  Defense.

<a id="exchange-order"></a>**Exchange order** (`battleDuelUpdate` 0x0888CF84, verified 2026-09-27):
- Step 2 reads First Attack of the attacker and of the target. Only the target has it → the duel turns
  first and the target strikes first. The attacker only, both, or neither → the attacker strikes
  first (a tie goes to the attacker).
- `battleCalcDamage` stores the defender's new HP / DF as pending values; the unit's HP (+0x22) and
  DF (+0x38) change only in the HP pass (`battleAnimateHpBar`, steps 7/8).
- Without a sole holder, both units strike before the one HP pass. Both hits use the HP from before
  the exchange, so a unit killed by the first strike still strikes back.
- With exactly one holder, it strikes, the HP pass runs, and step 6 ends the duel if either unit is at
  HP 0. Otherwise the other unit turns, strikes back, and a second HP pass follows.
- There is no range test: every unit counter-attacks, whatever its range. Bases never strike
  (`battleLoadUnitAnims` presets their "attacked / passed / turned" flags), so a duel against a base is
  one strike and one HP pass.
- Attack end: a left-side attack ends when the effect is idle and the attack animation is on its last
  step; a right-side attack also needs 32 frames since `effectStart`.
- **Mutual Death** (steps 9/10): for a unit at HP 0 whose opponent is alive, its Mutual Death (3)
  pop-up shows, with the opponent's Death Defense (29) pop-up in the other window while it lasts. If
  the dead unit has 3 and the survivor lacks 29, the survivor's bar drains to 0.
- The duel destroys nothing: the board then runs `mapBattleAfterUpdate` (state 0x8A2) and
  `mapProcessDeaths(1)` (0xB54), where Revival and the other death triggers apply
  ([card-effects.md](card-effects.md#death-order)).

**Spells.** HP changes follow the effect: Magic Bolt −3, Reversal of Power −AP, heals +2/+5, and the
instant kills (Guidance of Dusk, Strength Atonement, Collapsed Heart) unless the target has Death
Defense.

The duel itself plays no sound effects apart from the UI sounds of its spell choice
(`battleSpellSelectUpdate`: cursor, confirm, cancel, refused); hits come from the effect scripts. Its music is
at3/BGM_11.at3.

### Duel windows (`menuWinUpdateAll`, style 10)

All window styles, glyphs and skins are described in [windows.md](windows.md).

**Look.**
- **Fill:** a rectangle with 5-px 45° chamfers, RGB (34, 34, 34), alpha 221/255.
- **Frame:** a 9-slice of the top-left 64×64 cell of etc.one 1/14:
  - corners 20×16;
  - 1-px edges stretched to the size;
  - the cell centre is transparent.
- **Text:**
  - gothic16 glyphs whose 16×16 cell has its top-left at `(x + 15 + 10n, y + 15)` (so centred 8 px
    right and below), scaled 0.889 × 1.111 about the cell centre ([windows.md](windows.md#glyphs));
  - advance 10 px, line height 20;
  - white, with a faint halo of the same colour at alpha 63;
  - fades in over 32 frames (+4 alpha per frame).
- **Depth:** every part is drawn at GE z 0x7FFF, after the effects.
- **Parsing:** names go through `msgParseNextGlyph`. Letters, digits and `- + .` are one byte each. Any
  other byte starts a two-byte code, so ASCII punctuation swallows the byte after it (hence names like
  "Euro' s Shackles").

**Name windows.** 300×48, at (0, 400) and (340, 400), one per unit, showing the card name. They open
after the ability pop-ups and stay open until the scene ends.

**Ability pop-ups.**
- Size: `10 · n + 30` wide, where n is the advance to the last glyph, and 48 high.
- Position: centred on x 96 / 544. The centre starts at y 248 and moves 1/32 of the remaining distance
  toward 308 on every `battleShowAbilityPopup` call while the window is open: twice a frame for the
  intro pop-ups (Attack Castle, Kodama) and eight times a frame for the exchange pop-ups (step 1).
- Duration: 64 frames.

### Intro windows (`battleIntroUpdate`)

- **Face windows** (`winOpenFace`, slots 1/2): 128×128, style 10 with a 16-px chamfer and no text, showing
  each player's Dominator (chara.one entry = card id, member 1).
  - The face is scaled w/160 = 0.8 with its bottom centre at (x + 72, y + 120), fading in by +8 per frame.
  - The windows start at (0, 480) / (512, 480). On frames 1–149, y ← y − (y − 320)/6. On frames 150–175
    they glide toward x −160 / 672 at the same rate.
- **Unit-name windows** (slots 3/4): glyph size 22 (advance 11, scale 0.978 × 1.222), w = 11n + 30,
  h = 50, at (288 − w, 174) and (351, 224). They do not move.
- All four close on frame 176. In story mode the player's Dominator is Galahad, and `g_duelPlayerNames`
  holds the Dominators' card names (`duelSetPlayerName`).
- **Names by mode** (**code**, every caller of `duelSetPlayerName`):
  - Story, stage select and prologue: the card names of the two Dominators.
  - Battle mode (`battleModeMenuScene` 0x088380EC) and the ad-hoc setup in the same scene (0x0883821C,
    `g_gameMode` 0, controllers set by role): **both** slots get the same local name buffer
    (0x089B7060).
  - Ad-hoc: `adhocNetUpdate` state 0x30, after the `{0x0D}` record exchange (0x0889E7EC / 0x0889E89C),
    **overwrites the opponent's slot** with the peer's name from its matching hello (+0x84, the name
    from the peer's save). The host writes slot 1; the joiner writes slot 0 with the host's name.
    Each side's own slot keeps its local name.
  - A resumed continue save (`saveDeserializeContinue`) restores the saved names when `g_gameMode` is
    0, and otherwise uses the Dominators' card names.

### Depth (derived from code, not compared with a real screen)

**The GE buffer.** Depth test is GEQUAL and the buffer is cleared to 0. Through-mode quads carry these
depths:

| Item | GE z |
| --- | --- |
| Background, portraits | 0 |
| HUD, units | `0x7FFF − depth` |
| Camera-0 effect sprites | `65535 / view depth` (about 85–400) |
| Camera-6 effect sprites | 0xFFFF |

**Consequences.**
- 3D effects are hidden behind the opaque pixels of the units and the HUD, but show over the background
  and the portraits.
- Camera-6 effects are over everything.
- The player emulates this with a WebGL depth buffer and has a toggle for it. Without depth it paints in
  an order that gives the same result: background, portraits, camera 0, HUD, units, camera 6.

## Not modelled by the player

- Spell selection.
- The exchange pop-ups of step 1 (First Attack, Fierce Attack, Poison, Resist, Reflect Big Swings).
- Mutual Death (steps 9/10), and the attachments that count as First Attack, Fierce Attack or Death
  Defense (the map's own prediction, `battlePredict`, has both).
- The intro pop-ups glide once per frame instead of twice.
- VFPU `sin`/`cos`/`atan`/`sqrt` differ from the JS functions by a few ulps.

The map context of a duel unit (current HP, land, attachments, bases in range, adjacent allies, Mutual Fight
copies, Breath of Hellgaia) is not in the two cards; the player asks for it per unit and applies
`unitRecalcStats`.
