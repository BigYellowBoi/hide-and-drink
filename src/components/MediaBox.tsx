import { useId } from 'react'

interface Props {
  media: 'photo' | 'video'
  picked: { url: string; kind: 'photo' | 'video' } | null
  disabled?: boolean
  onPick: (file: File | undefined) => void
}

/**
 * Upload box for a photo or video. No `capture` attribute, so the phone offers the camera,
 * the photo library (screenshots included) or files. Shows the preview once picked; tap to change.
 */
export function MediaBox({ media, picked, disabled, onPick }: Props) {
  const id = useId()
  const what = media === 'video' ? 'video' : 'photo'
  return (
    <div className="media-pick">
      {picked &&
        (picked.kind === 'video' ? (
          <video className="photo-preview" src={picked.url} controls playsInline muted />
        ) : (
          <img className="photo-preview" src={picked.url} alt={`Your ${what}`} />
        ))}
      <label htmlFor={id} className={`media-box${picked ? ' media-box-picked' : ''}${disabled ? ' media-box-disabled' : ''}`}>
        <input
          id={id}
          type="file"
          accept={media === 'video' ? 'video/*' : 'image/*'}
          hidden
          disabled={disabled}
          onChange={(e) => {
            onPick(e.target.files?.[0])
            e.target.value = ''
          }}
        />
        <span className="media-box-icon" aria-hidden="true">
          {media === 'video' ? '🎥' : '📷'}
        </span>
        <span className="media-box-label">
          <strong>{picked ? `Change ${what}` : `Add ${what}`}</strong>
          <span className="muted small">
            {media === 'video' ? 'Record now or pick one from your videos' : 'Take one now, or pick from your photos or screenshots'}
          </span>
        </span>
      </label>
    </div>
  )
}
