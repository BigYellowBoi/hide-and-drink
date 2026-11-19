// Shared by media-upload-url and media-read-url (docs/r2.md). No Deno or npm imports here,
// so the unit tests (src/lib/mediaFunctions.test.ts) can load it too.

type Env = (key: string) => string | undefined

export interface R2Config {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
}

/** The four R2 secrets, or null if any is missing (the app then uses the Supabase buckets). */
export function r2Config(env: Env): R2Config | null {
  const accountId = env('R2_ACCOUNT_ID')?.trim()
  const accessKeyId = env('R2_ACCESS_KEY_ID')?.trim()
  const secretAccessKey = env('R2_SECRET_ACCESS_KEY')?.trim()
  const bucket = env('R2_BUCKET')?.trim()
  return accountId && accessKeyId && secretAccessKey && bucket ? { accountId, accessKeyId, secretAccessKey, bucket } : null
}

export interface MediaLimits {
  /** Total bytes kept in R2. R2's free plan stores 10 GB a month; stay under it. */
  budgetBytes: number
  /** Reduced-quality videos (card params.video_quality) stay original only under this share of the budget. */
  reducedShare: number
  /** Sanity cap for one file. */
  maxFileBytes: number
  /** Presigned URL lifetimes, seconds. */
  putExpiresS: number
  getExpiresS: number
}

export const DEFAULT_LIMITS: MediaLimits = {
  budgetBytes: 9_000_000_000,
  reducedShare: 0.5,
  maxFileBytes: 2_000_000_000,
  putExpiresS: 900,
  getExpiresS: 3600,
}

/** Free plan ceiling: never let a setting push the budget past it. */
export const R2_FREE_BYTES = 10_000_000_000

const num = (v: string | undefined, fallback: number, min: number, max: number) => {
  const n = Number(v)
  return v && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

/** Limits, with optional overrides R2_BUDGET_BYTES, R2_REDUCED_SHARE, R2_MAX_FILE_BYTES. */
export function mediaLimits(env: Env): MediaLimits {
  return {
    ...DEFAULT_LIMITS,
    budgetBytes: num(env('R2_BUDGET_BYTES'), DEFAULT_LIMITS.budgetBytes, 0, R2_FREE_BYTES * 0.95),
    reducedShare: num(env('R2_REDUCED_SHARE'), DEFAULT_LIMITS.reducedShare, 0, 1),
    maxFileBytes: num(env('R2_MAX_FILE_BYTES'), DEFAULT_LIMITS.maxFileBytes, 1, 5_000_000_000),
  }
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
/** <game_id>/<folder id>/<file>.<ext>, as the buckets (public._photo_path_ids). */
export const MEDIA_NAME = new RegExp(`^${UUID}/${UUID}/[A-Za-z0-9_-]{1,64}\\.(jpg|jpeg|png|webp|mp4|mov|webm)$`)

export const isMediaName = (v: unknown): v is string => typeof v === 'string' && MEDIA_NAME.test(v)

/** Object URL in the bucket (path-style; names only use URL-safe characters). */
export const objectUrl = (cfg: R2Config, name: string) =>
  `https://${cfg.accountId}.r2.cloudflarestorage.com/${encodeURIComponent(cfg.bucket)}/${name}`

/** What the phone says its picker handed over, trimmed to known fields. Logged and kept with the row. */
export function cleanPicked(v: unknown): Record<string, unknown> {
  const p = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  if (typeof p.bytes === 'number' && Number.isFinite(p.bytes)) out.bytes = Math.round(p.bytes)
  if (typeof p.type === 'string') out.type = p.type.slice(0, 100)
  if (typeof p.name === 'string') out.name = p.name.slice(0, 120)
  if (typeof p.user_agent === 'string') out.user_agent = p.user_agent.slice(0, 300)
  if (typeof p.width === 'number') out.width = Math.round(p.width)
  if (typeof p.height === 'number') out.height = Math.round(p.height)
  if (p.squeezed === true) out.squeezed = true
  return out
}

/** The snake_case code from a Postgres error ("media_not_allowed"), else a generic one. */
export const errorCode = (message: string | undefined) =>
  message && /^[a-z][a-z0-9_]{2,60}$/.test(message.trim()) ? message.trim() : 'media_error'

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } })
