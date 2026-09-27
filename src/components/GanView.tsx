import { useEffect, useMemo, useState } from 'react'
import { canvasToPng, download, ganSheetCache, imageToCanvas, renderGanFrames, zipAsync } from '../export'
import { drawGanFrame, ganBounds, ganSheet, HOLD, isMarker, parseGan, partBlend, SILHOUETTE_PALETTE, type GanPart } from '../formats/gan'
import { PaletteView } from './PaletteView'
import { PixelCanvas, ZoomControl } from './PixelCanvas'

type Tab = 'anim' | 'sheet' | 'data'
const TICK_MS = 1000 / 60

function blendLabel(p: GanPart): string {
  if (!(p.flags & 1)) return 'normal'
  const { alpha, additive } = partBlend(p)
  return `${additive ? 'add' : 'alpha'} ${Math.round(alpha * 100)}%`
}

function PartRects({ parts, ox, oy, useSrc }: { parts: GanPart[]; ox: number; oy: number; useSrc?: boolean }) {
  return (
    <>
      {parts.map((p, i) => {
        const x = (useSrc ? p.sx : p.dx + ox) + 0.5
        const y = (useSrc ? p.sy : p.dy + oy) + 0.5
        if (isMarker(p) && !useSrc) {
          return (
            <g key={i} className="marker">
              <line x1={x - 4} y1={y} x2={x + 4} y2={y} vectorEffect="non-scaling-stroke" />
              <line x1={x} y1={y - 4} x2={x} y2={y + 4} vectorEffect="non-scaling-stroke" />
            </g>
          )
        }
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={Math.max(0, p.w - 1)}
            height={Math.max(0, p.h - 1)}
            className={isMarker(p) ? 'rect marker' : 'rect'}
            vectorEffect="non-scaling-stroke"
          />
        )
      })}
    </>
  )
}

export function GanView({ data, name }: { data: Uint8Array; name: string }) {
  const gan = useMemo(() => parseGan(data), [data])
  const sheets = useMemo(() => ganSheetCache(gan), [gan])
  const body = useMemo(() => ganBounds(gan), [gan])
  // The ground shadow (ganDrawShadow) mirrors the body below the origin (y = 128 in part coordinates).
  const [shadow, setShadow] = useState(false)
  const bounds = useMemo(() => {
    if (!shadow) return body
    const top = Math.min(body.y, 256 - (body.y + body.h))
    const bottom = Math.max(body.y + body.h, 256 - body.y)
    return { ...body, y: top, h: bottom - top }
  }, [body, shadow])
  const [tab, setTab] = useState<Tab>('anim')
  const [zoom, setZoom] = useState(2)

  // Sheet tab: which image and which stored palette to preview it with.
  const [image, setImage] = useState(0)
  const [palIdx, setPalIdx] = useState(0)
  const sheetPalette = gan.rawPalettes[palIdx]
  const sheet = useMemo(() => imageToCanvas(ganSheet(gan, image, sheetPalette)), [gan, image, sheetPalette])

  const [step, setStep] = useState(0)
  const [frameOnly, setFrameOnly] = useState<number | null>(null)
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState(1)
  const [boxes, setBoxes] = useState(false)
  // The game mirrors the left-hand combatant by rotating its sprite by -π around Y.
  const [mirror, setMirror] = useState(false)

  const cur = gan.steps[step]
  const frameIdx = frameOnly ?? cur?.frame ?? 0
  const parts = useMemo(() => gan.frames[frameIdx] ?? [], [gan, frameIdx])

  useEffect(() => {
    if (!playing || frameOnly !== null || gan.steps.length < 2) return
    const dur = Math.max(1, gan.steps[step]?.duration ?? 1)
    // The game turns 255 into "forever", so an animation ending on it never loops.
    const next = step + 1 < gan.steps.length ? step + 1 : dur === HOLD ? -1 : 0
    const t = setTimeout(() => (next < 0 ? setPlaying(false) : setStep(next)), (dur * TICK_MS) / speed)
    return () => clearTimeout(t)
  }, [playing, step, speed, gan, frameOnly])

  const stage = useMemo(() => {
    const c = document.createElement('canvas')
    c.width = bounds.w
    c.height = bounds.h
    const ctx = c.getContext('2d')!
    ctx.imageSmoothingEnabled = false
    if (mirror) {
      ctx.translate(bounds.w, 0)
      ctx.scale(-1, 1)
    }
    if (shadow) {
      // Non-additive parts only, with the silhouette palette and normal blending, laid flat: seen through
      // the effects' 45° camera the flat copy is the body mirrored below the feet.
      ctx.save()
      ctx.translate(0, 2 * (128 - bounds.y))
      ctx.scale(1, -1)
      const flat = parts.filter((p) => !partBlend(p).additive).map((p) => ({ ...p, flags: p.flags & ~1 }))
      drawGanFrame(ctx, (image) => sheets(image, SILHOUETTE_PALETTE), flat, -bounds.x, -bounds.y)
      ctx.restore()
    }
    drawGanFrame(ctx, sheets, parts, -bounds.x, -bounds.y)
    return c
  }, [sheets, parts, bounds, mirror, shadow])

  const exportFrames = async () => {
    const files: Record<string, Uint8Array> = {}
    gan.images.forEach((_, i) => (files[`${name}_sheet${gan.images.length > 1 ? i : ''}.png`] = canvasToPng(imageToCanvas(ganSheet(gan, i)))))
    renderGanFrames(gan).forEach((c, i) => (files[`${name}_f${String(i).padStart(2, '0')}.png`] = canvasToPng(c)))
    download(await zipAsync(files), `${name}_frames.zip`, 'application/zip')
  }

  const img = gan.images[image]

  return (
    <div className="viewer">
      <div className="toolbar">
        <div className="seg" role="tablist">
          {(
            [
              ['anim', 'Animation'],
              ['sheet', 'Sheet'],
              ['data', 'Data'],
            ] as const
          ).map(([k, l]) => (
            <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
              {l}
            </button>
          ))}
        </div>
        <ZoomControl zoom={zoom} setZoom={setZoom} />
        <button onClick={exportFrames}>Frames (zip)</button>
        <button onClick={() => download(data, `${name}.gan`)}>Raw</button>
      </div>
      {gan.warning && <div className="warn">{gan.warning}</div>}

      {tab === 'anim' && (
        <div className="split">
          <div className="stage">
            <div className="toolbar">
              <button
                onClick={() => {
                  const atHold = step === gan.steps.length - 1 && gan.steps[step]?.duration === HOLD
                  if (!playing && atHold) setStep(0)
                  setFrameOnly(null)
                  setPlaying((p) => !p)
                }}
                disabled={gan.steps.length < 2}
              >
                {playing && frameOnly === null ? '❚❚ Pause' : '▶ Play'}
              </button>
              <button onClick={() => { setFrameOnly(null); setPlaying(false); setStep((s) => (s - 1 + gan.steps.length) % Math.max(1, gan.steps.length)) }}>◀</button>
              <button onClick={() => { setFrameOnly(null); setPlaying(false); setStep((s) => (s + 1) % Math.max(1, gan.steps.length)) }}>▶</button>
              <label>
                Speed{' '}
                <select value={speed} onChange={(e) => setSpeed(+e.target.value)}>
                  {[0.1, 0.25, 0.5, 1, 2].map((s) => (
                    <option key={s} value={s}>{s}×</option>
                  ))}
                </select>
              </label>
              <label>
                <input type="checkbox" checked={boxes} onChange={(e) => setBoxes(e.target.checked)} /> boxes &amp; markers
              </label>
              <label title="How the game shows the left-hand combatant">
                <input type="checkbox" checked={mirror} onChange={(e) => setMirror(e.target.checked)} /> mirror
              </label>
              <label title="Ground shadow of script animation objects (ganDrawShadow): non-additive parts in the palette-15 silhouette, laid flat; through the effects' 45° camera it appears mirrored below the feet">
                <input type="checkbox" checked={shadow} onChange={(e) => setShadow(e.target.checked)} /> shadow
              </label>
              <span className="muted mono">
                {frameOnly === null ? `step ${step + 1}/${gan.steps.length} · ` : ''}frame {frameIdx}
                {cur && frameOnly === null ? ` · ${cur.duration === HOLD ? 'hold' : `${cur.duration} ticks`}` : ''}
              </span>
            </div>
            <PixelCanvas source={stage} zoom={zoom}>
              {boxes && (
                <g transform={mirror ? `translate(${bounds.w} 0) scale(-1 1)` : undefined}>
                  <PartRects parts={parts} ox={-bounds.x} oy={-bounds.y} />
                </g>
              )}
            </PixelCanvas>
          </div>
          <aside className="side">
            <h4>Sequence</h4>
            <ol className="steps">
              {gan.steps.map((s, i) => (
                <li key={i}>
                  <button
                    className={frameOnly === null && i === step ? 'on' : ''}
                    onClick={() => { setFrameOnly(null); setPlaying(false); setStep(i) }}
                    title={gan.markerSteps.includes(i) ? 'Hit frame: contains a marker part (palette 12). In battle the first one triggers damage and the effect script.' : undefined}
                  >
                    frame {s.frame} · {s.duration === HOLD ? 'hold' : `${s.duration}t`}
                    {gan.markerSteps.includes(i) ? ' · ◆ hit' : ''}
                  </button>
                </li>
              ))}
            </ol>
            <h4>Frames</h4>
            <div className="chips">
              {gan.frames.map((f, i) => (
                <button key={i} className={frameOnly === i ? 'on' : ''} onClick={() => { setPlaying(false); setFrameOnly(i) }}>
                  {i}
                  <small>·{f.length}</small>
                </button>
              ))}
            </div>
          </aside>
        </div>
      )}

      {tab === 'sheet' && (
        <div className="split">
          <div className="stage">
            <div className="toolbar">
              {gan.images.length > 1 && (
                <label>
                  Image{' '}
                  <select value={image} onChange={(e) => { setImage(+e.target.value); setPalIdx(+e.target.value * 16) }}>
                    {gan.images.map((_, i) => (
                      <option key={i} value={i}>#{i}</option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                Palette{' '}
                <select value={palIdx} onChange={(e) => setPalIdx(+e.target.value)}>
                  {gan.rawPalettes.map((_, i) => (
                    <option key={i} value={i}>
                      #{i}
                      {(i & 15) === 12 ? ' (marker)' : (i & 15) === 15 ? ' (silhouette)' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <button onClick={() => download(canvasToPng(sheet), `${name}_sheet.png`, 'image/png')}>Sheet PNG</button>
            </div>
            <PixelCanvas source={sheet} zoom={zoom}>
              <PartRects parts={parts.filter((p) => p.image === image)} ox={0} oy={0} useSrc />
            </PixelCanvas>
          </div>
          <aside className="side">
            <p className="muted">
              Image {image}: {img?.width}×{img?.height}, {gan.bpp} bpp. Boxes mark the parts of frame {frameIdx}.
              Shown with the palette as stored; in game palette 12 is cleared and 15 becomes a black silhouette.
            </p>
            <h4>Frame</h4>
            <div className="chips">
              {gan.frames.map((_, i) => (
                <button key={i} className={frameIdx === i ? 'on' : ''} onClick={() => { setPlaying(false); setFrameOnly(i) }}>
                  {i}
                </button>
              ))}
            </div>
            <h4>Palette #{palIdx}</h4>
            <PaletteView palette={sheetPalette} />
          </aside>
        </div>
      )}

      {tab === 'data' && (
        <div className="scroll-pane">
          <p className="muted">
            Images: {gan.images.length}; palettes: {gan.rawPalettes.length}; steps: {gan.steps.length}; frames: {gan.frames.length}.
            Flags: 0x1 — blend mode in bits 4–5, 0x4 — rotate, 0x8 — scale. Palette 12 marks marker parts (not drawn).
          </p>
          <table className="grid">
            <thead>
              <tr>
                <th>frame</th><th>#</th><th>image</th><th>palette</th><th>src</th><th>dst</th><th>w×h</th><th>flags</th><th>blend</th><th>angle</th><th>scale</th>
              </tr>
            </thead>
            <tbody>
              {gan.frames.flatMap((f, fi) =>
                f.map((p, pi) => (
                  <tr key={`${fi}-${pi}`}>
                    <td>{pi === 0 ? fi : ''}</td>
                    <td>{pi}</td>
                    <td>{p.image}</td>
                    <td>{p.clut}{isMarker(p) ? ' ◆' : ''}</td>
                    <td>{p.sx},{p.sy}</td>
                    <td>{p.dx - 128},{p.dy - 128}</td>
                    <td>{p.w}×{p.h}</td>
                    <td>0x{p.flags.toString(16)}</td>
                    <td>{blendLabel(p)}</td>
                    <td>{p.flags & 4 ? `${p.angle.toFixed(1)}°` : '—'}</td>
                    <td>{p.flags & 8 ? `${p.scaleX.toFixed(2)}×${p.scaleY.toFixed(2)}` : '—'}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
          <h4>Palettes (as stored)</h4>
          <div className="pal-list">
            {gan.rawPalettes.map((p, i) => (
              <div key={i}>
                <small className="muted">#{i}</small>
                <PaletteView palette={p} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
