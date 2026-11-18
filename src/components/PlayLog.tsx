import type { LobbyState } from '../lobby/state'
import type { LogEntry } from '../play/state'
import { formatClock } from '../hiding/state'
import { useContext } from 'react'
import { HiderCountContext } from './hiderCount'
import { LockIcon } from './PrivateLabel'
import { PhotoThumb } from './PhotoThumb'

interface Props {
  log: readonly LogEntry[]
  lobby: LobbyState
}

/** Newest first, time since the round started. Penalties in amber. */
export function PlayLog({ log, lobby }: Props) {
  const roundStart = lobby.started?.startedAt ?? 0
  const hiders = useContext(HiderCountContext)
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
                {l.photo && <PhotoThumb path={l.photo} bucket={l.photoBucket} alt={l.photoBucket ? 'Proof photo' : 'Answer photo'} />}
                {l.private && (
                  <span className="muted small">
                    {' '}
                    <LockIcon /> {hiders > 1 ? 'only your team' : 'only you'}
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
