import type { GameEvent } from '../sync/types'
import { isLngLat, type LngLat } from './geo'

/** Question types the app has a tool, shading and suggestion for. The rest come later. */
export const SUPPORTED_TYPES = ['radar', 'thermometer'] as const
export type SupportedType = (typeof SUPPORTED_TYPES)[number]
export const isSupportedType = (t: string): t is SupportedType => (SUPPORTED_TYPES as readonly string[]).includes(t)

export const ANSWERS: Record<SupportedType, readonly [string, string]> = {
  radar: ['yes', 'no'],
  thermometer: ['hotter', 'colder'],
}

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
}

export type LogKind = 'seeking' | 'asked' | 'answered' | 'penalty' | 'bar'
export interface LogEntry {
  seq: number
  kind: LogKind
  at: number
  text: string
  /** Hider-only entry (shown with a lock). */
  private?: boolean
}

export interface PlayState {
  round: number
  /** Server ms when seeking starts (end of the hiding period). */
  seekingAt: number | null
  seekingStarted: boolean
  questions: Question[]
  pending: Question | null
  penalties: number
  log: LogEntry[]
}

export const emptyPlay: PlayState = {
  round: 0,
  seekingAt: null,
  seekingStarted: false,
  questions: [],
  pending: null,
  penalties: 0,
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

/** Short label for a question: "Radar 1 km", "Thermometer 500 m". */
export function questionLabel(q: Pick<Question, 'type' | 'params'>): string {
  const name = q.type.charAt(0).toUpperCase() + q.type.slice(1)
  const d = num(q.params.distance_m)
  return d ? `${name} ${km(d)}` : name
}

export const answerLabel = (a: string) => a.charAt(0).toUpperCase() + a.slice(1)

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

function update(state: PlayState, id: string | null, f: (q: Question) => Question): PlayState {
  const questions = state.questions.map((q) => (q.id === id ? f(q) : q))
  return { ...state, questions, pending: questions.find((q) => q.answer === null) ?? null }
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
        seekingStarted: true,
        log: [...state.log, { seq: e.seq, kind: 'seeking', at: time(p.at, e.created_at), text: 'Seeking started' }],
      }
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
      }
      return {
        ...state,
        // The server only lets a seeker ask once the hiding period is over.
        seekingStarted: true,
        questions: [...state.questions, q],
        pending: q,
        log: [...state.log, { seq: e.seq, kind: 'asked', at, text: `${questionLabel(q)} asked` }],
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
      }))
      const label = q ? questionLabel(q) : 'Question'
      return {
        ...next,
        log: [
          ...next.log,
          { seq: e.seq, kind: 'answered', at, text: `${label}: ${answerLabel(answer)}${p.late === true ? ' (late)' : ''}` },
        ],
      }
    }
    case 'answer_overdue': {
      const id = str(p.question_id)
      const next = update(state, id, (x) => ({ ...x, overdue: true }))
      return {
        ...next,
        penalties: next.penalties + 1,
        log: [...next.log, { seq: e.seq, kind: 'penalty', at, text: 'Answer deadline missed: hiders take a shot' }],
      }
    }
    default:
      return state
  }
}

export const derivePlay = (events: readonly GameEvent[]): PlayState => events.reduce(applyPlayEvent, emptyPlay)

/** Answered questions of this round the app can shade. */
export const shadable = (s: PlayState) =>
  s.questions.filter((q) => q.round === s.round && q.answer !== null && isSupportedType(q.type))

/** What a phone should ask the server to settle now (null: nothing due). Server decides. */
export function dueTimer(s: PlayState, serverNow: number): string | null {
  if (!s.seekingStarted && s.seekingAt !== null && serverNow >= s.seekingAt) return `seeking:${s.round}`
  if (s.pending && !s.pending.overdue && serverNow >= s.pending.deadlineAt) return `overdue:${s.pending.id}`
  return null
}
