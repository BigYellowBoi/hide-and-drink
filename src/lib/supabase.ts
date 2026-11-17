import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Set these in .env.local for development and as GitHub repository variables for deploys.
// The anon key is safe to ship to the browser: access is enforced by row-level security.
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const supabaseConfigured = Boolean(url && anonKey)

export const supabase: SupabaseClient | null = supabaseConfigured
  ? createClient(url!, anonKey!, {
      auth: { persistSession: true, autoRefreshToken: true },
      realtime: { params: { eventsPerSecond: 20 } },
    })
  : null

/**
 * Round-trip check against the Supabase API. Returns latency in ms, or throws.
 * Uses the auth settings endpoint, which needs no tables or sign-in.
 */
export async function pingSupabase(): Promise<number> {
  if (!url || !anonKey) throw new Error('Supabase is not configured')
  const started = performance.now()
  const res = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: anonKey } })
  if (!res.ok) throw new Error(`Supabase responded ${res.status}`)
  return Math.round(performance.now() - started)
}
