import { useEffect, useRef, useState } from 'react'
import { DRINK_BUCKET } from '../cards/state'
import { supabase } from '../lib/supabase'
import { describeError } from '../lobby/messages'
import { logPicked, uploadMedia, type UploadProgress } from '../play/media'
import { megabytes } from '../play/photos'
import type { GameSync } from '../sync/engine'
import { MediaBox } from './MediaBox'

export type ProofMedia = 'photo' | 'video'

interface Picked {
  folder: string
  file: File
  url: string
  kind: ProofMedia
}

/**
 * Pick (camera, photo library or a screenshot) and preview a photo or video, to upload under
 * `<game_id>/<folderId>/`: the original to R2, or the Supabase bucket (`bucket`) if R2 isn't
 * set up or is full (src/play/media.ts). Returns the picker box to render and upload().
 */
export function useMediaPick(
  sync: GameSync,
  folderId: string,
  media: ProofMedia = 'photo',
  disabled = false,
  bucket: string = DRINK_BUCKET,
) {
  const [picked, setPhoto] = useState<Picked | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)
  /** Object name per pick (its preview URL) once uploaded, so a failed action doesn't send the file again. */
  const sent = useRef(new Map<string, string>())
  useEffect(
    () => () => {
      if (picked) URL.revokeObjectURL(picked.url)
    },
    [picked],
  )
  // A pick belongs to its folder: another card selected starts empty.
  const photo = picked?.folder === folderId ? picked : null

  const pick = (file: File | undefined) => {
    if (!file) return
    setErr(null)
    logPicked(file)
    const kind: ProofMedia = file.type.startsWith('video/') ? 'video' : 'photo'
    setPhoto({ folder: folderId, file, url: URL.createObjectURL(file), kind })
  }
  /** Upload the picked file. Resolves its path; throws on failure. */
  const upload = async (): Promise<string> => {
    const p = photo
    if (!p || !supabase) throw new Error('Pick a photo or video first.')
    const done = sent.current.get(p.url)
    if (done) return done
    const onProgress = (u: UploadProgress) => {
      setBusy(u.label)
      setProgress(u.fraction)
    }
    try {
      const name = await uploadMedia(supabase, { gameId: sync.gameId, folderId, bucket }, p.file, onProgress)
      sent.current.set(p.url, name)
      return name
    } finally {
      setBusy(null)
      setProgress(null)
    }
  }
  const box = (
    <MediaBox
      media={media}
      picked={photo ? { url: photo.url, kind: photo.kind, note: `Picked ${megabytes(photo.file.size)}${photo.file.type ? ` · ${photo.file.type}` : ''}` } : null}
      disabled={disabled || !!busy}
      progress={busy ? { label: busy, fraction: progress } : null}
      onPick={pick}
    />
  )
  const clear = () => setPhoto(null)
  return { box, photo, busy, err, setErr, setBusy, upload, clear }
}

/** Pick, preview and send the photo or video for an open proof: upload, then submit_drink_proof. */
export function useProofPhoto(sync: GameSync, proofId: string, media: ProofMedia = 'photo', disabled = false) {
  const m = useMediaPick(sync, proofId, media, disabled)
  const { setErr, setBusy } = m
  /** Upload and submit. Resolves true once the server has it. */
  const send = async (): Promise<boolean> => {
    setErr(null)
    try {
      const path = await m.upload()
      setBusy('Sending…')
      const res = (await sync.action('submit_drink_proof', { p_proof_id: proofId, p_path: path })) as { seq?: number } | null
      // A follow-up action (We did it) must not race the drink_proved event.
      await sync.caughtUp(res?.seq)
      setBusy(null)
      return true
    } catch (e) {
      setErr(describeError(e))
      setBusy(null)
      return false
    }
  }
  return { box: m.box, photo: m.photo, busy: m.busy, err: m.err, setErr, setBusy, send }
}
