import { formatClock } from '../hiding/state'
import { formatOverdue, timerTone } from '../lib/timers'

interface Props {
  /** Server ms. */
  endsAt: number
  totalS: number
  now: number
  size?: number
}

/**
 * Ring + digits for an answer deadline (docs/design.md). Amber under a minute, pulsing in
 * the last ten seconds, then "Late" with the time past the deadline counting up.
 */
export function DeadlineRing({ endsAt, totalS, now, size = 64 }: Props) {
  const left = endsAt - now
  const frac = totalS > 0 ? Math.max(0, Math.min(1, left / (totalS * 1000))) : 0
  const r = size / 2 - 4
  const c = 2 * Math.PI * r
  const tone = timerTone(left)
  const label = left > 0 ? `${formatClock(left)} to answer` : `Late by ${formatOverdue(-left).slice(1)}`
  return (
    <div className={`ring ring-${tone}`} style={{ width: size, height: size }} role="timer" aria-label={label}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} className="ring-track" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          className="ring-fill"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - frac)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      {left > 0 ? (
        <span className="ring-digits">{formatClock(left)}</span>
      ) : (
        <span className="ring-digits ring-late-digits">
          <span>Late</span>
          <span>{formatOverdue(-left)}</span>
        </span>
      )}
    </div>
  )
}
