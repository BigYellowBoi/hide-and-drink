import { useContext, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { isVideoPath, photoUrl } from '../play/photos'
import { MediaSourceContext } from '../replay/mediaSource'

/** Photo or video from a private bucket (signed URL): answer photos by default. Tap a photo to open full size. */
export function PhotoThumb({ path, bucket, alt = 'Answer photo' }: { path: string; bucket?: string; alt?: string }) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  // A saved game opened from its zip shows the files in the zip.
  const source = useContext(MediaSourceContext)
  useEffect(() => {
    const client = supabase
    const get = source ?? (client ? (p: string) => photoUrl(client, p, bucket) : null)
    if (!get) return
    let live = true
    get(path)
      .then((u) => live && setUrl(u))
      .catch(() => live && setFailed(true))
    return () => {
      live = false
    }
  }, [path, bucket, source])
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
