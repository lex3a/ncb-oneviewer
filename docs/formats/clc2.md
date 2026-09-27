# CLC2 container

Groups related files (e.g. all assets of one unit or one effect) inside a single [ONE](one.md) entry.

## Layout

| Offset | Type | Description |
| --- | --- | --- |
| 0x00 | char[4] | `"CLC2"` |
| 0x04 | u32 | member count *N* |
| 0x08 | member[N] | member table |
| … | — | member data |

### Member (12 bytes)

| Offset | Type | Description |
| --- | --- | --- |
| 0x0 | u32 | member id |
| 0x4 | u32 | offset of the data, relative to the start of the CLC2 |
| 0x8 | u32 | data size in bytes (exact, without padding) |

## Notes (all **confirmed**)

- The first member starts right after the table, rounded up to 16 bytes.
- Each following member starts at the end of the previous one, rounded up to 16 bytes. There are no gaps
  or overlaps, and the padding is zero.
- The rest of the ONE entry after the last member is zero padding up to the sector boundary.
- Members are GBP, GAN or CAS1. Containers are never nested.
- Member ids are small and meaningful per archive (e.g. in effect.one `1` is always the CAS1 script).

## Lookup in the game (`clc2FindMember` 0x08877174, **code**, read from the assembly)

`clc2FindMember(clc2, id)` returns a pointer to the member's data, `clc2 + offset`.
- It reads the magic byte by byte. The count is read as **u16** (bytes 4–5 only; bytes 6–7 are
  ignored). Ids and offsets are assembled byte by byte, so the table may be unaligned.
- Results:

| Case | Result |
| --- | --- |
| id found | `clc2 + member.offset` (0x08877278) |
| magic ≠ `"CLC2"` | −3 (0x088771B8 / 0x088771E8), no message |
| id == 0 | message `CLC_ID %d は存在しません。` ("CLC_ID %d does not exist") and `messageExit` (fatal: ends in `exit`); −1 would be returned (0x088771A8) |
| id not in the table | same message and `messageExit`; −1 (0x088772B0) |

- The `return 0` at 0x0887728C cannot be reached: the loop only exits with index == count. The
  decompiled output shows it, which is why the returns looked inconsistent.
- Callers:
  - `fileLoadQueueUpdate` (0x08876A80, 0x08876CAC) compares the result with −3 and −1 explicitly.
  - `scrObjLoadAnm` checks for 0, which never happens.
  - `scrObjLoadSprite` does not check at all.
  - The two script loaders reach it only with a negative archive index, which is a dead path (see
    cas1.md).

Reference implementation: `parseEntry` in [`src/formats/one.ts`](../../src/formats/one.ts).
