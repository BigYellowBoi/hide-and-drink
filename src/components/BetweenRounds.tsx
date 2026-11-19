import { useMemo, useState } from 'react'
import type { GameSync } from '../sync/engine'
import type { GameEvent, Team } from '../sync/types'
import type { LobbyPlayer, LobbyState } from '../lobby/state'
import { startBlockers } from '../lobby/state'
import { describeCode, describeError } from '../lobby/messages'
import { deriveRounds, formatDuration, names, sides, type RoundScore } from '../rounds/state'
import { derivePlay } from '../play/state'
import { deriveCards } from '../cards/state'
import { deriveOverrides } from '../overrides/state'
import { SlideToConfirm } from './SlideToConfirm'
import { MapsLink } from './MapsLink'
import { FixSomething } from './FixSomething'
import type { FixState } from './Round'

interface Props {
  sync: GameSync
  lobby: LobbyState
  events: readonly GameEvent[]
  userId: string | null
  canAct: boolean
  fix: FixState
  setFix: (f: FixState) => void
}

const TEAMS: { id: Team; label: string }[] = [
  { id: 'hiders', label: 'Hiders' },
  { id: 'seekers', label: 'Seekers' },
]

/** One round's score, line by line. */
export function ScoreLines({ r }: { r: RoundScore }) {
  return (
    <dl className="score-lines">
      <dt>Hide time</dt>
      <dd>{formatDuration(r.hideS)}</dd>
      {r.bonusS !== 0 && (
        <>
          <dt>Time bonuses</dt>
          <dd>+{formatDuration(r.bonusS)}</dd>
        </>
      )}
      {r.adjustS !== 0 && (
        <>
          <dt>Host fix</dt>
          <dd>{r.adjustS > 0 ? '+' : ''}{formatDuration(r.adjustS)}</dd>
        </>
      )}
      <dt className="score-total">Total</dt>
      <dd className="score-total">{formatDuration(r.totalS)}</dd>
    </dl>
  )
}

/** Totals so far: one row per side (the players who hid the same rounds). */
export function Standings({ rounds, players, winners }: { rounds: ReturnType<typeof deriveRounds>; players: LobbyPlayer[]; winners?: Set<string> }) {
  const list = sides(rounds, players.map((p) => ({ userId: p.userId, name: p.name })))
  if (!list.some((s) => s.rounds.length)) return <p className="muted">No rounds scored yet.</p>
  return (
    <ol className="standings">
      {list.map((s) => (
        <li key={s.players.map((p) => p.userId).join()} className={winners && s.players.every((p) => winners.has(p.userId)) ? 'winner' : ''}>
          <span>
            <strong>{names(s.players)}</strong>
            <span className="muted small">
              {' '}
              {s.rounds.length ? `hid round${s.rounds.length > 1 ? 's' : ''} ${s.rounds.join(', ')}` : 'hasn\'t hidden yet'}
            </span>
          </span>
          <span className="standing-time">{formatDuration(s.totalS)}</span>
        </li>
      ))}
    </ol>
  )
}

/**
 * Between rounds: how the round went, the totals so far and the teams for the next one (already
 * swapped). Nothing starts by itself: the teams talk, then the new hiders slide to start.
 */
export function BetweenRounds({ sync, lobby, events, userId, canAct, fix, setFix }: Props) {
  const rounds = useMemo(() => deriveRounds(events), [events])
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmEnd, setConfirmEnd] = useState(false)
  const roundNo = lobby.started?.round ?? 0
  const last = rounds.rounds.find((r) => r.round === roundNo) ?? null
  const me = lobby.players.find((p) => p.userId === userId) ?? null
  const isHost = !!userId && userId === lobby.hostId
  const blockers = startBlockers({ ...lobby, playAreaId: lobby.playAreaId ?? 'snapshot' })
  const hiders = lobby.players.filter((p) => p.team === 'hiders')
  const canStart = me?.team === 'hiders' || isHost
  const nameOf = (id: string | null) => lobby.players.find((p) => p.userId === id)?.name ?? 'a seeker'

  const run = async (f: () => Promise<unknown>) => {
    setBusy(true)
    setErr(null)
    try {
      await f()
    } catch (e) {
      setErr(describeError(e))
    } finally {
      setBusy(false)
    }
  }
  const move = (p: LobbyPlayer) =>
    void run(() =>
      sync.action(
        'set_team',
        { p_team: p.team === 'hiders' ? 'seekers' : 'hiders', ...(p.userId === userId ? {} : { p_user_id: p.userId }) },
        { fresh: false },
      ),
    )

  // The fix sheet reads in-round state too; between rounds only the score fixes show.
  const fixSheet = fix ? (
    <FixSomething
      sync={sync}
      lobby={lobby}
      play={derivePlay(events)}
      cards={deriveCards(events)}
      overrides={deriveOverrides(events)}
      userId={userId}
      team={me?.team ?? null}
      canAct={canAct}
      layer={null}
      rounds={rounds.rounds}
      betweenRounds
      onClose={() => setFix(false)}
    />
  ) : null

  return (
    <>
      {fixSheet}
      <section className="card round-result">
        <p className="eyebrow">Round {roundNo} over</p>
        {!last ? (
          <p className="muted">Loading the score…</p>
        ) : last.voided ? (
          <>
            <h2>Round {roundNo} will be played again</h2>
            <p className="muted">The host redid it: it doesn't count. {names(last.hiders)} hide again.</p>
          </>
        ) : (
          <>
            <h2>
              {names(last.hiders)} hid for {formatDuration(last.totalS)}
            </h2>
            <p className="muted small">Found by {nameOf(last.foundBy)}.</p>
            {rounds.lastBar?.round === roundNo && (
              <p>
                They were at <strong>{rounds.lastBar.name}</strong>. <MapsLink point={[rounds.lastBar.lng, rounds.lastBar.lat]} inline />
              </p>
            )}
            <ScoreLines r={last} />
          </>
        )}
      </section>

      <section className="card">
        <h2>Standings</h2>
        <Standings rounds={rounds} players={lobby.players} />
      </section>

      <section className="card">
        <h2>Round {roundNo + 1} teams</h2>
        <p className="muted small-note team-hint">
          Roles have swapped. {isHost ? 'Tap a name to move them.' : 'Tap your name to switch team.'}
        </p>
        <div className="team-lists">
          {TEAMS.map((t) => {
            const list = lobby.players.filter((p) => p.team === t.id)
            return (
              <div key={t.id} className={`team-col team-${t.id}`}>
                <h3>
                  {t.label} <span className="muted">{list.length}</span>
                </h3>
                <ul>
                  {list.map((p) => (
                    <li key={p.userId} className="player-row">
                      {isHost || p.userId === userId ? (
                        <button
                          className={`player player-tap${p.userId === userId ? ' player-me' : ''}`}
                          disabled={!canAct || busy}
                          aria-label={`${p.name}: move to ${p.team === 'hiders' ? 'Seekers' : 'Hiders'}`}
                          onClick={() => move(p)}
                        >
                          <span className="player-name">{p.name}</span>
                          {p.userId === userId && <span className="badge you">you</span>}
                        </button>
                      ) : (
                        <span className="player">
                          <span className="player-name">{p.name}</span>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </div>
      </section>

      <section className="card">
        {canStart ? (
          <>
            <h2>Ready to hide?</h2>
            <p className="muted">
              Talk it over first. Slide when {me?.team === 'hiders' ? 'your team is' : 'the hiders are'} ready to go: the hiding clock starts for
              everyone.
            </p>
            {blockers.length > 0 && (
              <ul className="checklist">
                {blockers.map((b) => (
                  <li key={b}>{describeCode(b)}</li>
                ))}
              </ul>
            )}
            <SlideToConfirm
              label={busy ? 'Starting…' : `Slide to start round ${roundNo + 1}`}
              disabled={!canAct || busy || blockers.length > 0}
              onConfirm={() => void run(() => sync.action('start_next_round'))}
            />
          </>
        ) : (
          <p className="muted">
            Waiting for {names(hiders.map((p) => ({ userId: p.userId, name: p.name })))} to start round {roundNo + 1}.
          </p>
        )}
        {err && (
          <p className="bad" role="alert">
            {err}
          </p>
        )}
      </section>

      {isHost && (
        <section className="card">
          <h2>Finish</h2>
          <p className="muted small-note">Ends the game for everyone and shows who won.</p>
          <button
            className={`wide secondary${confirmEnd ? ' danger' : ''}`}
            disabled={!canAct || busy}
            onClick={() => (confirmEnd ? void run(() => sync.action('end_game')) : setConfirmEnd(true))}
            onBlur={() => setConfirmEnd(false)}
          >
            {confirmEnd ? 'Tap again to end the game' : 'End game'}
          </button>
        </section>
      )}
    </>
  )
}
