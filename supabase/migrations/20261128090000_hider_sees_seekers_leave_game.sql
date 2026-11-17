-- Two rule changes.
--
-- 1. Hiders see the seekers' positions. Seekers' GPS now goes to both teams: report_position
--    broadcasts on the hiders' topic as well, and hiders may read seeker_positions (current
--    round, rows of current seekers only, as before). Hider GPS still never leaves the phone.
--
-- 2. leave_game: a player leaving a lobby is removed from it. If they were the host, the
--    longest-standing remaining player becomes host. When the last player leaves, the lobby
--    counts as abandoned and is deleted (players, events and stored results cascade), which
--    also frees its join code. Lobby only: once a round starts, teams are locked, so leaving
--    a running game only forgets it on that phone.

create or replace function public.can_see_seeker_position(p_game_id uuid, p_user_id uuid, p_round integer)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.my_team(p_game_id) in ('seekers', 'hiders')
     and exists (select 1 from public.players where game_id = p_game_id and user_id = p_user_id and team = 'seekers')
     and exists (select 1 from public.games where id = p_game_id and round = p_round and status in ('hiding', 'seeking'));
$$;

create or replace function public.report_position(
  p_game_id uuid,
  p_lng double precision,
  p_lat double precision,
  p_accuracy_m real default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public._require_user();
  v_game public.games;
  v_msg jsonb;
begin
  if p_lng is null or p_lat is null or p_lng = 'NaN' or p_lat = 'NaN'
     or p_lng not between -180 and 180 or p_lat not between -90 and 90
     or (p_accuracy_m is not null and (p_accuracy_m = 'NaN' or p_accuracy_m < 0)) then
    raise exception 'invalid_position' using errcode = 'P0001';
  end if;

  -- Serialise with actions on this game, so the freeze check sees every earlier report.
  v_game := public._lock_game(p_game_id);

  if not exists (select 1 from public.players where game_id = p_game_id and user_id = v_uid and team = 'seekers') then
    raise exception 'seekers_only' using errcode = 'P0001';
  end if;
  if v_game.status not in ('hiding', 'seeking') then
    raise exception 'round_not_running' using errcode = 'P0001';
  end if;

  insert into public.seeker_positions (game_id, user_id, round, lng, lat, accuracy_m, reported_at)
  values (p_game_id, v_uid, v_game.round, p_lng, p_lat, p_accuracy_m, now())
  on conflict (game_id, user_id) do update set
    round = excluded.round, lng = excluded.lng, lat = excluded.lat,
    accuracy_m = excluded.accuracy_m, reported_at = excluded.reported_at;

  -- Both teams, on their team topics (never the shared topic: players without a team don't
  -- need it). Not an event: no seq, nothing in the log.
  v_msg := jsonb_build_object('game_id', p_game_id, 'user_id', v_uid, 'round', v_game.round,
    'lng', p_lng, 'lat', p_lat, 'accuracy_m', p_accuracy_m, 'at', now());
  perform realtime.send(v_msg, 'position', public.topic_for(p_game_id, 'seekers'), true);
  perform realtime.send(v_msg, 'position', public.topic_for(p_game_id, 'hiders'), true);

  perform public._update_freeze(v_game);

  return jsonb_build_object('ok', true, 'at', now());
end;
$$;

create function public.leave_game(p_game_id uuid, p_client_action_id uuid)
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
  v_new_host uuid;
  v_seq bigint;
begin
  if v_prev is not null then
    return v_prev;
  end if;

  v_game := public._lock_game(p_game_id);
  if v_game.status <> 'lobby' then
    raise exception 'teams_locked' using errcode = 'P0001';
  end if;

  delete from public.players where game_id = p_game_id and user_id = v_uid returning name into v_name;
  if v_name is null then
    raise exception 'not_a_player' using errcode = 'P0001';
  end if;

  if not exists (select 1 from public.players where game_id = p_game_id) then
    -- Abandoned. The result is stored without a game id: the game row is about to go, and
    -- processed_actions cascades with it.
    delete from public.games where id = p_game_id;
    return public._record_result(p_client_action_id, v_uid, null,
      jsonb_build_object('game_id', p_game_id, 'deleted', true));
  end if;

  if v_game.host_id = v_uid then
    select user_id into v_new_host from public.players
     where game_id = p_game_id order by joined_at, user_id limit 1;
    update public.games set host_id = v_new_host where id = p_game_id;
    update public.players set is_host = (user_id = v_new_host) where game_id = p_game_id;
  end if;

  v_seq := public._append_event(p_game_id, 'player_left',
    jsonb_build_object('user_id', v_uid, 'name', v_name, 'new_host_id', v_new_host));

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq, 'deleted', false));
end;
$$;

revoke execute on function
  public.can_see_seeker_position(uuid, uuid, integer),
  public.report_position(uuid, double precision, double precision, real),
  public.leave_game(uuid, uuid)
from public, anon, authenticated;

grant execute on function
  public.report_position(uuid, double precision, double precision, real),
  public.leave_game(uuid, uuid)
to authenticated;

-- RLS policies evaluate as the calling role.
grant execute on function public.can_see_seeker_position(uuid, uuid, integer) to authenticated;
