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

/** awaiting_seekers: a seeker_confirm curse the seekers haven't said applies yet. */
export type EffectStatus = 'active' | 'clear_requested' | 'cleared' | 'vetoed' | 'awaiting_seekers'

/** One question of a trivia curse, public to both teams. */
export interface TriviaQuestion {
  question: string
  /** The answer waiting for the hider's mark; null when the seekers owe one. */
  answer: string | null
  answeredBy: string | null
  correct: boolean
  /** Earlier answers the hider marked wrong, oldest first. */
  wrong: string[]
}

/** A trivia curse: the hider's questions (null until sent) and how many it needs. */
export interface Trivia {
  count: number
  /** How many must be right to clear it (params.need_right; default all). */
  need: number
  topic: string | null
  questions: TriviaQuestion[] | null
  /** The host marked everything right by hand. */
  forced: boolean
  /** The last set thrown out for too few right (need_right): how many were right of how many. */
  lastFailed: { right: number; total: number } | null
}

/** A played timed, until_cleared or trivia card. */
export interface Effect {
  id: string
  seq: number
  /** The played card that started it. */
  instanceId: string
  card: CardDef
  behaviour: 'timed' | 'until_cleared' | 'trivia'
  playedAt: number
  /** Timed: server ms the countdown ends. */
  endsAt: number | null
  durationS: number | null
  followupS: number | null
  followupEndsAt: number | null
  blocksQuestions: boolean
  /** A countdown paused by the host: time left, ms (its end is Infinity meanwhile). */
  pausedLeftMs: number | null
  status: EffectStatus
  /** Trivia curses only. */
  trivia: Trivia | null
  /** seeker_confirm curses: what the seekers are asked before it starts (params.seeker_confirm). */
  seekerConfirm: string | null
  /** Minefield (params.mine): the mined question's label, hider-only (null for seekers). */
  mineLabel: string | null
  /** Minefield: the question it went off on, once the seekers asked it. */
  mineTriggered: string | null
}

/** The hiders' number for a card with params.hider_count, or Time Bank's drinks (public). */
export interface CardCount {
  /** What the hiders sent (null for Time Bank: the minutes stay private). */
  count: number | null
  /** What it comes to: drinks for the seekers, or extra cards (reward 'extra_draw'). */
  amount: number
  unit: string
  reward: string | null
}

/** Plagued World: no questions within radiusM of here until endsAt. */
export interface PlagueSpot {
  effectId: string
  questionId: string | null
  lng: number
  lat: number
  radiusM: number
  endsAt: number
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
  /** Paused by the host: time left, ms (lockEndsAt is Infinity meanwhile). */
  pausedLeftMs: number | null
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

/**
 * A photo the app asked for. Open until the team sends one. kind 'drink': a drink (cast cost,
 * a card's params.drinks, veto, missed deadline). kind 'evidence': a curse's params.proof
 * photo or video, sent before the seekers can say they did it (effectId). kind 'setup': the
 * hiders' first step for a curse with params.hider_proof (e.g. Unguided Tourist's screenshot).
 */
export interface DrinkProof {
  id: string
  seq: number
  team: 'hiders' | 'seekers'
  kind: 'drink' | 'evidence' | 'setup'
  cost: 'drink' | 'shot'
  label: string
  path: string | null
  effectId: string | null
  /** The played card it is for (cast cost, card drinks, curse evidence), when known. */
  instanceId: string | null
  /** Closed by the host without a photo: not owed, or drunk without proof. */
  resolution: 'cancelled' | 'waived' | null
  /** A first step the hiders may skip (params.hider_proof_optional): nothing waits for it. */
  optional: boolean
  /** Server time the photo came in or the host closed it, for the "done" toast. */
  doneAt: number | null
  /** Who sent the photo. */
  by: string | null
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
  /** Extra cards the next answer draws (Beer Bonus: hider_count reward 'extra_draw'). */
  nextExtraDraw: number
  /** Hider counts by played card (card_count_set). */
  counts: Record<string, CardCount>
  plagueSpots: PlagueSpot[]
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
  nextExtraDraw: 0,
  counts: {},
  plagueSpots: [],
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
      const qid = str(p.question_id)
      return log({ kind: 'draw', text: `Drew ${cards.length}, keep ${pick}`, private: true, ...(qid ? { questionId: qid } : {}) }, next)
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
      return log(
        { kind: 'draw', text: `Kept ${names || 'cards'}`, private: true, ...(draw?.questionId ? { questionId: draw.questionId } : {}) },
        next,
      )
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
      if (effectId && (card.behaviour === 'timed' || card.behaviour === 'until_cleared' || card.behaviour === 'trivia')) {
        const awaiting = p.awaiting_seekers === true
        const endsAt = card.behaviour === 'timed' ? (awaiting ? Number.POSITIVE_INFINITY : time(p.ends_at, e.created_at)) : null
        next = {
          ...next,
          effects: [
            ...next.effects,
            {
              id: effectId,
              seq: e.seq,
              instanceId,
              card,
              behaviour: card.behaviour,
              playedAt,
              endsAt,
              durationS: num(p.duration_s),
              followupS: num(p.followup_s),
              followupEndsAt: null,
              blocksQuestions: p.blocks_questions === true,
              pausedLeftMs: null,
              status: awaiting ? 'awaiting_seekers' : 'active',
              trivia:
                card.behaviour === 'trivia'
                  ? { count: num(p.count) ?? triviaCount(card), need: triviaNeed(card), topic: triviaTopic(card), questions: null, forced: false, lastFailed: null }
                  : null,
              seekerConfirm: awaiting ? (str(p.seeker_confirm) ?? 'Does this curse apply to you right now?') : null,
              mineLabel: null,
              mineTriggered: null,
            },
          ],
        }
      }
      const closes = str(p.question_id)
      return log(
        {
          kind: 'card',
          text: playedText(state, card, p),
          colour: card.colour,
          private: e.visibility === 'hiders',
          instanceId,
          ...(closes ? { questionId: closes } : {}),
        },
        next,
      )
    }
    case 'question_answered':
      // The server spends every waiting modifier on the next answer.
      return state.nextRewardMultiplier === 1 && state.nextExtraDraw === 0 ? state : { ...state, nextRewardMultiplier: 1, nextExtraDraw: 0 }
    case 'card_count_set': {
      const instanceId = str(p.instance_id)
      const amount = num(p.amount)
      if (!instanceId || amount === null) return state
      const count: CardCount = { count: num(p.count), amount, unit: str(p.unit) ?? 'drink', reward: str(p.reward) }
      const name = str(p.name) ?? state.played.find((x) => x.instanceId === instanceId)?.card.name ?? 'Card'
      const next: CardsState = {
        ...state,
        counts: { ...state.counts, [instanceId]: count },
        nextExtraDraw: count.reward === 'extra_draw' ? state.nextExtraDraw + amount : state.nextExtraDraw,
      }
      return log({ kind: count.reward ? 'card' : 'penalty', text: `${name}: ${countText(count)}`, instanceId }, next)
    }
    case 'bonuses_banked': {
      // Time Bank (hider-only): the time bonuses discarded.
      const ids = new Set(strings(p.discarded))
      const mins = num(p.minutes) ?? 0
      return log(
        { kind: 'card', text: `Banked ${ids.size} time bonus${ids.size === 1 ? '' : 'es'} (${mins} min)`, private: true, ...linkTo(str(p.instance_id)) },
        { ...state, hand: state.hand.filter((c) => !ids.has(c.instanceId)) },
      )
    }
    case 'mine_set': {
      const id = str(p.effect_id)
      const label = mineLabel(p)
      const next = updateEffect(state, id, (x) => ({ ...x, mineLabel: label }))
      return log({ kind: 'card', text: `Mine planted on ${label}`, private: true, ...effectLink(next, id) }, next)
    }
    case 'mine_triggered': {
      const id = str(p.effect_id)
      const label = mineLabel(p)
      const next = updateEffect(state, id, (x) => ({ ...x, mineTriggered: label, blocksQuestions: true }))
      return log(
        { kind: 'penalty', text: `Mine! ${label} was mined: vetoed, every seeker drinks before the next question`, ...effectLink(next, id) },
        next,
      )
    }
    case 'plague_spot': {
      const effectId = str(p.effect_id)
      const lng = num(p.lng)
      const lat = num(p.lat)
      if (!effectId || lng === null || lat === null) return state
      const spot: PlagueSpot = {
        effectId,
        questionId: str(p.question_id),
        lng,
        lat,
        radiusM: num(p.radius_m) ?? 250,
        endsAt: time(p.ends_at, e.created_at),
      }
      return { ...state, plagueSpots: [...state.plagueSpots, spot] }
    }
    case 'hider_moved':
      return log(
        { kind: 'card', text: p.period_over === true ? 'Move over: seekers can move and ask again' : 'Hider has moved to a new bar' },
        { ...state, moving: false },
      )
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
        pausedLeftMs: null,
        penalty: str(p.penalty) ?? 'each seeker drinks',
      }
      const next = updateEffect(
        { ...state, vetoes: [...state.vetoes, veto], bans: state.bans.filter((b) => b.instanceId !== instanceId) },
        str(p.effect_id),
        (x) => ({ ...x, status: 'vetoed' }),
      )
      return log({ kind: 'penalty', text: `Seekers vetoed ${veto.name}: locked at a bar for ${minutes(lockS)}, ${veto.penalty}`, instanceId }, next)
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
      return log({ kind: 'card', text, instanceId }, { ...state, rolls: [...state.rolls, roll] })
    }
    case 'drink_due': {
      const id = str(p.proof_id)
      const team = p.team === 'hiders' || p.team === 'seekers' ? p.team : null
      if (!id || !team) return state
      const proof: DrinkProof = {
        id,
        seq: e.seq,
        team,
        kind: 'drink',
        cost: p.cost === 'shot' ? 'shot' : 'drink',
        label: str(p.label) ?? 'Drink',
        path: null,
        effectId: null,
        instanceId: str(p.instance_id),
        resolution: null,
        optional: false,
        doneAt: null,
        by: null,
      }
      const who = team === 'hiders' ? 'Hiders' : 'Seekers'
      return log(
        { kind: 'penalty', text: `${who}: ${proof.cost} (${proof.label}). Photo proof needed`, ...linkTo(proof.instanceId) },
        { ...state, proofs: [...state.proofs, proof] },
      )
    }
    case 'proof_due': {
      const id = str(p.proof_id)
      const effectId = str(p.effect_id)
      if (!id || !effectId) return state
      const team = p.team === 'hiders' ? 'hiders' : 'seekers'
      const instanceId = state.effects.find((x) => x.id === effectId)?.instanceId ?? null
      const kind = p.kind === 'setup' ? 'setup' : 'evidence'
      const proof: DrinkProof = {
        id,
        seq: e.seq,
        team,
        kind,
        cost: 'drink',
        label: str(p.label) ?? 'Curse',
        path: null,
        effectId,
        instanceId,
        resolution: null,
        optional: p.optional === true,
        doneAt: null,
        by: null,
      }
      return { ...state, proofs: [...state.proofs, proof] }
    }
    case 'drink_proved': {
      const id = str(p.proof_id)
      const path = str(p.path)
      const proof = state.proofs.find((x) => x.id === id)
      if (!id || !path) return state
      const doneAt = time(undefined, e.created_at)
      const next = { ...state, proofs: state.proofs.map((x) => (x.id === id ? { ...x, path, doneAt, by: str(p.by) } : x)) }
      const who = p.team === 'hiders' ? 'Hiders' : 'Seekers'
      const text =
        proof?.kind === 'evidence' || proof?.kind === 'setup' ? `${who} sent proof: ${proof.label}` : `${who} drank: ${proof?.label ?? 'drink'}`
      return log({ kind: 'proof', text, photo: path, photoBucket: DRINK_BUCKET, ...linkTo(proof?.instanceId) }, next)
    }
    case 'effect_clear_requested': {
      const id = str(p.effect_id)
      const next = updateEffect(state, id, (x) => ({ ...x, status: 'clear_requested' }))
      const name = next.effects.find((x) => x.id === id)?.card.name ?? 'Curse'
      return log({ kind: 'card', text: `Seekers say ${name} is done`, ...effectLink(next, id) }, next)
    }
    case 'effect_clear_rejected': {
      const id = str(p.effect_id)
      // The server reopens the seekers' photo proof (never the hiders' setup): the next try needs a new photo.
      const next = updateEffect(
        {
          ...state,
          proofs: state.proofs.map((x) =>
            x.kind === 'evidence' && x.effectId !== null && x.effectId === id && !x.resolution ? { ...x, path: null, doneAt: null } : x,
          ),
        },
        id,
        (x) => ({ ...x, status: 'active' }),
      )
      const card = next.effects.find((x) => x.id === id)?.card
      const name = card?.name ?? 'Curse'
      const judge = card ? judgeOf(card) : null
      const text = judge?.question ? `${name}: hider picked ${judge.reject}. Seekers try again` : `Hider says ${name} is not done yet`
      return log({ kind: 'penalty', text, ...effectLink(next, id) }, next)
    }
    case 'curse_checked': {
      const id = str(p.effect_id)
      const applies = p.applies === true
      const next = updateEffect(state, id, (x) => ({
        ...x,
        status: applies ? 'active' : 'cleared',
        endsAt: x.behaviour === 'timed' && applies ? time(p.ends_at, e.created_at) : x.endsAt,
      }))
      const name = effectName(next, id)
      return log(
        {
          kind: 'card',
          text: applies
            ? `Seekers confirmed ${name}: it starts now`
            : p.not_applicable === true
              ? `Seekers say ${name} doesn't apply: cancelled`
              : `Seekers say ${name} doesn't apply: dropped`,
          ...effectLink(next, id),
        },
        next,
      )
    }
    case 'effect_cleared': {
      const id = str(p.effect_id)
      const next = updateEffect(state, id, (x) => ({ ...x, status: 'cleared' }))
      const name = next.effects.find((x) => x.id === id)?.card.name ?? 'Curse'
      return log({ kind: 'card', text: p.self_cleared === true ? `Seekers did ${name}` : `${name} cleared`, ...effectLink(next, id) }, next)
    }
    case 'trivia_set': {
      const id = str(p.effect_id)
      const questions = strings(p.questions).map((question): TriviaQuestion => ({ question, answer: null, answeredBy: null, correct: false, wrong: [] }))
      const next = updateTrivia(state, id, (t) => ({ ...t, questions }))
      return log({ kind: 'card', text: `${effectName(next, id)}: hider sent ${questions.length} questions`, ...effectLink(next, id) }, next)
    }
    case 'trivia_answered': {
      // One answer per question, null for questions already right.
      const id = str(p.effect_id)
      const answers = Array.isArray(p.answers) ? p.answers.map(str) : []
      const by = str(p.by)
      const next = updateTrivia(state, id, (t) => ({
        ...t,
        questions: t.questions?.map((q, i) => (answers[i] && !q.correct ? { ...q, answer: answers[i], answeredBy: by } : q)) ?? null,
      }))
      const sent = answers.map((x, i) => (x ? `Q${i + 1} "${x}"` : null)).filter(Boolean)
      return log({ kind: 'card', text: `${effectName(next, id)}: seekers answered ${sent.join(', ')}`, ...effectLink(next, id) }, next)
    }
    case 'trivia_marked': {
      // One mark per question ({correct, answer}), null for questions already right.
      const id = str(p.effect_id)
      const marks = (Array.isArray(p.marks) ? p.marks : []).map((m) =>
        isObject(m) && typeof m.correct === 'boolean' ? { correct: m.correct, answer: str(m.answer) ?? '' } : null,
      )
      const next = updateTrivia(state, id, (t) => ({
        ...t,
        questions:
          t.questions?.map((q, i) => {
            const m = marks[i]
            if (!m || q.correct) return q
            return m.correct
              ? { ...q, answer: q.answer ?? m.answer, correct: true }
              : { ...q, answer: null, answeredBy: null, wrong: [...q.wrong, m.answer] }
          }) ?? null,
      }))
      const right = marks.flatMap((m, i) => (m?.correct ? [`Q${i + 1}`] : []))
      const reset = p.reset === true
      const t = next.effects.find((x) => x.id === id)?.trivia
      const enough = !!t?.questions && t.questions.filter((q) => q.correct).length >= t.need
      const wrong = marks.flatMap((m, i) => (m && !m.correct ? [`Q${i + 1} "${m.answer}"`] : []))
      const parts = [
        right.length ? `${right.join(', ')} right` : null,
        wrong.length ? `${wrong.join(', ')} wrong${reset || enough ? '' : ', try again'}` : null,
        reset ? 'not enough right: the hider sends new questions' : null,
      ]
      if (reset) {
        const cleared = updateTrivia(next, id, (t) => ({
          ...t,
          questions: null,
          lastFailed: { right: t.questions?.filter((q) => q.correct).length ?? 0, total: t.questions?.length ?? t.count },
        }))
        return log({ kind: 'penalty', text: `${effectName(next, id)}: ${parts.filter(Boolean).join('; ')}`, ...effectLink(next, id) }, cleared)
      }
      return log(
        { kind: wrong.length ? 'penalty' : 'card', text: `${effectName(next, id)}: ${parts.filter(Boolean).join('; ')}`, ...effectLink(next, id) },
        next,
      )
    }
    case 'trivia_force_cleared': {
      const id = str(p.effect_id)
      const next = updateTrivia(state, id, (t) => ({
        ...t,
        forced: true,
        questions: t.questions?.map((q) => ({ ...q, correct: true })) ?? null,
      }))
      return log({ kind: 'card', text: `Host marked ${effectName(next, id)} all correct`, ...effectLink(next, id) }, next)
    }
    case 'effect_followup_started': {
      const id = str(p.effect_id)
      const endsAt = time(p.ends_at, e.created_at)
      const next = updateEffect(state, id, (x) => ({ ...x, followupEndsAt: endsAt }))
      const effect = next.effects.find((x) => x.id === id)
      const len = effect?.followupS ? ` (${minutes(effect.followupS)})` : ''
      return log({ kind: 'penalty', text: `${effect?.card.name ?? 'Curse'}: missed, follow-on timer started${len}`, ...effectLink(next, id) }, next)
    }
    // ---------------------------------------------------------------- host overrides
    case 'drink_resolved': {
      const id = str(p.proof_id)
      const resolution: 'cancelled' | 'waived' = p.resolution === 'cancelled' ? 'cancelled' : 'waived'
      const proof = state.proofs.find((x) => x.id === id)
      const doneAt = time(undefined, e.created_at)
      const next = { ...state, proofs: state.proofs.map((x) => (x.id === id ? { ...x, resolution, doneAt } : x)) }
      if (!proof || proof.kind !== 'drink') return next
      const who = proof.team === 'hiders' ? 'Hiders' : 'Seekers'
      return log({ kind: 'override', text: `${who}: ${proof.label} ${resolution === 'cancelled' ? 'cancelled' : 'done, no photo needed'}` }, next)
    }
    case 'card_given': {
      const card = parseCard(p.card)
      const instanceId = str(p.instance_id)
      if (!card || !instanceId) return state
      return {
        ...state,
        deck: state.deck[card.id] ? state.deck : { ...state.deck, [card.id]: card },
        hand: [...state.hand, { instanceId, cardId: card.id }],
      }
    }
    case 'hand_discarded': {
      // Move discards the whole hand (hider-only).
      const ids = new Set(
        (Array.isArray(p.cards) ? p.cards : []).flatMap((c) => (isObject(c) && str(c.instance_id) ? [str(c.instance_id)!] : [])),
      )
      if (!ids.size) return state
      return log(
        { kind: 'card', text: `Discarded your hand (${ids.size} card${ids.size > 1 ? 's' : ''})`, private: true },
        { ...state, hand: state.hand.filter((c) => !ids.has(c.instanceId)) },
      )
    }
    case 'card_removed': {
      const id = str(p.instance_id)
      return { ...state, hand: state.hand.filter((c) => c.instanceId !== id) }
    }
    case 'deck_reshuffled':
      return { ...state, pileLeft: num(p.pile_left) ?? state.pileLeft }
    case 'hand_limit_changed':
      return { ...state, handLimit: num(p.hand_limit) ?? state.handLimit }
    case 'effect_changed':
      return updateEffect(state, str(p.effect_id), (x) =>
        typeof p.blocks_questions === 'boolean' ? { ...x, blocksQuestions: p.blocks_questions } : x,
      )
    case 'effect_reinstated': {
      const next = updateEffect(state, str(p.effect_id), (x) => ({
        ...x,
        status: 'active',
        endsAt: x.behaviour === 'timed' ? time(p.ends_at, e.created_at) : x.endsAt,
        durationS: num(p.duration_s) ?? x.durationS,
        followupEndsAt: null,
        pausedLeftMs: null,
      }))
      return log({ kind: 'override', text: `${effectName(next, str(p.effect_id))} is back in force` }, next)
    }
    case 'veto_cancelled': {
      const instanceId = str(p.instance_id)
      if (!instanceId) return state
      const bans = (Array.isArray(p.bans) ? p.bans : []).flatMap((b): Ban[] =>
        isObject(b) && str(b.type) && str(b.option_id)
          ? [{ type: str(b.type)!, optionId: str(b.option_id)!, label: str(b.label) ?? str(b.option_id)!, instanceId }]
          : [],
      )
      return updateEffect(
        { ...state, vetoes: state.vetoes.filter((v) => v.instanceId !== instanceId), bans: [...state.bans, ...bans] },
        str(p.effect_id),
        (x) => ({ ...x, status: 'active' }),
      )
    }
    case 'ban_lifted':
      return { ...state, bans: state.bans.filter((b) => !(b.type === p.type && b.optionId === p.option_id)) }
    case 'move_cancelled':
      return log({ kind: 'override', text: 'Move cancelled: the hider stays at their bar' }, { ...state, moving: false })
    case 'timer_changed': {
      const ends = str(p.ends_at)
      const left = num(p.paused_left_s)
      const endsAt = ends ? time(ends, e.created_at) : Number.POSITIVE_INFINITY
      const pausedLeftMs = ends === null && left !== null ? left * 1000 : null
      const id = str(p.id)
      if (p.timer === 'effect') return updateEffect(state, id, (x) => ({ ...x, endsAt, pausedLeftMs }))
      if (p.timer === 'followup') return updateEffect(state, id, (x) => ({ ...x, followupEndsAt: endsAt, pausedLeftMs }))
      if (p.timer === 'veto_lock') {
        return { ...state, vetoes: state.vetoes.map((v) => (v.instanceId === id ? { ...v, lockEndsAt: endsAt, pausedLeftMs } : v)) }
      }
      return state
    }
    default:
      return state
  }
}

/** Log fields tying an entry to the played card it belongs to (shown on its timeline card). */
const linkTo = (instanceId: string | null | undefined) => (instanceId ? { instanceId } : {})
const effectLink = (s: CardsState, effectId: string | null) => linkTo(s.effects.find((x) => x.id === effectId)?.instanceId)

const updateTrivia = (s: CardsState, id: string | null, f: (t: Trivia) => Trivia): CardsState =>
  updateEffect(s, id, (x) => (x.trivia ? { ...x, trivia: f(x.trivia) } : x))

const effectName = (s: CardsState, id: string | null) => s.effects.find((x) => x.id === id)?.card.name ?? 'Trivia'

/** How many questions a trivia card needs (params.count, default 3), as the server reads it. */
export function triviaCount(c: CardDef): number {
  const n = num(c.params.count)
  return n !== null && n >= 1 && n <= 10 ? Math.floor(n) : 3
}
/** How many trivia answers must be right (params.need_right, 1..count; default all). */
export function triviaNeed(c: CardDef): number {
  const n = num(c.params.need_right)
  const count = triviaCount(c)
  return n !== null && n >= 1 && n <= count ? Math.floor(n) : count
}
export const triviaTopic = (c: CardDef): string | null => {
  const t = str(c.params.topic)?.trim()
  return t ? t : null
}

/** What a team has to do for a trivia curse now: write, mark or answer. null: nothing. */
export function triviaTodo(e: Effect, team: 'hiders' | 'seekers'): 'write' | 'mark' | 'answer' | null {
  const t = e.trivia
  if (!t || e.status !== 'active') return null
  if (team === 'hiders') {
    if (!t.questions) return 'write'
    return triviaStage(t) === 'marking' ? 'mark' : null
  }
  return triviaStage(t) === 'answering' ? 'answer' : null
}

/**
 * Answers go in as a set and are marked as a set: 'answering' while the seekers owe answers
 * to the questions not yet right, 'marking' while those answers wait for the hider.
 */
export function triviaStage(t: Trivia): 'writing' | 'answering' | 'marking' | 'done' {
  if (!t.questions) return 'writing'
  const open = t.questions.filter((q) => !q.correct)
  if (!open.length) return 'done'
  return open.some((q) => q.answer === null) ? 'answering' : 'marking'
}

/** Trivia curses waiting on this team. */
export const triviaWaiting = (s: CardsState, team: 'hiders' | 'seekers') => s.effects.filter((e) => triviaTodo(e, team) !== null)

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
  /** seeker_confirm: waiting for the seekers to say whether it applies. */
  | 'awaiting_seekers'
  | 'over'

/** Where an effect is at this (server) time. */
export function effectPhase(e: Effect, now: number): EffectPhase {
  if (e.status === 'vetoed') return 'over'
  if (e.status === 'awaiting_seekers') return 'awaiting_seekers'
  if (e.behaviour === 'trivia') return e.status === 'cleared' ? 'over' : 'until_cleared'
  if (e.behaviour === 'until_cleared') {
    return e.status === 'cleared' ? 'over' : e.status === 'clear_requested' ? 'awaiting_confirm' : 'until_cleared'
  }
  if (e.status === 'cleared') return 'over'
  if (e.status === 'clear_requested') return 'awaiting_confirm'
  if (e.endsAt !== null && now < e.endsAt) return 'running'
  if (e.followupEndsAt !== null) return now < e.followupEndsAt ? 'followup' : 'over'
  // A follow-on can be started for a while after the countdown; after that it drops off.
  if (e.followupS && e.endsAt !== null && now < e.endsAt + FOLLOWUP_WINDOW_MS) return 'followup_available'
  return 'over'
}

/**
 * Seekers can say they've done it (the hider confirms): until_cleared curses, and timed
 * ones with a follow-on (a task with a deadline, e.g. Escape) until the follow-on starts.
 */
export function clearable(e: Effect, now: number): boolean {
  if (e.status !== 'active' || e.behaviour === 'trivia') return false
  // A mine has nothing to clear until it goes off.
  if (isMine(e.card) && !e.mineTriggered) return false
  const phase = effectPhase(e, now)
  if (e.behaviour === 'until_cleared') return phase === 'until_cleared'
  return e.followupS !== null && e.followupEndsAt === null && (phase === 'running' || phase === 'followup_available')
}

/** How long after a timed card ends its "missed it?" button stays up. */
export const FOLLOWUP_WINDOW_MS = 10 * 60_000

/** Effects still affecting play (anything not over), oldest first. */
export const liveEffects = (s: CardsState, now: number) => s.effects.filter((e) => effectPhase(e, now) !== 'over')

/** A blocking until_cleared curse is in force: seekers can't ask (the server refuses too). */
export const questionsBlockedBy = (s: CardsState): Effect[] =>
  s.effects.filter((e) => e.blocksQuestions && (e.status === 'active' || e.status === 'clear_requested'))

/**
 * Curses in force that block something else on the honour system (params.blocks, e.g.
 * 'transport' for Clash, Sculling, Moll), grouped by what they block, oldest first.
 */
export function otherBlocks(s: CardsState): [string, Effect[]][] {
  const out = new Map<string, Effect[]>()
  for (const e of s.effects) {
    const what = typeof e.card.params.blocks === 'string' ? e.card.params.blocks.trim() : ''
    if (!what || (e.status !== 'active' && e.status !== 'clear_requested')) continue
    out.set(what, [...(out.get(what) ?? []), e])
  }
  return [...out]
}

/** The countdown an effect shows now: [ends at, total seconds], or null. */
export function effectTimer(e: Effect, now: number): [number, number] | null {
  const phase = effectPhase(e, now)
  const shown = (end: number) => (e.pausedLeftMs !== null ? now + e.pausedLeftMs : end)
  if (phase === 'running' && e.endsAt !== null) return [shown(e.endsAt), e.durationS ?? 0]
  if (phase === 'followup' && e.followupEndsAt !== null) return [shown(e.followupEndsAt), e.followupS ?? 0]
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
export const PLAYABLE = ['text', 'timed', 'until_cleared', 'trivia', 'next_question_modifier', 'question_ban', 'powerup'] as const
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
      return p.as_veto === true ? 'Hider randomized the thermometer: counts as a veto (no reward)' : 'Hider randomized the question'
    case 'move':
      return num(card.params.duration_s) ? 'Hider played Move' : 'Hider is moving to a new bar. Questions wait until they lock it in'
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
  /** Minefield: the one question to mine. */
  | { kind: 'mine' }
  /** Time Bank: any number of time bonuses from the hand. */
  | { kind: 'bonuses' }

export function castChoice(c: CardDef): CastChoice {
  if (isMine(c)) return { kind: 'mine' }
  if (bankParams(c)) return { kind: 'bonuses' }
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
  ctx: { pendingQuestion: boolean; barChosen: boolean; moving: boolean; handSize: number; seeking?: boolean; frozen?: boolean },
): string | null {
  const a = powerupAction(c)
  if ((a === 'veto' || a === 'randomize') && !ctx.pendingQuestion) return 'Play this while a question is waiting for you.'
  if (a === 'move') {
    if (!ctx.barChosen) return 'Lock in a bar first.'
    if (ctx.moving) return 'You are already moving.'
    if (ctx.pendingQuestion) return 'Answer the waiting question first.'
    // A Move with a period (params.duration_s): seeking only, never in the endgame.
    if (num(c.params.duration_s)) {
      if (ctx.seeking === false) return 'Play this once seeking has started.'
      if (ctx.frozen) return "Can't move in the endgame: a seeker is inside your bar's zone."
    }
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
  const end = Math.max(0, ...s.vetoes.map((v) => (v.pausedLeftMs !== null ? now + v.pausedLeftMs : v.lockEndsAt)))
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

/** Open drink proofs a team still owes (curse evidence is sent from the curse itself). */
export const openProofs = (s: CardsState, team: 'hiders' | 'seekers') =>
  s.proofs.filter((p) => p.kind === 'drink' && p.team === team && !p.path && !p.resolution)

/** The hiders' first-step proof for a curse (params.hider_proof), or null. */
export const setupFor = (s: CardsState, effectId: string): DrinkProof | null =>
  s.proofs.find((p) => p.kind === 'setup' && p.effectId === effectId) ?? null

/** A proof is done once the photo is in or the host closed it. */
export const proofDone = (p: DrinkProof) => !!p.path || !!p.resolution

/** The photo proof a curse's effect needs before the seekers can say they did it, or null. */
export const evidenceFor = (s: CardsState, effectId: string): DrinkProof | null =>
  s.proofs.find((p) => p.kind === 'evidence' && p.effectId === effectId) ?? null

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
  if (c.behaviour === 'until_cleared' && !isMine(c)) out.push(c.params.blocks_questions === true ? 'Blocks questions' : 'Until done')
  if (c.behaviour === 'trivia') {
    const n = triviaCount(c)
    const need = triviaNeed(c)
    out.push(`${n} trivia question${n > 1 ? 's' : ''}${triviaTopic(c) ? ` (${triviaTopic(c)})` : ''}${need < n ? `, ${need} right needed` : ''}`)
    if (c.params.blocks_questions === true) out.push('Blocks questions')
  }
  if (c.behaviour === 'time_bonus' && num(c.params.minutes)) out.push(`+${num(c.params.minutes)} min`)
  if (isMine(c)) out.push('Mines a question')
  const count = hiderCount(c)
  if (count) out.push(count.timeS ? `Hiders drink ${minutes(count.timeS)}, then count` : 'Hiders send a count')
  const bank = bankParams(c)
  if (bank) out.push(`1 ${bank.unit} per ${bank.minutesPer} min banked`)
  if (c.params.drink_per_question === 'drink' || c.params.drink_per_question === 'shot') out.push(`A ${c.params.drink_per_question} per question`)
  const plague = num(c.params.plague_radius_m)
  if (plague) out.push(`No questions within ${plague} m of the last`)
  const zone = num(c.params.zone_radius_multiplier)
  if (zone) out.push(`Hiding zone ×${zone}`)
  if (selfClear(c)) out.push('Seekers say when done')
  if (c.behaviour === 'next_question_modifier') out.push(`Next reward ×${num(c.params.reward_multiplier) ?? 2}`)
  if (c.behaviour === 'question_ban') {
    const n = num(c.params.count) ?? 1
    out.push(`Bans ${n} question${n > 1 ? 's' : ''}${c.params.until === 'end_of_run' ? ' for the run' : ''}`)
  }
  if (powerupAction(c) === 'discard_draw') out.push(`Discard ${num(c.params.discard) ?? 0}, draw ${num(c.params.draw) ?? 0}`)
  const u = cardUtility(c)
  if (u?.kind === 'dice') out.push(`Roll ${u.dice} ${u.dice > 1 ? 'dice' : 'die'}`)
  if (u?.kind === 'wheel') out.push('Spin the wheel')
  const proof = proofKind(c)
  if (proof) out.push(`${proof === 'photo' ? 'Photo' : 'Video'} proof`)
  if (c.canVeto === false && c.category === 'curse') out.push("Can't veto")
  return out
}

export const COST_LABEL: Record<string, string> = { free: 'Free', drink: 'Drink', shot: 'Shot' }

/** Cast cost: the printed one, or params.cost (e.g. the shot for Double Rewards). null: free. */
export function castCost(c: CardDef): 'drink' | 'shot' | null {
  const cost = c.castCost ?? (typeof c.params.cost === 'string' ? c.params.cost : null)
  return cost === 'drink' || cost === 'shot' ? cost : null
}

/**
 * Who drinks a card's cast cost (and owes the photo proof), as play_card decides: the
 * card's params.cost_team, else the hiders, who pay to cast any card, curses included.
 */
export function costPayer(c: CardDef): 'hiders' | 'seekers' {
  const t = c.params.cost_team
  if (t === 'hiders' || t === 'seekers') return t
  return 'hiders'
}

/** params.proof: 'photo' or 'video', both collected by the app. */
export function proofKind(c: CardDef): 'photo' | 'video' | null {
  return c.params.proof === 'photo' || c.params.proof === 'video' ? c.params.proof : null
}

/**
 * What the hiders attach before they cast a card, sent with play_card (p_choice.media):
 * the photo of the drink they pay to cast it (when drink proofs are on), and their first
 * step (params.hider_proof, e.g. Sculling's chug video). A curse that first asks the seekers
 * whether it applies (params.seeker_confirm) opens its first step later, so not here.
 */
export function castMedia(c: CardDef, drinkProofs: boolean): { cost: boolean; setup: 'photo' | 'video' | null } {
  const confirmFirst =
    ['timed', 'until_cleared', 'trivia'].includes(c.behaviour) &&
    typeof c.params.seeker_confirm === 'string' &&
    c.params.seeker_confirm.trim() !== '' &&
    c.params.seeker_confirm !== 'false'
  return {
    cost: drinkProofs && !!castCost(c) && costPayer(c) === 'hiders',
    setup: confirmFirst || hiderProofOptional(c) ? null : hiderProofKind(c),
  }
}

/** params.hider_proof_optional: the first step is optional, sent with the count instead of at cast. */
export const hiderProofOptional = (c: CardDef) => c.params.hider_proof_optional === true

/** params.hider_proof: what the hiders send first when they cast it ('photo' or 'video'). */
export function hiderProofKind(c: CardDef): 'photo' | 'video' | null {
  return c.params.hider_proof === 'photo' || c.params.hider_proof === 'video' ? c.params.hider_proof : null
}

const textParam = (c: CardDef, key: string): string | null => {
  const v = c.params[key]
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** What the hiders send first (params.hider_proof_prompt), e.g. "Film your team chugging". */
export const hiderProofPrompt = (c: CardDef) => textParam(c, 'hider_proof_prompt')

/** params.not_applicable: the curse starts at once and the seekers may cancel it (e.g. Escape: only in a bar). */
export const notApplicable = (c: CardDef) => textParam(c, 'not_applicable')

/** Seekers can still say a running curse doesn't apply (before any lock starts). */
export const canSayNotApplicable = (e: Effect, now: number) =>
  !!notApplicable(e.card) && e.status === 'active' && e.followupEndsAt === null && effectPhase(e, now) !== 'over'

/** What the seekers send to clear it (params.proof_prompt). */
export const proofPrompt = (c: CardDef) => textParam(c, 'proof_prompt')

/**
 * How the hider judges the seekers' try (params.judge_question, judge_accept, judge_reject),
 * e.g. Sculling: "Who drank quicker?" Seekers (clears it) or Hiders (they go again).
 * Defaults to Confirm / Not yet.
 */
export function judgeOf(c: CardDef): { question: string | null; accept: string; reject: string } {
  return {
    question: textParam(c, 'judge_question'),
    accept: textParam(c, 'judge_accept') ?? 'Confirm',
    reject: textParam(c, 'judge_reject') ?? 'Not yet',
  }
}

const BEHAVIOUR_LABEL: Record<string, string> = {
  text: 'Shown to everyone',
  timed: 'Timed',
  until_cleared: 'Until the seekers do it',
  trivia: 'Trivia: the hider asks, the seekers answer',
  time_bonus: 'Time bonus',
  next_question_modifier: 'Changes the next reward',
  question_ban: 'Bans questions',
  powerup: 'Powerup',
}

const teamName = (t: 'hiders' | 'seekers') => (t === 'hiders' ? 'hiders' : 'seekers')
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1)

/** Everything the card info sheet shows besides the name and text: label/value rows. */
export function cardDetails(c: CardDef): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = []
  rows.push({ label: 'Type', value: `${c.categoryName || 'Card'} · ${BEHAVIOUR_LABEL[c.behaviour] ?? c.behaviour}` })
  const cost = castCost(c)
  rows.push({
    label: 'Cast cost',
    value: cost ? `${COST_LABEL[cost]}, paid by the ${teamName(costPayer(c))}` : 'Free',
  })
  if (c.canVeto !== null || c.category === 'curse') {
    rows.push({
      label: 'Veto',
      value: c.canVeto === true ? 'Seekers can veto it (bar lock and a drink)' : "Can't be vetoed",
    })
  }
  const drinks = strings(c.params.drinks).filter((t): t is 'hiders' | 'seekers' => t === 'hiders' || t === 'seekers')
  if (drinks.length) rows.push({ label: 'Drinks', value: `${cap(drinks.map(teamName).join(' and '))} drink when it's played` })
  const proof = proofKind(c)
  if (proof === 'photo') {
    rows.push({
      label: 'Proof',
      value:
        c.behaviour === 'until_cleared' || (c.behaviour === 'timed' && num(c.params.followup_s))
          ? 'Photo: the seekers send one before they can say they did it'
          : drinks.length
            ? 'Photo of each drink'
            : 'Photo',
    })
  } else if (proof === 'video') {
    rows.push({ label: 'Proof', value: 'Video: the seekers send one before they can say they did it' })
  }
  const first = hiderProofKind(c)
  if (first) {
    rows.push({
      label: 'Hiders first',
      value: hiderProofOptional(c) ? `The hiders can send a ${first} with their count` : `The hiders send a ${first} when they cast it`,
    })
  }
  const count = hiderCount(c)
  if (count) {
    rows.push({
      label: 'Count',
      value:
        count.reward === 'extra_draw'
          ? `The hiders say how many; that many extra cards on the next reward`
          : `The hiders say how many; the seekers drink 1 ${count.unit} per ${count.per > 1 ? count.per : ''}${count.per > 1 ? ' ' : ''}counted (rounded down)`,
    })
  }
  if (isMine(c)) rows.push({ label: 'Mine', value: 'The hiders pick a question in secret. Asking it vetoes it and every seeker drinks' })
  const facts = cardFacts(c).filter((f) => !/ proof$/.test(f) && f !== "Can't veto")
  if (facts.length) rows.push({ label: 'Rules', value: facts.join(' · ') })
  if ((c.behaviour === 'until_cleared' || c.behaviour === 'trivia') && typeof c.params.blocks === 'string') rows.push({ label: 'Blocks', value: cap(c.params.blocks) })
  return rows
}

/** Teams a played card makes drink (params.drinks), e.g. Drinks All Round: both. */
export function drinkTeams(p: PlayedCard): ('hiders' | 'seekers')[] {
  const d = p.card.params.drinks
  return Array.isArray(d) ? d.filter((t): t is 'hiders' | 'seekers' => t === 'hiders' || t === 'seekers') : []
}

/**
 * Keep button when the hand is full: what is kept and what goes, by name. Discarding the
 * new card itself reads "Discard X, keep your hand", never "keep new card, discard X".
 */
export function keepDiscardLabel(keptNew: readonly string[], discardedNew: readonly string[], discardedHand: readonly string[]): string {
  const list = (n: readonly string[]) => n.join(', ')
  if (!discardedHand.length) return `Discard ${list(discardedNew)}, keep your hand`
  const gone = list([...discardedNew, ...discardedHand])
  if (!keptNew.length) return `Discard ${gone}`
  return `Keep ${list(keptNew)}, discard ${gone}`
}

/** Toast text for a proof that just came in or was closed by the host. */
export function proofToastText(p: DrinkProof, team: 'hiders' | 'seekers' | null, nameOf: (id: string | null) => string): { title: string; body: string } {
  const who = p.team === team ? 'Your team' : p.team === 'hiders' ? 'The hiders' : 'The seekers'
  if (p.resolution) {
    return {
      title: p.resolution === 'cancelled' ? `${p.label}: cancelled` : `${p.label}: done`,
      body: p.resolution === 'cancelled' ? `${who} don't owe it (host fix).` : `${who} did it, no photo needed (host fix).`,
    }
  }
  const by = p.by ? nameOf(p.by) : who
  if (p.kind === 'setup') return { title: `${p.label}: the hiders sent theirs`, body: `Sent by ${by}. It's in the curse and the log.` }
  if (p.kind === 'evidence') return { title: `${p.label}: proof sent`, body: `Sent by ${by}.` }
  return { title: `${who === 'Your team' ? 'Your team' : who} drank: ${p.label}`, body: `${p.cost === 'shot' ? 'Shot' : 'Drink'} done, photo by ${by}.` }
}


// ---------------------------------------------------------------- custom curse params

/** params.mine (Minefield): the hiders mine one question when they cast it. */
export const isMine = (c: CardDef) => c.params.mine === true

const mineLabel = (p: Record<string, unknown>) => str(p.label) ?? str(p.option_id) ?? 'a question'

/** params.hider_count: the number the hiders send after casting (Brothel, Equivalent Exchange, Beer Bonus). */
export interface HiderCount {
  prompt: string
  /** Every `per` counted is one of `unit` (Brothel: 2 people = 1 shot). */
  per: number
  unit: string
  /** Seconds of drinking before the count (shown as a countdown), or null. */
  timeS: number | null
  /** 'extra_draw': the amount is extra cards on the next reward, not drinks for the seekers. */
  reward: string | null
}

export function hiderCount(c: CardDef): HiderCount | null {
  const h = c.params.hider_count
  if (!isObject(h)) return null
  const per = num(h.per)
  const t = num(h.time_s)
  return {
    prompt: str(h.prompt)?.trim() || 'How many?',
    per: per && per >= 1 ? per : 1,
    unit: str(h.unit)?.trim() || 'drink',
    timeS: t && t > 0 ? t : null,
    reward: str(h.reward),
  }
}

/** params.bank_time_bonuses (Time Bank): discard time bonuses, the seekers drink per `minutesPer`. */
export function bankParams(c: CardDef): { minutesPer: number; unit: string } | null {
  const b = c.params.bank_time_bonuses
  if (!isObject(b)) return null
  const m = num(b.minutes_per)
  return { minutesPer: m && m >= 1 ? m : 4, unit: str(b.unit)?.trim() || 'drink' }
}

/** "3 shots", "1 standard drink". */
export const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`

/** Drinks Time Bank costs the seekers for these minutes (rounded down, as the server does). */
export const bankDrinks = (minutes: number, minutesPer: number) => Math.floor(minutes / minutesPer)

/** What a count means, for the log and the curse. */
export function countText(c: CardCount): string {
  const counted = c.count !== null ? `hiders counted ${c.count}, ` : ''
  if (c.reward === 'extra_draw') return `${counted}${plural(c.amount, 'extra card')} on the next reward`
  return c.amount > 0 ? `${counted}seekers drink ${plural(c.amount, c.unit)}` : `${counted}nothing to drink`
}

/** The count a played card is waiting for: needed and not sent yet. */
export const countPending = (s: CardsState, p: PlayedCard) => !!hiderCount(p.card) && !s.counts[p.instanceId]

/**
 * Cards whose count the hiders still owe, oldest first: played this round with
 * params.hider_count, no count yet, and not over (cleared or vetoed).
 */
export function countsOwed(s: CardsState): PlayedCard[] {
  return s.played.filter((p) => {
    if (!countPending(s, p) || s.vetoes.some((v) => v.instanceId === p.instanceId)) return false
    const e = p.effectId ? s.effects.find((x) => x.id === p.effectId) : null
    return !e || e.status === 'active' || e.status === 'clear_requested'
  })
}

/** How much the hiding zone has grown this round (Prosperous Home), 1 = not at all. */
export function zoneMultiplier(s: Pick<CardsState, 'played' | 'vetoes'>): number {
  return s.played.reduce((m, p) => {
    const z = num(p.card.params.zone_radius_multiplier)
    return z && z > 0 && z <= 10 && !s.vetoes.some((v) => v.instanceId === p.instanceId) ? m * z : m
  }, 1)
}

/** Plagued World spots in force now. */
export function activePlagueSpots(s: CardsState, now: number): PlagueSpot[] {
  return s.plagueSpots.filter((x) => {
    const e = s.effects.find((f) => f.id === x.effectId)
    return x.endsAt > now && (!e || e.status === 'active')
  })
}

/** A running curse that makes every question cost a drink (params.drink_per_question, Happy Hour). */
export function drinkPerQuestion(s: CardsState, now: number): Effect[] {
  return s.effects.filter(
    (e) =>
      (e.card.params.drink_per_question === 'drink' || e.card.params.drink_per_question === 'shot') &&
      e.status === 'active' &&
      e.endsAt !== null &&
      e.endsAt > now,
  )
}

/** params.self_clear (Rewind): the seekers' "Okay, done" clears it, no hider confirm. */
export const selfClear = (c: CardDef) => c.params.self_clear === true
