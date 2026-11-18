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
export async function uploadPhoto(client: SupabaseClient, path: string, photo: Blob, bucket = PHOTO_BUCKET): Promise<string> {
  const { error } = await client.storage.from(bucket).upload(path, photo, { contentType: 'image/jpeg', upsert: false })
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
