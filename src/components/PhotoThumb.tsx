import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { isVideoPath, photoUrl } from '../play/photos'

/** Photo or video from a private bucket (signed URL): answer photos by default. Tap a photo to open full size. */
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
  const video = isVideoPath(path)
  if (failed) return <span className="muted">{video ? 'Video' : 'Photo'} unavailable</span>
  if (!url) return <span className="photo-thumb photo-loading" aria-label={video ? 'Loading video' : 'Loading photo'} />
  if (video) return <video className="photo-preview photo-link" src={url} controls playsInline preload="metadata" aria-label={alt} />
  return (
    <a href={url} target="_blank" rel="noreferrer" className="photo-link">
      <img className="photo-thumb" src={url} alt={alt} loading="lazy" />
    </a>
  )
}
