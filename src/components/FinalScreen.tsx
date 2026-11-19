import { useMemo } from 'react'
import type { GameEvent } from '../sync/types'
import type { LobbyState } from '../lobby/state'
import { deriveRounds, formatDuration, names, sides } from '../rounds/state'
import { Standings } from './BetweenRounds'

/** The game is over: winner, totals and every round. The game can't be joined any more. */
export function FinalScreen({ lobby, events, onHome }: { lobby: LobbyState; events: readonly GameEvent[]; onHome: () => void }) {
  const rounds = useMemo(() => deriveRounds(events), [events])
  const result = rounds.result
  const winners = useMemo(() => new Set(result?.winners ?? []), [result])
  const everyone = lobby.players.map((p) => ({ userId: p.userId, name: p.name }))
  const winning = sides(rounds, everyone).filter((s) => s.players.some((p) => winners.has(p.userId)))
  const winnerNames = names(
    [...winners].map((id) => ({ userId: id, name: lobby.players.find((p) => p.userId === id)?.name ?? rounds.rounds.flatMap((r) => r.hiders).find((h) => h.userId === id)?.name ?? 'Player' })),
  )

  return (
    <>
      <section className="card final-hero">
        <p className="eyebrow">Game over</p>
        {!result || winners.size === 0 ? (
          <h2>No winner</h2>
        ) : (
          <>
            <h2>
              {winnerNames} {winning.length > 1 ? 'tie' : winners.size > 1 ? 'win' : 'wins'}
            </h2>
            {winning[0] && <p className="final-time">{formatDuration(winning[0].totalS)}</p>}
          </>
        )}
        {result && winners.size === 0 && <p className="muted">No round was finished.</p>}
        {result?.reason === 'inactive' && <p className="muted small">Ended automatically after a day with no activity.</p>}
        {result?.unfinishedRound != null && (
          <p className="muted small">Round {result.unfinishedRound} was still running and doesn't count.</p>
        )}
      </section>

      <section className="card">
        <h2>Totals</h2>
        <Standings rounds={rounds} players={lobby.players} winners={winners} />
      </section>

      {rounds.rounds.length > 0 && (
        <section className="card">
          <h2>Rounds</h2>
          <ol className="round-list">
            {rounds.rounds.map((r) => (
              <li key={r.round} className={r.voided ? 'voided' : ''}>
                <span>
                  <strong>Round {r.round}</strong> · {names(r.hiders)}
                  {r.barName && <span className="muted small"> at {r.barName}</span>}
                  {r.voided && <span className="muted small"> (redone, doesn't count)</span>}
                  {!r.voided && (r.bonusS !== 0 || r.adjustS !== 0) && (
                    <span className="muted small">
                      {' '}
                      ({formatDuration(r.hideS)}
                      {r.bonusS ? ` + ${formatDuration(r.bonusS)} bonus` : ''}
                      {r.adjustS ? ` ${r.adjustS > 0 ? '+' : ''}${formatDuration(r.adjustS)} host fix` : ''})
                    </span>
                  )}
                </span>
                <span className="standing-time">{r.voided ? '–' : formatDuration(r.totalS)}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <button className="wide" onClick={onHome}>
        Back to home
      </button>
    </>
  )
}
