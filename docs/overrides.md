# Overrides

Rule: every decision the app makes automatically has a manual override, so a bug never stops a game.

This is the audit of `supabase/migrations/` (up to `20261213090000_host_overrides.sql`): every event the server writes on its own and every refusal an action can raise, with the fix for each.

## How overrides work

- **One action:** `host_override(game_id, kind, params, reason, client_action_id, last_seen_seq, request_id?)`. Game-play rules apply (idempotent, fresh view, round running; `set_host` also works in the lobby).
- **Who:** the host, for every kind. Any hider, for the hider-only kinds (below). A seeker who isn't host: none (`host_only`).
- **Reason:** required, 1 to 120 characters (`invalid_reason`). Shown to everyone.
- **Record:** a public `override` event with `override_id`, `kind`, `reason`, `by`, `summary` (one line) and `private`. It's a "Host fix" row in the timeline.
- **Hider-only kinds** (`set_bar`, `give_card`, `remove_card`, `draw_cards`, `reshuffle`, `move_player` onto the hiders, and `undo` of one of these):
  - A hider does them directly.
  - A seeker host only files a request: public `override_requested` with the kind and reason, no details. The hiders get a banner. A hider carries it out by calling `host_override` with `request_id` and picks the details. Or they decline it (kind `decline`; the host can withdraw their own request the same way).
  - The public `override` event then says only what kind of thing changed (for example "Changed the hider's bar") with empty `params`. The details go in a hiders-only `override_detail` event. Leak test: `supabase/tests/24_host_overrides.test.sql`.
- **Undo** (kind `undo`, `params.override_id`):
  - Every row an override changes is captured (`override_changes`, by a trigger while `hd.override_id` is set).
  - Every event it appends carries `payload.override_id`.
  - Undo restores the rows, newest change first. It refuses `undo_conflict` if any of those rows has changed since. Then it logs `override_undone`.
  - Phones drop the undone override's events (`src/overrides/state.ts`, `effectiveEvents`). The audit row stays, struck through.
  - An undo can be undone too. A host-wide undo of ordinary actions (step 12) can build on the same capture.
- **Tables:** `game_overrides`, `override_changes`, `override_requests` and `timer_pauses` have no client access.
- **Pausing:**
  - A paused countdown's end is stored as `infinity` (the hiding period as a huge `hiding_period_s`), so every existing deadline check treats it as still running.
  - The time left is in `timer_pauses`.
  - Phones show it frozen (`shownEnd`, `hidingPeriodAt`).

## Override kinds

| Kind | Params | Does | Events |
| --- | --- | --- | --- |
| `cancel_penalty` | `question_id` | Cancels a missed-deadline shot and closes its drink proof | `penalty_cancelled`, `drink_resolved` |
| `add_penalty` | `team`, `cost` (drink/shot), `label` | Logs a penalty the app missed and opens a drink proof | `drink_due`, `penalty_added` |
| `cancel_drink` | `proof_id` | Drink not owed: proof closed, no photo (`resolution` cancelled) | `drink_resolved` |
| `waive_proof` | `proof_id` | Drunk (or curse done) without a photo: proof closed (`resolution` waived); also unblocks `clear_effect` | `drink_resolved` |
| `timer` | `timer` (hiding/answer/effect/followup/veto_lock), `id`, `op` (add/end/pause/resume), `seconds` | Changes any countdown. Hiding end = start seeking now. More hiding time after seeking began puts the round back in hiding | `timer_changed`, then `seeking_started` / `answer_overdue` if now due |
| `freeze` | `frozen` (true/false/null) | Forces the hider's freeze alert for the round. Null goes back to automatic | `freeze_changed` (hiders, if it changed), `freeze_forced` |
| `set_bar` (hider-only) | `venue_id`, or `name` + `lng` + `lat` | Locks in any venue the app knows (even refused, hidden, or with a bar already locked), or pins an unlisted one (round venue, revealed at round end). Finishes a pending move | `venue_added` (hiders), `bar_chosen` (hiders), `hider_moved` |
| `cancel_move` | none | Ends a pending Move: hider stays put, questions open | `move_cancelled` |
| `set_answer` | `question_id`, `answer` (free text), `draw` | Answers an open question by hand (draws the reward unless `draw` false), or edits an answer. Skips answer validation | `question_answered` (`by_override`), `cards_drawn` |
| `void_answer` | `question_id` | No answer, no shading, no pending question (`closed_by` void) | `question_voided` |
| `reopen_question` | `question_id`, `deadline_s` | Back to pending with a new deadline (refuses `question_pending` if another is open) | `question_reopened` |
| `ask_question` | `type`, `option_id`, `params` | Asks past `questions_blocked`, `question_banned`, `hider_moving`, `still_hiding`. If the map data can't be worked out, it's sent without it (`params.manual`) | `question_asked` (`by_override`) |
| `lift_ban` | `type`, `option_id` | Removes a question ban | `ban_lifted` |
| `set_blocking` | `effect_id`, `blocks` | A curse stops (or starts) blocking questions | `effect_changed` |
| `clear_effect` | `effect_id` | Ends any curse now. Waives its open evidence proof | `drink_resolved`, `effect_cleared` |
| `reinstate_effect` | `effect_id`, `seconds` | Puts a cleared or vetoed curse back. Timed ones restart (card time or `seconds`) | `effect_reinstated` |
| `cancel_veto` | `instance_id` | Removes the veto and its lock (next vetoes cost less again), brings the curse and its bans back, cancels the veto drink | `veto_cancelled`, `drink_resolved` |
| `set_hand_limit` | `limit` (1 to 30) | Changes `config.hand_limit` mid-game (past `hand_full`) | `hand_limit_changed` |
| `give_card` (hider-only) | `card_id` | Puts any card in the hand, past the limit. Snapshots it from the library if it isn't in the deck | `card_given` (hiders) |
| `remove_card` (hider-only) | `instance_id` | Discards a hand card | `card_removed` (hiders) |
| `draw_cards` (hider-only) | `count`, `pick` | Deals a draw from the pile | `cards_drawn` (hiders) |
| `reshuffle` (hider-only) | none | Discards back into the pile, shuffled | `deck_reshuffled` (hiders) |
| `move_player` | `user_id`, `team` | Mid-game team change. Onto the hiders is hider-only (needs a hider) | `team_changed` |
| `set_host` | `user_id` | Reassigns the host | `host_changed` |
| `undo` | `override_id` | See above | `override_undone` |

## Automatic events

| Event | Written by | Override |
| --- | --- | --- |
| `seeking_started` | `_settle_timers` when the hiding period ends | `timer` hiding: add (seek later, even after it started), end (seek now), pause/resume |
| `answer_overdue` (+ `drink_due` shot) | `_settle_timers` when an answer deadline passes | `cancel_penalty`; `timer` answer (before it passes); `add_penalty` for one it missed |
| `drink_due` (cast cost, `params.drinks`, veto, missed deadline) | `play_card`, `veto_curse`, `_settle_timers` | `cancel_drink`, `waive_proof`, `add_penalty` |
| `proof_due` (curse evidence photo) | `play_card` for `params.proof` = photo curses | `waive_proof`, `clear_effect` |
| `freeze_changed` | `_update_freeze` on every seeker position and bar change | `freeze` (forced value wins until set back to automatic) |
| `bar_chosen` `late` flag | `choose_bar` after the hiding period | `set_bar` (relocks with `late` false) |
| `question_answered` `late` flag | `answer_question` after the deadline | `set_answer` (edit), `cancel_penalty` |
| Answer reward size (modifiers multiply draw and pick) | `answer_question` | `draw_cards`, `give_card`, `remove_card` |
| `cards_drawn` (which cards, server shuffle) | `_draw_reward`, `_deal_deck` | `remove_card`, `give_card`, `reshuffle`, `draw_cards` |
| Empty pile: no reward drawn (silent) | `_draw_reward` | `reshuffle`, then `draw_cards` |
| Randomize picks the new question | `play_card` randomize | `void_answer` the new one; `ask_question` the one wanted |
| Curse timer ending (`ends_at`, `followup_ends_at`) | time | `timer` effect/followup, `reinstate_effect`, `clear_effect` |
| Veto lock length and chaining | `veto_curse` (`base_lock_s + step_s × vetoes`) | `timer` veto_lock, `cancel_veto` |
| `hider_moved` | `choose_bar` after Move | `set_bar` (completes it), `cancel_move` |
| `venues_revealed` | trigger when the round ends or changes | none needed: reveals only after the round |
| `dice_rolled`, `wheel_spun` results | server random | not game state; roll again, or `add_penalty` / `clear_effect` as agreed |
| `trivia_*` marks | hider marks | `force_clear_trivia` (existing, host), `clear_effect`, `reinstate_effect` |
| Hiding-zone validity (`hiding_bars`, `_valid_bars`) | play area + venue edits | `set_bar` accepts any known venue or a pin |
| Suggested answers, shading | each phone, from answers | hider taps the answer (non-negotiable 6); `set_question_shading` (seekers); `set_answer`/`void_answer` |
| Lobby sweep after 24 h unused | `_sweep_stale_lobbies` | lobbies only; create a new one |
| Push alerts | `_queue_push` trigger | informational only |

## Refusals

### Game-play refusals and their override

| Refusal | Raised by | Override |
| --- | --- | --- |
| `still_hiding` | `ask_question` | `timer` hiding end, or `ask_question` override |
| `question_pending` | `ask_question`, `play_card` move | `set_answer`, `void_answer`, `timer` answer end |
| `questions_blocked` | `ask_question` | `set_blocking`, `clear_effect`, `ask_question` override |
| `question_banned` | `ask_question` | `lift_ban`, `ask_question` override |
| `hider_moving` | `ask_question` | `cancel_move`, `set_bar`, `ask_question` override |
| `question_type_not_supported`, `no_map_data`, `option_not_configured`, `position_outside_map`, `invalid_distance`, `not_far_enough`, `invalid_params` | `ask_question` (`_question_params`) | `ask_question` override (sent without map data) and `set_answer` |
| `question_not_pending` | `answer_question`, `set_trivia`... | `reopen_question`, `set_answer` |
| `invalid_answer`, `photo_not_uploaded` (answers) | `answer_question` (`_check_answer`) | `set_answer` (free text) |
| `no_pending_question`, `nothing_to_randomize` | `play_card` veto/randomize | `void_answer` (= veto), `ask_question` (= randomize) |
| `bar_already_chosen` | `choose_bar` | `set_bar` |
| `venue_not_allowed`, `venue_not_found`, `same_bar` | `choose_bar` | `set_bar` (any known venue, or a pin) |
| `venue_outside_play_area`, `too_many_venues`, `venue_outside_map_data`, `invalid_venue_name` | `add_venue` | `set_bar` with a pin (no area or count check) |
| `no_bar_yet`, `already_moving` | `play_card` move | `set_bar`, `cancel_move` |
| `hand_full` | `keep_cards` | `set_hand_limit`, `remove_card` |
| `deck_empty` | `_deal_deck` at start (lobby: fix the deck), empty pile in play | `reshuffle`, `draw_cards` |
| `draw_not_pending`, `invalid_keep`, `card_not_in_hand` | `keep_cards`, `play_card` | `give_card`, `remove_card`, `draw_cards` |
| `card_not_playable`, `card_not_configured`, `card_behaviour_not_supported`, `invalid_choice` | `play_card` | play it by hand, then `give_card`/`remove_card`, `add_penalty`, `timer` |
| `effect_not_active`, `effect_not_found`, `clear_not_requested` | `clear_effect`, `confirm_clear` | `clear_effect`, `reinstate_effect` |
| `proof_needed` | `clear_effect` | `waive_proof`, `clear_effect` |
| `proof_not_pending` | `submit_drink_proof` | `waive_proof` / `cancel_drink` (already closed is fine) |
| `no_followup`, `followup_already_started`, `timer_still_running` | `start_followup` | `timer` effect end, then `start_followup`; `timer` followup |
| `cannot_veto`, `already_vetoed`, `curse_over`, `card_not_found` | `veto_curse` | `clear_effect` (= veto without the lock), `add_penalty`; `cancel_veto` |
| `trivia_*`, `invalid_trivia*` | trivia actions | `force_clear_trivia`, `clear_effect` |
| `no_utility`, `wheel_not_configured` | `roll_dice`, `spin_wheel` | roll or spin by hand (the wheel link) |
| `invalid_shading`, `shading_too_detailed`, `question_not_answered` | `set_question_shading` | pick fewer areas; `set_answer` first |
| `hiders_only`, `seekers_only` | team checks | `move_player` |
| `host_only` | host actions | `set_host` |
| `teams_locked` | `set_team` after start | `move_player` |
| `round_not_running` | in-round actions | none needed: there is no round to fix |
| `stale_state` | every game action | none needed: the phone resyncs and retries |
| `not_a_player` | every action | Rejoin with the saved code (existing) |
| `game_ended`, `game_not_found` | `join_game`, actions | none needed |

### Not game-blocking (no override)

These refuse bad input in the lobby or the shared library. Correcting the input is the fix, and nothing is running yet:

- Lobby: `config_locked`, `play_area_locked`, `venues_locked`, `already_started`, `players_without_team`, `needs_both_teams`, `play_area_required`, `hiding_period_required`, `invalid_config`, `invalid_deck`, `cannot_remove_host`, `player_not_found`.
- Play areas: `play_area_*`, `invalid_play_area*`.
- Card library: `invalid_card*`, `card_changed`, `category_*`, `invalid_category*`.
- Deck presets: `preset_*`, `invalid_preset_name`.
- Push: `invalid_push_subscription`.
- Plumbing: `not_signed_in`, `client_action_id_*`, `library_edits_append_only`, `invalid_city_pack`, `unsupported_city_pack_version`, `invalid_position`.

### Refusals of `host_override` itself

`invalid_reason`, `unknown_override`, `invalid_override`, `request_not_open`, `no_penalty`, `proof_not_found`, `timer_paused`, `timer_not_paused`, `timer_not_running`, `no_timer`, `veto_not_found`, `already_void`, `ban_not_found`, `effect_active`, `not_moving`, `same_team`, `already_host`, `override_not_found`, `already_undone`, `undo_conflict`. Each is a "that's already the case" or "pick something else" answer. None of them blocks play.
