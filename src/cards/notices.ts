import type { GameEvent, Team } from '../sync/types'
import { judgeOf, parseCard, powerupAction, type CardsState } from './state'

/** A box pinned on top until this phone taps OK: what the other team just did. */
export interface Notice {
  key: string
  seq: number
  /** Server time, ms. */
  at: number
  eyebrow: string
  title: string
  body: string | null
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null)
const minutes = (s: unknown) => (typeof s === 'number' && s > 0 ? `${Math.round(s / 60)} min` : null)

/**
 * The other team's moves that otherwise only change a screen quietly: the hider's verdict on
 * "We did it", curses vetoed or cancelled by the seekers, non-curse cards the hiders play
 * publicly (question bans), and dice or wheel results. Host fixes (payload.override_id) are
 * left to the Host fix rows. Answers and curses cast have their own boxes (SeekerNotices).
 */
export function teamNotices(events: readonly GameEvent[], cards: CardsState, team: Team, userId: string | null): Notice[] {
  const out: Notice[] = []
  const effectName = (id: unknown) => cards.effects.find((e) => e.id === id)?.card.name ?? 'Curse'
  const effectCard = (id: unknown) => cards.effects.find((e) => e.id === id)?.card ?? null
  for (const e of events) {
    const p = e.payload
    if (!isObject(p) || p.override_id !== undefined) continue
    if (userId && e.actor_id === userId) continue
    const at = Date.parse(e.created_at)
    const add = (eyebrow: string, title: string, body: string | null = null) =>
      out.push({ key: `e:${e.seq}`, seq: e.seq, at: Number.isFinite(at) ? at : 0, eyebrow, title, body })

    switch (e.type) {
      case 'effect_cleared': {
        if (team !== 'seekers') break
        const card = effectCard(p.effect_id)
        const judge = card ? judgeOf(card) : null
        add(
          judge?.question ? `Hiders picked ${judge.accept}` : 'Hiders confirmed',
          `${effectName(p.effect_id)} is cleared`,
          judge?.question ? `${judge.question} ${judge.accept}.` : 'You did it. The curse is over.',
        )
        break
      }
      case 'effect_clear_rejected': {
        if (team !== 'seekers') break
        const card = effectCard(p.effect_id)
        const judge = card ? judgeOf(card) : null
        add(
          judge?.question ? `Hiders picked ${judge.reject}` : 'Hiders say not yet',
          `${effectName(p.effect_id)} isn't cleared`,
          judge?.question ? `${judge.question} ${judge.reject}. Try again.` : 'Try again, and send a new photo or video if it needs one.',
        )
        break
      }
      case 'curse_vetoed': {
        if (team !== 'hiders') break
        const lock = minutes(p.lock_s)
        add(
          'Seekers vetoed a curse',
          str(p.name) ?? 'Curse',
          [lock ? `They're locked at a bar for ${lock}` : null, str(p.penalty)].filter(Boolean).join(', ') || null,
        )
        break
      }
      case 'curse_checked': {
        if (team !== 'hiders') break
        const name = effectName(p.effect_id)
        if (p.applies === true) add('Seekers say it applies', name, 'It starts now.')
        else add(p.not_applicable === true ? 'Seekers tapped Not applicable' : "Seekers say it doesn't apply", name, 'The curse is cancelled.')
        break
      }
      case 'card_played': {
        // Seekers: public non-curse cards. Veto and Randomize show with the answer box.
        if (team !== 'seekers' || e.visibility !== 'all') break
        const card = parseCard(p.card)
        if (!card || card.category === 'curse') break
        const action = powerupAction(card)
        if (action === 'veto' || action === 'randomize') break
        const bans = Array.isArray(p.bans)
          ? p.bans.map((b) => (isObject(b) ? str(b.label) : null)).filter((x): x is string => !!x)
          : []
        add('The hiders played a card', card.name, bans.length ? `Banned: ${bans.join(', ')}.` : card.text)
        break
      }
      case 'dice_rolled':
      case 'wheel_spun': {
        const dice = Array.isArray(p.dice) ? p.dice.filter((d): d is number => typeof d === 'number') : []
        const result =
          e.type === 'dice_rolled'
            ? `Rolled ${dice.join(' + ')}${dice.length > 1 && typeof p.total === 'number' ? ` = ${p.total}` : ''}`
            : `The wheel says ${str(p.result) ?? '?'}`
        add(e.type === 'dice_rolled' ? 'Dice rolled' : 'Wheel spun', str(p.name) ?? 'Card', result)
        break
      }
    }
  }
  return out
}
