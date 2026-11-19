-- Rounds, scoring and ending a game (docs/spec.md §1 "Ending a game", §11).
--
--   * found_hider (seekers, while seeking): the seekers found the hiders. Scores the round
--     (hide time = found − seeking start, plus the time bonuses in the hand), reveals the bar,
--     sets status round_over and swaps every player's team for the next round. Public
--     round_ended, then team_changed per player (no actor: nobody chose it).
--   * start_next_round (any hider of the next round, or the host; round_over): the hiders
--     say when they're ready to go, so the seekers and hiders can talk first. Deals a fresh
--     deck and starts the hiding period, logged as game_started (next_round true) like the
--     first round, from the game's config and play-area snapshot.
--   * set_team works between rounds too (the host moves anyone, players themselves).
--   * end_game (host): status ended, winner from the round scores, public game_ended with the
--     result. A round still running doesn't count. end_stale_games (any signed-in user; the
--     keep-alive job calls it, and so does every new game) ends games with no events for 24 h.
--   * Score per player: the total of every round they hid (rounds a redo voided don't count).
--     Winners: the players with the highest total; none if no round was scored.
--   * Join codes only have to be unique among games that aren't ended, so ended games free
--     theirs. Joining by code only finds games that aren't ended.
--   * Overrides (host only, public): adjust_score (round, seconds: add or take away hide time)
--     and redo_round (the round running or just finished is voided and its hiders play it
--     again; teams go back to that round's). Both work between rounds as well.

-- ---------------------------------------------------------------------------
-- Join codes return to the pool
-- ---------------------------------------------------------------------------

alter table public.games drop constraint games_code_key;
create unique index games_code_open_idx on public.games (code) where status <> 'ended';

create or replace function public._new_game_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  v_code text;
begin
  loop
    v_code := '';
    for i in 1..4 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.games where code = v_code and status <> 'ended');
  end loop;
  return v_code;
end;
$$;

-- As in the core schema, but a code only finds a game that isn't ended.
create or replace function public.join_game(p_code text, p_name text, p_client_action_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public._require_user();
  v_prev jsonb := public._previous_result(p_client_action_id, v_uid);
  v_game_id uuid;
  v_game public.games;
  v_seq bigint;
begin
  if v_prev is not null then
    return v_prev;
  end if;

  select id into v_game_id from public.games where code = upper(btrim(p_code)) and status <> 'ended';
  if v_game_id is null then
    raise exception 'game_not_found' using errcode = 'P0001';
  end if;

  v_game := public._lock_game(v_game_id);

  if exists (select 1 from public.players where game_id = v_game.id and user_id = v_uid) then
    return public._record_result(p_client_action_id, v_uid, v_game.id,
      jsonb_build_object('game_id', v_game.id, 'code', v_game.code, 'seq', v_game.last_seq, 'rejoined', true));
  end if;

  if v_game.status = 'ended' then
    raise exception 'game_ended' using errcode = 'P0001';
  end if;

  insert into public.players (game_id, user_id, name)
  values (v_game.id, v_uid, btrim(p_name));

  v_seq := public._append_event(v_game.id, 'player_joined',
    jsonb_build_object('user_id', v_uid, 'name', btrim(p_name)));

  return public._record_result(p_client_action_id, v_uid, v_game.id,
    jsonb_build_object('game_id', v_game.id, 'code', v_game.code, 'seq', v_seq));
end;
$$;

-- ---------------------------------------------------------------------------
-- Rounds
-- ---------------------------------------------------------------------------

-- One row per round that ended (found, or redone). No client access: events carry it all.
create table public.game_rounds (
  game_id uuid not null references public.games (id) on delete cascade,
  round integer not null check (round >= 1),
  hiders jsonb not null check (jsonb_typeof(hiders) = 'array'),
  seekers jsonb not null check (jsonb_typeof(seekers) = 'array'),
  seeking_at timestamptz,
  ended_at timestamptz not null default now(),
  found_by uuid,
  bar_name text,
  hide_s integer not null default 0,
  bonus_s integer not null default 0,
  adjust_s integer not null default 0,
  -- Redone: played again, doesn't count.
  voided boolean not null default false,
  primary key (game_id, round)
);
alter table public.game_rounds enable row level security;
revoke all on public.game_rounds from anon, authenticated;

create trigger game_rounds_capture_override
after insert or update or delete on public.game_rounds
for each row execute function public._capture_override_change();

create function public._team_list(p_game_id uuid, p_team public.team)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('user_id', user_id, 'name', name) order by joined_at), '[]'::jsonb)
    from public.players where game_id = p_game_id and team = p_team;
$$;

create function public._round_json(r public.game_rounds)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'round', r.round,
    'hiders', r.hiders,
    'seekers', r.seekers,
    'seeking_at', public._iso(r.seeking_at),
    'ended_at', public._iso(r.ended_at),
    'found_by', r.found_by,
    'bar_name', r.bar_name,
    'hide_s', r.hide_s,
    'bonus_s', r.bonus_s,
    'adjust_s', r.adjust_s,
    'total_s', r.hide_s + r.bonus_s + r.adjust_s,
    'voided', r.voided);
$$;

-- The final result: every round, each player's total (rounds they hid), the winners.
create function public._game_result(p_game_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with r as (
    select * from public.game_rounds where game_id = p_game_id
  ),
  hid as (
    select h ->> 'user_id' as user_id, max(h ->> 'name') as name,
           sum(r.hide_s + r.bonus_s + r.adjust_s)::integer as total_s, count(*)::integer as rounds
      from r, jsonb_array_elements(r.hiders) h
     where not r.voided
     group by 1
  ),
  people as (
    select coalesce(p.user_id::text, hid.user_id) as user_id,
           coalesce(p.name, hid.name) as name,
           coalesce(hid.total_s, 0) as total_s,
           coalesce(hid.rounds, 0) as rounds,
           p.joined_at
      from (select * from public.players where game_id = p_game_id) p
      full join hid on hid.user_id = p.user_id::text
  )
  select jsonb_build_object(
    'rounds', coalesce((select jsonb_agg(public._round_json(r) order by r.round) from r), '[]'::jsonb),
    'players', coalesce((select jsonb_agg(jsonb_build_object('user_id', user_id, 'name', name,
                                  'total_s', total_s, 'rounds', rounds) order by total_s desc, joined_at nulls last)
                           from people), '[]'::jsonb),
    'winners', case when exists (select 1 from r where not r.voided)
                    then coalesce((select jsonb_agg(user_id order by joined_at nulls last) from people
                                    where total_s = (select max(total_s) from people)), '[]'::jsonb)
                    else '[]'::jsonb end);
$$;

-- End a game: status ended (frees the code), public game_ended with the result.
create function public._finish_game(p_game public.games, p_reason text, p_actor uuid)
returns bigint
language plpgsql
set search_path = ''
as $$
begin
  update public.games set status = 'ended' where id = p_game.id;
  delete from public.timer_pauses where game_id = p_game.id;
  return public._append_event(p_game.id, 'game_ended',
    public._game_result(p_game.id) || jsonb_build_object(
      'reason', p_reason,
      'at', now(),
      -- A round still running when the game ended doesn't count.
      'unfinished_round', case when p_game.status in ('hiding', 'seeking') then p_game.round end),
    'all', p_actor);
end;
$$;

-- Nothing settles once the round is over (a pending question can't turn overdue between
-- rounds), and only this round's questions do. Otherwise as in 20261213090000_host_overrides.sql.
create or replace function public._settle_timers(p_game_id uuid)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_game public.games;
  v_q public.questions;
  v_n integer := 0;
  v_seeking_at timestamptz;
  v_proof uuid;
begin
  select * into v_game from public.games where id = p_game_id;
  if v_game.status not in ('hiding', 'seeking') then
    return 0;
  end if;

  if v_game.status = 'hiding' and v_game.round_started_at is not null and v_game.hiding_period_s is not null then
    v_seeking_at := v_game.round_started_at + make_interval(secs => v_game.hiding_period_s);
    if now() >= v_seeking_at then
      update public.games set status = 'seeking' where id = p_game_id;
      perform public._append_event(p_game_id, 'seeking_started',
        jsonb_build_object('round', v_game.round, 'at', v_seeking_at), 'all', null);
      v_n := v_n + 1;
    end if;
  end if;

  for v_q in
    select * from public.questions
    where game_id = p_game_id and round = v_game.round
      and answered_at is null and penalised_at is null and deadline_at <= now()
    for update
  loop
    update public.questions set penalised_at = now() where id = v_q.id;
    perform public._append_event(p_game_id, 'answer_overdue', jsonb_build_object(
      'question_id', v_q.id,
      'type', v_q.type,
      'deadline_at', v_q.deadline_at,
      'team', 'hiders',
      'penalty', 'shot'
    ), 'all', null);
    v_proof := public._drink_due(v_game, 'hiders', 'shot', 'Missed answer deadline');
    if v_proof is not null then
      update public.drink_proofs set question_id = v_q.id where id = v_proof;
    end if;
    v_n := v_n + 1;
  end loop;

  return v_n;
end;
$$;

-- Swap every player's team. One team_changed each, no actor (nobody chose it).
create function public._swap_teams(p_game_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_p public.players;
begin
  for v_p in
    update public.players
       set team = case team when 'hiders' then 'seekers'::public.team else 'hiders'::public.team end
     where game_id = p_game_id and team is not null
    returning *
  loop
    perform public._append_event(p_game_id, 'team_changed', jsonb_build_object(
      'user_id', v_p.user_id, 'team', v_p.team, 'by', null, 'swap', true), 'all', null);
  end loop;
  delete from public.seeker_positions where game_id = p_game_id;
end;
$$;

-- The seekers found the hiders: the round is scored and over; teams swap for the next one.
create function public.found_hider(p_game_id uuid, p_client_action_id uuid, p_last_seen_seq bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public._require_user();
  v_prev jsonb := public._previous_result(p_client_action_id, v_uid);
  v_game public.games;
  v_bar public.hider_bars;
  v_seeking_at timestamptz;
  v_bonus integer;
  v_r public.game_rounds;
  v_seq bigint;
begin
  if v_prev is not null then
    return v_prev;
  end if;

  v_game := public._lock_game(p_game_id);
  perform public._require_team(p_game_id, v_uid, 'seekers');
  if v_game.status not in ('hiding', 'seeking') then
    raise exception 'round_not_running' using errcode = 'P0001';
  end if;
  perform public._require_fresh(p_game_id, v_uid, p_last_seen_seq);
  -- Anything due before now (seeking start, missed deadlines) happened before the find.
  perform public._settle_timers(p_game_id);
  select * into v_game from public.games where id = p_game_id;
  if v_game.status <> 'seeking' then
    raise exception 'not_seeking_yet' using errcode = 'P0001';
  end if;

  v_seeking_at := v_game.round_started_at + make_interval(secs => v_game.hiding_period_s);
  -- Time bonuses count while held in the hand at the end of the round.
  select coalesce(sum(round((g.params ->> 'minutes')::numeric * 60)), 0)::integer into v_bonus
    from public.card_instances i
    join public.game_cards g on g.game_id = i.game_id and g.round = i.round and g.card_id = i.card_id
   where i.game_id = p_game_id and i.round = v_game.round and i.location = 'hand'
     and g.behaviour = 'time_bonus' and jsonb_typeof(g.params -> 'minutes') = 'number'
     and (g.params ->> 'minutes')::numeric > 0;
  select * into v_bar from public.hider_bars where game_id = p_game_id and round = v_game.round;

  insert into public.game_rounds (game_id, round, hiders, seekers, seeking_at, found_by, bar_name, hide_s, bonus_s)
  values (p_game_id, v_game.round, public._team_list(p_game_id, 'hiders'), public._team_list(p_game_id, 'seekers'),
          v_seeking_at, v_uid, v_bar.venue_name,
          greatest(0, floor(extract(epoch from now() - v_seeking_at)))::integer, v_bonus)
  returning * into v_r;

  update public.games set status = 'round_over' where id = p_game_id;
  delete from public.timer_pauses where game_id = p_game_id;

  -- The round is over, so where they were is no secret any more.
  v_seq := public._append_event(p_game_id, 'round_ended', jsonb_build_object(
    'round', v_game.round,
    'score', public._round_json(v_r),
    'bar', case when v_bar.venue_id is null then null else jsonb_build_object(
      'name', v_bar.venue_name,
      'lng', round(extensions.st_x(v_bar.geom)::numeric, 6),
      'lat', round(extensions.st_y(v_bar.geom)::numeric, 6)) end));
  perform public._swap_teams(p_game_id);

  return public._record_result(p_client_action_id, v_uid, p_game_id, jsonb_build_object(
    'game_id', p_game_id,
    'seq', (select last_seq from public.games where id = p_game_id),
    'round', v_game.round,
    'total_s', v_r.hide_s + v_r.bonus_s + v_r.adjust_s));
end;
$$;

-- The next round's hiders are ready to go: deal a fresh deck and start the hiding period.
create function public.start_next_round(p_game_id uuid, p_client_action_id uuid, p_last_seen_seq bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public._require_user();
  v_prev jsonb := public._previous_result(p_client_action_id, v_uid);
  v_game public.games;
  v_me public.players;
  v_area public.play_areas;
  v_geojson jsonb;
  v_hiding jsonb;
  v_hiding_s integer;
  v_round integer;
  v_teams jsonb;
  v_deck jsonb;
  v_seq bigint;
begin
  if v_prev is not null then
    return v_prev;
  end if;

  v_game := public._lock_game(p_game_id);
  select * into v_me from public.players where game_id = p_game_id and user_id = v_uid;
  if not found then
    raise exception 'not_a_player' using errcode = 'P0001';
  end if;
  if v_me.team is distinct from 'hiders' and v_game.host_id <> v_uid then
    raise exception 'hiders_only' using errcode = 'P0001';
  end if;
  if v_game.status <> 'round_over' then
    raise exception 'round_not_over' using errcode = 'P0001';
  end if;
  perform public._require_fresh(p_game_id, v_uid, p_last_seen_seq);

  if exists (select 1 from public.players where game_id = p_game_id and team is null) then
    raise exception 'players_without_team' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.players where game_id = p_game_id and team = 'hiders')
     or not exists (select 1 from public.players where game_id = p_game_id and team = 'seekers') then
    raise exception 'needs_both_teams' using errcode = 'P0001';
  end if;

  -- Same play area as the first round (its snapshot: the saved map may have changed since).
  select * into v_area from public.play_areas where id = v_game.play_area_id;
  v_geojson := coalesce(v_game.play_area_snapshot, v_area.geojson);
  if v_geojson is null then
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

  v_deck := public._deal_deck(v_game, v_round);
  delete from public.timer_pauses where game_id = p_game_id;

  update public.games
     set status = 'hiding',
         round = v_round,
         round_started_at = now(),
         hiding_period_s = v_hiding_s,
         play_area_snapshot = v_geojson
   where id = p_game_id;

  v_seq := public._append_event(p_game_id, 'game_started', jsonb_build_object(
    'round', v_round,
    'next_round', true,
    'started_at', now(),
    'hiding_period_s', v_hiding_s,
    'config', v_game.config,
    'play_area', jsonb_build_object('id', v_game.play_area_id, 'name', v_area.name, 'geojson', v_geojson),
    'venues', public._venues_snapshot(p_game_id),
    'players', v_teams,
    'deck', v_deck,
    'hand_limit', public._hand_limit(v_game.config)
  ));

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq, 'round', v_round));
end;
$$;

-- The host ends the game, from anywhere (a round still running doesn't count).
create function public.end_game(p_game_id uuid, p_client_action_id uuid, p_last_seen_seq bigint)
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

  v_game := public._lock_game(p_game_id);
  if v_game.host_id <> v_uid then
    raise exception 'host_only' using errcode = 'P0001';
  end if;
  if v_game.status = 'ended' then
    raise exception 'game_ended' using errcode = 'P0001';
  end if;
  perform public._require_fresh(p_game_id, v_uid, p_last_seen_seq);

  v_seq := public._finish_game(v_game, 'host', v_uid);

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq));
end;
$$;

-- Games that started and then saw no events for 24 h are ended (lobbies are deleted instead,
-- by _sweep_stale_lobbies). Returns how many.
create function public._end_stale_games()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
  v_game public.games;
  v_n integer := 0;
begin
  for v_id in
    select g.id from public.games g
     where g.status in ('hiding', 'seeking', 'round_over')
       and coalesce((select e.created_at from public.events e where e.game_id = g.id and e.seq = g.last_seq),
                    g.updated_at) < now() - interval '24 hours'
     for update skip locked
  loop
    select * into v_game from public.games where id = v_id;
    perform public._finish_game(v_game, 'inactive', null);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- Callable by any signed-in user: it only ends games nobody has touched for a day. The
-- keep-alive GitHub Action calls it every 3 days.
create function public.end_stale_games()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public._require_user();
  return public._end_stale_games();
end;
$$;

-- New games also tidy up: as in 20261124090000_sweep_stale_lobbies.sql, plus ending stale games.
create or replace function public._sweep_stale_lobbies()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.games g
  where g.status = 'lobby'
    and greatest(
          g.created_at,
          coalesce((select e.created_at from public.events e
                    where e.game_id = g.id and e.seq = g.last_seq), g.created_at)
        ) < now() - interval '24 hours';
  perform public._end_stale_games();
  return null;
end;
$$;

-- Teams can change between rounds too. Otherwise as in the core schema.
create or replace function public.set_team(
  p_game_id uuid,
  p_team public.team,
  p_client_action_id uuid,
  p_user_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public._require_user();
  v_prev jsonb := public._previous_result(p_client_action_id, v_uid);
  v_target uuid := coalesce(p_user_id, v_uid);
  v_game public.games;
  v_seq bigint;
begin
  if v_prev is not null then
    return v_prev;
  end if;

  v_game := public._lock_game(p_game_id);

  if not exists (select 1 from public.players where game_id = p_game_id and user_id = v_uid) then
    raise exception 'not_a_player' using errcode = 'P0001';
  end if;
  if v_target <> v_uid and v_game.host_id <> v_uid then
    raise exception 'host_only' using errcode = 'P0001';
  end if;
  if v_game.status not in ('lobby', 'round_over') then
    raise exception 'teams_locked' using errcode = 'P0001';
  end if;

  update public.players set team = p_team
   where game_id = p_game_id and user_id = v_target;
  if not found then
    raise exception 'player_not_found' using errcode = 'P0001';
  end if;

  v_seq := public._append_event(p_game_id, 'team_changed',
    jsonb_build_object('user_id', v_target, 'team', p_team, 'by', v_uid));

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq));
end;
$$;

-- ---------------------------------------------------------------------------
-- Overrides: adjust_score, redo_round
-- ---------------------------------------------------------------------------

create function public._fmt_min(p_s integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_s > 0 then '+' when p_s < 0 then '−' else '' end
    || trim(trailing '.' from trim(trailing '0' from round(abs(p_s) / 60.0, 1)::text)) || ' min';
$$;

create function public._names(p_list jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(string_agg(x ->> 'name', ', '), 'nobody') from jsonb_array_elements(p_list) x;
$$;

-- Host only, public, and they work between rounds too (the other kinds need a round running).
create function public._override_round(
  p_game_id uuid,
  p_kind text,
  p_params jsonb,
  p_reason text,
  p_client_action_id uuid,
  p_last_seen_seq bigint
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_uid uuid := public._require_user();
  v_prev jsonb := public._previous_result(p_client_action_id, v_uid);
  v_game public.games;
  v_params jsonb := coalesce(p_params, '{}'::jsonb);
  v_reason text := btrim(coalesce(p_reason, ''));
  v_oid uuid := gen_random_uuid();
  v_summary text;
  v_round integer;
  v_s integer;
  v_r public.game_rounds;
  v_bar public.hider_bars;
  v_p public.players;
  v_seq bigint;
begin
  if v_prev is not null then
    return v_prev;
  end if;

  v_game := public._lock_game(p_game_id);
  if not exists (select 1 from public.players where game_id = p_game_id and user_id = v_uid) then
    raise exception 'not_a_player' using errcode = 'P0001';
  end if;
  if v_game.host_id <> v_uid then
    raise exception 'host_only' using errcode = 'P0001';
  end if;
  if jsonb_typeof(v_params) <> 'object' then
    raise exception 'invalid_override' using errcode = 'P0001';
  end if;
  if char_length(v_reason) not between 1 and 120 then
    raise exception 'invalid_reason' using errcode = 'P0001';
  end if;
  if v_game.status = 'ended' then
    raise exception 'game_ended' using errcode = 'P0001';
  end if;
  if v_game.status not in ('hiding', 'seeking', 'round_over') then
    raise exception 'round_not_running' using errcode = 'P0001';
  end if;
  perform public._require_fresh(p_game_id, v_uid, p_last_seen_seq);
  -- Anything already due happened before the fix.
  perform public._settle_timers(p_game_id);
  select * into v_game from public.games where id = p_game_id;

  insert into public.game_overrides (id, game_id, round, kind, params, reason, private, by_user)
  values (v_oid, p_game_id, v_game.round, p_kind, v_params, v_reason, false, v_uid);
  perform set_config('hd.override_id', v_oid::text, true);

  if p_kind = 'adjust_score' then
    if jsonb_typeof(v_params -> 'seconds') <> 'number'
       or (v_params ->> 'seconds')::numeric <> trunc((v_params ->> 'seconds')::numeric)
       or (v_params ->> 'seconds')::numeric not between -86400 and 86400
       or (v_params ->> 'seconds')::numeric = 0 then
      raise exception 'invalid_override' using errcode = 'P0001', detail = 'seconds';
    end if;
    v_s := (v_params ->> 'seconds')::integer;
    if v_params ? 'round' then
      if jsonb_typeof(v_params -> 'round') <> 'number' then
        raise exception 'invalid_override' using errcode = 'P0001', detail = 'round';
      end if;
      v_round := (v_params ->> 'round')::integer;
    else
      select max(round) into v_round from public.game_rounds where game_id = p_game_id and not voided;
    end if;
    update public.game_rounds set adjust_s = adjust_s + v_s
     where game_id = p_game_id and round = v_round and not voided
    returning * into v_r;
    if v_r.round is null then
      raise exception 'round_not_found' using errcode = 'P0001';
    end if;
    perform public._append_event(p_game_id, 'score_adjusted', jsonb_build_object(
      'round', v_r.round, 'seconds', v_s, 'score', public._round_json(v_r)));
    v_summary := format('Round %s: %s for %s', v_r.round, public._fmt_min(v_s), public._names(v_r.hiders));

  elsif p_kind = 'redo_round' then
    v_round := v_game.round;
    if v_game.status in ('hiding', 'seeking') then
      -- Stop the round now; the same teams play it again.
      select * into v_bar from public.hider_bars where game_id = p_game_id and round = v_round;
      insert into public.game_rounds (game_id, round, hiders, seekers, seeking_at, bar_name, voided)
      values (p_game_id, v_round, public._team_list(p_game_id, 'hiders'), public._team_list(p_game_id, 'seekers'),
              case when v_game.status = 'seeking'
                   then v_game.round_started_at + make_interval(secs => v_game.hiding_period_s) end,
              v_bar.venue_name, true)
      returning * into v_r;
      update public.games set status = 'round_over' where id = p_game_id;
    else
      update public.game_rounds set voided = true
       where game_id = p_game_id and round = v_round and not voided
      returning * into v_r;
      if v_r.round is null then
        raise exception 'round_not_found' using errcode = 'P0001';
      end if;
      -- Teams go back to how they were for that round.
      for v_p in
        update public.players p
           set team = case when exists (select 1 from jsonb_array_elements(v_r.hiders) h where h ->> 'user_id' = p.user_id::text)
                           then 'hiders'::public.team else 'seekers'::public.team end
         where p.game_id = p_game_id
           and exists (select 1 from jsonb_array_elements(v_r.hiders || v_r.seekers) x where x ->> 'user_id' = p.user_id::text)
           and p.team is distinct from case when exists (select 1 from jsonb_array_elements(v_r.hiders) h where h ->> 'user_id' = p.user_id::text)
                                            then 'hiders'::public.team else 'seekers'::public.team end
        returning p.*
      loop
        perform public._append_event(p_game_id, 'team_changed', jsonb_build_object(
          'user_id', v_p.user_id, 'team', v_p.team, 'by', v_uid));
      end loop;
    end if;
    delete from public.timer_pauses where game_id = p_game_id;
    delete from public.seeker_positions where game_id = p_game_id;
    perform public._append_event(p_game_id, 'round_redone', jsonb_build_object(
      'round', v_r.round, 'score', public._round_json(v_r)));
    v_summary := format('Round %s will be played again (%s hiding)', v_r.round, public._names(v_r.hiders));

  else
    raise exception 'unknown_override' using errcode = 'P0001';
  end if;

  perform set_config('hd.override_id', '', true);
  update public.game_overrides set summary = v_summary where id = v_oid;

  v_seq := public._append_event(p_game_id, 'override', jsonb_build_object(
    'override_id', v_oid,
    'kind', p_kind,
    'reason', v_reason,
    'by', v_uid,
    'summary', v_summary,
    'private', false,
    'request_id', null,
    'target_id', null,
    'params', v_params));

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq, 'override_id', v_oid));
end;
$$;

-- As in 20261215090000_undo_both_teams.sql, plus the round kinds.
create or replace function public.host_override(
  p_game_id uuid,
  p_kind text,
  p_params jsonb,
  p_reason text,
  p_client_action_id uuid,
  p_last_seen_seq bigint,
  p_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_request_id is not null then
    if exists (select 1 from public.override_requests where id = p_request_id and game_id = p_game_id and kind = 'undo') then
      return public._override_undo_vote(p_game_id, p_request_id, p_kind, p_client_action_id, p_last_seen_seq);
    end if;
  elsif p_kind = 'undo' then
    return public._override_undo_request(p_game_id, p_params, p_reason, p_client_action_id, p_last_seen_seq);
  elsif p_kind in ('adjust_score', 'redo_round') then
    return public._override_round(p_game_id, p_kind, p_params, p_reason, p_client_action_id, p_last_seen_seq);
  end if;
  return public._host_override_core(p_game_id, p_kind, p_params, p_reason, p_client_action_id, p_last_seen_seq, p_request_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Push alerts: round over, next round, game over (everyone). As in
-- 20261218090000_video_and_setup_proofs.sql otherwise.
-- ---------------------------------------------------------------------------

create or replace function public._push_for_event(p_type text, p_visibility public.event_visibility, p_payload jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_type text := initcap(coalesce(p_payload ->> 'type', 'question'));
  v_mins integer;
  v_alert jsonb;
begin
  case p_type
    when 'question_asked' then
      v_mins := ceil(coalesce((p_payload ->> 'deadline_s')::numeric, 300) / 60);
      v_alert := jsonb_build_object('audience', 'hiders', 'title', 'New question',
        'body', format('%s question: answer within %s min.', v_type, v_mins));
    when 'question_answered' then
      v_alert := jsonb_build_object('audience', 'seekers', 'title', 'Question answered',
        'body', format('The hiders answered your %s question.', lower(v_type)));
    when 'card_played' then
      if p_payload -> 'card' ->> 'category' = 'curse' then
        v_alert := jsonb_build_object('audience', 'seekers',
          'title', 'Curse: ' || coalesce(p_payload -> 'card' ->> 'name', 'a curse'),
          'body', 'The hiders cast a curse on you. Open the app to see it.');
      elsif jsonb_typeof(p_payload -> 'card' -> 'params' -> 'drinks') = 'array'
            and jsonb_array_length(p_payload -> 'card' -> 'params' -> 'drinks') > 0 then
        v_alert := jsonb_build_object(
          'audience', case when jsonb_array_length(p_payload -> 'card' -> 'params' -> 'drinks') = 1
                           then p_payload -> 'card' -> 'params' -> 'drinks' ->> 0 else 'all' end,
          'title', coalesce(p_payload -> 'card' ->> 'name', 'Drinks'),
          'body', coalesce(p_payload -> 'card' ->> 'text', 'Time to drink.'));
      end if;
    when 'curse_checked' then
      v_alert := jsonb_build_object('audience', 'hiders',
        'title', case when (p_payload ->> 'applies')::boolean then 'Curse applies' else 'Curse doesn''t apply' end,
        'body', case when (p_payload ->> 'applies')::boolean
                     then 'The seekers confirmed your curse: it has started.'
                     else 'The seekers say your curse doesn''t apply, so it was dropped.' end);
    when 'drink_proved' then
      v_alert := jsonb_build_object(
        'audience', case p_payload ->> 'team' when 'hiders' then 'seekers' else 'hiders' end,
        'title', case p_payload ->> 'kind'
                   when 'setup' then 'Hiders sent the ' || coalesce(p_payload ->> 'label', 'curse') || ' proof'
                   when 'evidence' then 'Seekers sent proof'
                   else initcap(coalesce(p_payload ->> 'team', 'team')) || ' drank' end,
        'body', case p_payload ->> 'kind'
                  when 'setup' then 'Open the app to see what you have to beat.'
                  when 'evidence' then coalesce(p_payload ->> 'label', 'Curse') || ': check it and confirm.'
                  else coalesce(p_payload ->> 'label', 'Drink') || ': done, photo in the log.' end);
    when 'freeze_changed' then
      v_alert := case when (p_payload ->> 'frozen')::boolean
        then jsonb_build_object('audience', 'hiders', 'title', 'Freeze',
               'body', 'A seeker is near your bar. Stay where you are.')
        else jsonb_build_object('audience', 'hiders', 'title', 'Freeze over', 'body', 'You can move again.') end;
    when 'round_ended' then
      v_alert := jsonb_build_object('audience', 'all', 'title', 'Found!',
        'body', format('Round %s is over. Swap roles: the next round starts when the new hiders are ready.',
                       p_payload ->> 'round'));
    when 'game_started' then
      if (p_payload ->> 'next_round')::boolean then
        v_alert := jsonb_build_object('audience', 'all', 'title', format('Round %s', p_payload ->> 'round'),
          'body', 'The hiding period has started.');
      end if;
    when 'game_ended' then
      v_alert := jsonb_build_object('audience', 'all', 'title', 'Game over', 'body', 'Open the app to see who won.');
    else
      v_alert := null;
  end case;
  if v_alert is null then
    return null;
  end if;
  if p_visibility <> 'all' and v_alert ->> 'audience' <> p_visibility::text then
    return null;
  end if;
  return v_alert;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke execute on function
  public._new_game_code(),
  public.join_game(text, text, uuid),
  public._team_list(uuid, public.team),
  public._round_json(public.game_rounds),
  public._game_result(uuid),
  public._finish_game(public.games, text, uuid),
  public._settle_timers(uuid),
  public._swap_teams(uuid),
  public.found_hider(uuid, uuid, bigint),
  public.start_next_round(uuid, uuid, bigint),
  public.end_game(uuid, uuid, bigint),
  public._end_stale_games(),
  public.end_stale_games(),
  public._sweep_stale_lobbies(),
  public.set_team(uuid, public.team, uuid, uuid),
  public._fmt_min(integer),
  public._names(jsonb),
  public._override_round(uuid, text, jsonb, text, uuid, bigint),
  public.host_override(uuid, text, jsonb, text, uuid, bigint, uuid),
  public._push_for_event(text, public.event_visibility, jsonb)
from public, anon, authenticated;

grant execute on function
  public.join_game(text, text, uuid),
  public.found_hider(uuid, uuid, bigint),
  public.start_next_round(uuid, uuid, bigint),
  public.end_game(uuid, uuid, bigint),
  public.end_stale_games(),
  public.set_team(uuid, public.team, uuid, uuid),
  public.host_override(uuid, text, jsonb, text, uuid, bigint, uuid)
to authenticated;
