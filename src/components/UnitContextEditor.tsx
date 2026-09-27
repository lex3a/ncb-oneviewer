import type { UnitContext } from '../effect/duel'
import type { Card, GameDb } from '../formats/gamedb'

interface Props {
  label: string
  card?: Card
  db?: GameDb
  value: UnitContext
  onChange: (v: UnitContext) => void
}

const num = (v: string) => Math.max(0, Math.min(99, Number(v) || 0))
const has = (c: Card | undefined, id: number) => !!c && c.abilities.includes(id)

/** The board state unitRecalcStats reads for one duel unit (docs/formats/rules.md). */
export function UnitContextEditor({ label, card, db, value, onChange }: Props) {
  const set = (patch: Partial<UnitContext>) => onChange({ ...value, ...patch })
  const bases = value.bases ?? {}
  const setBase = (k: keyof NonNullable<UnitContext['bases']>, v: string) => set({ bases: { ...bases, [k]: num(v) } })
  const attachable = db?.cards.filter((c) => c.type === 'spell' && c.abilities[1] === 1) ?? []
  const attached = value.attachments ?? []
  const toggle = (id: number) => set({ attachments: attached.includes(id) ? attached.filter((x) => x !== id) : [...attached, id].slice(0, 6) })
  const n = (v: number | undefined, key: 'supportAttack' | 'supportDefense' | 'copies', title: string, enabled: boolean) => (
    <label title={title} className={enabled ? '' : 'muted'}>
      {key === 'copies' ? 'copies' : key === 'supportAttack' ? 'S.Atk allies' : 'S.Def allies'}{' '}
      <input type="number" min={0} max={9} value={v ?? (key === 'copies' ? 1 : 0)} style={{ width: 44 }} onChange={(e) => set({ [key]: num(e.target.value) })} />
    </label>
  )
  return (
    <details className="ctx-editor">
      <summary>
        {label}: {card?.name ?? '—'} context
      </summary>
      <div className="ctx-grid">
        <label>
          HP{' '}
          <input
            type="number"
            min={0}
            max={card?.hp ?? 99}
            value={value.hp ?? card?.hp ?? 0}
            style={{ width: 50 }}
            onChange={(e) => set({ hp: Math.min(card?.hp ?? 99, num(e.target.value)) })}
          />
          <span className="muted"> / {card?.hp ?? '?'}</span>
        </label>
        <label title="The unit stands on land of its own attribute: +1 AP, +1 DF">
          <input type="checkbox" checked={!!value.land} onChange={(e) => set({ land: e.target.checked })} disabled={!card?.attribute} /> on own land
        </label>
        <label title="Player flag Breath of Hellgaia (2614): +1 AP, +1 DF">
          <input type="checkbox" checked={!!value.breath} onChange={(e) => set({ breath: e.target.checked })} /> Breath of Hellgaia
        </label>
        {n(value.supportAttack, 'supportAttack', 'Adjacent allies holding Support Attack (24): +1 AP each (abilityApplySupportAttack)', true)}
        {n(value.supportDefense, 'supportDefense', 'Adjacent allies holding Support Defense (1): +1 DF each (abilityApplySupportDefense)', true)}
        {n(value.copies, 'copies', 'Copies of this card on the board (Mutual Fight, ability 17)', has(card, 17))}
      </div>
      <div className="ctx-grid" title="Bases whose area covers this unit (ignored with Annul Base)">
        <span className="muted">bases in range:</span>
        {(
          [
            ['watchtower', 'Watchtower', 'enemy Goblin Watchtower: −1 AP, −1 DF'],
            ['shrine', 'Shrine', 'Elemental Shrine: +2 AP, +1 DF (units with an attribute)'],
            ['statue', 'Statue', 'own Statue of Hero: +1 AP, +1 DF'],
            ['fortress', 'Fortress', 'own Makeshift Fortress: +1 DF'],
          ] as const
        ).map(([k, l, t]) => (
          <label key={k} title={t}>
            {l}{' '}
            <input type="number" min={0} max={9} value={bases[k] ?? 0} style={{ width: 40 }} onChange={(e) => setBase(k, e.target.value)} />
          </label>
        ))}
      </div>
      {attachable.length > 0 && (
        <div className="ctx-grid">
          <span className="muted">attached:</span>
          {attachable.map((c) => (
            <label key={c.id} title={c.text}>
              <input type="checkbox" checked={attached.includes(c.id)} onChange={() => toggle(c.id)} /> {c.name}
            </label>
          ))}
        </div>
      )}
    </details>
  )
}
