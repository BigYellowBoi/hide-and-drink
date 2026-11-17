import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'

const KNOB = 56
const THRESHOLD = 0.85

interface Props {
  label: string
  disabled?: boolean
  onConfirm: () => void
}

/**
 * Slide-to-confirm pill for irreversible actions (docs/design.md). Drag the navy knob to the
 * end to confirm; letting go early snaps it back. Keyboard: focus the knob and press Enter.
 */
export function SlideToConfirm({ label, disabled = false, onConfirm }: Props) {
  const trackRef = useRef<HTMLDivElement>(null)
  const start = useRef<{ x: number; max: number } | null>(null)
  const [offset, setOffset] = useState(0)
  /** Drag distance to the end while dragging, null otherwise. */
  const [dragMax, setDragMax] = useState<number | null>(null)

  const reset = () => {
    start.current = null
    setDragMax(null)
    setOffset(0)
  }

  const onDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (disabled || !trackRef.current) return
    const max = trackRef.current.clientWidth - KNOB - 8
    start.current = { x: e.clientX, max }
    setDragMax(max)
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onMove = (e: PointerEvent<HTMLButtonElement>) => {
    const s = start.current
    if (!s) return
    setOffset(Math.min(s.max, Math.max(0, e.clientX - s.x)))
  }

  const onUp = () => {
    const s = start.current
    const done = s !== null && s.max > 0 && offset / s.max >= THRESHOLD
    reset()
    if (done) onConfirm()
  }

  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Enter' && !disabled) onConfirm()
  }

  const dragging = dragMax !== null
  return (
    <div ref={trackRef} className={`slide${disabled ? ' slide-disabled' : ''}`}>
      <span className="slide-label" style={{ opacity: dragging && dragMax > 0 ? 1 - offset / dragMax : 1 }}>
        {label}
      </span>
      <button
        type="button"
        className="slide-knob"
        aria-label={`${label}: slide right to confirm, or press Enter`}
        disabled={disabled}
        style={{ transform: `translateX(${offset}px)`, transition: dragging ? 'none' : undefined }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={reset}
        onKeyDown={onKey}
      >
        <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
          <path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  )
}
