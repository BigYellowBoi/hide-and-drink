import { useEffect, useState } from 'react'
import type { GameSync } from '../sync/engine'
import type { Team } from '../sync/types'
import { supabase } from '../lib/supabase'
import { listPlayAreas, type PlayAreaSummary } from '../lobby/playAreas'
import { describeCode, describeError } from '../lobby/messages'
import { startBlockers, type LobbyPlayer, type LobbyState } from '../lobby/state'
import { ConfigEditor } from './ConfigEditor'
import { JoinCode } from './JoinCode'
import type { Presence } from '../sync/presence'
import { PresenceDot } from './PresenceDot'
import { SlideToConfirm } from './SlideToConfirm'

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
  presence: (userId: string) => Presence
}

export function Lobby({ sync, lobby, userId, canAct, presence }: Props) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [areas, setAreas] = useState<PlayAreaSummary[] | null>(null)
  /** Player whose remove button has been tapped once (tap again to confirm). */
  const [removing, setRemoving] = useState<string | null>(null)

  const isHost = userId !== null && userId === lobby.hostId
  const me = lobby.players.find((p) => p.userId === userId)
  const blockers = startBlockers(lobby)
  const disabled = busy || !canAct

  // Disarm after a few seconds (iOS doesn't blur buttons, so onBlur alone isn't enough).
  useEffect(() => {
    if (!removing) return
    const t = setTimeout(() => setRemoving(null), 3000)
    return () => clearTimeout(t)
  }, [removing])

  useEffect(() => {
    if (!isHost || !supabase || areas || !canAct) return
    listPlayAreas(supabase, lobby.city)
      .then(setAreas)
      .catch((e: unknown) => setErr(describeError(e)))
  }, [isHost, lobby.city, areas, canAct])

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

  const canRemove = (p: LobbyPlayer) => isHost && !p.isHost
  const removeButton = (p: LobbyPlayer) => {
    const armed = removing === p.userId
    return (
      <button
        className={`small secondary player-remove${armed ? ' danger' : ''}`}
        disabled={disabled}
        aria-label={armed ? `Tap again to remove ${p.name}` : `Remove ${p.name}`}
        onClick={() => {
          if (!armed) return setRemoving(p.userId)
          setRemoving(null)
          void run(() => sync.action('remove_player', { p_user_id: p.userId }))
        }}
        onBlur={() => armed && setRemoving(null)}
      >
        {armed ? 'Remove?' : '✕'}
      </button>
    )
  }

  /** Tap a name to move that player to the other team: your own name, or anyone's if you host. */
  const canMove = (p: LobbyPlayer) => p.userId === userId || isHost
  const move = (p: LobbyPlayer, team: Team) => setTeam(team, p.userId === userId ? undefined : p)

  const nameContent = (p: LobbyPlayer) => (
    <>
      <PresenceDot online={presence(p.userId)} />
      <span className="player-name">{p.name}</span>
      {(p.isHost || p.userId === userId) && (
        <span className="player-badges">
          {p.userId === userId && <span className="badge you">you</span>}
          {p.isHost && <span className="badge">host</span>}
        </span>
      )}
    </>
  )

  const renderMember = (p: LobbyPlayer) => (
    <li key={p.userId} className="player-row">
      {canMove(p) && p.team ? (
        <button
          className={`player player-tap${p.userId === userId ? ' player-me' : ''}`}
          disabled={disabled}
          aria-label={`${p.name}: move to ${p.team === 'hiders' ? 'Seekers' : 'Hiders'}`}
          onClick={() => move(p, other(p.team!))}
        >
          {nameContent(p)}
        </button>
      ) : (
        <span className="player">{nameContent(p)}</span>
      )}
      {canRemove(p) && removeButton(p)}
    </li>
  )

  return (
    <>
      {lobby.code && <JoinCode code={lobby.code} />}

      <section className="card">
        <h2>Teams</h2>
        <p className="muted small-note team-hint">
          {isHost ? 'Tap a name to switch their team, ✕ to remove them.' : 'Tap your name to switch team.'}
        </p>
        <div className="team-lists">
          {TEAMS.map((t) => {
            const list = lobby.players.filter((p) => p.team === t.id)
            return (
              <div key={t.id} className={`team-col team-${t.id}`}>
                <h3>
                  {t.label} <span className="muted">{list.length}</span>
                </h3>
                <ul>{list.map(renderMember)}</ul>
                {me?.team !== t.id && (
                  <button className="small secondary team-join" disabled={disabled} onClick={() => setTeam(t.id)}>
                    Join {t.label}
                  </button>
                )}
              </div>
            )
          })}
        </div>
        {unassigned.length > 0 && (
          <div className="team-unassigned">
            <h3>
              No team <span className="muted">{unassigned.length}</span>
            </h3>
            <ul>
              {unassigned.map((p) => (
                <li key={p.userId} className="player">
                  <span className="player-who">{nameContent(p)}</span>
                  {isHost && p.userId !== userId && (
                    <span className="player-moves">
                      {canRemove(p) && removeButton(p)}
                      {TEAMS.map((t) => (
                        <button
                          key={t.id}
                          className="small secondary"
                          disabled={disabled}
                          onClick={() => move(p, t.id)}
                        >
                          → {t.label}
                        </button>
                      ))}
                    </span>
                  )}
                </li>
              ))}
            </ul>
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
            <SlideToConfirm
              label="Slide to lock and start"
              disabled={disabled || blockers.length > 0}
              onConfirm={() => void run(() => sync.action('start_game'))}
            />
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
