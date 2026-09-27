# ONE archive (`*.one`)

Top-level archive. Sector based: every entry starts on a 2048-byte boundary.

## Layout

| Offset | Type | Description |
| --- | --- | --- |
| 0x0000 | char[4] | `"ONE1"` |
| 0x0004 | entry[] | table of entries, terminated by an all-zero entry |
| … | — | zero padding up to 0xA000 |
| 0xA000 | — | entry data, back to back |

### Entry (4 bytes)

| Offset | Type | Description |
| --- | --- | --- |
| 0x0 | u16 | entry id |
| 0x2 | u16 | entry size in 2048-byte sectors |

Terminator: `id == 0 && size == 0`.

## Notes

- There is no offset field. Entry *n* starts at `0xA000 + 2048 × Σ size[0…n-1]`, and the last entry
  ends exactly at the end of the file (**confirmed**).
- The table area (0x0004–0x9FFF) fits 10239 entries; the largest archive (unit.one) uses 228.
- Ids are unique within an archive but not contiguous (e.g. map.one uses `1, 1000, 1001, 1100 …`).
- The entry payload is either a [CLC2 container](clc2.md) or a single file
  ([GBP](gbp.md) or [GAN](gan.md)), recognised by its magic. Single files are padded to the sector
  size; their real length comes from the file's own size field.

## Extracting

```ts
let offset = 0xA000
for (let t = 4; ; t += 4) {
  const id = u16(t), sectors = u16(t + 2)
  if (id === 0 && sectors === 0) break
  const data = file.subarray(offset, offset + sectors * 2048)
  offset += sectors * 2048
}
```

Reference implementation: [`src/formats/one.ts`](../../src/formats/one.ts).
