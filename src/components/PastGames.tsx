import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { SyncTransport } from '../sync/transport'
import { describeError } from '../lobby/messages'
import { formatDuration } from '../rounds/state'
import { deleteGame, fetchMediaUsage, fetchReplay, listPastGames, type PastGame, type ReplayData } from '../replay/api'
import { downloadGameZip, type DownloadProgress } from '../replay/download'
import { gameTeams, gameWinner, storageLabel } from '../replay/pastGames'

/** Download one game as a zip (events, summary, every photo and video). */
export function DownloadButton({ gameId, data, small = false }: { gameId: string; data?: ReplayData; small?: boolean }) {
  const [progress, setProgress] = useState<DownloadProgress | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const run = async () => {
    if (!supabase) return
    setErr(null)
    setProgress({ done: 0, total: 0 })
    try {
      await downloadGameZip(supabase, data ?? (await fetchReplay(supabase, gameId)), setProgress)
    } catch (e) {
      setErr(describeError(e))
    } finally {
      setProgress(null)
    }
  }
  return (
    <>
      <button className={`secondary${small ? ' small' : ''}`} disabled={!!progress} onClick={() => void run()}>
        {progress ? (progress.total ? `Downloading ${progress.done}/${progress.total}…` : 'Preparing…') : 'Download'}
      </button>
      {err && (
        <span className="bad small" role="alert">
          {err}
        </span>
      )}
    </>
  )
}

/**
 * Home: ended games this player took part in (admins: every ended game), newest first, with
 * R2 storage used above. Tap a game for its replay; Download; Delete for the host or an admin.
 */
export function PastGames({ transport, onOpen }: { transport: SyncTransport; onOpen: (gameId: string) => void }) {
  const [games, setGames] = useState<PastGame[] | null>(null)
  const [usage, setUsage] = useState<{ r2_bytes: number; r2_free_bytes: number } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    if (!supabase) return
    const client = supabase
    let live = true
    transport
      .signIn()
      .then(() => Promise.all([listPastGames(client), fetchMediaUsage(client).catch(() => null)]))
      .then(([g, u]) => {
        if (!live) return
        setGames(g)
        setUsage(u)
      })
      .catch((e: unknown) => live && setErr(describeError(e)))
    return () => {
      live = false
    }
  }, [transport])

  const remove = async (id: string) => {
    if (!supabase) return
    setBusy(id)
    setErr(null)
    try {
      await deleteGame(supabase, id)
      setGames((list) => list?.filter((g) => g.id !== id) ?? null)
      setConfirm(null)
      fetchMediaUsage(supabase).then(setUsage, () => {})
    } catch (e) {
      setErr(describeError(e))
    } finally {
      setBusy(null)
    }
  }

  if (!games?.length && !err) return null

  return (
    <section className="card past-games">
      <h2>Past games</h2>
      {usage && (
        <div className="storage-meter">
          <p className="muted small">Photos and videos: {storageLabel(usage.r2_bytes, usage.r2_free_bytes)}</p>
          <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={usage.r2_free_bytes} aria-valuenow={usage.r2_bytes}>
            <span style={{ width: `${Math.min(100, (100 * usage.r2_bytes) / usage.r2_free_bytes)}%` }} />
          </div>
        </div>
      )}
      {err && <p className="bad small">{err}</p>}
      <ul className="past-list">
        {(games ?? []).map((g) => {
          const teams = gameTeams(g)
          const winner = gameWinner(g)
          return (
            <li key={g.id} className="past-row">
              <button className="past-main" onClick={() => onOpen(g.id)}>
                <span className="past-title">
                  {new Date(g.started_at ?? g.ended_at).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
                  {g.play_area ? ` · ${g.play_area}` : ''}
                </span>
                <span className="muted small">
                  {teams.hiders} <span className="past-vs">vs</span> {teams.seekers}
                </span>
                <span className="small">{winner ? `Winner: ${winner.names} · ${formatDuration(winner.totalS)}` : 'No winner'}</span>
              </button>
              <div className="row past-actions">
                <DownloadButton gameId={g.id} small />
                {g.can_delete && (
                  <button className="small secondary" disabled={busy === g.id} onClick={() => setConfirm(confirm === g.id ? null : g.id)}>
                    Delete
                  </button>
                )}
              </div>
              {confirm === g.id && (
                <div className="past-confirm" role="alertdialog" aria-label="Delete this game">
                  <p className="small">
                    Delete this game for everyone? Its events, paths, photos and videos are gone for good. <strong>Download it first</strong> if you
                    want a copy.
                  </p>
                  <div className="row">
                    <button className="small secondary" onClick={() => setConfirm(null)}>
                      Cancel
                    </button>
                    <button className="small danger" disabled={busy === g.id} onClick={() => void remove(g.id)}>
                      {busy === g.id ? 'Deleting…' : 'Delete for everyone'}
                    </button>
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
