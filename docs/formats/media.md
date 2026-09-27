# Music and movies (`at3/*.at3`, `Movie/*.pmf`)

Both use Sony's ATRAC3plus audio codec, which no browser decodes. The viewer converts them with
ffmpeg compiled to WebAssembly (`@ffmpeg/core` 0.12.10, ffmpeg 5.1). The ~31 MB core is served from
`node_modules` and loaded on first use.

## `at3/BGM_01.at3` … `BGM_17.at3`

The game's music, streamed by the BGM player (the EBOOT holds the 17 paths).

These are standard RIFF WAVE files:

- `WAVE_FORMAT_EXTENSIBLE` (0xFFFE) with the ATRAC3plus sub-format GUID
  `E923AABF-CB58-4471-A119-FFFA01E4CE62`;
- 44100 Hz stereo, block align 376;
- extra data `01 00 28 2E` (version 1, frame header config 0x282E);
- `fact` and `smpl` (loop) chunks.

ffmpeg's `atrac3plus` decoder handles them directly.

## `Movie/*.pmf` (PSMF)

| File | Length | Content |
| --- | --- | --- |
| LOGO.pmf | 16 s | developer logo (Yuke's) |
| OP.pmf | 99 s | opening |
| ED000.pmf, ED001.pmf | 90 s each | endings: the staff credits over artwork (after stage 15 / 18) |

When the game plays them, and how Play mode does: [title-newgame.md](title-newgame.md#1-boot-and-movies-main-0x088477d4).

Layout:

- `"PSMF0015"` header; u32 BE at +8 is the offset of the stream (0x800), u32 BE at +12 its size.
- An MPEG-2 program stream follows:
  - **video**: H.264 Main profile, 480×272, 29.97 fps, stream 0xE0;
  - **audio**: ATRAC3plus in private stream 1 (0xBD), sub-stream 0x00.

ffmpeg's MPEG-PS demuxer does not recognise the PSMF audio. It is extracted by the viewer (**data**,
verified on all movies):

1. Collect the payloads of the 0xBD PES packets whose first byte is 0x00. Each payload starts with
   4 bytes: sub-stream id, 0, and a u16 pointer to the first frame. Skip them.
2. The concatenation is a sequence of frames. Each frame has an 8-byte header `0F D0 cc cc 00 00 00 00`
   followed by `((cfg & 0x3FF) + 1) × 8` bytes of ATRAC3plus data. `cfg` is the big-endian u16 at
   bytes 2–3: channels `(cfg >> 10) & 7`, rate index `(cfg >> 13) & 3` (32000/44100/48000). The game's
   movies use 0x285C: 744-byte frames, stereo, 44100 Hz.
3. Strip the headers and wrap the frames in the same RIFF container as the .at3 files, with block
   align = frame size and the config bytes in the extra data.

The conversion to MP4 then runs in two steps:

1. ffmpeg decodes that RIFF to PCM.
2. It muxes the PCM with the copied H.264 stream as AAC.

A direct ATRAC3plus → AAC mux produces broken timestamps, hence the two steps.

Reference implementation: [`src/formats/psmf.ts`](../../src/formats/psmf.ts),
[`src/media/ffmpeg.ts`](../../src/media/ffmpeg.ts).
