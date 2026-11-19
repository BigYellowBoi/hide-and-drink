// Short-lived read URLs for media (docs/r2.md). The phone POSTs { names: [...] } with its
// Supabase session and gets { urls: { name: url } } for the names its team may see, by the
// rules in public.media_read_grant (supabase/migrations/20261222090000_r2_media.sql):
// presigned R2 GETs for files in R2, signed Supabase Storage URLs for older files. Names it
// may not see are simply left out, so a hider-only file never reaches a seeker.

import { CORS_HEADERS, errorCode, isMediaName, json, mediaLimits, r2Config } from '../_shared/media.ts'
import { r2Client } from '../_shared/r2.ts'
import { callerId, db } from '../_shared/supabase.ts'

const cfg = r2Config((k) => Deno.env.get(k))
const limits = mediaLimits((k) => Deno.env.get(k))
const r2 = cfg ? r2Client(cfg) : null

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
  const user = await callerId(req)
  if (!user) return json({ error: 'not_signed_in' }, 401)

  const body = (await req.json().catch(() => null)) as { names?: unknown } | null
  const names = [...new Set(Array.isArray(body?.names) ? body.names.filter(isMediaName) : [])].slice(0, 100)
  if (!names.length) return json({ urls: {}, expires_in: limits.getExpiresS })

  const { data, error } = await db.rpc('media_read_grant', { p_user: user, p_names: names })
  if (error) return json({ error: errorCode(error.message) }, 400)
  const rows = (data ?? []) as { name: string; store: 'r2' | 'supabase'; bucket: string }[]

  const urls: Record<string, string> = {}
  for (const r of rows) {
    if (r.store === 'r2' && r2) urls[r.name] = await r2.presign('GET', r.name, limits.getExpiresS)
  }
  const byBucket = new Map<string, string[]>()
  for (const r of rows) if (r.store === 'supabase') byBucket.set(r.bucket, [...(byBucket.get(r.bucket) ?? []), r.name])
  for (const [bucket, paths] of byBucket) {
    const { data: signed } = await db.storage.from(bucket).createSignedUrls(paths, limits.getExpiresS)
    for (const s of signed ?? []) if (s.signedUrl && s.path) urls[s.path] = s.signedUrl
  }
  return json({ urls, expires_in: limits.getExpiresS })
})
