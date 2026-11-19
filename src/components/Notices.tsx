import { useMemo, useState } from 'react'
import { canSayNotApplicable, drinkTeams, effectTimer, type CardsState } from '../cards/state'
import { readLocal, writeLocal } from '../lib/storage'
import { answerText, NULL_ANSWER, questionLabel, type PlayState } from '../play/state'
import { teamNotices } from '../cards/notices'
import type { GameSync } from '../sync/engine'
import type { GameEvent, Team } from '../sync/types'
import { CardFace } from './CardFace'
import { EffectBar, NotApplicable } from './EffectsPanel'
import { PhotoThumb } from './PhotoThumb'

/** How long a notice stays pinned if nobody taps OK (a phone opened much later skips old ones). */
const SHOW_MS = 10 * 60_000

const seenKey = (gameId: string) => `hd.noticesSeen.${gameId}`

function useSeen(gameId: string): [string[], (id: string) => void] {
  const [seen, setSeen] = useState<string[]>(() => {
    try {
      const v: unknown = JSON.parse(readLocal(seenKey(gameId)) ?? '[]')
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  })
  const done = (id: string) => {
    const next = [...seen, id].slice(-100)
    setSeen(next)
    writeLocal(seenKey(gameId), JSON.stringify(next))
  }
  return [seen, done]
}

/**
 * Seekers: the hider's answer to each question, and every curse the hiders play, pinned on
 * top of every tab until this phone taps OK. Curses that already pin their own box (drink
 * cards, "does it apply?" checks) are left to those.
 */
export function SeekerNotices({
  sync,
  play,
  cards,
  now,
  canAct,
}: {
  sync: GameSync
  play: PlayState
  cards: CardsState
  now: number
  canAct: boolean
}) {
  const [seen, done] = useSeen(sync.gameId)
  const answers = play.questions.filter(
    (q) =>
      q.answeredAt !== null &&
      q.closedBy !== 'void' &&
      (q.answer !== null || q.closedBy !== null) &&
      now - q.answeredAt < SHOW_MS &&
      !seen.includes(`a:${q.id}:${q.answeredAt}`),
  )
  const curses = cards.played.filter((p) => {
    if (p.card.category !== 'curse' || now - p.playedAt >= SHOW_MS || seen.includes(`c:${p.instanceId}`)) return false
    if (drinkTeams(p).length > 0) return false
    const effect = p.effectId ? cards.effects.find((e) => e.id === p.effectId) : null
    return effect?.status !== 'awaiting_seekers'
  })
  if (!answers.length && !curses.length) return null
  return (
    <>
      {answers.map((q) => {
        const key = `a:${q.id}:${q.answeredAt}`
        const photo = q.type === 'photos' && q.answer && q.answer !== NULL_ANSWER ? q.answer : null
        const text =
          q.closedBy === 'veto' ? 'Vetoed by the hiders' : q.closedBy === 'randomize' ? 'Randomized into another question' : photo ? null : answerText(q, q.answer!)
        return (
          <section key={key} className="card pick-prompt drink-notice notice" role="alert">
            <div>
              <p className="eyebrow">Hiders answered{q.late ? ' (late)' : ''}</p>
              <h2>{questionLabel(q)}</h2>
              {text && <p className="notice-answer">{text}</p>}
              {photo && <PhotoThumb path={photo} />}
            </div>
            <button className="small" onClick={() => done(key)}>
              OK
            </button>
          </section>
        )
      })}
      {curses.map((p) => {
        const effect = p.effectId ? cards.effects.find((e) => e.id === p.effectId) : null
        const timer = effect ? effectTimer(effect, now) : null
        return (
          <section key={p.instanceId} className="card drink-notice notice notice-card" role="alert">
            <p className="eyebrow">The hiders cast a curse</p>
            <CardFace card={p.card}>
              {timer && <EffectBar endsAt={timer[0]} totalS={timer[1]} now={now} label="Left" />}
              {effect && canSayNotApplicable(effect, now) && <NotApplicable sync={sync} effect={effect} canAct={canAct} />}
            </CardFace>
            <button className="wide" onClick={() => done(`c:${p.instanceId}`)}>
              OK
            </button>
          </section>
        )
      })}
    </>
  )
}

/**
 * Both teams: the other team's moves that otherwise only change a screen quietly (the
 * hider's verdict on We did it, vetoed or cancelled curses, bans, dice), until OK.
 */
export function TeamNotices({
  gameId,
  events,
  cards,
  team,
  userId,
  now,
}: {
  gameId: string
  events: readonly GameEvent[]
  cards: CardsState
  team: Team
  userId: string | null
  now: number
}) {
  const [seen, done] = useSeen(gameId)
  const all = useMemo(() => teamNotices(events, cards, team, userId), [events, cards, team, userId])
  const shown = all.filter((n) => now - n.at < SHOW_MS && !seen.includes(n.key))
  if (!shown.length) return null
  return (
    <>
      {shown.map((n) => (
        <section key={n.key} className="card pick-prompt drink-notice notice" role="alert">
          <div>
            <p className="eyebrow">{n.eyebrow}</p>
            <h2>{n.title}</h2>
            {n.body && <p className="muted small">{n.body}</p>}
          </div>
          <button className="small" onClick={() => done(n.key)}>
            OK
          </button>
        </section>
      ))}
    </>
  )
}
