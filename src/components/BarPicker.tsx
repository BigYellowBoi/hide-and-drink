import { useMemo, useState } from 'react'
import type { GameSync } from '../sync/engine'
import { describeError } from '../lobby/messages'
import { distanceM, type LngLat } from '../play/geo'
import type { Venue } from '../play/shading'
import { km } from '../play/state'
import { SlideToConfirm } from './SlideToConfirm'

interface Props {
  sync: GameSync
  /** Bars inside the play area. */
  venues: readonly Venue[]
  here: LngLat | null
  selected: Venue | null
  onSelect: (v: Venue | null) => void
  canAct: boolean
}

/**
 * Hider: lock in the bar for this round (once). Nearest first when GPS is on. Only bars
 * inside the play area are offered; the server checks again.
 */
export function BarPicker({ sync, venues, here, selected, onSelect, canAct }: Props) {
  const [filter, setFilter] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const list = useMemo(() => {
    const f = filter.trim().toLowerCase()
    return venues
      .filter((v) => !f || v.name.toLowerCase().includes(f))
      .map((v) => ({ ...v, d: here ? distanceM(here, v.point) : null }))
      .sort((a, b) => (a.d ?? 0) - (b.d ?? 0) || a.name.localeCompare(b.name))
      .slice(0, 40)
  }, [venues, filter, here])

  const lock = async () => {
    if (!selected) return
    setBusy(true)
    setErr(null)
    try {
      await sync.action('choose_bar', { p_venue_id: selected.id })
    } catch (e) {
      setErr(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card bar-picker">
      <p className="lock-label">🔒 Only you see this</p>
      <h2>Pick your bar</h2>
      <p className="muted small">Hide inside it or outdoors within 100 m. Tap one to preview its circle.</p>
      <input placeholder="Search bars" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <ul className="bar-list">
        {list.map((v) => (
          <li key={v.id}>
            <button
              className={`bar-row${selected?.id === v.id ? ' on' : ''}`}
              aria-pressed={selected?.id === v.id}
              onClick={() => onSelect(selected?.id === v.id ? null : v)}
            >
              <span>{v.name}</span>
              {v.d !== null && <span className="muted small">{km(v.d)}</span>}
            </button>
          </li>
        ))}
        {list.length === 0 && <li className="muted">No bars match.</li>}
      </ul>
      {selected && (
        <SlideToConfirm label={`Lock in ${selected.name}`} disabled={busy || !canAct} onConfirm={() => void lock()} />
      )}
      {err && <p className="bad">{err}</p>}
    </section>
  )
}
