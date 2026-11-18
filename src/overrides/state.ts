import type { GameEvent } from '../sync/types'

/**
 * Host overrides (host_override, docs/overrides.md). Every event an override appends carries
 * payload.override_id; when the override is undone (override_undone) phones drop those events
 * and derive state as if it never happened, matching the rows the server restored. The audit
 * events themselves (override, override_detail) always stay, for the timeline.
 */

const AUDIT = new Set(['override', 'override_detail'])
const str = (v: unknown) => (typeof v === 'string' ? v : null)

/** Override ids that are undone, honouring undos of undos (newest first wins). */
export function undoneOverrides(events: readonly GameEvent[]): Set<string> {
  const undone = new Set<string>()
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type !== 'override_undone') continue
    const by = str(e.payload.override_id)
    const target = str(e.payload.target_id)
    // This undo is itself undone: it no longer counts.
    if (by && undone.has(by)) continue
    if (target) undone.add(target)
  }
  return undone
}

/** The log every reducer should read: events of undone overrides left out. */
export function effectiveEvents(events: readonly GameEvent[]): readonly GameEvent[] {
  if (!events.some((e) => e.type === 'override_undone')) return events
  const undone = undoneOverrides(events)
  if (!undone.size) return events
  return events.filter((e) => {
    const id = str(e.payload.override_id)
    return !id || !undone.has(id) || AUDIT.has(e.type)
  })
}

export interface OverrideEntry {
  id: string
  seq: number
  at: number
  kind: string
  reason: string
  by: string | null
  /** Public one-liner. Hider-only overrides say only that something happened. */
  summary: string
  /** Hider phones: what exactly changed (override_detail). */
  detail: string | null
  private: boolean
  undone: boolean
  /** Undo: the override it undid. */
  targetId: string | null
  params: Record<string, unknown>
}

export interface OverrideRequest {
  id: string
  seq: number
  kind: string
  reason: string
  by: string | null
  params: Record<string, unknown>
  /** null while open. */
  resolution: 'approved' | 'declined' | null
}

export interface OverridesState {
  overrides: OverrideEntry[]
  requests: OverrideRequest[]
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** All overrides and requests from the full log (pass the raw events, not effectiveEvents). */
export function deriveOverrides(events: readonly GameEvent[]): OverridesState {
  const undone = undoneOverrides(events)
  const overrides: OverrideEntry[] = []
  const requests = new Map<string, OverrideRequest>()
  const details = new Map<string, string>()
  for (const e of events) {
    const p = e.payload
    if (e.type === 'override_detail' && str(p.override_id) && str(p.summary)) details.set(str(p.override_id)!, str(p.summary)!)
    if (e.type === 'override_requested' && str(p.request_id)) {
      requests.set(str(p.request_id)!, {
        id: str(p.request_id)!,
        seq: e.seq,
        kind: str(p.kind) ?? '',
        reason: str(p.reason) ?? '',
        by: str(p.by),
        params: isObject(p.params) ? p.params : {},
        resolution: null,
      })
    }
    if (e.type === 'override_declined') {
      const r = requests.get(str(p.request_id) ?? '')
      if (r) r.resolution = 'declined'
    }
    if (e.type === 'override' && str(p.override_id)) {
      const id = str(p.override_id)!
      overrides.push({
        id,
        seq: e.seq,
        at: Date.parse(e.created_at),
        kind: str(p.kind) ?? '',
        reason: str(p.reason) ?? '',
        by: str(p.by),
        summary: str(p.summary) ?? 'Host fixed something',
        detail: null,
        private: p.private === true,
        undone: undone.has(id),
        targetId: str(p.target_id),
        params: isObject(p.params) ? p.params : {},
      })
      const r = requests.get(str(p.request_id) ?? '')
      if (r) r.resolution = 'approved'
    }
  }
  return {
    overrides: overrides.map((o) => ({ ...o, detail: details.get(o.id) ?? null })),
    requests: [...requests.values()],
  }
}

export const openRequests = (s: OverridesState) => s.requests.filter((r) => r.resolution === null)
