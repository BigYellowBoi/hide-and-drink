import { Suspense, useEffect, useState } from 'react'
import type { GameSync } from '../sync/engine'
import type { LobbyState } from '../lobby/state'
import type { Presence } from '../sync/presence'
import { PresenceDot } from './PresenceDot'
import { LazyGameMap } from './lazyMap'

const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Placeholder after start until the phase 2 map screen: hiding countdown on server time. */
interface Props {
  sync: GameSync
  lobby: LobbyState
  userId: string | null
  presence: (userId: string) => Presence
}

export function Started({ sync, lobby, userId, presence }: Props) {
  const [now, setNow] = useState(() => sync.serverNow())
  useEffect(() => {
    const t = setInterval(() => setNow(sync.serverNow()), 250)
    return () => clearInterval(t)
  }, [sync])

  const started = lobby.started
  if (!started) return null
  const endsAt = started.startedAt + started.hidingPeriodS * 1000
  const left = endsAt - now
  const me = lobby.players.find((p) => p.userId === userId)

  return (
    <>
    <section className="card started">
      <p className="eyebrow">{left > 0 ? 'Hiding period' : 'Hiding period over'}</p>
      <p className="countdown">{mmss(left)}</p>
      <p className="started-you">
        You are{' '}
        {me?.team ? (
          <strong className={`team-label-${me.team}`}>{me.team === 'hiders' ? 'hiding' : 'seeking'}</strong>
        ) : (
          'not on a team'
        )}
        .
      </p>
      <p className="muted">
        Round {started.round} · {started.playAreaName ?? 'Play area'}
      </p>
      {lobby.players.length > 0 && (
        <ul className="started-teams">
          {(['hiders', 'seekers'] as const).map((t) => (
            <li key={t}>
              <strong className={`team-label-${t}`}>{t === 'hiders' ? 'Hiders' : 'Seekers'}</strong>{' '}
              {lobby.players
                .filter((p) => p.team === t)
                .map((p) => (
                  <span key={p.userId} className="started-player">
                    <PresenceDot online={presence(p.userId)} />
                    {p.name}
                  </span>
                ))}
            </li>
          ))}
        </ul>
      )}
    </section>
    <section className="card map-card">
      <Suspense fallback={<div className="game-map play-map" />}>
        <LazyGameMap city={lobby.city} playArea={started.playArea} className="play-map" />
      </Suspense>
    </section>
    </>
  )
}
