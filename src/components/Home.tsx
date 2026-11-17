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
      <div className="hero">
        <img className="logo-tile" src={`${import.meta.env.BASE_URL}logo.svg`} alt="" width={112} height={112} />
        <h1 className="sr-only">Hide + Drink</h1>
        <img className="wordmark" src={`${import.meta.env.BASE_URL}wordmark.svg`} alt="Hide + Drink" width={240} height={35} />
      </div>

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

        <button
          className={linkCode ? 'wide secondary' : 'wide'}
          disabled={busy || !trimmed}
          onClick={() => run(() => createGame(transport, trimmed, defaultConfig))}
        >
          Create game
        </button>

        <p className="divider">or join with a code</p>
        {linkCode && <p className="muted small-note">Code from your link. Enter your name and tap Join.</p>}
        <div className="join-inline">
          <input
            className="code-input"
            aria-label="Join code"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4))}
            inputMode="text"
            autoCapitalize="characters"
            autoComplete="off"
            placeholder="ABCD"
          />
          <button
            className={codeOk ? '' : 'secondary'}
            disabled={busy || !trimmed || !codeOk}
            onClick={() => run(() => joinGame(transport, code, trimmed))}
          >
            Join
          </button>
        </div>
        <p className="muted small-note">Or scan the host's QR code with your camera.</p>
      </section>

      {err && (
        <p className="bad sticky-error" role="alert">
          {err}
        </p>
      )}
    </>
  )
}
