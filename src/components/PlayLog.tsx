import type { LobbyState } from '../lobby/state'
import type { LogEntry } from '../play/state'
import { formatClock } from '../hiding/state'
import { LockIcon } from './BarPicker'
import { PhotoThumb } from './PhotoThumb'

interface Props {
  log: readonly LogEntry[]
  lobby: LobbyState
}

/** Newest first, time since the round started. Penalties in amber. */
export function PlayLog({ log, lobby }: Props) {
  const roundStart = lobby.started?.startedAt ?? 0
  return (
    <section className="card">
      <h2>Log</h2>
      {log.length === 0 ? (
        <p className="muted">Nothing yet.</p>
      ) : (
        <ul className="play-log">
          {[...log].reverse().map((l) => (
            <li key={l.seq} className={`log-${l.kind}`}>
              <span className="log-dot" style={l.colour ? { background: l.colour } : undefined} aria-hidden="true" />
              <span className="log-time">+{formatClock(l.at - roundStart, { up: true })}</span>
              <span>
                {l.text}
                {l.photo && <PhotoThumb path={l.photo} />}
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
