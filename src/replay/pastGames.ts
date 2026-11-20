import type { PastGame } from './api'

const list = (ns: string[]) => ns.join(', ') || 'nobody'

/** "Amy, Bo" vs "Sam, Cy": the first round's teams (they swap each round), else the players' teams. */
export function gameTeams(g: PastGame): { hiders: string; seekers: string } {
  const first = g.rounds[0]
  if (first) return { hiders: list(first.hiders.map((p) => p.name)), seekers: list(first.seekers.map((p) => p.name)) }
  return {
    hiders: list(g.players.filter((p) => p.team === 'hiders').map((p) => p.name)),
    seekers: list(g.players.filter((p) => p.team === 'seekers').map((p) => p.name)),
  }
}

/** The winner(s) and their total time hidden, or null (no round was scored). */
export function gameWinner(g: PastGame): { names: string; totalS: number } | null {
  if (!g.winners.length) return null
  const won = g.totals.filter((t) => g.winners.includes(t.user_id))
  if (!won.length) return null
  return { names: won.map((t) => t.name).join(' and '), totalS: won[0].total_s }
}

/** "Playtest · deleted Fri 3:15 pm", "Playtest" (kept: it has media), or null for a real game. */
export function playtestLabel(g: PastGame): string | null {
  if (!g.playtest) return null
  if (!g.expires_at) return 'Playtest'
  const at = new Date(g.expires_at).toLocaleString('en-AU', { weekday: 'short', hour: 'numeric', minute: '2-digit' })
  return `Playtest · deleted ${at}`
}

const gb = (b: number) => b / 1e9

/** "1.2 GB of 10 GB used (12%)" */
export function storageLabel(bytes: number, freeBytes: number): string {
  const used = gb(bytes)
  const shown = used < 0.1 ? `${Math.round(bytes / 1e6)} MB` : `${used.toFixed(used < 10 ? 1 : 0)} GB`
  return `${shown} of ${+gb(freeBytes).toFixed(1)} GB free tier used (${Math.round((100 * bytes) / freeBytes)}%)`
}
