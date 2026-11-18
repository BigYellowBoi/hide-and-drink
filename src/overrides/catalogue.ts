/**
 * The "Fix something" menu: every host_override kind with a one-line explanation, grouped.
 * private: touches hider-only data, so a seeker host only sends a request a hider carries out.
 */
export type OverrideKind =
  | 'cancel_penalty'
  | 'add_penalty'
  | 'cancel_drink'
  | 'waive_proof'
  | 'timer'
  | 'freeze'
  | 'set_answer'
  | 'void_answer'
  | 'reopen_question'
  | 'ask_question'
  | 'lift_ban'
  | 'set_blocking'
  | 'clear_effect'
  | 'reinstate_effect'
  | 'cancel_veto'
  | 'set_hand_limit'
  | 'cancel_move'
  | 'move_player'
  | 'set_host'
  | 'set_bar'
  | 'give_card'
  | 'remove_card'
  | 'draw_cards'
  | 'reshuffle'
  | 'undo'

export interface OverrideOption {
  kind: OverrideKind
  label: string
  line: string
  group: 'Penalties and drinks' | 'Timers' | 'Bar and freeze' | 'Questions' | 'Cards' | 'Players' | 'Undo'
  private: boolean
}

export const OVERRIDES: readonly OverrideOption[] = [
  { kind: 'cancel_penalty', group: 'Penalties and drinks', private: false, label: 'Cancel a late-answer shot', line: 'The hiders don\'t owe the shot for a missed answer deadline.' },
  { kind: 'add_penalty', group: 'Penalties and drinks', private: false, label: 'Add a drink or shot', line: 'Log a penalty the app missed; the team is asked for a photo.' },
  { kind: 'cancel_drink', group: 'Penalties and drinks', private: false, label: 'Cancel a drink', line: 'A drink the app asked for isn\'t owed after all.' },
  { kind: 'waive_proof', group: 'Penalties and drinks', private: false, label: 'Done without a photo', line: 'They drank (or did the curse) but the photo won\'t send: close the request.' },
  { kind: 'timer', group: 'Timers', private: false, label: 'Change a countdown', line: 'Add or take away time, pause, resume or end any timer, including the hiding period.' },
  { kind: 'freeze', group: 'Bar and freeze', private: false, label: 'Force the freeze alert', line: 'Turn the hider\'s freeze alert on or off, or back to automatic.' },
  { kind: 'set_bar', group: 'Bar and freeze', private: true, label: 'Change the hider\'s bar', line: 'Lock in a different bar, even one the app refuses, or a pin for one it doesn\'t list.' },
  { kind: 'cancel_move', group: 'Bar and freeze', private: false, label: 'Cancel the hider\'s move', line: 'The hider stays at their bar and seekers can ask again.' },
  { kind: 'set_answer', group: 'Questions', private: false, label: 'Enter or change an answer', line: 'Type the answer by hand, for an open question or one already answered.' },
  { kind: 'void_answer', group: 'Questions', private: false, label: 'Void a question', line: 'No answer and no shading from it; the seekers can ask again.' },
  { kind: 'reopen_question', group: 'Questions', private: false, label: 'Reopen a question', line: 'Back to waiting for an answer, with a fresh deadline.' },
  { kind: 'ask_question', group: 'Questions', private: false, label: 'Ask past a block or ban', line: 'Send a question even while blocked, banned, still hiding or the hider is moving.' },
  { kind: 'lift_ban', group: 'Questions', private: false, label: 'Lift a question ban', line: 'The seekers can ask that question again.' },
  { kind: 'set_blocking', group: 'Questions', private: false, label: 'Unblock questions', line: 'A curse stays in force but stops blocking questions (or blocks again).' },
  { kind: 'clear_effect', group: 'Cards', private: false, label: 'Clear a curse', line: 'End any curse now, without the hider\'s confirm or a photo.' },
  { kind: 'reinstate_effect', group: 'Cards', private: false, label: 'Put a curse back', line: 'A curse cleared (or vetoed) by mistake goes back in force.' },
  { kind: 'cancel_veto', group: 'Cards', private: false, label: 'Cancel a veto', line: 'The curse comes back; the bar lock and the veto drink go away.' },
  { kind: 'set_hand_limit', group: 'Cards', private: false, label: 'Change the hand limit', line: 'Let the hider hold more (or fewer) cards than the setting.' },
  { kind: 'give_card', group: 'Cards', private: true, label: 'Give the hider a card', line: 'Put any card straight into the hider\'s hand, past the hand limit.' },
  { kind: 'remove_card', group: 'Cards', private: true, label: 'Take a card from the hand', line: 'Discard a card the hider shouldn\'t have.' },
  { kind: 'draw_cards', group: 'Cards', private: true, label: 'Draw cards for the hider', line: 'A reward the app didn\'t deal: draw some and keep some.' },
  { kind: 'reshuffle', group: 'Cards', private: true, label: 'Reshuffle the deck', line: 'Discards go back into the draw pile, shuffled (for an empty deck).' },
  { kind: 'move_player', group: 'Players', private: false, label: 'Move a player', line: 'Swap someone to the other team mid-game (onto the hiders needs a hider to agree).' },
  { kind: 'set_host', group: 'Players', private: false, label: 'Make someone else host', line: 'Hand the host controls to another player.' },
  { kind: 'undo', group: 'Undo', private: false, label: 'Undo a fix', line: 'Put things back as they were before an earlier fix.' },
]

export const optionOf = (kind: string) => OVERRIDES.find((o) => o.kind === kind) ?? null

/** What this phone may do: the host everything, other hiders only the hider-only fixes. */
export function availableOverrides(isHost: boolean, isHider: boolean): OverrideOption[] {
  if (isHost) return [...OVERRIDES]
  return isHider ? OVERRIDES.filter((o) => o.private) : []
}

/** A seeker host's hider-only fix goes to the hiders as a request instead. */
export const needsHiderApproval = (o: Pick<OverrideOption, 'private'>, isHider: boolean, params: Record<string, unknown> = {}) =>
  !isHider && (o.private || params.team === 'hiders')
