import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { CardScreenClock, CardScreenRenderer, readCardScreenTables, type CardScreenAssets, type CardScreenState, type Img } from '../effect/cardScreen'
import {
  CARD_NOS,
  DeckEditorRenderer,
  DeckEditorSim,
  MODE_DECK,
  MODE_LIST,
  PAD,
  readDeckEditorTables,
  UiClock,
  type Collection,
  type DeckData,
} from '../effect/deckEditor'
import { GlRenderer } from '../effect/gl'
import { playUiSe } from '../audio/sePlayer'
import { VIRTUAL_H, VIRTUAL_W } from '../effect/scene'
import { loadWinSkins, readWinTables, WindowPainter } from '../effect/windows'
import { download, ganSheetCache } from '../export'
import type { GameDb } from '../formats/gamedb'
import { parseGan } from '../formats/gan'
import { gbpToImage, parseGbp } from '../formats/gbp'
import type { OneArchive } from '../formats/one'
import type { RgbaImage } from '../formats/palette'
import { parseSave, type SaveFile } from '../formats/save'

interface Props {
  db: GameDb
  archives: OneArchive[]
  loadFont?: () => Promise<Uint8Array | null>
}

type Source = 'all3' | 'starter' | 'save'

const FRAME_MS = 1000 / 60

/** Keyboard → PSP pad bit. */
const KEYS: Record<string, number> = {
  ArrowUp: PAD.UP,
  ArrowDown: PAD.DOWN,
  ArrowLeft: PAD.LEFT,
  ArrowRight: PAD.RIGHT,
  x: PAD.CROSS,
  Enter: PAD.CROSS,
  ' ': PAD.CROSS,
  o: PAD.CIRCLE,
  Escape: PAD.CIRCLE,
  Backspace: PAD.CIRCLE,
  t: PAD.TRIANGLE,
  s: PAD.SQUARE,
  q: PAD.L,
  PageUp: PAD.L,
  e: PAD.R,
  PageDown: PAD.R,
}

const STATE_NAMES: Record<number, string> = {
  0: 'init',
  1: 'loading',
  2: 'deck grid',
  3: 'count popup (deck)',
  4: 'collection grid',
  5: 'count popup (collection)',
  6: 'card details (open)',
  7: 'card details',
  8: 'save / cancel prompt',
  9: 'name entry',
  10: 'save',
  11: 'exit',
}

/** Decoded GBP members per loaded archive set. */
const imageCache = new WeakMap<OneArchive[], Map<string, RgbaImage | null>>()

function toCanvas(img: RgbaImage | null): Img | null {
  if (!img) return null
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  const rgba = new Uint8ClampedArray(img.rgba)
  // GE alpha test (alpha > 0x28), as CardScreenView does
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] <= 40) rgba[i] = 0
  c.getContext('2d')!.putImageData(new ImageData(rgba, img.width, img.height), 0, 0)
  return c
}

/** The starter deck New Game gives the player (dbGetDeckByDominator(1001, …, 1)): the first deck of Galahad. */
function starterDecks(db: GameDb): DeckData[] {
  const g = db.decks.filter((d) => d.dominator === 1001)
  const deck = (i: number): DeckData => (g[i] ? { name: g[i].name, dominator: 1001, cards: [...g[i].cards] } : { name: '', dominator: 0, cards: [] })
  return [deck(0), deck(1), { name: '', dominator: 0, cards: [] }]
}

function sampleCollection(db: GameDb, source: Source, save: SaveFile | null, slot: number, sampleNew: boolean): Collection {
  if (source === 'save' && save) {
    return {
      owned: [...save.profile.cardCount],
      newFlags: [...save.profile.newFlags],
      decks: save.decks.map((d) => ({ name: d.name, dominator: d.dominator, cards: [...d.cards] })),
      slot,
    }
  }
  const decks = starterDecks(db)
  const owned = new Array(CARD_NOS + 1).fill(0)
  const byId = new Map(db.cards.map((c) => [c.id, c.no]))
  if (source === 'all3') for (let i = 1; i <= CARD_NOS; i++) owned[i] = 3
  else for (const id of decks[0].cards) if (id > 0) owned[byId.get(id) ?? 0]++
  owned[0] = 0
  // Viewer sample: a few "New" (bit 1) and "Get" (bit 0) markers so the badges show.
  const newFlags = new Array(CARD_NOS + 1).fill(0)
  if (sampleNew) for (let i = 1; i <= CARD_NOS; i++) if (owned[i]) newFlags[i] = i % 11 === 0 ? 2 : i % 7 === 0 ? 1 : 0
  return { owned, newFlags, decks, slot }
}

/**
 * The deck editor (deckEditScene) and card list (cardListScene) as the game draws them, 480×272 at 2×,
 * driven by the keyboard like the PSP pad. The scene logic runs in DeckEditorSim, the drawing in
 * DeckEditorRenderer (WebGL, with the WindowPainter windows); the card details viewer is
 * CardScreenRenderer on a canvas stacked on top.
 */
export function DeckEditorView({ db, archives, loadFont }: Props) {
  const [font, setFont] = useState<Uint8Array | null>(null)
  const [mode, setMode] = useState(MODE_DECK)
  const [source, setSource] = useState<Source>('all3')
  const [save, setSave] = useState<SaveFile | null>(null)
  const [saveName, setSaveName] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [slot, setSlot] = useState(1)
  const [sampleNew, setSampleNew] = useState(true)
  const [restart, setRestart] = useState(0)
  // sndPlaySeUi calls of deckEditScene / cardListScene / cardInfoUpdate (se.dat through the SAS model)
  const [sound, setSound] = useState(false)
  const soundRef = useRef(sound)
  useEffect(() => {
    soundRef.current = sound
  }, [sound])
  const [glError, setGlError] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [log, setLog] = useState<string[]>([])

  useEffect(() => {
    let live = true
    loadFont?.().then((f) => live && setFont(f))
    return () => {
      live = false
    }
  }, [loadFont])

  const image = useCallback(
    (archive: string, entry: number, member: number): RgbaImage | null => {
      let images = imageCache.get(archives)
      if (!images) imageCache.set(archives, (images = new Map()))
      const key = `${archive}:${entry}:${member}`
      if (images.has(key)) return images.get(key)!
      const a = archives.find((x) => x.name.toLowerCase() === archive)
      const f = a?.entries.find((e) => e.id === entry)?.files.find((x) => x.subId === member)
      const img = f?.data.length && f.kind === 'gbp' ? gbpToImage(parseGbp(f.data)) : null
      images.set(key, img)
      return img
    },
    [archives],
  )

  const winTables = useMemo(() => readWinTables(db), [db])
  const tables = useMemo(() => readDeckEditorTables(db), [db])
  const painter = useMemo(() => new WindowPainter({ skins: loadWinSkins(image), font, tables: winTables }), [image, font, winTables])
  const renderer = useMemo(
    () =>
      new DeckEditorRenderer(
        {
          // deckEditScene loads etc.one 300/1, cardListScene 300/7 (the same sheet with "Number" on the panel)
          frame: image('etc.one', 300, mode === MODE_DECK ? 1 : 7),
          tabs: image('etc.one', 300, 5),
          digits: image('etc.one', 2, 1),
          hand: image('etc.one', 2, 2),
          badge: image('etc.one', 2, 3),
          ui: image('etc.one', 2, 4),
          cardPic: (id) => image('card.one', 10000, id || 1000),
          font,
          fontPalettes: winTables.fontPalettes,
        },
        tables,
        painter,
      ),
    [image, mode, font, winTables, tables, painter],
  )

  // The card info viewer on top (cardInfoDrawCard): common sprites once, the card's own on demand.
  const csTables = useMemo(() => readCardScreenTables(db), [db])
  const csCommon = useMemo(
    () => ({
      digits: toCanvas(image('etc.one', 2, 1)),
      hand: toCanvas(image('etc.one', 2, 2)),
      ui: toCanvas(image('etc.one', 2, 4)),
      frame: toCanvas(image('etc.one', 2, 5)),
      icons: toCanvas(image('etc.one', 1, 11)),
    }),
    [image],
  )
  const csCache = useRef(new Map<number, CardScreenRenderer>())
  useEffect(() => {
    csCache.current = new Map()
  }, [csCommon, font, archives])
  const cardScreen = useCallback(
    (id: number): CardScreenRenderer => {
      let r = csCache.current.get(id)
      if (!r) {
        const a = archives.find((x) => x.name.toLowerCase() === 'card.one')
        const ganFile = id < 1000 ? a?.entries.find((e) => e.id === id)?.files.find((f) => f.subId === null) : undefined
        let gan: CardScreenAssets['gan'] = null
        if (ganFile?.kind === 'gan') {
          const g = parseGan(ganFile.data)
          gan = { gan: g, sheets: ganSheetCache(g) }
        }
        const assets: CardScreenAssets = {
          ...csCommon,
          font,
          preview: toCanvas(image('unit.one', id, 3)),
          attachments: [],
          gan,
          token: id > 2999 ? toCanvas(image('card.one', 10010, id)) : null,
        }
        r = new CardScreenRenderer(db, csTables, assets)
        csCache.current.set(id, r)
      }
      return r
    },
    [archives, csCommon, font, image, db, csTables],
  )

  const collection = useMemo(() => sampleCollection(db, source, save, slot, sampleNew), [db, source, save, slot, sampleNew])
  const simRef = useRef<DeckEditorSim | null>(null)
  useEffect(() => {
    // A fresh scene: the collection copy is owned by the sim (a saved deck replaces its slot).
    simRef.current = new DeckEditorSim(db, tables, structuredClone(collection), mode)
  }, [db, tables, collection, mode, restart])

  const glRef = useRef<GlRenderer | null>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const queue = useRef<{ bit: number; repeat: boolean }[]>([])
  const rendererRef = useRef(renderer)
  const cardScreenRef = useRef(cardScreen)
  useEffect(() => {
    rendererRef.current = renderer
    cardScreenRef.current = cardScreen
  }, [renderer, cardScreen])

  const initCanvas = useCallback((c: HTMLCanvasElement | null) => {
    if (!c || glRef.current?.canvas === c) return
    try {
      glRef.current = new GlRenderer(c, VIRTUAL_W, VIRTUAL_H)
    } catch (e) {
      setGlError((e as Error).message)
    }
  }, [])

  // 60 Hz: uiAnimCounter(0), one scene frame with the pad state, then the draw calls.
  useEffect(() => {
    const clock = new UiClock()
    const csClock = new CardScreenClock()
    let raf = 0, last = performance.now(), acc = FRAME_MS, ui = 0
    const step = () => {
      const sim = simRef.current
      const gl = glRef.current
      if (!sim || !gl) return
      const ev = queue.current.shift()
      const pressed = ev && !ev.repeat ? ev.bit : 0
      const repeat = ev ? ev.bit : 0
      clock.tick()
      csClock.tick()
      sim.frame(pressed, repeat)
      if (soundRef.current) for (const id of sim.se) playUiSe(id)
      if (sim.events.length) {
        const msgs = sim.events.map((e) => (e === 'saved' ? `deck ${sim.slot} saved (${sim.deck.cards.filter((c) => c > 0).length} cards)` : e === 'exit' ? 'the game returns to the camp menu here; the viewer restarts the scene' : 'the game asks for a deck name here (name entry); the viewer uses "Deck N"'))
        setLog((l) => [...l.slice(-4), ...msgs])
      }
      const info = rendererRef.current.draw(gl, sim, db, clock)
      const ov = overlayRef.current?.getContext('2d')
      if (ov) {
        ov.setTransform(1, 0, 0, 1, 0, 0)
        ov.clearRect(0, 0, 480, 272)
        const card = info ? db.byId.get(info) : undefined
        if (card) {
          const st: CardScreenState = {
            card, mode: 3, tab: sim.infoTab, cursor: -1, base: [card.ap, card.hp, card.range, card.move, card.attribute], eff: [0, 0, 0, 0, 0], showDf: false, attachments: [],
          }
          cardScreenRef.current(card.id).draw(ov, st, csClock, false)
        }
      }
      if (++ui % 6 === 0) {
        const total = sim.deckTotal()
        setStatus(
          `state ${sim.state} (${STATE_NAMES[sim.state] ?? '?'}) · view ${sim.view} · filter ${sim.filter} · cursor ${sim.cursorCol},${sim.cursorRow}` +
            (sim.mode === MODE_DECK ? ` · deck ${total} cards (30 to save, 42 max)` : ''),
        )
      }
    }
    const loop = (t: number) => {
      acc += Math.min(t - last, 100)
      last = t
      let n = 0
      while (acc >= FRAME_MS && n < 4) {
        step()
        acc -= FRAME_MS
        n++
      }
      if (n === 4) acc = 0
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [db])

  const push = (bit: number, repeat = false) => {
    if (queue.current.length < 8) queue.current.push({ bit, repeat })
  }
  const onKey = (e: KeyboardEvent) => {
    const bit = KEYS[e.key] ?? KEYS[e.key.toLowerCase()]
    if (!bit) return
    e.preventDefault()
    push(bit, e.repeat)
  }

  /** Viewer only: a click on a grid cell moves the cursor there; a click on the cursor cell is ✕. */
  const onClick = (e: MouseEvent<HTMLCanvasElement>) => {
    const sim = simRef.current
    if (!sim) return
    e.currentTarget.parentElement?.focus()
    const r = e.currentTarget.getBoundingClientRect()
    const vx = ((e.clientX - r.left) / r.width) * 640, vy = ((e.clientY - r.top) / r.height) * 448
    const gridState = sim.mode === MODE_DECK ? sim.state === 2 || sim.state === 4 : sim.state === 4
    if (!gridState) return
    const cell = rendererRef.current.cellAt(sim, vx, vy)
    if (!cell) return
    if (cell.col === sim.cursorCol && cell.row === sim.cursorRow) {
      push(PAD.CROSS)
      return
    }
    if (sim.view === 1) {
      if (cell.row > 6) return
    } else if (sim.mode === MODE_DECK) {
      if (sim.gridPosToCardNo(cell.col + cell.row * 10, sim.filter) === 0) return
    } else if (cell.col + cell.row * 10 > 0xcd) return
    sim.cursorCol = cell.col
    sim.cursorRow = cell.row
  }

  const exportDeck = () => {
    const sim = simRef.current
    if (!sim) return
    const cards = sim.editedCards()
    const json = JSON.stringify(
      {
        slot: sim.slot,
        name: sim.deck.name,
        dominator: sim.deck.dominator || 1001,
        count: cards.length,
        cards: cards.map((id) => ({ id, name: db.byId.get(id)?.name ?? '' })),
        savedDecks: sim.col.decks,
      },
      null,
      1,
    )
    download(new TextEncoder().encode(json), `ncb_deck${sim.slot}.json`, 'application/json')
  }

  const onSaveFile = async (f: File | undefined) => {
    if (!f) return
    try {
      const s = parseSave(new Uint8Array(await f.arrayBuffer()))
      setSave(s)
      setSaveName(f.name)
      setSaveError(null)
      setSource('save')
      setSlot(Math.min(3, Math.max(1, s.profile.curDeckSlot || 1)))
    } catch (err) {
      setSaveError((err as Error).message)
    }
  }

  const btn = (label: string, bit: number, title: string) => (
    <button key={label} onClick={() => push(bit)} title={title}>
      {label}
    </button>
  )
  const missing = [!image('etc.one', 300, 1) && 'etc.one', !image('card.one', 10000, 1000) && 'card.one', !image('option.one', 20, 8) && 'option.one', !image('unit.one', 1, 3) && 'unit.one', !font && 'gothic16.bin'].filter(Boolean)

  return (
    <div className="card-screen">
      <div className="toolbar">
        <div className="seg" role="group" aria-label="Scene">
          <button className={mode === MODE_DECK ? 'on' : ''} onClick={() => setMode(MODE_DECK)} title="deckEditScene (scene 0x140)">
            Deck editor
          </button>
          <button className={mode === MODE_LIST ? 'on' : ''} onClick={() => setMode(MODE_LIST)} title="cardListScene (scene 0x14A)">
            Card list
          </button>
        </div>
        <label title="Sound effects (snd/se.dat) through the SAS voice model">
          <input type="checkbox" checked={sound} onChange={(e) => setSound(e.target.checked)} /> sound
        </label>
        <label>
          collection{' '}
          <select value={source} onChange={(e) => setSource(e.target.value as Source)}>
            <option value="all3">sample: every card ×3</option>
            <option value="starter">sample: new game (starter deck only)</option>
            <option value="save" disabled={!save}>
              save{saveName ? `: ${saveName}` : ' (load one)'}
            </option>
          </select>
        </label>
        <label title="A decrypted CADATA.SAV (0x494 or 0x287CC bytes)">
          load save <input type="file" onChange={(e) => onSaveFile(e.target.files?.[0])} />
        </label>
        {mode === MODE_DECK && (
          <label title="PlayerProfile.curDeckSlot">
            deck{' '}
            <select value={slot} onChange={(e) => setSlot(Number(e.target.value))}>
              {[1, 2, 3].map((i) => (
                <option key={i} value={i}>
                  {i}: {collection.decks[i - 1]?.name || '(empty)'}
                </option>
              ))}
            </select>
          </label>
        )}
        {source !== 'save' && (
          <label title="Viewer sample: mark some cards New (bit 1) / Get (bit 0)">
            <input type="checkbox" checked={sampleNew} onChange={(e) => setSampleNew(e.target.checked)} /> sample NEW flags
          </label>
        )}
        <button onClick={() => { setRestart((n) => n + 1); setLog([]) }} title="Restart the scene (state 0)">
          Restart
        </button>
        {mode === MODE_DECK && (
          <button onClick={exportDeck} title="The deck being edited, as JSON">
            Export deck JSON
          </button>
        )}
      </div>
      {saveError && <p className="warn">{saveError}</p>}
      {glError ? (
        <p className="warn">{glError}</p>
      ) : (
        <div tabIndex={0} onKeyDown={onKey} style={{ position: 'relative', width: 960, maxWidth: '100%', outline: 'none' }} className="deck-editor-screen">
          <canvas ref={initCanvas} width={480} height={272} className="card-screen-canvas" onClick={onClick} />
          <canvas ref={overlayRef} width={480} height={272} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', imageRendering: 'pixelated', pointerEvents: 'none' }} />
        </div>
      )}
      <div className="card-screen-controls">
        {btn('↑', PAD.UP, 'Up (↑)')}
        {btn('↓', PAD.DOWN, 'Down (↓)')}
        {btn('←', PAD.LEFT, 'Left (←)')}
        {btn('→', PAD.RIGHT, 'Right (→)')}
        {btn('✕', PAD.CROSS, 'Cross: X / Enter / Space')}
        {btn('○', PAD.CIRCLE, 'Circle: O / Esc / Backspace')}
        {btn('△', PAD.TRIANGLE, 'Triangle: T')}
        {btn('□', PAD.SQUARE, 'Square: S')}
        {btn('L', PAD.L, 'L: Q / PageUp')}
        {btn('R', PAD.R, 'R: E / PageDown')}
        <span className="muted">{status}</span>
      </div>
      <p className="muted">
        Click the screen, then: arrows = D-pad · X / Enter / Space = ✕ · O / Esc / Backspace = ○ · T = △ · S = □ · Q / PageUp = L · E / PageDown = R.
        {mode === MODE_DECK
          ? ' ✕ opens the count popup (↑/↓ change, ✕ decide, ○ cancel), △ card details (←/→ tabs, L/R previous/next card), □ switches Deck ↔ Album, L/R change the Album filter, ○ ends (save prompt).'
          : ' ✕ or △ opens card details (L/R previous/next owned card), ○ returns to the camp.'}{' '}
        A click on a card moves the cursor; a click on the card under the cursor is ✕ (viewer convenience).
        {missing.length > 0 && ` Load ${missing.join(', ')} for the full screen.`}
      </p>
      {log.length > 0 && (
        <ul className="muted">
          {log.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
