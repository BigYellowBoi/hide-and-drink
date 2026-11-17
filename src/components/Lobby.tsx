import { useEffect, useState } from 'react'
import type { GameSync } from '../sync/engine'
import type { Team } from '../sync/types'
import { supabase } from '../lib/supabase'
import { listPlayAreas, type PlayAreaSummary } from '../lobby/playAreas'
import { describeCode, describeError } from '../lobby/messages'
import { startBlockers, type LobbyPlayer, type LobbyState } from '../lobby/state'
import { ConfigEditor } from './ConfigEditor'
import { JoinCode } from './JoinCode'

const TEAMS: { id: Team; label: string }[] = [
  { id: 'hiders', label: 'Hiders' },
  { id: 'seekers', label: 'Seekers' },
]
const other = (t: Team): Team => (t === 'hiders' ? 'seekers' : 'hiders')

interface Props {
  sync: GameSync
  lobby: LobbyState
  userId: string | null
  canAct: boolean
}

export function Lobby({ sync, lobby, userId, canAct }: Props) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [areas, setAreas] = useState<PlayAreaSummary[] | null>(null)
  const [confirmStart, setConfirmStart] = useState(false)

  const isHost = userId !== null && userId === lobby.hostId
  const me = lobby.players.find((p) => p.userId === userId)
  const blockers = startBlockers(lobby)
  const disabled = busy || !canAct

  useEffect(() => {
    if (!isHost || !supabase || areas || !canAct) return
    listPlayAreas(supabase, lobby.city)
      .then(setAreas)
      .catch((e: unknown) => setErr(describeError(e)))
  }, [isHost, lobby.city, areas, canAct])

  useEffect(() => {
    if (!confirmStart) return
    const t = setTimeout(() => setConfirmStart(false), 4000)
    return () => clearTimeout(t)
  }, [confirmStart])

  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true)
    setErr(null)
    try {
      await fn()
      return true
    } catch (e) {
      setErr(describeError(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  const setTeam = (team: Team, target?: LobbyPlayer) =>
    run(() =>
      sync.action('set_team', target ? { p_team: team, p_user_id: target.userId } : { p_team: team }, { fresh: false }),
    )

  const unassigned = lobby.players.filter((p) => !p.team)

  const renderPlayer = (p: LobbyPlayer) => (
    <li key={p.userId} className="player">
      <span className="player-name">
        {p.name}
        {p.isHost && <span className="badge">host</span>}
        {p.userId === userId && <span className="badge you">you</span>}
      </span>
      {isHost && (
        <span className="player-moves">
          {(p.team ? [other(p.team)] : TEAMS.map((t) => t.id)).map((t) => (
            <button key={t} className="small secondary" disabled={disabled} onClick={() => setTeam(t, p)}>
              → {t === 'hiders' ? 'Hiders' : 'Seekers'}
            </button>
          ))}
        </span>
      )}
    </li>
  )

  return (
    <>
      {lobby.code && <JoinCode code={lobby.code} />}

      <section className="card">
        <h2>Your team</h2>
        <div className="team-picker">
          {TEAMS.map((t) => (
            <button
              key={t.id}
              className={`team-btn team-${t.id}${me?.team === t.id ? ' selected' : ''}`}
              aria-pressed={me?.team === t.id}
              disabled={disabled || me?.team === t.id}
              onClick={() => setTeam(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>Players ({lobby.players.length})</h2>
        {TEAMS.map((t) => {
          const list = lobby.players.filter((p) => p.team === t.id)
          return (
            <div key={t.id} className={`team-list team-${t.id}`}>
              <h3>
                {t.label} <span className="muted">{list.length}</span>
              </h3>
              {list.length ? <ul>{list.map(renderPlayer)}</ul> : <p className="muted">Nobody yet</p>}
            </div>
          )
        })}
        {unassigned.length > 0 && (
          <div className="team-list">
            <h3>
              No team <span className="muted">{unassigned.length}</span>
            </h3>
            <ul>{unassigned.map(renderPlayer)}</ul>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Play area</h2>
        {isHost ? (
          <label className="field">
            <span>Saved areas ({lobby.city})</span>
            <select
              value={lobby.playAreaId ?? ''}
              disabled={disabled || !areas}
              onChange={(e) =>
                run(() => sync.action('set_play_area', { p_play_area_id: e.target.value || null }))
              }
            >
              <option value="">{areas ? 'Choose a play area' : 'Loading…'}</option>
              {areas?.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p>{lobby.playAreaName ?? <span className="muted">Host hasn't chosen yet</span>}</p>
        )}
      </section>

      <details className="card">
        <summary>
          <h2>Game settings</h2>
        </summary>
        <ConfigEditor
          config={lobby.config}
          editable={isHost}
          busy={disabled}
          onSave={(config) => run(() => sync.action('update_config', { p_config: config }))}
        />
      </details>

      <section className="card">
        {isHost ? (
          <>
            <h2>Start</h2>
            {blockers.length > 0 ? (
              <ul className="checklist">
                {blockers.map((b) => (
                  <li key={b}>{describeCode(b)}</li>
                ))}
              </ul>
            ) : (
              <p className="muted">Teams, settings and play area lock when you start.</p>
            )}
            <button
              className={`wide${confirmStart ? ' danger' : ''}`}
              disabled={disabled || blockers.length > 0}
              onClick={() => {
                if (!confirmStart) return setConfirmStart(true)
                setConfirmStart(false)
                void run(() => sync.action('start_game'))
              }}
            >
              {confirmStart ? 'Tap again to lock and start' : 'Lock and start'}
            </button>
          </>
        ) : (
          <p className="muted">Waiting for the host to start.</p>
        )}
      </section>

      {err && (
        <p className="bad sticky-error" role="alert">
          {err}
        </p>
      )}
    </>
  )
}
