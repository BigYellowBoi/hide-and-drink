import { useState } from 'react'
import { drinkTeams, type CardsState } from '../cards/state'
import { readLocal, writeLocal } from '../lib/storage'
import type { Team } from '../sync/types'

/** How long a drink card stays pinned if nobody taps Done. */
const SHOW_MS = 10 * 60_000

const seenKey = (gameId: string) => `hd.drinksSeen.${gameId}`

/**
 * Drinks All Round, Cheers and other cards that make a team drink: pinned on top of every tab
 * on both teams' phones, so nobody misses them, until this phone taps Done.
 */
export function DrinkNotice({ gameId, cards, team, now }: { gameId: string; cards: CardsState; team: Team; now: number }) {
  const [seen, setSeen] = useState<string[]>(() => {
    try {
      const v: unknown = JSON.parse(readLocal(seenKey(gameId)) ?? '[]')
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  })
  const shown = cards.played.filter((p) => drinkTeams(p).length > 0 && now - p.playedAt < SHOW_MS && !seen.includes(p.instanceId))
  if (!shown.length) return null
  const done = (id: string) => {
    const next = [...seen, id].slice(-50)
    setSeen(next)
    writeLocal(seenKey(gameId), JSON.stringify(next))
  }
  return (
    <>
      {shown.map((p) => {
        const teams = drinkTeams(p)
        const who = teams.length > 1 ? 'Both teams drink' : teams.includes(team) ? 'Your team drinks' : `The ${teams[0]} drink`
        return (
          <section key={p.instanceId} className="card pick-prompt drink-notice" role="alert">
            <div>
              <p className="eyebrow">{who}</p>
              <h2>{p.card.name}</h2>
              {p.card.text && <p className="muted small">{p.card.text}</p>}
            </div>
            <button className="small" onClick={() => done(p.instanceId)}>
              Done
            </button>
          </section>
        )
      })}
    </>
  )
}
