-- Cards, stage 2: powerups, next-question modifiers, question bans, seeker vetoes with
-- escalating locks, dice and wheel, and photo proof for drinks.
--
-- * play_card (replaced; new optional last argument p_choice jsonb) adds:
--     powerup  params.action:
--       veto          the pending question closes with no answer and no reward (public)
--       randomize     the pending question is replaced by a random other option of the same
--                     type (not banned, not custom; thermometer only within the distance
--                     travelled), same seeker position, fresh deadline (public)
--       duplicate     p_choice.target: a card in the hand; a copy of it joins the hand
--                     (hider-only)
--       move          no question pending, bar chosen: the hider re-picks a bar with
--                     choose_bar; seekers can't ask until then (public, then public
--                     hider_moved with no location). Phones shade only from questions
--                     asked after the move
--       discard_draw  p_choice.discard: params.discard other cards from the hand; then
--                     params.draw cards go into a pending draw the hider keeps in full
--                     (keep_cards, so the hand limit holds) (hider-only)
--     next_question_modifier  the next answer's reward is multiplied by
--                     params.reward_multiplier (draw and pick; stacks) (public)
--     question_ban    p_choice.bans: [{type, option_id}], exactly params.count, from
--                     different types if params.distinct_types; ask_question refuses them
--                     with question_banned for the rest of the run (public)
--   Cost: cast_cost, or params.cost when the card has none (free | drink | shot).
-- * veto_curse (seekers): veto a played curse with can_veto. Its effect ends (status
--   vetoed; bans lifted). The seekers are locked at a bar for
--   veto.base_lock_s + veto.step_s * (vetoes already used this run); a lock starts when
--   the previous one ends. Public curse_vetoed event with the lock times.
-- * roll_dice / spin_wheel (any player): for a card played this run with params.utility
--   dice (params.dice dice) or wheel (params.wheel_options). Server random, public event.
--   A wheel card without wheel_options opens params.wheel_url on the phones instead.
-- * Photo proof for drinks (config photo_proof_for_drinks, default on): every drink the
--   app knows about opens a drink_proofs row and a public drink_due event for the team
--   that drinks: a cast cost (hiders), params.drinks (listed teams, e.g. Cheers), a veto
--   (seekers) and a missed answer deadline (hiders, shot). That team uploads a photo to the
--   private bucket drink-photos at <game_id>/<proof_id>/<file> and calls
--   submit_drink_proof; drink_proved carries the path and both teams can read it.

-- ---------------------------------------------------------------------------
-- Content: who drinks for the drink cards (only rows not edited in the app)
-- ---------------------------------------------------------------------------

update public.cards
   set params = params || '{"drinks":["hiders","seekers"]}'::jsonb, updated_at = now()
 where id in ('cheers', 'drinks_all_round') and not params ? 'drinks';

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------

alter table public.card_effects drop constraint card_effects_status_check;
alter table public.card_effects add constraint card_effects_status_check
  check (status in ('active', 'clear_requested', 'cleared', 'vetoed'));

alter table public.hider_bars add column move_pending boolean not null default false;

-- A question closed by a powerup instead of an answer.
-- A question closed by a powerup instead of an answer: answered_at set, answer null.
alter table public.questions add column closed_by text check (closed_by in ('veto', 'randomize'));
alter table public.questions drop constraint questions_check;
alter table public.questions add constraint questions_answer_check check (
  case when closed_by is null then (answer is null) = (answered_at is null)
       else answer is null and answered_at is not null end);

create table public.card_modifiers (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  round integer not null,
  instance_id uuid not null unique references public.card_instances (id) on delete cascade,
  reward_multiplier numeric not null check (reward_multiplier > 0),
  used_question_id uuid references public.questions (id) on delete set null,
  used_at timestamptz
);

create table public.question_bans (
  game_id uuid not null references public.games (id) on delete cascade,
  round integer not null,
  type text not null,
  option_id text not null,
  instance_id uuid not null references public.card_instances (id) on delete cascade,
  primary key (game_id, round, type, option_id)
);

create table public.curse_vetoes (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  round integer not null,
  instance_id uuid not null unique references public.card_instances (id) on delete cascade,
  vetoed_by uuid not null,
  vetoed_at timestamptz not null default now(),
  lock_s integer not null check (lock_s >= 0),
  lock_starts_at timestamptz not null,
  lock_ends_at timestamptz not null
);

create table public.drink_proofs (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  round integer not null,
  team public.team not null,
  cost text not null check (cost in ('drink', 'shot')),
  label text not null,
  created_at timestamptz not null default now(),
  photo_path text,
  proved_by uuid,
  proved_at timestamptz,
  check ((photo_path is null) = (proved_at is null))
);

create index drink_proofs_game_idx on public.drink_proofs (game_id, round);

alter table public.card_modifiers enable row level security;
alter table public.question_bans enable row level security;
alter table public.curse_vetoes enable row level security;
alter table public.drink_proofs enable row level security;
revoke all on public.card_modifiers, public.question_bans, public.curse_vetoes, public.drink_proofs
  from anon, authenticated;
-- RLS on with no policies = no client access.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Open a drink proof for a team and tell everyone (unless photo proof is off).
create function public._drink_due(p_game public.games, p_team public.team, p_cost text, p_label text)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_cost not in ('drink', 'shot') or p_game.config -> 'photo_proof_for_drinks' = 'false'::jsonb then
    return null;
  end if;
  insert into public.drink_proofs (game_id, round, team, cost, label)
  values (p_game.id, p_game.round, p_team, p_cost, p_label)
  returning id into v_id;
  perform public._append_event(p_game.id, 'drink_due', jsonb_build_object(
    'round', p_game.round, 'proof_id', v_id, 'team', p_team, 'cost', p_cost, 'label', p_label), 'all', null);
  return v_id;
end;
$$;

-- The seekers' side of a question of this type and option (from ask_question in
-- 20261130090000_cards.sql, unchanged), as stored in questions.params.
create function public._question_params(p_game public.games, p_type text, p_option jsonb, p_extra jsonb, p_params jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_params jsonb;
  v_distance numeric;
  v_start extensions.geometry;
  v_end extensions.geometry;
  v_center extensions.geometry;
  v_travelled double precision;
begin
  if p_params is null or jsonb_typeof(p_params) <> 'object' then
    raise exception 'invalid_params' using errcode = 'P0001';
  end if;

  if p_type in ('radar', 'thermometer') then
    if jsonb_typeof(p_option -> 'distance_m') = 'number' then
      v_distance := (p_option ->> 'distance_m')::numeric;
    elsif jsonb_typeof(p_params -> 'distance_m') = 'number' then
      v_distance := round((p_params ->> 'distance_m')::numeric);
    end if;
    if v_distance is null or v_distance < 10 or v_distance > 100000 then
      raise exception 'invalid_distance' using errcode = 'P0001';
    end if;
  end if;

  if p_type = 'radar' then
    v_params := jsonb_build_object(
      'center', public._lonlat_json(public._lonlat(p_params -> 'center')),
      'distance_m', v_distance);
  elsif p_type = 'thermometer' then
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
  else
    v_params := jsonb_build_object('label', coalesce(p_option ->> 'label', p_option ->> 'id'));
    if p_extra ? 'null_answer' then
      v_params := v_params || jsonb_build_object('null_answer', p_extra -> 'null_answer');
    end if;
    if p_type in ('matching', 'measuring', 'tentacles') then
      v_center := public._lonlat(p_params -> 'center');
      if not exists (select 1 from public.city_packs c
                      where c.city = p_game.city and extensions.st_dwithin(c.extent, v_center, 0.05)) then
        raise exception 'position_outside_map' using errcode = 'P0001';
      end if;
      v_params := v_params || jsonb_build_object('center', public._lonlat_json(v_center))
        || public._question_reference(p_game.city, p_type, p_option, v_center);
    elsif p_type = 'bonus' then
      v_params := v_params || jsonb_build_object('answer_kind', coalesce(p_option ->> 'answer', 'text'));
      if p_option ? 'count' then
        v_params := v_params || jsonb_build_object('count', p_option -> 'count');
      end if;
    end if;
  end if;
  return v_params;
end;
$$;

-- Insert a question and append question_asked (everyone). p_extra goes into the payload.
create function public._insert_question(
  p_game public.games, p_qt public.question_types, p_option_id text, p_params jsonb, p_asked_by uuid, p_extra jsonb
)
returns public.questions
language plpgsql
set search_path = ''
as $$
declare
  v_deadline_s integer := public._answer_deadline_s(p_game.config, p_qt.type, p_qt.extra);
  v_q public.questions;
begin
  insert into public.questions (game_id, round, type, option_id, params, asked_by, deadline_at)
  values (p_game.id, p_game.round, p_qt.type, p_option_id, p_params, p_asked_by,
          now() + make_interval(secs => v_deadline_s))
  returning * into v_q;

  perform public._append_event(p_game.id, 'question_asked', jsonb_build_object(
    'question_id', v_q.id,
    'round', v_q.round,
    'type', v_q.type,
    'option_id', v_q.option_id,
    'prompt', p_qt.prompt,
    'params', v_q.params,
    'asked_by', p_asked_by,
    'asked_at', v_q.asked_at,
    'deadline_at', v_q.deadline_at,
    'deadline_s', v_deadline_s,
    'reward', jsonb_build_object('draw', p_qt.reward_draw, 'pick', p_qt.reward_pick)
  ) || coalesce(p_extra, '{}'::jsonb));
  return v_q;
end;
$$;

-- The pending question of the current round, locked, or no_pending_question.
create function public._lock_pending_question(p_game public.games)
returns public.questions
language plpgsql
set search_path = ''
as $$
declare
  v_q public.questions;
begin
  select * into v_q from public.questions
   where game_id = p_game.id and round = p_game.round and answered_at is null for update;
  if not found then
    raise exception 'no_pending_question' using errcode = 'P0001';
  end if;
  return v_q;
end;
$$;

-- uuid[] from a jsonb array of strings, or invalid_choice.
create function public._uuid_list(p jsonb)
returns uuid[]
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p is null or jsonb_typeof(p) <> 'array' then
    raise exception 'invalid_choice' using errcode = 'P0001';
  end if;
  return array(select e::uuid from jsonb_array_elements_text(p) e);
exception when invalid_text_representation then
  raise exception 'invalid_choice' using errcode = 'P0001';
end;
$$;

-- ---------------------------------------------------------------------------
-- _settle_timers: as in 20261127090000_questions.sql, plus a drink proof per missed deadline
-- ---------------------------------------------------------------------------

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
    perform public._drink_due(v_game, 'hiders', 'shot', 'Missed answer deadline');
    v_n := v_n + 1;
  end loop;

  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- ask_question: as before (params built by _question_params), plus bans and moves
-- ---------------------------------------------------------------------------

create or replace function public.ask_question(
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
  v_q public.questions;
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
  if exists (select 1 from public.card_effects
              where game_id = p_game_id and round = v_game.round and blocks_questions
                and status in ('active', 'clear_requested')) then
    raise exception 'questions_blocked' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.hider_bars where game_id = p_game_id and round = v_game.round and move_pending) then
    raise exception 'hider_moving' using errcode = 'P0001';
  end if;

  select * into v_qt from public.question_types where city = v_game.city and type = p_type;
  if not found then
    raise exception 'question_type_not_found' using errcode = 'P0001';
  end if;
  if p_type not in ('radar', 'thermometer', 'matching', 'measuring', 'tentacles', 'photos', 'bonus') then
    raise exception 'question_type_not_supported' using errcode = 'P0001';
  end if;
  select o into v_option from jsonb_array_elements(v_qt.options) o where o ->> 'id' = p_option_id;
  if v_option is null then
    raise exception 'option_not_found' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.question_bans
              where game_id = p_game_id and round = v_game.round and type = p_type and option_id = p_option_id) then
    raise exception 'question_banned' using errcode = 'P0001';
  end if;

  v_q := public._insert_question(v_game, v_qt, p_option_id,
    public._question_params(v_game, p_type, v_option, v_qt.extra, p_params), v_uid, null);

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', (select last_seq from public.games where id = p_game_id),
                       'question_id', v_q.id));
end;
$$;

-- ---------------------------------------------------------------------------
-- answer_question: as before, plus reward multipliers
-- ---------------------------------------------------------------------------

create or replace function public.answer_question(
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
  v_answer text;
  v_late boolean;
  v_reward jsonb;
  v_mult numeric := 1;
  v_draw integer;
  v_pick integer;
  v_draw_id uuid;
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
  v_answer := public._check_answer(v_q, p_answer);

  v_late := now() > v_q.deadline_at;
  update public.questions
     set answer = v_answer, answered_by = v_uid, answered_at = now(), late = v_late
   where id = v_q.id;

  -- The reward everyone was shown when the question was asked, times any modifiers.
  select e.payload -> 'reward' into v_reward from public.events e
   where e.game_id = p_game_id and e.type = 'question_asked' and e.payload ->> 'question_id' = v_q.id::text
   order by e.seq desc limit 1;
  if v_q.round = v_game.round then
    select coalesce(exp(sum(ln(reward_multiplier))), 1) into v_mult from public.card_modifiers
     where game_id = p_game_id and round = v_game.round and used_at is null;
    update public.card_modifiers set used_question_id = v_q.id, used_at = now()
     where game_id = p_game_id and round = v_game.round and used_at is null;
  end if;
  if jsonb_typeof(v_reward -> 'draw') = 'number' then
    v_draw := round((v_reward ->> 'draw')::numeric * v_mult)::integer;
    v_pick := round(coalesce((v_reward ->> 'pick')::numeric, 1) * v_mult)::integer;
  end if;

  perform public._append_event(p_game_id, 'question_answered', jsonb_build_object(
    'question_id', v_q.id,
    'type', v_q.type,
    'answer', v_answer,
    'answered_by', v_uid,
    'answered_at', now(),
    'late', v_late
  ) || case when v_mult <> 1
            then jsonb_build_object('reward_multiplier', round(v_mult, 3),
                                    'reward', jsonb_build_object('draw', v_draw, 'pick', v_pick))
            else '{}'::jsonb end);

  if v_q.round = v_game.round and v_draw is not null then
    v_draw_id := public._draw_reward(v_game, v_q.id, v_draw, v_pick);
  end if;

  return public._record_result(p_client_action_id, v_uid, p_game_id, jsonb_build_object(
    'game_id', p_game_id,
    'seq', (select last_seq from public.games where id = p_game_id),
    'late', v_late,
    'draw_id', v_draw_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- choose_bar: as before, plus re-picking after a Move
-- ---------------------------------------------------------------------------

create or replace function public.choose_bar(
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
  v_bar public.hider_bars;
  v_venue public.map_features;
  v_radius numeric;
  v_late boolean;
  v_seq bigint;
  v_frozen boolean;
begin
  if v_prev is not null then
    return v_prev;
  end if;

  v_game := public._lock_game(p_game_id);

  if not exists (select 1 from public.players where game_id = p_game_id and user_id = v_uid and team = 'hiders') then
    raise exception 'hiders_only' using errcode = 'P0001';
  end if;
  if v_game.status not in ('hiding', 'seeking') then
    raise exception 'round_not_running' using errcode = 'P0001';
  end if;
  select * into v_bar from public.hider_bars where game_id = p_game_id and round = v_game.round for update;
  if found and not v_bar.move_pending then
    raise exception 'bar_already_chosen' using errcode = 'P0001';
  end if;
  perform public._require_fresh(p_game_id, v_uid, p_last_seen_seq);

  select * into v_venue from public.map_features
   where city = v_game.city and layer = 'venues' and feature_id = p_venue_id;
  if not found then
    raise exception 'venue_not_found' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public._valid_bars(v_game) b where b.feature_id = p_venue_id) then
    raise exception 'venue_not_allowed' using errcode = 'P0001';
  end if;
  if v_bar.move_pending and v_bar.venue_id = p_venue_id then
    raise exception 'same_bar' using errcode = 'P0001';
  end if;

  v_radius := public._cfg_num(v_game.config, '{hiding_zone,bar_radius_m}', 100);
  v_late := now() > v_game.round_started_at + make_interval(secs => v_game.hiding_period_s);

  if v_bar.move_pending then
    update public.hider_bars
       set venue_id = v_venue.feature_id, venue_name = v_venue.name, geom = v_venue.geom,
           chosen_by = v_uid, chosen_at = now(), move_pending = false
     where game_id = p_game_id and round = v_game.round;
  else
    insert into public.hider_bars (game_id, round, venue_id, venue_name, geom, chosen_by)
    values (p_game_id, v_game.round, v_venue.feature_id, v_venue.name, v_venue.geom, v_uid);
  end if;

  v_seq := public._append_event(p_game_id, 'bar_chosen', jsonb_build_object(
    'round', v_game.round,
    'venue_id', v_venue.feature_id,
    'name', v_venue.name,
    'lng', round(extensions.st_x(v_venue.geom)::numeric, 6),
    'lat', round(extensions.st_y(v_venue.geom)::numeric, 6),
    'radius_m', v_radius,
    'late', v_late,
    'moved', coalesce(v_bar.move_pending, false)
  ), 'hiders');

  if v_bar.move_pending then
    -- Seekers learn only that the move is done, never where.
    v_seq := public._append_event(p_game_id, 'hider_moved', jsonb_build_object('round', v_game.round, 'at', now()));
  end if;

  perform public._update_freeze(v_game);
  select frozen into v_frozen from public.hider_bars where game_id = p_game_id and round = v_game.round;

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq, 'frozen', v_frozen));
end;
$$;

-- ---------------------------------------------------------------------------
-- play_card: every behaviour (see top of file)
-- ---------------------------------------------------------------------------

drop function public.play_card(uuid, uuid, uuid, bigint);

create function public.play_card(
  p_game_id uuid,
  p_instance_id uuid,
  p_client_action_id uuid,
  p_last_seen_seq bigint,
  p_choice jsonb default null
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
  v_inst public.card_instances;
  v_card public.game_cards;
  v_effect public.card_effects;
  v_duration integer;
  v_followup integer;
  v_payload jsonb;
  v_visibility public.event_visibility := 'all';
  v_action text;
  v_q public.questions;
  v_qt public.question_types;
  v_option jsonb;
  v_new public.questions;
  v_ids uuid[];
  v_target public.card_instances;
  v_copy uuid;
  v_n integer;
  v_draw integer;
  v_mult numeric;
  v_bans jsonb;
  v_ban jsonb;
  v_cost text;
  v_team text;
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
  perform public._settle_timers(p_game_id);

  select * into v_inst from public.card_instances
   where id = p_instance_id and game_id = p_game_id and round = v_game.round for update;
  if not found or v_inst.location <> 'hand' then
    raise exception 'card_not_in_hand' using errcode = 'P0001';
  end if;
  select * into v_card from public.game_cards
   where game_id = p_game_id and round = v_game.round and card_id = v_inst.card_id;

  v_payload := jsonb_build_object(
    'round', v_game.round,
    'instance_id', v_inst.id,
    'card', public._card_json(v_card) - 'copies',
    'played_at', now());

  case v_card.behaviour
    when 'text' then
      null;
    when 'timed' then
      v_duration := public._cfg_num(v_card.params, '{duration_s}', 0)::integer;
      if v_duration < 1 then
        raise exception 'card_not_configured' using errcode = 'P0001', detail = 'params.duration_s';
      end if;
      v_followup := nullif(public._cfg_num(v_card.params, '{followup_s}', 0)::integer, 0);
      insert into public.card_effects (game_id, round, instance_id, card_id, behaviour, ends_at, followup_s)
      values (p_game_id, v_game.round, v_inst.id, v_card.card_id, 'timed',
              now() + make_interval(secs => v_duration), v_followup)
      returning * into v_effect;
      v_payload := v_payload || jsonb_build_object(
        'effect_id', v_effect.id, 'duration_s', v_duration, 'ends_at', v_effect.ends_at, 'followup_s', v_followup);
    when 'until_cleared' then
      insert into public.card_effects (game_id, round, instance_id, card_id, behaviour, blocks_questions)
      values (p_game_id, v_game.round, v_inst.id, v_card.card_id, 'until_cleared',
              coalesce(v_card.params -> 'blocks_questions' = 'true'::jsonb, false))
      returning * into v_effect;
      v_payload := v_payload || jsonb_build_object(
        'effect_id', v_effect.id, 'blocks_questions', v_effect.blocks_questions);
    when 'time_bonus' then
      -- Time bonuses only count while held in the hand at the end of the round.
      raise exception 'card_not_playable' using errcode = 'P0001';
    when 'next_question_modifier' then
      v_mult := public._cfg_num(v_card.params, '{reward_multiplier}', 0);
      if v_mult <= 0 then
        raise exception 'card_not_configured' using errcode = 'P0001', detail = 'params.reward_multiplier';
      end if;
      insert into public.card_modifiers (game_id, round, instance_id, reward_multiplier)
      values (p_game_id, v_game.round, v_inst.id, v_mult);
      v_payload := v_payload || jsonb_build_object('reward_multiplier', v_mult);
    when 'question_ban' then
      v_n := floor(public._cfg_num(v_card.params, '{count}', 1))::integer;
      v_bans := p_choice -> 'bans';
      if v_bans is null or jsonb_typeof(v_bans) <> 'array' or jsonb_array_length(v_bans) <> v_n
         or (select count(distinct (b ->> 'type', b ->> 'option_id')) from jsonb_array_elements(v_bans) b) <> v_n then
        raise exception 'invalid_choice' using errcode = 'P0001', detail = format('pick %s questions', v_n);
      end if;
      if v_card.params -> 'distinct_types' = 'true'::jsonb
         and (select count(distinct b ->> 'type') from jsonb_array_elements(v_bans) b) <> v_n then
        raise exception 'invalid_choice' using errcode = 'P0001', detail = 'pick questions of different types';
      end if;
      v_payload := v_payload || jsonb_build_object('bans', '[]'::jsonb);
      for v_ban in select * from jsonb_array_elements(v_bans) loop
        select * into v_qt from public.question_types where city = v_game.city and type = v_ban ->> 'type';
        select o into v_option from jsonb_array_elements(v_qt.options) o where o ->> 'id' = v_ban ->> 'option_id';
        if v_qt.type is null or v_option is null then
          raise exception 'invalid_choice' using errcode = 'P0001', detail = 'unknown question';
        end if;
        insert into public.question_bans (game_id, round, type, option_id, instance_id)
        values (p_game_id, v_game.round, v_qt.type, v_option ->> 'id', v_inst.id)
        on conflict do nothing;
        v_payload := jsonb_set(v_payload, '{bans}', (v_payload -> 'bans') || jsonb_build_object(
          'type', v_qt.type, 'option_id', v_option ->> 'id',
          'label', coalesce(v_option ->> 'label', v_option ->> 'id')));
        v_qt := null;
        v_option := null;
      end loop;
      v_payload := v_payload || jsonb_build_object('until', coalesce(v_card.params ->> 'until', 'end_of_run'));
    when 'powerup' then
      v_action := v_card.params ->> 'action';
      case v_action
        when 'veto' then
          v_q := public._lock_pending_question(v_game);
          update public.questions set answered_at = now(), answered_by = v_uid, closed_by = 'veto', late = false
           where id = v_q.id;
          v_payload := v_payload || jsonb_build_object('question_id', v_q.id);
        when 'randomize' then
          v_q := public._lock_pending_question(v_game);
          select * into v_qt from public.question_types where city = v_game.city and type = v_q.type;
          select o into v_option from jsonb_array_elements(v_qt.options) o
           where o ->> 'id' <> v_q.option_id
             and not exists (select 1 from public.question_bans b
                              where b.game_id = p_game_id and b.round = v_game.round
                                and b.type = v_q.type and b.option_id = o ->> 'id')
             and (v_q.type not in ('radar', 'thermometer') or jsonb_typeof(o -> 'distance_m') = 'number')
             and (v_q.type <> 'thermometer'
                  or (o ->> 'distance_m')::numeric <= coalesce((v_q.params ->> 'travelled_m')::numeric, 0))
           order by random() limit 1;
          if v_option is null then
            raise exception 'nothing_to_randomize' using errcode = 'P0001';
          end if;
          update public.questions set answered_at = now(), answered_by = v_uid, closed_by = 'randomize', late = false
           where id = v_q.id;
          v_payload := v_payload || jsonb_build_object('question_id', v_q.id);
        when 'duplicate' then
          begin
            v_copy := (p_choice ->> 'target')::uuid;
          exception when invalid_text_representation then
            raise exception 'invalid_choice' using errcode = 'P0001';
          end;
          select * into v_target from public.card_instances
           where id = v_copy and game_id = p_game_id and round = v_game.round and location = 'hand' and id <> v_inst.id;
          if not found then
            raise exception 'invalid_choice' using errcode = 'P0001', detail = 'pick another card in your hand';
          end if;
          insert into public.card_instances (game_id, round, card_id, pile_pos, location)
          values (p_game_id, v_game.round, v_target.card_id,
                  (select max(pile_pos) + 1 from public.card_instances where game_id = p_game_id and round = v_game.round),
                  'hand')
          returning id into v_copy;
          v_visibility := 'hiders';
          v_payload := v_payload || jsonb_build_object(
            'duplicate', jsonb_build_object('of', v_target.id, 'instance_id', v_copy, 'card_id', v_target.card_id));
        when 'move' then
          if not exists (select 1 from public.hider_bars where game_id = p_game_id and round = v_game.round) then
            raise exception 'no_bar_yet' using errcode = 'P0001';
          end if;
          if exists (select 1 from public.hider_bars where game_id = p_game_id and round = v_game.round and move_pending) then
            raise exception 'already_moving' using errcode = 'P0001';
          end if;
          if exists (select 1 from public.questions where game_id = p_game_id and answered_at is null) then
            raise exception 'question_pending' using errcode = 'P0001';
          end if;
          update public.hider_bars set move_pending = true where game_id = p_game_id and round = v_game.round;
        when 'discard_draw' then
          v_n := floor(public._cfg_num(v_card.params, '{discard}', 0))::integer;
          v_draw := floor(public._cfg_num(v_card.params, '{draw}', 0))::integer;
          if v_draw < 1 then
            raise exception 'card_not_configured' using errcode = 'P0001', detail = 'params.draw';
          end if;
          v_ids := public._uuid_list(coalesce(p_choice -> 'discard', '[]'::jsonb));
          if cardinality(v_ids) <> v_n or (select count(distinct d) from unnest(v_ids) d) <> v_n
             or (select count(*) from public.card_instances
                  where game_id = p_game_id and round = v_game.round and location = 'hand'
                    and id = any (v_ids) and id <> v_inst.id) <> v_n then
            raise exception 'invalid_choice' using errcode = 'P0001', detail = format('discard %s other cards', v_n);
          end if;
          update public.card_instances set location = 'discarded' where id = any (v_ids);
          v_visibility := 'hiders';
          v_payload := v_payload || jsonb_build_object('discarded', to_jsonb(v_ids));
        else
          raise exception 'card_behaviour_not_supported' using errcode = 'P0001';
      end case;
    else
      raise exception 'card_behaviour_not_supported' using errcode = 'P0001';
  end case;

  update public.card_instances set location = 'played' where id = v_inst.id;

  perform public._append_event(p_game_id, 'card_played', v_payload, v_visibility);

  -- After card_played, so phones read the log in order.
  if v_action = 'randomize' then
    v_new := public._insert_question(v_game, v_qt, v_option ->> 'id',
      public._question_params(v_game, v_q.type, v_option, v_qt.extra,
        v_q.params || jsonb_build_object('distance_m', v_option -> 'distance_m')),
      v_q.asked_by, jsonb_build_object('randomized_from', v_q.id));
  elsif v_action = 'discard_draw' then
    perform public._draw_reward(v_game, null, v_draw, v_draw);
  end if;

  v_cost := coalesce(v_card.cast_cost, v_card.params ->> 'cost');
  if v_cost in ('drink', 'shot') then
    perform public._drink_due(v_game, 'hiders', v_cost, v_card.name);
  end if;
  if jsonb_typeof(v_card.params -> 'drinks') = 'array' then
    for v_team in select jsonb_array_elements_text(v_card.params -> 'drinks') loop
      if v_team in ('hiders', 'seekers') then
        perform public._drink_due(v_game, v_team::public.team, 'drink', v_card.name);
      end if;
    end loop;
  end if;

  return public._record_result(p_client_action_id, v_uid, p_game_id, jsonb_build_object(
    'game_id', p_game_id,
    'seq', (select last_seq from public.games where id = p_game_id),
    'effect_id', v_effect.id,
    'question_id', v_new.id));
end;
$$;

-- ---------------------------------------------------------------------------
-- Seekers veto a curse
-- ---------------------------------------------------------------------------

create function public.veto_curse(
  p_game_id uuid,
  p_instance_id uuid,
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
  v_inst public.card_instances;
  v_card public.game_cards;
  v_e public.card_effects;
  v_used integer;
  v_lock_s integer;
  v_starts timestamptz;
  v_veto public.curse_vetoes;
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

  select * into v_inst from public.card_instances
   where id = p_instance_id and game_id = p_game_id and round = v_game.round and location = 'played' for update;
  if not found then
    raise exception 'card_not_found' using errcode = 'P0001';
  end if;
  select * into v_card from public.game_cards
   where game_id = p_game_id and round = v_game.round and card_id = v_inst.card_id;
  if v_card.can_veto is not true then
    raise exception 'cannot_veto' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.curse_vetoes where instance_id = v_inst.id) then
    raise exception 'already_vetoed' using errcode = 'P0001';
  end if;

  select * into v_e from public.card_effects where instance_id = v_inst.id for update;
  if found and (v_e.status in ('cleared', 'vetoed')
                or (v_e.behaviour = 'timed' and now() >= coalesce(v_e.followup_ends_at, v_e.ends_at))) then
    raise exception 'curse_over' using errcode = 'P0001';
  end if;

  select count(*) into v_used from public.curse_vetoes where game_id = p_game_id and round = v_game.round;
  v_lock_s := (public._cfg_num(v_game.config, '{veto,base_lock_s}', 600)
               + public._cfg_num(v_game.config, '{veto,step_s}', 600) * v_used)::integer;
  select greatest(now(), coalesce(max(lock_ends_at), now())) into v_starts
    from public.curse_vetoes where game_id = p_game_id and round = v_game.round;

  insert into public.curse_vetoes (game_id, round, instance_id, vetoed_by, lock_s, lock_starts_at, lock_ends_at)
  values (p_game_id, v_game.round, v_inst.id, v_uid, v_lock_s, v_starts, v_starts + make_interval(secs => v_lock_s))
  returning * into v_veto;

  if v_e.id is not null then
    update public.card_effects set status = 'vetoed', cleared_at = now() where id = v_e.id;
  end if;
  delete from public.question_bans where instance_id = v_inst.id;

  v_seq := public._append_event(p_game_id, 'curse_vetoed', jsonb_build_object(
    'round', v_game.round,
    'instance_id', v_inst.id,
    'effect_id', v_e.id,
    'card_id', v_card.card_id,
    'name', v_card.name,
    'veto_number', v_used + 1,
    'lock_s', v_lock_s,
    'lock_starts_at', v_veto.lock_starts_at,
    'lock_ends_at', v_veto.lock_ends_at,
    'penalty', coalesce(v_game.config #>> '{veto,penalty}', 'each seeker drinks')
  ));
  perform public._drink_due(v_game, 'seekers', 'drink', 'Veto: ' || v_card.name);

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', (select last_seq from public.games where id = p_game_id),
                       'lock_ends_at', v_veto.lock_ends_at));
end;
$$;

-- ---------------------------------------------------------------------------
-- Dice and wheel
-- ---------------------------------------------------------------------------

-- A card played this run, for its utility; any player of the game.
create function public._utility_card(p_game public.games, p_uid uuid, p_instance_id uuid, p_utility text)
returns public.game_cards
language plpgsql
set search_path = ''
as $$
declare
  v_card public.game_cards;
begin
  if not exists (select 1 from public.players where game_id = p_game.id and user_id = p_uid and team is not null) then
    raise exception 'not_a_player' using errcode = 'P0001';
  end if;
  if p_game.status not in ('hiding', 'seeking') then
    raise exception 'round_not_running' using errcode = 'P0001';
  end if;
  select g.* into v_card from public.card_instances i
    join public.game_cards g on g.game_id = i.game_id and g.round = i.round and g.card_id = i.card_id
   where i.id = p_instance_id and i.game_id = p_game.id and i.round = p_game.round and i.location = 'played';
  if not found then
    raise exception 'card_not_found' using errcode = 'P0001';
  end if;
  if v_card.params ->> 'utility' is distinct from p_utility then
    raise exception 'no_utility' using errcode = 'P0001';
  end if;
  return v_card;
end;
$$;

create function public.roll_dice(
  p_game_id uuid,
  p_instance_id uuid,
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
  v_card public.game_cards;
  v_n integer;
  v_dice jsonb;
  v_seq bigint;
begin
  if v_prev is not null then
    return v_prev;
  end if;

  v_game := public._lock_game(p_game_id);
  v_card := public._utility_card(v_game, v_uid, p_instance_id, 'dice');
  perform public._require_fresh(p_game_id, v_uid, p_last_seen_seq);

  v_n := least(10, greatest(1, floor(public._cfg_num(v_card.params, '{dice}', 1))::integer));
  select jsonb_agg(1 + floor(random() * 6)::integer) into v_dice from generate_series(1, v_n);

  v_seq := public._append_event(p_game_id, 'dice_rolled', jsonb_build_object(
    'round', v_game.round,
    'instance_id', p_instance_id,
    'card_id', v_card.card_id,
    'name', v_card.name,
    'dice', v_dice,
    'total', (select sum(d::integer) from jsonb_array_elements_text(v_dice) d),
    'by', v_uid));

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq, 'dice', v_dice));
end;
$$;

create function public.spin_wheel(
  p_game_id uuid,
  p_instance_id uuid,
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
  v_card public.game_cards;
  v_options jsonb;
  v_i integer;
  v_seq bigint;
begin
  if v_prev is not null then
    return v_prev;
  end if;

  v_game := public._lock_game(p_game_id);
  v_card := public._utility_card(v_game, v_uid, p_instance_id, 'wheel');
  perform public._require_fresh(p_game_id, v_uid, p_last_seen_seq);

  v_options := v_card.params -> 'wheel_options';
  if v_options is null or jsonb_typeof(v_options) <> 'array' or jsonb_array_length(v_options) = 0 then
    raise exception 'wheel_not_configured' using errcode = 'P0001';
  end if;
  v_i := floor(random() * jsonb_array_length(v_options))::integer;

  v_seq := public._append_event(p_game_id, 'wheel_spun', jsonb_build_object(
    'round', v_game.round,
    'instance_id', p_instance_id,
    'card_id', v_card.card_id,
    'name', v_card.name,
    'index', v_i,
    'result', v_options ->> v_i,
    'count', jsonb_array_length(v_options),
    'by', v_uid));

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq, 'result', v_options ->> v_i));
end;
$$;

-- ---------------------------------------------------------------------------
-- Drink photos
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('drink-photos', 'drink-photos', false, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

-- Upload: a player of the team that owes the drink, while its proof is open.
create function public.can_upload_drink_photo(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public._photo_path_ids(p_name) ids
    join public.drink_proofs d on d.id = ids.question_id and d.game_id = ids.game_id
    join public.players p on p.game_id = d.game_id and p.user_id = (select auth.uid())
    where d.proved_at is null and p.team = d.team
  );
$$;

create function public.can_read_drink_photo(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public._photo_path_ids(p_name) ids where public.is_player(ids.game_id));
$$;

create policy "teams upload photos for their open drink proofs" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'drink-photos' and public.can_upload_drink_photo(name));

create policy "players read their game's drink photos" on storage.objects
  for select to authenticated
  using (bucket_id = 'drink-photos' and public.can_read_drink_photo(name));

create function public.submit_drink_proof(
  p_game_id uuid,
  p_proof_id uuid,
  p_path text,
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
  v_d public.drink_proofs;
  v_path text := btrim(coalesce(p_path, ''));
  v_seq bigint;
begin
  if v_prev is not null then
    return v_prev;
  end if;

  v_game := public._lock_game(p_game_id);
  select * into v_d from public.drink_proofs where id = p_proof_id and game_id = p_game_id for update;
  if not found or v_d.proved_at is not null then
    raise exception 'proof_not_pending' using errcode = 'P0001';
  end if;
  perform public._require_team(p_game_id, v_uid, v_d.team);
  perform public._require_fresh(p_game_id, v_uid, p_last_seen_seq);

  if not starts_with(v_path, p_game_id::text || '/' || v_d.id::text || '/')
     or not exists (select 1 from storage.objects o where o.bucket_id = 'drink-photos' and o.name = v_path) then
    raise exception 'photo_not_uploaded' using errcode = 'P0001';
  end if;

  update public.drink_proofs set photo_path = v_path, proved_by = v_uid, proved_at = now() where id = v_d.id;

  v_seq := public._append_event(p_game_id, 'drink_proved', jsonb_build_object(
    'round', v_d.round, 'proof_id', v_d.id, 'team', v_d.team, 'path', v_path, 'by', v_uid));

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq));
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke execute on function
  public._drink_due(public.games, public.team, text, text),
  public._question_params(public.games, text, jsonb, jsonb, jsonb),
  public._insert_question(public.games, public.question_types, text, jsonb, uuid, jsonb),
  public._lock_pending_question(public.games),
  public._uuid_list(jsonb),
  public._settle_timers(uuid),
  public._utility_card(public.games, uuid, uuid, text),
  public.ask_question(uuid, text, text, jsonb, uuid, bigint),
  public.answer_question(uuid, uuid, text, uuid, bigint),
  public.choose_bar(uuid, text, uuid, bigint),
  public.play_card(uuid, uuid, uuid, bigint, jsonb),
  public.veto_curse(uuid, uuid, uuid, bigint),
  public.roll_dice(uuid, uuid, uuid, bigint),
  public.spin_wheel(uuid, uuid, uuid, bigint),
  public.can_upload_drink_photo(text),
  public.can_read_drink_photo(text),
  public.submit_drink_proof(uuid, uuid, text, uuid, bigint)
from public, anon, authenticated;

grant execute on function
  public.ask_question(uuid, text, text, jsonb, uuid, bigint),
  public.answer_question(uuid, uuid, text, uuid, bigint),
  public.choose_bar(uuid, text, uuid, bigint),
  public.play_card(uuid, uuid, uuid, bigint, jsonb),
  public.veto_curse(uuid, uuid, uuid, bigint),
  public.roll_dice(uuid, uuid, uuid, bigint),
  public.spin_wheel(uuid, uuid, uuid, bigint),
  public.submit_drink_proof(uuid, uuid, text, uuid, bigint)
to authenticated;

-- Storage policies call these as the uploading/reading user.
grant execute on function
  public.can_upload_drink_photo(text),
  public.can_read_drink_photo(text)
to authenticated;
