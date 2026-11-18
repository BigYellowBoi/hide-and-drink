import { useEffect, useState } from 'react'
import {
  banKey,
  bannedSet,
  cardOf,
  castBlocker,
  castChoice,
  handBonusS,
  isPlayable,
  type CardDef,
  type CardRef,
  type CardsState,
  type PendingDraw,
} from '../cards/state'
import { supabase } from '../lib/supabase'
import { loadQuestionTypes, optionLabel, type QuestionType } from '../play/questionTypes'
import { isSupportedType, typeName } from '../play/state'
import { describeError } from '../lobby/messages'
import type { GameSync } from '../sync/engine'
import { LockIcon } from './BarPicker'
import { CardFace } from './CardFace'
import { SlideToConfirm } from './SlideToConfirm'

interface Props {
  sync: GameSync
  cards: CardsState
  canAct: boolean
}

/** Round context a powerup needs before it can be cast. */
export interface CastContext {
  city: string
  pendingQuestion: boolean
  barChosen: boolean
}

/** Hider's Hand tab: pending draws first, then the selected card large with Cast, hand strip below. */
export function HandPanel({ sync, cards, canAct, ctx }: Props & { ctx: CastContext }) {
  return (
    <>
      {cards.draws.map((d) => (
        <DrawChooser key={d.drawId} sync={sync} cards={cards} draw={d} canAct={canAct} />
      ))}
      <Hand sync={sync} cards={cards} canAct={canAct} ctx={ctx} />
    </>
  )
}

function Hand({ sync, cards, canAct, ctx }: Props & { ctx: CastContext }) {
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  /** Picks for cards that need them: hand cards (duplicate, discard) or questions (ban). */
  const [picks, setPicks] = useState<string[]>([])
  const hand = cards.hand
  const current = hand.find((c) => c.instanceId === selected) ?? hand[0] ?? null
  const def = current ? cardOf(cards, current.cardId) : null
  const choice = def ? castChoice(def) : { kind: 'none' as const }
  const blocker = def
    ? castBlocker(def, { pendingQuestion: ctx.pendingQuestion, barChosen: ctx.barChosen, moving: cards.moving, handSize: hand.length })
    : null
  const need = choice.kind === 'target' ? 1 : choice.kind === 'discard' || choice.kind === 'bans' ? choice.count : 0
  const ready = picks.length === need

  const select = (id: string) => {
    setSelected(id)
    setPicks([])
    setErr(null)
  }

  const cast = async (c: CardRef) => {
    setBusy(true)
    setErr(null)
    const p_choice =
      choice.kind === 'target'
        ? { target: picks[0] }
        : choice.kind === 'discard'
          ? { discard: picks }
          : choice.kind === 'bans'
            ? { bans: picks.map((k) => ({ type: k.split(':')[0], option_id: k.split(':').slice(1).join(':') })) }
            : null
    try {
      await sync.action('play_card', { p_instance_id: c.instanceId, ...(p_choice ? { p_choice } : {}) })
      setSelected(null)
      setPicks([])
    } catch (e) {
      setErr(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card">
      <p className="eyebrow">
        <LockIcon /> Only you see this
      </p>
      <h2>
        Hand{' '}
        <span className="muted small">
          {hand.length}/{cards.handLimit}
          {cards.pileLeft !== null ? ` · ${cards.pileLeft} left in the pile` : ` · ${cards.deckSize} in the deck`}
        </span>
      </h2>
      {handBonusS(cards) > 0 && (
        <p className="ok small-note">
          Time bonus in hand: +{Math.round(handBonusS(cards) / 60)} min. Counts if you still hold it when the round ends.
        </p>
      )}
      {cards.nextRewardMultiplier !== 1 && (
        <p className="ok small-note">Next answer's reward: ×{+cards.nextRewardMultiplier.toFixed(2)}.</p>
      )}
      {!current || !def ? (
        <p className="muted">No cards yet. Answering questions draws cards.</p>
      ) : (
        <>
          <CardFace card={def} />
          {isPlayable(def) ? (
            <>
              {choice.kind === 'target' || choice.kind === 'discard' ? (
                <HandPicker
                  cards={cards}
                  exclude={current.instanceId}
                  max={need}
                  picks={picks}
                  setPicks={setPicks}
                  title={choice.kind === 'target' ? 'Pick the card to copy' : `Pick ${need} card${need > 1 ? 's' : ''} to discard`}
                />
              ) : choice.kind === 'bans' ? (
                <BanPicker city={ctx.city} cards={cards} count={choice.count} distinctTypes={choice.distinctTypes} picks={picks} setPicks={setPicks} />
              ) : null}
              {blocker ? (
                <p className="muted small">{blocker}</p>
              ) : (
                <div className="hand-cast">
                  <SlideToConfirm
                    key={`${current.instanceId}:${ready}`}
                    label={
                      busy
                        ? 'Casting…'
                        : !ready
                          ? `Pick ${need - picks.length} more`
                          : castCost(def)
                            ? `Cast (costs a ${castCost(def)})`
                            : 'Cast'
                    }
                    disabled={!canAct || busy || !ready}
                    onConfirm={() => void cast(current)}
                  />
                </div>
              )}
            </>
          ) : def.behaviour === 'time_bonus' ? (
            <p className="muted small">Not played: it adds its time if it's still in your hand when the round ends.</p>
          ) : (
            <p className="muted small">This kind of card isn't in the app yet. Play it by hand for now.</p>
          )}
          {err && <p className="bad">{err}</p>}
          {hand.length > 1 && (
            <div className="hand-strip" role="list">
              {hand.map((c) => (
                <div role="listitem" key={c.instanceId}>
                  <CardFace
                    card={cardOf(cards, c.cardId)}
                    size="small"
                    selected={c.instanceId === current.instanceId}
                    onClick={() => select(c.instanceId)}
                  />
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  )
}

/** Cast cost: the printed one, or params.cost (e.g. the shot for Double Rewards). */
const castCost = (c: CardDef) => {
  const cost = c.castCost ?? (typeof c.params.cost === 'string' ? c.params.cost : null)
  return cost && cost !== 'free' ? cost : null
}

const toggle = (list: string[], id: string, max: number) =>
  list.includes(id) ? list.filter((x) => x !== id) : max === 1 ? [id] : list.length < max ? [...list, id] : list

function HandPicker({
  cards,
  exclude,
  max,
  picks,
  setPicks,
  title,
}: {
  cards: CardsState
  exclude: string
  max: number
  picks: string[]
  setPicks: (p: string[]) => void
  title: string
}) {
  return (
    <div className="cast-choice">
      <p className="small">{title}</p>
      <div className="draw-grid">
        {cards.hand
          .filter((c) => c.instanceId !== exclude)
          .map((c) => (
            <CardFace
              key={c.instanceId}
              card={cardOf(cards, c.cardId)}
              size="small"
              selected={picks.includes(c.instanceId)}
              onClick={() => setPicks(toggle(picks, c.instanceId, max))}
            />
          ))}
      </div>
    </div>
  )
}

/** Question ban: pick `count` questions (one per type when distinctTypes). */
function BanPicker({
  city,
  cards,
  count,
  distinctTypes,
  picks,
  setPicks,
}: {
  city: string
  cards: CardsState
  count: number
  distinctTypes: boolean
  picks: string[]
  setPicks: (p: string[]) => void
}) {
  const [types, setTypes] = useState<QuestionType[] | null>(null)
  useEffect(() => {
    if (!supabase) return
    loadQuestionTypes(supabase, city)
      .then(setTypes)
      .catch(() => setTypes([]))
  }, [city])
  const banned = bannedSet(cards)
  const pickedTypes = new Set(picks.map((k) => k.split(':')[0]))
  return (
    <div className="cast-choice">
      <p className="small">
        Pick {count} question{count > 1 ? 's' : ''}
        {distinctTypes ? ', each of a different type' : ''}. Seekers can't ask them for the rest of the run.
      </p>
      {!types && <p className="muted small">Loading questions…</p>}
      {types
        ?.filter((t) => isSupportedType(t.type))
        .map((t) => (
          <div key={t.type} className="ban-type">
            <strong className="small">{typeName(t.type)}</strong>
            <div className="chips">
              {t.options.map((o) => {
                const key = banKey(t.type, o.id)
                const on = picks.includes(key)
                const off = banned.has(key) || (!on && distinctTypes && pickedTypes.has(t.type))
                return (
                  <button
                    key={o.id}
                    className={`option-chip${on ? ' on' : ''}`}
                    aria-pressed={on}
                    disabled={off}
                    onClick={() => setPicks(toggle(picks, key, count))}
                  >
                    {optionLabel(o)}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
    </div>
  )
}

/** "Keep 1 of 3": pick the cards to keep; if the hand would overflow, pick hand cards to discard. */
function DrawChooser({ sync, cards, draw, canAct }: Props & { draw: PendingDraw }) {
  const [keep, setKeep] = useState<string[]>([])
  const [discard, setDiscard] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const overflow = Math.max(0, cards.hand.length + draw.pick - cards.handLimit)
  const ready = keep.length === draw.pick && discard.length === overflow

  const send = async () => {
    setBusy(true)
    setErr(null)
    try {
      await sync.action('keep_cards', { p_draw_id: draw.drawId, p_keep: keep, p_discard: discard })
    } catch (e) {
      setErr(describeError(e))
      setBusy(false)
    }
  }

  return (
    <section className="card draw-card" aria-live="polite">
      <p className="eyebrow">
        <LockIcon /> Only you see this
      </p>
      <h2>
        Keep {draw.pick} of {draw.cards.length}
      </h2>
      <div className="draw-grid">
        {draw.cards.map((c) => (
          <CardFace
            key={c.instanceId}
            card={cardOf(cards, c.cardId)}
            size="small"
            selected={keep.includes(c.instanceId)}
            onClick={() => setKeep((k) => toggle(k, c.instanceId, draw.pick))}
          />
        ))}
      </div>
      {overflow > 0 && (
        <>
          <p className="flag">
            Hand limit is {cards.handLimit}. Pick {overflow} card{overflow > 1 ? 's' : ''} from your hand to discard.
          </p>
          <div className="draw-grid">
            {cards.hand.map((c) => (
              <CardFace
                key={c.instanceId}
                card={cardOf(cards, c.cardId)}
                size="small"
                selected={discard.includes(c.instanceId)}
                onClick={() => setDiscard((d) => toggle(d, c.instanceId, overflow))}
              />
            ))}
          </div>
        </>
      )}
      <button className="wide" disabled={!ready || busy || !canAct} onClick={() => void send()}>
        {busy ? 'Keeping…' : ready ? `Keep ${draw.pick === 1 ? 'this card' : 'these cards'}` : `Pick ${draw.pick - keep.length} more`}
      </button>
      <p className="muted small">The rest go to the discard pile.</p>
      {err && <p className="bad">{err}</p>}
    </section>
  )
}
