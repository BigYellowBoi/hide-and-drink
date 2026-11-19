import { useEffect, useState } from 'react'
import {
  keepDiscardLabel,
  banKey,
  bannedSet,
  cardOf,
  castBlocker,
  castCost,
  castChoice,
  castMedia,
  hiderProofPrompt,
  costPayer,
  handBonusS,
  isPlayable,
  type CardRef,
  type CardsState,
  type PendingDraw,
} from '../cards/state'
import { supabase } from '../lib/supabase'
import { loadQuestionTypes, optionLabel, type QuestionType } from '../play/questionTypes'
import { isSupportedType, typeName } from '../play/state'
import { describeError } from '../lobby/messages'
import type { GameSync } from '../sync/engine'
import { PrivateLabel } from './PrivateLabel'
import { CardFace } from './CardFace'
import { SlideToConfirm } from './SlideToConfirm'
import { useMediaPick } from './useProofPhoto'

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
  /** Config photo_proof_for_drinks: the cast cost's drink needs a photo. */
  drinkProofs: boolean
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
  // Media sent with the card: the drink photo for its cost, and the curse's first step.
  const media = def && isPlayable(def) ? castMedia(def, ctx.drinkProofs) : { cost: false, setup: null }
  const folder = current?.instanceId ?? 'none'
  const costPick = useMediaPick(sync, folder, 'photo', !canAct || busy)
  const setupPick = useMediaPick(sync, folder, media.setup ?? 'photo', !canAct || busy)
  const mediaMissing = (media.cost && !costPick.photo) || (!!media.setup && !setupPick.photo)
  const mediaBusy = costPick.busy ?? setupPick.busy
  const ready = picks.length === need && !mediaMissing && !mediaBusy

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
      const sent: Record<string, string> = {}
      if (media.cost) sent.cost = await costPick.upload()
      if (media.setup) sent.setup = await setupPick.upload()
      const full = Object.keys(sent).length ? { ...(p_choice ?? {}), media: sent } : p_choice
      await sync.action('play_card', { p_instance_id: c.instanceId, ...(full ? { p_choice: full } : {}) })
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
      <PrivateLabel />
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
              {!blocker && media.setup && (
                <div className="cast-choice">
                  <p className="small">
                    <strong>Your {media.setup}, sent with the curse.</strong>{' '}
                    {hiderProofPrompt(def) ?? `The seekers see it when the curse lands.`}
                  </p>
                  {setupPick.box}
                  {setupPick.err && <p className="bad small">{setupPick.err}</p>}
                </div>
              )}
              {!blocker && media.cost && (
                <div className="cast-choice">
                  <p className="small">
                    <strong>Photo of your {castCost(def)}</strong>: the cost of casting it, sent with the card.
                  </p>
                  {costPick.box}
                  {costPick.err && <p className="bad small">{costPick.err}</p>}
                </div>
              )}
              {blocker ? (
                <p className="muted small">{blocker}</p>
              ) : (
                <div className="hand-cast">
                  <SlideToConfirm
                    key={`${current.instanceId}:${ready}`}
                    label={
                      busy
                        ? (mediaBusy ?? 'Casting…')
                        : mediaBusy
                          ? mediaBusy
                          : picks.length < need
                          ? `Pick ${need - picks.length} more`
                          : mediaMissing
                          ? `Add your ${media.setup && !setupPick.photo ? media.setup : 'photo'} first`
                          : castCost(def)
                            ? costPayer(def) === 'seekers'
                              ? `Cast (seekers drink a ${castCost(def)})`
                              : `Cast (costs you a ${castCost(def)})`
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
        </>
      )}
      {hand.length > 0 && (
        <HandGrid cards={cards} selected={current?.instanceId ?? null} onSelect={select} />
      )}
    </section>
  )
}

/** Columns for a hand of this size: one row up to 4, then two rows (6 cards: 3 × 2). */
const handColumns = (slots: number) => (slots <= 4 ? Math.max(1, slots) : Math.min(5, Math.ceil(slots / 2)))

/** The hand as a grid with one slot per card the hand can hold, so it all fits on screen. */
function HandGrid({ cards, selected, onSelect }: { cards: CardsState; selected: string | null; onSelect: (id: string) => void }) {
  const slots = Math.max(cards.handLimit, cards.hand.length)
  return (
    <div className="hand-grid" role="list" aria-label="Your hand" style={{ ['--cols' as string]: handColumns(slots) }}>
      {Array.from({ length: slots }, (_, i) => {
        const c = cards.hand[i]
        return (
          <div role="listitem" key={c?.instanceId ?? `empty-${i}`} className="hand-slot">
            {c ? (
              <CardFace card={cardOf(cards, c.cardId)} size="small" selected={c.instanceId === selected} onClick={() => onSelect(c.instanceId)} />
            ) : (
              <span className="hand-slot-empty">Empty</span>
            )}
          </div>
        )
      })}
    </div>
  )
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
  // To make room the hider can throw away a card from the hand or one just kept from this draw.
  const kept = draw.cards.filter((c) => keep.includes(c.instanceId))
  const setKept = (next: string[]) => {
    setKeep(next)
    setDiscard((d) => d.filter((id) => next.includes(id) || cards.hand.some((h) => h.instanceId === id)))
  }

  // Name what goes, so the button never reads as keeping the card just picked to discard.
  const nameOfCard = (c: { cardId: string }) => cardOf(cards, c.cardId).name
  const overflowLabel = keepDiscardLabel(
    kept.filter((c) => !discard.includes(c.instanceId)).map(nameOfCard),
    kept.filter((c) => discard.includes(c.instanceId)).map(nameOfCard),
    cards.hand.filter((c) => discard.includes(c.instanceId)).map(nameOfCard),
  )

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
      <PrivateLabel />
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
            onClick={() => setKept(toggle(keep, c.instanceId, draw.pick))}
          />
        ))}
      </div>
      {overflow > 0 && (
        <>
          <p className="flag">
            Hand limit is {cards.handLimit}. Pick {overflow} card{overflow > 1 ? 's' : ''} to discard: from your hand, or the new
            card{draw.pick > 1 ? 's' : ''} you keep.
          </p>
          <div className="draw-grid">
            {[...kept, ...cards.hand].map((c) => (
              <CardFace
                key={c.instanceId}
                card={cardOf(cards, c.cardId)}
                size="small"
                tag={discard.includes(c.instanceId) ? 'Discard' : kept.includes(c) ? 'New' : undefined}
                selected={discard.includes(c.instanceId)}
                onClick={() => setDiscard((d) => toggle(d, c.instanceId, overflow))}
              />
            ))}
          </div>
        </>
      )}
      <button className="wide" disabled={!ready || busy || !canAct} onClick={() => void send()}>
        {busy
          ? 'Keeping…'
          : ready
            ? overflow > 0
              ? overflowLabel
              : `Keep ${draw.pick === 1 ? 'this card' : 'these cards'}`
            : keep.length < draw.pick
              ? `Pick ${draw.pick - keep.length} more`
              : `Pick ${overflow - discard.length} to discard`}
      </button>
      <p className="muted small">The rest go to the discard pile.</p>
      {err && <p className="bad">{err}</p>}
    </section>
  )
}
