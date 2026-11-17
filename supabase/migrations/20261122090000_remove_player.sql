-- Host removes a player from the lobby (wrong person, duplicate device, someone left).
-- Lobby only: once the game starts, teams, hands and positions depend on who is in it.
-- Deleting the players row revokes their access at once: RLS on events and the Realtime
-- topic checks both go through is_player. They can rejoin with the code if that was a mistake.

create function public.remove_player(
  p_game_id uuid,
  p_user_id uuid,
  p_client_action_id uuid,
  p_last_seen_seq bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public._require_user();
  v_prev jsonb := public._previous_result(p_client_action_id, v_uid);
  v_game public.games;
  v_name text;
  v_seq bigint;
begin
  if v_prev is not null then
    return v_prev;
  end if;

  v_game := public._lock_game(p_game_id);

  if v_game.host_id <> v_uid then
    raise exception 'host_only' using errcode = 'P0001';
  end if;
  if p_user_id = v_game.host_id then
    raise exception 'cannot_remove_host' using errcode = 'P0001';
  end if;
  if v_game.status <> 'lobby' then
    raise exception 'teams_locked' using errcode = 'P0001';
  end if;

  perform public._require_fresh(p_game_id, v_uid, p_last_seen_seq);

  delete from public.players where game_id = p_game_id and user_id = p_user_id
  returning name into v_name;
  if v_name is null then
    raise exception 'player_not_found' using errcode = 'P0001';
  end if;

  v_seq := public._append_event(p_game_id, 'player_removed',
    jsonb_build_object('user_id', p_user_id, 'name', v_name, 'by', v_uid));

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq));
end;
$$;

revoke execute on function public.remove_player(uuid, uuid, uuid, bigint) from public, anon, authenticated;
grant execute on function public.remove_player(uuid, uuid, uuid, bigint) to authenticated;
