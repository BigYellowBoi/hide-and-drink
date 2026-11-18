import type { SupabaseClient } from '@supabase/supabase-js'
import type { CardDef } from '../cards/state'
import { NAME_KEY, readLocal } from '../lib/storage'
import { callWithRetry } from '../sync/actions'
import type { SyncTransport } from '../sync/transport'

/** The shared card library (DB tables cards/categories). Games snapshot it at start. */

export type CastCost = 'free' | 'drink' | 'shot'

export interface LibraryCategory {
  id: string
  name: string
  colour: string
  sort: number
  active: boolean
}

export interface LibraryCard {
  id: string
  name: string
  category: string
  behaviour: string
  text: string | null
  params: Record<string, unknown>
  castCost: CastCost | null
  canVeto: boolean | null
  /** Library default copies (the deck when the host hasn't built one). */
  copies: number
  sort: number
  active: boolean
  updatedByName: string | null
  /** As stored (ISO string), sent back on save so the server can refuse a stale edit. */
  updatedAt: string
}

export interface DeckPreset {
  id: string
  name: string
  /** null = library defaults. */
  deck: Deck | null
  builtIn: boolean
  creatorName: string | null
  sort: number
}

export interface Library {
  categories: LibraryCategory[]
  cards: LibraryCard[]
  presets: DeckPreset[]
}

/** config.deck: copies per card id. Missing = 0. */
export type Deck = Record<string, number>

const str = (v: unknown) => (typeof v === 'string' ? v : null)
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function parseDeck(v: unknown): Deck | null {
  if (!isObject(v)) return null
  const out: Deck = {}
  for (const [k, n] of Object.entries(v)) if (typeof n === 'number' && Number.isInteger(n) && n >= 0) out[k] = n
  return out
}

export function parseCategory(r: Record<string, unknown>): LibraryCategory {
  return {
    id: String(r.id),
    name: str(r.name) ?? String(r.id),
    colour: str(r.colour) ?? '#A9B4BF',
    sort: num(r.sort),
    active: r.active !== false,
  }
}

export function parseCard(r: Record<string, unknown>): LibraryCard {
  const cost = r.cast_cost
  return {
    id: String(r.id),
    name: str(r.name) ?? String(r.id),
    category: str(r.category_id) ?? '',
    behaviour: str(r.behaviour) ?? 'text',
    text: str(r.body),
    params: isObject(r.params) ? r.params : {},
    castCost: cost === 'free' || cost === 'drink' || cost === 'shot' ? cost : null,
    canVeto: typeof r.can_veto === 'boolean' ? r.can_veto : null,
    copies: num(r.default_copies),
    sort: num(r.sort),
    active: r.active !== false,
    updatedByName: str(r.updated_by_name),
    updatedAt: str(r.updated_at) ?? '',
  }
}

export function parsePreset(r: Record<string, unknown>): DeckPreset {
  return {
    id: String(r.id),
    name: str(r.name) ?? '',
    deck: parseDeck(r.deck),
    builtIn: r.created_by === null || r.created_by === undefined,
    creatorName: str(r.creator_name),
    sort: num(r.sort, 100),
  }
}

export async function fetchLibrary(client: SupabaseClient): Promise<Library> {
  const [cats, cards, presets] = await Promise.all([
    client.from('categories').select('id, name, colour, sort, active').order('sort').order('id'),
    client
      .from('cards')
      .select('id, name, category_id, behaviour, body, params, cast_cost, can_veto, default_copies, sort, active, updated_by_name, updated_at')
      .order('sort')
      .order('id'),
    client.from('deck_presets').select('id, name, deck, created_by, creator_name, sort').order('sort').order('name'),
  ])
  for (const r of [cats, cards, presets]) if (r.error) throw new Error(r.error.message)
  return {
    categories: (cats.data ?? []).map(parseCategory),
    cards: (cards.data ?? []).map(parseCard),
    presets: (presets.data ?? []).map(parsePreset),
  }
}

/** A library card as a CardDef, for CardFace (preview and lists). */
export function toCardDef(card: LibraryCard, categories: LibraryCategory[], copies = card.copies): CardDef {
  const cat = categories.find((c) => c.id === card.category)
  return {
    id: card.id,
    name: card.name,
    category: card.category,
    categoryName: cat?.name ?? card.category,
    colour: cat?.colour ?? '#A9B4BF',
    behaviour: card.behaviour,
    text: card.text,
    params: card.params,
    castCost: card.castCost,
    canVeto: card.canVeto,
    copies,
  }
}

// ---------------------------------------------------------------- deck (pure)

/** Copies of a card in this game's deck: config.deck when set, else the library default. */
export const copiesIn = (deck: Deck | null, card: LibraryCard): number =>
  deck ? (deck[card.id] ?? 0) : card.copies

/** The deck the game would start with, as a full {card_id: copies} map over active cards. */
export function effectiveDeck(deck: Deck | null, cards: LibraryCard[]): Deck {
  const out: Deck = {}
  for (const c of cards) if (c.active) out[c.id] = copiesIn(deck, c)
  return out
}

/** Set one card's copies, turning the library defaults into an explicit deck first. */
export function withCopies(deck: Deck | null, cards: LibraryCard[], cardId: string, copies: number): Deck {
  const next = effectiveDeck(deck, cards)
  next[cardId] = Math.max(0, Math.min(99, Math.round(copies)))
  return next
}

/** Copies per category (active cards only) and in total. */
export function deckTotals(deck: Deck | null, cards: LibraryCard[]): { total: number; byCategory: Record<string, number> } {
  const byCategory: Record<string, number> = {}
  let total = 0
  for (const c of cards) {
    if (!c.active) continue
    const n = copiesIn(deck, c)
    byCategory[c.category] = (byCategory[c.category] ?? 0) + n
    total += n
  }
  return { total, byCategory }
}

/** A preset as a deck for set_deck: null stays null (library defaults); retired cards drop. */
export function presetDeck(preset: DeckPreset, cards: LibraryCard[]): Deck | null {
  if (!preset.deck) return null
  const out: Deck = {}
  for (const c of cards) if (c.active) out[c.id] = preset.deck[c.id] ?? 0
  return out
}

/** Does the game's deck match this preset? */
export function matchesPreset(deck: Deck | null, preset: DeckPreset, cards: LibraryCard[]): boolean {
  const a = effectiveDeck(deck, cards)
  const b = effectiveDeck(presetDeck(preset, cards), cards)
  return cards.every((c) => !c.active || a[c.id] === b[c.id])
}

/** Only cards with copies, for saving as a preset. */
export const compactDeck = (deck: Deck): Deck =>
  Object.fromEntries(Object.entries(deck).filter(([, n]) => n > 0))

// ---------------------------------------------------------------- actions

const authorName = () => readLocal(NAME_KEY)?.trim() || null

async function call(transport: SyncTransport, fn: string, args: Record<string, unknown>): Promise<unknown> {
  await transport.signIn()
  return callWithRetry(transport, fn, { ...args, p_client_action_id: crypto.randomUUID() })
}

export interface CardDraft {
  name: string
  category: string
  behaviour: string
  text: string
  params: Record<string, unknown>
  castCost: CastCost | null
  canVeto: boolean | null
  copies: number
}

export const draftOf = (c: LibraryCard): CardDraft => ({
  name: c.name,
  category: c.category,
  behaviour: c.behaviour,
  text: c.text ?? '',
  params: c.params,
  castCost: c.castCost,
  canVeto: c.canVeto,
  copies: c.copies,
})

/** Save a card (id null = new). Returns its id. */
export async function saveCard(
  transport: SyncTransport,
  id: string | null,
  d: CardDraft,
  baseUpdatedAt: string | null,
): Promise<string> {
  const res = (await call(transport, 'save_card', {
    p_card_id: id,
    p_card: {
      name: d.name.trim(),
      category: d.category,
      behaviour: d.behaviour,
      text: d.text.trim() || null,
      params: d.params,
      cast_cost: d.castCost,
      can_veto: d.canVeto,
      copies: d.copies,
    },
    p_base_updated_at: baseUpdatedAt,
    p_author_name: authorName(),
  })) as { card_id: string }
  return res.card_id
}

export const setCardActive = (transport: SyncTransport, id: string, active: boolean) =>
  call(transport, 'set_card_active', { p_card_id: id, p_active: active, p_author_name: authorName() })

export const saveCategory = (transport: SyncTransport, id: string | null, name: string, colour: string) =>
  call(transport, 'save_category', {
    p_category_id: id,
    p_name: name.trim(),
    p_colour: colour,
    p_author_name: authorName(),
  })

export const setCategoryActive = (transport: SyncTransport, id: string, active: boolean) =>
  call(transport, 'set_category_active', { p_category_id: id, p_active: active, p_author_name: authorName() })

export const saveDeckPreset = (transport: SyncTransport, name: string, deck: Deck) =>
  call(transport, 'save_deck_preset', { p_name: name.trim(), p_deck: compactDeck(deck), p_author_name: authorName() })

export const deleteDeckPreset = (transport: SyncTransport, id: string) =>
  call(transport, 'delete_deck_preset', { p_preset_id: id })
