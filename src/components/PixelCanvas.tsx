import { useEffect, useRef, type ReactNode } from 'react'

interface Props {
  /** Source canvas; it is copied into the displayed one on change. */
  source: HTMLCanvasElement | null
  zoom: number
  children?: ReactNode
  onPointer?: (x: number, y: number) => void
}

/** Shows a canvas scaled with nearest-neighbour over a checkerboard. Children are overlaid in source pixel coords. */
export function PixelCanvas({ source, zoom, children, onPointer }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const c = ref.current
    if (!c || !source) return
    c.width = source.width
    c.height = source.height
    const ctx = c.getContext('2d')!
    ctx.clearRect(0, 0, c.width, c.height)
    ctx.drawImage(source, 0, 0)
  }, [source])

  if (!source) return null
  const w = source.width * zoom
  const h = source.height * zoom
  return (
    <div className="pixel-wrap checker" style={{ width: w, height: h }}>
      <canvas
        ref={ref}
        style={{ width: w, height: h }}
        onMouseMove={
          onPointer &&
          ((e) => {
            const r = e.currentTarget.getBoundingClientRect()
            onPointer(Math.floor((e.clientX - r.left) / zoom), Math.floor((e.clientY - r.top) / zoom))
          })
        }
      />
      {children && (
        <svg className="overlay" width={w} height={h} viewBox={`0 0 ${source.width} ${source.height}`}>
          {children}
        </svg>
      )}
    </div>
  )
}

export function ZoomControl({ zoom, setZoom }: { zoom: number; setZoom: (z: number) => void }) {
  return (
    <div className="seg" role="group" aria-label="Zoom">
      {[1, 2, 3, 4, 6, 8].map((z) => (
        <button key={z} className={z === zoom ? 'on' : ''} onClick={() => setZoom(z)}>
          {z}×
        </button>
      ))}
    </div>
  )
}
