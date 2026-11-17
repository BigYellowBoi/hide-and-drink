-- Questions: seekers ask, the hider answers within a deadline, late answers log a penalty.
-- Also the hider's bar lock-in, which the hider's phone needs to suggest answers.
--
-- * ask_question: seekers only, once the hiding period is over, one pending question at a
--   time. Radar and thermometer only for now (the other types need their own tools; they
--   are refused with question_type_not_supported). The deadline comes from the game config
--   (answer_deadline_s.<type>, then the question type's extra.deadline_s, then
--   answer_deadline_s.default, then 300 s) and is stored as a server timestamp.
-- * answer_question: hiders only. The hider always picks the answer; the app's suggestion
--   is computed on the hider's phone from hider-only data and never reaches the server.
--   An answer after the deadline is still accepted and marked late.
-- * Late penalty: _settle_timers runs at the start of every question action and from
--   settle_timers, which every phone calls when a timer it shows runs out. Whichever comes
--   first appends one answer_overdue event (a shot for the hiders). It also moves the game
--   from hiding to seeking once the hiding period is over. No scheduler needed.
-- * choose_bar: the hider locks in a venue from the city pack inside the play area, once per
--   round. Stored in a hider-only table and announced on the hiders' channel only.

-- ---------------------------------------------------------------------------
-- Tables (no client grants: clients derive state from events)
-- ---------------------------------------------------------------------------

create table public.questions (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  round integer not null,
  type text not null,
  option_id text not null,
  params jsonb not null check (jsonb_typeof(params) = 'object'),
  asked_by uuid not null,
  asked_at timestamptz not null default now(),
  deadline_at timestamptz not null,
  answer text,
  answered_by uuid,
  answered_at timestamptz,
  late boolean,
  penalised_at timestamptz,
  check ((answer is null) = (answered_at is null))
);

-- At most one unanswered question per game, whatever the code does.
create unique index questions_one_pending on public.questions (game_id) where answered_at is null;

create table public.hider_bars (
  game_id uuid not null references public.games (id) on delete cascade,
  round integer not null,
  venue_id text not null,
  name text not null,
  geom extensions.geometry(Point, 4326) not null,
  chosen_by uuid not null,
  chosen_at timestamptz not null default now(),
  primary key (game_id, round)
);

alter table public.questions enable row level security;
alter table public.hider_bars enable row level security;
revoke all on public.questions, public.hider_bars from anon, authenticated;
-- RLS on with no policies = no client access. The hider learns their bar from the
-- hiders-only bar_chosen event.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- [lon, lat] as a WGS84 point, or invalid_position.
create function public._lonlat(p jsonb)
returns extensions.geometry
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_lon double precision;
  v_lat double precision;
begin
  if p is null or jsonb_typeof(p) <> 'array' or jsonb_array_length(p) <> 2
     or jsonb_typeof(p -> 0) <> 'number' or jsonb_typeof(p -> 1) <> 'number' then
    raise exception 'invalid_position' using errcode = 'P0001';
  end if;
  v_lon := (p ->> 0)::double precision;
  v_lat := (p ->> 1)::double precision;
  if v_lon not between -180 and 180 or v_lat not between -90 and 90 then
    raise exception 'invalid_position' using errcode = 'P0001';
  end if;
  return extensions.st_setsrid(extensions.st_makepoint(v_lon, v_lat), 4326);
end;
$$;

create function public._lonlat_json(p extensions.geometry)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_array(round(extensions.st_x(p)::numeric, 6), round(extensions.st_y(p)::numeric, 6));
$$;

-- Seconds the hider gets to answer this question type in this game.
create function public._answer_deadline_s(p_config jsonb, p_type text, p_extra jsonb)
returns integer
language plpgsql
immutable
set search_path = ''
as $$
declare
  v jsonb;
begin
  foreach v in array array[
    p_config #> array['answer_deadline_s', p_type],
    p_extra -> 'deadline_s',
    p_config #> array['answer_deadline_s', 'default']
  ] loop
    if v is not null and jsonb_typeof(v) = 'number' and (v #>> '{}')::numeric >= 1 then
      return round((v #>> '{}')::numeric)::integer;
    end if;
  end loop;
  return 300;
end;
$$;

-- Apply whatever the clock has made due. Call with the game row locked. Returns the number
-- of events appended. System events have no actor.
create function public._settle_timers(p_game_id uuid)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_game public.games;
  v_q public.questions;
  v_n integer := 0;
  v_seeking_at timestamptz;
begin
  select * into v_game from public.games where id = p_game_id;

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
    where game_id = p_game_id and answered_at is null and penalised_at is null and deadline_at <= now()
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
    v_n := v_n + 1;
  end loop;

  return v_n;
end;
$$;

create function public._require_team(p_game_id uuid, p_user uuid, p_team public.team)
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  v_team public.team;
  v_found boolean;
begin
  select team, true into v_team, v_found from public.players where game_id = p_game_id and user_id = p_user;
  if v_found is null then
    raise exception 'not_a_player' using errcode = 'P0001';
  end if;
  if v_team is distinct from p_team then
    raise exception '%', case p_team when 'hiders' then 'hiders_only' else 'seekers_only' end
      using errcode = 'P0001';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Client actions
-- ---------------------------------------------------------------------------

-- Any player: apply due timers (hiding period over, missed answer deadline). Phones call
-- this when a countdown they show reaches zero; the server decides from its own clock.
create function public.settle_timers(p_game_id uuid, p_client_action_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public._require_user();
  v_prev jsonb := public._previous_result(p_client_action_id, v_uid);
  v_game public.games;
  v_n integer;
begin
  if v_prev is not null then
    return v_prev;
  end if;

  v_game := public._lock_game(p_game_id);
  if not exists (select 1 from public.players where game_id = p_game_id and user_id = v_uid) then
    raise exception 'not_a_player' using errcode = 'P0001';
  end if;

  v_n := public._settle_timers(p_game_id);

  return public._record_result(p_client_action_id, v_uid, p_game_id, jsonb_build_object(
    'game_id', p_game_id,
    'seq', (select last_seq from public.games where id = p_game_id),
    'settled', v_n
  ));
end;
$$;

create function public.choose_bar(
  p_game_id uuid,
  p_venue_id text,
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
  v_venue public.map_features;
  v_seq bigint;
begin
  if v_prev is not null then
    return v_prev;
  end if;

  v_game := public._lock_game(p_game_id);
  perform public._require_team(p_game_id, v_uid, 'hiders');
  if v_game.status not in ('hiding', 'seeking') then
    raise exception 'round_not_running' using errcode = 'P0001';
  end if;
  perform public._require_fresh(p_game_id, v_uid, p_last_seen_seq);

  if exists (select 1 from public.hider_bars where game_id = p_game_id and round = v_game.round) then
    raise exception 'bar_already_chosen' using errcode = 'P0001';
  end if;

  select * into v_venue from public.map_features
   where city = v_game.city and layer = 'venues' and feature_id = p_venue_id
     and extensions.geometrytype(geom) = 'POINT';
  if not found then
    raise exception 'venue_not_found' using errcode = 'P0001';
  end if;
  if v_game.play_area_snapshot is null
     -- _play_area_geom can come back without an SRID (st_union on some PostGIS versions).
     or not extensions.st_intersects(v_venue.geom,
          extensions.st_setsrid(public._play_area_geom(v_game.play_area_snapshot), 4326)) then
    raise exception 'venue_outside_play_area' using errcode = 'P0001';
  end if;

  insert into public.hider_bars (game_id, round, venue_id, name, geom, chosen_by)
  values (p_game_id, v_game.round, v_venue.feature_id, v_venue.name, v_venue.geom, v_uid);

  -- Hiders only: seekers must never learn the bar.
  v_seq := public._append_event(p_game_id, 'bar_chosen', jsonb_build_object(
    'round', v_game.round,
    'venue_id', v_venue.feature_id,
    'name', v_venue.name,
    'point', public._lonlat_json(v_venue.geom)
  ), 'hiders');

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq));
end;
$$;

create function public.ask_question(
  p_game_id uuid,
  p_type text,
  p_option_id text,
  p_params jsonb,
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
  v_qt public.question_types;
  v_option jsonb;
  v_params jsonb;
  v_distance numeric;
  v_start extensions.geometry;
  v_end extensions.geometry;
  v_travelled double precision;
  v_deadline_s integer;
  v_q public.questions;
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
  if now() < v_game.round_started_at + make_interval(secs => v_game.hiding_period_s) then
    raise exception 'still_hiding' using errcode = 'P0001';
  end if;
  perform public._require_fresh(p_game_id, v_uid, p_last_seen_seq);
  perform public._settle_timers(p_game_id);

  if exists (select 1 from public.questions where game_id = p_game_id and answered_at is null) then
    raise exception 'question_pending' using errcode = 'P0001';
  end if;

  select * into v_qt from public.question_types where city = v_game.city and type = p_type;
  if not found then
    raise exception 'question_type_not_found' using errcode = 'P0001';
  end if;
  if p_type not in ('radar', 'thermometer') then
    raise exception 'question_type_not_supported' using errcode = 'P0001';
  end if;
  select o into v_option from jsonb_array_elements(v_qt.options) o where o ->> 'id' = p_option_id;
  if v_option is null then
    raise exception 'option_not_found' using errcode = 'P0001';
  end if;
  if p_params is null or jsonb_typeof(p_params) <> 'object' then
    raise exception 'invalid_params' using errcode = 'P0001';
  end if;

  -- Distance: the option's, or the seeker's own for a custom option.
  if jsonb_typeof(v_option -> 'distance_m') = 'number' then
    v_distance := (v_option ->> 'distance_m')::numeric;
  elsif jsonb_typeof(p_params -> 'distance_m') = 'number' then
    v_distance := round((p_params ->> 'distance_m')::numeric);
  end if;
  if v_distance is null or v_distance < 10 or v_distance > 100000 then
    raise exception 'invalid_distance' using errcode = 'P0001';
  end if;

  if p_type = 'radar' then
    v_params := jsonb_build_object(
      'center', public._lonlat_json(public._lonlat(p_params -> 'center')),
      'distance_m', v_distance);
  else
    v_start := public._lonlat(p_params -> 'start');
    v_end := public._lonlat(p_params -> 'end');
    v_travelled := extensions.st_distance(v_start::extensions.geography, v_end::extensions.geography);
    if v_travelled < v_distance then
      raise exception 'not_far_enough' using errcode = 'P0001',
        detail = format('travelled %s m of %s m', round(v_travelled::numeric), v_distance);
    end if;
    v_params := jsonb_build_object(
      'start', public._lonlat_json(v_start),
      'end', public._lonlat_json(v_end),
      'distance_m', v_distance,
      'travelled_m', round(v_travelled::numeric));
  end if;

  v_deadline_s := public._answer_deadline_s(v_game.config, p_type, v_qt.extra);

  insert into public.questions (game_id, round, type, option_id, params, asked_by, deadline_at)
  values (p_game_id, v_game.round, p_type, p_option_id, v_params, v_uid,
          now() + make_interval(secs => v_deadline_s))
  returning * into v_q;

  v_seq := public._append_event(p_game_id, 'question_asked', jsonb_build_object(
    'question_id', v_q.id,
    'round', v_q.round,
    'type', v_q.type,
    'option_id', v_q.option_id,
    'prompt', v_qt.prompt,
    'params', v_q.params,
    'asked_by', v_uid,
    'asked_at', v_q.asked_at,
    'deadline_at', v_q.deadline_at,
    'deadline_s', v_deadline_s,
    'reward', jsonb_build_object('draw', v_qt.reward_draw, 'pick', v_qt.reward_pick)
  ));

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq, 'question_id', v_q.id));
end;
$$;

create function public.answer_question(
  p_game_id uuid,
  p_question_id uuid,
  p_answer text,
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
  v_q public.questions;
  v_late boolean;
  v_seq bigint;
begin
  if v_prev is not null then
    return v_prev;
  end if;

  v_game := public._lock_game(p_game_id);
  perform public._require_team(p_game_id, v_uid, 'hiders');
  perform public._require_fresh(p_game_id, v_uid, p_last_seen_seq);
  -- A missed deadline is logged before the (late) answer, so the log reads in order.
  perform public._settle_timers(p_game_id);

  select * into v_q from public.questions where id = p_question_id and game_id = p_game_id for update;
  if not found or v_q.answered_at is not null then
    raise exception 'question_not_pending' using errcode = 'P0001';
  end if;
  if not (
    (v_q.type = 'radar' and p_answer in ('yes', 'no'))
    or (v_q.type = 'thermometer' and p_answer in ('hotter', 'colder'))
  ) then
    raise exception 'invalid_answer' using errcode = 'P0001';
  end if;

  v_late := now() > v_q.deadline_at;
  update public.questions
     set answer = p_answer, answered_by = v_uid, answered_at = now(), late = v_late
   where id = v_q.id;

  v_seq := public._append_event(p_game_id, 'question_answered', jsonb_build_object(
    'question_id', v_q.id,
    'type', v_q.type,
    'answer', p_answer,
    'answered_by', v_uid,
    'answered_at', now(),
    'late', v_late
  ));

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq, 'late', v_late));
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke execute on function
  public._lonlat(jsonb),
  public._lonlat_json(extensions.geometry),
  public._answer_deadline_s(jsonb, text, jsonb),
  public._settle_timers(uuid),
  public._require_team(uuid, uuid, public.team),
  public.settle_timers(uuid, uuid),
  public.choose_bar(uuid, text, uuid, bigint),
  public.ask_question(uuid, text, text, jsonb, uuid, bigint),
  public.answer_question(uuid, uuid, text, uuid, bigint)
from public, anon, authenticated;

grant execute on function
  public.settle_timers(uuid, uuid),
  public.choose_bar(uuid, text, uuid, bigint),
  public.ask_question(uuid, text, text, jsonb, uuid, bigint),
  public.answer_question(uuid, uuid, text, uuid, bigint)
to authenticated;
