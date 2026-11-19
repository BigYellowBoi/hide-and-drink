import { FunctionsFetchError, FunctionsHttpError, FunctionsRelayError, type SupabaseClient } from '@supabase/supabase-js'
import { MAX_VIDEO_BYTES, megabytes, shrinkPhoto, squeezeVideo, uploadPhoto, videoType } from './photos'

/**
 * Uploads to Cloudflare R2 (docs/r2.md): the phone asks the Edge Function media-upload-url
 * for a presigned PUT, sends the original file straight to R2 with progress and retries, then
 * confirms. The function may ask for a reduced-quality video to be squeezed first, or send
 * the upload to the Supabase buckets (R2 not set up, or full): then photos are shrunk and big
 * videos squeezed, as before.
 */

/** Sanity cap for one original file. */
export const MAX_ORIGINAL_BYTES = 2_000_000_000

export interface UploadProgress {
  /** What is happening, ready to show. */
  label: string
  /** 0..1 while sending bytes with known progress, else null. */
  fraction: number | null
}

export interface UploadTarget {
  gameId: string
  /** The question, proof or card the file belongs to. */
  folderId: string
  /** Supabase bucket for the fallback path. */
  bucket: string
}

/** What the picker handed over: logged here and by the function, and kept with the R2 row. */
export interface PickedInfo {
  bytes: number
  type: string
  name: string
  user_agent: string
  squeezed?: boolean
}

export function pickedInfo(file: Blob): PickedInfo {
  return {
    bytes: file.size,
    type: file.type,
    name: file instanceof File ? file.name : '',
    user_agent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
  }
}

/** Log the picked file so we can check whether iPhones hand over originals or converted copies. */
export function logPicked(file: Blob) {
  const p = pickedInfo(file)
  console.info(`[media] picked ${p.name || 'file'}: ${p.bytes} bytes (${megabytes(p.bytes)}), ${p.type || 'no type'}`)
  return p
}

const PHOTO_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }

/** Upload type and extension for a photo kept as it is, or null (HEIC and the like: converted). */
export function photoType(blob: Blob): { contentType: string; ext: string } | null {
  const type = blob.type.split(';')[0].toLowerCase()
  const ext = PHOTO_TYPES[type]
  return ext ? { contentType: type, ext } : null
}

/** Full-size JPEG of a photo in a format other phones can't show (e.g. HEIC). */
async function fullJpeg(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
  bitmap.close()
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not read that photo.'))), 'image/jpeg', 0.95),
  )
}

/** <game_id>/<folder>/<random>.<ext> */
export const mediaName = (gameId: string, folderId: string, ext: string, fileId: string = crypto.randomUUID()) =>
  `${gameId}/${folderId}/${fileId.replace(/[^A-Za-z0-9_-]/g, '')}.${ext}`

export type Grant =
  | { store: 'r2'; url: string; bucket: string; quality: string }
  | { store: 'supabase'; reason: string }
  | { squeeze: true }

/** An upload refused by the function (not allowed, too big, ...): don't retry, don't fall back. */
export class MediaError extends Error {
  readonly code: string
  constructor(code: string) {
    super(MEDIA_MESSAGES[code] ?? code.replace(/_/g, ' '))
    this.code = code
  }
}

const MEDIA_MESSAGES: Record<string, string> = {
  media_too_big: 'That file is too big (over 2 GB). Trim it and try again.',
  media_not_allowed: 'You can no longer send media for this.',
  media_exists: 'That file was already sent.',
  media_not_uploaded: 'The upload did not arrive. Try again.',
  invalid_media_type: 'That file type is not supported here.',
  invalid_media_path: 'That upload is not for this game.',
  invalid_media_size: 'That file looks empty. Pick it again.',
  storage_full: 'Media storage is full. Try again.',
  not_signed_in: 'Signed out. Reopen the app and try again.',
}

/** Call an Edge Function; null if it isn't there or can't be reached (the caller falls back). */
async function invoke<T>(client: SupabaseClient, fn: string, body: Record<string, unknown>): Promise<T | null> {
  const { data, error } = await client.functions.invoke(fn, { body })
  if (!error) return data as T
  if (error instanceof FunctionsFetchError || error instanceof FunctionsRelayError) return null
  if (error instanceof FunctionsHttpError) {
    const res = error.context as Response
    if (res.status === 404) return null
    const payload = (await res.json().catch(() => null)) as { error?: string } | null
    if (payload?.error && res.status < 500) throw new MediaError(payload.error)
    return null
  }
  return null
}

export async function requestGrant(
  client: SupabaseClient,
  name: string,
  blob: Blob,
  contentType: string,
  picked: PickedInfo,
): Promise<Grant> {
  const grant = await invoke<Grant>(client, 'media-upload-url', { name, bytes: blob.size, content_type: contentType, picked: { ...picked } })
  return grant ?? { store: 'supabase', reason: 'function_unavailable' }
}

/** HTTP status of a failed PUT (0: network). */
export class PutError extends Error {
  readonly status: number
  constructor(status: number) {
    super(status ? `Upload failed (${status})` : 'Upload interrupted')
    this.status = status
  }
}

/** PUT a blob to a presigned URL, reporting bytes sent. */
export function putWithProgress(
  url: string,
  blob: Blob,
  contentType: string,
  onProgress: (loaded: number, total: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.setRequestHeader('Content-Type', contentType)
    xhr.upload.onprogress = (e) => onProgress(e.loaded, e.lengthComputable ? e.total : blob.size)
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new PutError(xhr.status)))
    xhr.onerror = () => reject(new PutError(0))
    xhr.ontimeout = () => reject(new PutError(0))
    xhr.send(blob)
  })
}

/** Network trouble, an expired URL (403) or a server hiccup: worth another go. */
export const retryable = (e: unknown) =>
  e instanceof PutError && (e.status === 0 || e.status === 403 || e.status === 408 || e.status === 429 || e.status >= 500)

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Run fn up to attempts times while retry(error) says so, waiting delays[i] between goes. */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  retry: (e: unknown) => boolean,
  delays: readonly number[] = [2000, 5000, 10000],
  wait: (ms: number) => Promise<void> = sleep,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt)
    } catch (e) {
      if (attempt >= delays.length || !retry(e)) throw e
      await wait(delays[attempt])
    }
  }
}

const percentLabel = (what: string, loaded: number, total: number, attempt: number) =>
  `Uploading ${what} ${Math.floor((loaded / Math.max(total, 1)) * 100)}% (${megabytes(loaded)} of ${megabytes(total)})` +
  (attempt ? `, try ${attempt + 1}` : '') +
  '…'

/**
 * Upload a picked photo or video. Resolves the object name to send with the action. Keeps
 * the original in R2 when the function allows it; otherwise the Supabase path.
 */
export async function uploadMedia(
  client: SupabaseClient,
  target: UploadTarget,
  file: Blob,
  onProgress: (p: UploadProgress) => void,
  retryDelays: readonly number[] = [2000, 5000, 10000],
): Promise<string> {
  const video = file.type.startsWith('video/')
  const what = video ? 'video' : 'photo'
  if (file.size > MAX_ORIGINAL_BYTES) throw new MediaError('media_too_big')
  const picked = pickedInfo(file)

  let blob = file
  let type = video ? videoType(file) : photoType(file)
  if (!type && video) throw new Error('That video format is not supported. Try recording it again.')
  if (!type) {
    onProgress({ label: 'Preparing photo…', fraction: null })
    blob = await fullJpeg(file)
    type = { contentType: 'image/jpeg', ext: 'jpg' }
  }

  for (let squeezes = 0; ; ) {
    const name = mediaName(target.gameId, target.folderId, type.ext)
    onProgress({ label: `Getting ready to upload the ${what}…`, fraction: null })
    let grant = await requestGrant(client, name, blob, type.contentType, picked)

    if ('squeeze' in grant) {
      if (squeezes++) throw new MediaError('storage_full')
      blob = await squeezeVideo(blob, (done, total) =>
        onProgress({ label: `Shrinking video ${Math.floor(done)} of ${Math.round(total)} s (keep the app open)…`, fraction: total ? done / total : null }),
      )
      type = videoType(blob)
      if (!type) throw new Error('That video format is not supported. Try recording it again.')
      picked.squeezed = true
      continue
    }

    if (grant.store === 'r2') {
      const t = type
      const sent = await withRetry(async (attempt) => {
        // A fresh URL for each retry, in case the last one expired.
        if (attempt) grant = await requestGrant(client, name, blob, t.contentType, picked)
        if (!('store' in grant) || grant.store !== 'r2') return false
        await putWithProgress(grant.url, blob, t.contentType, (loaded, total) =>
          onProgress({ label: percentLabel(what, loaded, total, attempt), fraction: loaded / Math.max(total, 1) }),
        )
        return true
      }, retryable, retryDelays)
      if (sent) {
        onProgress({ label: `Checking the ${what} arrived…`, fraction: 1 })
        await withRetry(
          async () => {
            const ok = await invoke<{ ok?: boolean }>(client, 'media-upload-url', { name, done: true })
            if (!ok?.ok) throw new PutError(0)
          },
          (e) => e instanceof PutError || (e instanceof MediaError && e.code === 'media_not_uploaded'),
          retryDelays.slice(0, 2),
        )
        return name
      }
      // The function changed its mind (budget): the Supabase path below.
    }

    return uploadToSupabase(client, target, blob, video, onProgress)
  }
}

/** The pre-R2 path: photos shrunk to 1600 px JPEG, videos over 48 MB squeezed. */
async function uploadToSupabase(
  client: SupabaseClient,
  target: UploadTarget,
  file: Blob,
  video: boolean,
  onProgress: (p: UploadProgress) => void,
): Promise<string> {
  if (!video) {
    onProgress({ label: 'Preparing photo…', fraction: null })
    const blob = await shrinkPhoto(file)
    onProgress({ label: 'Uploading photo…', fraction: null })
    return uploadPhoto(client, mediaName(target.gameId, target.folderId, 'jpg'), blob, target.bucket, 'image/jpeg')
  }
  let blob = file
  if (blob.size > MAX_VIDEO_BYTES) {
    onProgress({ label: `Shrinking ${megabytes(blob.size)} video…`, fraction: null })
    blob = await squeezeVideo(file, (done, total) =>
      onProgress({ label: `Shrinking video ${Math.floor(done)} of ${Math.round(total)} s (keep the app open)…`, fraction: total ? done / total : null }),
    )
    if (blob.size > MAX_VIDEO_BYTES) throw new Error(`Still ${megabytes(blob.size)} after shrinking (max 48 MB). Trim it and try again.`)
  }
  const t = videoType(blob)
  if (!t) throw new Error('That video format is not supported. Try recording it again.')
  onProgress({ label: `Uploading video (${megabytes(blob.size)})…`, fraction: null })
  return uploadPhoto(client, mediaName(target.gameId, target.folderId, t.ext), blob, target.bucket, t.contentType)
}
