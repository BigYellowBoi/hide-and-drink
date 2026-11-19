// Service-role client, and the signed-in caller from the request's JWT.

import { createClient } from 'npm:@supabase/supabase-js@2.119.0'

const env = (k: string) => {
  const v = Deno.env.get(k)
  if (!v) throw new Error(`missing ${k}`)
  return v
}

export const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
})

/** The caller's user id (anonymous sign-ins count), or null. */
export async function callerId(req: Request): Promise<string | null> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!token) return null
  const { data, error } = await db.auth.getUser(token)
  return error || !data.user ? null : data.user.id
}
