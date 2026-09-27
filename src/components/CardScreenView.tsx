import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  allowedTabs,
  CardScreenClock,
  CardScreenRenderer,
  readCardScreenTables,
  SCREEN_H,
  SCREEN_W,
  stepCursor,
  stepTab,
  tabAt,
  TAB_ATTACH,
  TAB_LABELS,
  type CardScreenAssets,
  type CardScreenState,
  type Img,
} from '../effect/cardScreen'
import { ganSheetCache } from '../export'
import { spellAttachment, type Card, type GameDb } from '../formats/gamedb'
import { parseGan } from '../formats/gan'
import { gbpToImage, parseGbp } from '../formats/gbp'
import type { OneArchive } from '../formats/one'

interface Props {
  db: GameDb
  archives: OneArchive[]
  card: Card
  loadFont?: () => Promise<Uint8Array | null>
  /** Position of `card` in the (filtered) card list and a callback to move to the previous/next one. */
  nav?: { index: number; count: number; onStep: (dir: -1 | 1) => void }
}

const FRAME_MS = 1000 / 60

function member(archives: OneArchive[], name: string, entry: number, sub: number | null) {
  const a = archives.find((x) => x.name.toLowerCase() === name)
  return a?.entries.find((e) => e.id === entry)?.files.find((f) => f.subId === sub)
}

/** A GBP member as a canvas, with the GE alpha test (alpha > 0x28) applied. */
function gbpCanvas(archives: OneArchive[], name: string, entry: number, sub: number | null): Img | null {
  const f = member(archives, name, entry, sub)
  if (!f || f.kind !== 'gbp') return null
  const img = gbpToImage(parseGbp(f.data))
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  const rgba = new Uint8ClampedArray(img.rgba)
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] <= 40) rgba[i] = 0
  c.getContext('2d')!.putImageData(new ImageData(rgba, img.width, img.height), 0, 0)
  return c
}

/**
 * The game's card info screen (cardInfoDraw and its tabs), 480×272 shown at 2×. Card list mode is
 * cardInfoDrawCard (deck editor / card list, zero effective stats); map-unit mode is cardInfoDrawUnit
 * with a sample unit whose stats and attachments can be edited.
 */
export function CardScreenView({ db, archives, card, loadFont, nav }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [font, setFont] = useState<Uint8Array | null>(null)
  const [mode, setMode] = useState<1 | 3>(3)
  const [tab, setTab] = useState(1)
  const [cursor, setCursor] = useState(-1)
  const [attachments, setAttachments] = useState<number[]>([0, 0, 0, 0, 0, 0])
  const [unitHp, setUnitHp] = useState<number | null>(null)
  const [unitDf, setUnitDf] = useState(0)
  const [unitAp, setUnitAp] = useState<number | null>(null)
  const [unitMove, setUnitMove] = useState<number | null>(null)

  useEffect(() => {
    let live = true
    loadFont?.().then((f) => live && setFont(f))
    return () => {
      live = false
    }
  }, [loadFont])

  const allowed = allowedTabs(card.id, mode)
  // Like cardInfoUpdate: a new card restarts the viewer (cursor off) and the tab is moved to an allowed one.
  const [shown, setShown] = useState({ id: card.id, mode })
  if (shown.id !== card.id || shown.mode !== mode) {
    setShown({ id: card.id, mode })
    setCursor(-1)
    setTab((t) => stepTab(t, 0, allowed))
    setUnitHp(null)
    setUnitAp(null)
    setUnitMove(null)
  }
  const curTab = tab & allowed ? tab : stepTab(tab, 0, allowed)

  const tables = useMemo(() => readCardScreenTables(db), [db])
  const common = useMemo(
    () => ({
      digits: gbpCanvas(archives, 'etc.one', 2, 1),
      hand: gbpCanvas(archives, 'etc.one', 2, 2),
      ui: gbpCanvas(archives, 'etc.one', 2, 4),
      frame: gbpCanvas(archives, 'etc.one', 2, 5),
      icons: gbpCanvas(archives, 'etc.one', 1, 11),
    }),
    [archives],
  )
  const cardAssets = useMemo(() => {
    const ganFile = card.id < 1000 ? member(archives, 'card.one', card.id, null) : undefined
    let gan: CardScreenAssets['gan'] = null
    if (ganFile?.kind === 'gan') {
      const g = parseGan(ganFile.data)
      gan = { gan: g, sheets: ganSheetCache(g) }
    }
    return {
      preview: gbpCanvas(archives, 'unit.one', card.id, 3),
      gan,
      token: card.id > 2999 ? gbpCanvas(archives, 'card.one', 10010, card.id) : null,
    }
  }, [archives, card.id])
  const attachImages = useMemo(() => attachments.map((id) => gbpCanvas(archives, 'unit.one', id || 1000, 2)), [archives, attachments])

  const renderer = useMemo(
    () => new CardScreenRenderer(db, tables, { ...common, ...cardAssets, attachments: attachImages, font }),
    [db, tables, common, cardAssets, attachImages, font],
  )

  const hp = unitHp ?? card.hp
  const state: CardScreenState = useMemo(() => {
    if (mode === 3) {
      // cardInfoDrawCard: base = {AP, HP, Range, Move, Attr} from the CardDef, effective stats zero.
      return { card, mode, tab: curTab, cursor: -1, base: [card.ap, card.hp, card.range, card.move, card.attribute], eff: [0, 0, 0, 0, 0], showDf: false, attachments }
    }
    // cardInfoDrawUnit, mode 1: base = {0, current HP, 0, 0, 0}; effective = the unit's AP/DF/Range/Move/Attr
    // (left zero for bases).
    const isBase = Math.trunc(card.id / 1000) === 3
    const eff = isBase ? [0, 0, 0, 0, 0] : [unitAp ?? card.ap, unitDf, card.range, unitMove ?? card.move, card.attribute]
    return { card, mode, tab: curTab, cursor, base: [0, hp, 0, 0, 0], eff, showDf: true, attachments }
  }, [card, mode, curTab, cursor, attachments, hp, unitAp, unitDf, unitMove])

  const stateRef = useRef(state)
  const rendererRef = useRef(renderer)
  const clockRef = useRef<CardScreenClock | null>(null)
  useEffect(() => {
    stateRef.current = state
    rendererRef.current = renderer
    // Draw right away too, so a change shows even while animation frames are paused (hidden tab).
    const ctx = canvasRef.current?.getContext('2d')
    if (ctx && clockRef.current) renderer.draw(ctx, state, clockRef.current)
  }, [state, renderer])

  // 60 Hz: uiAnimCounter(0) and one draw per game frame (the star blink and GAN advance inside the draw).
  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return
    const clock = new CardScreenClock()
    clockRef.current = clock
    rendererRef.current.draw(ctx, stateRef.current, clock)
    let raf = 0
    let last = performance.now()
    let acc = FRAME_MS
    const loop = (t: number) => {
      acc += Math.min(t - last, 100)
      last = t
      let steps = 0
      while (acc >= FRAME_MS && steps < 4) {
        clock.tick()
        rendererRef.current.draw(ctx, stateRef.current, clock)
        acc -= FRAME_MS
        steps++
      }
      if (steps === 4) acc = 0
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  const onKey = (e: KeyboardEvent) => {
    const k = e.key
    if (cursor >= 0) {
      const dir = k === 'ArrowLeft' ? 'left' : k === 'ArrowRight' ? 'right' : k === 'ArrowUp' ? 'up' : k === 'ArrowDown' ? 'down' : null
      if (dir) setCursor((c) => stepCursor(c, dir))
      else if (k === 'Escape' || k === 'Backspace' || k === 'o') setCursor(-1)
      else return
    } else if (nav && (k === 'ArrowUp' || k === 'ArrowDown' || k === 'PageUp' || k === 'PageDown')) nav.onStep(k === 'ArrowUp' || k === 'PageUp' ? -1 : 1)
    else if (k === 'ArrowLeft' || k === 'ArrowRight') setTab(stepTab(curTab, k === 'ArrowLeft' ? -1 : 1, allowed))
    else if ((k === 'Enter' || k === ' ' || k === 'x') && curTab === TAB_ATTACH) setCursor(0)
    else return
    e.preventDefault()
  }

  // Viewer only: the tabs drawn on the canvas are clickable (hover shows a pointer).
  const [hoverTab, setHoverTab] = useState(0)
  const tabFromMouse = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const x = ((e.clientX - r.left) * SCREEN_W) / r.width
    const y = ((e.clientY - r.top) * SCREEN_H) / r.height
    return tabAt(tables, card.id, mode, x, y)
  }
  const onCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const t = tabFromMouse(e)
    if (t) {
      setTab(t)
      setCursor(-1)
    }
  }

  const attachable = useMemo(() => db.cards.filter(spellAttachment).sort((a, b) => a.no - b.no), [db])
  const missing = [
    !common.ui && 'etc.one',
    !cardAssets.preview && 'unit.one',
    card.id < 1000 && !cardAssets.gan && 'card.one',
    !font && 'gothic16.bin',
  ].filter(Boolean)

  return (
    <div className="card-screen">
      <canvas
        ref={canvasRef}
        width={SCREEN_W}
        height={SCREEN_H}
        tabIndex={0}
        onKeyDown={onKey}
        onClick={onCanvasClick}
        onMouseMove={(e) => {
          const t = tabFromMouse(e)
          if (t !== hoverTab) setHoverTab(t)
        }}
        onMouseLeave={() => setHoverTab(0)}
        style={{ cursor: hoverTab ? 'pointer' : undefined }}
        className="card-screen-canvas"
        title={`Left/Right: tabs · ${nav ? 'Up/Down: previous/next card · ' : ''}Enter: attachment cursor · Esc: back`}
      />
      {nav && (
        <div className="card-screen-nav">
          <button onClick={() => nav.onStep(-1)} disabled={nav.index <= 0} title="Previous card (Up)">
            ◀ Prev
          </button>
          <span>
            {nav.index + 1} / {nav.count} · <b>{card.name}</b> <span className="muted">#{card.id}</span>
          </span>
          <button onClick={() => nav.onStep(1)} disabled={nav.index >= nav.count - 1} title="Next card (Down)">
            Next ▶
          </button>
        </div>
      )}
      <div className="card-screen-controls">
        <div className="seg" role="group" aria-label="Viewer mode">
          <button className={mode === 3 ? 'on' : ''} onClick={() => setMode(3)} title="cardInfoDrawCard (deck editor, card list)">
            Card list
          </button>
          <button className={mode === 1 ? 'on' : ''} onClick={() => setMode(1)} title="cardInfoDrawUnit (a unit on the map)">
            Map unit
          </button>
        </div>
        <div className="seg" role="tablist" aria-label="Tab">
          {[1, 2, 4, 8]
            .filter((b) => b & allowed)
            .map((b) => (
              <button key={b} className={curTab === b ? 'on' : ''} onClick={() => { setTab(b); setCursor(-1) }}>
                {TAB_LABELS[b]}
              </button>
            ))}
        </div>
        {missing.length > 0 && <span className="muted">Load {missing.join(', ')} for the full screen.</span>}
      </div>
      {mode === 1 && (
        <div className="card-screen-controls">
          {Math.trunc(card.id / 1000) !== 2 && (
            <label>
              HP <input type="number" min={0} max={99} value={hp} onChange={(e) => setUnitHp(Number(e.target.value) || 0)} />
            </label>
          )}
          {card.id < 2000 && (
            <>
              <label>
                AP <input type="number" min={0} max={99} value={unitAp ?? card.ap} onChange={(e) => setUnitAp(Number(e.target.value) || 0)} />
              </label>
              <label>
                DF <input type="number" min={0} max={99} value={unitDf} onChange={(e) => setUnitDf(Number(e.target.value) || 0)} />
              </label>
              <label>
                Move <input type="number" min={0} max={99} value={unitMove ?? card.move} onChange={(e) => setUnitMove(Number(e.target.value) || 0)} />
              </label>
            </>
          )}
        </div>
      )}
      {mode === 1 && card.id < 2000 && (
        <div className="card-screen-controls">
          <span className="muted">Attachments:</span>
          {attachments.map((id, i) => (
            <select
              key={i}
              value={id}
              onChange={(e) => {
                const v = Number(e.target.value)
                setAttachments((a) => a.map((x, j) => (j === i ? v : x)))
                setTab(TAB_ATTACH)
                setCursor(i)
              }}
            >
              <option value={0}>{i + 1}: (empty)</option>
              {attachable.map((c) => (
                <option key={c.id} value={c.id}>
                  {i + 1}: {c.name}
                </option>
              ))}
            </select>
          ))}
        </div>
      )}
    </div>
  )
}
