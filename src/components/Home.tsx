import { useState } from 'react'
import { createGame, joinGame } from '../sync/actions'
import type { SyncTransport } from '../sync/transport'
import { defaultConfig } from '../lobby/config'
import { describeError } from '../lobby/messages'
import { PastGames } from './PastGames'
import { LAST_CODE_KEY, NAME_KEY, readLocal, writeLocal } from '../lib/storage'

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

interface Props {
  transport: SyncTransport
  onEnter: (gameId: string) => void
  onSettings: () => void
  onReplay: (gameId: string) => void
}

export function Home({ transport, onEnter, onSettings, onReplay }: Props) {
  const [name, setName] = useState(() => readLocal(NAME_KEY) ?? '')
  const [linkCode] = useState(codeFromUrl)
  // A link's code wins; else the last game's, so a phone that dropped out can rejoin in a tap.
  const [code, setCode] = useState(() => linkCode || (CODE_RE.test(readLocal(LAST_CODE_KEY) ?? '') ? readLocal(LAST_CODE_KEY)! : ''))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const trimmed = name.trim()
  const codeOk = CODE_RE.test(code)

  const run = async (fn: () => Promise<{ game_id: string; code?: string }>) => {
    setBusy(true)
    setErr(null)
    writeLocal(NAME_KEY, trimmed)
    try {
      const res = await fn()
      if (res.code) writeLocal(LAST_CODE_KEY, res.code)
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
      <button className="icon-button home-settings" aria-label="Settings" onClick={onSettings}>
        <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
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
            autoFocus={!name}
          />
        </label>

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

        <p className="divider">or start a new game</p>
        <button
          className={linkCode || codeOk ? 'wide secondary' : 'wide'}
          disabled={busy || !trimmed}
          onClick={() => run(() => createGame(transport, trimmed, defaultConfig))}
        >
          Create game
        </button>
      </section>

      <PastGames transport={transport} onOpen={onReplay} />

      {err && (
        <p className="bad sticky-error" role="alert">
          {err}
        </p>
      )}
    </>
  )
}
