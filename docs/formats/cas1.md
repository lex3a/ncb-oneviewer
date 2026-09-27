# CAS1 effect script

Compiled bytecode of the game's effect scripting language, a small C-like language (`.CAR` sources
that include `.cah` headers). There are 70 files, all in effect.one, and each is always member `/1` of
its effect's CLC2. The other members of that CLC2 are the GBP/GAN assets the script loads.

This document is based on the interpreter in the USA EBOOT and was checked against all 70 scripts:
the layout below accounts for every byte of every file.

| Function | Role |
| --- | --- |
| `FUN_0889cba4` | scrSetBuffer: parses the header and starts the script |
| `FUN_0889cae4` | scrLoadBuffer: copies the file, then calls scrSetBuffer |
| `FUN_0889ce10` | interpreter: runs one script slot for one frame |
| `FUN_0889c640` | runs all script slots |
| `FUN_0889671c`, `FUN_08890ee4`, `FUN_0889b880`, `FUN_08896678` | register the built-in functions |

## Layout

| Offset | Type | Description |
| --- | --- | --- |
| 0x00 | char[4] | `"CAS1"` |
| 0x04 | u32 | total size. Used only to copy the buffer |
| 0x08 | u32 | instruction count *N* |
| 0x0C | u16 | string count *C* (the high half is unused) |
| 0x10 | u16 | source file count *F*. Stored but not used |
| 0x12 | u16 | global slot count *G* |
| 0x14 | u32 | not read |
| 0x18 | instr[N] | code. Instruction *i* is at `0x18 + 8i` |
| … | string[C] | `u16 len, u16 pad, char[len]` (len includes NUL padding), no alignment |
| … | u32[G] | globals: initial values. The VM reads and writes them **in place** |
| … | char[256][F] | source file paths, NUL-padded (debug info only) |

Example source paths (effect 1001):

```
E:\CARDIN~1\TEST4\ONE\_EFFECT\EFFE001\EFFE001.CAR
E:\CARDIN~1\TEST4\ONE\_EFFECT\EFFE001\..\compiler\stdfunc.cah   (also 3d_func, efcfunc, tabfunc, effetypes, effemacros)
```

53 scripts start with `label 0`. The other 17 start with `addr 0x263; call goto`, which jumps straight
to an init block at the end of the script.

### Instruction (8 bytes)

| Offset | Type | Description |
| --- | --- | --- |
| 0x0 | u8 | opcode |
| 0x1 | u8 | source file index (debug) |
| 0x2 | u16 | source line (the runtime-error printer shows it) |
| 0x4 | u32 | argument |

## Execution model

- **Script slots.** There are 48 slots. Each has a 128-entry value stack plus a parallel type-tag stack
  (`0x10` int, `0x20` float, `0x30` string, `0x60` label).
- **Values are references.** Every stack entry is a *pointer* to its value: literals point at their own
  argument field inside the code, and operator results go into a 128-entry scratch ring. This is why
  `=`/`+=` can write through their left operand.
- **Threads.** Each script has 13 threads. Each thread has an 8-deep call stack, and 32 int and
  32 float locals.
- **Entry points.** A script has 16 entry points (event handlers). Loading runs the init code
  immediately. Init registers entry 15 (`set_entry(15, L1)`) and returns. The effect driver then
  triggers entry 15 on thread 0.
- **Once per frame** the interpreter runs threads 0..12 in turn. Each thread runs until a handler yields
  (`wait_frame`), the thread returns from depth 0, or the script dies. The VM has no timers: waits are
  loops around `wait_frame`, e.g. `while (obj_is_loading(-1)) wait_frame();`.
- **Script end.** A script ends on `exit`, on an error, when a handler returns −1, or when the pc runs
  past *N*. There is no end opcode.

### Opcodes

| Op | Name | Semantics |
| --- | --- | --- |
| 0x10 | `int` | push int (reference to the argument) |
| 0x20 | `float` | push float |
| 0x30 | `str` | pop int *k*, push string `#(arg + k)` |
| 0x02 | `gvar` | pop int *k*, push a reference to `globals[(arg & 0xFFFF) + k]`. `arg >> 16 == 0x21` means float, otherwise int (0x11) |
| 0x04 | `addr` | push a label value: instruction index `arg`. It does not jump by itself |
| 0x60 | `label` | no-op at run time. `arg` is the label id, and jump targets always land on one |
| 0x01 | `call` | `r = table[arg](ctx, arg)`, table at `0x09CE73F4` (0x400 entries). An unknown id is a fatal error |
| other | — | ignored |

A handler's return value controls the thread:

| r | Effect |
| --- | --- |
| 0 | continue |
| 1 | continue at the next instruction on the next frame (yield) |
| 2 | retry the same instruction on the next frame |
| −1 | kill the script |

Arguments are pushed left to right. Every `call` pushes one result, and the compiler drops it with
`call pop` (0x65) at the end of each statement. Jumps are the only calls not followed by `pop`.

### Call ids

Every registered id is named, with its argument signature, in
[`src/formats/casNames.ts`](../../src/formats/casNames.ts); the same names are applied to the handlers
in Ghidra (`scrfn_*`). All handlers push one result except the jumps (0x46–0x4B) and `pop` (0x65).
Only `wait_frame` (0x64) yields. Summary:

| Ids | Group |
| --- | --- |
| 0x0A–0x23 | operators: `+ - * / % & | ^`, `|| && == != < > <= >=`, 0x1A neg, 0x1B `!`, 0x1E–0x23 `= += -= *= /= %=`. Arithmetic is int if both operands are int, otherwise float |
| 0x46–0x4E | control flow: 0x46 goto, 0x47/0x48 jump if true/false `(cond, L)`, 0x49 gosub, 0x4C return. 0x4A/0x4B/0x4D/0x4E (conditional gosub/return) are **broken** in the game: the handler compares against the wrong ids, so they never branch |
| 0x5F–0x90 | VM services: thread locals, `wait_frame`, `pop`, `exit`, threads, entry points, function arguments, data/script loading, debug print, int↔float, `rand`, `strcmp` |
| 0xC8–0xED | math: trig, deg↔rad (0xD0 deg→rad), pow, logs, min/max/abs, sqrt, vector length/distance. 0xE2 "fmin" returns the max (bug) |
| 0x100–0x17E | game functions: global flags and variables, message/menu windows, BGM/SE/voice/stream sound, array helpers, point-in-rect/circle, "approach" helpers. Several are empty stubs |
| 0x180–0x1CB | effect library: cameras, `scr_LoadSprite`/`scr_LoadAnm`, script objects, tweens, global tint, sprite pivot/source rect, textured "poly" meshes (spheres, tubes, cones; optionally shattered), animation control |
| 0x320–0x389 | battle/map state: attacker/defender side, side anchor positions, result winner, map camera |

The two load functions are named by the game's own debug strings. The other names are descriptive.

### Calls used by effects (**code**)

- **Loading.** `scr_LoadSprite/scr_LoadAnm(obj, archive, entry, member, flags)`. `archive` indexes the
  script archive table (48 slots); `main` fills slots 4–10 with option, etc, unit, **effect (7)**, map,
  card, chara. `member < 1` loads the whole entry. `flags` low nibble: 0 keep in RAM, 1 upload to VRAM,
  2 upload and free the RAM copy; 0x10 forces a reload. Loads are asynchronous: scripts wait with
  `while (obj_is_loading(-1)) wait_frame();`. Calling `scr_LoadAnm` again on the same object adds
  another animation to it (switch with `anim_switch`).
- **Coordinates.** Positions are passed as `(x, d, h)`. For 3D objects the world position is
  `(x, −h, −d)`; 2D objects use them as is. Units are pixels of a 640×448 virtual screen (drawn at
  480×272). The default 3D camera sits at (320, 224, −768) with focal length 768, so the z = 0 plane is
  drawn at 1:1.
- **Cameras.** 8 cameras, copied from engine render contexts when effects start: 0–2 3D perspective
  (focal 768), **3 = the battle-field/board camera** (a copy of the 2D-sorted context with zoom 2.0,
  rotated (−65°, 0, −30°) and scrolled every frame by the map code; card and map unit sprites use it),
  4 2D sorted, 5 2D background, 6–7 2D foreground (focal 32768, i.e. near-orthographic). Objects draw with
  the camera set by `obj_set_camera`. Mode 0 cameras use the projected draw path; the 2D modes take depth
  from the mode (background, depth-sorted, foreground).
- **Axes and rotation.** World +X is screen right, **+Y is screen down**, +Z points into the screen;
  angles are radians, right-handed (a positive Z angle turns +X toward +Y, i.e. clockwise on screen).
  The camera applies its rotation X first, then Y, then Z; sprites and meshes apply theirs in the
  reverse order (Z, Y, X).
- **Cloning.** `obj_clone(dst, src)` copies the object record. A sprite gets its own sprite via
  `spriteCopy`, sharing the texture. An animation is copied with `anmClone` mode 2 (deferred until the
  source has loaded): it gets its own GanObjects, timers, colour and transform, but shares the GAN frame
  records and their part sprites with the source. The draw rewrites a part sprite's state before each
  use, so the two still animate independently (effects.md "Clone"). No effect clones an animation.
- **Poly meshes.** `poly_create(obj, pattern, srcObj)` builds a mesh textured with `srcObj`'s sprite:
  pattern 0 = UV sphere (8 × 16 segments), 1–7 = open tube with 32/16/8/6/5/4/3 sides.
  `poly_params(obj, A, B, H, spread, spin)`: sphere radius A (X/Z) and H (Y); tube radii A (top ring,
  texture bottom) and B (other ring, texture top — A ≠ B gives a cone) and height H. `spread` 1.0 keeps
  the mesh closed, > 1 pushes every triangle outward (explosion), 0 collapses it; `spin` scales a
  random per-triangle tumble (an absolute angle, so scripts increase it every frame). In effect.one
  56 calls use pattern 1, 15 the sphere, 2 pattern 3, and 171 of 186 `poly_params` calls keep spread 1
  and spin 0: mostly light pillars, rings and orbs rather than shatters.
- **Loading data.** `scr_LoadData(slot, archive, entry, member, size)` allocates `size` bytes into one of
  16 data slots and queues CLC2 member `member` of ONE entry `entry`; completion is only visible through
  `obj_is_loading(-1)`. `start_script(scriptSlot, dataSlot)` runs it, `free_data` frees it. No effect
  uses these (they exist for sub-scripts; effect scripts themselves are loaded the same way by the engine).
- **Tweens.** `tween_*` take a *speed* (units, colour steps or radians per second), not a duration;
  `tween_pos_arc` adds a parabolic jump. `obj_tween_flags` returns the running tweens
  (1 position, 2 colour, 4 rotation, 8 scale) and scripts poll it.
- **Battle data.** `battle_get_defender_side(&s)` then `battle_get_side_pos(s, &x, &y, &z)` positions
  an effect on the target (side 0 = left combatant). `result_get_winner` feeds the result-screen effects.
- **Sound.** `se_play(id, _)` plays sound effect `id` from the resident bank on one of 20 voices;
  `se_stop` always stops voice 1 (bug); `se_stop_all` stops all SE voices.

## Example

Effect 1003, as reconstructed by the viewer's decompiler:

```c
L0:
    set_entry(15, L1);
    return(0);
L1:
    cam_get_pos(0, g8, g9, g10);
    cam_set_pos(0, g5, g6, g7);
    gf11 = deg2rad(-45f);
    cam_set_rot(0, gf11, gf12, gf13);
    scr_LoadSprite(g18, 7, 1003, 2, 1);
    scr_LoadSprite((g18 + 1), 7, 1003, 3, 1);
L5:
    if_false_goto(obj_is_loading(-1), L6);   // while (obj_is_loading(-1)) wait_frame();
    wait_frame();
    goto(L5);
L6:
    ...
    start_thread(1, L2);
    start_thread(2, L3);
```

## Open questions

- Camera fields +0xD8..+0xF0 (set by `cam_config` and `cam_viewport`) are written but never read by
  anything in this build, so their intended meaning cannot be recovered.
- Negative `archive` values in `scr_LoadSprite/scr_LoadAnm` read an in-memory container table that is
  never filled in this build (dead feature; no effect uses it). They would look the member up with
  `clc2FindMember` (clc2.md), and an id that is not found is fatal (`messageExit`).
- The call stack has 8 slots per thread with no bounds check.

How the VM, the script objects and the renderer behave in detail (and what the viewer's effect player
implements): [effects.md](effects.md).

Reference implementation: [`src/formats/cas.ts`](../../src/formats/cas.ts),
[`src/formats/casDecompile.ts`](../../src/formats/casDecompile.ts).
