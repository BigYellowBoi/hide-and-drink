// Push alerts: sends one queued push_outbox row (supabase/migrations/*_push_alerts.sql) to
// the push subscriptions of the game's players in its audience. Called by the database
// trigger through pg_net with { outbox_id } and the shared secret; see docs/push.md.
//
// Secrets (supabase secrets set ...): PUSH_WEBHOOK_SECRET, VAPID_PUBLIC_KEY,
// VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto: or https: contact for the push services).
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.

import { createClient } from 'npm:@supabase/supabase-js@2.119.0'
import webpush from 'npm:web-push@3.6.7'

const env = (k: string) => {
  const v = Deno.env.get(k)
  if (!v) throw new Error(`missing ${k}`)
  return v
}

webpush.setVapidDetails(env('VAPID_SUBJECT'), env('VAPID_PUBLIC_KEY'), env('VAPID_PRIVATE_KEY'))
const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })
const secret = env('PUSH_WEBHOOK_SECRET')

/** Constant-time string compare, so the secret can't be guessed byte by byte. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })
  if (!same(req.headers.get('Authorization') ?? '', `Bearer ${secret}`)) return new Response('unauthorized', { status: 401 })

  const { outbox_id } = await req.json().catch(() => ({}))
  if (typeof outbox_id !== 'number') return new Response('outbox_id required', { status: 400 })

  const { data: alert, error } = await db.from('push_outbox').select('*').eq('id', outbox_id).maybeSingle()
  if (error) return new Response(error.message, { status: 500 })
  if (!alert || alert.sent_at) return Response.json({ sent: 0 })

  // Players of the game in the audience, except whoever caused the event.
  let players = db.from('players').select('user_id').eq('game_id', alert.game_id)
  if (alert.audience !== 'all') players = players.eq('team', alert.audience)
  const { data: rows, error: pErr } = await players
  if (pErr) return new Response(pErr.message, { status: 500 })
  const users = (rows ?? []).map((r) => r.user_id).filter((u) => u !== alert.exclude_user)

  const { data: subs, error: sErr } = users.length
    ? await db.from('push_subscriptions').select('endpoint, p256dh, auth').in('user_id', users)
    : { data: [], error: null }
  if (sErr) return new Response(sErr.message, { status: 500 })

  const payload = JSON.stringify({ title: alert.title, body: alert.body, tag: alert.tag, game_id: alert.game_id })
  let sent = 0
  const gone: string[] = []
  await Promise.all(
    (subs ?? []).map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, {
          TTL: 600,
          urgency: 'high',
          topic: alert.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32),
        })
        sent++
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode
        // The browser dropped the subscription (app uninstalled, permission revoked).
        if (status === 404 || status === 410) gone.push(s.endpoint)
        else console.error('push failed', status, (e as Error).message)
      }
    }),
  )
  if (gone.length) await db.from('push_subscriptions').delete().in('endpoint', gone)
  await db.from('push_outbox').update({ sent_at: new Date().toISOString(), sent_count: sent }).eq('id', alert.id)
  return Response.json({ sent, removed: gone.length })
})
