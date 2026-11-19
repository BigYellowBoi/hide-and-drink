import { useId } from 'react'

interface Props {
  media: 'photo' | 'video'
  /** note: size and type of the picked file, so we can see what the phone handed over. */
  picked: { url: string; kind: 'photo' | 'video'; note?: string } | null
  disabled?: boolean
  /** Upload under way: label, and the share sent when known. */
  progress?: { label: string; fraction: number | null } | null
  onPick: (file: File | undefined) => void
}

/**
 * Upload box for a photo or video. No `capture` attribute, so the phone offers the camera,
 * the photo library (screenshots included) or files. Shows the preview once picked; tap to change.
 */
export function MediaBox({ media, picked, disabled, progress, onPick }: Props) {
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
            {picked?.note
              ? picked.note
              : media === 'video'
                ? 'Record now or pick one from your videos'
                : 'Take one now, or pick from your photos or screenshots'}
          </span>
        </span>
      </label>
      {progress && (
        <div className="media-progress" role="status">
          <progress max={1} value={progress.fraction ?? undefined} aria-label={progress.label} />
          <span className="muted small">{progress.label}</span>
        </div>
      )}
    </div>
  )
}
