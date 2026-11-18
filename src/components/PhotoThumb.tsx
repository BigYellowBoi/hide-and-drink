import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { photoUrl } from '../play/photos'

/** Photo from a private bucket (signed URL): answer photos by default. Tap to open full size. */
export function PhotoThumb({ path, bucket, alt = 'Answer photo' }: { path: string; bucket?: string; alt?: string }) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!supabase) return
    let live = true
    photoUrl(supabase, path, bucket)
      .then((u) => live && setUrl(u))
      .catch(() => live && setFailed(true))
    return () => {
      live = false
    }
  }, [path, bucket])
  if (failed) return <span className="muted">Photo unavailable</span>
  if (!url) return <span className="photo-thumb photo-loading" aria-label="Loading photo" />
  return (
    <a href={url} target="_blank" rel="noreferrer" className="photo-link">
      <img className="photo-thumb" src={url} alt={alt} loading="lazy" />
    </a>
  )
}
