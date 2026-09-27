import { useEffect, useRef, useState } from 'react'
import { imageToCanvas } from '../export'
import { ganSheet, parseGan } from '../formats/gan'
import { gbpToImage, parseGbp } from '../formats/gbp'
import type { OneFile } from '../formats/one'

const cache = new WeakMap<Uint8Array, string | null>()

function thumbUrl(f: OneFile): string | null {
  if (cache.has(f.data)) return cache.get(f.data)!
  let url: string | null = null
  try {
    if (f.kind === 'gbp') url = imageToCanvas(gbpToImage(parseGbp(f.data))).toDataURL()
    else if (f.kind === 'gan') url = imageToCanvas(ganSheet(parseGan(f.data))).toDataURL()
  } catch {
    url = null
  }
  cache.set(f.data, url)
  return url
}

/** Lazily rendered thumbnail — decodes only when scrolled into view. */
export function Thumb({ file }: { file: OneFile }) {
  const ref = useRef<HTMLDivElement>(null)
  const [url, setUrl] = useState<string | null | undefined>(() => (cache.has(file.data) ? cache.get(file.data) : undefined))

  useEffect(() => {
    if (url !== undefined || !ref.current) return
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) {
          io.disconnect()
          setUrl(thumbUrl(file))
        }
      },
      { rootMargin: '200px' },
    )
    io.observe(ref.current)
    return () => io.disconnect()
  }, [file, url])

  return (
    <div ref={ref} className="thumb checker-sm">
      {url ? <img src={url} alt="" /> : <span className="kind-badge">{file.kind.toUpperCase()}</span>}
    </div>
  )
}
