import { useEffect, useState } from 'react'
import { DRINK_BUCKET } from '../cards/state'
import { supabase } from '../lib/supabase'
import { describeError } from '../lobby/messages'
import { MAX_VIDEO_BYTES, megabytes, photoPath, shrinkPhoto, squeezeVideo, uploadPhoto, videoPath, videoType } from '../play/photos'
import type { GameSync } from '../sync/engine'
import { MediaBox } from './MediaBox'

export type ProofMedia = 'photo' | 'video'

interface Picked {
  blob: Blob
  url: string
  path: string
  contentType: string
  kind: ProofMedia
}

/**
 * Pick (camera, photo library or a screenshot), preview and send the photo or video for an
 * open proof: upload to drink-photos, then submit_drink_proof. Videos over the free plan's
 * 50 MB cap are squeezed on the phone first. Returns the picker box to render and the actions.
 */
export function useProofPhoto(sync: GameSync, proofId: string, media: ProofMedia = 'photo', disabled = false) {
  const [photo, setPhoto] = useState<Picked | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(
    () => () => {
      if (photo) URL.revokeObjectURL(photo.url)
    },
    [photo],
  )

  const pick = async (file: File | undefined) => {
    if (!file) return
    setErr(null)
    try {
      if (file.type.startsWith('video/')) {
        let blob: Blob = file
        if (blob.size > MAX_VIDEO_BYTES) {
          setBusy(`Shrinking ${megabytes(blob.size)} video…`)
          blob = await squeezeVideo(file, (done, total) =>
            setBusy(`Shrinking video ${Math.floor(done)} of ${Math.round(total)} s (keep the app open)…`),
          )
          if (blob.size > MAX_VIDEO_BYTES) throw new Error(`Still ${megabytes(blob.size)} after shrinking (max 48 MB). Trim it and try again.`)
        }
        const t = videoType(blob)
        if (!t) throw new Error('That video format is not supported. Try recording it again.')
        setPhoto({ blob, url: URL.createObjectURL(blob), path: videoPath(sync.gameId, proofId, t.ext), contentType: t.contentType, kind: 'video' })
      } else {
        setBusy('Preparing photo…')
        const blob = await shrinkPhoto(file)
        setPhoto({ blob, url: URL.createObjectURL(blob), path: photoPath(sync.gameId, proofId), contentType: 'image/jpeg', kind: 'photo' })
      }
    } catch (e) {
      setErr(describeError(e))
    } finally {
      setBusy(null)
    }
  }
  /** Upload and submit. Resolves true once the server has it. */
  const send = async (): Promise<boolean> => {
    if (!photo || !supabase) return false
    setErr(null)
    try {
      setBusy(photo.kind === 'video' ? `Uploading video (${megabytes(photo.blob.size)})…` : 'Uploading photo…')
      const path = await uploadPhoto(supabase, photo.path, photo.blob, DRINK_BUCKET, photo.contentType)
      setBusy('Sending…')
      await sync.action('submit_drink_proof', { p_proof_id: proofId, p_path: path })
      setBusy(null)
      return true
    } catch (e) {
      setErr(describeError(e))
      setBusy(null)
      return false
    }
  }
  const box = (
    <MediaBox
      media={media}
      picked={photo ? { url: photo.url, kind: photo.kind } : null}
      disabled={disabled || !!busy}
      onPick={(f) => void pick(f)}
    />
  )
  return { box, photo, busy, err, setErr, setBusy, send }
}
