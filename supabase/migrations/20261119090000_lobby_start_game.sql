-- Lobby: choose a saved play area, and the host's "lock and start" action.
--
-- start_game locks teams and config (status leaves 'lobby', which every lobby action
-- checks), snapshots the play area polygon onto the game so later edits to the saved
-- area can't change a running game, and starts the hiding period timer
-- (round_started_at + hiding_period_s, server time).
-- Deck snapshot and server-side shuffle arrive with the deck builder (phase 3).

alter table public.games
  add column round integer not null default 0 check (round >= 0),
  add column round_started_at timestamptz,
  add column hiding_period_s integer check (hiding_period_s > 0),
  add column play_area_snapshot jsonb check (play_area_snapshot is null or jsonb_typeof(play_area_snapshot) = 'object');

-- game_created now carries the starting config, so the lobby can be derived from events alone.
create or replace function public.create_game(
  p_name text,
  p_client_action_id uuid,
  p_city text default 'brisbane',
  p_config jsonb default '{}'::jsonb
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
  v_seq bigint;
begin
  if v_prev is not null then
    return v_prev;
  end if;
  if p_config is not null and jsonb_typeof(p_config) <> 'object' then
    raise exception 'invalid_config' using errcode = 'P0001';
  end if;

  insert into public.games (code, host_id, city, config)
  values (public._new_game_code(), v_uid, coalesce(p_city, 'brisbane'), coalesce(p_config, '{}'::jsonb))
  returning * into v_game;

  insert into public.players (game_id, user_id, name, is_host)
  values (v_game.id, v_uid, btrim(p_name), true);

  v_seq := public._append_event(v_game.id, 'game_created',
    jsonb_build_object('code', v_game.code, 'city', v_game.city, 'host_id', v_uid,
      'host_name', btrim(p_name), 'config', v_game.config));

  return public._record_result(p_client_action_id, v_uid, v_game.id,
    jsonb_build_object('game_id', v_game.id, 'code', v_game.code, 'seq', v_seq));
end;
$$;

-- Host picks one of the saved play areas for the game's city (null clears it). Lobby only.
create function public.set_play_area(
  p_game_id uuid,
  p_play_area_id uuid,
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
  v_area public.play_areas;
  v_seq bigint;
begin
  if v_prev is not null then
    return v_prev;
  end if;

  v_game := public._lock_game(p_game_id);

  if v_game.host_id <> v_uid then
    raise exception 'host_only' using errcode = 'P0001';
  end if;
  if v_game.status <> 'lobby' then
    raise exception 'play_area_locked' using errcode = 'P0001';
  end if;
  if p_play_area_id is not null then
    select * into v_area from public.play_areas where id = p_play_area_id and city = v_game.city;
    if not found then
      raise exception 'play_area_not_found' using errcode = 'P0001';
    end if;
  end if;
  perform public._require_fresh(p_game_id, v_uid, p_last_seen_seq);

  update public.games set play_area_id = p_play_area_id where id = p_game_id;

  v_seq := public._append_event(p_game_id, 'play_area_changed',
    jsonb_build_object('play_area_id', p_play_area_id, 'name', v_area.name));

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq));
end;
$$;

-- Host locks teams, config and play area, and starts the hiding period.
create function public.start_game(
  p_game_id uuid,
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
  v_area public.play_areas;
  v_hiding jsonb;
  v_hiding_s integer;
  v_round integer;
  v_teams jsonb;
  v_seq bigint;
begin
  if v_prev is not null then
    return v_prev;
  end if;

  v_game := public._lock_game(p_game_id);

  if v_game.host_id <> v_uid then
    raise exception 'host_only' using errcode = 'P0001';
  end if;
  if v_game.status <> 'lobby' then
    raise exception 'already_started' using errcode = 'P0001';
  end if;
  perform public._require_fresh(p_game_id, v_uid, p_last_seen_seq);

  if exists (select 1 from public.players where game_id = p_game_id and team is null) then
    raise exception 'players_without_team' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.players where game_id = p_game_id and team = 'hiders')
     or not exists (select 1 from public.players where game_id = p_game_id and team = 'seekers') then
    raise exception 'needs_both_teams' using errcode = 'P0001';
  end if;

  select * into v_area from public.play_areas where id = v_game.play_area_id;
  if not found then
    raise exception 'play_area_required' using errcode = 'P0001';
  end if;

  v_hiding := v_game.config -> 'hiding_period_s';
  if v_hiding is null or jsonb_typeof(v_hiding) <> 'number'
     or (v_hiding #>> '{}')::numeric <= 0
     or (v_hiding #>> '{}')::numeric <> trunc((v_hiding #>> '{}')::numeric) then
    raise exception 'hiding_period_required' using errcode = 'P0001';
  end if;
  v_hiding_s := (v_hiding #>> '{}')::integer;
  v_round := v_game.round + 1;

  select jsonb_agg(jsonb_build_object('user_id', user_id, 'name', name, 'team', team) order by joined_at)
    into v_teams
    from public.players where game_id = p_game_id;

  update public.games
     set status = 'hiding',
         round = v_round,
         round_started_at = now(),
         hiding_period_s = v_hiding_s,
         play_area_snapshot = v_area.geojson
   where id = p_game_id;

  v_seq := public._append_event(p_game_id, 'game_started', jsonb_build_object(
    'round', v_round,
    'started_at', now(),
    'hiding_period_s', v_hiding_s,
    'config', v_game.config,
    'play_area', jsonb_build_object('id', v_area.id, 'name', v_area.name, 'geojson', v_area.geojson),
    'players', v_teams
  ));

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq, 'round', v_round));
end;
$$;

revoke execute on function
  public.create_game(text, uuid, text, jsonb),
  public.set_play_area(uuid, uuid, uuid, bigint),
  public.start_game(uuid, uuid, bigint)
from public, anon, authenticated;

grant execute on function
  public.create_game(text, uuid, text, jsonb),
  public.set_play_area(uuid, uuid, uuid, bigint),
  public.start_game(uuid, uuid, bigint)
to authenticated;
