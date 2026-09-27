import { useEffect, useMemo, useRef, useState } from 'react'
import { download } from '../export'
import {
  ATTRIBUTE_LABEL,
  CARD_TYPE_LABEL,
  charaIndex,
  spellAttachment,
  spellBattleUsable,
  type Card,
  type CardType,
  type GameDb,
} from '../formats/gamedb'
import type { OneArchive, OneFile } from '../formats/one'
import { CardScreenView } from './CardScreenView'
import { DeckEditorView } from './DeckEditorView'
import { MapBoards } from './MapBoards'
import { StoryView } from './StoryView'
import { WindowsView } from './WindowsView'
import { SoundCatalogView } from './SoundCatalogView'
import { ExtrasView } from './ExtrasView'
import { Thumb } from './Thumb'

type Tab = 'cards' | 'abilities' | 'decks' | 'deckEditor' | 'maps' | 'story' | 'windows' | 'extras' | 'sounds'
const TYPES: CardType[] = ['unit', 'chara', 'spell', 'base']
const oneLine = (s: string) => s.replace(/\n/g, ' ')

interface Props {
  db: GameDb
  archives: OneArchive[]
  onOpen: (archive: string, entry: number, file: string) => void
  loadFont?: () => Promise<Uint8Array | null>
  loadVoices?: () => Promise<Uint8Array | null>
  loadMusic?: (fileName: string) => Promise<Uint8Array | null>
}

/** Card / ability / deck tables from BOOT.BIN, with links to each card's images. */
export function DatabaseView({ db, archives, onOpen, loadFont, loadVoices, loadMusic }: Props) {
  const [tab, setTab] = useState<Tab>('cards')
  const [types, setTypes] = useState<Set<CardType>>(new Set(TYPES))
  const [query, setQuery] = useState('')
  const [selId, setSelId] = useState<number | null>(null)
  const [gameView, setGameView] = useState(false)
  const screenRef = useRef<HTMLDivElement>(null)
  const [scrollTo, setScrollTo] = useState(0)
  // A click in the table opens the card in the game view and brings the screen into sight.
  const openCard = (id: number) => {
    setSelId(id)
    setGameView(true)
    setScrollTo((n) => n + 1)
  }
  useEffect(() => {
    if (!scrollTo) return
    const el = screenRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    if (r.top < 0 || r.bottom > window.innerHeight) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [scrollTo])

  const cards = useMemo(() => {
    const q = query.trim().toLowerCase()
    return db.cards
      .filter((c) => types.has(c.type))
      .filter((c) => !q || String(c.id) === q || c.name.toLowerCase().includes(q) || c.text.toLowerCase().includes(q))
      .sort((a, b) => a.no - b.no)
  }, [db, types, query])
  const sel = selId !== null ? db.byId.get(selId) : undefined
  const cardName = (id: number) => db.byId.get(id)?.name ?? `#${id}`

  const exportJson = () => {
    const json = JSON.stringify({ cards: db.cards.map(({ nameCodes: _n, ...c }) => c), abilities: [...db.abilities.values()].map(({ nameCodes: _n, ...a }) => a), decks: db.decks, ladder: db.ladder }, null, 1)
    download(new TextEncoder().encode(json), 'ncb_database.json', 'application/json')
  }

  return (
    <div className="viewer">
      <div className="toolbar">
        <div className="seg" role="tablist">
          {(
            [
              ['cards', `Cards (${db.cards.length})`],
              ['abilities', `Abilities (${db.abilities.size})`],
              ['decks', `Decks (${db.decks.length})`],
              ['deckEditor', 'Deck editor'],
              ['maps', `Maps (${db.maps.length})`],
              ['story', `Story (${db.stories.length})`],
              ['windows', 'Windows'],
              ['sounds', 'Sounds'],
              ['extras', 'Extras'],
            ] as const
          ).map(([k, l]) => (
            <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
              {l}
            </button>
          ))}
        </div>
        <button onClick={exportJson}>Export JSON</button>
        {tab === 'cards' && (
          <>
            <div className="chips">
              {TYPES.map((t) => (
                <button
                  key={t}
                  className={types.has(t) ? 'on' : ''}
                  onClick={() =>
                    setTypes((s) => {
                      const n = new Set(s)
                      if (n.has(t)) n.delete(t)
                      else n.add(t)
                      return n
                    })
                  }
                >
                  {CARD_TYPE_LABEL[t]}
                </button>
              ))}
            </div>
            <input type="search" placeholder="name, text or id" value={query} onChange={(e) => setQuery(e.target.value)} />
            <button className={gameView ? 'on' : ''} onClick={() => setGameView((v) => !v)} title="The in-game card info screen (cardInfoDraw)">
              Game view
            </button>
          </>
        )}
      </div>

      {tab === 'cards' && (
        <div className="split">
          <div className="stage">
            {gameView && (sel ?? cards[0]) && (
              <div ref={screenRef}>
              <CardScreenView
                db={db}
                archives={archives}
                card={(sel ?? cards[0])!}
                loadFont={loadFont}
                nav={{
                  index: Math.max(0, cards.findIndex((c) => c.id === (sel ?? cards[0])!.id)),
                  count: cards.length,
                  onStep: (dir) => {
                    const i = Math.max(0, cards.findIndex((c) => c.id === (sel ?? cards[0])!.id))
                    const next = cards[Math.min(cards.length - 1, Math.max(0, i + dir))]
                    if (next) setSelId(next.id)
                  },
                }}
              />
              </div>
            )}
            <table className="grid db-grid">
              <thead>
                <tr>
                  <th>no</th>
                  <th>id</th>
                  <th className="left">name</th>
                  <th className="left">type</th>
                  <th>AP</th>
                  <th>HP</th>
                  <th>move</th>
                  <th>cost</th>
                  <th>soul</th>
                  <th>maint.</th>
                  <th className="left">attribute</th>
                  <th>rarity</th>
                  <th className="left">abilities / text</th>
                </tr>
              </thead>
              <tbody>
                {cards.map((c) => (
                  <tr key={c.id} className={c.id === selId ? 'on' : ''} onClick={() => openCard(c.id)}>
                    <td>{c.no}</td>
                    <td>{c.id}</td>
                    <td className="left">{c.name}</td>
                    <td className="left">{CARD_TYPE_LABEL[c.type]}</td>
                    <td>{c.type === 'spell' || c.type === 'base' ? '' : c.ap}</td>
                    <td>{c.type === 'spell' ? '' : c.hp}</td>
                    <td>{c.type === 'unit' || c.type === 'chara' ? c.move : ''}</td>
                    <td>{c.cost}</td>
                    <td>{c.soul || ''}</td>
                    <td>{c.maintenance || ''}</td>
                    <td className="left">{attributeText(c)}</td>
                    <td>{c.rarity || ''}</td>
                    <td className="left wrap">{c.type === 'spell' ? oneLine(c.text) : abilityNames(db, c).join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <aside className="side db-side">{sel ? <CardDetail db={db} card={sel} archives={archives} onOpen={onOpen} /> : <p className="muted">Pick a card.</p>}</aside>
        </div>
      )}

      {tab === 'abilities' && (
        <div className="scroll-pane">
          <table className="grid">
            <thead>
              <tr>
                <th>id</th>
                <th className="left">name</th>
                <th className="left">kind</th>
                <th>use cost</th>
                <th>use soul</th>
                <th>effect</th>
                <th className="left">description</th>
                <th className="left">cards</th>
              </tr>
            </thead>
            <tbody>
              {[...db.abilities.values()]
                .filter((a) => a.id)
                .sort((a, b) => a.id - b.id)
                .map((a) => {
                  const users = db.cards.filter((c) => c.type !== 'spell' && c.abilities.includes(a.id))
                  return (
                    <tr key={a.id}>
                      <td>{a.id}</td>
                      <td className="left">{a.name}</td>
                      <td className="left">{a.active ? 'activated' : 'passive'}</td>
                      <td>{a.active ? (a.useCost < 0 ? 'card cost' : a.useCost) : ''}</td>
                      <td>{a.active && a.useSoul ? a.useSoul : ''}</td>
                      <td>{a.effect || ''}</td>
                      <td className="left wrap">{oneLine(a.description)}</td>
                      <td className="left wrap">
                        {users.length > 6 ? `${users.length} cards` : users.map((c) => c.name).join(', ')}
                      </td>
                    </tr>
                  )
                })}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'maps' && <MapBoards db={db} archives={archives} loadFont={loadFont} />}
      {tab === 'deckEditor' && <DeckEditorView db={db} archives={archives} loadFont={loadFont} />}
      {tab === 'windows' && <WindowsView db={db} archives={archives} loadFont={loadFont} />}
      {tab === 'sounds' && <SoundCatalogView db={db} />}
      {tab === 'extras' && <ExtrasView db={db} archives={archives} loadFont={loadFont} loadVoices={loadVoices} />}
      {tab === 'story' && <StoryView db={db} archives={archives} loadFont={loadFont} loadVoices={loadVoices} loadMusic={loadMusic} />}

      {tab === 'decks' && (
        <div className="scroll-pane">
          <p className="muted">
            Ladder order: {db.ladder.map(cardName).join(' → ')}
          </p>
          <div className="deck-list">
            {db.decks.map((d) => (
              <div key={d.index} className="deck">
                <strong>
                  {d.index}. {d.name || '(no name)'}
                </strong>{' '}
                <span className="muted">— {cardName(d.dominator)}</span>
                <ul>
                  {countCards(d.cards).map(([id, n]) => (
                    <li key={id}>
                      {n > 1 && <span className="muted">{n}× </span>}
                      <button className="link" onClick={() => { setTab('cards'); setSelId(id) }}>
                        {cardName(id)}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function attributeText(c: Card): string {
  if (c.type === 'unit') return c.attribute ? ATTRIBUTE_LABEL[c.attribute] ?? String(c.attribute) : ''
  if (c.type === 'spell') return `icon ${c.attribute}`
  return ''
}

function abilityNames(db: GameDb, c: Card): string[] {
  if (c.type === 'spell') return []
  return c.abilities.filter(Boolean).map((id) => db.abilities.get(id)?.name ?? `#${id}`)
}

function countCards(ids: number[]): [number, number][] {
  const m = new Map<number, number>()
  for (const id of ids) if (id > 0) m.set(id, (m.get(id) ?? 0) + 1)
  return [...m]
}

/** Archives and entries that hold images of a card (docs/formats/database.md). */
function cardAssets(card: Card, archives: OneArchive[]): { archive: string; file: OneFile }[] {
  const out: { archive: string; file: OneFile }[] = []
  const take = (name: string, entryId: number, member?: number) => {
    const a = archives.find((x) => x.name.toLowerCase() === name)
    const e = a?.entries.find((x) => x.id === entryId)
    if (!a || !e) return
    for (const f of e.files) if (member === undefined || f.subId === member) out.push({ archive: a.name, file: f })
  }
  take('unit.one', card.id)
  take('card.one', card.id)
  if (card.type === 'unit' || card.type === 'chara') take('card.one', 10010, card.id)
  if (card.type === 'chara') {
    take('chara.one', card.id)
    take('chara.one', 1000, charaIndex(card.id))
  }
  return out
}

function CardDetail({ db, card, archives, onOpen }: { db: GameDb; card: Card; archives: OneArchive[]; onOpen: Props['onOpen'] }) {
  const assets = cardAssets(card, archives)
  const rows: [string, string | number][] = [
    ['id', card.id],
    ['card no', card.no],
    ['type', CARD_TYPE_LABEL[card.type]],
  ]
  if (card.type === 'unit' || card.type === 'chara') rows.push(['AP / HP', `${card.ap} / ${card.hp}`], ['move', card.move])
  if (card.type === 'base') rows.push(['HP', card.hp], ['area', card.range])
  rows.push(['cost', card.cost + (card.soul ? ` + ${card.soul} soul` : '')])
  if (card.maintenance) rows.push(['maintenance', card.maintenance])
  if (attributeText(card)) rows.push(['attribute', attributeText(card)])
  if (card.rarity) rows.push(['rarity', card.rarity])
  if (card.type === 'spell') {
    rows.push(['usable', [spellBattleUsable(card) && 'in battle', spellAttachment(card) && 'attaches to a unit'].filter(Boolean).join(', ') || 'on the map'])
  }
  const effects: [string, number][] = []
  if (card.battleEffect) effects.push([card.type === 'unit' || card.type === 'chara' ? 'attack effect' : 'battle effect', 1000 + card.battleEffect])
  if (card.mapEffect && card.type !== 'unit' && card.type !== 'chara') effects.push(['map effect', 1000 + card.mapEffect])
  const effectArchive = archives.find((a) => a.name.toLowerCase() === 'effect.one')

  return (
    <>
      <h3>{card.name}</h3>
      <dl className="props">
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {card.text && <p className="pre">{card.text}</p>}
      {abilityNames(db, card).length > 0 && (
        <ul className="plain">
          {card.abilities
            .filter(Boolean)
            .map((id) => db.abilities.get(id))
            .map((a, i) =>
              a ? (
                <li key={i}>
                  <strong>{a.name}</strong>
                  <div className="muted pre">{a.description}</div>
                </li>
              ) : null,
            )}
        </ul>
      )}
      {card.flavor && <p className="muted pre flavor">{card.flavor}</p>}
      {effects.length > 0 && (
        <dl className="props">
          {effects.map(([label, entry]) => {
            const script = effectArchive?.entries.find((e) => e.id === entry)?.files.find((f) => f.kind === 'cas')
            return (
              <div key={label} style={{ display: 'contents' }}>
                <dt>{label}</dt>
                <dd>
                  {script ? (
                    <button className="link" onClick={() => onOpen(effectArchive!.name, entry, script.key)} title="Open and play the effect script">
                      ▶ effect.one {entry}
                    </button>
                  ) : (
                    `effect.one ${entry}`
                  )}
                </dd>
              </div>
            )
          })}
        </dl>
      )}
      <h4>Images</h4>
      {assets.length ? (
        <div className="db-assets">
          {assets.map(({ archive, file }) => (
            <button key={archive + file.key} className="card" onClick={() => onOpen(archive, file.id, file.key)} title={`${archive} ${file.path}`}>
              <Thumb file={file} />
              <span className="mono">
                {archive.replace(/\.one$/i, '')} {file.path}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p className="muted">Load unit.one, card.one and chara.one to see them.</p>
      )}
    </>
  )
}
