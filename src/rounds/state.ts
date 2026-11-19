import type { GameEvent } from '../sync/types'

/**
 * Rounds and scores from the public events (round_ended, score_adjusted, round_redone,
 * game_ended). A round's score is its hiders' hide time (found − seeking start) plus the time
 * bonuses they held, plus any host adjustment. Each player's total is the sum of the rounds
 * they hid; rounds a redo voided don't count. Mirrors _game_result on the server.
 */

export interface RoundPlayer {
  userId: string
  name: string
}

export interface RoundScore {
  round: number
  hiders: RoundPlayer[]
  seekers: RoundPlayer[]
  /** Server time, ms. Null for a round redone before seeking started. */
  seekingAt: number | null
  endedAt: number | null
  foundBy: string | null
  barName: string | null
  hideS: number
  bonusS: number
  adjustS: number
  totalS: number
  /** Redone: played again, doesn't count. */
  voided: boolean
}

export interface GameResult {
  reason: 'host' | 'inactive'
  /** User ids of the winners (empty: no round was scored). */
  winners: string[]
  /** A round that was still running when the game ended (it doesn't count). */
  unfinishedRound: number | null
  at: number
}

export interface RoundsState {
  rounds: RoundScore[]
  /** Where the hiders were, for the round that just ended (public once it's over). */
  lastBar: { round: number; name: string; lng: number; lat: number } | null
  result: GameResult | null
}

export const noRounds: RoundsState = { rounds: [], lastBar: null, result: null }

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const time = (v: unknown): number | null => {
  const t = Date.parse(str(v) ?? '')
  return Number.isNaN(t) ? null : t
}

const people = (v: unknown): RoundPlayer[] =>
  (Array.isArray(v) ? v : []).flatMap((x) => (isObj(x) && str(x.user_id) ? [{ userId: str(x.user_id)!, name: str(x.name) ?? 'Player' }] : []))

export function parseScore(v: unknown): RoundScore | null {
  if (!isObj(v) || num(v.round) === null) return null
  const hideS = num(v.hide_s) ?? 0
  const bonusS = num(v.bonus_s) ?? 0
  const adjustS = num(v.adjust_s) ?? 0
  return {
    round: num(v.round)!,
    hiders: people(v.hiders),
    seekers: people(v.seekers),
    seekingAt: time(v.seeking_at),
    endedAt: time(v.ended_at),
    foundBy: str(v.found_by),
    barName: str(v.bar_name),
    hideS,
    bonusS,
    adjustS,
    totalS: num(v.total_s) ?? hideS + bonusS + adjustS,
    voided: v.voided === true,
  }
}

const put = (rounds: RoundScore[], r: RoundScore) => [...rounds.filter((x) => x.round !== r.round), r].sort((a, b) => a.round - b.round)

export function applyRoundEvent(state: RoundsState, e: GameEvent): RoundsState {
  const p = e.payload
  switch (e.type) {
    case 'round_ended': {
      const r = parseScore(p.score)
      if (!r) return state
      const bar = isObj(p.bar) && str(p.bar.name) && num(p.bar.lng) !== null && num(p.bar.lat) !== null
        ? { round: r.round, name: str(p.bar.name)!, lng: num(p.bar.lng)!, lat: num(p.bar.lat)! }
        : null
      return { ...state, rounds: put(state.rounds, r), lastBar: bar }
    }
    case 'score_adjusted':
    case 'round_redone': {
      const r = parseScore(p.score)
      return r ? { ...state, rounds: put(state.rounds, r) } : state
    }
    case 'game_ended': {
      // The final word: the server's rounds replace ours.
      const rounds = (Array.isArray(p.rounds) ? p.rounds : []).map(parseScore).filter((r): r is RoundScore => !!r)
      return {
        ...state,
        rounds: rounds.length ? rounds : state.rounds,
        result: {
          reason: p.reason === 'inactive' ? 'inactive' : 'host',
          winners: (Array.isArray(p.winners) ? p.winners : []).filter((x): x is string => typeof x === 'string'),
          unfinishedRound: num(p.unfinished_round),
          at: time(p.at) ?? Date.parse(e.created_at),
        },
      }
    }
    default:
      return state
  }
}

export const deriveRounds = (events: readonly GameEvent[]): RoundsState => events.reduce(applyRoundEvent, noRounds)

export const scoredRounds = (s: RoundsState) => s.rounds.filter((r) => !r.voided)

export interface Side {
  /** Everyone who hid exactly these rounds (with a full swap each round: a team). */
  players: RoundPlayer[]
  rounds: number[]
  totalS: number
}

/**
 * Players grouped by the rounds they hid, best total first. With teams swapping every round
 * these are the two teams; players who never hid are a side with 0 (if any were given).
 */
export function sides(s: RoundsState, everyone: RoundPlayer[] = []): Side[] {
  const totals = new Map<string, { player: RoundPlayer; rounds: number[]; totalS: number }>()
  for (const p of everyone) totals.set(p.userId, { player: p, rounds: [], totalS: 0 })
  for (const r of scoredRounds(s)) {
    for (const h of r.hiders) {
      const t = totals.get(h.userId) ?? { player: h, rounds: [], totalS: 0 }
      totals.set(h.userId, { ...t, rounds: [...t.rounds, r.round], totalS: t.totalS + r.totalS })
    }
  }
  const groups = new Map<string, Side>()
  for (const t of totals.values()) {
    const key = t.rounds.join(',')
    const g = groups.get(key) ?? { players: [], rounds: t.rounds, totalS: t.totalS }
    groups.set(key, { ...g, players: [...g.players, t.player] })
  }
  return [...groups.values()].sort((a, b) => b.totalS - a.totalS || (a.rounds[0] ?? Infinity) - (b.rounds[0] ?? Infinity))
}

/** "1 h 02 min", "47 min 10 s", "−5 min". Scores are whole seconds. */
export function formatDuration(totalS: number): string {
  const sign = totalS < 0 ? '−' : ''
  const s = Math.abs(Math.round(totalS))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h) return `${sign}${h} h ${String(m).padStart(2, '0')} min`
  if (m) return sec ? `${sign}${m} min ${String(sec).padStart(2, '0')} s` : `${sign}${m} min`
  return `${sign}${sec} s`
}

export const names = (ps: RoundPlayer[]) => ps.map((p) => p.name).join(', ') || 'nobody'
