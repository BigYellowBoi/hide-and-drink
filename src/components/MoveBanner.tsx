import { formatClock } from '../hiding/state'
import { moveRunning, type MovePeriod } from '../hiding/move'
import { formatDistance } from '../map/geo'
import { useTimerAlert } from '../lib/useTimerAlert'

/**
 * A running Move period, pinned on both teams' screens with its countdown (server time).
 * Seekers: frozen, and where the hiders left from. Hiders: how long and how far they can go.
 */
export function MoveBanner({ move, team, now }: { move: MovePeriod | null; team: 'hiders' | 'seekers'; now: number }) {
  const running = moveRunning(move, now)
  const left = running ? move.endsAt - now : null
  // Buzz a minute before the end and at the end.
  useTimerAlert(running ? `move:${move.seq}` : null, left)
  if (!running || left === null) return null
  const within = move.radiusM !== null ? ` within ${formatDistance(move.radiusM)}` : ''
  return team === 'seekers' ? (
    <div className="freeze-banner" role="alert">
      <strong>Frozen {formatClock(left)}</strong>
      <p>
        The hiders are moving. Stay where you are: no travelling, no questions (you can still call Found if you spot them). They left {move.from.name} (on your map) and
        will be{within} of it.
      </p>
    </div>
  ) : (
    <div className="blocked-banner" role="status">
      <strong>Moving: {formatClock(left)} left</strong>
      <p>
        Get to a new bar{within} of {move.from.name} and pick it on the Map tab. You can change your pick until the time is up.
        Seekers are frozen and your hide timer is paused.
      </p>
    </div>
  )
}
