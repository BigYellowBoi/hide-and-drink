import { useState } from 'react'
import { cardOf, isPlayable, type CardRef, type CardsState, type PendingDraw } from '../cards/state'
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

/** Hider's Hand tab: pending draws first, then the selected card large with Cast, hand strip below. */
export function HandPanel({ sync, cards, canAct }: Props) {
  return (
    <>
      {cards.draws.map((d) => (
        <DrawChooser key={d.drawId} sync={sync} cards={cards} draw={d} canAct={canAct} />
      ))}
      <Hand sync={sync} cards={cards} canAct={canAct} />
    </>
  )
}

function Hand({ sync, cards, canAct }: Props) {
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const hand = cards.hand
  const current = hand.find((c) => c.instanceId === selected) ?? hand[0] ?? null
  const def = current ? cardOf(cards, current.cardId) : null

  const cast = async (c: CardRef) => {
    setBusy(true)
    setErr(null)
    try {
      await sync.action('play_card', { p_instance_id: c.instanceId })
      setSelected(null)
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
      {cards.timeBonusS > 0 && (
        <p className="ok small-note">Time bonus banked: +{Math.round(cards.timeBonusS / 60)} min</p>
      )}
      {!current || !def ? (
        <p className="muted">No cards yet. Answering questions draws cards.</p>
      ) : (
        <>
          <CardFace card={def} />
          {isPlayable(def) ? (
            <div className="hand-cast">
              <SlideToConfirm
                key={current.instanceId}
                label={busy ? 'Casting…' : def.castCost && def.castCost !== 'free' ? `Cast (costs a ${def.castCost})` : 'Cast'}
                disabled={!canAct || busy}
                onConfirm={() => void cast(current)}
              />
            </div>
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
                    onClick={() => setSelected(c.instanceId)}
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

/** "Keep 1 of 3": pick the cards to keep; if the hand would overflow, pick hand cards to discard. */
function DrawChooser({ sync, cards, draw, canAct }: Props & { draw: PendingDraw }) {
  const [keep, setKeep] = useState<string[]>([])
  const [discard, setDiscard] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const overflow = Math.max(0, cards.hand.length + draw.pick - cards.handLimit)
  const toggle = (list: string[], id: string, max: number) =>
    list.includes(id) ? list.filter((x) => x !== id) : max === 1 ? [id] : list.length < max ? [...list, id] : list
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
