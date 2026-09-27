# ONE Viewer

Viewer and extractor for the `*.one` archives of **Neverland Card Battles** (PSP, `PSP_GAME/USRDIR/data`), and a
browser port of the game itself that plays from your own disc image (see [Playing the game](#playing-the-game)).
React 19 + TypeScript + Vite. Everything runs in the browser; files are never uploaded anywhere.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static build in dist/
```

Open the whole UMD image (`.iso`), the `PSP_GAME/USRDIR/data` folder (drag & drop or “Open folder”), or single
files: the `.one` archives,
the `snd/*.dat` sound banks, `gothic16.bin`, `at3/*.at3` music and `Movie/*.pmf` movies. Music and movies
are converted with ffmpeg.wasm (loaded on first use). An ISO is read lazily: its ISO 9660 directory is parsed
and every file is a slice of the image, so nothing is loaded until it is opened. `ICON0.PNG`, `PIC1.PNG` and
`PARAM.SFO` from the disc are shown too. The archive tree is on the left, a gallery or
file viewer on the right. "Extract" builds a ZIP with the raw files plus PNG conversions.

The card database is read from the game executable: `PSP_GAME/SYSDIR/BOOT.BIN` in the ISO (the plain ELF),
or a decrypted `.elf` opened on its own. With it, the viewer:
- adds a "Card database" page (cards, abilities, decks and each card's images, with a JSON export);
- labels archive entries with card, character and screen names;
- shows the speaker and text of every `goc.dat` voice clip.

The Card database page also replays the story scenes (Story tab: windows, faces, backgrounds, CGs and
goc.dat voices), shows the 16 boards (terrain, starts, stage and opponent), and a decrypted
`CADATA.SAV` opens as a save viewer (profile, cleared stages, collection, decks).

See [docs/formats/database.md](docs/formats/database.md). The game rules, card effects, AI and save format are documented in
[docs/formats](docs/formats/README.md).

## Playing the game

Once a disc image (or the data folder with `BOOT.BIN`) is loaded, **▶ Play** in the top bar runs the whole game in the
browser. No game data ships with this project; everything comes from your own disc. The game is built from the ports
described in the docs:
- the boot movies and the title;
- new game with the name keyboard;
- the camp, the deck editor and the card list;
- the stage select, the map board with the CPU, duels and effects;
- story events, results and rewards;
- the stage clear and the ending movies.

Saves go to `localStorage` in the `CADATA.SAV` layout (no encryption). The Saves panel exports them as `CADATA.SAV` files
and imports them (a decrypted PSP save works too). Versus play (ad-hoc) is not available yet.

The screen scales ×1 / ×2 / ×3 / fit and has a fullscreen mode, where the toolbar slides in when the mouse reaches the top
edge. There are two filter options: **bilinear** is the GE's texture filter, and **smooth scaling** smooths the upscaled picture.
Master, BGM, SE and voice have their own volumes. F2 opens a debug overlay: scene jump, pause / step, RNG and profile state.

Controls:

| PSP | Keyboard | Gamepad |
| --- | --- | --- |
| D-pad | arrows | D-pad / left stick |
| ✕ / ○ | X or Enter / O or Esc | A / B |
| △ / □ | T / S | Y / X |
| L / R | Q / E | LB / RB |
| START / SELECT | P or Space / Tab | Start / Back |

Mouse (a quality-of-life addition, the game itself has none):
- **Left click:**
  - on a menu row, card, square, unit, tab or help label (e.g. "□ Delete"), it does what that entry says;
  - pointing moves the cursor there;
  - a click anywhere advances dialogue, closes messages and accepts yes / no questions.
- **Right click:** ○ (back / cancel); in "Check board" it is □. The browser's context menu is off over the game.
- **Middle click:** START; it skips dialogue, banners and movies.
- **Wheel:** ↑ / ↓ in lists and card grids.
- **Help labels:** the one under the mouse gets the menu cursor's highlight.
- **Map board:** the camera scrolls at the screen edges while the mouse drives the cursor. Clicking your unit selects its square and opens the command ring.
- **Name entry:** Backspace deletes a character.

The details are in [docs/formats/play-mode.md](docs/formats/play-mode.md).

URL parameters:
- **`?play=1`** opens Play mode as soon as a disc is loaded. It works in the production build too: open the page with
  `?play=1`, pick your ISO or data folder, and the game starts.
- **`?load=/@fs/<absolute path>,…`** loads files from disk at start, for example the ELF and the `.one` archives. It works only
  in the dev server (`npm run dev`), which serves the files. Together with `?play=1` it starts the game straight away, for example
  `http://localhost:5173/?play=1&load=/@fs/C:/…/PSP_GAME/SYSDIR/BOOT.BIN,/@fs/C:/…/PSP_GAME/USRDIR/data/etc.one,…`.

## Formats

Full specifications live in [docs/formats](docs/formats/README.md). Short summary:

**ONE1** — `"ONE1"`, then entries `{u16 id, u16 size in 2048-byte sectors}` up to `{0,0}`;
data starts at `0xA000`. An entry is either a single file or a **CLC2** container:
`"CLC2", u32 n, n × {u32 id, u32 offset, u32 size}`.

**GBP** — image. `+0x08 u32 size, +0x10 u16 w, +0x12 u16 h, +0x14 u8 format (0x13 = 8bpp, 0x14 = 4bpp),
+0x18 u32 compression`. An RGBA palette follows at `0x20` (alpha `0x80` = opaque; 256-color palettes
are PS2 CLUT-swizzled — bits 3 and 4 of the index are swapped), then pixels (4bpp: low nibble first).
Compression of the byte stream: `0` — none; `1` — RLE, `(value, count)` pairs;
`2` — `u32 n, u32 fill, n × {u32 pos, u32 len}` fill runs, everything else is literal bytes.

**GAN** — 4bpp animated sprite: palettes (16 per image), image(s), timed steps (`u8 frame, u8 duration`,
255 = hold), and frames made of 20-byte parts (`image, palette, src x/y, dst x/y (+128), w, h, flags, angle, scale`).
Flags: `0x1` enables the blend mode in bits 4–5 (50% / additive / hidden / 25% additive), `0x4` rotates,
`0x8` scales (signed 4.12, negative mirrors); both pivot on the part's centre. Palette slot 12 marks
invisible marker parts, slot 15 is replaced by a black silhouette.

**CAS1** — compiled effect script (effect.one) for a stack VM: `N` 8-byte instructions at `0x18`
(`op, file, line, arg`), then strings, globals and source paths. The viewer shows a disassembly and a
reconstructed C-like pseudo-code with names for the built-in calls.

The **Play** tab runs the script in a port of the game's VM and effect library, with sprites, GAN
animations, textured poly meshes, cameras, tweens and sound from `snd/se.dat`. It draws with WebGL at
60 frames per second, the game's rate. With the ISO or the data folder loaded, "Duel: attack" and "Duel:
spell" put it in the duel scene: background, HUD, portraits and both units. There the attack animation
starts the effect on its hit frame, as in the game. See [docs/formats/effects.md](docs/formats/effects.md).

Most of this was confirmed against the game's own loaders and interpreter; see the docs for function
addresses.
