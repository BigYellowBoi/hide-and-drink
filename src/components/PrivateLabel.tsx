import { useContext } from 'react'
import { HiderCountContext } from './hiderCount'

/** Lock eyebrow on hider-only screens: "Only you see this", or "Only your team sees this" with 2+ hiders. */
export function PrivateLabel() {
  const n = useContext(HiderCountContext)
  return (
    <p className="eyebrow">
      <LockIcon /> {n > 1 ? 'Only your team sees this' : 'Only you see this'}
    </p>
  )
}

export function LockIcon() {
  return (
    <svg className="lock-icon" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" fill="currentColor" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" strokeWidth="2.2" />
    </svg>
  )
}
