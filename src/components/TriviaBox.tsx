import { useState } from 'react'
import type { Effect } from '../cards/state'
import { describeError } from '../lobby/messages'
import type { GameSync } from '../sync/engine'
import type { Team } from '../sync/types'

interface Props {
  sync: GameSync
  effect: Effect
  team: Team
  canAct: boolean
  isHost: boolean
  nameOf: (userId: string | null) => string
}

/**
 * A trivia curse (behaviour 'trivia'), inside its card: the hider writes the questions, the
 * seekers answer, the hider marks each answer. Both teams see everything. The host can mark
 * them all right by hand.
 */
export function TriviaBox({ sync, effect: e, team, canAct, isHost, nameOf }: Props) {
  const t = e.trivia
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  if (!t) return null

  const act = async (fn: string, params: Record<string, unknown>) => {
    setBusy(true)
    setErr(null)
    try {
      await sync.action(fn, { p_effect_id: e.id, ...params })
      return true
    } catch (x) {
      setErr(describeError(x))
      return false
    } finally {
      setBusy(false)
    }
  }
  const disabled = busy || !canAct
  const done = t.questions?.filter((q) => q.correct).length ?? 0

  return (
    <span className="trivia">
      {!t.questions ? (
        team === 'hiders' ? (
          <TriviaWrite count={t.count} topic={t.topic} disabled={disabled} onSend={(qs) => act('set_trivia', { p_questions: qs })} />
        ) : (
          <span className="muted small">Waiting for the hider to send {t.count} questions.</span>
        )
      ) : (
        <>
          <span className="muted small">
            {done} of {t.questions.length} right
          </span>
          <ol className="trivia-list">
            {t.questions.map((q, i) => (
              <li key={i} className={q.correct ? 'trivia-right' : undefined}>
                <span className="trivia-q">{q.question}</span>
                {q.wrong.map((w, j) => (
                  <span key={j} className="trivia-wrong small">
                    ✗ {w}
                  </span>
                ))}
                {q.correct ? (
                  <span className="ok small">✓ {q.answer}</span>
                ) : q.answer !== null ? (
                  team === 'hiders' && e.status === 'active' ? (
                    <span className="trivia-mark">
                      <span className="small">
                        “{q.answer}” <span className="muted">({nameOf(q.answeredBy)})</span>
                      </span>
                      <span className="confirm-row">
                        <button className="secondary small" disabled={disabled} onClick={() => void act('mark_trivia', { p_index: i, p_correct: false })}>
                          Wrong
                        </button>
                        <button className="small" disabled={disabled} onClick={() => void act('mark_trivia', { p_index: i, p_correct: true })}>
                          Right
                        </button>
                      </span>
                    </span>
                  ) : (
                    <span className="small">
                      “{q.answer}” <span className="muted">waiting for the hider</span>
                    </span>
                  )
                ) : team === 'seekers' && e.status === 'active' ? (
                  <TriviaAnswer disabled={disabled} onSend={(a) => act('answer_trivia', { p_index: i, p_answer: a })} />
                ) : (
                  <span className="muted small">Waiting for the seekers</span>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
      {isHost && e.status === 'active' && <HostClear disabled={disabled} onClear={() => act('force_clear_trivia', {})} />}
      {err && <span className="bad small">{err}</span>}
    </span>
  )
}

function TriviaWrite({
  count,
  topic,
  disabled,
  onSend,
}: {
  count: number
  topic: string | null
  disabled: boolean
  onSend: (questions: string[]) => Promise<boolean>
}) {
  const [qs, setQs] = useState<string[]>(() => Array.from({ length: count }, () => ''))
  const ready = qs.every((q) => q.trim().length > 0)
  return (
    <span className="trivia-write">
      <span className="small">
        Write {count} {topic ? `${topic} ` : ''}question{count > 1 ? 's' : ''} for the seekers.
      </span>
      {qs.map((q, i) => (
        <input
          key={i}
          maxLength={500}
          value={q}
          aria-label={`Question ${i + 1}`}
          placeholder={`Question ${i + 1}`}
          onChange={(ev) => setQs(qs.map((x, j) => (j === i ? ev.target.value : x)))}
        />
      ))}
      <button className="small" disabled={disabled || !ready} onClick={() => void onSend(qs.map((x) => x.trim()))}>
        Send to seekers
      </button>
    </span>
  )
}

function TriviaAnswer({ disabled, onSend }: { disabled: boolean; onSend: (answer: string) => Promise<boolean> }) {
  const [text, setText] = useState('')
  return (
    <span className="trivia-answer">
      <input maxLength={500} value={text} aria-label="Your answer" placeholder="Your answer" onChange={(ev) => setText(ev.target.value)} />
      <button
        className="small"
        disabled={disabled || !text.trim()}
        onClick={() => void onSend(text.trim()).then((ok) => ok && setText(''))}
      >
        Send
      </button>
    </span>
  )
}

/** Host only, either team: mark everything right and clear the curse. Asks once. */
function HostClear({ disabled, onClear }: { disabled: boolean; onClear: () => Promise<boolean> }) {
  const [sure, setSure] = useState(false)
  return sure ? (
    <span className="confirm-row">
      <button className="secondary small" disabled={disabled} onClick={() => setSure(false)}>
        Cancel
      </button>
      <button className="small" disabled={disabled} onClick={() => void onClear()}>
        Clear curse
      </button>
    </span>
  ) : (
    <button className="secondary small" disabled={disabled} onClick={() => setSure(true)}>
      Host: mark all correct
    </button>
  )
}
