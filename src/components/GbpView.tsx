import { useMemo, useState } from 'react'
import { canvasToPng, download, imageToCanvas } from '../export'
import { gbpToImage, parseGbp } from '../formats/gbp'
import { PaletteView } from './PaletteView'
import { PixelCanvas, ZoomControl } from './PixelCanvas'

const COMPRESSION = ['none', 'RLE', 'fill-runs']

export function GbpView({ data, name }: { data: Uint8Array; name: string }) {
  const gbp = useMemo(() => parseGbp(data), [data])
  const canvas = useMemo(() => imageToCanvas(gbpToImage(gbp)), [gbp])
  const [zoom, setZoom] = useState(() => (gbp.width <= 128 ? 4 : gbp.width <= 256 ? 2 : 1))
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null)

  const hoverIndex = (() => {
    if (!hover || hover.x < 0 || hover.y < 0 || hover.x >= gbp.width || hover.y >= gbp.height) return undefined
    const i = hover.y * gbp.width + hover.x
    return gbp.bpp === 8 ? gbp.indices[i] : (gbp.indices[i >> 1] >> ((i & 1) * 4)) & 15
  })()

  return (
    <div className="viewer">
      <div className="toolbar">
        <ZoomControl zoom={zoom} setZoom={setZoom} />
        <button onClick={() => download(canvasToPng(canvas), `${name}.png`, 'image/png')}>PNG</button>
        <button onClick={() => download(data, `${name}.gbp`)}>Raw</button>
        {hover && hoverIndex !== undefined && (
          <span className="muted mono">
            ({hover.x}, {hover.y}) → #{hoverIndex}
          </span>
        )}
      </div>
      {gbp.warning && <div className="warn">{gbp.warning}</div>}
      <div className="split">
        <div className="stage" onMouseLeave={() => setHover(null)}>
          <PixelCanvas source={canvas} zoom={zoom} onPointer={(x, y) => setHover({ x, y })} />
        </div>
        <aside className="side">
          <dl className="props">
            <dt>Size</dt>
            <dd>
              {gbp.width}×{gbp.height}
            </dd>
            <dt>Format</dt>
            <dd>
              {gbp.bpp} bpp (0x{gbp.format.toString(16)})
            </dd>
            <dt>Compression</dt>
            <dd>
              {gbp.compression} — {COMPRESSION[gbp.compression] ?? '?'}
            </dd>
            <dt>Bytes</dt>
            <dd>{data.length.toLocaleString()}</dd>
          </dl>
          <h4>Palette</h4>
          <PaletteView palette={gbp.palette} highlight={hoverIndex} />
        </aside>
      </div>
    </div>
  )
}
