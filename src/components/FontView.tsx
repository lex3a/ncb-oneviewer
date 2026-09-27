import { useMemo, useState } from 'react'
import { canvasToPng, download } from '../export'
import { fontTables, GLYPH, glyphCount, glyphPixels, textToGlyphs } from '../formats/font'
import { PixelCanvas, ZoomControl } from './PixelCanvas'

const COLS = 64
const INK = [255, 255, 255, 255]
const EDGE = [40, 40, 60, 255]

function drawGlyphs(font: Uint8Array, glyphs: number[], cols: number, outline: boolean): HTMLCanvasElement {
  const rows = Math.max(1, Math.ceil(glyphs.length / cols))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.min(cols, glyphs.length)) * GLYPH
  c.height = rows * GLYPH
  const ctx = c.getContext('2d')!
  const img = ctx.createImageData(c.width, c.height)
  glyphs.forEach((g, i) => {
    const px = glyphPixels(font, g, outline)
    const ox = (i % cols) * GLYPH
    const oy = Math.floor(i / cols) * GLYPH
    for (let y = 0; y < GLYPH; y++)
      for (let x = 0; x < GLYPH; x++) {
        const v = px[y * GLYPH + x]
        if (!v) continue
        img.data.set(v === 1 ? INK : EDGE, ((oy + y) * c.width + ox + x) * 4)
      }
  })
  ctx.putImageData(img, 0, 0)
  return c
}

const hex = (n: number) => n.toString(16).toUpperCase().padStart(4, '0')

export function FontView({ data }: { data: Uint8Array }) {
  const count = glyphCount(data)
  const [zoom, setZoom] = useState(2)
  const [outline, setOutline] = useState(false)
  const [text, setText] = useState('Neverland Card Battles ネバーランド カードバトルズ')
  const [hover, setHover] = useState<number | null>(null)
  const all = useMemo(() => Array.from({ length: count }, (_, i) => i), [count])
  const atlas = useMemo(() => drawGlyphs(data, all, COLS, outline), [data, all, outline])
  const preview = useMemo(() => drawGlyphs(data, textToGlyphs(text), 40, true), [data, text])
  const { glyphToCode, codeToChar } = fontTables()
  const code = hover !== null ? glyphToCode.get(hover) : undefined

  return (
    <div className="viewer">
      <div className="toolbar">
        <ZoomControl zoom={zoom} setZoom={setZoom} />
        <label>
          <input type="checkbox" checked={outline} onChange={(e) => setOutline(e.target.checked)} /> outline (as in game)
        </label>
        <button onClick={() => download(canvasToPng(atlas), 'gothic16_atlas.png', 'image/png')}>Atlas PNG</button>
        <span className="muted">
          {count} glyphs · 16×16 · 1 bpp · Shift-JIS
          {hover !== null && ` · #${hover}${code !== undefined ? ` · SJIS ${hex(code)} · ${codeToChar.get(code) ?? ''}` : ' · (unmapped)'}`}
        </span>
      </div>
      <div className="scroll-pane">
        <h4>Preview</h4>
        <input className="font-input" value={text} onChange={(e) => setText(e.target.value)} />
        <div style={{ margin: '8px 0 16px' }}>
          <PixelCanvas source={preview} zoom={Math.max(2, zoom)} />
        </div>
        <h4>All glyphs (hover for code)</h4>
        <PixelCanvas
          source={atlas}
          zoom={zoom}
          onPointer={(x, y) => {
            const i = Math.floor(y / GLYPH) * COLS + Math.floor(x / GLYPH)
            setHover(i >= 0 && i < count ? i : null)
          }}
        />
      </div>
    </div>
  )
}
