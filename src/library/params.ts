/**
 * The card params the app's code reads, per behaviour, so the card editor can show real
 * fields instead of raw JSON. This describes code (what play_card and the phones act on),
 * not content: any other key is kept as is and edited under "Other settings".
 * Units follow the data: seconds (shown as minutes) and metres.
 */

export type ParamKind = 'minutes' | 'number' | 'int' | 'bool' | 'select' | 'teams' | 'lines' | 'text'

export interface ParamField {
  key: string
  label: string
  kind: ParamKind
  options?: { value: string; label: string }[]
  required?: boolean
  /** Only shown (and kept) when this returns true for the current params. */
  when?: (p: Record<string, unknown>) => boolean
  hint?: string
}

export const BEHAVIOURS: { id: string; label: string; hint: string }[] = [
  { id: 'text', label: 'Text', hint: 'Do what the card says. Nothing to track.' },
  { id: 'timed', label: 'Timed', hint: 'Runs for a set time, shown to both teams.' },
  { id: 'until_cleared', label: 'Until cleared', hint: 'Lasts until the seekers do it and the hider confirms.' },
  { id: 'trivia', label: 'Trivia', hint: 'The hider writes questions, the seekers answer until enough are right.' },
  { id: 'time_bonus', label: 'Time bonus', hint: 'Never played: adds time while held at the end of the round.' },
  { id: 'next_question_modifier', label: 'Next question', hint: 'Multiplies the next answer\'s draw and keep.' },
  { id: 'powerup', label: 'Powerup', hint: 'Veto, randomize, duplicate, move or discard/draw.' },
  { id: 'question_ban', label: 'Question ban', hint: 'The seekers can\'t ask the questions picked.' },
]

const TEAM_OPTIONS = [
  { value: 'hiders', label: 'Hiders' },
  { value: 'seekers', label: 'Seekers' },
]

const BY_BEHAVIOUR: Record<string, ParamField[]> = {
  timed: [
    { key: 'duration_s', label: 'Duration', kind: 'minutes', required: true },
    { key: 'followup_s', label: 'Then a lock of', kind: 'minutes', hint: 'Optional follow-on timer if the task is missed' },
    { key: 'seeker_confirm', label: 'Ask the seekers first', kind: 'text', hint: "Only starts if they say yes, e.g. Are you in the hiders' bar?" },
  ],
  until_cleared: [
    { key: 'blocks_questions', label: 'Blocks questions until done', kind: 'bool' },
    { key: 'seeker_confirm', label: 'Ask the seekers first', kind: 'text', hint: "Only starts if they say yes, e.g. Are you in the hiders' bar?" },
  ],
  trivia: [
    { key: 'count', label: 'Questions', kind: 'int', hint: 'Default 3' },
    { key: 'topic', label: 'Topic', kind: 'text', hint: 'e.g. Harry Potter' },
    { key: 'need_right', label: 'Right answers needed', kind: 'int', hint: 'Default all. Fewer: a set that falls short is replaced by a new one' },
    { key: 'blocks_questions', label: 'Blocks questions until done', kind: 'bool' },
  ],
  time_bonus: [{ key: 'minutes', label: 'Minutes added', kind: 'number', required: true }],
  next_question_modifier: [{ key: 'reward_multiplier', label: 'Reward multiplier', kind: 'number', hint: 'Default 2' }],
  powerup: [
    {
      key: 'action',
      label: 'Does',
      kind: 'select',
      required: true,
      options: [
        { value: 'veto', label: 'Veto the pending question' },
        { value: 'randomize', label: 'Randomize the pending question' },
        { value: 'duplicate', label: 'Duplicate a card in hand' },
        { value: 'move', label: 'Move to a new bar' },
        { value: 'discard_draw', label: 'Discard then draw' },
      ],
    },
    { key: 'discard', label: 'Discard', kind: 'int', required: true, when: (p) => p.action === 'discard_draw' },
    { key: 'draw', label: 'Draw', kind: 'int', required: true, when: (p) => p.action === 'discard_draw' },
  ],
  question_ban: [
    { key: 'count', label: 'Questions banned', kind: 'int', hint: 'Default 1' },
    { key: 'distinct_types', label: 'Each from a different type', kind: 'bool' },
  ],
}

const isWheel = (p: Record<string, unknown>) => p.utility === 'wheel'

/** Fields any card can have. */
export const COMMON_FIELDS: ParamField[] = [
  {
    key: 'cost',
    label: 'Extra cost to play',
    kind: 'select',
    options: [
      { value: 'drink', label: 'Drink' },
      { value: 'shot', label: 'Shot' },
    ],
    hint: 'Used when the card has no cast cost',
  },
  { key: 'cost_team', label: 'Who pays the cost', kind: 'select', options: TEAM_OPTIONS, hint: 'Default: the hiders (they pay to cast)' },
  { key: 'drinks', label: 'Teams that drink when played', kind: 'teams' },
  {
    key: 'utility',
    label: 'Dice or wheel',
    kind: 'select',
    options: [
      { value: 'dice', label: 'Dice' },
      { value: 'wheel', label: 'Wheel' },
    ],
  },
  { key: 'dice', label: 'Dice', kind: 'int', when: (p) => p.utility === 'dice', hint: 'Default 1' },
  { key: 'wheel_options', label: 'Wheel options (one per line)', kind: 'lines', when: isWheel },
  { key: 'wheel_url', label: 'Wheel link (if no options)', kind: 'text', when: isWheel },
  {
    key: 'proof',
    label: 'Proof',
    kind: 'select',
    options: [
      { value: 'photo', label: 'Photo' },
      { value: 'video', label: 'Video' },
    ],
    hint: 'The app asks the seekers for it before a curse clears (photo also for each drink the card hands out)',
  },
  {
    key: 'hider_proof',
    label: 'Hiders send first',
    kind: 'select',
    options: [
      { value: 'photo', label: 'Photo' },
      { value: 'video', label: 'Video' },
    ],
    hint: "The hiders send this when they cast it (e.g. a Street View screenshot); the seekers can't clear it before it arrives",
  },
]

export const fieldsFor = (behaviour: string): ParamField[] => [...(BY_BEHAVIOUR[behaviour] ?? []), ...COMMON_FIELDS]

const KNOWN = new Set(
  [...Object.values(BY_BEHAVIOUR).flat(), ...COMMON_FIELDS].map((f) => f.key),
)

/** Params the editor has no field for, kept as raw JSON. */
export function otherParams(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(params).filter(([k]) => !KNOWN.has(k)))
}

const empty = (v: unknown) =>
  v === undefined || v === null || v === '' || v === false || (Array.isArray(v) && v.length === 0)

/**
 * The params to save: the shown fields for this behaviour (empty ones dropped), plus the
 * other keys. Known keys that don't apply to this behaviour are dropped.
 */
export function buildParams(behaviour: string, params: Record<string, unknown>, other: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...other }
  for (const f of fieldsFor(behaviour)) {
    if (f.when && !f.when(params)) continue
    const v = params[f.key]
    if (!empty(v)) out[f.key] = v
  }
  return out
}

/** First problem with a card's params, as a sentence, or null. Mirrors _check_card_params. */
export function paramProblem(behaviour: string, params: Record<string, unknown>): string | null {
  for (const f of fieldsFor(behaviour)) {
    if (f.when && !f.when(params)) continue
    const v = params[f.key]
    if (empty(v)) {
      if (f.required) return `${f.label}: required.`
      continue
    }
    if ((f.kind === 'minutes' || f.kind === 'number') && !(typeof v === 'number' && v > 0)) return `${f.label}: must be above 0.`
    if (f.kind === 'int' && !(typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10))
      return `${f.label}: a whole number up to 10.`
    if (f.key === 'draw' && v === 0) return 'Draw: at least 1.'
    if ((f.key === 'count' || f.key === 'dice') && v === 0) return `${f.label}: at least 1.`
    if (f.key === 'reward_multiplier' && typeof v === 'number' && v < 1) return 'Reward multiplier: at least 1.'
    if (f.key === 'wheel_options' && Array.isArray(v) && v.length < 2) return 'Wheel options: at least 2.'
  }
  return null
}
