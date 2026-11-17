import type { LobbyState } from '../lobby/state'
import type { Presence } from '../sync/presence'
import type { PlayState } from '../play/state'
import { mmss } from '../play/useServerNow'
import { PresenceDot } from './PresenceDot'

interface Props {
  play: PlayState
  lobby: LobbyState
  presence: (userId: string) => Presence
}

/** Newest first, time since the round started. Penalties in amber. */
export function PlayLog({ play, lobby, presence }: Props) {
  const roundStart = lobby.started?.startedAt ?? 0
  return (
    <>
      <section className="card">
        <h2>Log</h2>
        {play.log.length === 0 ? (
          <p className="muted">Nothing yet.</p>
        ) : (
          <ul className="play-log">
            {[...play.log].reverse().map((l) => (
              <li key={l.seq} className={`log-${l.kind}`}>
                <span className="log-dot" aria-hidden="true" />
                <span className="log-time">+{mmss(l.at - roundStart)}</span>
                <span>
                  {l.text}
                  {l.private && <span className="muted small"> 🔒 only you</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="card">
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
        <p className="muted small">
          Round {lobby.started?.round} · {lobby.started?.playAreaName ?? 'Play area'}
        </p>
      </section>
    </>
  )
}
