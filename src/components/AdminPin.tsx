import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { SyncTransport } from '../sync/transport'
import { describeError } from '../lobby/messages'
import { enterAdminPin, fetchIsAdmin } from '../replay/api'

/**
 * Settings: become an admin with the admin PIN (checked by the Edge Function admin-pin,
 * rate-limited; docs/admin.md). Admins see and may delete every ended game. Once per phone:
 * a new phone, or one with its data cleared, enters it again.
 */
export function AdminPin({ transport }: { transport: SyncTransport }) {
  const [admin, setAdmin] = useState<boolean | null>(null)
  const [open, setOpen] = useState(false)
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!supabase) return
    const client = supabase
    transport
      .signIn()
      .then(() => fetchIsAdmin(client))
      .then(setAdmin)
      .catch(() => setAdmin(false))
  }, [transport])

  const submit = async () => {
    if (!supabase || !pin.trim()) return
    setBusy(true)
    setErr(null)
    try {
      setAdmin(await enterAdminPin(supabase, pin))
      setPin('')
      setOpen(false)
    } catch (e) {
      setErr(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h2>Admin</h2>
      {admin ? (
        <p className="muted small-note">This phone is an admin: Home lists every ended game, and you can delete any of them.</p>
      ) : !open ? (
        <>
          <p className="muted small-note">Admins see every past game on Home and can delete any of them.</p>
          <div className="row">
            <button className="small secondary" disabled={admin === null} onClick={() => setOpen(true)}>
              Admin
            </button>
          </div>
        </>
      ) : (
        <form
          className="join-inline"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <input
            aria-label="Admin PIN"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            autoFocus
            placeholder="PIN"
          />
          <button type="submit" disabled={busy || !pin.trim()}>
            {busy ? 'Checking…' : 'Enter'}
          </button>
        </form>
      )}
      {err && (
        <p className="bad small" role="alert">
          {err}
        </p>
      )}
    </>
  )
}
