import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ActionError, GameSync } from './engine'
import type { ActionResult, ChannelState, PresenceOptions, SyncTransport } from './transport'
import type { GameEvent, SeekerPosition, Team, Visibility } from './types'

const GAME = 'game-1'
const ME = 'user-me'

/** In-memory server: an event log with visibility, plus controllable topics. */
class FakeServer implements SyncTransport {
  log: GameEvent[] = []
  team: Team | null = 'seekers'
  topics = new Map<
    string,
    {
      onEvent: (raw: unknown) => void
      onState: (s: ChannelState) => void
      presence?: PresenceOptions
      onSignal?: (event: string, raw: unknown) => void
    }
  >()
  storedPositions: SeekerPosition[] = []
  fetchCount = 0
  failFetch = false
  serverOffset = 5000
  calls: Array<{ fn: string; args: Record<string, unknown> }> = []
  nextResults: ActionResult[] = []

  async signIn() {
    return ME
  }
  async membership() {
    return { team: this.team }
  }
  async fetchEvents(_gameId: string, after: number) {
    this.fetchCount++
    if (this.failFetch) throw new Error('network')
    return this.log.filter((e) => e.seq > after && this.visible(e.visibility))
  }
  async serverTime() {
    return Date.now() + this.serverOffset
  }
  subscribe(
    topic: string,
    onEvent: (raw: unknown) => void,
    onState: (s: ChannelState) => void,
    presence?: PresenceOptions,
    onSignal?: (event: string, raw: unknown) => void,
  ) {
    this.topics.set(topic, { onEvent, onState, presence, onSignal })
    return () => this.topics.delete(topic)
  }
  async fetchPositions() {
    return this.storedPositions
  }
  async call(fn: string, args: Record<string, unknown>) {
    this.calls.push({ fn, args })
    return this.nextResults.shift() ?? { ok: true as const, data: { seq: this.log.length } }
  }

  visible(v: Visibility) {
    return v === 'all' || v === this.team
  }
  /** Join every open topic. */
  ackAll(state: ChannelState = 'subscribed') {
    for (const t of this.topics.values()) t.onState(state)
  }
  /** Append an event; returns it with prev_seq as the broadcast trigger would. */
  append(type: string, visibility: Visibility = 'all', payload: Record<string, unknown> = {}): GameEvent {
    const before = this.log
    const max = (vs: Visibility[]) => Math.max(0, ...before.filter((e) => vs.includes(e.visibility)).map((e) => e.seq))
    const e: GameEvent = {
      game_id: GAME,
      seq: before.length + 1,
      type,
      visibility,
      actor_id: null,
      payload,
      created_at: '',
    }
    this.log = [...before, e]
    return { ...e, prev_seq: { none: max(['all']), hiders: max(['all', 'hiders']), seekers: max(['all', 'seekers']) } }
  }
  /** Deliver a broadcast to the topic it would go to (if we're subscribed). */
  deliver(e: GameEvent) {
    const topic = e.visibility === 'all' ? `game:${GAME}` : `game:${GAME}:${e.visibility}`
    this.topics.get(topic)?.onEvent(e)
  }
}

const flush = () => vi.advanceTimersByTimeAsync(0)

async function started(server: FakeServer) {
  const sync = new GameSync(GAME, server, { gapGraceMs: 100, pollIntervalMs: 60_000, rejoinAfterHiddenMs: 10_000 })
  await sync.start()
  await flush()
  server.ackAll()
  await flush()
  return sync
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('GameSync', () => {
  it('joins the game and team topics, catches up, then goes live', async () => {
    const server = new FakeServer()
    server.append('game_created')
    server.append('secret', 'hiders')
    server.append('seeker_note', 'seekers')
    const sync = new GameSync(GAME, server)
    await sync.start()
    expect(sync.getSnapshot().status).toBe('connecting')
    expect([...server.topics.keys()].sort()).toEqual([`game:${GAME}`, `game:${GAME}:seekers`])
    server.ackAll()
    await flush()
    const snap = sync.getSnapshot()
    expect(snap.status).toBe('live')
    expect(snap.canAct).toBe(true)
    expect(snap.events.map((e) => e.seq)).toEqual([1, 3])
    expect(snap.lastSeq).toBe(3)
    sync.stop()
  })

  it('applies live broadcasts in order without fetching, skipping hidden seqs', async () => {
    const server = new FakeServer()
    const sync = await started(server)
    const fetches = server.fetchCount
    const a = server.append('a')
    server.append('hidden', 'hiders') // never delivered to seekers
    const b = server.append('b', 'seekers')
    server.deliver(a)
    server.deliver(b)
    await vi.advanceTimersByTimeAsync(500)
    expect(sync.getSnapshot().events.map((e) => e.type)).toEqual(['a', 'b'])
    expect(server.fetchCount).toBe(fetches)
    sync.stop()
  })

  it('waits briefly for an out-of-order event before fetching', async () => {
    const server = new FakeServer()
    const sync = await started(server)
    const fetches = server.fetchCount
    const a = server.append('a')
    const b = server.append('b', 'seekers')
    server.deliver(b)
    expect(sync.getSnapshot().canAct).toBe(false)
    server.deliver(a)
    await vi.advanceTimersByTimeAsync(500)
    expect(sync.getSnapshot().events.map((e) => e.type)).toEqual(['a', 'b'])
    expect(sync.getSnapshot().canAct).toBe(true)
    expect(server.fetchCount).toBe(fetches)
    sync.stop()
  })

  it('fetches a gap left by a dropped broadcast', async () => {
    const server = new FakeServer()
    const sync = await started(server)
    server.append('dropped')
    const next = server.append('next')
    server.deliver(next)
    expect(sync.getSnapshot().status).toBe('syncing')
    await vi.advanceTimersByTimeAsync(150)
    expect(sync.getSnapshot().events.map((e) => e.type)).toEqual(['dropped', 'next'])
    expect(sync.getSnapshot().status).toBe('live')
    sync.stop()
  })

  it('blocks actions on reopen until it has caught up', async () => {
    const server = new FakeServer()
    const sync = await started(server)
    sync.setVisible(false)
    server.append('while_hidden') // broadcast missed: phone was locked
    await vi.advanceTimersByTimeAsync(2000)
    sync.setVisible(true)
    expect(sync.getSnapshot().canAct).toBe(false)
    await expect(sync.action('update_config', {})).rejects.toMatchObject({ code: 'not_live' })
    await flush()
    expect(sync.getSnapshot().events.map((e) => e.type)).toEqual(['while_hidden'])
    expect(sync.getSnapshot().canAct).toBe(true)
    sync.stop()
  })

  it('rejoins topics after a long time hidden', async () => {
    const server = new FakeServer()
    const sync = await started(server)
    sync.setVisible(false)
    await vi.advanceTimersByTimeAsync(30_000)
    sync.setVisible(true)
    expect(sync.getSnapshot().status).toBe('connecting')
    server.append('later')
    server.ackAll()
    await flush()
    expect(sync.getSnapshot().status).toBe('live')
    expect(sync.getSnapshot().events.map((e) => e.type)).toEqual(['later'])
    sync.stop()
  })

  it('goes offline when the network drops and recovers on reconnect', async () => {
    const server = new FakeServer()
    const sync = await started(server)
    sync.setOnline(false)
    expect(sync.getSnapshot().status).toBe('offline')
    expect(sync.getSnapshot().canAct).toBe(false)
    server.append('missed')
    sync.setOnline(true)
    server.ackAll()
    await flush()
    expect(sync.getSnapshot().status).toBe('live')
    expect(sync.getSnapshot().events.map((e) => e.type)).toEqual(['missed'])
    sync.stop()
  })

  it('shows offline when a topic drops and resyncs when it rejoins', async () => {
    const server = new FakeServer()
    const sync = await started(server)
    server.ackAll('error')
    expect(sync.getSnapshot().status).toBe('offline')
    server.append('missed')
    server.ackAll('subscribed')
    await flush()
    expect(sync.getSnapshot().status).toBe('live')
    expect(sync.getSnapshot().lastSeq).toBe(1)
    sync.stop()
  })

  it('retries a failed fetch and stays offline meanwhile', async () => {
    const server = new FakeServer()
    server.failFetch = true
    const sync = await started(server)
    expect(sync.getSnapshot().status).toBe('offline')
    server.failFetch = false
    server.append('a')
    await vi.advanceTimersByTimeAsync(2100)
    expect(sync.getSnapshot().status).toBe('live')
    expect(sync.getSnapshot().lastSeq).toBe(1)
    sync.stop()
  })

  it('stops with a clear error when the host removes us', async () => {
    const server = new FakeServer()
    server.append('game_created')
    const sync = await started(server)
    server.deliver(server.append('player_removed', 'all', { user_id: 'someone-else' }))
    await flush()
    expect(sync.getSnapshot().status).toBe('live')
    server.deliver(server.append('player_removed', 'all', { user_id: ME }))
    await flush()
    expect(sync.getSnapshot().status).toBe('error')
    expect(sync.getSnapshot().error).toBe('removed_from_game')
    expect(server.topics.size).toBe(0)
    sync.stop()
  })

  it('lets a removed player rejoin: an old removal followed by a rejoin is not fatal', async () => {
    const server = new FakeServer()
    server.append('game_created')
    server.append('player_joined', 'all', { user_id: ME, name: 'Me' })
    server.append('player_removed', 'all', { user_id: ME })
    server.append('player_joined', 'all', { user_id: ME, name: 'Me' })
    const sync = await started(server)
    expect(sync.getSnapshot().status).toBe('live')
    expect(sync.getSnapshot().events.map((e) => e.seq)).toEqual([1, 2, 3, 4])
    // Removed again after rejoining: that one counts.
    server.deliver(server.append('player_removed', 'all', { user_id: ME }))
    await flush()
    expect(sync.getSnapshot().error).toBe('removed_from_game')
    sync.stop()
  })

  it('stops when the fetched log ends with our removal', async () => {
    const server = new FakeServer()
    server.append('game_created')
    server.append('player_removed', 'all', { user_id: ME })
    const sync = await started(server)
    expect(sync.getSnapshot().error).toBe('removed_from_game')
    sync.stop()
  })

  it('starts over with the new team view when our team changes', async () => {
    const server = new FakeServer()
    server.team = null
    server.append('game_created')
    server.append('secret', 'hiders')
    const sync = await started(server)
    expect(sync.getSnapshot().events.map((e) => e.seq)).toEqual([1])
    server.team = 'hiders'
    // The screen must never go blank mid-switch (it used to flash "Loading game…").
    const seen: number[][] = []
    sync.subscribe(() => seen.push(sync.getSnapshot().events.map((e) => e.seq)))
    server.deliver(server.append('team_changed', 'all', { user_id: ME, team: 'hiders' }))
    await flush()
    expect(server.topics.has(`game:${GAME}:hiders`)).toBe(true)
    server.ackAll()
    await flush()
    expect(sync.getSnapshot().team).toBe('hiders')
    expect(sync.getSnapshot().events.map((e) => e.seq)).toEqual([1, 2, 3])
    expect(seen.every((seqs) => seqs.length > 0)).toBe(true)
    // Old view until the new one is complete, then one swap: no partial logs in between.
    expect(seen.filter((seqs) => seqs.join() !== '1,3' && seqs.join() !== '1' && seqs.join() !== '1,2,3')).toEqual([])
    sync.stop()
  })

  it('sends game id, client action id and last seen seq; reuses the id on retry', async () => {
    const server = new FakeServer()
    server.append('game_created')
    const sync = await started(server)
    server.nextResults = [{ ok: false, code: 'network', message: 'x', retryable: true }]
    const p = sync.action('update_config', { p_config: {} })
    await vi.advanceTimersByTimeAsync(1000)
    await p
    expect(server.calls).toHaveLength(2)
    const [first, second] = server.calls
    expect(first.args).toMatchObject({ p_game_id: GAME, p_last_seen_seq: 1, p_config: {} })
    expect(second.args.p_client_action_id).toBe(first.args.p_client_action_id)
    sync.stop()
  })

  it('does not retry a server refusal, and resyncs on stale_state', async () => {
    const server = new FakeServer()
    const sync = await started(server)
    server.nextResults = [{ ok: false, code: 'host_only', message: 'host_only', retryable: false }]
    await expect(sync.action('update_config')).rejects.toBeInstanceOf(ActionError)
    expect(server.calls).toHaveLength(1)

    const fetches = server.fetchCount
    server.nextResults = [{ ok: false, code: 'stale_state', message: 'stale_state', retryable: false }]
    await expect(sync.action('update_config')).rejects.toMatchObject({ code: 'stale_state' })
    await flush()
    expect(server.fetchCount).toBe(fetches + 1)
    sync.stop()
  })

  it('estimates the server clock offset', async () => {
    const server = new FakeServer()
    const sync = await started(server)
    expect(sync.getSnapshot().clockOffsetMs).toBe(5000)
    expect(sync.serverNow() - Date.now()).toBe(5000)
    sync.stop()
  })

  it('ignores broadcasts for other games and malformed payloads', async () => {
    const server = new FakeServer()
    const sync = await started(server)
    const topic = server.topics.get(`game:${GAME}`)!
    topic.onEvent({ ...server.append('x'), game_id: 'other' })
    topic.onEvent({ nonsense: true })
    topic.onEvent(null)
    expect(sync.getSnapshot().events).toHaveLength(0)
    sync.stop()
  })

  it('tracks presence on the shared topic only, keyed by user id', async () => {
    const server = new FakeServer()
    const sync = await started(server)
    expect(server.topics.get(`game:${GAME}`)?.presence?.key).toBe(ME)
    expect(server.topics.get(`game:${GAME}:seekers`)?.presence).toBeUndefined()
    server.topics.get(`game:${GAME}`)?.presence?.onSync(['user-b', ME])
    expect(sync.getSnapshot().present).toEqual(['user-b', ME].sort())
    sync.stop()
  })

  it('ignores presence from a topic it has since left', async () => {
    const server = new FakeServer()
    const sync = await started(server)
    const old = server.topics.get(`game:${GAME}`)?.presence
    sync.setOnline(false)
    sync.setOnline(true) // rejoins: new channel entries
    old?.onSync(['ghost'])
    expect(sync.getSnapshot().present).toEqual([])
    sync.stop()
  })

  it('records when it stopped being live and clears it on recovery', async () => {
    const server = new FakeServer()
    const sync = await started(server)
    expect(sync.getSnapshot().staleSince).toBeNull()
    const t = Date.now()
    sync.setOnline(false)
    expect(sync.getSnapshot().staleSince).toBe(t)
    await vi.advanceTimersByTimeAsync(5000)
    sync.setOnline(true)
    expect(sync.getSnapshot().staleSince).toBe(t) // still catching up
    server.ackAll()
    await flush()
    expect(sync.getSnapshot().status).toBe('live')
    expect(sync.getSnapshot().staleSince).toBeNull()
    sync.stop()
  })

  describe('seeker positions', () => {
    const pos = (user: string, lng: number, at: string, round = 1) => ({
      game_id: GAME,
      user_id: user,
      round,
      lng,
      lat: -27.4,
      accuracy_m: 5,
      at,
    })

    it('loads teammates on sync and keeps the newest broadcast per seeker', async () => {
      const server = new FakeServer()
      server.storedPositions = [{ userId: 'amy', round: 1, lng: 153, lat: -27.4, accuracyM: 5, at: Date.parse('2026-11-17T10:00:00Z') }]
      const sync = await started(server)
      await flush()
      expect(sync.getSnapshot().positions.map((p) => p.userId)).toEqual(['amy'])
      const signal = server.topics.get(`game:${GAME}:seekers`)?.onSignal
      signal?.('position', pos('amy', 153.1, '2026-11-17T10:00:20Z'))
      signal?.('position', pos('amy', 153.2, '2026-11-17T10:00:10Z')) // older, arrives late
      signal?.('position', pos('sam', 153.3, '2026-11-17T10:00:15Z'))
      signal?.('position', { ...pos('eve', 1, '2026-11-17T10:00:15Z'), game_id: 'other' })
      const byUser = Object.fromEntries(sync.getSnapshot().positions.map((p) => [p.userId, p.lng]))
      expect(byUser).toEqual({ amy: 153.1, sam: 153.3 })
      // A new round drops last round's positions.
      signal?.('position', pos('sam', 153.4, '2026-11-17T11:00:00Z', 2))
      expect(sync.getSnapshot().positions.map((p) => p.userId)).toEqual(['sam'])
      sync.stop()
    })

    it('hiders never listen for positions', async () => {
      const server = new FakeServer()
      server.team = 'hiders'
      server.storedPositions = [{ userId: 'amy', round: 1, lng: 153, lat: -27.4, accuracyM: 5, at: 0 }]
      const sync = await started(server)
      await flush()
      expect(server.topics.get(`game:${GAME}:hiders`)?.onSignal).toBeUndefined()
      expect(sync.getSnapshot().positions).toEqual([])
      expect((await sync.reportPosition(153, -27, 5)).ok).toBe(false)
      expect(server.calls).toEqual([])
      sync.stop()
    })

    it('reports only while live, once, without queueing', async () => {
      const server = new FakeServer()
      const sync = await started(server)
      expect((await sync.reportPosition(153, -27.4, 8)).ok).toBe(true)
      expect(server.calls).toEqual([
        { fn: 'report_position', args: { p_game_id: GAME, p_lng: 153, p_lat: -27.4, p_accuracy_m: 8 } },
      ])
      sync.setOnline(false)
      expect((await sync.reportPosition(153, -27.4, 8)).ok).toBe(false)
      sync.setOnline(true)
      server.ackAll()
      await flush()
      expect(server.calls).toHaveLength(1)
      sync.stop()
    })
  })
})
