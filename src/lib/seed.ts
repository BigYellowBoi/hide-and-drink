import cardsData from '../../data/cards.json'
import questionsData from '../../data/questions.json'

export type Behaviour =
  | 'text'
  | 'timed'
  | 'until_cleared'
  | 'time_bonus'
  | 'next_question_modifier'
  | 'powerup'

export type CastCost = 'free' | 'drink' | 'shot' | null

export interface Card {
  id: string
  name: string
  category: string
  behaviour: Behaviour
  copies: number
  text: string | null
  params: Record<string, unknown>
  active: boolean
  cast_cost?: CastCost
  can_veto?: boolean
  todo?: string
}

export interface Category {
  id: string
  name: string
  colour: string
}

export const categories = cardsData.categories as Category[]
export const behaviours = cardsData.behaviours as Behaviour[]
export const cards = cardsData.cards as Card[]
export const questionTypes = questionsData.types

export function deckSize(list: Card[] = cards): number {
  return list.filter((c) => c.active).reduce((sum, c) => sum + c.copies, 0)
}

export function copiesByCategory(list: Card[] = cards): Record<string, number> {
  const out: Record<string, number> = {}
  for (const c of list) {
    if (!c.active) continue
    out[c.category] = (out[c.category] ?? 0) + c.copies
  }
  return out
}
