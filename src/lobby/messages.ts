import { ActionError } from '../sync/actions'

const MESSAGES: Record<string, string> = {
  game_not_found: 'No game with that code.',
  game_ended: 'That game has ended.',
  host_only: 'Only the host can do that.',
  teams_locked: 'Teams are locked.',
  config_locked: 'Settings are locked.',
  play_area_locked: 'The play area is locked.',
  play_area_not_found: 'That play area is not available for this city.',
  already_started: 'The game has already started.',
  players_without_team: 'Everyone needs a team.',
  needs_both_teams: 'Need at least one hider and one seeker.',
  play_area_required: 'Choose a play area.',
  hiding_period_required: 'Set the hiding period (in General settings).',
  not_live: 'Not connected. Wait for the live dot.',
  not_a_player: 'You are not in this game. The host may have removed you.',
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
