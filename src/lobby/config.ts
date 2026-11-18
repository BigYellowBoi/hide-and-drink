import defaults from '../../data/config.json'
import { questionTypes } from '../lib/seed'

/**
 * Game settings: an explicit schema over the game config (defaults in data/config.json).
 *
 * Only keys listed here are shown in the settings editor. Everything else in the config
 * (notes, schema_version, penalty text, cast_costs, the deck, keys from newer versions) is
 * kept as it is when the host saves.
 */

/** Default game config, from data/config.json. */
export const defaultConfig = defaults as Record<string, unknown>

/** Data is metres and seconds; display km, minutes, or seconds for short intervals. */
export type Unit = 'min' | 'km' | 's' | null

export type GroupId = 'hiding' | 'questions' | 'cards' | 'vetoes' | 'advanced'

export const GROUPS: readonly { id: GroupId; title: string }[] = [
  { id: 'hiding', title: 'Hiding' },
  { id: 'questions', title: 'Questions' },
  { id: 'cards', title: 'Cards' },
  { id: 'vetoes', title: 'Vetoes and penalties' },
  { id: 'advanced', title: 'Advanced' },
]

export type SettingInput =
  | {
      kind: 'number'
      control: 'slider' | 'stepper'
      unit: Unit
      /** Data units (seconds, metres, count). */
      min: number
      max: number
      step: number
      /** Set: the setting may be left unset (null), shown with this label. */
      unsetLabel?: string
    }
  | { kind: 'toggle' }
  | { kind: 'select'; options: readonly { value: string; label: string }[] }

export interface Setting {
  /** Dotted config path, also the React key. */
  id: string
  path: string[]
  group: GroupId
  /** Folded together under this title inside the group. */
  subgroup?: string
  label: string
  /** One line under the label. */
  description: string
  /** Longer text behind the info button. */
  info: string
  input: SettingInput
}

const min = (n: number) => n * 60

const typeName = (t: string) => t.charAt(0).toUpperCase() + t.slice(1)

/** Per-type answer time overrides, one per question type in the seed data. */
const deadlineOverrides: Setting[] = questionTypes.map((t) => ({
  id: `answer_deadline_s.${t.type}`,
  path: ['answer_deadline_s', t.type],
  group: 'questions',
  subgroup: 'Answer time per question type',
  label: `Answer time: ${typeName(t.type)}`,
  description: `Answer time for ${t.type} questions, if it should differ.`,
  info: `Off: ${t.type} questions use the question type's own time if it has one, else the answer time above. On: they get this long instead.`,
  input: { kind: 'number', control: 'slider', unit: 'min', min: min(1), max: min(60), step: 60, unsetLabel: 'Usual' },
}))

export const SETTINGS: readonly Setting[] = [
  {
    id: 'hiding_period_s',
    path: ['hiding_period_s'],
    group: 'hiding',
    label: 'Hiding period',
    description: 'Time the hiders get to reach their bar before seeking starts.',
    info: 'Seekers see only the countdown during the hiding period and cannot ask questions until it ends. Hiders must lock in a bar before it runs out.',
    input: { kind: 'number', control: 'slider', unit: 'min', min: min(5), max: min(180), step: min(5) },
  },
  {
    id: 'hiding_zone.bar_radius_m',
    path: ['hiding_zone', 'bar_radius_m'],
    group: 'hiding',
    label: 'Hiding zone radius',
    description: 'How far from their bar the hiders may be.',
    info: 'Hiders may be inside their bar or outdoors within this distance of it, but not in any other building. Shading treats a bar as possible while any part of this circle is left.',
    input: { kind: 'number', control: 'stepper', unit: 'km', min: 25, max: 500, step: 25 },
  },
  {
    id: 'hiding_zone.freeze_when_seeker_within_m',
    path: ['hiding_zone', 'freeze_when_seeker_within_m'],
    group: 'hiding',
    label: 'Freeze distance',
    description: 'Hiders must stay put while a seeker is this close to their bar.',
    info: "The hider's phone shows a freeze banner while any seeker's shared position is within this distance of the bar. It is a guide, not a referee.",
    input: { kind: 'number', control: 'stepper', unit: 'km', min: 25, max: 500, step: 25 },
  },
  {
    id: 'answer_deadline_s.default',
    path: ['answer_deadline_s', 'default'],
    group: 'questions',
    label: 'Answer time',
    description: 'How long the hiders have to answer a question.',
    info: 'A late answer is still accepted but marked late, and a missed deadline costs the hiders a shot.',
    input: { kind: 'number', control: 'slider', unit: 'min', min: min(1), max: min(30), step: 60 },
  },
  ...deadlineOverrides,
  {
    id: 'hand_limit',
    path: ['hand_limit'],
    group: 'cards',
    label: 'Hand limit',
    description: 'Most cards the hiders can hold at once.',
    info: 'When a draw would take the hand over the limit, the hiders discard down to it as they keep their new cards.',
    input: { kind: 'number', control: 'stepper', unit: null, min: 1, max: 12, step: 1 },
  },
  {
    id: 'photo_proof_for_drinks',
    path: ['photo_proof_for_drinks'],
    group: 'cards',
    label: 'Photo proof for drinks',
    description: 'Ask for a photo of every drink the app knows about.',
    info: 'Cast costs, drink cards, vetoes and missed deadlines ask the drinking team for a photo, which both teams see in the timeline.',
    input: { kind: 'toggle' },
  },
  {
    id: 'veto.base_lock_s',
    path: ['veto', 'base_lock_s'],
    group: 'vetoes',
    label: 'Veto lock',
    description: 'How long seekers stay at a bar after their first veto.',
    info: 'Vetoing a curse ends it, but the seekers must stay at a bar for this long, and each seeker drinks.',
    input: { kind: 'number', control: 'stepper', unit: 'min', min: 0, max: min(60), step: 60 },
  },
  {
    id: 'veto.step_s',
    path: ['veto', 'step_s'],
    group: 'vetoes',
    label: 'Extra lock per veto',
    description: 'Added to the lock for every veto already used this run.',
    info: 'Lock = veto lock + this x vetoes used so far. A new lock starts when the previous one ends.',
    input: { kind: 'number', control: 'stepper', unit: 'min', min: 0, max: min(60), step: 60 },
  },
  {
    id: 'seeker_location_interval_s',
    path: ['seeker_location_interval_s'],
    group: 'advanced',
    label: 'Seeker location updates',
    description: "How often seekers' phones share their position.",
    info: 'Shorter is more accurate for the freeze banner but uses more battery. Phones only share while the app is open.',
    input: { kind: 'number', control: 'slider', unit: 's', min: 5, max: 120, step: 5 },
  },
  {
    id: 'dev_mode',
    path: ['dev_mode'],
    group: 'advanced',
    label: 'Playtest mode',
    description: 'GPS off: everyone long-presses the map to set their position.',
    info: 'For trying the app at home. A banner shows on every phone while it is on.',
    input: { kind: 'toggle' },
  },
]

/**
 * Config keys that are not settings: notes, free text the app only shows elsewhere, values
 * with their own editor (deck) or not used yet (rounds, game_size). Kept as they are on save.
 */
export const NOT_SETTINGS: readonly string[] = [
  'schema_version',
  'todo',
  'game_size',
  'rounds',
  'cast_costs',
  'late_answer_penalty',
  'veto.penalty',
  'answer_deadline_s.todo',
  'deck',
]

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function getIn(obj: Record<string, unknown>, path: readonly string[]): unknown {
  let cur: unknown = obj
  for (const k of path) {
    if (!isObject(cur)) return undefined
    cur = cur[k]
  }
  return cur
}

/** Immutable set at a path. */
export function setIn(obj: Record<string, unknown>, path: readonly string[], value: unknown): Record<string, unknown> {
  const [head, ...rest] = path
  if (rest.length === 0) return { ...obj, [head]: value }
  const child = isObject(obj[head]) ? (obj[head] as Record<string, unknown>) : {}
  return { ...obj, [head]: setIn(child, rest, value) }
}

const optional = (s: Setting) => s.input.kind === 'number' && s.input.unsetLabel !== undefined

/** The default for a setting: data/config.json, or unset for an optional one. */
export function defaultOf(s: Setting): unknown {
  const v = getIn(defaultConfig, s.path)
  return v === undefined && optional(s) ? null : v
}

/** The setting's value in a config: a missing key reads as the default (the server does the same). */
export function valueOf(s: Setting, config: Record<string, unknown>): unknown {
  const v = getIn(config, s.path)
  if (v === undefined) return defaultOf(s)
  return v
}

export function isChanged(s: Setting, config: Record<string, unknown>): boolean {
  return valueOf(s, config) !== defaultOf(s)
}

export function changedSettings(config: Record<string, unknown>): Setting[] {
  return SETTINGS.filter((s) => isChanged(s, config))
}

export function resetSetting(config: Record<string, unknown>, s: Setting): Record<string, unknown> {
  return setIn(config, s.path, defaultOf(s))
}

/** Every setting back to its default; the deck, notes and unknown keys stay. */
export function resetAll(config: Record<string, unknown>): Record<string, unknown> {
  return SETTINGS.reduce((c, s) => resetSetting(c, s), config)
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

/** "60 min", "0.1 km", "20 s", "6". */
export function formatAmount(value: number, unit: Unit): string {
  return unit ? `${toDisplay(value, unit)} ${unit}` : String(value)
}

/** The value as the editor shows it. */
export function formatValue(s: Setting, value: unknown): string {
  const input = s.input
  if (input.kind === 'toggle') return value === true ? 'On' : 'Off'
  if (input.kind === 'select') return input.options.find((o) => o.value === value)?.label ?? String(value)
  if (value === null) return input.unsetLabel ?? 'Not set'
  return typeof value === 'number' ? formatAmount(value, input.unit) : String(value)
}

export interface SettingError {
  id: string
  message: string
}

/** Problems with a config's settings, one readable message per bad setting. */
export function validateConfig(config: Record<string, unknown>): SettingError[] {
  const errors: SettingError[] = []
  for (const s of SETTINGS) {
    const message = validateSetting(s, valueOf(s, config))
    if (message) errors.push({ id: s.id, message })
  }
  return errors
}

export function validateSetting(s: Setting, value: unknown): string | null {
  const input = s.input
  switch (input.kind) {
    case 'toggle':
      return typeof value === 'boolean' ? null : `${s.label} must be on or off.`
    case 'select':
      return input.options.some((o) => o.value === value) ? null : `Pick an option for ${s.label}.`
    case 'number': {
      if (value === null && input.unsetLabel !== undefined) return null
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${s.label} needs a number.`
      const range = `between ${formatAmount(input.min, input.unit)} and ${formatAmount(input.max, input.unit)}`
      if (value < input.min || value > input.max) return `${s.label} must be ${range}.`
      if (input.unit === null && !Number.isInteger(value)) return `${s.label} must be a whole number.`
      return null
    }
  }
}

/** Snap a number to the setting's step and range. */
export function clampToInput(s: Setting, value: number): number {
  if (s.input.kind !== 'number') return value
  const { min: lo, max: hi, step } = s.input
  const snapped = lo + Math.round((value - lo) / step) * step
  return Math.min(hi, Math.max(lo, snapped))
}
