// Admin PIN (docs/admin.md). The phone POSTs { pin } with its Supabase session. The PIN is
// the Edge Function secret ADMIN_PIN (never in the client or the repo). public.admin_pin_attempt
// rate-limits first (5 tries per user, 20 wrong ones overall, per 15 min), then records the
// try and, if the PIN matched, makes this user an admin (table public.admins, no client writes).
//
//   { pin }  ->  { admin: true }  |  { error: 'wrong_pin' | 'rate_limited' | 'admin_not_set_up' }

import { CORS_HEADERS, errorCode, json, pinMatches } from '../_shared/media.ts'
import { callerId, db } from '../_shared/supabase.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
  const user = await callerId(req)
  if (!user) return json({ error: 'not_signed_in' }, 401)
  const secret = Deno.env.get('ADMIN_PIN')
  if (!secret?.trim()) return json({ error: 'admin_not_set_up' }, 503)

  const body = (await req.json().catch(() => null)) as { pin?: unknown } | null
  const ok = pinMatches(body?.pin, secret)
  const { data, error } = await db.rpc('admin_pin_attempt', { p_user: user, p_ok: ok })
  if (error) return json({ error: errorCode(error.message) }, 400)
  if (data === 'ok') return json({ admin: true })
  return json({ error: data === 'rate_limited' ? 'rate_limited' : 'wrong_pin' }, data === 'rate_limited' ? 429 : 403)
})
