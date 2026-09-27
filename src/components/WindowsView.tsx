import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { GlRenderer, type Vertex } from '../effect/gl'
import { VIRTUAL_H, VIRTUAL_W } from '../effect/scene'
import {
  asciiMarkup,
  loadWinSkins,
  readWinTables,
  WF_CENTER_X,
  WF_CENTER_Y,
  WF_DIVIDERS,
  WF_FACE_NO_SHIFT,
  WF_MENU,
  WF_POINTER,
  WF_SCROLLBAR,
  WIN_CURSOR_COLORS,
  WIN_SKIN_ROLES,
  WIN_SKIN_SOURCES,
  windowLayout,
  WindowPainter,
  type DuelWindow,
} from '../effect/windows'
import type { GameDb } from '../formats/gamedb'
import { gbpToImage, parseGbp } from '../formats/gbp'
import type { OneArchive } from '../formats/one'
import type { RgbaImage } from '../formats/palette'

interface Props {
  db: GameDb
  archives: OneArchive[]
  loadFont?: () => Promise<Uint8Array | null>
}

/** Where the game uses each style (docs/formats/windows.md). */
const STYLE_NAMES: string[] = [
  '0 · none (face only)',
  '1 · fill only',
  '2 · outlined (unused)',
  '3 · skin 0 frame (unused)',
  '4 · skin 1 frame (unused)',
  '5 · band with caps (unused)',
  '6 · speech bubble (unused)',
  '7 · menu frame',
  '8 · radar hexagon (unused)',
  '9 · bars (unused)',
  '10 · framed',
  '11 · framed, cell 2 (unused)',
  '12 · framed, filled centre (unused)',
  '13 · framed, cell 4 (unused)',
]

interface Spec {
  style: number
  x: number
  y: number
  w: number
  h: number
  chamfer: number
  pointX: number
  pointY: number
  tailIdx: number
  text: string
  glyph: number
  textColor: number
  typeDelay: number
  arrow: boolean
  alpha: number
  bright: number
  face: number
  expr: number
  flags: number
  menuRow: number
  items: number
  scrollTop: number
  number: number | null
  numberSign: boolean
  hexValues: number[]
  hexDeltas: number[]
  hexHold: boolean
  bars: { count: number; target: number; period: number; gap: number }
}

const BASE: Spec = {
  style: 10, x: 40, y: 300, w: 560, h: 110, chamfer: 5, pointX: 320, pointY: 100, tailIdx: 0,
  text: 'The quick brown fox@njumps over the lazy dog.', glyph: 22, textColor: 0, typeDelay: 4, arrow: true,
  alpha: 128, bright: 128, face: 0, expr: 1, flags: 0, menuRow: 0, items: 6, scrollTop: 0, number: null, numberSign: false,
  hexValues: [32, 24, 18, 36, 22, 14], hexDeltas: [6, 4, 8, 0, 5, 3], hexHold: true,
  bars: { count: 0, target: 10, period: 6, gap: 6 },
}

/** Presets built from windows the game opens (positions from the calling code where known). */
const PRESETS: [string, Partial<Spec>][] = [
  ['Story: speaker text (style 10)', { style: 10, x: 168, y: 82, w: 464, h: 110, text: 'Galahad, look! The castle gates@nare open at last.', glyph: 22 }],
  ['Story: face panel (style 10, chamfer 16)', { style: 10, x: 8, y: 32, w: 160, h: 160, chamfer: 16, text: '', face: 1001, arrow: false }],
  ['Story: narrator (style 1, chamfer 0)', { style: 1, x: 0, y: 318, w: 640, h: 130, chamfer: 0, text: 'Long ago, in the land of Neverland...', arrow: false }],
  ['Help window with tail 4 (deckUpdateHelpWin)', { style: 10, x: 0, y: 0, w: 277, h: 68, chamfer: 16, tailIdx: 4, text: '@b0Accept @b3Cancel', glyph: 20, typeDelay: 0, arrow: false }],
  ['Message with tail 1 (spell target)', { style: 10, x: 179, y: 176, w: 283, h: 96, chamfer: 16, tailIdx: 1, text: 'Select a target.@n@b0Accept @b3Cancel', glyph: 20, typeDelay: 0, arrow: false }],
  ['Name-entry help (＠ｂ icons 0–11)', { style: 10, x: 8, y: 250, w: 624, h: 110, text: '@b0Enter @b2Delete @b1Return @b11Accept @n@b7Move cursor left @n@b9Move cursor right ', glyph: 20, typeDelay: 0, arrow: false }],
  ['Card screen tabs (＠ｐ animated icons)', { style: 10, x: 40, y: 200, w: 420, h: 80, text: '@p13@p14Basic powers @n@p11@p12Change ', glyph: 20, typeDelay: 0, arrow: false }],
  ['Attribute icons (＠ｍ0–12)', { style: 10, x: 20, y: 200, w: 600, h: 60, text: '@m0@m1@m2@m3@m4@m5@m6@m7@m8@m9@m10@m11@m12', glyph: 20, typeDelay: 0, arrow: false }],
  ['＠ｅ icon sheet (skin 9, 49 icons; no text uses it)', { style: 10, x: 20, y: 120, w: 600, h: 200, text: '@e0@e1@e2@e3@e4@e5@e6@e7@e8@e9@e10@e11@e12@e13@e14@e15@e16@n@e17@e18@e19@e20@e21@e22@e23@e24@e25@e26@e27@e28@e29@e30@e31@e32@n@e33@e34@e35@e36@e37@e38@e39@e40@e41@e42@e43@e44@e45@e46@e47@e48', glyph: 20, typeDelay: 0, arrow: false }],
  ['Camp frame (style 7, campMenuOpenState)', { style: 7, x: 16, y: 0, w: 251, h: 146, text: 'Deck 1@nCards 30', glyph: 20, typeDelay: 0, arrow: false }],
  ['Menu (style 7, cursor bar, pointer, scroll bar)', { style: 7, x: 200, y: 100, w: 240, h: 150, text: 'New game@nContinue@nBattle mode@nOptions@nCredits@nQuit', glyph: 20, typeDelay: 0, arrow: false, flags: WF_MENU | WF_POINTER | WF_SCROLLBAR, items: 9, scrollTop: 1 }],
  ['List with counts (style 7, winPrintNumber style 3)', { style: 7, x: 200, y: 120, w: 240, h: 60, text: 'Gold', glyph: 20, typeDelay: 0, arrow: false, number: 1234, flags: 0 }],
  ['Dividers (style 7, flag 8)', { style: 7, x: 120, y: 120, w: 400, h: 200, text: '', arrow: false, flags: WF_DIVIDERS, pointX: 160, pointY: 60 }],
  ['Speech bubble (style 6)', { style: 6, x: 180, y: 140, w: 300, h: 90, chamfer: 12, pointX: 120, pointY: 360, textColor: 7, text: 'Over here!', glyph: 22 }],
  ['Radar hexagon (style 8)', { style: 8, x: 320, y: 224, w: 0, h: 0, chamfer: 3, text: '', arrow: false }],
  ['Bars (style 9)', { style: 9, x: 120, y: 200, w: 24, h: 40, text: '', arrow: false, bars: { count: 0, target: 12, period: 6, gap: 8 } }],
  ['Outlined (style 2)', { style: 2, x: 120, y: 150, w: 400, h: 120, chamfer: 12, arrow: false }],
  ['Skin 0 frame (style 3)', { style: 3, x: 120, y: 150, w: 400, h: 120 }],
  ['Skin 1 frame (style 4)', { style: 4, x: 120, y: 150, w: 400, h: 160 }],
  ['Band with caps (style 5)', { style: 5, x: 160, y: 200, w: 320, h: 30, text: 'Stage 1', arrow: false }],
  ['Framed variants (style 12)', { style: 12, x: 120, y: 150, w: 400, h: 120 }],
]

/** Decoded GBP members per loaded archive set. */
const imageCache = new WeakMap<OneArchive[], Map<string, RgbaImage | null>>()

const FACES = [1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1010, 1011]
const BACKGROUNDS: [string, number | null][] = [['black', null], ['grey', -1], ...Array.from({ length: 10 }, (_, i): [string, number] => [`story bg ${i + 1}`, i + 1])]

/** The window draw styles of menuWinUpdateAll with sample text, icons and digits (a viewer tool). */
export function WindowsView({ db, archives, loadFont }: Props) {
  const [font, setFont] = useState<Uint8Array | null>(null)
  const [spec, setSpec] = useState<Spec>({ ...BASE, ...PRESETS[0][1] })
  const [preset, setPreset] = useState(0)
  const [bg, setBg] = useState(0)
  const [lineMode, setLineMode] = useState<'ge' | 'intended'>('ge')
  const [marker, setMarker] = useState(true)
  const [glError, setGlError] = useState<string | null>(null)
  const [frameShown, setFrameShown] = useState(0)
  const glRef = useRef<GlRenderer | null>(null)
  const frameRef = useRef(0)
  const openedRef = useRef(0)
  const movedRef = useRef<number | undefined>(undefined)

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
  const skins = useMemo(() => loadWinSkins(image), [image])
  const tables = useMemo(() => readWinTables(db), [db])
  const painter = useMemo(() => new WindowPainter({ skins, font, tables, lineMode }), [skins, font, tables, lineMode])

  const text = useMemo(() => asciiMarkup(spec.text), [spec.text])
  const replay = () => {
    openedRef.current = frameRef.current
  }
  // Restart the typewriter whenever the text or the style changes.
  useEffect(replay, [text, spec.style, spec.typeDelay, spec.glyph, preset])

  const win = useMemo((): DuelWindow => {
    const s = spec
    const face = s.face ? image('chara.one', s.face, s.expr) : null
    return {
      x: s.x, y: s.y, w: s.w, h: s.h, codes: [], text, opened: 0, style: s.style, chamfer: s.chamfer,
      pointX: s.pointX, pointY: s.pointY, tailIdx: s.tailIdx, glyph: s.glyph, textColor: s.textColor, typeDelay: s.typeDelay,
      arrow: s.arrow, alpha: s.alpha, bright: s.bright, face, flags: s.flags,
      menu: s.flags & WF_MENU ? { row: s.menuRow, color: WIN_CURSOR_COLORS[0], itemCount: s.items, visibleRows: Math.max(1, Math.trunc((s.h - 10) / s.glyph)), scrollTop: s.scrollTop } : undefined,
      numbers: s.number !== null ? [{ x: s.w - 20, y: 0, style: 3, sign: s.numberSign, attr: 0, maxDigits: 10, value: s.number }] : undefined,
      hexagon: { values: s.hexValues, deltas: s.hexDeltas, hold: s.hexHold },
      bars: { ...s.bars, color: WIN_CURSOR_COLORS[0] },
    }
  }, [spec, text, image])

  const draw = useCallback(() => {
    const gl = glRef.current
    if (!gl) return
    gl.depthTest = false
    const back = BACKGROUNDS[bg][1]
    gl.begin(back === -1 ? [0.35, 0.35, 0.4] : [0, 0, 0])
    if (back && back > 0) {
      const img = image('chara.one', 2000, back)
      if (img) {
        const V = (x: number, y: number, u: number, v: number): Vertex => ({ x, y, w: 1, d: 0.5, u, v })
        gl.triangles(gl.texture(img), 'alpha', [V(0, 0, 0, 0), V(640, 0, 1, 0), V(0, 448, 0, 1), V(640, 0, 1, 0), V(640, 448, 1, 1), V(0, 448, 0, 1)], [1, 1, 1, 1])
      }
    }
    const frame = frameRef.current
    const w = { ...win, opened: openedRef.current, menu: win.menu && { ...win.menu, movedAt: movedRef.current } }
    painter.draw(gl, w, frame)
    if (marker && (spec.style === 6 || (spec.style === 7 && spec.flags & WF_DIVIDERS) || spec.style === 8)) {
      // viewer marker: the tail target (style 6), the divider origin (7) or the centre (8)
      const [mx, my] = spec.style === 6 ? [spec.pointX, spec.pointY] : spec.style === 8 ? [spec.x, spec.y] : [spec.x + spec.pointX, spec.y + spec.pointY]
      const V = (x: number, y: number): Vertex => ({ x, y, w: 1, d: 0.5, u: 0, v: 0 })
      const r = 4
      gl.triangles(null, 'alpha', [V(mx - r, my - 1), V(mx + r, my - 1), V(mx - r, my + 1), V(mx + r, my - 1), V(mx + r, my + 1), V(mx - r, my + 1), V(mx - 1, my - r), V(mx + 1, my - r), V(mx - 1, my + r), V(mx + 1, my - r), V(mx + 1, my + r), V(mx - 1, my + r)], [1, 0.2, 0.2, 1])
    }
    gl.end()
  }, [win, painter, bg, image, marker, spec])

  const drawRef = useRef(draw)
  useEffect(() => {
    drawRef.current = draw
  }, [draw])

  useEffect(() => {
    let raf = 0, last = performance.now(), acc = 0, ui = 0
    const tick = (now: number) => {
      acc += ((now - last) / 1000) * 60
      last = now
      let n = 0
      while (acc >= 1 && n < 8) {
        acc -= 1
        n++
        frameRef.current++
      }
      if (acc > 8) acc = 0
      if (n) {
        drawRef.current()
        if (++ui % 15 === 0) setFrameShown(frameRef.current - openedRef.current)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const initCanvas = useCallback((c: HTMLCanvasElement | null) => {
    if (!c || glRef.current?.canvas === c) return
    try {
      glRef.current = new GlRenderer(c, VIRTUAL_W, VIRTUAL_H)
    } catch (e) {
      setGlError((e as Error).message)
    }
  }, [])

  const set = <K extends keyof Spec>(k: K, v: Spec[K]) => setSpec((s) => ({ ...s, [k]: v }))
  const num = (k: keyof Spec, label: string, min: number, max: number, title?: string) => (
    <label title={title}>
      {label} <input type="number" min={min} max={max} value={spec[k] as number} onChange={(e) => set(k, Number(e.target.value) as never)} />
    </label>
  )
  const flag = (bit: number, label: string, title: string) => (
    <label title={title}>
      <input type="checkbox" checked={(spec.flags & bit) !== 0} onChange={(e) => set('flags', e.target.checked ? spec.flags | bit : spec.flags & ~bit)} /> {label}
    </label>
  )

  /** Click: style 6 moves the tail target, style 7 the dividers, others the window. */
  const onCanvasClick = (e: MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const x = Math.round(((e.clientX - r.left) / r.width) * 640), y = Math.round(((e.clientY - r.top) / r.height) * 448)
    if (spec.style === 6) setSpec((s) => ({ ...s, pointX: x, pointY: y }))
    else if (spec.style === 7 && spec.flags & WF_DIVIDERS) setSpec((s) => ({ ...s, pointX: x - s.x, pointY: y - s.y }))
    else setSpec((s) => ({ ...s, x, y }))
  }

  const lay = windowLayout(win, tables)
  const loadedSkins = skins.map((s, i) => [i, s] as const)

  return (
    <div className="split">
      <div className="stage">
        <div className="toolbar">
          <select value={preset} onChange={(e) => {
            const i = Number(e.target.value)
            setPreset(i)
            setSpec({ ...BASE, ...PRESETS[i][1] })
          }}>
            {PRESETS.map(([l], i) => (
              <option key={i} value={i}>{l}</option>
            ))}
          </select>
          <button onClick={replay} title="Restart the typewriter and the glyph fade">Replay</button>
          <button
            onClick={() => {
              movedRef.current = frameRef.current
              setSpec((s) => ({ ...s, menuRow: (s.menuRow + 1) % Math.max(1, s.text.split('@n').length) }))
            }}
            disabled={!(spec.flags & WF_MENU)}
            title="Move the menu cursor (flag 0x400: 8-frame flash)"
          >
            Cursor ↓
          </button>
          <label>
            background{' '}
            <select value={bg} onChange={(e) => setBg(Number(e.target.value))}>
              {BACKGROUNDS.map(([l], i) => (
                <option key={i} value={i}>{l}</option>
              ))}
            </select>
          </label>
          <label title="Prim2D 'lines' (styles 2, 6, 8): the GE draws them as triangle strips to the origin; 'intended' draws 1-px lines instead">
            lines{' '}
            <select value={lineMode} onChange={(e) => setLineMode(e.target.value as 'ge' | 'intended')}>
              <option value="ge">as the GE draws them</option>
              <option value="intended">as intended (1 px)</option>
            </select>
          </label>
          <label>
            <input type="checkbox" checked={marker} onChange={(e) => setMarker(e.target.checked)} /> marker
          </label>
        </div>
        {glError ? <p className="warn">{glError}</p> : <canvas ref={initCanvas} width={960} height={544} className="effect-canvas" onClick={onCanvasClick} />}
        <p className="muted">
          frame {frameShown} since open · {lay.glyphs.length} glyphs · typing ends at frame {lay.end}
          {lay.style !== undefined ? ` · ＠ｔ sets style ${lay.style}` : ''} · auto size {lay.autoW}×{lay.autoH}
          {!font && ' · load gothic16.bin for text'}
          {' · click the canvas to move the window (style 6: the tail target; style 7 with dividers: the dividers)'}
        </p>
        <div className="win-controls">
          <label>
            style{' '}
            <select value={spec.style} onChange={(e) => set('style', Number(e.target.value))}>
              {STYLE_NAMES.map((l, i) => (
                <option key={i} value={i}>{l}</option>
              ))}
            </select>
          </label>
          {num('x', 'x', -640, 1280)}
          {num('y', 'y', -448, 896)}
          {num('w', 'w', 0, 1280)}
          {num('h', 'h', 0, 896)}
          {num('chamfer', 'chamfer', 0, 64, 'win+0x20: fill chamfer; style 8: pixels per value unit')}
          {num('pointX', 'pointX', -640, 1280, 'style 6: tail target (absolute); style 7: divider x (relative)')}
          {num('pointY', 'pointY', -448, 896)}
          {num('tailIdx', 'tail', 0, 10, 'styles 10/11: g_winTailRects index (skin 14)')}
          <label>
            alpha <input type="range" min={0} max={128} value={spec.alpha} onChange={(e) => set('alpha', Number(e.target.value))} /> {spec.alpha}
          </label>
          <label title="win+0x6E: dims frame, text and face (0x38 when not speaking)">
            brightness <input type="range" min={0} max={128} value={spec.bright} onChange={(e) => set('bright', Number(e.target.value))} /> {spec.bright}
          </label>
          <label>
            face{' '}
            <select value={spec.face} onChange={(e) => set('face', Number(e.target.value))}>
              <option value={0}>none</option>
              {FACES.map((id) => (
                <option key={id} value={id}>{db.byId.get(id)?.name ?? id}</option>
              ))}
            </select>
          </label>
          {spec.face ? num('expr', 'expression', 1, 6) : null}
          {flag(WF_FACE_NO_SHIFT, 'no face shift', 'flag 0x40000: without it a window with a face moves its text 100 px right')}
          {num('glyph', 'glyph', 8, 32, 'winOpenMessage glyphW = lineH')}
          {num('textColor', 'colour', 0, 15, 'font palette (＠ｃN)')}
          {num('typeDelay', 'type delay', 0, 30, 'frames per typewriter step (0 = all at once)')}
          <label>
            <input type="checkbox" checked={spec.arrow} onChange={(e) => set('arrow', e.target.checked)} /> next arrow
          </label>
          {flag(WF_MENU, 'menu', 'flag 0x4: cursor bar instead of the next arrow')}
          {flag(WF_POINTER, 'pointer', 'flag 0x20: pointer sprite (skin 4)')}
          {flag(WF_SCROLLBAR, 'scroll bar', 'flag 0x10: scroll bar (skin 5)')}
          {flag(WF_DIVIDERS, 'dividers', 'flag 8 (style 7)')}
          {flag(WF_CENTER_X, 'centre x', 'flag 0x4000')}
          {flag(WF_CENTER_Y, 'centre y', 'flag 0x8000')}
          {spec.flags & WF_MENU ? (
            <>
              {num('menuRow', 'cursor row', 0, 20)}
              {num('items', 'items', 1, 99)}
              {num('scrollTop', 'scroll top', 0, 99)}
            </>
          ) : null}
          <label title="winPrintNumber(win, w − 20, 0, style 3, sign, 0, 10, value)">
            <input type="checkbox" checked={spec.number !== null} onChange={(e) => set('number', e.target.checked ? 123 : null)} /> number
          </label>
          {spec.number !== null && (
            <>
              <input type="number" value={spec.number} onChange={(e) => set('number', Number(e.target.value))} />
              <label>
                <input type="checkbox" checked={spec.numberSign} onChange={(e) => set('numberSign', e.target.checked)} /> sign
              </label>
            </>
          )}
          {spec.style === 8 && (
            <>
              <span className="muted">values</span>
              {spec.hexValues.map((v, i) => (
                <input key={i} type="number" min={0} max={20} value={v} onChange={(e) => set('hexValues', spec.hexValues.map((x, j) => (j === i ? Number(e.target.value) : x)))} />
              ))}
              <span className="muted">deltas</span>
              {spec.hexDeltas.map((v, i) => (
                <input key={i} type="number" min={-20} max={20} value={v} onChange={(e) => set('hexDeltas', spec.hexDeltas.map((x, j) => (j === i ? Number(e.target.value) : x)))} />
              ))}
              <label title="The draw function moves every field one step toward 0 each frame; 'hold' re-sets them every frame as a caller would">
                <input type="checkbox" checked={spec.hexHold} onChange={(e) => set('hexHold', e.target.checked)} /> hold
              </label>
            </>
          )}
          {spec.style === 9 && (
            <>
              {(['count', 'target', 'period', 'gap'] as const).map((k) => (
                <label key={k}>
                  {k} <input type="number" min={0} max={64} value={spec.bars[k]} onChange={(e) => set('bars', { ...spec.bars, [k]: Number(e.target.value) })} />
                </label>
              ))}
            </>
          )}
        </div>
        <label className="win-text">
          <span className="muted">
            text (ASCII markup: @n new line, @b0–11 buttons, @m0–12 attributes, @p0–27 animated, @e0–48, @cN colour, @tN style, @sN delay, @wN wait, @aN fade)
          </span>
          <textarea rows={3} value={spec.text} onChange={(e) => set('text', e.target.value)} />
        </label>
      </div>
      <aside className="side db-side">
        <h4>Skins (menuWinSysInit)</h4>
        <ul className="plain small">
          {loadedSkins.map(([i, s]) => (
            <li key={i}>
              {i}: {WIN_SKIN_SOURCES[i][0]} {WIN_SKIN_SOURCES[i][1]}/{WIN_SKIN_SOURCES[i][2]} {s ? `${s.width}×${s.height}` : <span className="warn">missing</span>}
              <span className="muted"> · {WIN_SKIN_ROLES[i]}</span>
            </li>
          ))}
        </ul>
        <h4>Styles in the game</h4>
        <ul className="plain small">
          <li>10: nearly every window (map, deck, duel, story speakers, name entry); tails 1 and 4.</li>
          <li>7: winOpenMessage / winOpenMenu / winOpenList default; camp, stage select and battle-mode frames; script windows.</li>
          <li>1: story narrator.</li>
          <li>0: stage-select face window; story cmd 5 window (unused).</li>
          <li>2–6, 8, 9, 11–13: reachable only through a ＠ｔ tag, which no text uses.</li>
        </ul>
      </aside>
    </div>
  )
}
