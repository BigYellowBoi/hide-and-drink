import { mmss } from '../play/useServerNow'

interface Props {
  /** Server ms. */
  endsAt: number
  totalS: number
  now: number
  size?: number
}

/** Ring + digits for an answer deadline (docs/design.md). Amber under a minute, "Late" after. */
export function DeadlineRing({ endsAt, totalS, now, size = 64 }: Props) {
  const left = endsAt - now
  const frac = totalS > 0 ? Math.max(0, Math.min(1, left / (totalS * 1000))) : 0
  const r = size / 2 - 4
  const c = 2 * Math.PI * r
  const tone = left <= 0 ? 'late' : left < 60_000 ? 'soon' : 'ok'
  return (
    <div className={`ring ring-${tone}`} style={{ width: size, height: size }} role="timer" aria-label="Time to answer">
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
      <span className="ring-digits">{left > 0 ? mmss(left) : 'Late'}</span>
    </div>
  )
}
