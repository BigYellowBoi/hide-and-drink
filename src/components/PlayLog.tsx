import type { LobbyState } from '../lobby/state'
import type { PlayState } from '../play/state'
import { formatClock } from '../hiding/state'
import { LockIcon } from './BarPicker'

interface Props {
  play: PlayState
  lobby: LobbyState
}

/** Newest first, time since the round started. Penalties in amber. */
export function PlayLog({ play, lobby }: Props) {
  const roundStart = lobby.started?.startedAt ?? 0
  return (
    <section className="card">
      <h2>Log</h2>
      {play.log.length === 0 ? (
        <p className="muted">Nothing yet.</p>
      ) : (
        <ul className="play-log">
          {[...play.log].reverse().map((l) => (
            <li key={l.seq} className={`log-${l.kind}`}>
              <span className="log-dot" aria-hidden="true" />
              <span className="log-time">+{formatClock(l.at - roundStart, { up: true })}</span>
              <span>
                {l.text}
                {l.private && (
                  <span className="muted small">
                    {' '}
                    <LockIcon /> only you
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
