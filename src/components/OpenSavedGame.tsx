import { useRef, useState } from 'react'
import { openSavedGame, type SavedGame } from '../replay/saved'

/** Home: open a game downloaded earlier (its zip) and watch the replay, no server needed. */
export function OpenSavedGame({ onOpen }: { onOpen: (saved: SavedGame) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const pick = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    setErr(null)
    try {
      onOpen(await openSavedGame(file))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }
  return (
    <section className="card">
      <button className="wide secondary" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? 'Opening…' : 'Open a saved game'}
      </button>
      <p className="muted small-note">Pick a game's downloaded zip to watch its replay, even after it's been deleted or offline.</p>
      <input
        ref={input}
        type="file"
        accept=".zip,application/zip"
        hidden
        onChange={(e) => void pick(e.target.files?.[0])}
      />
      {err && (
        <p className="bad small" role="alert">
          {err}
        </p>
      )}
    </section>
  )
}
