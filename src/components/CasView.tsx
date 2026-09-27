import { useMemo, useState } from 'react'
import { download } from '../export'
import { CAS_OPS, parseCas, type CasInstr } from '../formats/cas'
import { decompileCas } from '../formats/casDecompile'
import { CAS_FUNCS, casFuncName } from '../formats/casNames'
import type { GameDb } from '../formats/gamedb'
import type { OneArchive } from '../formats/one'
import { EffectPlayer } from './EffectPlayer'
import { HexView } from './HexView'

type Tab = 'play' | 'code' | 'asm' | 'data'
const h = (n: number, w = 2) => n.toString(16).padStart(w, '0')
const baseName = (p: string) => p.split('\\').pop() ?? p

function operand(i: CasInstr, strings: string[]): string {
  switch (i.op) {
    case 0x01:
      return casFuncName(i.arg)
    case 0x02:
      return `${i.arg >>> 16 === 0x21 ? 'float' : 'int'} global #${i.arg & 0xffff}`
    case 0x04:
      return `→ ${i.arg}`
    case 0x10:
      return String(i.arg | 0)
    case 0x20:
      return String(+i.argFloat.toPrecision(7))
    case 0x30:
      return strings[i.arg] !== undefined ? `#${i.arg} ${JSON.stringify(strings[i.arg])}` : `#${i.arg}`
    case 0x60:
      return `L${i.arg}`
    default:
      return i.arg ? `0x${h(i.arg, 8)}` : ''
  }
}

interface Props {
  data: Uint8Array
  name: string
  /** effect.one, when the script comes from it: enables the player. */
  archive?: OneArchive
  loadSe?: () => Promise<Uint8Array | null>
  /** All loaded archives (the duel scene reads etc.one and unit.one). */
  archives?: OneArchive[]
  entryId?: number
  loadFont?: () => Promise<Uint8Array | null>
  db?: GameDb
}

export function CasView({ data, name, archive, loadSe, archives, db, entryId, loadFont }: Props) {
  const cas = useMemo(() => parseCas(data), [data])
  const code = useMemo(() => decompileCas(cas), [cas])
  const [limit, setLimit] = useState(1500)
  const [tab, setTab] = useState<Tab>(archive ? 'play' : 'code')

  return (
    <div className="viewer">
      <div className="toolbar">
        <div className="seg" role="tablist">
          {(
            [
              ...(archive ? ([['play', 'Play']] as const) : []),
              ['code', 'Pseudo-code'],
              ['asm', 'Disassembly'],
              ['data', 'Data & sources'],
            ] as const
          ).map(([k, l]) => (
            <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
              {l}
            </button>
          ))}
        </div>
        <button onClick={() => download(data, `${name}.cas`)}>Raw</button>
        <span className="muted">
          {cas.instrs.length} instructions · {cas.strings.length} strings · {cas.globals.length / 4} globals
        </span>
      </div>
      {tab === 'play' && archive && <EffectPlayer data={data} name={name} archive={archive} loadSe={loadSe} archives={archives ?? []} db={db} entryId={entryId ?? 0} loadFont={loadFont} />}
      <div className="scroll-pane" hidden={tab === 'play'}>
        {tab === 'code' && (
          <>
            <p className="muted">
              Reconstructed from the stack code. g/gf = int/float globals, li/lf = thread locals, argi/argf/args =
              function arguments. /*?*/ marks calls whose argument count is unknown.
            </p>
            <pre className="cas-code">
              {code.slice(0, limit).map((l, i) => (
                <div key={i} className={l.label ? 'label' : ''}>
                  <span className="ln">{l.label ? '' : l.line}</span>
                  {l.label ? l.text : `    ${l.text}`}
                </div>
              ))}
            </pre>
            {limit < code.length && <button onClick={() => setLimit((l) => l + 3000)}>Show more</button>}
          </>
        )}
        {tab === 'asm' && (
          <>
            <table className="grid mono cas">
              <thead>
                <tr>
                  <th>#</th><th>source</th><th>op</th><th>operand</th><th>raw arg</th>
                </tr>
              </thead>
              <tbody>
                {cas.instrs.slice(0, limit).map((i) => (
                  <tr key={i.index} className={i.op === 0x60 ? 'label' : ''}>
                    <td>{i.index}</td>
                    <td className="left muted">
                      {baseName(cas.files[i.file] ?? `file${i.file}`)}:{i.line}
                    </td>
                    <td className="left">{CAS_OPS[i.op] ?? `op_${h(i.op)}`}</td>
                    <td className="left" title={i.op === 1 ? CAS_FUNCS[i.arg]?.args : undefined}>
                      {operand(i, cas.strings)}
                    </td>
                    <td className="muted">{h(i.arg, 8)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {limit < cas.instrs.length && <button onClick={() => setLimit((l) => l + 3000)}>Show more</button>}
          </>
        )}
        {tab === 'data' && (
          <>
            <h4>Source files (debug info)</h4>
            <ol start={0} className="mono">
              {cas.files.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ol>
            <h4>Strings</h4>
            {cas.strings.length ? (
              <ol start={0} className="mono">
                {cas.strings.map((s, i) => (
                  <li key={i}>{JSON.stringify(s)}</li>
                ))}
              </ol>
            ) : (
              <p className="muted">none</p>
            )}
            <h4>Globals (initial values)</h4>
            {cas.globals.length ? <HexView data={cas.globals} base={cas.globalsOffset} /> : <p className="muted">none</p>}
          </>
        )}
      </div>
    </div>
  )
}
