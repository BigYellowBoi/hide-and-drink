import type { Presence } from '../sync/presence'

export function PresenceDot({ online }: { online: Presence }) {
  const label = online === null ? 'Unknown' : online ? 'App open' : 'Away'
  const cls = online === null ? 'unknown' : online ? 'online' : 'away'
  return <span className={`presence-dot presence-${cls}`} role="img" aria-label={label} title={label} />
}

