import { useEffect, useState } from 'react'
import { DRINK_BUCKET, proofToastText, type CardsState } from '../cards/state'
import type { Team } from '../sync/types'
import { PhotoThumb } from './PhotoThumb'

/** How long a "done" toast stays up. */
const SHOW_MS = 12_000

/**
 * Pops up on both teams' phones when a drink, curse proof or hider photo comes in (or the
 * host closes one with Fix something), so it isn't only a quiet row in the timeline.
 */
export function ProofToast({ cards, team, now, nameOf }: { cards: CardsState; team: Team | null; now: number; nameOf: (id: string | null) => string }) {
  const [dismissed, setDismissed] = useState<string[]>([])
  const shown = cards.proofs.filter((p) => p.doneAt !== null && now - p.doneAt < SHOW_MS && now >= p.doneAt - 5000 && !dismissed.includes(p.id))
  const key = shown.map((p) => p.id).join()
  useEffect(() => {
    if (key && typeof navigator !== 'undefined' && 'vibrate' in navigator) navigator.vibrate?.(60)
  }, [key])
  if (!shown.length) return null
  return (
    <div className="toast-stack" aria-live="polite">
      {shown.slice(-3).map((p) => {
        const t = proofToastText(p, team, nameOf)
        return (
          <div key={p.id} className="toast" role="status" onClick={() => setDismissed((d) => [...d, p.id])}>
            <span className="toast-tick" aria-hidden="true">
              ✓
            </span>
            <span className="toast-body">
              <strong>{t.title}</strong>
              <span className="muted small">{t.body}</span>
            </span>
            {p.path && <PhotoThumb path={p.path} bucket={DRINK_BUCKET} alt="Proof" />}
          </div>
        )
      })}
    </div>
  )
}
