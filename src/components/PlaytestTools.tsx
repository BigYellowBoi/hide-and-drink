import { useState } from 'react'
import { describeError } from '../lobby/messages'
import type { GameSync } from '../sync/engine'
import type { Team } from '../sync/types'

interface Props {
  sync: GameSync
  status: string
  team: Team | null
  canAct: boolean
}

/**
 * Playtest mode only (config dev_mode, the server checks too): skip the hiding period, and
 * let the hider draw cards without waiting for a question.
 */
export function PlaytestTools({ sync, status, team, canAct }: Props) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const running = status === 'hiding' || status === 'seeking'
  if (!running) return null
  const run = async (fn: string, params: Record<string, unknown> = {}) => {
    setBusy(true)
    setErr(null)
    try {
      await sync.action(fn, params)
    } catch (e) {
      setErr(describeError(e))
    } finally {
      setBusy(false)
    }
  }
  const off = busy || !canAct
  return (
    <div className="dev-tools">
      {status === 'hiding' && (
        <button className="small secondary" disabled={off} onClick={() => run('skip_hiding')}>
          Skip hiding
        </button>
      )}
      {team === 'hiders' && (
        <button className="small secondary" disabled={off} onClick={() => run('dev_draw_cards', { p_count: 3 })}>
          Draw 3 cards
        </button>
      )}
      {err && <span className="bad small">{err}</span>}
    </div>
  )
}
