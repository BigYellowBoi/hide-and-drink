-- Cards: deck snapshot and shuffled draw pile at start, draw/keep rewards on answers, the
-- hider-only hand, and playing cards with the text, timed, until_cleared and time_bonus
-- behaviours. The other behaviours (next_question_modifier, question_ban, powerup) and
-- vetoes come later; play_card refuses them with card_behaviour_not_supported.
--
-- * start_game (replaced, same signature): snapshots the deck into game_cards (card and
--   category content frozen for the round) and deals one card_instances row per copy in a server-side random
--   order (pile_pos). Copies are cards.default_copies of active cards, or config.deck
--   ({card_id: copies}) when the host set one. The deck list is public: game_started carries
--   it. The pile order never leaves the server.
-- * answer_question (replaced, same signature): after the answer, draws the question's
--   reward (the draw/pick shown in question_asked) off the top of the pile into a pending
--   draw. Hider-only cards_drawn event. Late answers still draw. A short pile draws what is
--   left; an empty pile draws nothing.
-- * keep_cards (hiders): keep exactly pick cards of a pending draw; the rest are discarded.
--   The hand may not go over config.hand_limit (default 6): discard cards from the hand in
--   the same call to make room. Hider-only cards_kept event.
-- * play_card (hiders): a card from the hand, while the round runs. Public card_played event
--   with the card, so every phone shows it. Effects:
--     text           shown to everyone, nothing else
--     timed          countdown: ends_at = now + params.duration_s. If params.followup_s is
--                    set, start_followup (any player, once, after the countdown ends) starts
--                    the follow-on timer when the condition was missed
--     until_cleared  active until seekers tap Done (clear_effect) and the hider confirms
--                    (confirm_clear). params.blocks_questions: ask_question is refused with
--                    questions_blocked meanwhile
--     time_bonus     banks params.minutes for the hider's score (time_bonus_s in the event)
-- * ask_question (replaced, same signature): adds the questions_blocked check.
--
-- Everything is keyed by (game_id, round): each run deals a fresh deck. Tables have no
-- client access; phones derive state from events.

-- ---------------------------------------------------------------------------
-- Content: category colours from docs/design.md (only rows still on the seed colour)
-- ---------------------------------------------------------------------------

update public.categories c
   set colour = v.colour
  from (values ('curse', '#C9423A', '#EC353A'), ('powerup', '#4F7BE8', '#9B8CF5'),
               ('time_bonus', '#3FA34D', '#4FC88A'), ('drink', '#E8A33F', '#F2B705')) v(id, seed, colour)
 where c.id = v.id and upper(c.colour) = v.seed;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.game_cards (
  game_id uuid not null references public.games (id) on delete cascade,
  round integer not null,
  card_id text not null,
  name text not null,
  category_id text not null,
  category_name text not null,
  category_colour text not null,
  behaviour text not null,
  body text,
  params jsonb not null,
  cast_cost text,
  can_veto boolean,
  copies integer not null check (copies >= 1),
  sort integer not null,
  primary key (game_id, round, card_id)
);

create table public.card_draws (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  round integer not null,
  question_id uuid references public.questions (id) on delete set null,
  drawn integer not null check (drawn >= 1),
  pick integer not null check (pick >= 1 and pick <= drawn),
  created_at timestamptz not null default now(),
  kept_at timestamptz
);

create table public.card_instances (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  round integer not null,
  card_id text not null,
  pile_pos integer not null,
  location text not null default 'pile' check (location in ('pile', 'drawn', 'hand', 'played', 'discarded')),
  draw_id uuid references public.card_draws (id) on delete set null,
  unique (game_id, round, pile_pos),
  foreign key (game_id, round, card_id) references public.game_cards (game_id, round, card_id) on delete cascade
);

create index card_instances_location_idx on public.card_instances (game_id, round, location, pile_pos);

create table public.card_effects (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  round integer not null,
  instance_id uuid not null unique references public.card_instances (id) on delete cascade,
  card_id text not null,
  behaviour text not null check (behaviour in ('timed', 'until_cleared')),
  blocks_questions boolean not null default false,
  played_at timestamptz not null default now(),
  ends_at timestamptz,
  followup_s integer,
  followup_ends_at timestamptz,
  status text not null default 'active' check (status in ('active', 'clear_requested', 'cleared')),
  clear_requested_by uuid,
  cleared_at timestamptz,
  check ((behaviour = 'timed') = (ends_at is not null))
);

create index card_effects_game_idx on public.card_effects (game_id, round, status);

alter table public.game_cards enable row level security;
alter table public.card_draws enable row level security;
alter table public.card_instances enable row level security;
alter table public.card_effects enable row level security;
revoke all on public.game_cards, public.card_draws, public.card_instances, public.card_effects
  from anon, authenticated;
-- RLS on with no policies = no client access.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Copies per active card for this game: config.deck when set, else the library defaults.
create function public._deck_copies(p_config jsonb)
returns table (card_id text, copies integer)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_deck jsonb := p_config -> 'deck';
  v_key text;
  v_val jsonb;
begin
  if v_deck is null or jsonb_typeof(v_deck) = 'null' then
    return query select c.id, c.default_copies from public.cards c where c.active and c.default_copies > 0;
    return;
  end if;
  if jsonb_typeof(v_deck) <> 'object' then
    raise exception 'invalid_deck' using errcode = 'P0001';
  end if;
  for v_key, v_val in select * from jsonb_each(v_deck) loop
    if jsonb_typeof(v_val) <> 'number' or (v_val #>> '{}')::numeric not between 0 and 99
       or (v_val #>> '{}')::numeric <> trunc((v_val #>> '{}')::numeric)
       or not exists (select 1 from public.cards c where c.id = v_key and c.active) then
      raise exception 'invalid_deck' using errcode = 'P0001', detail = v_key;
    end if;
  end loop;
  return query
    select e.key, (e.value #>> '{}')::integer from jsonb_each(v_deck) e where (e.value #>> '{}')::integer > 0;
end;
$$;

-- One snapshot card as the clients see it.
create function public._card_json(p public.game_cards)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'card_id', p.card_id, 'name', p.name, 'category', p.category_id, 'category_name', p.category_name,
    'colour', p.category_colour, 'behaviour', p.behaviour,
    'text', p.body, 'params', p.params, 'cast_cost', p.cast_cost, 'can_veto', p.can_veto,
    'copies', p.copies);
$$;

-- Snapshot the deck for a round and deal the shuffled pile. Returns the public deck list.
create function public._deal_deck(p_game public.games, p_round integer)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_deck jsonb;
begin
  insert into public.game_cards (game_id, round, card_id, name, category_id, category_name, category_colour,
                                 behaviour, body, params, cast_cost, can_veto, copies, sort)
  select p_game.id, p_round, c.id, c.name, c.category_id, cat.name, cat.colour, c.behaviour, c.body, c.params,
         c.cast_cost, c.can_veto, d.copies, (row_number() over (order by cat.sort, c.sort, c.id))::integer
    from public._deck_copies(p_game.config) d
    join public.cards c on c.id = d.card_id
    join public.categories cat on cat.id = c.category_id;

  if not found then
    raise exception 'deck_empty' using errcode = 'P0001';
  end if;

  insert into public.card_instances (game_id, round, card_id, pile_pos)
  select p_game.id, p_round, g.card_id, (row_number() over (order by random()))::integer
    from public.game_cards g, generate_series(1, g.copies)
   where g.game_id = p_game.id and g.round = p_round;

  select jsonb_agg(public._card_json(g) order by g.sort) into v_deck
    from public.game_cards g where g.game_id = p_game.id and g.round = p_round;
  return v_deck;
end;
$$;

-- Draw a question's reward off the top of the pile into a pending draw. Appends the
-- hider-only cards_drawn event. Returns the draw id, or null if nothing was drawn.
create function public._draw_reward(p_game public.games, p_question_id uuid, p_draw integer, p_pick integer)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_draw public.card_draws;
  v_n integer;
  v_cards jsonb;
begin
  if coalesce(p_draw, 0) < 1 then
    return null;
  end if;
  select least(p_draw, count(*))::integer into v_n from public.card_instances
   where game_id = p_game.id and round = p_game.round and location = 'pile';
  if v_n < 1 then
    return null;
  end if;

  insert into public.card_draws (game_id, round, question_id, drawn, pick)
  values (p_game.id, p_game.round, p_question_id, v_n, greatest(1, least(coalesce(p_pick, 1), v_n)))
  returning * into v_draw;

  update public.card_instances i
     set location = 'drawn', draw_id = v_draw.id
   where i.id in (select id from public.card_instances
                   where game_id = p_game.id and round = p_game.round and location = 'pile'
                   order by pile_pos limit v_n);

  select jsonb_agg(jsonb_build_object('instance_id', i.id, 'card_id', i.card_id) order by i.pile_pos)
    into v_cards from public.card_instances i where i.draw_id = v_draw.id;

  perform public._append_event(p_game.id, 'cards_drawn', jsonb_build_object(
    'round', p_game.round,
    'draw_id', v_draw.id,
    'question_id', p_question_id,
    'pick', v_draw.pick,
    'cards', v_cards,
    'pile_left', (select count(*) from public.card_instances
                   where game_id = p_game.id and round = p_game.round and location = 'pile')
  ), 'hiders');
  return v_draw.id;
end;
$$;

-- Hand limit from the config (default 6).
create function public._hand_limit(p_config jsonb)
returns integer
language sql
immutable
set search_path = ''
as $$
  select floor(public._cfg_num(p_config, '{hand_limit}', 6))::integer;
$$;

-- An effect of this game, locked, or effect_not_found.
create function public._lock_effect(p_game public.games, p_effect_id uuid)
returns public.card_effects
language plpgsql
set search_path = ''
as $$
declare
  v_e public.card_effects;
begin
  select * into v_e from public.card_effects
   where id = p_effect_id and game_id = p_game.id and round = p_game.round for update;
  if not found then
    raise exception 'effect_not_found' using errcode = 'P0001';
  end if;
  return v_e;
end;
$$;

-- ---------------------------------------------------------------------------
-- start_game: as before, plus the deck
-- ---------------------------------------------------------------------------

create or replace function public.start_game(
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
  v_deck jsonb;
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

  v_deck := public._deal_deck(v_game, v_round);

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
    'players', v_teams,
    'deck', v_deck,
    'hand_limit', public._hand_limit(v_game.config)
  ));

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq, 'round', v_round));
end;
$$;

-- ---------------------------------------------------------------------------
-- ask_question: as in 20261129090000_more_question_types.sql, plus questions_blocked
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
  v_params jsonb;
  v_distance numeric;
  v_start extensions.geometry;
  v_end extensions.geometry;
  v_center extensions.geometry;
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
  if exists (select 1 from public.card_effects
              where game_id = p_game_id and round = v_game.round and blocks_questions and status <> 'cleared') then
    raise exception 'questions_blocked' using errcode = 'P0001';
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
  if p_params is null or jsonb_typeof(p_params) <> 'object' then
    raise exception 'invalid_params' using errcode = 'P0001';
  end if;

  if p_type in ('radar', 'thermometer') then
    -- Distance: the option's, or the seeker's own for a custom option.
    if jsonb_typeof(v_option -> 'distance_m') = 'number' then
      v_distance := (v_option ->> 'distance_m')::numeric;
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
    v_params := jsonb_build_object('label', coalesce(v_option ->> 'label', v_option ->> 'id'));
    if v_qt.extra ? 'null_answer' then
      v_params := v_params || jsonb_build_object('null_answer', v_qt.extra -> 'null_answer');
    end if;
    if p_type in ('matching', 'measuring', 'tentacles') then
      v_center := public._lonlat(p_params -> 'center');
      if not exists (select 1 from public.city_packs c
                      where c.city = v_game.city and extensions.st_dwithin(c.extent, v_center, 0.05)) then
        raise exception 'position_outside_map' using errcode = 'P0001';
      end if;
      v_params := v_params || jsonb_build_object('center', public._lonlat_json(v_center))
        || public._question_reference(v_game.city, p_type, v_option, v_center);
    elsif p_type = 'bonus' then
      v_params := v_params || jsonb_build_object('answer_kind', coalesce(v_option ->> 'answer', 'text'));
      if v_option ? 'count' then
        v_params := v_params || jsonb_build_object('count', v_option -> 'count');
      end if;
    end if;
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

-- ---------------------------------------------------------------------------
-- answer_question: as before, plus the reward draw
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
  v_draw_id uuid;
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
  v_answer := public._check_answer(v_q, p_answer);

  v_late := now() > v_q.deadline_at;
  update public.questions
     set answer = v_answer, answered_by = v_uid, answered_at = now(), late = v_late
   where id = v_q.id;

  v_seq := public._append_event(p_game_id, 'question_answered', jsonb_build_object(
    'question_id', v_q.id,
    'type', v_q.type,
    'answer', v_answer,
    'answered_by', v_uid,
    'answered_at', now(),
    'late', v_late
  ));

  -- The reward everyone was shown when the question was asked.
  select e.payload -> 'reward' into v_reward from public.events e
   where e.game_id = p_game_id and e.type = 'question_asked' and e.payload ->> 'question_id' = v_q.id::text;
  if v_q.round = v_game.round and jsonb_typeof(v_reward -> 'draw') = 'number' then
    v_draw_id := public._draw_reward(v_game, v_q.id, (v_reward ->> 'draw')::integer,
                                     coalesce((v_reward ->> 'pick')::integer, 1));
  end if;

  return public._record_result(p_client_action_id, v_uid, p_game_id, jsonb_build_object(
    'game_id', p_game_id,
    'seq', (select last_seq from public.games where id = p_game_id),
    'late', v_late,
    'draw_id', v_draw_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- Card actions
-- ---------------------------------------------------------------------------

-- Hiders keep exactly `pick` cards of a pending draw; the rest are discarded. Cards from the
-- hand can be discarded in the same call to stay within the hand limit.
create function public.keep_cards(
  p_game_id uuid,
  p_draw_id uuid,
  p_keep uuid[],
  p_discard uuid[],
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
  v_draw public.card_draws;
  v_keep uuid[] := coalesce(p_keep, '{}');
  v_discard uuid[] := coalesce(p_discard, '{}');
  v_hand integer;
  v_dropped jsonb;
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

  select * into v_draw from public.card_draws
   where id = p_draw_id and game_id = p_game_id and round = v_game.round for update;
  if not found or v_draw.kept_at is not null then
    raise exception 'draw_not_pending' using errcode = 'P0001';
  end if;

  if cardinality(v_keep) <> v_draw.pick
     or (select count(distinct k) from unnest(v_keep) k) <> v_draw.pick
     or (select count(*) from public.card_instances
          where draw_id = v_draw.id and location = 'drawn' and id = any (v_keep)) <> v_draw.pick then
    raise exception 'invalid_keep' using errcode = 'P0001',
      detail = format('keep exactly %s of the drawn cards', v_draw.pick);
  end if;
  if (select count(distinct d) from unnest(v_discard) d) <> cardinality(v_discard)
     or (select count(*) from public.card_instances
          where game_id = p_game_id and round = v_game.round and location = 'hand' and id = any (v_discard))
        <> cardinality(v_discard) then
    raise exception 'card_not_in_hand' using errcode = 'P0001';
  end if;

  select count(*) into v_hand from public.card_instances
   where game_id = p_game_id and round = v_game.round and location = 'hand';
  if v_hand - cardinality(v_discard) + v_draw.pick > public._hand_limit(v_game.config) then
    raise exception 'hand_full' using errcode = 'P0001',
      detail = format('hand limit %s', public._hand_limit(v_game.config));
  end if;

  select coalesce(jsonb_agg(id order by pile_pos), '[]') into v_dropped from public.card_instances
   where (draw_id = v_draw.id and location = 'drawn' and not id = any (v_keep)) or id = any (v_discard);

  update public.card_instances set location = 'hand' where id = any (v_keep);
  update public.card_instances set location = 'discarded'
   where (draw_id = v_draw.id and location = 'drawn') or id = any (v_discard);
  update public.card_draws set kept_at = now() where id = v_draw.id;

  v_seq := public._append_event(p_game_id, 'cards_kept', jsonb_build_object(
    'round', v_game.round,
    'draw_id', v_draw.id,
    'kept', to_jsonb(v_keep),
    'discarded', v_dropped
  ), 'hiders');

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq));
end;
$$;

-- Hiders play a card from the hand. Public card_played event (see top of file).
create function public.play_card(
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
  v_effect public.card_effects;
  v_duration integer;
  v_followup integer;
  v_minutes numeric;
  v_payload jsonb;
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
      v_minutes := public._cfg_num(v_card.params, '{minutes}', 0);
      if v_minutes <= 0 then
        raise exception 'card_not_configured' using errcode = 'P0001', detail = 'params.minutes';
      end if;
      v_payload := v_payload || jsonb_build_object('time_bonus_s', round(v_minutes * 60));
    else
      raise exception 'card_behaviour_not_supported' using errcode = 'P0001';
  end case;

  update public.card_instances set location = 'played' where id = v_inst.id;

  v_seq := public._append_event(p_game_id, 'card_played', v_payload);

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq, 'effect_id', v_effect.id));
end;
$$;

-- Seekers: "We did it" on an until_cleared effect. The hider then confirms or rejects.
create function public.clear_effect(
  p_game_id uuid,
  p_effect_id uuid,
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
  v_e public.card_effects;
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

  v_e := public._lock_effect(v_game, p_effect_id);
  if v_e.behaviour <> 'until_cleared' or v_e.status <> 'active' then
    raise exception 'effect_not_active' using errcode = 'P0001';
  end if;

  update public.card_effects set status = 'clear_requested', clear_requested_by = v_uid where id = v_e.id;

  v_seq := public._append_event(p_game_id, 'effect_clear_requested', jsonb_build_object(
    'round', v_game.round, 'effect_id', v_e.id, 'by', v_uid));

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq));
end;
$$;

-- Hiders: confirm (cleared) or reject (back to active) the seekers' "We did it".
create function public.confirm_clear(
  p_game_id uuid,
  p_effect_id uuid,
  p_accept boolean,
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
  v_e public.card_effects;
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

  v_e := public._lock_effect(v_game, p_effect_id);
  if v_e.status <> 'clear_requested' then
    raise exception 'clear_not_requested' using errcode = 'P0001';
  end if;

  if coalesce(p_accept, false) then
    update public.card_effects set status = 'cleared', cleared_at = now() where id = v_e.id;
    v_seq := public._append_event(p_game_id, 'effect_cleared', jsonb_build_object(
      'round', v_game.round, 'effect_id', v_e.id));
  else
    update public.card_effects set status = 'active', clear_requested_by = null where id = v_e.id;
    v_seq := public._append_event(p_game_id, 'effect_clear_rejected', jsonb_build_object(
      'round', v_game.round, 'effect_id', v_e.id));
  end if;

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq));
end;
$$;

-- Any player: the condition of a timed card was missed, start its follow-on timer. Once,
-- and only after the main countdown has ended.
create function public.start_followup(
  p_game_id uuid,
  p_effect_id uuid,
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
  v_e public.card_effects;
  v_seq bigint;
begin
  if v_prev is not null then
    return v_prev;
  end if;

  v_game := public._lock_game(p_game_id);
  if not exists (select 1 from public.players where game_id = p_game_id and user_id = v_uid and team is not null) then
    raise exception 'not_a_player' using errcode = 'P0001';
  end if;
  if v_game.status not in ('hiding', 'seeking') then
    raise exception 'round_not_running' using errcode = 'P0001';
  end if;
  perform public._require_fresh(p_game_id, v_uid, p_last_seen_seq);

  v_e := public._lock_effect(v_game, p_effect_id);
  if v_e.behaviour <> 'timed' or v_e.followup_s is null then
    raise exception 'no_followup' using errcode = 'P0001';
  end if;
  if v_e.followup_ends_at is not null then
    raise exception 'followup_already_started' using errcode = 'P0001';
  end if;
  if now() < v_e.ends_at then
    raise exception 'timer_still_running' using errcode = 'P0001';
  end if;

  update public.card_effects set followup_ends_at = now() + make_interval(secs => v_e.followup_s)
   where id = v_e.id returning * into v_e;

  v_seq := public._append_event(p_game_id, 'effect_followup_started', jsonb_build_object(
    'round', v_game.round, 'effect_id', v_e.id, 'by', v_uid,
    'followup_s', v_e.followup_s, 'ends_at', v_e.followup_ends_at));

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq));
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke execute on function
  public._deck_copies(jsonb),
  public._card_json(public.game_cards),
  public._deal_deck(public.games, integer),
  public._draw_reward(public.games, uuid, integer, integer),
  public._hand_limit(jsonb),
  public._lock_effect(public.games, uuid),
  public.start_game(uuid, uuid, bigint),
  public.ask_question(uuid, text, text, jsonb, uuid, bigint),
  public.answer_question(uuid, uuid, text, uuid, bigint),
  public.keep_cards(uuid, uuid, uuid[], uuid[], uuid, bigint),
  public.play_card(uuid, uuid, uuid, bigint),
  public.clear_effect(uuid, uuid, uuid, bigint),
  public.confirm_clear(uuid, uuid, boolean, uuid, bigint),
  public.start_followup(uuid, uuid, uuid, bigint)
from public, anon, authenticated;

grant execute on function
  public.start_game(uuid, uuid, bigint),
  public.ask_question(uuid, text, text, jsonb, uuid, bigint),
  public.answer_question(uuid, uuid, text, uuid, bigint),
  public.keep_cards(uuid, uuid, uuid[], uuid[], uuid, bigint),
  public.play_card(uuid, uuid, uuid, bigint),
  public.clear_effect(uuid, uuid, uuid, bigint),
  public.confirm_clear(uuid, uuid, boolean, uuid, bigint),
  public.start_followup(uuid, uuid, uuid, bigint)
to authenticated;
