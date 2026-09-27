import { zipSync, type Zippable } from 'fflate'
import { drawGanFrame, ganBounds, ganSheet, parseGan, type Gan, type SheetCache } from './formats/gan'
import { gbpToImage, parseGbp } from './formats/gbp'
import { KIND_EXT, type OneArchive, type OneFile } from './formats/one'
import type { RgbaImage } from './formats/palette'
import { encodePng } from './png'

export function imageToCanvas(img: RgbaImage): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = Math.max(1, img.width)
  c.height = Math.max(1, img.height)
  if (img.width && img.height) {
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.rgba), img.width, img.height), 0, 0)
  }
  return c
}

export function canvasToPng(c: HTMLCanvasElement): Uint8Array {
  const { data } = c.getContext('2d')!.getImageData(0, 0, c.width, c.height)
  return encodePng(c.width, c.height, data)
}

const imageToPng = (img: RgbaImage) => encodePng(img.width, img.height, img.rgba)

export function download(data: Uint8Array | Blob, name: string, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export function fileBaseName(archive: string, f: OneFile): string {
  const arc = archive.replace(/\.one$/i, '')
  return f.subId === null ? `${arc}_${f.id}` : `${arc}_${f.id}_${f.subId}`
}

/** Sheets decoded with the game's palettes, one canvas per (image, palette) pair. */
export function ganSheetCache(g: Gan): SheetCache {
  const cache = new Map<number, HTMLCanvasElement>()
  return (image, clut) => {
    const key = image * 4096 + clut
    let c = cache.get(key)
    if (!c) {
      c = imageToCanvas(ganSheet(g, image, g.palettes[clut]))
      cache.set(key, c)
    }
    return c
  }
}

/** Renders every animation frame of a GAN onto a same-sized canvas. */
export function renderGanFrames(g: Gan): HTMLCanvasElement[] {
  const sheets = ganSheetCache(g)
  const b = ganBounds(g)
  return g.frames.map((parts) => {
    const c = document.createElement('canvas')
    c.width = b.w
    c.height = b.h
    const ctx = c.getContext('2d')!
    ctx.imageSmoothingEnabled = false
    drawGanFrame(ctx, sheets, parts, -b.x, -b.y)
    return c
  })
}

/** PNG files a single archive member converts to (empty for non-image kinds). */
export function convertFile(f: OneFile): { suffix: string; png: Uint8Array }[] {
  if (f.kind === 'gbp') return [{ suffix: '', png: imageToPng(gbpToImage(parseGbp(f.data))) }]
  if (f.kind === 'gan') {
    const g = parseGan(f.data)
    const out = g.images.map((_, i) => ({ suffix: g.images.length > 1 ? `_sheet${i}` : '_sheet', png: imageToPng(ganSheet(g, i)) }))
    renderGanFrames(g).forEach((c, i) => out.push({ suffix: `_f${String(i).padStart(2, '0')}`, png: canvasToPng(c) }))
    return out
  }
  return []
}

export async function zipAsync(files: Zippable): Promise<Uint8Array> {
  return zipSync(files, { level: 0 })
}

/** Yields to the event loop without setTimeout's background-tab throttling. */
const yieldToUi = () =>
  new Promise<void>((r) => {
    const ch = new MessageChannel()
    ch.port1.onmessage = () => r()
    ch.port2.postMessage(0)
  })

export async function extractArchive(
  archives: OneArchive[],
  opts: { raw: boolean; png: boolean },
  onProgress: (done: number, total: number) => void,
): Promise<Uint8Array> {
  const files: Zippable = {}
  const all = archives.flatMap((a) => a.entries.flatMap((e) => e.files.map((f) => ({ a, f }))))
  let done = 0
  let lastYield = performance.now()
  for (const { a, f } of all) {
    const dir = a.name.replace(/\.one$/i, '')
    const sub = f.subId === null ? `${f.id}` : `${f.id}/${f.subId}`
    const base = `${dir}/${sub}`
    if (opts.raw) files[`${base}.${KIND_EXT[f.kind]}`] = f.data.slice()
    if (opts.png) {
      try {
        for (const { suffix, png } of convertFile(f)) files[`${base}${suffix}.png`] = png
      } catch (e) {
        console.warn(`convert ${base} failed`, e)
      }
    }
    done++
    if (performance.now() - lastYield > 50) {
      onProgress(done, all.length)
      await yieldToUi()
      lastYield = performance.now()
    }
  }
  onProgress(done, all.length)
  return zipAsync(files)
}
