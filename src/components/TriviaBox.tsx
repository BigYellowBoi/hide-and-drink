import { useState } from 'react'
import { triviaStage, type Effect, type TriviaQuestion } from '../cards/state'
import { describeError } from '../lobby/messages'
import type { GameSync } from '../sync/engine'
import type { Team } from '../sync/types'

interface Props {
  sync: GameSync
  effect: Effect
  team: Team
  canAct: boolean
  nameOf: (userId: string | null) => string
}

/**
 * A trivia curse (behaviour 'trivia'), inside its card: the hider writes the questions, the
 * seekers send all their answers at once, the hider marks them all at once. Both teams see everything.
 * With need_right below the count (Moll: 1 of 3), a set that falls short is thrown out and the
 * hider writes a new one. A stuck curse is cleared with Fix something.
 */
export function TriviaBox({ sync, effect: e, team, canAct, nameOf }: Props) {
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
  const qs = t.questions
  const done = qs?.filter((q) => q.correct).length ?? 0
  const stage = triviaStage(t)
  const active = e.status === 'active'
  const answering = active && stage === 'answering' && team === 'seekers'
  const marking = active && stage === 'marking' && team === 'hiders'

  return (
    <span className="trivia">
      {!qs ? (
        team === 'hiders' ? (
          <TriviaWrite count={t.count} topic={t.topic} disabled={disabled} onSend={(list) => act('set_trivia', { p_questions: list })} />
        ) : (
          <span className="muted small">
            Waiting for the hider to send {t.count} questions{t.need < t.count ? ` (get ${t.need} right)` : ''}.
          </span>
        )
      ) : (
        <>
          <span className="muted small">
            {done} of {qs.length} right{t.need < qs.length ? ` (${t.need} needed)` : ''}
            {active && stage === 'answering' && team === 'hiders' && ' · waiting for the seekers to answer'}
            {active && stage === 'marking' && team === 'seekers' && ' · waiting for the hider to mark'}
          </span>
          {answering ? (
            <TriviaAnswers
              key={qs.map((q) => q.wrong.length).join()}
              questions={qs}
              disabled={disabled}
              onSend={(answers) => act('answer_trivia', { p_answers: answers })}
            />
          ) : marking ? (
            <TriviaMarks
              key={qs.map((q) => q.wrong.length).join()}
              questions={qs}
              nameOf={nameOf}
              disabled={disabled}
              onSend={(marks) => act('mark_trivia', { p_marks: marks })}
            />
          ) : (
            <ol className="trivia-list">
              {qs.map((q, i) => (
                <li key={i}>
                  <span className="trivia-q">{q.question}</span>
                  <Wrong answers={q.wrong} />
                  {q.correct ? (
                    <span className="ok small">✓ {q.answer}</span>
                  ) : q.answer !== null ? (
                    <span className="small">“{q.answer}”</span>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </>
      )}
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

function Wrong({ answers }: { answers: readonly string[] }) {
  return (
    <>
      {answers.map((w, j) => (
        <span key={j} className="trivia-wrong small">
          ✗ {w}
        </span>
      ))}
    </>
  )
}

/** Seekers: one answer for every question not yet right, sent together. */
function TriviaAnswers({
  questions,
  disabled,
  onSend,
}: {
  questions: readonly TriviaQuestion[]
  disabled: boolean
  onSend: (answers: (string | null)[]) => Promise<boolean>
}) {
  const [texts, setTexts] = useState<string[]>(() => questions.map(() => ''))
  const open = questions.map((q) => !q.correct)
  const ready = questions.every((q, i) => q.correct || texts[i].trim().length > 0)
  return (
    <>
      <ol className="trivia-list">
        {questions.map((q, i) => (
          <li key={i}>
            <span className="trivia-q">{q.question}</span>
            <Wrong answers={q.wrong} />
            {q.correct ? (
              <span className="ok small">✓ {q.answer}</span>
            ) : (
              <input
                maxLength={500}
                value={texts[i]}
                aria-label={`Answer ${i + 1}`}
                placeholder="Your answer"
                onChange={(ev) => setTexts(texts.map((x, j) => (j === i ? ev.target.value : x)))}
              />
            )}
          </li>
        ))}
      </ol>
      <button className="small" disabled={disabled || !ready} onClick={() => void onSend(texts.map((x, i) => (open[i] ? x.trim() : null)))}>
        Send answers
      </button>
    </>
  )
}

/** Hider: Right or Wrong on every waiting answer, sent together. */
function TriviaMarks({
  questions,
  nameOf,
  disabled,
  onSend,
}: {
  questions: readonly TriviaQuestion[]
  nameOf: (userId: string | null) => string
  disabled: boolean
  onSend: (marks: (boolean | null)[]) => Promise<boolean>
}) {
  const [marks, setMarks] = useState<(boolean | null)[]>(() => questions.map(() => null))
  const ready = questions.every((q, i) => q.correct || marks[i] !== null)
  const by = questions.find((q) => !q.correct)?.answeredBy ?? null
  const set = (i: number, v: boolean) => setMarks(marks.map((m, j) => (j === i ? v : m)))
  return (
    <>
      <span className="small">Answers from {nameOf(by)}:</span>
      <ol className="trivia-list">
        {questions.map((q, i) => (
          <li key={i}>
            <span className="trivia-q">{q.question}</span>
            <Wrong answers={q.wrong} />
            {q.correct ? (
              <span className="ok small">✓ {q.answer}</span>
            ) : (
              <span className="trivia-mark">
                <span className="small">“{q.answer}”</span>
                <span className="confirm-row">
                  <button
                    className={marks[i] === false ? 'small trivia-on-wrong' : 'secondary small'}
                    aria-pressed={marks[i] === false}
                    disabled={disabled}
                    onClick={() => set(i, false)}
                  >
                    Wrong
                  </button>
                  <button
                    className={marks[i] === true ? 'small trivia-on-right' : 'secondary small'}
                    aria-pressed={marks[i] === true}
                    disabled={disabled}
                    onClick={() => set(i, true)}
                  >
                    Right
                  </button>
                </span>
              </span>
            )}
          </li>
        ))}
      </ol>
      <button className="small" disabled={disabled || !ready} onClick={() => void onSend(questions.map((q, i) => (q.correct ? null : marks[i])))}>
        Send marks
      </button>
    </>
  )
}
