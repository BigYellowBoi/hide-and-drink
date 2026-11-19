import type { Feature, MultiPolygon, Polygon } from 'geojson'
import type { GameEvent } from '../sync/types'
import { isLngLat, type LngLat } from './geo'

/** Question types the app can ask and answer. */
export const SUPPORTED_TYPES = ['radar', 'thermometer', 'matching', 'measuring', 'tentacles', 'photos', 'bonus'] as const
export type SupportedType = (typeof SUPPORTED_TYPES)[number]
export const isSupportedType = (t: string): t is SupportedType => (SUPPORTED_TYPES as readonly string[]).includes(t)

/** Types whose question includes the asking seeker's position (params.center). */
export const MAP_TYPES: readonly string[] = ['radar', 'matching', 'measuring', 'tentacles']

/** Two-button answers. Tentacles, photos and bonus answers depend on the question. */
export const ANSWERS: Partial<Record<string, readonly [string, string]>> = {
  radar: ['yes', 'no'],
  thermometer: ['hotter', 'colder'],
  matching: ['same', 'different'],
  measuring: ['closer', 'further'],
}

/** The null answer ("none") and its label, for types that have one (tentacles, photos). */
export const NULL_ANSWER = 'none'

export const TYPE_NAMES: Record<string, string> = {
  matching: 'Matching',
  measuring: 'Measuring',
  thermometer: 'Thermometer',
  radar: 'Radar',
  tentacles: 'Tentacles',
  photos: 'Photo',
  bonus: 'Bonus',
}
export const typeName = (t: string) => TYPE_NAMES[t] ?? t.charAt(0).toUpperCase() + t.slice(1)

export interface RadarParams {
  center: LngLat
  distance_m: number
}
export interface ThermometerParams {
  start: LngLat
  end: LngLat
  distance_m: number
  travelled_m: number
}

export interface Candidate {
  feature_id: string
  name: string
  point: LngLat
  distance_m: number
}

export interface Question {
  id: string
  seq: number
  round: number
  type: string
  optionId: string
  prompt: string
  params: Record<string, unknown>
  askedBy: string | null
  /** Server time, ms. */
  askedAt: number
  deadlineAt: number
  deadlineS: number
  reward: { draw: number; pick: number }
  answer: string | null
  answeredAt: number | null
  late: boolean
  /** The missed-deadline penalty has been logged. */
  overdue: boolean
  /** The host cancelled the missed-deadline penalty (override). */
  penaltyCancelled: boolean
  /** The answer deadline is paused (override): time left, ms. deadlineAt is Infinity meanwhile. */
  pausedLeftMs: number | null
  /** Closed by a powerup instead of an answer, or voided by the host (override). */
  closedBy: 'veto' | 'randomize' | 'void' | null
  /** Randomize: the question this one replaced. */
  randomizedFrom: string | null
  /** Final reward when a modifier changed it (question_answered). */
  rewardMultiplier: number | null
  /** The seekers' own shading, replacing the app's (set_question_shading). null: the app's. */
  manualShading: ManualShading | null
}

/** keep/cut: keep only / rule out the area. none: the answer rules nothing out. */
export type ManualShading =
  | { mode: 'keep' | 'cut'; area: Feature<Polygon | MultiPolygon> }
  | { mode: 'none' }

export function parseManualShading(v: unknown): ManualShading | null {
  if (!isObject(v)) return null
  if (v.mode === 'none') return { mode: 'none' }
  const a = v.area
  if ((v.mode === 'keep' || v.mode === 'cut') && isObject(a) && (a.type === 'Polygon' || a.type === 'MultiPolygon') && Array.isArray(a.coordinates)) {
    return { mode: v.mode, area: { type: 'Feature', properties: {}, geometry: a as unknown as Polygon | MultiPolygon } }
  }
  return null
}

export type LogKind = 'seeking' | 'asked' | 'answered' | 'penalty' | 'bar' | 'draw' | 'card' | 'proof' | 'shading' | 'override'
export interface LogEntry {
  seq: number
  kind: LogKind
  at: number
  text: string
  /** The question this entry belongs to (answer, cards drawn for it, a veto): shown on its timeline card. */
  questionId?: string
  /** Who did it (user id), when the event says. */
  by?: string | null
  /** Hider-only entry (shown with a lock). */
  private?: boolean
  /** Storage path of a photo (answer photo, or drink proof with photoBucket). */
  photo?: string
  /** Bucket of the photo; default the answer-photo bucket. */
  photoBucket?: string
  /** Dot colour (card category), when the kind's own colour doesn't fit. */
  colour?: string
  /** The played card this entry belongs to (a curse's replies, proofs, veto): shown on its timeline card. */
  instanceId?: string
  /** Host override this entry records (kind 'override'). */
  overrideId?: string
  /** Why the host did it. */
  reason?: string
  /** The override was undone since. */
  undone?: boolean
}

export interface PlayState {
  round: number
  /** Server ms when seeking starts (end of the hiding period). */
  seekingAt: number | null
  seekingStarted: boolean
  /** The hiding period is paused (override): time left, ms. seekingAt is Infinity meanwhile. */
  hidingPausedLeftMs: number | null
  questions: Question[]
  pending: Question | null
  penalties: number
  /** Seq of the last hider_moved: answers before it describe the old bar. */
  movedSeq: number
  log: LogEntry[]
}

export const emptyPlay: PlayState = {
  round: 0,
  seekingAt: null,
  seekingStarted: false,
  hidingPausedLeftMs: null,
  questions: [],
  pending: null,
  penalties: 0,
  movedSeq: 0,
  log: [],
}

const str = (v: unknown) => (typeof v === 'string' ? v : null)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const time = (v: unknown, fallback: string) => {
  const t = Date.parse(str(v) ?? '')
  return Number.isNaN(t) ? Date.parse(fallback) : t
}
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export const km = (m: number) => (m >= 1000 ? `${+(m / 1000).toFixed(m % 1000 ? 1 : 0)} km` : `${Math.round(m)} m`)

/** The option label the server stored on the question (all types but radar/thermometer). */
export const optionText = (q: Pick<Question, 'params'>) => str(q.params.label)

/** Short label for a question: "Radar 1 km", "Thermometer 500 m", "Matching · Park". */
export function questionLabel(q: Pick<Question, 'type' | 'params'>): string {
  const name = typeName(q.type)
  const label = optionText(q)
  if (label) return q.type === 'bonus' ? name : `${name} · ${label}`
  const d = num(q.params.distance_m)
  return d ? `${name} ${km(d)}` : name
}

/** The full question: the prompt with its blank filled in (bonus options are the question). */
export function questionText(q: Pick<Question, 'type' | 'params' | 'prompt'>): string {
  const label = optionText(q)
  const d = num(q.params.distance_m)
  if (q.type === 'bonus') return label ?? q.prompt
  const fill = label
    ? // Names ("The Airport", "Felons Brewing Co") keep their capitals; common nouns go lower case.
      /^The [A-Z]/.test(label) || /^[A-Z][a-z]+ [A-Z]/.test(label)
      ? label
      : label.charAt(0).toLowerCase() + label.slice(1)
    : d
      ? km(d)
      : '___'
  return q.prompt.replace('___', fill)
}

export const answerLabel = (a: string) => a.charAt(0).toUpperCase() + a.slice(1)

/** What an answer says, in words: "Same suburb", "Riverside Cinema", "None within range". */
export function answerText(q: Pick<Question, 'type' | 'params'>, a: string): string {
  if (a === NULL_ANSWER && typeof q.params.null_answer === 'string') return q.params.null_answer
  const label = (optionText(q) ?? '').toLowerCase()
  switch (q.type) {
    case 'matching':
      return a === 'same' ? `Same ${label}` : a === 'different' ? `Different ${label}` : answerLabel(a)
    case 'tentacles':
      return candidatesOf(q).find((c) => c.feature_id === a)?.name ?? a
    case 'photos':
      return 'Photo'
    case 'bonus':
      return q.params.answer_kind === 'text' ? a : answerLabel(a)
    default:
      return answerLabel(a)
  }
}

export function candidatesOf(q: Pick<Question, 'params'>): Candidate[] {
  const c = q.params.candidates
  return Array.isArray(c)
    ? c.filter(
        (x): x is Candidate =>
          isObject(x) && typeof x.feature_id === 'string' && typeof x.name === 'string' && isLngLat(x.point),
      )
    : []
}

export function radarParams(q: Pick<Question, 'type' | 'params'>): RadarParams | null {
  const d = num(q.params.distance_m)
  return q.type === 'radar' && isLngLat(q.params.center) && d ? { center: q.params.center, distance_m: d } : null
}

export function thermometerParams(q: Pick<Question, 'type' | 'params'>): ThermometerParams | null {
  const { start, end } = q.params
  return q.type === 'thermometer' && isLngLat(start) && isLngLat(end)
    ? { start, end, distance_m: num(q.params.distance_m) ?? 0, travelled_m: num(q.params.travelled_m) ?? 0 }
    : null
}

const isOpen = (q: Question) => q.answer === null && q.closedBy === null

function update(state: PlayState, id: string | null, f: (q: Question) => Question): PlayState {
  const questions = state.questions.map((q) => (q.id === id ? f(q) : q))
  return { ...state, questions, pending: questions.find(isOpen) ?? null }
}

export function applyPlayEvent(state: PlayState, e: GameEvent): PlayState {
  const p = e.payload
  const at = Date.parse(e.created_at)
  switch (e.type) {
    case 'game_started': {
      const started = time(p.started_at, e.created_at)
      const hiding = num(p.hiding_period_s) ?? 0
      return { ...emptyPlay, round: num(p.round) ?? 1, seekingAt: started + hiding * 1000, log: state.log }
    }
    case 'seeking_started':
      return {
        ...state,
        // Playtest skips end hiding early: the event says when seeking really started.
        seekingAt: time(p.at, e.created_at),
        seekingStarted: true,
        log: [...state.log, { seq: e.seq, kind: 'seeking', at: time(p.at, e.created_at), text: 'Seeking started' }],
      }
    case 'round_ended':
      return { ...state, log: [...state.log, { seq: e.seq, kind: 'seeking', at, text: `Found! Round ${num(p.round) ?? state.round} over`, by: str(e.actor_id) }] }
    case 'hiding_skipped':
      return { ...state, log: [...state.log, { seq: e.seq, kind: 'seeking', at, text: 'Hiding skipped (playtest)', by: str(e.actor_id) }] }
    case 'bar_chosen':
      // Hiders-only event; the bar itself comes from src/hiding/state.ts.
      return {
        ...state,
        log: [...state.log, { seq: e.seq, kind: 'bar', at, text: `Locked in ${str(p.name) ?? 'a bar'}`, private: true }],
      }
    case 'question_asked': {
      const id = str(p.question_id)
      if (!id) return state
      const reward = isObject(p.reward) ? p.reward : {}
      const q: Question = {
        id,
        seq: e.seq,
        round: num(p.round) ?? state.round,
        type: str(p.type) ?? 'unknown',
        optionId: str(p.option_id) ?? '',
        prompt: str(p.prompt) ?? '',
        params: isObject(p.params) ? p.params : {},
        askedBy: str(p.asked_by),
        askedAt: time(p.asked_at, e.created_at),
        deadlineAt: time(p.deadline_at, e.created_at),
        deadlineS: num(p.deadline_s) ?? 0,
        reward: { draw: num(reward.draw) ?? 0, pick: num(reward.pick) ?? 0 },
        answer: null,
        answeredAt: null,
        late: false,
        overdue: false,
        penaltyCancelled: false,
        pausedLeftMs: null,
        closedBy: null,
        randomizedFrom: str(p.randomized_from),
        rewardMultiplier: null,
        manualShading: null,
      }
      return {
        ...state,
        // The server only lets a seeker ask once the hiding period is over.
        seekingStarted: true,
        questions: [...state.questions, q],
        pending: q,
        log: [
          ...state.log,
          {
            seq: e.seq,
            kind: 'asked',
            at,
            text: q.randomizedFrom ? `Randomized into ${questionLabel(q)}` : `${questionLabel(q)} asked`,
            questionId: id,
            by: q.askedBy,
          },
        ],
      }
    }
    case 'question_answered': {
      const id = str(p.question_id)
      const answer = str(p.answer)
      if (!id || !answer) return state
      const q = state.questions.find((x) => x.id === id)
      const next = update(state, id, (x) => ({
        ...x,
        answer,
        answeredAt: time(p.answered_at, e.created_at),
        late: p.late === true,
        closedBy: null,
        pausedLeftMs: null,
        rewardMultiplier: num(p.reward_multiplier),
        reward: isObject(p.reward) ? { draw: num(p.reward.draw) ?? x.reward.draw, pick: num(p.reward.pick) ?? x.reward.pick } : x.reward,
      }))
      const label = q ? questionLabel(q) : 'Question'
      return {
        ...next,
        log: [
          ...next.log,
          {
            seq: e.seq,
            kind: 'answered',
            at,
            text: `${label}: ${q ? answerText(q, answer) : answerLabel(answer)}${p.late === true ? ' (late)' : ''}`,
            questionId: id,
            ...(q?.type === 'photos' && answer !== NULL_ANSWER ? { photo: answer } : {}),
          },
        ],
      }
    }
    case 'card_played': {
      // Veto and Randomize close the pending question (Randomize's new one follows as question_asked).
      const id = str(p.question_id)
      const action = isObject(p.card) && isObject(p.card.params) ? p.card.params.action : null
      if (!id || (action !== 'veto' && action !== 'randomize')) return state
      // A Randomize on a thermometer (extra.randomize_vetoes) closes it as a veto.
      const closedBy = action === 'randomize' && p.as_veto === true ? 'veto' : action
      return update(state, id, (x) => ({ ...x, closedBy, answeredAt: time(p.played_at, e.created_at) }))
    }
    case 'hider_moved':
      return { ...state, movedSeq: e.seq }
    case 'question_shading_set': {
      const id = str(p.question_id)
      const q = state.questions.find((x) => x.id === id)
      if (!id || !q) return state
      const manual = parseManualShading(p.shading)
      const next = update(state, id, (x) => ({ ...x, manualShading: manual }))
      const what = !manual
        ? 'back to the app\'s shading'
        : manual.mode === 'none'
          ? 'rules nothing out'
          : manual.mode === 'keep'
            ? 'shaded by hand (keep inside)'
            : 'shaded by hand (rule out inside)'
      return {
        ...next,
        log: [...next.log, { seq: e.seq, kind: 'shading', at, text: `${questionLabel(q)}: ${what}`, questionId: id, by: str(p.by) }],
      }
    }
    case 'answer_overdue': {
      const id = str(p.question_id)
      const next = update(state, id, (x) => ({ ...x, overdue: true }))
      return {
        ...next,
        penalties: next.penalties + 1,
        log: [
          ...next.log,
          { seq: e.seq, kind: 'penalty', at, text: 'Answer deadline missed: hiders take a shot', ...(id ? { questionId: id } : {}) },
        ],
      }
    }
    case 'penalty_cancelled': {
      const id = str(p.question_id)
      const next = update(state, id, (x) => ({ ...x, penaltyCancelled: true }))
      return {
        ...next,
        penalties: Math.max(0, next.penalties - 1),
        log: [...next.log, { seq: e.seq, kind: 'override', at, text: 'Missed-deadline shot cancelled', ...(id ? { questionId: id } : {}) }],
      }
    }
    case 'penalty_added': {
      const who = p.team === 'seekers' ? 'Seekers' : 'Hiders'
      return {
        ...state,
        penalties: state.penalties + (p.team === 'hiders' ? 1 : 0),
        log: [...state.log, { seq: e.seq, kind: 'penalty', at, text: `${who} take a ${str(p.cost) ?? 'shot'}: ${str(p.label) ?? 'penalty'}` }],
      }
    }
    case 'question_voided': {
      const id = str(p.question_id)
      return update(state, id, (x) => ({ ...x, answer: null, closedBy: 'void', answeredAt: x.answeredAt ?? at, pausedLeftMs: null }))
    }
    case 'question_reopened': {
      const id = str(p.question_id)
      return update(state, id, (x) => ({
        ...x,
        answer: null,
        answeredAt: null,
        closedBy: null,
        late: false,
        overdue: false,
        penaltyCancelled: false,
        pausedLeftMs: null,
        deadlineAt: time(p.deadline_at, e.created_at),
        deadlineS: num(p.deadline_s) ?? x.deadlineS,
      }))
    }
    case 'timer_changed': {
      const ends = str(p.ends_at)
      const left = num(p.paused_left_s)
      const endsAt = ends ? time(ends, e.created_at) : Number.POSITIVE_INFINITY
      const pausedLeftMs = ends === null && left !== null ? left * 1000 : null
      if (p.timer === 'answer') return update(state, str(p.id), (x) => ({ ...x, deadlineAt: endsAt, pausedLeftMs }))
      if (p.timer === 'hiding') {
        return { ...state, seekingAt: endsAt, hidingPausedLeftMs: pausedLeftMs, seekingStarted: p.status === 'seeking' }
      }
      return state
    }
    case 'override': {
      const text = str(p.summary) ?? 'Host fixed something'
      const id = str(p.override_id) ?? undefined
      return {
        ...state,
        log: [...state.log, { seq: e.seq, kind: 'override', at, text, by: str(p.by), overrideId: id, reason: str(p.reason) ?? undefined }],
      }
    }
    case 'override_detail': {
      // Hider phones: what the hider-only override changed.
      const id = str(p.override_id)
      const text = str(p.summary)
      if (!id || !text) return state
      return { ...state, log: state.log.map((l) => (l.overrideId === id ? { ...l, text, private: true } : l)) }
    }
    case 'override_undone': {
      const id = str(p.target_id)
      return { ...state, log: state.log.map((l) => (id && l.overrideId === id ? { ...l, undone: true } : l)) }
    }
    default:
      return state
  }
}

/** When a countdown shows it ends: paused ones stay put at the time left. */
export const shownEnd = (endsAt: number, pausedLeftMs: number | null, now: number) =>
  pausedLeftMs !== null ? now + pausedLeftMs : endsAt

export const derivePlay = (events: readonly GameEvent[]): PlayState => events.reduce(applyPlayEvent, emptyPlay)

/** Answered questions of this round the app can shade (only since the hider's last move). */
export const shadable = (s: PlayState) =>
  s.questions.filter((q) => q.round === s.round && q.answer !== null && q.seq > s.movedSeq && isSupportedType(q.type))

/** What happened to a question, in words, for lists. */
export const outcomeText = (q: Question): string =>
  q.closedBy === 'veto' ? 'Vetoed' : q.closedBy === 'randomize' ? 'Randomized' : q.closedBy === 'void' ? 'Voided by the host' : q.answer ? answerText(q, q.answer) : 'Waiting'

/** What a phone should ask the server to settle now (null: nothing due). Server decides. */
export function dueTimer(s: PlayState, serverNow: number): string | null {
  if (!s.seekingStarted && s.seekingAt !== null && serverNow >= s.seekingAt) return `seeking:${s.round}`
  if (s.pending && !s.pending.overdue && serverNow >= s.pending.deadlineAt) return `overdue:${s.pending.id}`
  return null
}
