import { ActionError, callWithRetry } from './actions'
import { ServerClock } from './clock'
import { EventSequencer } from './sequencer'
import { gameTopic, teamTopic, type ChannelState, type SyncTransport } from './transport'
import { audienceFor, isGameEvent, type GameEvent, type Team } from './types'

/**
 * connecting: joining topics. syncing: fetching missed events. live: up to date.
 * offline: no network or a topic dropped. error: can't continue (e.g. not a player).
 */
export type SyncStatus = 'idle' | 'connecting' | 'syncing' | 'live' | 'offline' | 'error'

export interface SyncSnapshot {
  status: SyncStatus
  /** Actions are allowed only when live with no known gap. Never queue offline. */
  canAct: boolean
  lastSeq: number
  events: readonly GameEvent[]
  team: Team | null
  userId: string | null
  clockOffsetMs: number
  error: string | null
  /** User ids with the app open (presence on the game topic). Only meaningful while live. */
  present: readonly string[]
  /** Local time (ms) the status last left 'live', or null while live or before the first sync. */
  staleSince: number | null
}

export { ActionError }

export interface SyncOptions {
  /** Wait this long for an out-of-order event to arrive before fetching the gap. */
  gapGraceMs?: number
  /** Safety-net fetch while live, in case a broadcast was dropped and nothing followed it. */
  pollIntervalMs?: number
  /** After being hidden this long, rejoin topics instead of trusting the old socket. */
  rejoinAfterHiddenMs?: number
  /** Retries for an action whose request may not have reached the server. */
  actionRetries?: number
  retryDelayMs?: number
  now?: () => number
}

const DEFAULTS: Required<Omit<SyncOptions, 'now'>> = {
  gapGraceMs: 250,
  pollIntervalMs: 30_000,
  rejoinAfterHiddenMs: 10_000,
  actionRetries: 3,
  retryDelayMs: 300,
}

/**
 * Keeps one game's event log in sync with the server: joins the game and team topics,
 * applies events in order, fetches gaps, resyncs on reconnect, and tracks clock offset.
 */
export class GameSync {
  readonly gameId: string
  private readonly transport: SyncTransport
  private readonly opts: Required<Omit<SyncOptions, 'now'>>
  private readonly now: () => number

  private readonly clock = new ServerClock()
  private readonly sequencer: EventSequencer
  private events: GameEvent[] = []
  /**
   * While rebuilding the log for a new team view, fetched events collect here and the screen
   * keeps showing the old log, so it never blanks. Swapped in once the rebuild is caught up.
   */
  private rebuilding: GameEvent[] | null = null
  private team: Team | null = null
  private userId: string | null = null
  private status: SyncStatus = 'idle'
  private error: string | null = null
  private present: readonly string[] = []
  private staleSince: number | null = null
  private wasLive = false

  private channels = new Map<string, { state: ChannelState | 'joining'; unsubscribe: () => void }>()
  private online = true
  private started = false
  private stopped = false
  /** Not yet confirmed up to date since the last (re)join, reopen or request. */
  private stale = true
  private fetchFailed = false
  private syncing: Promise<void> | null = null
  private syncAgain = false
  private hiddenAt: number | null = null
  private gapTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null

  private listeners = new Set<() => void>()
  private snapshot: SyncSnapshot

  constructor(gameId: string, transport: SyncTransport, options: SyncOptions = {}) {
    this.gameId = gameId
    this.transport = transport
    this.opts = { ...DEFAULTS, ...options }
    this.now = options.now ?? Date.now
    this.sequencer = new EventSequencer('none', (e) => this.onApplied(e))
    this.snapshot = this.buildSnapshot()
  }

  // ------------------------------------------------------------------ public

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): SyncSnapshot => this.snapshot

  /** Server time in ms since epoch, corrected for this device's clock offset. */
  serverNow(): number {
    return this.clock.now(this.now())
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.setStatus('connecting')
    try {
      this.userId = await this.transport.signIn()
      const member = await this.transport.membership(this.gameId)
      if (this.stopped) return
      if (!member) return this.fail('not_a_player')
      this.team = member.team
      this.sequencer.reset(audienceFor(this.team))
      this.joinTopics()
      void this.sampleClock(3)
      this.pollTimer = setInterval(() => {
        if (this.status === 'live') void this.resync({ quiet: true })
      }, this.opts.pollIntervalMs)
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e))
    }
  }

  stop(): void {
    this.stopped = true
    for (const ch of this.channels.values()) ch.unsubscribe()
    this.channels.clear()
    for (const t of [this.gapTimer, this.retryTimer]) if (t) clearTimeout(t)
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.listeners.clear()
  }

  /** Call when the page becomes hidden or visible (document.visibilitychange). */
  setVisible(visible: boolean): void {
    if (!visible) {
      this.hiddenAt = this.now()
      return
    }
    const hiddenFor = this.hiddenAt === null ? 0 : this.now() - this.hiddenAt
    this.hiddenAt = null
    if (!this.running) return
    // Assume nothing about what happened while hidden: block actions until caught up.
    if (hiddenFor >= this.opts.rejoinAfterHiddenMs) {
      this.clock.clear()
      this.rejoinTopics()
    } else {
      void this.resync()
    }
    void this.sampleClock(1)
  }

  /** Call on window online/offline. */
  setOnline(online: boolean): void {
    this.online = online
    if (!this.running) return
    if (online) {
      this.rejoinTopics()
      void this.sampleClock(1)
    } else {
      this.stale = true
      this.settle()
    }
  }

  /**
   * Run a game action. Adds game_id, client_action_id and (if fresh) last_seen_seq.
   * Retries with the same client_action_id if the request may not have arrived, so the
   * server applies it at most once. Throws ActionError.
   */
  async action(fn: string, params: Record<string, unknown> = {}, { fresh = true } = {}): Promise<unknown> {
    if (!this.snapshot.canAct) throw new ActionError('not_live', 'Not connected. Wait for the live dot.')
    const args: Record<string, unknown> = {
      p_game_id: this.gameId,
      p_client_action_id: crypto.randomUUID(),
      ...params,
    }
    if (fresh) args.p_last_seen_seq = this.sequencer.lastSeq

    try {
      return await callWithRetry(this.transport, fn, args, {
        retries: this.opts.actionRetries,
        retryDelayMs: this.opts.retryDelayMs,
        canRetry: () => this.online && !this.stopped,
      })
    } catch (e) {
      if (e instanceof ActionError && e.code === 'stale_state') {
        void this.resync()
        throw new ActionError('stale_state', 'Something changed. Check and try again.')
      }
      throw e
    }
  }

  /**
   * Fetch every event after the last applied one. Single-flight: a request made while a
   * fetch is running triggers one more pass. quiet: a background check that doesn't
   * block actions.
   */
  resync({ quiet = false } = {}): Promise<void> {
    if (!this.running) return Promise.resolve()
    if (!quiet) {
      this.stale = true
      this.settle()
    }
    if (this.syncing) {
      this.syncAgain = true
      return this.syncing
    }
    this.syncing = this.runResync().finally(() => {
      this.syncing = null
      this.settle()
    })
    return this.syncing
  }

  // ------------------------------------------------------------------ internals

  private get running(): boolean {
    return this.started && !this.stopped && this.status !== 'error'
  }

  private async runResync(): Promise<void> {
    do {
      this.syncAgain = false
      const after = this.sequencer.lastSeq
      let member: { team: Team | null } | null
      let events: GameEvent[]
      try {
        ;[member, events] = await Promise.all([
          this.transport.membership(this.gameId),
          this.transport.fetchEvents(this.gameId, after),
        ])
      } catch {
        if (this.stopped) return
        this.fetchFailed = true
        this.stale = true
        if (!this.retryTimer) {
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null
            void this.resync()
          }, 2000)
        }
        return
      }
      if (this.stopped) return
      this.fetchFailed = false
      if (!member) return this.fail('not_a_player')
      if (member.team !== this.team) {
        // Visibility changed: start over with the new team's view of the log.
        this.team = member.team
        this.sequencer.reset(audienceFor(this.team))
        this.rebuilding = []
        this.stale = true
        this.rejoinTopics()
        return
      }
      this.sequencer.applyFetched(after, events)
    } while (this.syncAgain)
    this.stale = false
    if (this.rebuilding) {
      this.events = this.rebuilding
      this.rebuilding = null
    }
  }

  private joinTopics(): void {
    const topics = [gameTopic(this.gameId)]
    if (this.team) topics.push(teamTopic(this.gameId, this.team))
    for (const topic of topics) {
      if (this.channels.has(topic)) continue
      const entry: { state: ChannelState | 'joining'; unsubscribe: () => void } = {
        state: 'joining',
        unsubscribe: () => {},
      }
      this.channels.set(topic, entry)
      // Presence rides on the shared topic only, keyed by user id.
      const presence =
        topic === gameTopic(this.gameId) && this.userId
          ? {
              key: this.userId,
              onSync: (keys: string[]) => {
                if (this.channels.get(topic) !== entry) return
                this.present = [...keys].sort()
                this.emit()
              },
            }
          : undefined
      entry.unsubscribe = this.transport.subscribe(
        topic,
        (raw) => this.onBroadcast(raw),
        (state) => {
          if (this.channels.get(topic) !== entry) return
          entry.state = state
          // (Re)joined: anything sent while we weren't listening must be fetched.
          if (state === 'subscribed') void this.resync()
          else this.stale = true
          this.settle()
        },
        presence,
      )
    }
    this.settle()
  }

  private rejoinTopics(): void {
    for (const ch of this.channels.values()) ch.unsubscribe()
    this.channels.clear()
    this.stale = true
    if (!this.stopped) this.joinTopics()
  }

  private onBroadcast(raw: unknown): void {
    if (this.stopped || !isGameEvent(raw) || raw.game_id !== this.gameId) return
    // During a fetch the sequencer keeps ordering live events; the fetch result merges
    // with anything buffered.
    if (this.sequencer.receive(raw) === 'buffered') this.scheduleGapFetch()
    this.settle()
  }

  private scheduleGapFetch(): void {
    if (this.gapTimer) return
    this.gapTimer = setTimeout(() => {
      this.gapTimer = null
      if (this.sequencer.hasGap) void this.resync()
    }, this.opts.gapGraceMs)
  }

  private onApplied(event: GameEvent): void {
    if (this.rebuilding) {
      this.rebuilding.push(event)
      return
    }
    this.events = [...this.events, event]
    if (event.type === 'team_changed' && event.payload.user_id === this.userId && event.payload.team !== this.team) {
      // Our own visibility changed. resync() picks up the new team from the server.
      void this.resync()
    }
  }

  private async sampleClock(count: number): Promise<void> {
    for (let i = 0; i < count && !this.stopped; i++) {
      try {
        const sentAt = this.now()
        const serverAt = await this.transport.serverTime()
        this.clock.add({ sentAt, serverAt, receivedAt: this.now() })
        this.emit()
      } catch {
        return
      }
    }
  }

  /** Derive status from network, topics, fetch state and gaps. */
  private settle(): void {
    if (!this.running) return this.emit()
    const states = [...this.channels.values()].map((c) => c.state)
    if (!this.online || this.fetchFailed || states.some((s) => s === 'error' || s === 'closed')) {
      this.setStatus('offline')
    } else if (states.length === 0 || states.includes('joining')) {
      this.setStatus('connecting')
    } else if (this.stale || this.sequencer.hasGap) {
      this.setStatus('syncing')
    } else {
      this.setStatus('live')
    }
  }

  private fail(message: string): void {
    this.error = message
    this.setStatus('error')
  }

  private setStatus(status: SyncStatus): void {
    if (status === 'live') {
      this.wasLive = true
      this.staleSince = null
    } else if (this.wasLive && this.staleSince === null) {
      this.staleSince = this.now()
    }
    this.status = status
    this.emit()
  }

  private emit(): void {
    this.snapshot = this.buildSnapshot()
    for (const l of this.listeners) l()
  }

  private buildSnapshot(): SyncSnapshot {
    return {
      status: this.status,
      canAct: this.status === 'live',
      lastSeq: this.sequencer.lastSeq,
      events: this.events,
      team: this.team,
      userId: this.userId,
      clockOffsetMs: this.clock.offsetMs,
      error: this.error,
      present: this.present,
      staleSince: this.staleSince,
    }
  }
}
