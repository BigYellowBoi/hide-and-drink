import { useState } from 'react'
import {
  changedSettings,
  clampToInput,
  defaultOf,
  formatAmount,
  formatValue,
  GROUPS,
  isChanged,
  resetAll,
  resetSetting,
  setIn,
  SETTINGS,
  validateConfig,
  valueOf,
  type Setting,
} from '../lobby/config'
import { InfoIcon } from './InfoIcon'
import { Stepper } from './Stepper'

interface Props {
  config: Record<string, unknown>
  editable: boolean
  busy: boolean
  onSave: (config: Record<string, unknown>) => Promise<boolean>
}

function Control({ s, value, onChange }: { s: Setting; value: unknown; onChange: (v: unknown) => void }) {
  const id = `cfg-${s.id}`
  const input = s.input
  if (input.kind === 'toggle') {
    return (
      <label className="setting-switch" htmlFor={id}>
        <input id={id} type="checkbox" role="switch" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
        <span>{value === true ? 'On' : 'Off'}</span>
      </label>
    )
  }
  if (input.kind === 'select') {
    return (
      <select id={id} value={String(value)} onChange={(e) => onChange(e.target.value)}>
        {input.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    )
  }
  const unset = value === null
  const n = typeof value === 'number' ? value : (defaultOf(s) as number | null) ?? input.min
  const fmt = (v: number) => formatAmount(v, input.unit)
  return (
    <div className="setting-number">
      {input.unsetLabel !== undefined && (
        <label className="setting-switch" htmlFor={`${id}-custom`}>
          <input
            id={`${id}-custom`}
            type="checkbox"
            role="switch"
            checked={!unset}
            onChange={(e) => onChange(e.target.checked ? clampToInput(s, n) : null)}
          />
          <span>{unset ? input.unsetLabel : 'Custom'}</span>
        </label>
      )}
      {!unset &&
        (input.control === 'slider' ? (
          <div className="setting-slider">
            <input
              id={id}
              type="range"
              min={input.min}
              max={input.max}
              step={input.step}
              value={n}
              aria-valuetext={fmt(n)}
              onChange={(e) => onChange(Number(e.target.value))}
            />
            <output htmlFor={id} className="setting-value">
              {fmt(n)}
            </output>
          </div>
        ) : (
          <Stepper
            value={n}
            min={input.min}
            max={input.max}
            step={input.step}
            format={fmt}
            label={s.label}
            onChange={(v) => onChange(clampToInput(s, v))}
          />
        ))}
    </div>
  )
}

function SettingRow({
  s,
  config,
  editable,
  error,
  onChange,
}: {
  s: Setting
  config: Record<string, unknown>
  editable: boolean
  error?: string
  onChange: (config: Record<string, unknown>) => void
}) {
  const [info, setInfo] = useState(false)
  const value = valueOf(s, config)
  const changed = isChanged(s, config)
  return (
    <div className={`setting${changed ? ' setting-changed' : ''}${error ? ' setting-error' : ''}`}>
      <div className="setting-head">
        <label className="setting-label" htmlFor={`cfg-${s.id}`}>
          {s.label}
        </label>
        {changed && <span className="badge setting-badge">Changed</span>}
        {!editable && <span className="setting-readonly">{formatValue(s, value)}</span>}
        <button
          type="button"
          className="card-info-btn"
          aria-label={`About ${s.label}`}
          aria-expanded={info}
          onClick={() => setInfo((v) => !v)}
        >
          <InfoIcon />
        </button>
      </div>
      <p className="setting-desc">{s.description}</p>
      {info && <p className="setting-info">{s.info}</p>}
      {editable && <Control s={s} value={value} onChange={(v) => onChange(setIn(config, s.path, v))} />}
      {editable && changed && (
        <button type="button" className="secondary small setting-reset" onClick={() => onChange(resetSetting(config, s))}>
          Reset to default ({formatValue(s, defaultOf(s))})
        </button>
      )}
      {error && (
        <p className="bad setting-msg" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

/** Game settings editor: an explicit schema (src/lobby/config.ts), grouped, validated on save. */
export function ConfigEditor({ config, editable, busy, onSave }: Props) {
  // null = showing the server's config; an object = local edits not yet saved.
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null)
  const [errors, setErrors] = useState<Map<string, string>>(new Map())
  const shown = draft ?? config
  const changedCount = changedSettings(shown).length

  const edit = (next: Record<string, unknown>) => {
    setDraft(next)
    // Clear the message of a setting once it is fixed.
    if (errors.size) setErrors(new Map(validateConfig(next).filter((e) => errors.has(e.id)).map((e) => [e.id, e.message])))
  }
  const save = async () => {
    if (!draft) return
    const found = validateConfig(draft)
    setErrors(new Map(found.map((e) => [e.id, e.message])))
    if (found.length) return
    if (await onSave(draft)) setDraft(null)
  }

  return (
    <div className="config">
      <p className="muted setting-summary">
        {changedCount === 0 ? 'All settings are at their defaults.' : `${changedCount} changed from the defaults.`}
      </p>
      {GROUPS.map((g) => {
        const settings = SETTINGS.filter((s) => s.group === g.id)
        if (!settings.length) return null
        const changed = settings.filter((s) => isChanged(s, shown)).length
        return (
          <fieldset key={g.id} className="config-group">
            <legend>
              {g.title}
              {changed > 0 && <span className="setting-group-count"> · {changed} changed</span>}
            </legend>
            {settings.map((s) => (
              <SettingRow key={s.id} s={s} config={shown} editable={editable} error={errors.get(s.id)} onChange={edit} />
            ))}
          </fieldset>
        )
      })}
      {editable && (
        <>
          {errors.size > 0 && (
            <p className="bad" role="alert">
              Fix {errors.size === 1 ? 'the setting' : `${errors.size} settings`} marked above to save.
            </p>
          )}
          <div className="row config-actions">
            <button disabled={busy || !draft} onClick={() => void save()}>
              Save settings
            </button>
            <button
              className="secondary"
              disabled={busy || !draft}
              onClick={() => {
                setDraft(null)
                setErrors(new Map())
              }}
            >
              Discard
            </button>
            <button className="secondary" disabled={busy || changedCount === 0} onClick={() => edit(resetAll(shown))}>
              Reset all
            </button>
          </div>
        </>
      )}
    </div>
  )
}
