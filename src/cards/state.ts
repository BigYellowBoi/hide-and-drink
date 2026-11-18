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

export type EffectStatus = 'active' | 'clear_requested' | 'cleared' | 'vetoed'

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

/** A question the seekers can't ask this run (question_ban card). */
export interface Ban {
  type: string
  optionId: string
  label: string
  instanceId: string
}

/** A curse the seekers vetoed, and the bar lock it cost them. */
export interface Veto {
  seq: number
  instanceId: string
  name: string
  number: number
  lockS: number
  lockStartsAt: number
  lockEndsAt: number
  penalty: string
}

/** A dice roll or wheel spin for a played card (server random). */
export interface Roll {
  seq: number
  instanceId: string
  name: string
  kind: 'dice' | 'wheel'
  dice: number[]
  total: number | null
  result: string | null
  by: string | null
}

/** A drink the app asked to see a photo of. Open until the drinking team sends one. */
export interface DrinkProof {
  id: string
  seq: number
  team: 'hiders' | 'seekers'
  cost: 'drink' | 'shot'
  label: string
  path: string | null
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
  /** Reward multiplier the next answer gets (next_question_modifier cards; 1 = none). */
  nextRewardMultiplier: number
  bans: Ban[]
  vetoes: Veto[]
  /** The hider played Move and hasn't locked in the new bar yet. */
  moving: boolean
  rolls: Roll[]
  proofs: DrinkProof[]
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
  nextRewardMultiplier: 1,
  bans: [],
  vetoes: [],
  moving: false,
  rolls: [],
  proofs: [],
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
      const discarded = new Set(strings(p.discarded))
      const dup = isObject(p.duplicate) ? p.duplicate : null
      const copy = dup && str(dup.instance_id) && str(dup.card_id) ? { instanceId: str(dup.instance_id)!, cardId: str(dup.card_id)! } : null
      const mult = num(p.reward_multiplier)
      const bans = (Array.isArray(p.bans) ? p.bans : []).flatMap((b): Ban[] => {
        if (!isObject(b) || !str(b.type) || !str(b.option_id)) return []
        return [{ type: str(b.type)!, optionId: str(b.option_id)!, label: str(b.label) ?? str(b.option_id)!, instanceId }]
      })
      let next: CardsState = {
        ...state,
        hand: [...state.hand.filter((c) => c.instanceId !== instanceId && !discarded.has(c.instanceId)), ...(copy ? [copy] : [])],
        played: [...state.played, { seq: e.seq, instanceId, card, playedAt, effectId }],
        nextRewardMultiplier: mult && mult > 0 ? state.nextRewardMultiplier * mult : state.nextRewardMultiplier,
        bans: [...state.bans, ...bans],
        moving: state.moving || powerupAction(card) === 'move',
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
      return log({ kind: 'card', text: playedText(state, card, p), colour: card.colour, private: e.visibility === 'hiders' }, next)
    }
    case 'question_answered':
      // The server spends every waiting modifier on the next answer.
      return state.nextRewardMultiplier === 1 ? state : { ...state, nextRewardMultiplier: 1 }
    case 'hider_moved':
      return log({ kind: 'card', text: 'Hider has moved to a new bar' }, { ...state, moving: false })
    case 'curse_vetoed': {
      const instanceId = str(p.instance_id)
      if (!instanceId) return state
      const lockS = num(p.lock_s) ?? 0
      const veto: Veto = {
        seq: e.seq,
        instanceId,
        name: str(p.name) ?? 'Curse',
        number: num(p.veto_number) ?? state.vetoes.length + 1,
        lockS,
        lockStartsAt: time(p.lock_starts_at, e.created_at),
        lockEndsAt: time(p.lock_ends_at, e.created_at),
        penalty: str(p.penalty) ?? 'each seeker drinks',
      }
      const next = updateEffect(
        { ...state, vetoes: [...state.vetoes, veto], bans: state.bans.filter((b) => b.instanceId !== instanceId) },
        str(p.effect_id),
        (x) => ({ ...x, status: 'vetoed' }),
      )
      return log({ kind: 'penalty', text: `Seekers vetoed ${veto.name}: locked at a bar for ${minutes(lockS)}, ${veto.penalty}` }, next)
    }
    case 'dice_rolled':
    case 'wheel_spun': {
      const instanceId = str(p.instance_id)
      if (!instanceId) return state
      const dice = Array.isArray(p.dice) ? p.dice.filter((d): d is number => typeof d === 'number') : []
      const roll: Roll = {
        seq: e.seq,
        instanceId,
        name: str(p.name) ?? 'Card',
        kind: e.type === 'dice_rolled' ? 'dice' : 'wheel',
        dice,
        total: num(p.total),
        result: str(p.result),
        by: str(p.by),
      }
      const text = roll.kind === 'dice' ? `${roll.name}: rolled ${dice.join(' + ')}${dice.length > 1 ? ` = ${roll.total}` : ''}` : `${roll.name}: wheel says ${roll.result}`
      return log({ kind: 'card', text }, { ...state, rolls: [...state.rolls, roll] })
    }
    case 'drink_due': {
      const id = str(p.proof_id)
      const team = p.team === 'hiders' || p.team === 'seekers' ? p.team : null
      if (!id || !team) return state
      const proof: DrinkProof = { id, seq: e.seq, team, cost: p.cost === 'shot' ? 'shot' : 'drink', label: str(p.label) ?? 'Drink', path: null }
      const who = team === 'hiders' ? 'Hiders' : 'Seekers'
      return log({ kind: 'penalty', text: `${who}: ${proof.cost} (${proof.label}). Photo proof needed` }, { ...state, proofs: [...state.proofs, proof] })
    }
    case 'drink_proved': {
      const id = str(p.proof_id)
      const path = str(p.path)
      const proof = state.proofs.find((x) => x.id === id)
      if (!id || !path) return state
      const next = { ...state, proofs: state.proofs.map((x) => (x.id === id ? { ...x, path } : x)) }
      const who = p.team === 'hiders' ? 'Hiders' : 'Seekers'
      return log({ kind: 'proof', text: `${who} drank: ${proof?.label ?? 'drink'}`, photo: path, photoBucket: DRINK_BUCKET }, next)
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
  if (e.status === 'vetoed') return 'over'
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
  s.effects.filter((e) => e.blocksQuestions && (e.status === 'active' || e.status === 'clear_requested'))

/** The countdown an effect shows now: [ends at, total seconds], or null. */
export function effectTimer(e: Effect, now: number): [number, number] | null {
  const phase = effectPhase(e, now)
  if (phase === 'running' && e.endsAt !== null) return [e.endsAt, e.durationS ?? 0]
  if (phase === 'followup' && e.followupEndsAt !== null) return [e.followupEndsAt, e.followupS ?? 0]
  return null
}

/** Powerup actions play_card handles. */
export const POWERUP_ACTIONS = ['veto', 'randomize', 'duplicate', 'move', 'discard_draw'] as const
export type PowerupAction = (typeof POWERUP_ACTIONS)[number]
export const powerupAction = (c: CardDef): PowerupAction | null => {
  const a = c.behaviour === 'powerup' ? c.params.action : null
  return (POWERUP_ACTIONS as readonly unknown[]).includes(a) ? (a as PowerupAction) : null
}

/** Behaviours play_card handles (time bonuses stay in the hand). */
export const PLAYABLE = ['text', 'timed', 'until_cleared', 'next_question_modifier', 'question_ban', 'powerup'] as const
export const isPlayable = (c: CardDef) =>
  (PLAYABLE as readonly string[]).includes(c.behaviour) && (c.behaviour !== 'powerup' || powerupAction(c) !== null)

/** Drink proof photos: private bucket drink-photos, path <game_id>/<proof_id>/<file>. */
export const DRINK_BUCKET = 'drink-photos'

/** What a card_played event says in the log. */
function playedText(s: CardsState, card: CardDef, p: Record<string, unknown>): string {
  switch (powerupAction(card)) {
    case 'veto':
      return 'Hider vetoed the question (no reward)'
    case 'randomize':
      return 'Hider randomized the question'
    case 'move':
      return 'Hider is moving to a new bar. Questions wait until they lock it in'
    case 'duplicate': {
      const dup = isObject(p.duplicate) ? str(p.duplicate.card_id) : null
      return `Duplicated ${dup ? cardOf(s, dup).name : 'a card'}`
    }
    case 'discard_draw':
      return `${card.name}: discarded ${strings(p.discarded).length}`
  }
  if (card.behaviour === 'question_ban' && Array.isArray(p.bans)) {
    const labels = p.bans.flatMap((b) => (isObject(b) && str(b.label) ? [str(b.label)!] : []))
    return `${card.name} played: banned ${labels.join(', ')}`
  }
  if (card.behaviour === 'next_question_modifier') return `${card.name} played: next reward ×${num(p.reward_multiplier) ?? 2}`
  return `${card.name} played`
}

/** What play_card needs picked before it can be cast. */
export type CastChoice =
  | { kind: 'none' }
  | { kind: 'target' }
  | { kind: 'discard'; count: number }
  | { kind: 'bans'; count: number; distinctTypes: boolean }

export function castChoice(c: CardDef): CastChoice {
  if (c.behaviour === 'question_ban') {
    return { kind: 'bans', count: Math.max(1, Math.floor(num(c.params.count) ?? 1)), distinctTypes: c.params.distinct_types === true }
  }
  const a = powerupAction(c)
  if (a === 'duplicate') return { kind: 'target' }
  if (a === 'discard_draw') return { kind: 'discard', count: Math.max(0, Math.floor(num(c.params.discard) ?? 0)) }
  return { kind: 'none' }
}

/** Why a powerup can't be cast right now (null: it can). The server checks the same. */
export function castBlocker(
  c: CardDef,
  ctx: { pendingQuestion: boolean; barChosen: boolean; moving: boolean; handSize: number },
): string | null {
  const a = powerupAction(c)
  if ((a === 'veto' || a === 'randomize') && !ctx.pendingQuestion) return 'Play this while a question is waiting for you.'
  if (a === 'move') {
    if (!ctx.barChosen) return 'Lock in a bar first.'
    if (ctx.moving) return 'You are already moving.'
    if (ctx.pendingQuestion) return 'Answer the waiting question first.'
  }
  if (a === 'duplicate' && ctx.handSize < 2) return 'You need another card in your hand to copy.'
  const choice = castChoice(c)
  if (choice.kind === 'discard' && ctx.handSize - 1 < choice.count) return `You need ${choice.count} other card${choice.count > 1 ? 's' : ''} to discard.`
  return null
}

/** Key for a banned question. */
export const banKey = (type: string, optionId: string) => `${type}:${optionId}`
export const bannedSet = (s: CardsState) => new Set(s.bans.map((b) => banKey(b.type, b.optionId)))

/** The bar lock the seekers are serving now or next (vetoes chain), or null. */
export function vetoLock(s: CardsState, now: number): Veto | null {
  return s.vetoes.filter((v) => v.lockEndsAt > now).sort((a, b) => a.lockStartsAt - b.lockStartsAt)[0] ?? null
}

/** When the seekers' chained veto locks end (server ms), or null when not locked. */
export const lockedUntil = (s: CardsState, now: number) => {
  const end = Math.max(0, ...s.vetoes.map((v) => v.lockEndsAt))
  return end > now ? end : null
}

/** Lock length the next veto would cost: base + step x vetoes used (config veto, defaults 10 min each). */
export function nextVetoLockS(s: CardsState, config: Record<string, unknown>): number {
  const veto = isObject(config.veto) ? config.veto : {}
  const pos = (v: unknown, d: number) => (num(v) !== null && num(v)! > 0 ? num(v)! : d)
  return pos(veto.base_lock_s, 600) + pos(veto.step_s, 600) * s.vetoes.length
}

/** A played curse the seekers can still veto. */
export function vetoable(s: CardsState, p: PlayedCard, now: number): boolean {
  if (p.card.canVeto !== true || s.vetoes.some((v) => v.instanceId === p.instanceId)) return false
  const effect = p.effectId ? s.effects.find((x) => x.id === p.effectId) : null
  if (!effect) return p.card.category === 'curse'
  const phase = effectPhase(effect, now)
  return phase !== 'over' && phase !== 'followup_available'
}

/** The card's utility: dice (count) or wheel (in-app options, or a link). */
export function cardUtility(c: CardDef): { kind: 'dice'; dice: number } | { kind: 'wheel'; options: string[]; url: string | null } | null {
  if (c.params.utility === 'dice') return { kind: 'dice', dice: Math.max(1, Math.min(10, Math.floor(num(c.params.dice) ?? 1))) }
  if (c.params.utility === 'wheel') {
    const options = strings(c.params.wheel_options)
    return { kind: 'wheel', options, url: str(c.params.wheel_url) }
  }
  return null
}

/** Open drink proofs a team still owes. */
export const openProofs = (s: CardsState, team: 'hiders' | 'seekers') => s.proofs.filter((p) => p.team === team && !p.path)

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
  if (c.behaviour === 'next_question_modifier') out.push(`Next reward ×${num(c.params.reward_multiplier) ?? 2}`)
  if (c.behaviour === 'question_ban') {
    const n = num(c.params.count) ?? 1
    out.push(`Bans ${n} question${n > 1 ? 's' : ''}${c.params.until === 'end_of_run' ? ' for the run' : ''}`)
  }
  if (powerupAction(c) === 'discard_draw') out.push(`Discard ${num(c.params.discard) ?? 0}, draw ${num(c.params.draw) ?? 0}`)
  const u = cardUtility(c)
  if (u?.kind === 'dice') out.push(`Roll ${u.dice} ${u.dice > 1 ? 'dice' : 'die'}`)
  if (u?.kind === 'wheel') out.push('Spin the wheel')
  if (c.params.proof === 'photo' || c.params.proof === 'video') out.push(`${c.params.proof === 'photo' ? 'Photo' : 'Video'} proof`)
  if (c.canVeto === false && c.category === 'curse') out.push("Can't veto")
  return out
}

export const COST_LABEL: Record<string, string> = { free: 'Free', drink: 'Drink', shot: 'Shot' }
