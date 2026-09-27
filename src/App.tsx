import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react'
import { CasView } from './components/CasView'
import { DatabaseView } from './components/DatabaseView'
import { FontView } from './components/FontView'
import { MediaView } from './components/MediaView'
import { PngView, SfoView } from './components/MiscViews'
import { SaveView } from './components/SaveView'
import { VagBankView } from './components/VagBankView'
import { GanView } from './components/GanView'
import { GbpView } from './components/GbpView'
import { HexView } from './components/HexView'
import { Thumb } from './components/Thumb'
import { download, extractArchive, fileBaseName } from './export'
import { isFont } from './formats/font'
import { entryLabel, parseGameDb, type GameDb } from './formats/gamedb'
import { expandIsos, fromDataTransfer, fromFileList, type InputFile } from './inputs'
import { parseOne, type FileKind, type OneArchive, type OneFile } from './formats/one'
import { isSfo } from './formats/sfo'
import { isVagBank } from './formats/vag'
import { setSeLoader } from './audio/sePlayer'
import { PlayView } from './components/PlayView'

interface Selection {
  archive: number
  entry?: number
  file?: string
  /** Path of a non-ONE file (sound bank, font, movie, …). */
  loose?: string
}

type LooseKind = 'vag' | 'font' | 'at3' | 'pmf' | 'png' | 'sfo' | 'elf' | 'save' | 'bin'

/** Files outside the ONE archives. They are read only when selected (goc.dat alone is 120 MB). */
interface LooseFile {
  path: string
  name: string
  blob: Blob
  kind: LooseKind
}

const LOOSE_LABEL: Record<LooseKind, string> = { vag: 'sound bank', font: 'font', at3: 'ATRAC3+', pmf: 'movie', png: 'image', sfo: 'metadata', elf: 'executable', save: 'save data', bin: 'binary' }
const SUPPORTED = /\.(one|dat|bin|at3|pmf|png|sfo|elf|sav)$/i

function guessKind(name: string): LooseKind {
  if (/\.at3$/i.test(name)) return 'at3'
  if (/\.pmf$/i.test(name)) return 'pmf'
  if (/\.png$/i.test(name)) return 'png'
  if (/\.sfo$/i.test(name)) return 'sfo'
  if (/\.sav$/i.test(name)) return 'save'
  // BOOT.BIN on the UMD is the unencrypted executable; EBOOT.BIN is encrypted.
  if (/(\.elf|^boot\.bin)$/i.test(name)) return 'elf'
  if (/gothic16\.bin$/i.test(name)) return 'font'
  if (/\.dat$/i.test(name)) return 'vag'
  return 'bin'
}


const KINDS: FileKind[] = ['gbp', 'gan', 'cas', 'bin']
const KIND_LABEL: Record<FileKind, string> = { gbp: 'Images', gan: 'Animations', cas: 'Scripts', clc2: 'CLC2', bin: 'Other' }

export default function App() {
  const [archives, setArchives] = useState<OneArchive[]>([])
  const [sel, setSel] = useState<Selection | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const [kinds, setKinds] = useState<Set<FileKind>>(new Set(KINDS))
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [progress, setProgress] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [loose, setLoose] = useState<LooseFile[]>([])
  const [looseData, setLooseData] = useState<{ path: string; data: Uint8Array } | null>(null)
  /** Card tables read from the executable, and the path of the file they came from. */
  const [db, setDb] = useState<{ path: string; db: GameDb } | null>(null)

  const loadFiles = useCallback(async (input: InputFile[] | Promise<InputFile[]>) => {
    const errs: string[] = []
    const loaded: OneArchive[] = []
    const others: LooseFile[] = []
    let list: InputFile[] = []
    setProgress('Reading…')
    try {
      list = await expandIsos(await input)
    } catch (e) {
      errs.push((e as Error).message)
    }
    for (const f of list) {
      if (!SUPPORTED.test(f.name)) continue
      if (/\.one$/i.test(f.name)) {
        try {
          loaded.push(parseOne(f.name, await f.blob.arrayBuffer()))
        } catch (e) {
          errs.push((e as Error).message)
        }
      } else {
        others.push({ path: f.path, name: f.name, blob: f.blob, kind: guessKind(f.name) })
      }
    }
    let foundDb = false
    for (const l of others) {
      if (l.kind !== 'elf' || foundDb) continue
      try {
        const parsed = parseGameDb(new Uint8Array(await l.blob.arrayBuffer()))
        if (parsed) {
          setDb({ path: l.path, db: parsed })
          foundDb = true
        }
      } catch (e) {
        errs.push((e as Error).message)
      }
    }
    setProgress(null)
    if (!loaded.length && !others.length && !errs.length) errs.push('No supported files found (.one, .dat, .bin, .at3, .pmf, .iso)')
    setErrors(errs)
    if (others.length) {
      const byPath = new Map(loose.map((l) => [l.path, l]))
      for (const l of others) byPath.set(l.path, l)
      setLoose([...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)))
    }
    if (!loaded.length) {
      if (others.length && !archives.length) setSel({ archive: -1, loose: others[0].path })
      return
    }
    const byName = new Map(archives.map((a) => [a.name, a]))
    for (const a of loaded) byName.set(a.name, a)
    const next = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
    setArchives(next)
    if (foundDb && !archives.length) return setSel({ archive: -1, loose: others.find((l) => l.kind === 'elf')!.path })
    setSel({ archive: next.findIndex((a) => a.name === loaded[0].name) })
    setOpen(new Set(loaded.map((a) => a.name)))
  }, [archives, loose])

  // Dev only: ?load=url1,url2 fetches game files (e.g. /@fs/<path>/etc.one) at start, for automated checks.
  const [devLoad] = useState(() => (import.meta.env.DEV ? new URLSearchParams(location.search).get('load') : null))
  useEffect(() => {
    if (!devLoad) return
    const urls = devLoad.split(',').filter(Boolean)
    loadFiles(
      Promise.all(
        urls.map(async (u) => {
          const name = decodeURIComponent(u.split('/').pop() ?? u)
          return { name, path: name, blob: await (await fetch(u)).blob() }
        }),
      ),
    )
    // Once, at start.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devLoad])

  const seFile = loose.find((l) => /(^|\/)se\.dat$/i.test(l.path))
  const gocFile = loose.find((l) => /goc\.dat$/i.test(l.path))
  const loadGoc = useCallback(async () => (gocFile ? new Uint8Array(await gocFile.blob.arrayBuffer()) : null), [gocFile])
  const loadMusic = useCallback(
    async (fileName: string) => {
      const f = loose.find((l) => l.name.toLowerCase() === fileName.toLowerCase())
      return f ? new Uint8Array(await f.blob.arrayBuffer()) : null
    },
    [loose],
  )
  /** Play mode reads loose disc files by name (se.dat, goc.dat, BGM_nn.at3). */
  const loadFile = useCallback(
    async (fileName: string) => {
      const f = loose.find((l) => l.name.toLowerCase() === fileName.toLowerCase())
      return f ? new Uint8Array(await f.blob.arrayBuffer()) : null
    },
    [loose],
  )
  const [playing, setPlaying] = useState(false)
  // ?play=1 (also in the production build) opens Play mode as soon as a disc is loaded (the ISO / data folder the user opens, or ?load in dev).
  const [autoPlay, setAutoPlay] = useState(() => new URLSearchParams(location.search).has('play'))
  const fontFile = loose.find((l) => l.kind === 'font')
  const loadFont = useCallback(async () => (fontFile ? new Uint8Array(await fontFile.blob.arrayBuffer()) : null), [fontFile])
  const loadSe = useCallback(async () => (seFile ? new Uint8Array(await seFile.blob.arrayBuffer()) : null), [seFile])
  const canPlay = !!db && archives.length > 0
  if (autoPlay && canPlay && fontFile) {
    setAutoPlay(false)
    setPlaying(true)
  }
  // Views that play sound effects without a prop (map board, deck editor, Sounds tab) read se.dat through this.
  useEffect(() => setSeLoader(seFile ? loadSe : null), [seFile, loadSe])
  const looseFile = sel?.loose ? loose.find((l) => l.path === sel.loose) : undefined
  useEffect(() => {
    if (!looseFile || looseData?.path === looseFile.path) return
    let cancelled = false
    looseFile.blob.arrayBuffer().then((buf) => {
      if (!cancelled) setLooseData({ path: looseFile.path, data: new Uint8Array(buf) })
    })
    return () => {
      cancelled = true
    }
  }, [looseFile, looseData])
  const looseBytes = looseFile && looseData?.path === looseFile.path ? looseData.data : null
  let looseKind: LooseKind | null = looseFile && looseBytes ? looseFile.kind : null
  if (looseKind === 'vag' && looseBytes && !isVagBank(looseBytes)) looseKind = 'bin'
  if (looseKind === 'font' && looseBytes && looseFile && !isFont(looseFile.name, looseBytes)) looseKind = 'bin'
  if (looseKind === 'sfo' && looseBytes && !isSfo(looseBytes)) looseKind = 'bin'

  const match = useCallback(
    (f: OneFile) => kinds.has(f.kind === 'clc2' ? 'bin' : f.kind) && (!query.trim() || f.path.startsWith(query.trim())),
    [kinds, query],
  )

  const archive = sel && !sel.loose ? archives[sel.archive] : undefined
  const entry = archive && sel?.entry !== undefined ? archive.entries.find((e) => e.id === sel.entry) : undefined
  const file = entry && sel?.file ? entry.files.find((f) => f.key === sel.file) : undefined

  const galleryFiles = useMemo(() => {
    if (!archive || file) return []
    const src = entry ? [entry] : archive.entries
    return src.flatMap((e) => e.files).filter(match)
  }, [archive, entry, file, match])

  const toggle = (k: string) =>
    setOpen((s) => {
      const n = new Set(s)
      if (n.has(k)) n.delete(k)
      else n.add(k)
      return n
    })

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    loadFiles(fromDataTransfer(e.dataTransfer))
  }

  const runExtract = async (which: OneArchive[], png: boolean) => {
    setProgress('Preparing…')
    try {
      const zip = await extractArchive(which, { raw: true, png }, (d, t) => setProgress(`Extracting ${d}/${t}`))
      const name = which.length === 1 ? which[0].name.replace(/\.one$/i, '') : 'one_extract'
      download(zip, `${name}${png ? '_png' : ''}.zip`, 'application/zip')
    } catch (e) {
      setErrors([(e as Error).message])
    } finally {
      setProgress(null)
    }
  }

  const displayName = file && archive ? fileBaseName(archive.name, file) : ''
  const label = (arc: string, entryId: number, member?: number | null) => entryLabel(db?.db ?? null, arc, entryId, member)
  const openFile = (arc: string, entryId: number, key: string) => {
    const ai = archives.findIndex((a) => a.name === arc)
    if (ai < 0) return
    setSel({ archive: ai, entry: entryId, file: key })
    setOpen((s) => new Set([...s, arc, `${arc}:${entryId}`]))
  }

  return (
    <div className={`app${dragging ? ' dragging' : ''}`} onDragOver={(e) => { e.preventDefault(); setDragging(true) }} onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false) }} onDrop={onDrop}>
      <header className="topbar">
        <strong className="brand">ONE Viewer</strong>
        <span className="muted hide-sm">Neverland Card Battles (PSP)</span>
        <label className="btn primary">
          Open files
          <input type="file" accept=".one,.dat,.bin,.at3,.pmf,.iso,.elf,.sav" multiple hidden onChange={(e) => e.target.files && loadFiles(fromFileList(e.target.files))} />
        </label>
        <label className="btn" title="Pick PSP_GAME/USRDIR/data to load everything at once">
          Open folder
          <input type="file" hidden {...{ webkitdirectory: '' }} onChange={(e) => e.target.files && loadFiles(fromFileList(e.target.files))} />
        </label>
        {archives.length > 0 && (
          <>
            <button disabled={!!progress || !archive} onClick={() => archive && runExtract([archive], true)} title="Raw files + PNG">
              Extract {archive?.name}
            </button>
            <button disabled={!!progress} onClick={() => runExtract(archives, true)}>Extract all</button>
            <button disabled={!!progress} onClick={() => runExtract(archives, false)} title="Raw files only, no conversion">
              All without PNG
            </button>
          </>
        )}
        {canPlay && (
          <button className="primary" onClick={() => setPlaying(true)} title="Play the game from the loaded disc (Play mode)">
            ▶ Play
          </button>
        )}
        {progress && <span className="muted">{progress}</span>}
      </header>
      {playing && db && <PlayView db={db.db} archives={archives} loadFont={loadFont} loadFile={loadFile} onExit={() => setPlaying(false)} />}

      {errors.length > 0 && (
        <div className="warn" onClick={() => setErrors([])}>
          {errors.join(' · ')} (click to dismiss)
        </div>
      )}

      {archives.length === 0 && loose.length === 0 ? (
        <div className="empty">
          <div>
            <h2>Drop game files here</h2>
            <p className="muted">
              The whole UMD image (.iso), the PSP_GAME/USRDIR/data folder, or single files: .one archives,
              snd/*.dat sound banks, gothic16.bin, SYSDIR/BOOT.BIN (card database), at3/*.at3 music and Movie/*.pmf movies. Everything is parsed locally in your browser.
            </p>
          </div>
        </div>
      ) : (
        <div className="main">
          <nav className="sidebar">
            <div className="filters">
              <input type="search" placeholder="id, e.g. 100/3" value={query} onChange={(e) => setQuery(e.target.value)} />
              <div className="chips">
                {KINDS.map((k) => (
                  <button
                    key={k}
                    className={kinds.has(k) ? 'on' : ''}
                    onClick={() =>
                      setKinds((s) => {
                        const n = new Set(s)
                        if (n.has(k)) n.delete(k)
                        else n.add(k)
                        return n
                      })
                    }
                  >
                    {KIND_LABEL[k]}
                  </button>
                ))}
              </div>
            </div>
            <ul className="tree">
              {db && (
                <li>
                  <button className={`node arc${sel?.loose === db.path ? ' on' : ''}`} onClick={() => setSel({ archive: -1, loose: db.path })}>
                    <span className="caret" />
                    Card database
                    <small>{db.db.cards.length}</small>
                  </button>
                </li>
              )}
              {archives.map((a, ai) => {
                const isOpen = open.has(a.name)
                return (
                  <li key={a.name}>
                    <button
                      className={`node arc${sel?.archive === ai && sel.entry === undefined ? ' on' : ''}`}
                      onClick={() => { setSel({ archive: ai }); if (!isOpen) toggle(a.name) }}
                    >
                      <span className="caret" onClick={(e) => { e.stopPropagation(); toggle(a.name) }}>{isOpen ? '▾' : '▸'}</span>
                      {a.name}
                      <small>{a.entries.length}</small>
                    </button>
                    {isOpen && (
                      <ul>
                        {a.entries.map((e) => {
                          const files = e.files.filter(match)
                          if (!files.length) return null
                          const ek = `${a.name}:${e.id}`
                          const eOpen = open.has(ek) || !!query
                          const single = !e.container
                          return (
                            <li key={e.id}>
                              <button
                                className={`node${sel?.archive === ai && sel.entry === e.id && (single ? sel.file === files[0].key : !sel.file) ? ' on' : ''}`}
                                onClick={() => {
                                  if (single) setSel({ archive: ai, entry: e.id, file: files[0].key })
                                  else { setSel({ archive: ai, entry: e.id }); if (!eOpen) toggle(ek) }
                                }}
                              >
                                <span className="caret" onClick={(ev) => { ev.stopPropagation(); if (!single) toggle(ek) }}>{single ? '' : eOpen ? '▾' : '▸'}</span>
                                {e.id}
                                <span className="label">{label(a.name, e.id)}</span>
                                <small>{single ? files[0].kind : `${files.length} files`}</small>
                              </button>
                              {!single && eOpen && (
                                <ul>
                                  {files.map((f) => (
                                    <li key={f.key}>
                                      <button
                                        className={`node leaf${sel?.file === f.key && sel.archive === ai ? ' on' : ''}`}
                                        onClick={() => setSel({ archive: ai, entry: e.id, file: f.key })}
                                      >
                                        {f.path}
                                        <span className="label">{label(a.name, e.id, f.subId)}</span>
                                        <small className={`k-${f.kind}`}>{f.kind}</small>
                                      </button>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </li>
                )
              })}
              {loose.length > 0 && (
                <li>
                  <button className="node arc" onClick={() => toggle('__loose')}>
                    <span className="caret">{open.has('__loose') ? '▸' : '▾'}</span>
                    Other files
                    <small>{loose.length}</small>
                  </button>
                  {!open.has('__loose') && (
                    <ul>
                      {loose.map((l) => (
                        <li key={l.path}>
                          <button
                            className={`node leaf${sel?.loose === l.path ? ' on' : ''}`}
                            onClick={() => setSel({ archive: -1, loose: l.path })}
                            title={l.path}
                          >
                            {l.name}
                            <small>{LOOSE_LABEL[l.kind]}</small>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              )}
            </ul>
          </nav>

          <main className="content">
            {looseFile ? (
              <>
                <div className="crumbs">
                  <span className="mono">{looseFile.path}</span>
                  <span className="muted"> · {(looseFile.blob.size / 1048576).toFixed(1)} MB</span>
                </div>
                {!looseBytes && <div className="scroll-pane muted">Reading…</div>}
                {looseBytes && looseKind === 'vag' && <VagBankView key={looseFile.path} data={looseBytes} name={looseFile.name} db={/goc\.dat$/i.test(looseFile.name) ? db?.db : undefined} />}
                {looseBytes && looseKind === 'font' && <FontView key={looseFile.path} data={looseBytes} />}
                {looseBytes && (looseKind === 'at3' || looseKind === 'pmf') && (
                  <MediaView key={looseFile.path} data={looseBytes} name={looseFile.name} kind={looseKind} />
                )}
                {looseBytes && looseKind === 'png' && <PngView key={looseFile.path} data={looseBytes} name={looseFile.name} />}
                {looseBytes && looseKind === 'elf' && db?.path === looseFile.path && (
                  <DatabaseView db={db.db} archives={archives} onOpen={openFile} loadFont={loadFont} loadVoices={loadGoc} loadMusic={loadMusic} />
                )}
                {looseBytes && looseKind === 'elf' && db?.path !== looseFile.path && (
                  <div className="scroll-pane">
                    <p className="muted">Not the ULUS10382 executable: the card tables were not found.</p>
                    <button onClick={() => download(looseBytes, looseFile.name)}>Download</button>
                    <HexView key={looseFile.path} data={looseBytes} />
                  </div>
                )}
                {looseBytes && looseKind === 'save' && <SaveView key={looseFile.path} data={looseBytes} name={looseFile.name} db={db?.db} />}
                {looseBytes && looseKind === 'sfo' && <SfoView key={looseFile.path} data={looseBytes} name={looseFile.name} />}
                {looseBytes && looseKind === 'bin' && (
                  <div className="scroll-pane">
                    <button onClick={() => download(looseBytes, looseFile.name)}>Download</button>
                    <HexView key={looseFile.path} data={looseBytes} />
                  </div>
                )}
              </>
            ) : file && archive ? (
              <>
                <div className="crumbs">
                  <button onClick={() => setSel({ archive: sel!.archive })}>{archive.name}</button> /{' '}
                  {entry?.container ? <button onClick={() => setSel({ archive: sel!.archive, entry: entry.id })}>{entry.id}</button> : entry?.id}
                  {file.subId !== null && <> / {file.subId}</>}
                  {label(archive.name, file.id, file.subId) && <strong> · {label(archive.name, file.id, file.subId)}</strong>}
                  <span className="muted">
                    {' '}· {file.kind.toUpperCase()} · {file.data.length.toLocaleString()} bytes · offset 0x{file.offset.toString(16)}
                  </span>
                </div>
                {file.kind === 'gbp' && <GbpView key={file.key + archive.name} data={file.data} name={displayName} />}
                {file.kind === 'gan' && <GanView key={file.key + archive.name} data={file.data} name={displayName} />}
                {file.kind === 'cas' && (
                  <CasView
                    key={file.key + archive.name}
                    data={file.data}
                    name={displayName}
                    archive={/^effect\.one$/i.test(archive.name) ? archive : undefined}
                    loadSe={loadSe}
                    archives={archives}
                    entryId={file.id}
                    loadFont={loadFont}
                    db={db?.db}
                  />
                )}
                {(file.kind === 'bin' || file.kind === 'clc2') && (
                  <div className="scroll-pane">
                    <button onClick={() => download(file.data, `${displayName}.bin`)}>Download</button>
                    <HexView key={file.key} data={file.data} base={file.offset} />
                  </div>
                )}
              </>
            ) : archive ? (
              <>
                <div className="crumbs">
                  <button onClick={() => setSel({ archive: sel!.archive })}>{archive.name}</button>
                  {entry && <> / {entry.id}</>}
                  {entry && label(archive.name, entry.id) && <strong> · {label(archive.name, entry.id)}</strong>}
                  <span className="muted"> · {galleryFiles.length} files · {(archive.size / 1048576).toFixed(1)} MB</span>
                </div>
                <div className="gallery">
                  {galleryFiles.map((f) => (
                    <button key={f.key} className="card" onClick={() => setSel({ archive: sel!.archive, entry: f.id, file: f.key })}>
                      <Thumb file={f} />
                      <span className="mono">{f.path}</span>
                    </button>
                  ))}
                </div>
              </>
            ) : null}
          </main>
        </div>
      )}
      {dragging && <div className="drop-hint">Release to open</div>}
    </div>
  )
}
