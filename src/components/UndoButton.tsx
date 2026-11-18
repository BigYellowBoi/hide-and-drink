import { useMemo, useState } from 'react'
import { describeError } from '../lobby/messages'
import { undoLabel, undoTarget } from '../play/undo'
import type { GameSync } from '../sync/engine'
import type { GameEvent } from '../sync/types'

/**
 * Host only: take back the latest question asked, answer or shading by hand
 * (undo_last_action). Two taps: the first says what will be undone.
 */
export function UndoButton({ sync, events, canAct }: { sync: GameSync; events: readonly GameEvent[]; canAct: boolean }) {
  const target = useMemo(() => undoTarget(events), [events])
  const [sureSeq, setSureSeq] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  if (!target) return null
  const label = undoLabel(target.type, target.questionType)
  const sure = sureSeq === target.seq

  const undo = async () => {
    setBusy(true)
    setErr(null)
    try {
      await sync.action('undo_last_action', {})
      setSureSeq(null)
    } catch (e) {
      setErr(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card undo-bar">
      {sure ? (
        <span className="confirm-row">
          <button className="secondary small" disabled={busy} onClick={() => setSureSeq(null)}>
            Cancel
          </button>
          <button className="small" disabled={busy || !canAct} onClick={() => void undo()}>
            Undo {label}
          </button>
        </span>
      ) : (
        <button className="secondary small" disabled={!canAct} onClick={() => setSureSeq(target.seq)}>
          Host: undo last ({label})
        </button>
      )}
      <span className="muted small-note">Everyone sees the undo in the timeline.</span>
      {err && <span className="bad small-note">{err}</span>}
    </section>
  )
}
