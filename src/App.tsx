import { useEffect, useMemo, useState } from 'react'
import { supabase } from './lib/supabase'
import { GAME_KEY, LAST_CODE_KEY, NAME_KEY, readLocal, writeLocal } from './lib/storage'
import { joinGame } from './sync/actions'
import { deriveLobby } from './lobby/state'
import { describeCode, describeError } from './lobby/messages'
import { supabaseTransport } from './sync/supabaseTransport'
import type { SyncTransport } from './sync/transport'
import { useGameSync } from './sync/useGameSync'
import { deriveCards, handBonusS } from './cards/state'
import { ConnectionStatus } from './components/ConnectionStatus'
import { Home } from './components/Home'
import { Settings } from './components/Settings'
import { Lobby } from './components/Lobby'
import { Round, TopbarClock, type FixState } from './components/Round'
import { BetweenRounds } from './components/BetweenRounds'
import { FinalScreen } from './components/FinalScreen'
import { StaleBanner } from './components/StaleBanner'
import { presenceOf } from './sync/presence'
import { isDevMode } from './hiding/devPosition'
import { PlaytestTools } from './components/PlaytestTools'
import { effectiveEvents } from './overrides/state'
import { buildLabel } from './lib/version'

const transport = supabase ? supabaseTransport(supabase) : null
const asset = (f: string) => `${import.meta.env.BASE_URL}${f}`
const TEAM_CHIP = { hiders: 'Hider', seekers: 'Seeker' } as const

function GameScreen({
  gameId,
  transport,
  onLeave,
  onRejoin,
}: {
  gameId: string
  transport: SyncTransport
  onLeave: () => void
  onRejoin: (gameId: string) => void
}) {
  const game = useGameSync(gameId, transport)
  // Undone host overrides drop out here, so every screen derives state without them.
  const events = useMemo(() => effectiveEvents(game.events), [game.events])
  const lobby = useMemo(() => deriveLobby(events), [events])
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [fix, setFix] = useState<FixState>(false)
  const [rejoin, setRejoin] = useState<{ busy: boolean; err: string | null }>({ busy: false, err: null })

  // Remember this game's code: if the phone ever loses its player session, it can rejoin.
  useEffect(() => {
    if (lobby.code) writeLocal(LAST_CODE_KEY, lobby.code)
  }, [lobby.code])
  const savedCode = readLocal(LAST_CODE_KEY)
  const savedName = readLocal(NAME_KEY)
  const canRejoin = game.status === 'error' && game.error === 'not_a_player' && !!savedCode && !!savedName
  const doRejoin = async () => {
    if (!savedCode || !savedName) return
    setRejoin({ busy: true, err: null })
    try {
      const res = await joinGame(transport, savedCode, savedName)
      onRejoin(res.game_id)
    } catch (e) {
      setRejoin({ busy: false, err: describeError(e) })
    }
  }

  // In a lobby, leaving removes you on the server too (the last one out deletes the lobby).
  // A running game has locked teams, so there it only forgets the game on this phone. If the
  // server call fails (offline), leave anyway: the 24 h sweep clears abandoned lobbies.
  const leave = async () => {
    if (game.sync && game.canAct && lobby.status === 'lobby') {
      await game.sync.action('leave_game', {}, { fresh: false }).catch(() => {})
    }
    onLeave()
  }
  const presence = useMemo(() => presenceOf(game.present, game.status === 'live'), [game.present, game.status])
  const locked = !game.canAct && game.status !== 'idle' && game.status !== 'error'
  const myTeam = lobby.players.find((p) => p.userId === game.userId)?.team ?? null
  // Hider-only events: on seekers' phones the hand is always empty.
  // Fix something: in a running game, for the host and anyone on a team; between rounds, the
  // host's score fixes; never once the game is over.
  const isHost = !!game.userId && game.userId === lobby.hostId
  const running = lobby.status === 'hiding' || lobby.status === 'seeking'
  const canFix = !!lobby.started && ((running && (myTeam !== null || isHost)) || (lobby.status === 'round_over' && isHost))
  const ended = lobby.status === 'ended'
  const bonusS = useMemo(() => handBonusS(deriveCards(events)), [events])

  return (
    <>
      {/* Top bar: team chip left, screen label centre, status dot right (docs/design.md). */}
      <header className="topbar">
        <span className={`chip chip-${myTeam ?? 'none'}`}>{myTeam ? TEAM_CHIP[myTeam] : 'No team'}</span>
        <span className="topbar-centre">
          {running && lobby.started && game.sync ? (
            <TopbarClock sync={game.sync} started={lobby.started} bonusS={myTeam === 'hiders' ? bonusS : 0} />
          ) : (
            <span className="topbar-label">
              {!lobby.code ? '' : ended ? 'Game over' : lobby.status === 'round_over' ? `Round ${lobby.started?.round ?? ''} over` : 'Lobby'}
            </span>
          )}
          {/* Always on show, so anyone who drops out can rejoin with it (an ended game can't be joined). */}
          {lobby.code && !ended && <span className="topbar-code">Code {lobby.code}</span>}
        </span>
        <ConnectionStatus status={game.status} canAct={game.canAct} />
      </header>

      <StaleBanner status={game.status} staleSince={game.staleSince} />

      {isDevMode(lobby.config) && (
        <div className="dev-banner" role="status">
          <strong>Playtest mode</strong>
          <span>GPS is off: long-press the map to set your position.</span>
          {game.sync && <PlaytestTools sync={game.sync} status={lobby.status} team={myTeam} canAct={game.canAct} />}
        </div>
      )}

      {/* Locked: nothing on the game screen can be tapped until this phone is caught up. */}
      <div className={`game-body${locked ? ` locked lock-${game.status}` : ''}`} inert={locked}>
        {game.status === 'error' ? (
          <>
            <p className="bad">{describeCode(game.error ?? 'error')}</p>
            {canRejoin && (
              <>
                <button className="wide" disabled={rejoin.busy} onClick={() => void doRejoin()}>
                  {rejoin.busy ? 'Rejoining…' : `Rejoin ${savedCode} as ${savedName}`}
                </button>
                {rejoin.err && <p className="bad">{rejoin.err}</p>}
              </>
            )}
          </>
        ) : !game.sync || !lobby.code ? (
          <p className="muted">Loading game…</p>
        ) : lobby.status === 'lobby' ? (
          <Lobby sync={game.sync} transport={transport} lobby={lobby} userId={game.userId} canAct={game.canAct} presence={presence} />
        ) : ended ? (
          <FinalScreen lobby={lobby} events={events} onHome={onLeave} />
        ) : lobby.status === 'round_over' ? (
          <BetweenRounds sync={game.sync} lobby={lobby} events={events} userId={game.userId} canAct={game.canAct} fix={fix} setFix={setFix} />
        ) : (
          <Round
            sync={game.sync}
            lobby={lobby}
            userId={game.userId}
            canAct={game.canAct}
            events={events}
            positions={game.positions}
            presence={presence}
            transport={transport}
            fix={fix}
            setFix={setFix}
          />
        )}
      </div>

      {!ended && <div className={`row footer-actions${canFix ? ' footer-split' : ''}`}>
        <button
          className={`secondary${confirmLeave ? ' danger' : ''}`}
          onClick={() => (confirmLeave ? void leave() : setConfirmLeave(true))}
          onBlur={() => setConfirmLeave(false)}
        >
          {confirmLeave ? 'Tap again to leave' : 'Leave game'}
        </button>
        {canFix && (
          <button className="secondary" disabled={!game.canAct} onClick={() => setFix(true)}>
            Fix something
          </button>
        )}
      </div>}

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
  const [settings, setSettings] = useState(false)

  const [attempt, setAttempt] = useState(0)

  const enter = (id: string | null) => {
    writeLocal(GAME_KEY, id)
    setGameId(id)
  }

  return (
    <div className="scroll">
      <main className="shell">
        {!transport ? (
          <>
            <div className="hero">
              <img className="wordmark" src={asset('wordmark.svg')} alt="Hide + Drink" width={240} height={35} />
            </div>
            <p className="bad">Backend not configured (see .env.example).</p>
          </>
        ) : gameId ? (
          <GameScreen
            key={`${gameId}:${attempt}`}
            gameId={gameId}
            transport={transport}
            onLeave={() => enter(null)}
            onRejoin={(id) => {
              enter(id)
              setAttempt((n) => n + 1)
            }}
          />
        ) : settings ? (
          <Settings transport={transport} onBack={() => setSettings(false)} />
        ) : (
          <Home transport={transport} onEnter={enter} onSettings={() => setSettings(true)} />
        )}
        <p className="muted small app-version">{buildLabel()}</p>
      </main>
    </div>
  )
}
