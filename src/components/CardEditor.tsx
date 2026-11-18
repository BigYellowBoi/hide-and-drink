import { useEffect, useMemo, useState } from 'react'
import {
  draftOf,
  saveCard,
  setCardActive,
  toCardDef,
  type CardDraft,
  type CastCost,
  type LibraryCard,
  type LibraryCategory,
} from '../library/library'
import { BEHAVIOURS, buildParams, fieldsFor, otherParams, paramProblem, type ParamField } from '../library/params'
import { describeError } from '../lobby/messages'
import type { SyncTransport } from '../sync/transport'
import { CardFace } from './CardFace'
import { Stepper } from './Stepper'

interface Props {
  transport: SyncTransport
  /** null = a new card. */
  card: LibraryCard | null
  categories: LibraryCategory[]
  /** Category a new card starts in. */
  defaultCategory?: string
  onClose: () => void
  onSaved?: (id: string, draft: CardDraft, isNew: boolean) => void
}

const COSTS: { value: CastCost | null; label: string }[] = [
  { value: null, label: 'None' },
  { value: 'free', label: 'Free' },
  { value: 'drink', label: 'Drink' },
  { value: 'shot', label: 'Shot' },
]

const blank = (category: string): CardDraft => ({
  name: '',
  category,
  behaviour: 'text',
  text: '',
  params: {},
  castCost: null,
  canVeto: null,
  copies: 1,
})

const toMinutes = (s: unknown) => (typeof s === 'number' ? Math.round((s / 60) * 100) / 100 : '')

function ParamInput({ field, value, onChange }: { field: ParamField; value: unknown; onChange: (v: unknown) => void }) {
  const id = `param-${field.key}`
  const label = (
    <span>
      {field.label}
      {field.kind === 'minutes' && <span className="muted"> (min)</span>}
      {field.hint && <span className="muted"> · {field.hint}</span>}
    </span>
  )
  switch (field.kind) {
    case 'bool':
      return (
        <label className="toggle" htmlFor={id}>
          <input id={id} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
          <span>{field.label}</span>
        </label>
      )
    case 'select':
      return (
        <label className="field" htmlFor={id}>
          {label}
          <select id={id} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value || undefined)}>
            <option value="">{field.required ? 'Choose…' : 'None'}</option>
            {field.options!.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      )
    case 'teams': {
      const list = Array.isArray(value) ? (value as string[]) : []
      const flip = (t: string) => onChange(list.includes(t) ? list.filter((x) => x !== t) : [...list, t])
      return (
        <fieldset className="field param-teams">
          {label}
          <div className="row">
            {['hiders', 'seekers'].map((t) => (
              <label key={t} className="toggle">
                <input type="checkbox" checked={list.includes(t)} onChange={() => flip(t)} />
                <span>{t === 'hiders' ? 'Hiders' : 'Seekers'}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )
    }
    case 'lines':
      return (
        <label className="field" htmlFor={id}>
          {label}
          <textarea
            id={id}
            rows={4}
            value={Array.isArray(value) ? value.join('\n') : ''}
            onChange={(e) => onChange(e.target.value.split('\n').map((s) => s.trim()).filter(Boolean))}
          />
        </label>
      )
    case 'text':
      return (
        <label className="field" htmlFor={id}>
          {label}
          <input id={id} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value || undefined)} />
        </label>
      )
    default:
      return (
        <label className="field" htmlFor={id}>
          {label}
          <input
            id={id}
            type="number"
            inputMode="decimal"
            min={0}
            step={field.kind === 'int' ? 1 : 'any'}
            value={field.kind === 'minutes' ? toMinutes(value) : typeof value === 'number' ? value : ''}
            onChange={(e) => {
              const t = e.target.value
              if (t === '') return onChange(undefined)
              const n = Number(t)
              onChange(field.kind === 'minutes' ? Math.round(n * 60) : n)
            }}
          />
        </label>
      )
  }
}

/** Add or edit a library card. Saves go live to every phone; started games keep their copy. */
export function CardEditor({ transport, card, categories, defaultCategory, onClose, onSaved }: Props) {
  const active = categories.filter((c) => c.active)
  const [draft, setDraft] = useState<CardDraft>(() =>
    card ? draftOf(card) : blank(defaultCategory && active.some((c) => c.id === defaultCategory) ? defaultCategory : (active[0]?.id ?? '')),
  )
  const [otherText, setOtherText] = useState(() => {
    const o = otherParams(card?.params ?? {})
    return Object.keys(o).length ? JSON.stringify(o, null, 2) : ''
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [arming, setArming] = useState(false)

  useEffect(() => {
    document.documentElement.classList.add('scroll-locked')
    return () => document.documentElement.classList.remove('scroll-locked')
  }, [])
  useEffect(() => {
    if (!arming) return
    const t = setTimeout(() => setArming(false), 3000)
    return () => clearTimeout(t)
  }, [arming])

  const other = useMemo((): Record<string, unknown> | null => {
    if (!otherText.trim()) return {}
    try {
      const v: unknown = JSON.parse(otherText)
      return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
    } catch {
      return null
    }
  }, [otherText])

  const params = buildParams(draft.behaviour, draft.params, other ?? {})
  const problem = !draft.name.trim()
    ? 'Give the card a name.'
    : !draft.category
      ? 'Pick a category.'
      : other === null
        ? 'Other settings must be a JSON object, like {"radius_m": 150}.'
        : paramProblem(draft.behaviour, draft.params)

  const preview = toCardDef(
    {
      id: card?.id ?? 'new',
      ...draft,
      name: draft.name.trim() || 'New card',
      text: draft.text.trim() || null,
      params,
      sort: 0,
      active: true,
      updatedByName: null,
      updatedAt: '',
    },
    categories,
  )

  const set = (patch: Partial<CardDraft>) => setDraft((d) => ({ ...d, ...patch }))
  const setParam = (key: string, v: unknown) =>
    setDraft((d) => {
      const next = { ...d.params }
      if (v === undefined) delete next[key]
      else next[key] = v
      return { ...d, params: next }
    })

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setErr(null)
    try {
      await fn()
    } catch (e) {
      setErr(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  const save = () =>
    run(async () => {
      const full = { ...draft, params }
      const id = await saveCard(transport, card?.id ?? null, full, card?.updatedAt || null)
      onSaved?.(id, full, !card)
      onClose()
    })

  const toggleActive = () => {
    if (!card) return
    if (card.active && !arming) return setArming(true)
    setArming(false)
    void run(async () => {
      await setCardActive(transport, card.id, !card.active)
      onClose()
    })
  }

  const fields = fieldsFor(draft.behaviour).filter((f) => !f.when || f.when(draft.params))
  const behaviour = BEHAVIOURS.find((b) => b.id === draft.behaviour)

  return (
    <div className="sheet-page" role="dialog" aria-label={card ? `Edit ${card.name}` : 'New card'}>
      <header className="editor-bar">
        <button className="small secondary" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <span className="editor-title">{card ? 'Edit card' : 'New card'}</span>
        <button className="small" onClick={() => void save()} disabled={busy || !!problem}>
          Save
        </button>
      </header>
      <div className="sheet-page-body">
        <div className="card-preview">
          <CardFace card={preview} />
        </div>
        {card && (
          <p className="muted small-note">
            {card.updatedByName ? `Last edited by ${card.updatedByName}` : 'From the original deck'}
            {!card.active && ' · Retired'}
          </p>
        )}

        <section className="card">
          <label className="field" htmlFor="card-name">
            <span>Name</span>
            <input id="card-name" value={draft.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} />
          </label>
          <label className="field" htmlFor="card-category">
            <span>Category</span>
            <select id="card-category" value={draft.category} onChange={(e) => set({ category: e.target.value })}>
              {!active.some((c) => c.id === draft.category) && <option value={draft.category}>{draft.category || 'Choose…'}</option>}
              {active.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field" htmlFor="card-text">
            <span>Text</span>
            <textarea id="card-text" rows={4} maxLength={2000} value={draft.text} onChange={(e) => set({ text: e.target.value })} />
          </label>
          <div className="field">
            <span>Cast cost</span>
            <div className="segmented segmented-4">
              {COSTS.map((c) => (
                <button
                  key={c.label}
                  type="button"
                  className={draft.castCost === c.value ? 'on' : ''}
                  aria-pressed={draft.castCost === c.value}
                  onClick={() => set({ castCost: c.value })}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>
          <label className="toggle" htmlFor="card-veto">
            <input
              id="card-veto"
              type="checkbox"
              checked={draft.canVeto === true}
              onChange={(e) => set({ canVeto: e.target.checked })}
            />
            <span>Seekers can veto it (curses)</span>
          </label>
          <div className="field">
            <span>Copies in a default deck</span>
            <Stepper value={draft.copies} onChange={(n) => set({ copies: n })} label="default copies" />
          </div>
        </section>

        <section className="card">
          <label className="field" htmlFor="card-behaviour">
            <span>What the app does with it</span>
            <select id="card-behaviour" value={draft.behaviour} onChange={(e) => set({ behaviour: e.target.value })}>
              {BEHAVIOURS.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </select>
          </label>
          {behaviour && <p className="muted small-note">{behaviour.hint}</p>}
          {fields.map((f) => (
            <ParamInput key={f.key} field={f} value={draft.params[f.key]} onChange={(v) => setParam(f.key, v)} />
          ))}
          <label className="field" htmlFor="card-other">
            <span>
              Other settings <span className="muted">(JSON, kept as is)</span>
            </span>
            <textarea
              id="card-other"
              className="mono"
              rows={3}
              placeholder="{}"
              value={otherText}
              onChange={(e) => setOtherText(e.target.value)}
            />
          </label>
        </section>

        {problem && draft.name.trim() && <p className="bad small-note">{problem}</p>}
        {err && (
          <p className="bad small-note" role="alert">
            {err}
          </p>
        )}

        {card && (
          <button
            className={`wide secondary${arming ? ' danger' : ''}`}
            disabled={busy}
            onClick={toggleActive}
            onBlur={() => setArming(false)}
          >
            {card.active ? (arming ? 'Tap again to retire' : 'Retire card') : 'Restore card'}
          </button>
        )}
        {card?.active && (
          <p className="muted small-note">Retired cards leave the library and new decks. Nothing is deleted: restore it any time.</p>
        )}
      </div>
    </div>
  )
}
