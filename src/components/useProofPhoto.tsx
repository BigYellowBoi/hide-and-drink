import { useEffect, useRef, useState } from 'react'
import { DRINK_BUCKET } from '../cards/state'
import { supabase } from '../lib/supabase'
import { describeError } from '../lobby/messages'
import { photoPath, shrinkPhoto, uploadPhoto } from '../play/photos'
import type { GameSync } from '../sync/engine'

/**
 * Take, preview and send a photo for an open proof: upload to drink-photos, then
 * submit_drink_proof. Returns the file input to render, the preview and the actions.
 */
export function useProofPhoto(sync: GameSync, proofId: string) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [photo, setPhoto] = useState<{ blob: Blob; url: string; path: string } | null>(null)
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
    setBusy('Preparing photo…')
    try {
      const blob = await shrinkPhoto(file)
      setPhoto({ blob, url: URL.createObjectURL(blob), path: photoPath(sync.gameId, proofId) })
    } catch (e) {
      setErr(describeError(e))
    } finally {
      setBusy(null)
    }
  }
  /** Upload and submit. Resolves true once the server has the photo. */
  const send = async (): Promise<boolean> => {
    if (!photo || !supabase) return false
    setErr(null)
    try {
      setBusy('Uploading photo…')
      const path = await uploadPhoto(supabase, photo.path, photo.blob, DRINK_BUCKET)
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
  const input = (
    <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => void pick(e.target.files?.[0])} />
  )
  return { input, photo, busy, err, setErr, setBusy, take: () => fileRef.current?.click(), send }
}
