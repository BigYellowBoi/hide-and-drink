import { useEffect, useState } from 'react'
import { ActionError, createGame, joinGame } from '../sync/actions'
import { supabaseTransport } from '../sync/supabaseTransport'
import { useGameSync } from '../sync/useGameSync'
import { supabase } from '../lib/supabase'
import { ConnectionStatus } from './ConnectionStatus'

const transport = supabase ? supabaseTransport(supabase) : null
const STORAGE_KEY = 'hd.gameId'

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function store(id: string | null) {
  try {
    if (id) localStorage.setItem(STORAGE_KEY, id)
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Storage unavailable (private mode): the game just won't resume after reload.
  }
}

const message = (e: unknown) => (e instanceof ActionError ? e.code : e instanceof Error ? e.message : String(e))

/** Phase 1 test panel for the sync engine. Replaced by the lobby UI. */
export function SyncCheck() {
  const [gameId, setGameId] = useState<string | null>(readStored)
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const game = useGameSync(gameId, transport)
  const [, tick] = useState(0)

  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])

  if (!transport) return null

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setErr(null)
    try {
      await fn()
    } catch (e) {
      setErr(message(e))
    } finally {
      setBusy(false)
    }
  }

  const enter = (id: string) => {
    store(id)
    setGameId(id)
  }

  const created = game.events.find((e) => e.type === 'game_created')
  const joinCode = typeof created?.payload.code === 'string' ? created.payload.code : null

  return (
    <section className="card">
      <h2>Sync check</h2>
      {!gameId ? (
        <>
          <div className="row">
            <input placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} maxLength={24} />
          </div>
          <div className="row">
            <button disabled={busy || !name.trim()} onClick={() => run(async () => enter((await createGame(transport, name)).game_id))}>
              Create game
            </button>
          </div>
          <div className="row">
            <input placeholder="Code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={4} size={6} />
            <button
              disabled={busy || !name.trim() || code.length !== 4}
              onClick={() => run(async () => enter((await joinGame(transport, code, name)).game_id))}
            >
              Join
            </button>
          </div>
        </>
      ) : (
        <>
          <p>
            <ConnectionStatus status={game.status} canAct={game.canAct} />
          </p>
          <p className="muted">
            Code {joinCode ?? '…'} · team {game.team ?? 'none'} · seq {game.lastSeq} · clock offset{' '}
            {game.clockOffsetMs} ms
          </p>
          <p className="muted">Server time {game.sync ? new Date(game.sync.serverNow()).toLocaleTimeString() : '…'}</p>
          {game.error && <p className="bad">{game.error}</p>}
          <div className="row">
            {(['hiders', 'seekers'] as const).map((team) => (
              <button
                key={team}
                disabled={busy || !game.canAct}
                onClick={() => run(() => game.sync!.action('set_team', { p_team: team }, { fresh: false }))}
              >
                {team}
              </button>
            ))}
            <button
              disabled={busy}
              onClick={() => {
                store(null)
                setGameId(null)
              }}
            >
              Leave
            </button>
          </div>
          <ul className="log">
            {[...game.events].reverse().map((e) => (
              <li key={e.seq}>
                #{e.seq} {e.type} {e.visibility !== 'all' ? `(${e.visibility})` : ''}
              </li>
            ))}
          </ul>
        </>
      )}
      {err && <p className="bad">{err}</p>}
    </section>
  )
}
