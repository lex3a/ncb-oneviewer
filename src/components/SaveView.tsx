import { useMemo, useState } from 'react'
import { download } from '../export'
import { AREA_NAMES, CARD_TYPE_LABEL, type GameDb } from '../formats/gamedb'
import { parseSave } from '../formats/save'
import { HexView } from './HexView'

type Tab = 'summary' | 'collection' | 'decks'
const STAGES = 18

/** A decrypted CADATA.SAV: profile, cleared stages, collection and decks. */
export function SaveView({ data, name, db }: { data: Uint8Array; name: string; db?: GameDb }) {
  const parsed = useMemo(() => {
    try {
      return { save: parseSave(data), error: null }
    } catch (e) {
      return { save: null, error: (e as Error).message }
    }
  }, [data])
  const [tab, setTab] = useState<Tab>('summary')
  const [owned, setOwned] = useState(true)
  const save = parsed.save
  if (!save) {
    return (
      <div className="scroll-pane">
        <p className="warn">{parsed.error}</p>
        <p className="muted">
          Decrypt it first with the game key <span className="mono">aOiupxRNZIFU2m6Q</span> (a PSP save tool), or export it from PPSSPP
          with save-data encryption turned off.
        </p>
        <button onClick={() => download(data, name)}>Download</button>
        <HexView data={data} />
      </div>
    )
  }
  const p = save.profile
  const byNo = new Map(db?.cards.map((c) => [c.no, c]) ?? [])
  const cardName = (id: number) => db?.byId.get(id)?.name ?? `#${id}`
  const stageInfo = (s: number) => {
    const m = db?.maps.find((x) => x.stage === s)
    return m ? `${AREA_NAMES[m.area]}${m.variant ? ' B' : ''} · ${cardName(m.opponent)}` : s === 16 ? 'Hellgaia rematch (unreachable)' : s === 18 ? `Shadow Heaven Ship B · ${cardName(1021)}` : ''
  }
  const kinds = p.cardCount.slice(1, 207).filter((c) => c > 0).length
  const total = p.cardCount.slice(1, 207).reduce((a, c) => a + c, 0)
  const wins = p.charaWins.reduce((a, c) => a + c, 0)
  const battles = p.charaBattles.reduce((a, c) => a + c, 0)
  const pt = save.header.playTime

  return (
    <div className="viewer">
      <div className="toolbar">
        <div className="seg">
          {(
            [
              ['summary', 'Summary'],
              ['collection', `Collection (${kinds}/206)`],
              ['decks', 'Decks'],
            ] as const
          ).map(([k, l]) => (
            <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
              {l}
            </button>
          ))}
        </div>
        <button onClick={() => download(data, name)}>Download</button>
        <span className="muted">{save.kind === 'game' ? 'game data (0x494 bytes)' : 'continue save (0x287CC bytes)'}</span>
      </div>
      <div className="scroll-pane">
        {save.warnings.length > 0 && <p className="warn">Check: {save.warnings.join('; ')}</p>}
        {!db && <p className="muted">Load BOOT.BIN (or the ISO) to see card and stage names.</p>}

        {tab === 'summary' && (
          <>
            <dl className="props">
              <dt>player</dt>
              <dd>{p.name || '(no name)'}</dd>
              <dt>cards</dt>
              <dd>
                {total} ({kinds} kinds, {Math.floor((kinds * 100) / 206)} % of 206)
              </dd>
              <dt>battles</dt>
              <dd>
                {wins} won of {battles}
                {battles ? ` (${Math.floor((wins * 100) / battles)} %)` : ''}
              </dd>
              <dt>current deck</dt>
              <dd>
                {p.curDeckSlot}. {save.decks[p.curDeckSlot - 1]?.name}
              </dd>
              <dt>play time</dt>
              <dd>{pt ? `${pt >>> 20}:${String((pt >> 14) & 63).padStart(2, '0')}:${String((pt >> 8) & 63).padStart(2, '0')}` : '— (the game never counts it)'}</dd>
              {save.battle && (
                <>
                  <dt>suspended battle</dt>
                  <dd>
                    stage {save.battle.stage}, {AREA_NAMES[save.battle.area]}
                    {save.battle.variant ? ' B' : ''}, round {save.battle.round}, {save.battle.turnPlayer ? "opponent's" : "player's"} turn
                    {save.battle.mode === 0 ? ' (versus)' : save.battle.mode === 2 ? ' (free battle)' : ''}
                  </dd>
                </>
              )}
            </dl>
            <h4>Stages</h4>
            <table className="grid">
              <thead>
                <tr>
                  <th>stage</th>
                  <th className="left">cleared</th>
                  <th className="left">board · opponent</th>
                  <th>battles</th>
                  <th>wins</th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: STAGES }, (_, i) => i + 1).map((s) => (
                  <tr key={s}>
                    <td>{s}</td>
                    <td className="left">{p.stageClearMask & (1 << (s - 1)) ? '✓' : ''}</td>
                    <td className="left">{stageInfo(s)}</td>
                    <td>{p.mapBattles[Math.min(s, 17) - 1] || ''}</td>
                    <td>{p.mapWins[Math.min(s, 17) - 1] || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {db && (
              <>
                <h4>Opponents</h4>
                <table className="grid">
                  <thead>
                    <tr>
                      <th className="left">opponent</th>
                      <th>battles</th>
                      <th>wins</th>
                    </tr>
                  </thead>
                  <tbody>
                    {db.ladder.map((id, i) =>
                      p.charaBattles[i] ? (
                        <tr key={i}>
                          <td className="left">{cardName(id)}</td>
                          <td>{p.charaBattles[i]}</td>
                          <td>{p.charaWins[i]}</td>
                        </tr>
                      ) : null,
                    )}
                  </tbody>
                </table>
              </>
            )}
          </>
        )}

        {tab === 'collection' && (
          <>
            <label>
              <input type="checkbox" checked={owned} onChange={(e) => setOwned(e.target.checked)} /> owned only
            </label>
            <table className="grid" style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th>no</th>
                  <th className="left">card</th>
                  <th className="left">type</th>
                  <th>copies</th>
                  <th className="left">new</th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: 206 }, (_, i) => i + 1)
                  .filter((i) => !owned || p.cardCount[i] > 0)
                  .map((i) => {
                    const c = byNo.get(i)
                    return (
                      <tr key={i}>
                        <td>{i}</td>
                        <td className="left">{c?.name ?? ''}</td>
                        <td className="left">{c ? CARD_TYPE_LABEL[c.type] : ''}</td>
                        <td>{p.cardCount[i]}</td>
                        <td className="left">{p.newFlags[i] ? 'NEW' : ''}</td>
                      </tr>
                    )
                  })}
              </tbody>
            </table>
          </>
        )}

        {tab === 'decks' && (
          <div className="deck-list">
            {save.decks.map((d, i) => (
              <div key={i} className="deck">
                <strong>
                  {i + 1}. {d.name || '(empty)'}
                </strong>
                {d.name && (
                  <>
                    {' '}
                    <span className="muted">— {cardName(d.dominator)}</span>
                    <ul>
                      {[...d.cards.reduce((m, id) => (id > 0 ? m.set(id, (m.get(id) ?? 0) + 1) : m), new Map<number, number>())].map(([id, n]) => (
                        <li key={id}>
                          {n > 1 && <span className="muted">{n}× </span>}
                          {cardName(id)}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
