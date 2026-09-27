/**
 * Turning whatever the user gives us into a flat list of files: picked files, picked or dropped
 * folders, and UMD ISO images (read lazily — a file inside the image is just a Blob slice).
 */
export interface InputFile {
  name: string
  /** Path shown in the UI (relative folder path, or path inside the ISO). */
  path: string
  blob: Blob
}

const relPath = (f: File) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name

export function fromFileList(list: FileList | File[]): InputFile[] {
  return Array.from(list, (f) => ({ name: f.name, path: relPath(f), blob: f }))
}

// --- Drag & drop: dataTransfer.files lists a dropped folder as an empty entry, so walk the tree.

function readAllEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader()
  const out: FileSystemEntry[] = []
  return new Promise((resolve, reject) => {
    // readEntries returns at most ~100 entries per call; keep calling until it returns none.
    const next = () =>
      reader.readEntries((batch) => {
        if (!batch.length) return resolve(out)
        out.push(...batch)
        next()
      }, reject)
    next()
  })
}

async function walk(entry: FileSystemEntry, prefix: string, out: InputFile[]) {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej))
    out.push({ name: file.name, path, blob: file })
  } else if (entry.isDirectory) {
    for (const child of await readAllEntries(entry as FileSystemDirectoryEntry)) await walk(child, path, out)
  }
}

export async function fromDataTransfer(dt: DataTransfer): Promise<InputFile[]> {
  // Entries must be taken synchronously, before the first await: the DataTransfer is emptied after.
  const entries = Array.from(dt.items)
    .map((it) => (it.kind === 'file' ? it.webkitGetAsEntry?.() : null))
    .filter((e): e is FileSystemEntry => !!e)
  if (!entries.length) return fromFileList(dt.files)
  const out: InputFile[] = []
  for (const e of entries) await walk(e, '', out)
  return out
}

// --- ISO 9660 (UMD images). Directory records never cross a 2048-byte sector.

const SECTOR = 2048

export const isIsoName = (name: string) => /\.iso$/i.test(name)

async function readRange(blob: Blob, offset: number, length: number): Promise<Uint8Array> {
  return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer())
}

export async function readIso(image: Blob, imageName: string): Promise<InputFile[]> {
  const pvd = await readRange(image, 16 * SECTOR, SECTOR)
  if (pvd[0] !== 1 || String.fromCharCode(...pvd.subarray(1, 6)) !== 'CD001') {
    throw new Error(`${imageName}: not an ISO 9660 image`)
  }
  const pdv = new DataView(pvd.buffer)
  const rootLba = pdv.getUint32(156 + 2, true)
  const rootSize = pdv.getUint32(156 + 10, true)
  const dec = new TextDecoder('latin1')
  const out: InputFile[] = []
  const seen = new Set<number>()

  const readDir = async (lba: number, size: number, prefix: string) => {
    if (seen.has(lba)) return // guard against loops in broken images
    seen.add(lba)
    const data = await readRange(image, lba * SECTOR, size)
    const dv = new DataView(data.buffer)
    let o = 0
    while (o < data.length) {
      const len = data[o]
      if (len === 0) {
        o = (Math.floor(o / SECTOR) + 1) * SECTOR // rest of the sector is padding
        continue
      }
      const extent = dv.getUint32(o + 2, true)
      const bytes = dv.getUint32(o + 10, true)
      const flags = data[o + 25]
      const nameLen = data[o + 32]
      const raw = data.subarray(o + 33, o + 33 + nameLen)
      o += len
      if (nameLen === 1 && (raw[0] === 0 || raw[0] === 1)) continue // "." and ".."
      const name = dec.decode(raw).replace(/;\d+$/, '').replace(/\.$/, '')
      const path = prefix ? `${prefix}/${name}` : name
      if (flags & 2) await readDir(extent, bytes, path)
      else out.push({ name, path: `${imageName}/${path}`, blob: image.slice(extent * SECTOR, extent * SECTOR + bytes) })
    }
  }

  await readDir(rootLba, rootSize, '')
  return out
}

/** Replaces every .iso in the list by the files inside it. */
export async function expandIsos(files: InputFile[]): Promise<InputFile[]> {
  const out: InputFile[] = []
  for (const f of files) {
    if (isIsoName(f.name)) out.push(...(await readIso(f.blob, f.name)))
    else out.push(f)
  }
  return out
}
