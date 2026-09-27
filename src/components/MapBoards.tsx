import { useEffect, useMemo, useRef, useState } from 'react'
import { AREA_NAMES, CARD_TYPE_LABEL, rewardOdds, rewardWeight, type GameDb, type MapBoard } from '../formats/gamedb'
import type { OneArchive } from '../formats/one'
import { MapBoardView } from './MapBoardView'
import { Thumb } from './Thumb'

/** Square colours: plain, earth, water, fire, air (the ＠ｍ1..4 attribute icons' hues). */
const LAND_COLORS = ['#9a9a8c', '#a8742f', '#2f7fd0', '#d8452c', '#3fb06b']
const LAND_NAMES = ['plain', 'earth', 'water', 'fire', 'air']
const START_COLORS = ['#1e5cff', '#ff2f5a']

function BoardCanvas({ map, cell }: { map: MapBoard; cell: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const ctx = c.getContext('2d')!
    ctx.clearRect(0, 0, c.width, c.height)
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const v = map.land[y * 40 + x]
        if (v < 0) continue
        ctx.fillStyle = LAND_COLORS[v] ?? '#fff'
        ctx.fillRect(x * cell, y * cell, cell - 1, cell - 1)
      }
    }
    map.starts.forEach(([x, y], p) => {
      ctx.fillStyle = START_COLORS[p]
      ctx.beginPath()
      ctx.arc(x * cell + (cell - 1) / 2, y * cell + (cell - 1) / 2, Math.max(2, cell * 0.38), 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = Math.max(1, cell / 8)
      ctx.stroke()
    })
  }, [map, cell])
  return <canvas ref={ref} width={map.width * cell} height={map.height * cell} className="board-canvas" />
}

/** duelRollRewardCards odds against one opponent: 5–10 cards after a win, 1–3 after a loss. */
function Rewards({ db, opponent }: { db: GameDb; opponent: number }) {
  // the simulation takes ~0.1 s per opponent: run it after the switch has painted (results are cached in rewardOdds)
  const [odds, setOdds] = useState<{ opponent: number; win: Map<number, number>; loss: Map<number, number> } | null>(null)
  useEffect(() => {
    const id = setTimeout(() => setOdds({ opponent, win: rewardOdds(db, opponent, true), loss: rewardOdds(db, opponent, false) }), 16)
    return () => clearTimeout(id)
  }, [db, opponent])
  const ready = odds?.opponent === opponent ? odds : null
  const rows = useMemo(() => {
    const list = db.rewards
      .map((r) => ({ card: db.byId.get(r.cardId), w: rewardWeight(r, opponent), win: ready?.win.get(r.cardId) ?? 0, loss: ready?.loss.get(r.cardId) ?? 0 }))
      .filter((r) => r.w > 0)
    return list.sort((a, b) => b.win - a.win || b.w - a.w)
  }, [db, opponent, ready])
  const pct = (p: number) => (!ready ? '…' : p >= 0.001 ? `${(p * 100).toFixed(1)} %` : p > 0 ? '< 0.1 %' : '≈ 0')
  return (
    <>
      <h4>Card rewards ({rows.length} cards can drop)</h4>
      <p className="muted small">
        Each card scores weight × random 1–100; the best 5–10 (win) or 1–3 (loss) are awarded. Simulated 20 000 times, without
        the rare bonus and without cards already owned 10 times.
      </p>
      <table className="grid small">
        <thead>
          <tr>
            <th className="left">card</th>
            <th className="left">type</th>
            <th>weight</th>
            <th>win</th>
            <th>loss</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.card?.id}>
              <td className="left">{r.card?.name}</td>
              <td className="left">{r.card ? CARD_TYPE_LABEL[r.card.type] : ''}</td>
              <td>{r.w}</td>
              <td>{pct(r.win)}</td>
              <td>{pct(r.loss)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

/** The 16 boards of g_mapTerrainTable (docs/formats/rules.md), with their stage and opponent. */
export function MapBoards({ db, archives, loadFont }: { db: GameDb; archives: OneArchive[]; loadFont?: () => Promise<Uint8Array | null> }) {
  const maps = useMemo(() => [...db.maps].sort((a, b) => a.stage - b.stage), [db])
  const [sel, setSel] = useState(0)
  const [view, setView] = useState<'flat' | 'game'>('flat')
  const m = maps[sel]
  const mapOne = archives.find((a) => a.name.toLowerCase() === 'map.one')
  const bg = m ? mapOne?.entries.filter((e) => Math.floor(e.id / 100) === m.area * 10 + m.variant).flatMap((e) => e.files) ?? [] : []
  if (!m) return <p className="muted">No boards in this executable.</p>
  return (
    <div className="split">
      <div className="stage">
        <div className="seg" role="group" aria-label="Board view" style={{ marginBottom: 10 }}>
          <button className={view === 'flat' ? 'on' : ''} onClick={() => setView('flat')}>
            Flat
          </button>
          <button className={view === 'game' ? 'on' : ''} onClick={() => setView('game')} title="mapBoardScene: the game camera, tiles, scenery and tokens">
            Game view
          </button>
        </div>
        {view === 'game' && <MapBoardView db={db} archives={archives} board={m} loadFont={loadFont} />}
        <div className="board-list">
          {maps.map((b, i) => (
            <button key={`${b.area}-${b.variant}`} className={`card${i === sel ? ' on' : ''}`} onClick={() => setSel(i)}>
              <BoardCanvas map={b} cell={5} />
              <span className="small">
                Stage {b.stage} · {AREA_NAMES[b.area]}
                {b.variant ? ' B' : ''}
              </span>
            </button>
          ))}
        </div>
      </div>
      <aside className="side db-side">
        <h3>
          Stage {m.stage}: {AREA_NAMES[m.area]} {m.variant ? '(Block B)' : '(Block A)'}
        </h3>
        <BoardCanvas map={m} cell={Math.max(6, Math.min(14, Math.floor(300 / Math.max(m.width, m.height))))} />
        <dl className="props">
          <dt>opponent</dt>
          <dd>{db.byId.get(m.opponent)?.name ?? m.opponent}</dd>
          <dt>size</dt>
          <dd>
            {m.width} × {m.height}
          </dd>
          <dt>squares</dt>
          <dd>{m.squares}</dd>
          <dt>conquest goal</dt>
          <dd>{m.goal} squares (80 %)</dd>
          <dt>attributes</dt>
          <dd>{m.attrCounts.map((n, i) => `${LAND_NAMES[i + 1]} ${n}`).join(', ')}</dd>
          <dt>starts</dt>
          <dd>
            <span style={{ color: START_COLORS[0] }}>●</span> player ({m.starts[0].join(', ')}) · <span style={{ color: START_COLORS[1] }}>●</span> opponent ({m.starts[1].join(', ')})
          </dd>
        </dl>
        <div className="legend small">
          {LAND_NAMES.map((n, i) => (
            <span key={n}>
              <i style={{ background: LAND_COLORS[i] }} /> {n}
            </span>
          ))}
        </div>
        {m.opponent >= 1002 && <Rewards db={db} opponent={m.opponent} />}
        <h4>Scenery (map.one {m.area * 1000 + m.variant * 100}…)</h4>
        {bg.length ? (
          <div className="db-assets">
            {bg.map((f) => (
              <div key={f.key} className="card">
                <Thumb file={f} />
                <span className="mono small">{f.path}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">Load map.one to see the background.</p>
        )}
      </aside>
    </div>
  )
}
