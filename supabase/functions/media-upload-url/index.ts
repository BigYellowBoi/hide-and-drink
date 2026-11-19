// Media uploads to Cloudflare R2 (docs/r2.md). The phone POSTs with its Supabase session:
//
//   { name, bytes, content_type, picked }  ->  { store: 'r2', url, bucket, quality }
//                                              { squeeze: true, bucket }       (shrink, ask again)
//                                              { store: 'supabase', reason }   (old upload path)
//   { name, done: true }                   ->  { ok: true } once R2 has the object
//
// Who may upload what, the storage budget and which videos stay original are decided by
// public.media_upload_grant (supabase/migrations/20261222090000_r2_media.sql).
//
// Secrets: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET; optional
// R2_BUDGET_BYTES, R2_REDUCED_SHARE, R2_MAX_FILE_BYTES. Without the four R2 secrets the answer
// is always { store: 'supabase' }.

import { cleanPicked, CORS_HEADERS, errorCode, isMediaName, json, mediaLimits, r2Config } from '../_shared/media.ts'
import { r2Client } from '../_shared/r2.ts'
import { callerId, db } from '../_shared/supabase.ts'

const cfg = r2Config((k) => Deno.env.get(k))
const limits = mediaLimits((k) => Deno.env.get(k))
const r2 = cfg ? r2Client(cfg) : null

/** Settle a few reservations nobody confirmed: count what arrived, drop what didn't. */
async function sweep() {
  if (!r2) return
  const { data } = await db.rpc('media_stale_uploads', { p_limit: 3 })
  for (const name of (data ?? []) as string[]) {
    try {
      const size = await r2.size(name)
      const { data: status } = await db.rpc('media_upload_done', { p_user: null, p_name: name, p_bytes: size })
      if (status === 'too_big') await r2.remove(name)
    } catch (e) {
      console.error('sweep failed', name, (e as Error).message)
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
  const user = await callerId(req)
  if (!user) return json({ error: 'not_signed_in' }, 401)
  if (!cfg || !r2) return json({ store: 'supabase', reason: 'r2_not_configured' })

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  const name = body?.name
  if (!isMediaName(name)) return json({ error: 'invalid_media_path' }, 400)

  if (body?.done === true) {
    const size = await r2.size(name)
    const { data: status, error } = await db.rpc('media_upload_done', { p_user: user, p_name: name, p_bytes: size })
    if (error) return json({ error: errorCode(error.message) }, 400)
    if (status === 'too_big') {
      await r2.remove(name)
      return json({ error: 'media_too_big' }, 400)
    }
    if (status !== 'ok') return json({ error: 'media_not_uploaded' }, 409)
    console.log('media uploaded', JSON.stringify({ user, name, bytes: size }))
    return json({ ok: true })
  }

  await sweep().catch((e) => console.error('sweep failed', (e as Error).message))

  const picked = cleanPicked(body?.picked)
  const bytes = Number(body?.bytes)
  const contentType = typeof body?.content_type === 'string' ? body.content_type.toLowerCase().slice(0, 100) : ''
  // Logged so we can check what phones hand over (iPhones: originals or converted copies?).
  console.log('media upload requested', JSON.stringify({ user, name, bytes, content_type: contentType, picked }))

  const { data, error } = await db.rpc('media_upload_grant', {
    p_user: user,
    p_name: name,
    p_bytes: Number.isFinite(bytes) ? Math.round(bytes) : null,
    p_content_type: contentType,
    p_picked: picked,
    p_budget: limits.budgetBytes,
    p_reduced_share: limits.reducedShare,
    p_max_bytes: limits.maxFileBytes,
  })
  if (error) return json({ error: errorCode(error.message) }, 400)
  const grant = data as { store?: string; squeeze?: boolean }
  if (grant.store !== 'r2') return json(grant)
  return json({ ...grant, url: await r2.presign('PUT', name, limits.putExpiresS), expires_in: limits.putExpiresS })
})
