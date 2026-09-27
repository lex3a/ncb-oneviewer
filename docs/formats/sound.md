# Sound banks (`snd/*.dat`)

`bgm.dat`, `se.dat` and `goc.dat` are plain Sony **VAG** files concatenated back to back. Each clip
starts on a 2048-byte boundary; the gap before the next one is zero padding (**data**: all three
files parse completely).

| File | Clips | Rate | Names | Content |
| --- | ---: | --- | --- | --- |
| se.dat | 49 | 11025 Hz | `se1.wav` … `se49.wav` | sound effects |
| goc.dat | 1270 | 44100 Hz | `<chara>_<n>.wav` (prefixes 0–18 and 100) | voice lines, one prefix per story episode ([database.md](database.md#voices)) |
| bgm.dat | 17 | 22050 Hz | `BGM_01.wav` … `BGM_17.wav` | VAG copies of the music, **never opened by the game** |

## VAG clip

Header, 0x30 bytes, **big endian**:

| Offset | Type | Description |
| --- | --- | --- |
| 0x00 | char[4] | `"VAGp"` |
| 0x04 | u32 | version (4) |
| 0x08 | u32 | 0 |
| 0x0C | u32 | data size in bytes |
| 0x10 | u32 | sample rate |
| 0x14 | u8[12] | 0 |
| 0x20 | char[16] | original file name |

Then `size` bytes of PSX ADPCM, mono. Each 16-byte block holds 28 samples:

| Byte | Meaning |
| --- | --- |
| 0 | low nibble = shift, high nibble = predictor (0–4) |
| 1 | flags: bit 0 = end, bit 1 = repeat, bit 2 = loop start; `7` = silent end block |
| 2–15 | 28 × 4-bit samples, low nibble first |

```
s = (sign-extend(nibble) << 12) >> shift
s += (s1 * F0[predictor] + s2 * F1[predictor] + 32) >> 6     // F0 = 0,60,115,98,122  F1 = 0,0,-52,-55,-60
```

The first block of every clip is the usual all-zero lead-in.

## How the game uses them (**code**, `sndInit` 0x0885f3bc)

- **goc.dat** is opened once and kept open; voice clips are streamed from it
  (`sndPlayVoiceVag`, table `g_vocGocClipTable`). The ids come from the `＠ｖN` tags in the story
  text; see [database.md](database.md#voices). Script id 0x14F `voice_play` is never used by effects.
- **se.dat** is read completely into memory (`g_seBank` 0x08A45540) at start-up. The clip positions
  come from a table hardcoded in the EBOOT (`g_seFileTable` 0x088ECCEC, 49 × `VagClipEntry` {u32
  startSector, u32 sectorCount, u32 byteSize, u32[2] 0}; byteSize = VAG size field + 0x30 for all 49
  clips, **data**) rather than from the file. `g_seOffsets` 0x08AF0540 / `g_seSizes` 0x08AF0640 hold the
  bank offset (past the 0x30-byte header) and size. The game then plays sound effect *n* (1-based) on
  one of 20 SAS voices; see [Sound effects](#sound-effects-sas) below.
- **bgm.dat** is never referenced. The music is streamed from `at3/BGM_01.at3` … `BGM_17.at3`
  (ATRAC3plus, see [media.md](media.md)). The EBOOT has a flag named `AT3plusBGMFlag0`, so the VAG
  set is probably a leftover fallback.

Reference implementation: [`src/formats/vag.ts`](../../src/formats/vag.ts).

## Sound effects (SAS)

### Output chain (**code**, `sndSysInit` 0x0885F5F4, `sndp_thread` 0x0885F584)

`sceSasInitWithGrain(0x400)` → `__sceSasInit(grain 0x400, 32 voices, stereo, 44100 Hz)`. The thread
`sndp thread` calls `sceSasCore` for 0x400-sample grains and writes them with
`sceWaveAudioWriteBlocking(2, 0x8000, 0x8000)` (libwave channel 2, unity). The libsas wrapper means to
give every voice pitch 0x1000, SimpleADSR(0xF, 0x5FC0) and volume 0, but its guard flag is only set
after the loop, so these per-voice defaults are never applied (Sony's bug, same bytes in SDK 6.6.0):
the voices keep the sceSasCore defaults.

Reverb: `sceSasSetEffectType(4)` (HALL), `sceSasSetEffect(dry 1, wet fxsw)`,
`sceSasSetEffectVolume(0xC00, 0xC00)`. `fxsw` (0x08B3C340) is written once, with 0, and never again:
**the wet path is off, so the game's sound effects are dry**. The HALL preset and the effect volume
have no audible effect (the voices do send at 0x1000, but nothing listens).

### One sound effect (`sndPlaySeUi` 0x0885FA90; `sndPlaySe` 0x0885F9B8 and `sndPlaySeEx` 0x0885FB68 are byte-identical)

| Call | Value | Meaning |
| --- | --- | --- |
| `sceSasSetVoice(v, g_seBank + off, size − 0x30, 0)` | clip *n* − 1, no loop | the lead-in block is played too |
| `sceSasSetPitch(v, 0x400)` | 0x1000 = one source sample per 44.1 kHz output sample | 0x400 → 11025 Hz, the clips' own rate |
| `sceSasSetADSR(v, 0xF, 0x40000000, 100, 100, 0x10000000)` | rates A, D, S, R | curves and sustain level keep the defaults |
| `sceSasSetVolume(v, 0x1000, 0x1000, 0x1000, 0x1000)` | dry L/R, effect send L/R | maximum, centred (no pan anywhere) |
| `sceSasSetKeyOn(v)` | | |

`v = g_seNextVoice` (0x08B3C344), then `(v + 1) % 20`: voices 0–19 round robin. A voice that is still
playing is simply re-keyed (the old sound stops). `sndStopSeVoice1` (CAS `se_stop`) keys off voice 1
only; `sndStopAllSe` (CAS `se_stop_all`) keys off 0–19. `sndPlaySeEx` (CAS `se_play_ex`) drops its
four extra arguments.

**ADSR** (curves as in PPSSPP's `SasAudio.cpp`; the defaults are linear increase / linear decrease /
linear decrease / linear decrease, sustain level 0; the envelope height runs 0 … 0x40000000 and steps
once per output sample):

- key-on: the voice waits `(32 × pitch >> 12) + 1` = 9 samples before reading, and the envelope stays
  at 0 for about 32 samples (key-on step), so the first ~23 output samples of the clip are muted.
  Every clip starts with a 28-sample zero block (= 112 output samples at pitch 0x400), so nothing is
  lost;
- attack +0x40000000: full level after one step;
- decay −100 per sample toward sustain level 0: −0.4 % per second, about −2.7 % at the end of the
  longest clip (se45, 6.6 s). Sustain (−100) is never reached;
- release on key-off −0x10000000 per sample: silent after 4 samples.

So a sound effect plays at full, constant volume, resampled ×4 with two-tap linear interpolation
(`s0 − ((s0 − s1) × frac >> 12)`), identical in both channels.

### Voices (goc.dat, libwave)

`sndPlayVoiceVag` reads the clip into 0x08AF0740 and plays it on libwave channel 0 with
`sceWavePlay(0, 0x7F, 0x7F)` (volumes 0 … 127 → 0 … 0x1000: unity). libwave decodes one PSX-ADPCM
block per 28 samples without resampling (the clips are 44.1 kHz). `sndStopVoice` / `sceWaveStop` fades
the channel out linearly over `fadeLen` = 0x70 samples, then stops it.

### Catalogue

**Code** = call sites of `sndPlaySeUi` / `sndPlaySe` whose argument is (or can be) that id: 272 calls,
the argument resolved from the decompiler's p-code for all of them (two take a variable:
`nameEntryUpdate` 1 / 7 / 9, `mapBoardScene` 7 / 9). **Effects** = effect.one scripts (effect id =
entry − 1000) with `se_play(id, _)`: 196 calls in 69 of the 70 scripts (the second argument, 127 / 128 /
172, is ignored). The script sources write `se_play(N + 1)`; three use globals whose initial values give
16 / 17 / 11. The UI ids have one meaning everywhere; the effect-only clips are named after the cards
whose effects play them (Sounds tab). Full lists: [`src/audio/seCatalog.ts`](../../src/audio/seCatalog.ts).
Ghidra: enum `/sound/SeId` on the parameter of `sndPlaySeUi` / `sndPlaySe` / `sndPlaySeEx`.

| SE | Length | Name | Code (functions) | Effects |
| ---: | ---: | --- | ---: | --- |
| 1 | 0.40 s | Cursor move | 30 (12) | |
| 2 | 0.18 s | Command ring turn (`mapCmdMenuUpdate`) | 2 (1) | |
| 3 | 4.96 s | Card drawn (`handSelectUpdate`, "%s has been drawn.") | 1 (1) | |
| 4 | 0.39 s | unused | | |
| 5 | 0.27 s | Page / switch (next report page, hand scroll, list switch, grid jump, message page break) | 16 (9) | |
| 6 | 0.81 s | unused | | |
| 7 | 0.17 s | Confirm (Cross) | 96 (36) | |
| 8 | 1.64 s | Window open / close (Triangle: card info, help) | 8 (4) | 43 |
| 9 | 0.26 s | Cancel (Circle) | 91 (30) | |
| 10 | 0.37 s | Refused (buzzer) | 28 (15) | |
| 11 | 0.70 s | effect | | 1, 11, 12, 13 |
| 12 | 0.63 s | effect | | 5 |
| 13 | 0.39 s | effect | | 2, 65, 66 |
| 14 | 0.95 s | effect | | 67 |
| 15 | 0.64 s | unused | | |
| 16 | 0.25 s | effect | | 4 |
| 17 | 0.68 s | effect | | 4, 6 |
| 18 | 0.81 s | effect | | 40, 69, 70 |
| 19 | 1.76 s | effect | | 7, 28, 46, 49, 55 |
| 20 | 3.93 s | effect | | 3, 35, 36, 52, 56 |
| 21 | 1.08 s | effect | | 1, 11, 13, 28, 36, 39, 47, 48, 51, 52, 56, 62 |
| 22 | 1.41 s | effect | | 20, 21, 22, 37, 41, 46, 59 |
| 23 | 0.65 s | effect | | 37 |
| 24 | 2.91 s | effect | | 16 effects (19–22, 30–34, 47, 48, 51, 53, 59, 60, 63) |
| 25 | 4.26 s | effect | | 24 effects (1, 8–11, 13–17, 20–22, 28, 37, 41–45, 57–59, 68) |
| 26 | 1.17 s | effect | | 44, 45 |
| 27 | 0.53 s | unused | | |
| 28 | 1.34 s | effect | | 23, 24, 28, 38, 39, 50, 51, 53, 61, 62 |
| 29 | 1.43 s | Cell seized (`mapSeizeCell`) | 1 (1) | 20 effects (19–22, 28, 30–34, 37, 41–45, 53, 59, 60, 63) |
| 30 | 0.45 s | effect | | 37 |
| 31 | 1.45 s | unused | | |
| 32 | 1.14 s | effect | | 19 effects (8–10, 14–17, 23, 24, 26, 27, 39, 43, 50, 57, 58, 61, 62, 68) |
| 33 | 1.56 s | effect | | 7, 28, 36, 41–45, 49, 51, 55, 69, 70 |
| 34 | 2.67 s | effect | | 18, 19, 26, 27, 44, 45, 46, 60, 64 |
| 35 | 4.31 s | effect | | 28, 40, 42, 43 |
| 36 | 2.01 s | effect | | 37, 38, 43, 44, 45 |
| 37 | 4.43 s | unused | | |
| 38 | 0.44 s | effect | | 65 |
| 39 | 1.50 s | effect | | 19, 40, 42, 46, 60 |
| 40 | 0.81 s | unused | | |
| 41 | 1.76 s | effect | | 40 |
| 42 | 1.48 s | effect | | 66 |
| 43–45 | 3.24 / 1.29 / 6.62 s | unused | | |
| 46 | 4.77 s | effect | | 54 (result screen: winner) |
| 47, 48 | 4.28 / 4.93 s | unused | | |
| 49 | 5.58 s | effect | | 28 |

37 of the 49 clips are played; 4, 6, 15, 27, 31, 37, 40, 43, 44, 45, 47 and 48 never are. The effect
scripts also call `se_stop` 7 times, always with the (always 0) return value of an earlier `se_play`
as a handle, which is ignored: voice 1 is keyed off whatever plays there.

Where the calls are (**code**): camp menu, stage select, title, resume, battle-mode (ad-hoc) menus,
name entry, deck editor, card list, card info, result screen, "How to play", the board
(`mapBoardScene`, cursor, L/R jump, command ring, hand picker, counter window, spell target / confirm
and the spell handlers, activated abilities, Revival prompt, turn start, Healing Spring / Trap Zone
reports, seizing), the duel's spell choice (`battleSpellSelectUpdate`) and every list window
(`winUpdateInput`: cursor, message page break).

### Viewer

[`src/audio/sas.ts`](../../src/audio/sas.ts) renders a voice sample by sample: key-on delay and
key-on step, the six ADSR curves (the exponential ones in 64-bit arithmetic), linear interpolation, the
envelope (`(h + 0x4000) >> 15`) and volume (`>> 12`) scaling, the 16-bit clip of the mix, and the
reverb. [`src/audio/sePlayer.ts`](../../src/audio/sePlayer.ts) plays those renders through WebAudio: 20
voices round robin, key-off with the 4-sample release, `se_stop` on voice 1, `se_stop_all`.

- **Exact** (with respect to PPSSPP's model; checked numerically, see below): pitch 0x400 resampling
  and interpolation, envelope, volumes, the 20-voice rotation, key-off, the dry output. The WebAudio
  path (pre-rendered buffer) matches the sample model to the last bit (OfflineAudioContext, max error 0).
- **Approximated**: the HALL reverb (off in the game; a "HALL reverb" switch in the Sounds tab turns it
  on). The offline render (WAV export, scope) runs the PSX SPU reverb formula with the PSP HALL constants
  as tabulated by PPSSPP (itself reverse-engineered, not Sony's code), including the 22.05 kHz decimation
  of the send and the zero-stuffed return. Real-time playback uses a ConvolverNode with that algorithm's
  impulse response, halved because a convolution cannot drop the odd send frames; it ignores 16-bit
  clipping inside the reverb. Against the offline render: 27 dB SNR after a 2-tap low-pass (the rest is
  the 22 kHz image of the zero-stuffing). The HALL tail decays by 60 dB in about 1 s. Simultaneous
  voices are summed in floating point (no 16-bit clip before the output).
- Voices (Story tab): the libwave stop fade over 0x70 samples.

Where the viewer plays sound effects: the **Sounds** tab of the card database (every clip with play
button, parameters, scope, code sites and effect scripts, WAV export of the SAS render), the effect
player (`se_play`, `se_stop`, `se_stop_all`), the map board (every `sndPlaySeUi` the port records, plus
the map and duel effect scripts; "sound" switch, off by default) and the deck editor / card list (the
calls of `deckEditScene`, `cardListScene` and `cardInfoUpdate` at the game's places; "sound" switch, off
by default).

**Verification**: `renderSasVoice` on se1, se7, se9, se29, se45: output length = 9 + 4 × source samples
(+1), every 4th output sample equals the source sample scaled by the envelope (error 0), midpoints equal
the interpolation formula, L = R, envelope 0x40000000 → 99.4–99.9 % at the end (97.3 % for se45);
key-off → 0 after 4 samples; key-on: first audible output sample 33. In headless Chrome, `SePlayer`
rendered in an OfflineAudioContext equals `renderSe` exactly for se7 and se45 (dry); release after
`keyOff` = 3 samples of tail; 21 plays use voices 0…19, 0.

