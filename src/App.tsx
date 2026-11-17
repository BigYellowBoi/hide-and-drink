import { useMemo, useState } from 'react'
import { supabase } from './lib/supabase'
import { GAME_KEY, readLocal, writeLocal } from './lib/storage'
import { deriveLobby } from './lobby/state'
import { describeCode } from './lobby/messages'
import { supabaseTransport } from './sync/supabaseTransport'
import type { SyncTransport } from './sync/transport'
import { useGameSync } from './sync/useGameSync'
import { ConnectionStatus } from './components/ConnectionStatus'
import { Home } from './components/Home'
import { Lobby } from './components/Lobby'
import { Started } from './components/Started'
import { StaleBanner } from './components/StaleBanner'
import { presenceOf } from './sync/presence'

const transport = supabase ? supabaseTransport(supabase) : null

function GameScreen({ gameId, transport, onLeave }: { gameId: string; transport: SyncTransport; onLeave: () => void }) {
  const game = useGameSync(gameId, transport)
  const lobby = useMemo(() => deriveLobby(game.events), [game.events])
  const [confirmLeave, setConfirmLeave] = useState(false)
  const presence = useMemo(() => presenceOf(game.present, game.status === 'live'), [game.present, game.status])
  const locked = !game.canAct && game.status !== 'idle' && game.status !== 'error'

  return (
    <>
      <header className="topbar">
        <h1>Hide + Drink</h1>
        <ConnectionStatus status={game.status} canAct={game.canAct} />
      </header>

      <StaleBanner status={game.status} staleSince={game.staleSince} />

      {/* Locked: nothing on the game screen can be tapped until this phone is caught up. */}
      <div className={`game-body${locked ? ` locked lock-${game.status}` : ''}`} inert={locked}>
        {game.status === 'error' ? (
          <p className="bad">{describeCode(game.error ?? 'error')}</p>
        ) : !game.sync || !lobby.code ? (
          <p className="muted">Loading game…</p>
        ) : lobby.status === 'lobby' ? (
          <Lobby sync={game.sync} lobby={lobby} userId={game.userId} canAct={game.canAct} presence={presence} />
        ) : (
          <Started sync={game.sync} lobby={lobby} userId={game.userId} presence={presence} />
        )}
      </div>

      <div className="row footer-actions">
        <button
          className={`secondary${confirmLeave ? ' danger' : ''}`}
          onClick={() => (confirmLeave ? onLeave() : setConfirmLeave(true))}
          onBlur={() => setConfirmLeave(false)}
        >
          {confirmLeave ? 'Tap again to leave' : 'Leave game'}
        </button>
      </div>

      <details className="debug">
        <summary>Event log</summary>
        <p className="muted">
          seq {game.lastSeq} · team {game.team ?? 'none'} · clock offset {game.clockOffsetMs} ms
        </p>
        <ul className="log">
          {[...game.events].reverse().map((e) => (
            <li key={e.seq}>
              #{e.seq} {e.type} {e.visibility !== 'all' ? `(${e.visibility})` : ''}
            </li>
          ))}
        </ul>
      </details>
    </>
  )
}

export default function App() {
  const [gameId, setGameId] = useState<string | null>(() => readLocal(GAME_KEY))

  const enter = (id: string | null) => {
    writeLocal(GAME_KEY, id)
    setGameId(id)
  }

  return (
    <main className="shell">
      {!transport ? (
        <>
          <h1>Hide + Drink</h1>
          <p className="bad">Backend not configured (see .env.example).</p>
        </>
      ) : gameId ? (
        <GameScreen key={gameId} gameId={gameId} transport={transport} onLeave={() => enter(null)} />
      ) : (
        <>
          <header className="topbar">
            <h1>Hide + Drink</h1>
          </header>
          <Home transport={transport} onEnter={enter} />
        </>
      )}
      <p className="muted small">Build {import.meta.env.VITE_BUILD_SHA?.slice(0, 7) ?? 'local'}</p>
    </main>
  )
}
