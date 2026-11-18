import { useEffect, useRef, useState } from 'react'
import { cardFacts } from '../cards/state'
import {
  copiesIn,
  deckTotals,
  deleteDeckPreset,
  effectiveDeck,
  matchesPreset,
  presetDeck,
  saveCategory,
  saveDeckPreset,
  setCategoryActive,
  toCardDef,
  withCopies,
  type Deck,
  type Library,
  type LibraryCard,
  type LibraryCategory,
} from '../library/library'
import { describeError } from '../lobby/messages'
import type { SyncTransport } from '../sync/transport'
import { CardEditor } from './CardEditor'
import { Stepper } from './Stepper'

const RETIRED = '__retired'

interface DeckProps {
  /** The game's deck as the server has it (config.deck; null = library defaults). */
  deck: Deck | null
  /** Host: may change copies and apply presets. */
  editable: boolean
  /** Send the whole deck (set_deck). Rejects on failure. */
  onSave: (deck: Deck | null) => Promise<unknown>
}

interface Props {
  transport: SyncTransport
  library: Library | null
  loadError: string | null
  /** Live: actions allowed (green dot in a game; always in Settings). */
  canAct: boolean
  onClose: () => void
  /** Deck builder for a lobby. Without it: library editing (Settings). */
  deckBuilder?: DeckProps
}

/**
 * Deck builder (lobby) and card library (Settings): category tabs with live totals, one row
 * per card. In the deck builder each row has -/count/+ (0 greys out); in the library each row
 * shows default copies and who last edited it. Tapping a card's name opens the editor, so
 * anyone can fix a card from either place; "+ New card" adds one.
 */
export function CardLibrary({ transport, library, loadError, canAct, onClose, deckBuilder }: Props) {
  const isDeck = !!deckBuilder
  const cats = (library?.categories ?? []).filter((c) => c.active)
  const [tab, setTab] = useState<string | null>(null)
  const [editing, setEditing] = useState<LibraryCard | 'new' | null>(null)
  const [catForm, setCatForm] = useState<LibraryCategory | 'new' | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    document.documentElement.classList.add('scroll-locked')
    return () => document.documentElement.classList.remove('scroll-locked')
  }, [])

  const current = tab && (tab === RETIRED || cats.some((c) => c.id === tab)) ? tab : (cats[0]?.id ?? null)
  const cards = library?.cards ?? []

  // ------------------------------------------------------------ deck draft (debounced save)
  const draft = useDeckDraft(deckBuilder, cards, setErr)
  const shownDeck = draft.deck
  const totals = deckTotals(shownDeck, cards)

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setErr(null)
    try {
      await fn()
      return true
    } catch (e) {
      setErr(describeError(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  const list =
    current === RETIRED
      ? cards.filter((c) => !c.active)
      : cards.filter((c) => c.active && c.category === current)
  const retiredCats = (library?.categories ?? []).filter((c) => !c.active)
  const currentCat = cats.find((c) => c.id === current) ?? null
  const disabled = busy || !canAct

  return (
    <div className="sheet-page" role="dialog" aria-label={isDeck ? 'Deck' : 'Card library'}>
      <header className="editor-bar">
        <button className="small secondary" onClick={onClose}>
          {isDeck ? 'Done' : 'Back'}
        </button>
        <span className="editor-title">{isDeck ? 'Deck' : 'Card library'}</span>
        <span className="editor-km">
          {isDeck ? `${totals.total} cards` : `${cards.filter((c) => c.active).length} cards`}
          {draft.saving && <span className="muted"> · saving</span>}
        </span>
      </header>

      <div className="sheet-page-body">
        {!library && !loadError && <p className="muted">Loading…</p>}
        {loadError && !library && <p className="bad">{loadError}</p>}

        {isDeck && library && (
          <section className="presets">
            <h3>Presets</h3>
            <PresetRow
              transport={transport}
              library={library}
              deck={shownDeck}
              editable={deckBuilder.editable && canAct}
              onApply={(d) => draft.change(d)}
              onError={setErr}
            />
          </section>
        )}

        {library && (
          <nav className="cat-tabs" aria-label="Categories">
            {cats.map((c) => (
              <button
                key={c.id}
                className={`cat-tab${current === c.id ? ' on' : ''}`}
                style={{ ['--cat' as string]: c.colour }}
                aria-pressed={current === c.id}
                onClick={() => setTab(c.id)}
              >
                <span className="cat-swatch" />
                {c.name}
                <span className="cat-count">
                  {isDeck ? (totals.byCategory[c.id] ?? 0) : cards.filter((x) => x.active && x.category === c.id).length}
                </span>
              </button>
            ))}
            {!isDeck && (
              <>
                <button className={`cat-tab${current === RETIRED ? ' on' : ''}`} onClick={() => setTab(RETIRED)}>
                  Retired
                  <span className="cat-count">{cards.filter((c) => !c.active).length + retiredCats.length}</span>
                </button>
                <button className="cat-tab" disabled={disabled} onClick={() => setCatForm('new')}>
                  + Category
                </button>
              </>
            )}
          </nav>
        )}

        {!isDeck && currentCat && (
          <p className="row cat-actions">
            <button className="small secondary" disabled={disabled} onClick={() => setCatForm(currentCat)}>
              Edit {currentCat.name}
            </button>
          </p>
        )}
        {catForm && (
          <CategoryForm
            key={catForm === 'new' ? 'new' : catForm.id}
            category={catForm === 'new' ? null : catForm}
            hasCards={catForm !== 'new' && cards.some((c) => c.active && c.category === catForm.id)}
            busy={disabled}
            onCancel={() => setCatForm(null)}
            onSave={async (name, colour) => {
              const ok = await run(() => saveCategory(transport, catForm === 'new' ? null : catForm.id, name, colour))
              if (ok) setCatForm(null)
            }}
            onRetire={async () => {
              if (catForm === 'new') return
              const ok = await run(() => setCategoryActive(transport, catForm.id, false))
              if (ok) setCatForm(null)
            }}
          />
        )}

        {current === RETIRED && retiredCats.length > 0 && (
          <ul className="lib-list">
            {retiredCats.map((c) => (
              <li key={c.id} className="lib-row lib-off">
                <span className="lib-main">
                  <span className="lib-name">
                    <span className="cat-swatch" style={{ ['--cat' as string]: c.colour }} /> {c.name}
                  </span>
                  <span className="map-tag">Category</span>
                </span>
                <button
                  className="small secondary"
                  disabled={disabled}
                  onClick={() => void run(() => setCategoryActive(transport, c.id, true))}
                >
                  Restore
                </button>
              </li>
            ))}
          </ul>
        )}

        {library && (
          <ul className="lib-list">
            {list.map((c) => {
              const n = isDeck ? copiesIn(shownDeck, c) : c.copies
              const facts = cardFacts(toCardDef(c, library.categories))
              return (
                <li key={c.id} className={`lib-row${n === 0 || !c.active ? ' lib-off' : ''}`}>
                  <button className="lib-main" onClick={() => setEditing(c)} aria-label={`Edit ${c.name}`}>
                    <span className="lib-name">{c.name}</span>
                    <span className="lib-meta">
                      {[
                        c.castCost && c.castCost !== 'free' ? (c.castCost === 'shot' ? 'Shot' : 'Drink') : null,
                        ...facts.slice(0, 2),
                        !isDeck ? `${c.copies} by default` : null,
                        !isDeck && c.updatedByName ? `edited by ${c.updatedByName}` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </button>
                  {isDeck &&
                    (deckBuilder.editable ? (
                      <Stepper
                        value={n}
                        label={`copies of ${c.name}`}
                        disabled={!canAct}
                        onChange={(v) => draft.change(withCopies(shownDeck, cards, c.id, v))}
                      />
                    ) : (
                      <span className="stepper-count">×{n}</span>
                    ))}
                </li>
              )
            })}
            {library && list.length === 0 && current !== RETIRED && <li className="muted">No cards here yet.</li>}
            {library && current === RETIRED && list.length === 0 && retiredCats.length === 0 && (
              <li className="muted">Nothing retired.</li>
            )}
          </ul>
        )}

        {library && current !== RETIRED && (
          <button className="wide" disabled={disabled || cats.length === 0} onClick={() => setEditing('new')}>
            + New card
          </button>
        )}
        <p className="muted small-note">
          {isDeck
            ? 'The library is shared: card edits show up for everyone. The deck locks when the game starts.'
            : 'Shared by everyone. Edits show up on every phone straight away; games already running keep their own copy.'}
        </p>

        {err && (
          <p className="bad sticky-error" role="alert">
            {err}
          </p>
        )}
      </div>

      {editing && library && (
        <CardEditor
          transport={transport}
          card={editing === 'new' ? null : editing}
          categories={library.categories}
          defaultCategory={current ?? undefined}
          onClose={() => setEditing(null)}
          onSaved={(id, d, isNew) => {
            // A new card joins this game's deck with its default copies.
            if (isNew && deckBuilder?.editable && shownDeck) draft.change({ ...effectiveDeck(shownDeck, cards), [id]: d.copies })
          }}
        />
      )}
    </div>
  )
}

/**
 * Local deck edits, saved 500 ms after the last tap. The edit stays shown until the
 * server's deck matches it, so taps never flicker back while the save is in flight.
 */
function useDeckDraft(props: DeckProps | undefined, cards: LibraryCard[], onError: (e: string | null) => void) {
  const server = props?.deck ?? null
  const [draft, setDraft] = useState<{ deck: Deck | null } | null>(null)
  const [saving, setSaving] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef<{ deck: Deck | null } | null>(null)
  const onSave = useRef(props?.onSave)
  useEffect(() => {
    onSave.current = props?.onSave
  })

  const same = (a: Deck | null, b: Deck | null) => {
    if ((a === null) !== (b === null)) return false
    const x = effectiveDeck(a, cards)
    const y = effectiveDeck(b, cards)
    return cards.every((c) => !c.active || x[c.id] === y[c.id])
  }

  // The server caught up: drop the draft (state adjusted during render, as React advises).
  const caughtUp = draft !== null && !saving && same(draft.deck, server)
  if (caughtUp) setDraft(null)

  const flush = async () => {
    timer.current = null
    const d = latest.current
    const save = onSave.current
    if (!d || !save) return
    setSaving(true)
    try {
      await save(d.deck)
    } catch (e) {
      onError(describeError(e))
      if (latest.current === d) {
        setDraft(null)
        latest.current = null
      }
    } finally {
      setSaving(false)
    }
  }
  const flushRef = useRef(flush)
  useEffect(() => {
    flushRef.current = flush
  })

  // Closing the builder mid-debounce still saves the last tap.
  useEffect(
    () => () => {
      if (!timer.current) return
      clearTimeout(timer.current)
      void flushRef.current()
    },
    [],
  )

  const change = (deck: Deck | null) => {
    onError(null)
    const d = { deck }
    latest.current = d
    setDraft(d)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void flush(), 500)
  }

  return { deck: draft ? draft.deck : server, change, saving: saving || (draft !== null && !caughtUp) }
}

function PresetRow({
  transport,
  library,
  deck,
  editable,
  onApply,
  onError,
}: {
  transport: SyncTransport
  library: Library
  deck: Deck | null
  editable: boolean
  onApply: (deck: Deck | null) => void
  onError: (e: string | null) => void
}) {
  const [naming, setNaming] = useState<string | null>(null)
  const [arming, setArming] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!arming) return
    const t = setTimeout(() => setArming(null), 3000)
    return () => clearTimeout(t)
  }, [arming])

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    onError(null)
    try {
      await fn()
      return true
    } catch (e) {
      onError(describeError(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="chips">
        {library.presets.map((p) => {
          const on = matchesPreset(deck, p, library.cards)
          return (
            <span key={p.id} className={`preset-chip${on ? ' on' : ''}`}>
              <button
                className="preset-apply"
                disabled={!editable || busy}
                aria-pressed={on}
                onClick={() => onApply(presetDeck(p, library.cards))}
              >
                {p.name}
                {!p.builtIn && p.creatorName && <span className="muted"> · {p.creatorName}</span>}
              </button>
              {!p.builtIn && editable && (
                <button
                  className={`preset-delete${arming === p.id ? ' danger' : ''}`}
                  aria-label={arming === p.id ? `Tap again to delete ${p.name}` : `Delete preset ${p.name}`}
                  disabled={busy}
                  onClick={() => {
                    if (arming !== p.id) return setArming(p.id)
                    setArming(null)
                    void run(() => deleteDeckPreset(transport, p.id))
                  }}
                >
                  {arming === p.id ? 'Delete?' : '✕'}
                </button>
              )}
            </span>
          )
        })}
      </div>
      {editable &&
        (naming === null ? (
          <button className="small secondary preset-save" disabled={busy} onClick={() => setNaming('')}>
            Save this deck as a preset
          </button>
        ) : (
          <form
            className="preset-form"
            onSubmit={(e) => {
              e.preventDefault()
              void run(() => saveDeckPreset(transport, naming, effectiveDeck(deck, library.cards))).then(
                (ok) => ok && setNaming(null),
              )
            }}
          >
            <input
              autoFocus
              aria-label="Preset name"
              placeholder="Preset name"
              maxLength={60}
              value={naming}
              onChange={(e) => setNaming(e.target.value)}
            />
            <button className="small" disabled={busy || !naming.trim()}>
              Save
            </button>
            <button type="button" className="small secondary" onClick={() => setNaming(null)}>
              Cancel
            </button>
          </form>
        ))}
    </>
  )
}

function CategoryForm({
  category,
  hasCards,
  busy,
  onCancel,
  onSave,
  onRetire,
}: {
  category: LibraryCategory | null
  hasCards: boolean
  busy: boolean
  onCancel: () => void
  onSave: (name: string, colour: string) => void
  onRetire: () => void
}) {
  const [name, setName] = useState(category?.name ?? '')
  const [colour, setColour] = useState(category?.colour ?? '#5BB4F0')
  return (
    <form
      className="card cat-form"
      onSubmit={(e) => {
        e.preventDefault()
        onSave(name, colour)
      }}
    >
      <h3>{category ? `Edit ${category.name}` : 'New category'}</h3>
      <div className="cat-form-row">
        <label className="field" htmlFor="cat-name">
          <span>Name</span>
          <input id="cat-name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field cat-colour" htmlFor="cat-colour">
          <span>Colour</span>
          <input id="cat-colour" type="color" value={colour} onChange={(e) => setColour(e.target.value)} />
        </label>
      </div>
      <div className="row">
        <button className="small" disabled={busy || !name.trim()}>
          Save
        </button>
        <button type="button" className="small secondary" onClick={onCancel}>
          Cancel
        </button>
        {category && (
          <button type="button" className="small secondary" disabled={busy || hasCards} onClick={onRetire}>
            Retire
          </button>
        )}
      </div>
      {category && hasCards && <p className="muted small-note">Retire or move its cards first to retire the category.</p>}
    </form>
  )
}
