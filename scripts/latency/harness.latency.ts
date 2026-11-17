/**
 * Latency harness: 6-10 simulated players on one game, each running the app's real sync
 * engine (GameSync + supabaseTransport) with its own anonymous user and socket.
 *
 * Measures send-to-receive: from the moment a player starts an action until each phone
 * (sender included) has applied the resulting event in order. Fails if p95 > the limit,
 * if any broadcast never arrives, or if presence doesn't show everyone online.
 *
 * Run: npm run latency (env below). CI runs it against the local Supabase stack.
 *   SUPABASE_URL, SUPABASE_ANON_KEY  (or VITE_ prefixed)
 *   LATENCY_PLAYERS=8  LATENCY_ROUNDS=40  LATENCY_BURSTS=5  LATENCY_P95_MS=1000
 *   LATENCY_REPORT=path.json  (optional; also writes $GITHUB_STEP_SUMMARY when set)
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { appendFileSync, writeFileSync } from 'node:fs'
import { afterAll, expect, it } from 'vitest'
import { callWithRetry, createGame, joinGame } from '../../src/sync/actions'
import { GameSync } from '../../src/sync/engine'
import { supabaseTransport } from '../../src/sync/supabaseTransport'
import type { Team } from '../../src/sync/types'
import { failures, summarise, type Summary } from './stats.ts'

const env = (k: string) => process.env[k] ?? process.env[`VITE_${k}`]
const num = (k: string, d: number) => (process.env[k] ? Number(process.env[k]) : d)

const URL_ = env('SUPABASE_URL')
const KEY = env('SUPABASE_ANON_KEY')
const PLAYERS = num('LATENCY_PLAYERS', 8)
const ROUNDS = num('LATENCY_ROUNDS', 40)
const BURSTS = num('LATENCY_BURSTS', 5)
const P95_MS = num('LATENCY_P95_MS', 1000)
const ARRIVAL_TIMEOUT_MS = 5000

interface Player {
  name: string
  team: Team
  isHost: boolean
  client: SupabaseClient
  sync: GameSync
  userId: string
  /** seq -> performance.now() when this phone applied it. */
  appliedAt: Map<number, number>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(what: string, cond: () => boolean, timeoutMs = 15_000): Promise<number> {
  const start = performance.now()
  while (!cond()) {
    if (performance.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await sleep(5)
  }
  return performance.now() - start
}

const players: Player[] = []

afterAll(async () => {
  for (const p of players) {
    p.sync.stop()
    await p.client.removeAllChannels()
  }
})

it(`p95 send-to-receive <= ${P95_MS} ms with ${PLAYERS} players`, async () => {
  if (!URL_ || !KEY) throw new Error('Set SUPABASE_URL and SUPABASE_ANON_KEY (see scripts/latency/README.md)')
  if (!(PLAYERS >= 6 && PLAYERS <= 10)) throw new Error('LATENCY_PLAYERS must be 6-10')

  // ---------------------------------------------------------------- set up the game
  const half = Math.ceil(PLAYERS / 2)
  let gameId = ''
  let code = ''
  for (let i = 0; i < PLAYERS; i++) {
    const client = createClient(URL_, KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
    const transport = supabaseTransport(client)
    const name = `Bot ${i + 1}`
    if (i === 0) {
      const res = await createGame(transport, name)
      gameId = res.game_id
      code = res.code
    } else {
      await joinGame(transport, code, name)
    }
    const team: Team = i < half ? 'hiders' : 'seekers'
    await callWithRetry(transport, 'set_team', {
      p_game_id: gameId,
      p_team: team,
      p_client_action_id: crypto.randomUUID(),
    })
    const sync = new GameSync(gameId, transport)
    const p: Player = { name, team, isHost: i === 0, client, sync, userId: '', appliedAt: new Map() }
    let seen = 0
    sync.subscribe(() => {
      const { events } = sync.getSnapshot()
      if (events.length < seen) seen = 0 // team change reset the view
      const t = performance.now()
      for (const e of events.slice(seen)) if (!p.appliedAt.has(e.seq)) p.appliedAt.set(e.seq, t)
      seen = events.length
    })
    players.push(p)
  }

  await Promise.all(players.map((p) => p.sync.start()))
  await waitFor('every phone live', () => players.every((p) => p.sync.getSnapshot().status === 'live'))
  for (const p of players) p.userId = p.sync.getSnapshot().userId ?? ''

  const presenceMs = await waitFor(
    'presence to show every player online on every phone',
    () => players.every((p) => p.sync.getSnapshot().present.length === PLAYERS),
  )

  // ---------------------------------------------------------------- measure
  const sentAt = new Map<number, number>()
  const rpcMs: number[] = []
  let lastSeq = Math.max(...players.map((p) => p.sync.getSnapshot().lastSeq))

  const send = async (p: Player, round: number) => {
    const t0 = performance.now()
    // Host edits config (needs a fresh view); others re-pick their own team.
    const res = (
      p.isHost
        ? await p.sync.action('update_config', { p_config: { harness_round: round } })
        : await p.sync.action('set_team', { p_team: p.team }, { fresh: false })
    ) as { seq: number }
    rpcMs.push(performance.now() - t0)
    sentAt.set(Number(res.seq), t0)
    lastSeq = Math.max(lastSeq, Number(res.seq))
  }
  const senderReady = (p: Player) => {
    const s = p.sync.getSnapshot()
    return s.canAct && s.lastSeq >= lastSeq
  }
  /**
   * Wait for phones to catch up before they send. If a broadcast went missing, fetch it,
   * as the app's own safety-net poll would; the late arrival still counts in the results.
   */
  const catchUp = async (what: string, ps: Player[]) => {
    const ready = () => ps.every(senderReady)
    try {
      await waitFor(what, ready, ARRIVAL_TIMEOUT_MS)
    } catch {
      await Promise.all(ps.map((p) => p.sync.resync()))
      await waitFor(what, ready, ARRIVAL_TIMEOUT_MS)
    }
  }

  // Warm up: a freshly started stack can take a few seconds before broadcasts from the
  // database flow. Not representative of a running server, so send unmeasured events until
  // one reaches every phone by broadcast.
  const host = players[0]
  let warmups = 0
  const warmStart = performance.now()
  for (;;) {
    if (performance.now() - warmStart > 60_000) throw new Error('broadcasts never started flowing')
    await catchUp('phones to catch up during warm-up', [host])
    const res = (await host.sync.action('update_config', { p_config: { harness_warmup: ++warmups } })) as {
      seq: number
    }
    const seq = Number(res.seq)
    lastSeq = Math.max(lastSeq, seq)
    const ok = await waitFor('warm-up event', () => players.every((p) => p.appliedAt.has(seq)), 2000)
      .then(() => true)
      .catch(() => false)
    if (ok) break
    await Promise.all(players.map((p) => p.sync.resync()))
  }
  const warmupMs = performance.now() - warmStart

  // One action at a time, rotating sender, like normal play.
  for (let r = 0; r < ROUNDS; r++) {
    const p = players[r % PLAYERS]
    await catchUp(`${p.name} to catch up`, [p])
    await send(p, r)
    await sleep(50 + Math.random() * 200)
  }
  // Everyone but the host taps at once.
  for (let b = 0; b < BURSTS; b++) {
    const senders = players.filter((p) => !p.isHost)
    await catchUp('phones to catch up', senders)
    await Promise.all(senders.map((p) => send(p, ROUNDS + b)))
    await sleep(300)
  }

  const allArrived = () => players.every((p) => [...sentAt.keys()].every((seq) => p.appliedAt.has(seq)))
  await waitFor('every event on every phone', allArrived, ARRIVAL_TIMEOUT_MS).catch(() => {})

  // ---------------------------------------------------------------- report
  const all: number[] = []
  let missing = 0
  const perPlayer: Array<{ name: string; team: Team } & Summary> = []
  for (const p of players) {
    const mine: number[] = []
    let gone = 0
    for (const [seq, t0] of sentAt) {
      const t1 = p.appliedAt.get(seq)
      if (t1 === undefined) gone++
      else mine.push(t1 - t0)
    }
    all.push(...mine)
    missing += gone
    perPlayer.push({ name: p.name, team: p.team, ...summarise(mine, gone) })
  }
  const overall = summarise(all, missing)
  const rpc = summarise(rpcMs)
  const failed = failures(overall, P95_MS)

  const ms = (n: number) => (Number.isFinite(n) ? `${Math.round(n)}` : '-')
  const row = (label: string, s: Summary) =>
    `| ${label} | ${s.count} | ${s.missing} | ${ms(s.p50)} | ${ms(s.p95)} | ${ms(s.p99)} | ${ms(s.max)} |`
  const md = [
    `### Latency harness: ${failed.length ? 'FAIL' : 'pass'}`,
    '',
    `${PLAYERS} players, ${sentAt.size} actions (${ROUNDS} sequential, ${BURSTS} bursts), p95 limit ${P95_MS} ms. ` +
      `Presence converged in ${ms(presenceMs)} ms. Warm-up: ${warmups} event(s), ${ms(warmupMs)} ms.`,
    '',
    '| | samples | missing | p50 ms | p95 ms | p99 ms | max ms |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    row('**send to receive**', overall),
    row('action round trip', rpc),
    ...perPlayer.map((p) => row(`${p.name} (${p.team})`, p)),
    '',
    ...failed.map((f) => `- ${f}`),
  ].join('\n')
  console.log(md)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n')
  if (process.env.LATENCY_REPORT) {
    writeFileSync(
      process.env.LATENCY_REPORT,
      JSON.stringify({ players: PLAYERS, p95LimitMs: P95_MS, presenceMs, warmups, warmupMs, overall, rpc, perPlayer, failed }, null, 2),
    )
  }

  expect(failed).toEqual([])
})
