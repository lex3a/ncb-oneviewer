/**
 * Game data access for Play mode: the loaded disc (ONE archives, BOOT.BIN tables, the font and the
 * loose files), decoded images and animations cached per run, and the shared renderers' tables.
 * Nothing here is bundled with the app: everything comes from the player's own disc image.
 */
import { CardScreenRenderer, readCardScreenTables, type CardScreenAssets, type CardScreenTables, type Img } from '../effect/cardScreen'
import { readDeckEditorTables, type DeckEditorTables } from '../effect/deckEditor'
import { readExtrasTables, type ExtrasTables } from '../effect/extras'
import { readMapBoardTables, type MapBoardTables } from '../effect/mapBoard'
import { loadWinSkins, readWinTables, WindowPainter, type WinTables } from '../effect/windows'
import { ganSheetCache } from '../export'
import type { GameDb } from '../formats/gamedb'
import { parseGan, type Gan } from '../formats/gan'
import { gbpToImage, parseGbp } from '../formats/gbp'
import type { OneArchive } from '../formats/one'
import type { RgbaImage } from '../formats/palette'

export interface GameFiles {
  db: GameDb
  archives: OneArchive[]
  font: Uint8Array | null
  /** Reads a loose disc file by name (se.dat, goc.dat, BGM_01.at3 …); null when not loaded. */
  file: (name: string) => Promise<Uint8Array | null>
}

export class GameAssets {
  readonly db: GameDb
  readonly archives: OneArchive[]
  readonly font: Uint8Array | null
  readonly file: GameFiles['file']
  private images = new Map<string, RgbaImage | null>()
  private gans = new Map<string, Gan | null>()
  private canvases = new WeakMap<RgbaImage, Img>()
  private cache = new Map<string, unknown>()
  private cardScreens = new Map<string, CardScreenRenderer>()

  constructor(f: GameFiles) {
    this.db = f.db
    this.archives = f.archives
    this.font = f.font
    this.file = f.file
  }

  archive(name: string): OneArchive | undefined {
    return this.archives.find((a) => a.name.toLowerCase() === name)
  }

  /** A GBP member (entry, member; null member = a direct entry). */
  image(archive: string, entry: number, member: number | null): RgbaImage | null {
    const key = `${archive}/${entry}/${member}`
    if (this.images.has(key)) return this.images.get(key)!
    const f = this.archive(archive)?.entries.find((e) => e.id === entry)?.files.find((x) => x.subId === member)
    const img = f && f.kind === 'gbp' && f.data.length ? gbpToImage(parseGbp(f.data)) : null
    this.images.set(key, img)
    return img
  }

  gan(archive: string, entry: number, member: number | null): Gan | null {
    const key = `${archive}/${entry}/${member}`
    if (this.gans.has(key)) return this.gans.get(key)!
    const f = this.archive(archive)?.entries.find((e) => e.id === entry)?.files.find((x) => x.subId === member)
    const g = f && f.kind === 'gan' ? parseGan(f.data) : null
    this.gans.set(key, g)
    return g
  }

  /** CAS1 script of effect.one entry (member 1). */
  effectScript(entry: number): Uint8Array | null {
    return this.archive('effect.one')?.entries.find((x) => x.id === entry)?.files.find((x) => x.kind === 'cas')?.data ?? null
  }

  /** An image as a canvas with the GE alpha test (alpha > 0x28), for the 2D card screen. */
  canvas(img: RgbaImage | null): Img | null {
    if (!img) return null
    let c = this.canvases.get(img)
    if (c) return c
    c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const rgba = new Uint8ClampedArray(img.rgba)
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i] <= 40) rgba[i] = 0
    c.getContext('2d')!.putImageData(new ImageData(rgba, img.width, img.height), 0, 0)
    this.canvases.set(img, c)
    return c
  }

  private once<T>(key: string, make: () => T): T {
    if (!this.cache.has(key)) this.cache.set(key, make())
    return this.cache.get(key) as T
  }

  get winTables(): WinTables {
    return this.once('win', () => readWinTables(this.db))
  }
  get mapTables(): MapBoardTables {
    return this.once('map', () => readMapBoardTables(this.db))
  }
  get deckTables(): DeckEditorTables {
    return this.once('deck', () => readDeckEditorTables(this.db))
  }
  get cardScreenTables(): CardScreenTables {
    return this.once('cs', () => readCardScreenTables(this.db))
  }
  get extrasTables(): ExtrasTables {
    return this.once('extras', () => readExtrasTables(this.db))
  }
  get winSkins(): (RgbaImage | null)[] {
    return this.once('skins', () => loadWinSkins((a, e, m) => this.image(a, e, m)))
  }
  /** The window painter (skins from option.one, gothic16 glyphs). */
  get painter(): WindowPainter {
    return this.once('painter', () => new WindowPainter({ skins: this.winSkins, font: this.font, tables: this.winTables }))
  }

  /** cardInfoDraw* renderer for a card with these attachments (sprites loaded on first use). */
  cardScreen(id: number, attachments: number[] = []): CardScreenRenderer {
    const key = `${id}:${attachments.join(',')}`
    let r = this.cardScreens.get(key)
    if (r) return r
    const common = this.once('csCommon', () => ({
      digits: this.canvas(this.image('etc.one', 2, 1)),
      hand: this.canvas(this.image('etc.one', 2, 2)),
      ui: this.canvas(this.image('etc.one', 2, 4)),
      frame: this.canvas(this.image('etc.one', 2, 5)),
      icons: this.canvas(this.image('etc.one', 1, 11)),
    }))
    const g = id < 1000 ? this.gan('card.one', id, null) : null
    const a: CardScreenAssets = {
      ...common,
      font: this.font,
      preview: this.canvas(this.image('unit.one', id, 3)),
      attachments: attachments.map((x) => this.canvas(this.image('unit.one', x || 1000, 2))),
      gan: g ? { gan: g, sheets: ganSheetCache(g) } : null,
      token: id > 2999 ? this.canvas(this.image('card.one', 10010, id)) : null,
    }
    r = new CardScreenRenderer(this.db, this.cardScreenTables, a)
    this.cardScreens.set(key, r)
    return r
  }

  /** Which archives are missing for Play mode. */
  missing(): string[] {
    const need = ['option.one', 'etc.one', 'unit.one', 'effect.one', 'map.one', 'card.one', 'chara.one']
    const m = need.filter((n) => !this.archive(n))
    if (!this.font) m.push('gothic16.bin')
    return m
  }
}
