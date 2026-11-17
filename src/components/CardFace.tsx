import type { ReactNode } from 'react'
import { cardFacts, COST_LABEL, type CardDef } from '../cards/state'

interface Props {
  card: CardDef
  /** large: the selected card; small: hand strip and draw choices. */
  size?: 'large' | 'small'
  selected?: boolean
  onClick?: () => void
  children?: ReactNode
}

/**
 * One template for every card (docs/design.md: content is data): category colour band on
 * top, cost badge, name, text, then facts from the card's params.
 */
export function CardFace({ card, size = 'large', selected = false, onClick, children }: Props) {
  const facts = cardFacts(card)
  const body = (
    <>
      <span className="pcard-band" style={{ background: card.colour }}>
        <span>{card.categoryName}</span>
        {card.castCost && <span className="pcard-cost">{COST_LABEL[card.castCost]}</span>}
      </span>
      <span className="pcard-body">
        <span className="pcard-name">{card.name}</span>
        {size === 'large' && card.text && <span className="pcard-text">{card.text}</span>}
        {facts.length > 0 && <span className="pcard-facts">{facts.join(' · ')}</span>}
        {children}
      </span>
    </>
  )
  const cls = `pcard pcard-${size}${selected ? ' pcard-on' : ''}`
  return onClick ? (
    <button type="button" className={cls} aria-pressed={selected} onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  )
}
