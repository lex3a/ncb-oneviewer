import { useState } from 'react'

const PAGE = 4096

export function HexView({ data, base = 0 }: { data: Uint8Array; base?: number }) {
  const [limit, setLimit] = useState(PAGE)
  const lines: string[] = []
  const end = Math.min(data.length, limit)
  for (let o = 0; o < end; o += 16) {
    const row = data.subarray(o, Math.min(o + 16, end))
    const hex = Array.from(row, (b) => b.toString(16).padStart(2, '0')).join(' ')
    const asc = Array.from(row, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('')
    lines.push(`${(base + o).toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  ${asc}`)
  }
  return (
    <div>
      <pre className="hex">{lines.join('\n')}</pre>
      {end < data.length && (
        <button onClick={() => setLimit((l) => l + PAGE * 4)}>
          Show more ({(data.length - end).toLocaleString()} bytes left)
        </button>
      )}
    </div>
  )
}
