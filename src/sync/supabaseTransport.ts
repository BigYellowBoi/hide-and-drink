import type { SupabaseClient } from '@supabase/supabase-js'
import { SIGNAL_EVENTS, type ActionResult, type ChannelState, type SyncTransport } from './transport'
import { parsePosition, type GameEvent, type SeekerPosition, type Team } from './types'

const PAGE = 500

/** Signed-in user id. Signs in anonymously on first use; the session persists on the device. */
export async function ensureSignedIn(client: SupabaseClient): Promise<string> {
  const { data } = await client.auth.getSession()
  let session = data.session
  if (!session) {
    const res = await client.auth.signInAnonymously()
    if (res.error || !res.data.session) throw new Error(res.error?.message ?? 'sign_in_failed')
    session = res.data.session
  }
  // Private topics authorise with the user's JWT, not the anon key.
  await client.realtime.setAuth(session.access_token)
  return session.user.id
}

export function supabaseTransport(client: SupabaseClient): SyncTransport {
  return {
    signIn: () => ensureSignedIn(client),

    async membership(gameId) {
      const { data: auth } = await client.auth.getSession()
      if (!auth.session) throw new Error('not_signed_in')
      const { data, error } = await client
        .from('players')
        .select('team')
        .eq('game_id', gameId)
        .eq('user_id', auth.session.user.id)
        .maybeSingle()
      if (error) throw new Error(error.message)
      return data ? { team: (data.team as Team | null) ?? null } : null
    },

    async fetchEvents(gameId, afterSeq) {
      const all: GameEvent[] = []
      let after = afterSeq
      for (;;) {
        const { data, error } = await client
          .from('events')
          .select('game_id, seq, type, visibility, actor_id, payload, created_at')
          .eq('game_id', gameId)
          .gt('seq', after)
          .order('seq', { ascending: true })
          .limit(PAGE)
        if (error) throw new Error(error.message)
        const rows = (data ?? []).map((r) => ({ ...r, seq: Number(r.seq) }) as GameEvent)
        all.push(...rows)
        if (rows.length < PAGE) return all
        after = rows[rows.length - 1].seq
      }
    },

    async serverTime() {
      const { data, error } = await client.rpc('server_time')
      if (error) throw new Error(error.message)
      const ms = Date.parse(String(data))
      if (Number.isNaN(ms)) throw new Error('bad_server_time')
      return ms
    },

    async fetchPositions(gameId) {
      const { data, error } = await client
        .from('seeker_positions')
        .select('user_id, round, lng, lat, accuracy_m, reported_at')
        .eq('game_id', gameId)
      if (error) throw new Error(error.message)
      return (data ?? []).map(parsePosition).filter((p): p is SeekerPosition => p !== null)
    },

    subscribe(topic, onEvent, onState, presence, onSignal) {
      const channel = client.channel(topic, {
        config: { private: true, ...(presence ? { presence: { key: presence.key } } : {}) },
      })
      channel.on('broadcast', { event: 'event' }, (msg) => onEvent(msg.payload))
      if (onSignal) {
        for (const name of SIGNAL_EVENTS) channel.on('broadcast', { event: name }, (msg) => onSignal(name, msg.payload))
      }
      if (presence) {
        channel.on('presence', { event: 'sync' }, () => presence.onSync(Object.keys(channel.presenceState())))
      }
      channel.subscribe((status) => {
        const state: ChannelState =
          status === 'SUBSCRIBED' ? 'subscribed' : status === 'CLOSED' ? 'closed' : 'error'
        // Presence is best effort: a failed track only greys out our dot for others.
        if (state === 'subscribed' && presence) void channel.track({ at: new Date().toISOString() }).catch(() => {})
        onState(state)
      })
      return () => {
        void client.removeChannel(channel)
      }
    },

    async call(fn, args): Promise<ActionResult> {
      try {
        const { data, error, status } = await client.rpc(fn, args)
        if (!error) return { ok: true, data }
        // P0001 = our own raise exception: the server saw it and refused. Not retryable.
        const retryable = error.code !== 'P0001' && (status === 0 || status >= 500)
        return { ok: false, code: error.code === 'P0001' ? error.message : error.code || 'request_failed', message: error.message, retryable }
      } catch (e) {
        return { ok: false, code: 'network', message: e instanceof Error ? e.message : String(e), retryable: true }
      }
    },
  }
}
