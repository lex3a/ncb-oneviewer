import { useEffect, useMemo } from 'react'
import { download } from '../export'
import { parseSfo } from '../formats/sfo'

/** ICON0.PNG / PIC1.PNG from the disc. */
export function PngView({ data, name }: { data: Uint8Array; name: string }) {
  const url = useMemo(() => URL.createObjectURL(new Blob([data as BlobPart], { type: 'image/png' })), [data])
  useEffect(() => () => URL.revokeObjectURL(url), [url])
  return (
    <div className="scroll-pane">
      <button onClick={() => download(data, name, 'image/png')}>Download</button>
      <div className="checker" style={{ display: 'inline-block', marginTop: 12 }}>
        <img src={url} alt={name} style={{ display: 'block', maxWidth: '100%' }} />
      </div>
    </div>
  )
}

/** PARAM.SFO key/value table. */
export function SfoView({ data, name }: { data: Uint8Array; name: string }) {
  const entries = useMemo(() => parseSfo(data), [data])
  return (
    <div className="scroll-pane">
      <button onClick={() => download(data, name)}>Download</button>
      <table className="grid" style={{ marginTop: 12 }}>
        <thead>
          <tr>
            <th className="left">key</th>
            <th className="left">value</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.key}>
              <td className="left mono">{e.key}</td>
              <td className="left">{typeof e.value === 'number' ? `${e.value} (0x${e.value.toString(16)})` : e.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
