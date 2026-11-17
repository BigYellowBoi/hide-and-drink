import { ActionError } from '../sync/actions'

const MESSAGES: Record<string, string> = {
  game_not_found: 'No game with that code.',
  game_ended: 'That game has ended.',
  host_only: 'Only the host can do that.',
  teams_locked: 'Teams are locked.',
  config_locked: 'Settings are locked.',
  play_area_locked: 'The play area is locked.',
  play_area_not_found: 'That play area is not available for this city.',
  invalid_play_area: 'That shape is not a usable area. Draw a closed shape.',
  invalid_play_area_name: 'Give the play area a name (up to 80 characters).',
  play_area_too_small: 'That area is too small (under 0.1 km²).',
  play_area_too_large: 'That area is too large (over 2000 km²).',
  play_area_too_detailed: 'That shape has too many corners (5000 max). Simplify it.',
  play_area_name_taken: 'A play area with that name already exists. Pick another name.',
  play_area_protected: 'Built-in maps can\'t be deleted.',
  play_area_in_use: 'A lobby is using that map. Pick a different map there first.',
  play_area_not_yours: 'Only whoever saved that area can change it. Save it as a new area instead.',
  already_started: 'The game has already started.',
  players_without_team: 'Everyone needs a team.',
  needs_both_teams: 'Need at least one hider and one seeker.',
  play_area_required: 'Choose a play area.',
  hiding_period_required: 'Set the hiding period (in General settings).',
  not_live: 'Not connected. Wait for the live dot.',
  not_a_player: 'You are not in this game. The host may have removed you, or the lobby closed after a day unused.',
  removed_from_game: 'The host removed you from this game.',
  cannot_remove_host: 'The host can\'t be removed.',
  player_not_found: 'That player has already left.',
  network: 'Network problem. Try again.',
}

export const describeCode = (code: string) => MESSAGES[code] ?? code.replace(/_/g, ' ')

export function describeError(e: unknown): string {
  if (e instanceof ActionError) return e.code === 'stale_state' ? e.message : describeCode(e.code)
  return e instanceof Error ? e.message : String(e)
}
