/** true = app open, false = away, null = unknown (this phone isn't live, so its list may be old). */
export type Presence = boolean | null

/** Presence lookup for player rows: unknown unless we're live. */
export function presenceOf(present: readonly string[], live: boolean): (userId: string) => Presence {
  const set = new Set(present)
  return (userId) => (live ? set.has(userId) : null)
}
