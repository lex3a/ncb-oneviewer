import type { Palette } from '../formats/palette'

const hex = (n: number) => n.toString(16).padStart(2, '0')

export function PaletteView({ palette, highlight }: { palette: Palette; highlight?: number }) {
  const n = palette.length / 4
  return (
    <div className={`palette ${n > 16 ? 'p256' : 'p16'}`}>
      {Array.from({ length: n }, (_, i) => {
        const [r, g, b, a] = palette.subarray(i * 4, i * 4 + 4)
        return (
          <div
            key={i}
            className={`sw checker-sm${i === highlight ? ' hl' : ''}`}
            title={`#${i}: ${hex(r)}${hex(g)}${hex(b)} α=${a}`}
          >
            <span style={{ background: `rgba(${r},${g},${b},${a / 255})` }} />
          </div>
        )
      })}
    </div>
  )
}
