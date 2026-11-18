import type { GameEvent } from '../sync/types'
import type { LogEntry } from '../play/state'

/** A card of this round's deck, as snapshotted at the start (game_started.deck). */
export interface CardDef {
  id: string
  name: string
  category: string
  categoryName: string
  colour: string
  behaviour: string
  text: string | null
  params: Record<string, unknown>
  castCost: 'free' | 'drink' | 'shot' | null
  canVeto: boolean | null
  copies: number
}

/** One physical card: an instance of a deck card. */
export interface CardRef {
  instanceId: string
  cardId: string
}

/** A question reward waiting for the hider to pick which cards to keep. */
export interface PendingDraw {
  drawId: string
  seq: number
  questionId: string | null
  pick: number
  cards: CardRef[]
}

export type EffectStatus = 'active' | 'clear_requested' | 'cleared'

/** A played timed or until_cleared card. */
export interface Effect {
  id: string
  seq: number
  card: CardDef
  behaviour: 'timed' | 'until_cleared'
  playedAt: number
  /** Timed: server ms the countdown ends. */
  endsAt: number | null
  durationS: number | null
  followupS: number | null
  followupEndsAt: number | null
  blocksQuestions: boolean
  status: EffectStatus
}

export interface PlayedCard {
  seq: number
  instanceId: string
  card: CardDef
  playedAt: number
  effectId: string | null
}

export interface CardsState {
  round: number
  /** Deck list by card id (public). */
  deck: Record<string, CardDef>
  deckSize: number
  handLimit: number
  /** Hider-only: what the hider has drawn, kept and discarded. Empty for seekers. */
  hand: CardRef[]
  draws: PendingDraw[]
  /** Cards left in the draw pile (hider-only knowledge; null for seekers). */
  pileLeft: number | null
  played: PlayedCard[]
  effects: Effect[]
  log: LogEntry[]
}

export const emptyCards: CardsState = {
  round: 0,
  deck: {},
  deckSize: 0,
  handLimit: 6,
  hand: [],
  draws: [],
  pileLeft: null,
  played: [],
  effects: [],
  log: [],
}

const str = (v: unknown) => (typeof v === 'string' ? v : null)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const time = (v: unknown, fallback: string) => {
  const t = Date.parse(str(v) ?? '')
  return Number.isNaN(t) ? Date.parse(fallback) : t
}
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

export function parseCard(v: unknown): CardDef | null {
  if (!isObject(v)) return null
  const id = str(v.card_id)
  if (!id) return null
  const cost = v.cast_cost
  return {
    id,
    name: str(v.name) ?? id,
    category: str(v.category) ?? '',
    categoryName: str(v.category_name) ?? str(v.category) ?? '',
    colour: str(v.colour) ?? '#A9B4BF',
    behaviour: str(v.behaviour) ?? 'text',
    text: str(v.text),
    params: isObject(v.params) ? v.params : {},
    castCost: cost === 'free' || cost === 'drink' || cost === 'shot' ? cost : null,
    canVeto: typeof v.can_veto === 'boolean' ? v.can_veto : null,
    copies: num(v.copies) ?? 1,
  }
}

const unknownCard = (id: string): CardDef => ({
  id,
  name: id,
  category: '',
  categoryName: '',
  colour: '#A9B4BF',
  behaviour: 'text',
  text: null,
  params: {},
  castCost: null,
  canVeto: null,
  copies: 1,
})

export const cardOf = (s: Pick<CardsState, 'deck'>, id: string): CardDef => s.deck[id] ?? unknownCard(id)

const updateEffect = (s: CardsState, id: string | null, f: (e: Effect) => Effect): CardsState => ({
  ...s,
  effects: s.effects.map((e) => (e.id === id ? f(e) : e)),
})

const minutes = (sec: number) => `${Math.round(sec / 60)} min`

export function applyCardEvent(state: CardsState, e: GameEvent): CardsState {
  const p = e.payload
  const at = Date.parse(e.created_at)
  const log = (entry: Omit<LogEntry, 'seq' | 'at'>, s: CardsState = state): CardsState => ({
    ...s,
    log: [...s.log, { seq: e.seq, at, ...entry }],
  })
  switch (e.type) {
    case 'game_started': {
      const deck: Record<string, CardDef> = {}
      for (const c of Array.isArray(p.deck) ? p.deck : []) {
        const card = parseCard(c)
        if (card) deck[card.id] = card
      }
      const deckSize = Object.values(deck).reduce((n, c) => n + c.copies, 0)
      return {
        ...emptyCards,
        round: num(p.round) ?? 1,
        deck,
        deckSize,
        handLimit: num(p.hand_limit) ?? 6,
        log: state.log,
      }
    }
    case 'cards_drawn': {
      const drawId = str(p.draw_id)
      if (!drawId) return state
      const cards = (Array.isArray(p.cards) ? p.cards : []).flatMap((c): CardRef[] => {
        const instanceId = isObject(c) ? str(c.instance_id) : null
        const cardId = isObject(c) ? str(c.card_id) : null
        return instanceId && cardId ? [{ instanceId, cardId }] : []
      })
      const pick = num(p.pick) ?? 1
      const next: CardsState = {
        ...state,
        draws: [...state.draws, { drawId, seq: e.seq, questionId: str(p.question_id), pick, cards }],
        pileLeft: num(p.pile_left) ?? state.pileLeft,
      }
      return log({ kind: 'draw', text: `Drew ${cards.length}, keep ${pick}`, private: true }, next)
    }
    case 'cards_kept': {
      const drawId = str(p.draw_id)
      const draw = state.draws.find((d) => d.drawId === drawId)
      const kept = new Set(strings(p.kept))
      const dropped = new Set(strings(p.discarded))
      const fromDraw = draw?.cards.filter((c) => kept.has(c.instanceId)) ?? []
      const next: CardsState = {
        ...state,
        draws: state.draws.filter((d) => d.drawId !== drawId),
        hand: [...state.hand.filter((c) => !dropped.has(c.instanceId)), ...fromDraw],
      }
      const names = fromDraw.map((c) => cardOf(state, c.cardId).name).join(', ')
      return log({ kind: 'draw', text: `Kept ${names || 'cards'}`, private: true }, next)
    }
    case 'card_played': {
      const card = parseCard(p.card)
      const instanceId = str(p.instance_id)
      if (!card || !instanceId) return state
      const playedAt = time(p.played_at, e.created_at)
      const effectId = str(p.effect_id)
      let next: CardsState = {
        ...state,
        hand: state.hand.filter((c) => c.instanceId !== instanceId),
        played: [...state.played, { seq: e.seq, instanceId, card, playedAt, effectId }],
      }
      if (effectId && (card.behaviour === 'timed' || card.behaviour === 'until_cleared')) {
        const endsAt = card.behaviour === 'timed' ? time(p.ends_at, e.created_at) : null
        next = {
          ...next,
          effects: [
            ...next.effects,
            {
              id: effectId,
              seq: e.seq,
              card,
              behaviour: card.behaviour,
              playedAt,
              endsAt,
              durationS: num(p.duration_s),
              followupS: num(p.followup_s),
              followupEndsAt: null,
              blocksQuestions: p.blocks_questions === true,
              status: 'active',
            },
          ],
        }
      }
      return log({ kind: 'card', text: `${card.name} played`, colour: card.colour }, next)
    }
    case 'effect_clear_requested': {
      const id = str(p.effect_id)
      const next = updateEffect(state, id, (x) => ({ ...x, status: 'clear_requested' }))
      const name = next.effects.find((x) => x.id === id)?.card.name ?? 'Curse'
      return log({ kind: 'card', text: `Seekers say ${name} is done` }, next)
    }
    case 'effect_clear_rejected': {
      const id = str(p.effect_id)
      const next = updateEffect(state, id, (x) => ({ ...x, status: 'active' }))
      const name = next.effects.find((x) => x.id === id)?.card.name ?? 'Curse'
      return log({ kind: 'penalty', text: `Hider says ${name} is not done yet` }, next)
    }
    case 'effect_cleared': {
      const id = str(p.effect_id)
      const next = updateEffect(state, id, (x) => ({ ...x, status: 'cleared' }))
      const name = next.effects.find((x) => x.id === id)?.card.name ?? 'Curse'
      return log({ kind: 'card', text: `${name} cleared` }, next)
    }
    case 'effect_followup_started': {
      const id = str(p.effect_id)
      const endsAt = time(p.ends_at, e.created_at)
      const next = updateEffect(state, id, (x) => ({ ...x, followupEndsAt: endsAt }))
      const effect = next.effects.find((x) => x.id === id)
      const len = effect?.followupS ? ` (${minutes(effect.followupS)})` : ''
      return log({ kind: 'penalty', text: `${effect?.card.name ?? 'Curse'}: missed, follow-on timer started${len}` }, next)
    }
    default:
      return state
  }
}

export const deriveCards = (events: readonly GameEvent[]): CardsState => events.reduce(applyCardEvent, emptyCards)

export type EffectPhase =
  /** Timed: main countdown running. */
  | 'running'
  /** Timed: countdown over and a follow-on could still be started. */
  | 'followup_available'
  /** Timed: follow-on countdown running. */
  | 'followup'
  /** Until cleared: in force (or waiting for the hider to confirm). */
  | 'until_cleared'
  | 'awaiting_confirm'
  | 'over'

/** Where an effect is at this (server) time. */
export function effectPhase(e: Effect, now: number): EffectPhase {
  if (e.behaviour === 'until_cleared') {
    return e.status === 'cleared' ? 'over' : e.status === 'clear_requested' ? 'awaiting_confirm' : 'until_cleared'
  }
  if (e.endsAt !== null && now < e.endsAt) return 'running'
  if (e.followupEndsAt !== null) return now < e.followupEndsAt ? 'followup' : 'over'
  // A follow-on can be started for a while after the countdown; after that it drops off.
  if (e.followupS && e.endsAt !== null && now < e.endsAt + FOLLOWUP_WINDOW_MS) return 'followup_available'
  return 'over'
}

/** How long after a timed card ends its "missed it?" button stays up. */
export const FOLLOWUP_WINDOW_MS = 10 * 60_000

/** Effects still affecting play (anything not over), oldest first. */
export const liveEffects = (s: CardsState, now: number) => s.effects.filter((e) => effectPhase(e, now) !== 'over')

/** A blocking until_cleared curse is in force: seekers can't ask (the server refuses too). */
export const questionsBlockedBy = (s: CardsState): Effect[] =>
  s.effects.filter((e) => e.blocksQuestions && e.status !== 'cleared')

/** The countdown an effect shows now: [ends at, total seconds], or null. */
export function effectTimer(e: Effect, now: number): [number, number] | null {
  const phase = effectPhase(e, now)
  if (phase === 'running' && e.endsAt !== null) return [e.endsAt, e.durationS ?? 0]
  if (phase === 'followup' && e.followupEndsAt !== null) return [e.followupEndsAt, e.followupS ?? 0]
  return null
}

/** Behaviours play_card handles; others stay in the hand for now. */
export const PLAYABLE = ['text', 'timed', 'until_cleared'] as const
export const isPlayable = (c: CardDef) => (PLAYABLE as readonly string[]).includes(c.behaviour)

/**
 * Time bonus the hider would get if the round ended now: time_bonus cards count only while
 * held in the hand at the end (they can't be played). Hider-only: seekers have no hand.
 */
export const handBonusS = (s: CardsState): number =>
  s.hand.reduce((sum, c) => {
    const card = cardOf(s, c.cardId)
    const m = card.behaviour === 'time_bonus' ? num(card.params.minutes) : null
    return sum + (m && m > 0 ? m * 60 : 0)
  }, 0)

/** Short facts for a card face: "20 min", "Blocks questions", "+2 min". */
export function cardFacts(c: CardDef): string[] {
  const out: string[] = []
  const d = num(c.params.duration_s)
  const f = num(c.params.followup_s)
  if (c.behaviour === 'timed' && d) out.push(f ? `${minutes(d)}, then ${minutes(f)} if missed` : minutes(d))
  if (c.behaviour === 'until_cleared') out.push(c.params.blocks_questions === true ? 'Blocks questions' : 'Until done')
  if (c.behaviour === 'time_bonus' && num(c.params.minutes)) out.push(`+${num(c.params.minutes)} min`)
  if (c.canVeto === false && c.category === 'curse') out.push("Can't veto")
  return out
}

export const COST_LABEL: Record<string, string> = { free: 'Free', drink: 'Drink', shot: 'Shot' }
