import defaults from '../../data/config.json'

/** Default game config, from data/config.json. */
export const defaultConfig = defaults as Record<string, unknown>

/** Keys that describe the config rather than configure the game. */
const META_KEYS = new Set(['schema_version', 'todo'])

/** Top-level keys with their own editor: the deck builder owns config.deck. */
const OWN_EDITOR_KEYS = new Set(['deck'])

export type Unit = 'min' | 'km' | null

export type FieldKind = 'number' | 'boolean' | 'text' | 'list' | 'unset'

export interface ConfigField {
  path: string[]
  label: string
  kind: FieldKind
  unit: Unit
  value: unknown
}

export interface ConfigGroup {
  /** Empty for top-level fields. */
  path: string[]
  title: string
  notes: string[]
  fields: ConfigField[]
}

/** Data is metres and seconds; display km and minutes. Unit comes from the key suffix. */
export function unitFor(key: string): Unit {
  if (key.endsWith('_s')) return 'min'
  if (key.endsWith('_m')) return 'km'
  return null
}

export function humanize(key: string): string {
  const base = key.replace(/_(s|m)$/, '').replace(/_/g, ' ')
  return base.charAt(0).toUpperCase() + base.slice(1)
}

function kindOf(value: unknown, unit: Unit): FieldKind {
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'string') return 'text'
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return 'list'
  if (value === null) return unit ? 'number' : 'unset'
  return 'text'
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Flatten a config object into editable groups, one per nested object. */
export function configGroups(config: Record<string, unknown>): ConfigGroup[] {
  const groups: ConfigGroup[] = []
  // A nested object under a unit key (answer_deadline_s: { default, photos }) passes its unit down.
  const walk = (obj: Record<string, unknown>, path: string[], inherited: Unit = null) => {
    const group: ConfigGroup = {
      path,
      title: path.length ? path.map(humanize).join(' › ') : 'General',
      notes: typeof obj.todo === 'string' ? [obj.todo] : [],
      fields: [],
    }
    groups.push(group)
    for (const [key, value] of Object.entries(obj)) {
      if (META_KEYS.has(key)) continue
      if (path.length === 0 && OWN_EDITOR_KEYS.has(key)) continue
      if (isObject(value)) {
        walk(value, [...path, key], unitFor(key) ?? inherited)
        continue
      }
      const unit = unitFor(key) ?? inherited
      group.fields.push({ path: [...path, key], label: humanize(key), kind: kindOf(value, unit), unit, value })
    }
  }
  walk(config, [])
  if (typeof config.todo === 'string') groups[0].notes = [config.todo]
  return groups.filter((g) => g.fields.length > 0 || g.notes.length > 0)
}

/** Immutable set at a path. */
export function setIn(obj: Record<string, unknown>, path: string[], value: unknown): Record<string, unknown> {
  const [head, ...rest] = path
  if (rest.length === 0) return { ...obj, [head]: value }
  const child = isObject(obj[head]) ? (obj[head] as Record<string, unknown>) : {}
  return { ...obj, [head]: setIn(child, rest, value) }
}

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places

export function toDisplay(value: number, unit: Unit): number {
  if (unit === 'min') return round(value / 60, 2)
  if (unit === 'km') return round(value / 1000, 3)
  return value
}

export function fromDisplay(value: number, unit: Unit): number {
  if (unit === 'min') return Math.round(value * 60)
  if (unit === 'km') return Math.round(value * 1000)
  return value
}

/** Parse free text for a field with no known type yet: blank = unset. */
export function parseLoose(text: string): unknown {
  const t = text.trim()
  if (t === '') return null
  if (t === 'true') return true
  if (t === 'false') return false
  const n = Number(t)
  return Number.isFinite(n) ? n : t
}
