import { useState } from 'react'
import {
  configGroups,
  defaultConfig,
  fromDisplay,
  parseLoose,
  setIn,
  toDisplay,
  type ConfigField,
} from '../lobby/config'

interface Props {
  config: Record<string, unknown>
  editable: boolean
  busy: boolean
  onSave: (config: Record<string, unknown>) => Promise<boolean>
}

function display(f: ConfigField): string {
  if (f.value === null || f.value === undefined) return 'not set'
  if (typeof f.value === 'number') return `${toDisplay(f.value, f.unit)}${f.unit ? ` ${f.unit}` : ''}`
  if (typeof f.value === 'boolean') return f.value ? 'yes' : 'no'
  if (Array.isArray(f.value)) return f.value.join(', ')
  return String(f.value)
}

function FieldInput({ field, onChange }: { field: ConfigField; onChange: (v: unknown) => void }) {
  const id = `cfg-${field.path.join('-')}`
  switch (field.kind) {
    case 'boolean':
      return (
        <label className="toggle" htmlFor={id}>
          <input id={id} type="checkbox" checked={field.value === true} onChange={(e) => onChange(e.target.checked)} />
          <span>{field.label}</span>
        </label>
      )
    case 'number':
      return (
        <label className="field" htmlFor={id}>
          <span>
            {field.label}
            {field.unit && <span className="muted"> ({field.unit})</span>}
          </span>
          <input
            id={id}
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            placeholder="not set"
            value={typeof field.value === 'number' ? toDisplay(field.value, field.unit) : ''}
            onChange={(e) => {
              const t = e.target.value
              onChange(t === '' ? null : fromDisplay(Number(t), field.unit))
            }}
          />
        </label>
      )
    case 'list':
      return (
        <label className="field" htmlFor={id}>
          <span>
            {field.label} <span className="muted">(comma separated)</span>
          </span>
          <input
            id={id}
            value={(field.value as string[]).join(', ')}
            onChange={(e) =>
              onChange(
                e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              )
            }
          />
        </label>
      )
    case 'unset':
      return (
        <label className="field" htmlFor={id}>
          <span>{field.label}</span>
          <input id={id} placeholder="not set" defaultValue="" onBlur={(e) => onChange(parseLoose(e.target.value))} />
        </label>
      )
    default:
      return (
        <label className="field" htmlFor={id}>
          <span>{field.label}</span>
          <input id={id} value={String(field.value ?? '')} onChange={(e) => onChange(e.target.value)} />
        </label>
      )
  }
}

/** Generic editor for the game config: fields come from the data, not from code. */
export function ConfigEditor({ config, editable, busy, onSave }: Props) {
  // null = showing the server's config; an object = local edits not yet saved.
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null)
  const shown = draft ?? config
  const groups = configGroups(shown)

  return (
    <div className="config">
      {groups.map((g) => (
        <fieldset key={g.path.join('.') || 'root'} className="config-group">
          <legend>{g.title}</legend>
          {g.notes.map((n) => (
            <p key={n} className="note">
              {n}
            </p>
          ))}
          {g.fields.map((f) =>
            editable ? (
              <FieldInput key={f.path.join('.')} field={f} onChange={(v) => setDraft(setIn(shown, f.path, v))} />
            ) : (
              <p key={f.path.join('.')} className="config-row">
                <span>{f.label}</span>
                <span>{display(f)}</span>
              </p>
            ),
          )}
        </fieldset>
      ))}
      {editable && (
        <div className="row">
          <button
            disabled={busy || !draft}
            onClick={async () => {
              if (draft && (await onSave(draft))) setDraft(null)
            }}
          >
            Save settings
          </button>
          <button className="secondary" disabled={busy || !draft} onClick={() => setDraft(null)}>
            Discard
          </button>
          <button className="secondary" disabled={busy} onClick={() => setDraft(defaultConfig)}>
            Defaults
          </button>
        </div>
      )}
    </div>
  )
}
