import type { SupabaseClient } from '@supabase/supabase-js'

/** Answer photos: private Storage bucket, path <game_id>/<question_id>/<file>. */
export const PHOTO_BUCKET = 'question-photos'
const MAX_SIDE = 1600

/** Downscale to at most 1600 px and re-encode as JPEG, so uploads are quick on mobile data. */
export async function shrinkPhoto(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
  const w = Math.round(bitmap.width * scale)
  const h = Math.round(bitmap.height * scale)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not read that photo.'))), 'image/jpeg', 0.82),
  )
}

/** Upload; returns the path to send with answer_question. Upserts so a retry is harmless. */
export async function uploadPhoto(
  client: SupabaseClient,
  path: string,
  photo: Blob,
  bucket = PHOTO_BUCKET,
  contentType = 'image/jpeg',
): Promise<string> {
  const { error } = await client.storage.from(bucket).upload(path, photo, { contentType, upsert: false })
  if (error && !/exists|duplicate/i.test(error.message)) throw new Error(error.message)
  return path
}

interface Pending {
  path: string
  bucket: string
  resolve: (url: string) => void
  reject: (e: Error) => void
}

/** Read URLs last an hour; refetch a little before. */
const URL_TTL_MS = 50 * 60 * 1000
const urls = new Map<string, { url: Promise<string>; at: number }>()
let queue: Pending[] = []
let flushing: ReturnType<typeof setTimeout> | null = null

/** Old way, if media-read-url isn't deployed or reachable: a signed Storage URL (same rules, by RLS). */
async function storageUrl(client: SupabaseClient, path: string, bucket: string): Promise<string> {
  const { data, error } = await client.storage.from(bucket).createSignedUrl(path, 3600)
  if (error || !data) throw new Error(error?.message ?? 'Photo not available')
  return data.signedUrl
}

async function flush(client: SupabaseClient) {
  flushing = null
  const batch = queue.splice(0, 100)
  if (queue.length) flushing = setTimeout(() => void flush(client), 0)
  let granted: Record<string, string> | null = null
  try {
    const { data, error } = await client.functions.invoke('media-read-url', { body: { names: batch.map((b) => b.path) } })
    if (!error && data && typeof data === 'object' && 'urls' in data) granted = (data as { urls: Record<string, string> }).urls
  } catch {
    granted = null
  }
  for (const b of batch) {
    if (granted) {
      // Left out: this team may not see it (or it is gone).
      if (granted[b.path]) b.resolve(granted[b.path])
      else b.reject(new Error('Photo not available'))
    } else {
      storageUrl(client, b.path, b.bucket).then(b.resolve, b.reject)
    }
  }
}

/**
 * Read URL (1 h) for showing a photo or video: from media-read-url (R2 or Storage, only
 * what this phone's team may see; batched), else a signed Storage URL. Cached per session.
 */
export function photoUrl(client: SupabaseClient, path: string, bucket = PHOTO_BUCKET): Promise<string> {
  const key = `${bucket}/${path}`
  const hit = urls.get(key)
  if (hit && Date.now() - hit.at < URL_TTL_MS) return hit.url
  const url = new Promise<string>((resolve, reject) => {
    queue.push({ path, bucket, resolve, reject })
    flushing ??= setTimeout(() => void flush(client), 20)
  })
  urls.set(key, { url, at: Date.now() })
  url.catch(() => urls.delete(key))
  return url
}

// ------------------------------------------------------------------- videos

/**
 * Supabase's free plan caps one file at 50 MB (the drink-photos bucket limit). On the
 * Supabase path (no R2, or R2 full: src/play/media.ts) videos over this are squeezed first.
 */
export const MAX_VIDEO_BYTES = 48 * 1024 * 1024
/** Bitrate for squeezed videos: 5 min at 480p comes out around 30 MB. */
const SQUEEZE_BPS = 750_000
const SQUEEZE_SIDE = 854

const VIDEO_EXT: Record<string, string> = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' }

/** Object names ending in a video extension are videos (drink-photos takes both). */
export const isVideoPath = (path: string) => /\.(mp4|mov|webm)$/i.test(path)

/** The upload content type and file extension for a video blob, or null if unsupported. */
export function videoType(blob: Blob): { contentType: string; ext: string } | null {
  const type = blob.type.split(';')[0].toLowerCase()
  const ext = VIDEO_EXT[type]
  return ext ? { contentType: type, ext } : null
}

export const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`

/** Recorder type the browser can write: mp4 (Safari, newer Chrome) first, then webm. */
function recorderType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null
  for (const t of ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
    if (MediaRecorder.isTypeSupported(t)) return t
  }
  return null
}

/**
 * Re-encode a video smaller by playing it into a canvas and recording that at a low bitrate.
 * Runs in real time (a 5 min video takes 5 min) so the length stays exact; no sound.
 * onProgress gets seconds done and the total.
 */
export async function squeezeVideo(file: Blob, onProgress: (done: number, total: number) => void): Promise<Blob> {
  const type = recorderType()
  const canvas = document.createElement('canvas')
  if (!type || typeof canvas.captureStream !== 'function') {
    throw new Error("This phone can't shrink videos. Trim it in your Photos app and try again.")
  }
  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.src = url
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve()
      video.onerror = () => reject(new Error('Could not read that video.'))
    })
    const scale = Math.min(1, SQUEEZE_SIDE / Math.max(video.videoWidth || SQUEEZE_SIDE, video.videoHeight || SQUEEZE_SIDE))
    canvas.width = Math.max(2, Math.round((video.videoWidth || 640) * scale / 2) * 2)
    canvas.height = Math.max(2, Math.round((video.videoHeight || 480) * scale / 2) * 2)
    const ctx = canvas.getContext('2d')!
    const stream = canvas.captureStream(30)
    const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: SQUEEZE_BPS })
    const chunks: Blob[] = []
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
    const stopped = new Promise<void>((resolve) => (rec.onstop = () => resolve()))
    let raf = 0
    const draw = () => {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      onProgress(video.currentTime, video.duration || 0)
      raf = requestAnimationFrame(draw)
    }
    rec.start(1000)
    await video.play()
    draw()
    await new Promise<void>((resolve, reject) => {
      video.onended = () => resolve()
      video.onerror = () => reject(new Error('Could not read that video.'))
    })
    cancelAnimationFrame(raf)
    rec.stop()
    await stopped
    stream.getTracks().forEach((t) => t.stop())
    return new Blob(chunks, { type: type.split(';')[0] })
  } finally {
    video.pause()
    video.removeAttribute('src')
    URL.revokeObjectURL(url)
  }
}
