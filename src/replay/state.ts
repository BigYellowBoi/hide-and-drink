import type { GameEvent, Team } from '../sync/types'
import { deriveLobby, type StartedRound } from '../lobby/state'
import { derivePlay, shadable, type Question } from '../play/state'
import { deriveCards, type CardsState } from '../cards/state'
import { buildTimeline, type TimelineItem } from '../play/timeline'
import { deriveHiding, type ChosenBar } from '../hiding/state'
import { effectiveEvents } from '../overrides/state'
import type { LogEntry } from '../play/state'
import type { MapDot, MapPath } from '../components/GameMap'
import type { TrackPoint } from './api'

/**
 * The end-of-game replay, built from the whole event log (both teams' events: once a game has
 * ended everyone sees everything) and the position track. Pure, so it is tested without a map.
 */

export interface ReplayRound {
  round: number
  started: StartedRound
  /** Seq range of the round: game_started (exclusive of the previous round) to the next one. */
  fromSeq: number
  toSeq: number
  /** Events up to the end of this round, for the round's play and card state. */
  events: readonly GameEvent[]
  cards: CardsState
  log: LogEntry[]
  bar: ChosenBar | null
  hiders: string[]
}

export type ReplayStep =
  | { kind: 'round'; round: number; seq: number; at: number }
  | { kind: 'item'; round: number; seq: number; at: number; item: TimelineItem }
  | { kind: 'end'; round: number; seq: number; at: number }

export interface Replay {
  events: readonly GameEvent[]
  rounds: ReplayRound[]
  /** Every reveal, oldest first; times never go backwards. */
  steps: ReplayStep[]
  start: number
  end: number
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function buildReplay(raw: readonly GameEvent[]): Replay {
  const events = [...effectiveEvents(raw)].sort((a, b) => a.seq - b.seq)
  const starts = events.filter((e) => e.type === 'game_started')
  const lastSeq = events.at(-1)?.seq ?? 0
  const rounds: ReplayRound[] = []
  starts.forEach((s, i) => {
    const toSeq = (starts[i + 1]?.seq ?? lastSeq + 1) - 1
    const upTo = events.filter((e) => e.seq <= toSeq)
    const started = deriveLobby(upTo).started
    if (!started) return
    const play = derivePlay(upTo)
    const cards = deriveCards(upTo)
    const inRound = (seq: number) => seq >= s.seq && seq <= toSeq
    const log = [...play.log, ...cards.log].filter((l) => inRound(l.seq)).sort((a, b) => a.seq - b.seq)
    // Teams as the round started (they swap when it ends).
    const hiders = deriveLobby(events.filter((e) => e.seq <= s.seq)).players.filter((p) => p.team === 'hiders').map((p) => p.userId)
    rounds.push({
      round: started.round,
      started,
      fromSeq: s.seq,
      toSeq,
      events: upTo,
      cards: { ...cards, played: cards.played.filter((p) => inRound(p.seq)) },
      log,
      bar: deriveHiding(upTo, started.round).bar,
      hiders,
    })
  })

  const steps: ReplayStep[] = []
  for (const r of rounds) {
    const play = derivePlay(r.events)
    steps.push({ kind: 'round', round: r.round, seq: r.fromSeq, at: r.started.startedAt })
    const items = buildTimeline(play.questions, r.log, r.cards.played).sort((a, b) => a.seq - b.seq)
    for (const item of items) steps.push({ kind: 'item', round: r.round, seq: item.seq, at: item.at, item })
  }
  const ended = [...events].reverse().find((e) => e.type === 'game_ended')
  if (ended) {
    const at = Date.parse(typeof ended.payload.at === 'string' ? ended.payload.at : ended.created_at)
    steps.push({ kind: 'end', round: rounds.at(-1)?.round ?? 0, seq: ended.seq, at })
  }
  steps.sort((a, b) => a.seq - b.seq)
  let t = -Infinity
  for (const s of steps) {
    if (!Number.isFinite(s.at)) s.at = t
    t = s.at = Math.max(t, s.at)
  }
  const first = Date.parse(events[0]?.created_at ?? '')
  return {
    events,
    rounds,
    steps,
    start: steps[0]?.at ?? (Number.isNaN(first) ? 0 : first),
    end: steps.at(-1)?.at ?? (Number.isNaN(first) ? 0 : first),
  }
}

/** Index of the last step revealed at time t (-1: none yet). */
export function stepAt(steps: readonly ReplayStep[], t: number): number {
  let i = -1
  for (let j = 0; j < steps.length; j++) if (steps[j].at <= t) i = j
  return i
}

/** The round showing at time t: the round of the last step revealed (else the first). */
export function roundAt(replay: Replay, t: number): ReplayRound | null {
  const i = stepAt(replay.steps, t)
  const round = i >= 0 ? replay.steps[i].round : replay.rounds[0]?.round
  return replay.rounds.find((r) => r.round === round) ?? null
}

export interface TrackView {
  paths: MapPath[]
  dots: MapDot[]
}

/** Each player's path in one round up to time t, and where they were at t. */
export function trackAt(
  track: readonly TrackPoint[],
  round: number,
  t: number,
  nameOf: (userId: string) => string,
): TrackView {
  const byUser = new Map<string, { team: Team; coords: [number, number][]; stale: boolean }>()
  for (const p of track) {
    if (p.round !== round) continue
    const at = Date.parse(p.at)
    if (!(at <= t)) continue
    const lng = num(p.lng)
    const lat = num(p.lat)
    if (lng === null || lat === null) continue
    let u = byUser.get(p.user_id)
    if (!u) byUser.set(p.user_id, (u = { team: p.team, coords: [], stale: false }))
    u.team = p.team
    u.coords.push([lng, lat])
    // No point for 3 min: the phone was closed or had no signal.
    u.stale = t - at > 180_000
  }
  const paths: MapPath[] = []
  const dots: MapDot[] = []
  for (const [id, u] of byUser) {
    paths.push({ id, team: u.team, coords: u.coords })
    const [lng, lat] = u.coords[u.coords.length - 1]
    dots.push({ id, lng, lat, team: u.team, name: nameOf(id), stale: u.stale })
  }
  return { paths, dots }
}

/**
 * The round's questions the map shades as of a step (seq): answered by then, since the hider's
 * last move, with any manual shading set by then. Shading builds up as the replay goes.
 */
export function shadableAt(round: ReplayRound, seq: number): Question[] {
  return shadable(derivePlay(round.events.filter((e) => e.seq <= seq)))
}
