import { useState } from 'react'
import { createGame, joinGame } from '../sync/actions'
import type { SyncTransport } from '../sync/transport'
import { defaultConfig } from '../lobby/config'
import { describeError } from '../lobby/messages'
import { NAME_KEY, readLocal, writeLocal } from '../lib/storage'

const CODE_RE = /^[A-HJ-NP-Z]{4}$/

/** ?join=ABCD from a scanned QR code or shared link. */
function codeFromUrl(): string {
  const raw = new URLSearchParams(window.location.search).get('join')?.toUpperCase().trim() ?? ''
  return CODE_RE.test(raw) ? raw : ''
}

function clearJoinParam() {
  const url = new URL(window.location.href)
  if (!url.searchParams.has('join')) return
  url.searchParams.delete('join')
  window.history.replaceState(null, '', url.pathname + url.search + url.hash)
}

export function Home({ transport, onEnter }: { transport: SyncTransport; onEnter: (gameId: string) => void }) {
  const [name, setName] = useState(() => readLocal(NAME_KEY) ?? '')
  const [linkCode] = useState(codeFromUrl)
  const [code, setCode] = useState(linkCode)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const trimmed = name.trim()
  const codeOk = CODE_RE.test(code)

  const run = async (fn: () => Promise<{ game_id: string }>) => {
    setBusy(true)
    setErr(null)
    writeLocal(NAME_KEY, trimmed)
    try {
      const res = await fn()
      clearJoinParam()
      onEnter(res.game_id)
    } catch (e) {
      setErr(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <section className="card">
        <label className="field">
          <span>Your name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={24}
            autoComplete="nickname"
            placeholder="e.g. Louis"
            autoFocus={!name}
          />
        </label>
      </section>

      <section className="card">
        <h2>Join a game</h2>
        {linkCode && <p className="muted">Code from your link. Enter your name and tap Join.</p>}
        <label className="field">
          <span>Join code</span>
          <input
            className="code-input"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4))}
            inputMode="text"
            autoCapitalize="characters"
            autoComplete="off"
            placeholder="ABCD"
          />
        </label>
        <button
          className="wide"
          disabled={busy || !trimmed || !codeOk}
          onClick={() => run(() => joinGame(transport, code, trimmed))}
        >
          Join
        </button>
        <p className="muted small-note">Or scan the host's QR code with your camera.</p>
      </section>

      <section className="card">
        <h2>Host a game</h2>
        <button
          className="wide secondary"
          disabled={busy || !trimmed}
          onClick={() => run(() => createGame(transport, trimmed, defaultConfig))}
        >
          Create game
        </button>
      </section>

      {err && <p className="bad">{err}</p>}
    </>
  )
}
