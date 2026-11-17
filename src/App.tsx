import { useEffect, useState } from 'react'
import { pingSupabase, supabaseConfigured } from './lib/supabase'
import { copiesByCategory, deckSize, questionTypes } from './lib/seed'
import { SyncCheck } from './components/SyncCheck'

type Status = { state: 'checking' } | { state: 'ok'; ms: number } | { state: 'error'; message: string }

export default function App() {
  const [status, setStatus] = useState<Status>(
    supabaseConfigured ? { state: 'checking' } : { state: 'error', message: 'Not configured' },
  )

  useEffect(() => {
    if (!supabaseConfigured) return
    pingSupabase()
      .then((ms) => setStatus({ state: 'ok', ms }))
      .catch((e: unknown) => setStatus({ state: 'error', message: e instanceof Error ? e.message : String(e) }))
  }, [])

  const byCategory = copiesByCategory()

  return (
    <main className="shell">
      <h1>Hide + Drink</h1>
      <p className="muted">Phase 1 sync check</p>

      <section className="card">
        <h2>Backend</h2>
        <p>
          Supabase:{' '}
          {status.state === 'checking' && <span>checking…</span>}
          {status.state === 'ok' && <span className="ok">connected ({status.ms} ms)</span>}
          {status.state === 'error' && <span className="bad">{status.message}</span>}
        </p>
      </section>

      <SyncCheck />

      <section className="card">
        <h2>Seed data</h2>
        <p>Deck: {deckSize()} cards</p>
        <ul>
          {Object.entries(byCategory).map(([cat, n]) => (
            <li key={cat}>
              {cat}: {n}
            </li>
          ))}
        </ul>
        <p>Question types: {questionTypes.length}</p>
      </section>

      <p className="muted small">Build {import.meta.env.VITE_BUILD_SHA?.slice(0, 7) ?? 'local'}</p>
    </main>
  )
}
