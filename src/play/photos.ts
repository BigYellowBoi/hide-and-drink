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

/** <game_id>/<question or proof id>/<file>.jpg */
export const photoPath = (gameId: string, ownerId: string, fileId: string = crypto.randomUUID()) =>
  `${gameId}/${ownerId}/${fileId.replace(/[^A-Za-z0-9_-]/g, '')}.jpg`

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

const urls = new Map<string, Promise<string>>()

/** Signed URL (1 h) for showing a photo; cached per session. */
export function photoUrl(client: SupabaseClient, path: string, bucket = PHOTO_BUCKET): Promise<string> {
  const key = `${bucket}/${path}`
  let p = urls.get(key)
  if (!p) {
    p = client.storage
      .from(bucket)
      .createSignedUrl(path, 3600)
      .then(({ data, error }) => {
        if (error || !data) throw new Error(error?.message ?? 'Photo not available')
        return data.signedUrl
      })
    urls.set(key, p)
    p.catch(() => urls.delete(key))
  }
  return p
}

// ------------------------------------------------------------------- videos

/**
 * Supabase's free plan caps one file at 50 MB (the drink-photos bucket limit). Videos over
 * this are squeezed on the phone first; a little headroom under the cap.
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

/** <game_id>/<owner id>/<file>.<ext> for a video. */
export const videoPath = (gameId: string, ownerId: string, ext: string, fileId: string = crypto.randomUUID()) =>
  `${gameId}/${ownerId}/${fileId.replace(/[^A-Za-z0-9_-]/g, '')}.${ext}`

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
