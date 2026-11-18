import { useEffect, useState, type ReactNode } from 'react'
import { InfoIcon } from './InfoIcon'
import { createPortal } from 'react-dom'
import { cardDetails, cardFacts, COST_LABEL, type CardDef } from '../cards/state'

interface Props {
  card: CardDef
  /** large: the selected card; small: hand grid, draw choices and pickers (no text: see the info sheet). */
  size?: 'large' | 'small'
  selected?: boolean
  onClick?: () => void
  /** Small tag on the card, e.g. "New" for a card just drawn. */
  tag?: string
  children?: ReactNode
}

/**
 * One template for every card (docs/design.md: content is data): category colour band on
 * top, cost badge, name, text, then facts from the card's params. Every card has an info
 * button that opens the full card.
 */
export function CardFace({ card, size = 'large', selected = false, onClick, tag, children }: Props) {
  const facts = cardFacts(card)
  const body = (
    <>
      <span className="pcard-band" style={{ background: card.colour }}>
        {/* Small cards with a cost badge: the band colour says the category. */}
        {(size === 'large' || !card.castCost) && <span className="pcard-cat">{card.categoryName}</span>}
        {card.castCost && <span className="pcard-cost">{COST_LABEL[card.castCost]}</span>}
      </span>
      <span className="pcard-body">
        <span className="pcard-name">{card.name}</span>
        {tag && <span className="pcard-tag">{tag}</span>}
        {size === 'large' && card.text && <span className="pcard-text">{card.text}</span>}
        {facts.length > 0 && <span className="pcard-facts">{facts.join(' · ')}</span>}
        {children}
      </span>
    </>
  )
  const cls = `pcard pcard-${size}${selected ? ' pcard-on' : ''}`
  return (
    <div className={`pcard-wrap pcard-wrap-${size}`}>
      {onClick ? (
        <button type="button" className={cls} aria-pressed={selected} onClick={onClick}>
          {body}
        </button>
      ) : (
        <div className={cls}>{body}</div>
      )}
      <CardInfoButton card={card} className="pcard-info" />
    </div>
  )
}

/** "i" button that opens the card info sheet. Also used in library and deck builder rows. */
export function CardInfoButton({ card, className = 'card-info-btn' }: { card: CardDef; className?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        className={className}
        aria-label={`About ${card.name}`}
        onClick={(e) => {
          e.stopPropagation()
          setOpen(true)
        }}
      >
        <InfoIcon />
      </button>
      {open && <CardInfoSheet card={card} onClose={() => setOpen(false)} />}
    </>
  )
}

/** Bottom sheet with the whole card: text, cast cost, veto status and what its params do. */
export function CardInfoSheet({ card, onClose }: { card: CardDef; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  // Portal: outside any inert screen, scroller or card button.
  return createPortal(
    <div className="info-backdrop" onClick={onClose}>
      <div
        className="info-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={card.name}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pcard pcard-large pcard-sheet">
          <span className="pcard-band" style={{ background: card.colour }}>
            <span className="pcard-cat">{card.categoryName}</span>
            {card.castCost && <span className="pcard-cost">{COST_LABEL[card.castCost]}</span>}
          </span>
          <span className="pcard-body">
            <span className="pcard-name">{card.name}</span>
            <span className="pcard-text">{card.text || 'No text on this card.'}</span>
          </span>
        </div>
        <dl className="info-facts">
          {cardDetails(card).map((r) => (
            <div key={r.label}>
              <dt>{r.label}</dt>
              <dd>{r.value}</dd>
            </div>
          ))}
        </dl>
        <button className="wide secondary" onClick={onClose} autoFocus>
          Close
        </button>
      </div>
    </div>,
    document.body,
  )
}
