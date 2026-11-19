import { useState } from 'react'
import type { GameSync } from '../sync/engine'
import { describeError } from '../lobby/messages'
import { SlideToConfirm } from './SlideToConfirm'

/**
 * Seekers end the seeking period with "Found them", guarded three ways so it can't happen by
 * accident (docs/spec.md §9): tap once, tap "Are you sure?" to unlock the slider, then slide.
 * Either seeker can do it; every phone goes to the round's result straight away.
 */
export function FoundButton({ sync, canAct }: { sync: GameSync; canAct: boolean }) {
  const [step, setStep] = useState<'idle' | 'sure' | 'slide'>('idle')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const found = async () => {
    setBusy(true)
    setErr(null)
    try {
      await sync.action('found_hider')
    } catch (e) {
      setErr(describeError(e))
      setStep('idle')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card found-card">
      {step === 'idle' ? (
        <button className="wide secondary" disabled={!canAct} onClick={() => setStep('sure')}>
          Found them
        </button>
      ) : step === 'sure' ? (
        <>
          <p>
            <strong>Are you sure?</strong> Only when you can see the hiders. This ends the round for everyone.
          </p>
          <div className="row">
            <button className="secondary" onClick={() => setStep('idle')}>
              Not yet
            </button>
            <button disabled={!canAct} onClick={() => setStep('slide')}>
              Yes, we found them
            </button>
          </div>
        </>
      ) : (
        <>
          <SlideToConfirm label={busy ? 'Ending the round…' : 'Slide to end the round'} disabled={!canAct || busy} onConfirm={() => void found()} />
          <button className="small secondary" disabled={busy} onClick={() => setStep('idle')}>
            Cancel
          </button>
        </>
      )}
      {err && <p className="bad">{err}</p>}
    </section>
  )
}
