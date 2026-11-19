// Delete an ended game for everyone (docs/admin.md). The phone POSTs { game_id,
// client_action_id } with its Supabase session. public.game_delete_media checks the caller is
// the game's host or an admin and the game has ended, and lists its media. This function
// deletes it: R2 objects (plus anything else under <game_id>/ in the bucket) and files in
// the Supabase buckets, through the Storage API (SQL deletes on storage.objects are blocked).
// Then it calls public.delete_game as the caller, which refuses media_left if anything is
// still there and otherwise deletes the game row (players, events and the track cascade).
//
//   { game_id, client_action_id }  ->  { deleted: true, media: <files removed> }  |  { error }

import { CORS_HEADERS, errorCode, gameFolder, json, r2Config } from '../_shared/media.ts'
import { r2Client } from '../_shared/r2.ts'
import { callerId, db } from '../_shared/supabase.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.119.0'

const cfg = r2Config((k) => Deno.env.get(k))
const r2 = cfg ? r2Client(cfg) : null

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
  const user = await callerId(req)
  if (!user) return json({ error: 'not_signed_in' }, 401)

  const body = (await req.json().catch(() => null)) as { game_id?: unknown; client_action_id?: unknown } | null
  const folder = gameFolder(body?.game_id)
  const actionId = typeof body?.client_action_id === 'string' ? body.client_action_id : crypto.randomUUID()
  if (!folder) return json({ error: 'game_not_found' }, 400)
  const gameId = folder.slice(0, -1)

  const { data, error } = await db.rpc('game_delete_media', { p_user: user, p_game_id: gameId })
  if (error) return json({ error: errorCode(error.message) }, 400)
  const rows = (data ?? []) as { name: string; store: 'r2' | 'supabase'; bucket: string }[]

  let removed = 0
  try {
    // R2: the recorded objects, and any stray under the game's folder.
    const inR2 = rows.filter((r) => r.store === 'r2').map((r) => r.name)
    if (r2) {
      const names = [...new Set([...inR2, ...(await r2.list(folder))])]
      for (const name of names) await r2.remove(name)
      removed += names.length
    } else if (inR2.length) {
      return json({ error: 'r2_not_set_up' }, 503)
    }
    if (inR2.length) {
      const { error: forgetError } = await db.rpc('media_forget', { p_game_id: gameId, p_names: inR2 })
      if (forgetError) throw new Error(forgetError.message)
    }

    // Supabase buckets, through the Storage API.
    const byBucket = new Map<string, string[]>()
    for (const r of rows) if (r.store === 'supabase') byBucket.set(r.bucket, [...(byBucket.get(r.bucket) ?? []), r.name])
    for (const [bucket, names] of byBucket) {
      for (let i = 0; i < names.length; i += 500) {
        const { error: rmError } = await db.storage.from(bucket).remove(names.slice(i, i + 500))
        if (rmError) throw new Error(rmError.message)
      }
      removed += names.length
    }
  } catch (e) {
    console.error('delete-game media', gameId, e)
    return json({ error: 'media_delete_failed' }, 502)
  }

  // The game itself, as the caller (delete_game checks again and refuses media_left).
  const asUser = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  })
  const { error: delError } = await asUser.rpc('delete_game', { p_game_id: gameId, p_client_action_id: actionId })
  if (delError) return json({ error: errorCode(delError.message) }, 400)
  console.log('game deleted', { game: gameId, by: user, media: removed })
  return json({ deleted: true, media: removed })
})
