-- Move as a timed period (the group's rule, 27/11/26):
--   "Discard your hand and send the seekers the location of your bar. This card grants a
--    10 minute period to establish a new hiding bar within a 1.5 km radius of the original
--    bar. The seekers are frozen and your hiding timer is paused until this new hiding
--    period has concluded. This card cannot be played during the endgame."
--
-- * Card params (data, not code): duration_s (the period; without it Move works as before:
--   done once the new bar is locked in), radius_m (how far from the old bar the new one may
--   be; absent = anywhere), discard_hand (true: every other hand card is discarded).
-- * play_card (front): a Move with duration_s is seeking-only (not_seeking_yet) and refused
--   while a seeker is inside the bar circle (endgame: hider_bars.frozen). After the core plays
--   it: public move_started (the old bar's name and point, radius, ends_at), hider-only
--   hand_discarded.
-- * choose_bar: while the period runs the hiders may pick (and re-pick) a bar within radius_m
--   of the old one (too_far_to_move); the move stays open (bar_chosen.move_open).
-- * _settle_timers ends the period at ends_at: public hider_moved (no actor, at = ends_at).
--   If no new bar was picked the hiders stay at the old one.
-- * Seekers are frozen meanwhile: ask_question already refuses hider_moving while
--   move_pending. found_hider still works (the hiders can be spotted on the way).
-- * The hide timer pauses: found_hider leaves out time spent in move periods
--   (_move_paused_s, from the events: move_started to its hider_moved or move_cancelled).
-- * Push: move_started and hider_moved to the seekers.

alter table public.hider_bars
  add column move_from extensions.geometry(Point, 4326),
  add column move_from_name text,
  add column move_radius_m numeric,
  add column move_ends_at timestamptz;

-- ---------------------------------------------------------------------------
-- Content: the library card, unless someone has edited it since the seed.
-- ---------------------------------------------------------------------------

update public.cards
   set body = 'Discard your hand and send the seekers the location of your bar. You get 10 minutes to '
              || 'establish a new hiding bar within 1.5 km of it. The seekers are frozen and your hiding '
              || 'timer is paused until the 10 minutes are up. Can''t be played during the endgame '
              || '(a seeker inside your bar''s zone).',
       params = '{"action": "move", "duration_s": 600, "radius_m": 1500, "discard_hand": true}'::jsonb
 where id = 'move' and params = '{"action": "move"}'::jsonb;

-- ---------------------------------------------------------------------------
-- play_card: as in 20261221090000_cast_media_escape_stations.sql, plus the Move period.
-- ---------------------------------------------------------------------------

create or replace function public.play_card(
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
  v_media jsonb := case when jsonb_typeof(p_choice -> 'media') = 'object' then p_choice -> 'media' end;
  v_result jsonb;
  v_game public.games;
  v_proof uuid;
  v_card public.game_cards;
  v_move boolean := false;
  v_duration integer;
  v_radius numeric;
  v_bar public.hider_bars;
  v_ids jsonb;
begin
  -- A Move with a period: checks the core doesn't make. Retries go straight to the core,
  -- which returns the first result.
  if public._previous_result(p_client_action_id, v_uid) is null then
    select g.* into v_card from public.card_instances i
      join public.game_cards g on g.game_id = i.game_id and g.round = i.round and g.card_id = i.card_id
     where i.id = p_instance_id and i.game_id = p_game_id and i.location = 'hand';
    v_move := found and v_card.behaviour = 'powerup' and v_card.params ->> 'action' = 'move'
              and public._cfg_num(v_card.params, '{duration_s}', 0) >= 1;
    if v_move then
      v_game := public._lock_game(p_game_id);
      perform public._require_team(p_game_id, v_uid, 'hiders');
      -- Not settled here: new events before the core's freshness check would make it stale.
      if v_game.status = 'hiding'
         and now() < v_game.round_started_at + make_interval(secs => v_game.hiding_period_s) then
        raise exception 'not_seeking_yet' using errcode = 'P0001';
      end if;
      if exists (select 1 from public.hider_bars where game_id = p_game_id and round = v_game.round and frozen) then
        raise exception 'endgame' using errcode = 'P0001';
      end if;
    end if;
  end if;

  v_result := public._play_card_core(p_game_id, p_instance_id, p_client_action_id, p_last_seen_seq,
                                     case when p_choice is null then null else p_choice - 'media' end);

  if v_move then
    v_duration := public._cfg_num(v_card.params, '{duration_s}', 0)::integer;
    v_radius := nullif(public._cfg_num(v_card.params, '{radius_m}', 0), 0);
    update public.hider_bars
       set move_from = geom, move_from_name = venue_name, move_radius_m = v_radius,
           move_ends_at = now() + make_interval(secs => v_duration)
     where game_id = p_game_id and round = v_game.round
    returning * into v_bar;
    -- The old bar goes to everyone: that's the card's price.
    perform public._append_event(p_game_id, 'move_started', jsonb_build_object(
      'round', v_game.round,
      'instance_id', p_instance_id,
      'from', jsonb_build_object(
        'name', v_bar.move_from_name,
        'lng', round(extensions.st_x(v_bar.move_from)::numeric, 6),
        'lat', round(extensions.st_y(v_bar.move_from)::numeric, 6)),
      'radius_m', v_radius,
      'duration_s', v_duration,
      'started_at', public._iso(now()),
      'ends_at', public._iso(v_bar.move_ends_at)));
    if v_card.params -> 'discard_hand' = 'true'::jsonb then
      with d as (
        update public.card_instances set location = 'discarded'
         where game_id = p_game_id and round = v_game.round and location = 'hand'
        returning id, card_id
      )
      select jsonb_agg(jsonb_build_object('instance_id', id, 'card_id', card_id)) into v_ids from d;
      if v_ids is not null then
        perform public._append_event(p_game_id, 'hand_discarded', jsonb_build_object(
          'round', v_game.round, 'instance_id', p_instance_id, 'cards', v_ids), 'hiders');
      end if;
    end if;
    v_result := v_result || jsonb_build_object('seq', (select last_seq from public.games where id = p_game_id));
  end if;

  if v_media is null then
    return v_result;
  end if;
  select * into v_game from public.games where id = p_game_id;

  -- The drink the hiders pay to cast it.
  if v_media ? 'cost' then
    select (e.payload ->> 'proof_id')::uuid into v_proof from public.events e
     where e.game_id = p_game_id and e.type = 'drink_due'
       and e.payload ->> 'instance_id' = p_instance_id::text and e.payload ->> 'team' = 'hiders'
     order by e.seq limit 1;
    if v_proof is not null then
      perform public._prove_with_cast_media(v_game, v_proof, p_instance_id, v_media ->> 'cost');
    end if;
  end if;
  -- The curse's first step (params.hider_proof).
  if v_media ? 'setup' then
    select d.id into v_proof from public.drink_proofs d
      join public.card_effects ce on ce.id = d.effect_id
     where ce.game_id = p_game_id and ce.instance_id = p_instance_id and d.kind = 'setup';
    if v_proof is not null then
      perform public._prove_with_cast_media(v_game, v_proof, p_instance_id, v_media ->> 'setup');
    end if;
  end if;

  return v_result || jsonb_build_object('seq', (select last_seq from public.games where id = p_game_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- choose_bar: as in 20261206090000_custom_venues.sql, plus picking during a Move period.
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
  v_period boolean;
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
  v_period := coalesce(v_bar.move_pending and v_bar.move_ends_at is not null, false);
  if v_period and v_bar.move_ends_at <= now() then
    raise exception 'move_over' using errcode = 'P0001';
  end if;

  select * into v_venue from public._valid_bars(v_game) b where b.feature_id = p_venue_id;
  if not found then
    if exists (select 1 from public.map_features where city = v_game.city and layer = 'venues' and feature_id = p_venue_id)
       or exists (select 1 from public.game_venues where game_id = p_game_id and feature_id = p_venue_id) then
      raise exception 'venue_not_allowed' using errcode = 'P0001';
    end if;
    raise exception 'venue_not_found' using errcode = 'P0001';
  end if;
  if v_period then
    if v_bar.move_radius_m is not null and not extensions.st_dwithin(
         v_venue.geom::extensions.geography, v_bar.move_from::extensions.geography, v_bar.move_radius_m::float8) then
      raise exception 'too_far_to_move' using errcode = 'P0001';
    end if;
  elsif v_bar.move_pending and v_bar.venue_id = p_venue_id then
    raise exception 'same_bar' using errcode = 'P0001';
  end if;

  v_radius := public._cfg_num(v_game.config, '{hiding_zone,bar_radius_m}', 100);
  v_late := now() > v_game.round_started_at + make_interval(secs => v_game.hiding_period_s);

  if v_bar.move_pending then
    update public.hider_bars
       set venue_id = v_venue.feature_id, venue_name = v_venue.name, geom = v_venue.geom,
           chosen_by = v_uid, chosen_at = now(), move_pending = v_period
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
    'late', v_late and not coalesce(v_bar.move_pending, false),
    'moved', coalesce(v_bar.move_pending, false),
    -- The Move period is still running: the hiders can change their pick until it ends.
    'move_open', v_period
  ), 'hiders');

  if v_bar.move_pending and not v_period then
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
-- _settle_timers: as in 20261219090100_rounds_scoring.sql, plus the end of a Move period.
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
  v_proof uuid;
  v_bar public.hider_bars;
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

  -- The Move period is over: the hiders are wherever they picked last (or still at the old bar).
  select * into v_bar from public.hider_bars
   where game_id = p_game_id and round = v_game.round and move_pending and move_ends_at <= now()
  for update;
  if found then
    update public.hider_bars set move_pending = false where game_id = p_game_id and round = v_game.round;
    perform public._append_event(p_game_id, 'hider_moved', jsonb_build_object(
      'round', v_game.round, 'at', public._iso(v_bar.move_ends_at), 'period_over', true), 'all', null);
    perform public._update_freeze(v_game);
    v_n := v_n + 1;
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

-- ---------------------------------------------------------------------------
-- Time spent in Move periods (the hide timer is paused) between p_from and p_to, seconds.
-- A period ends at its hider_moved (at) or move_cancelled, else at ends_at.
-- ---------------------------------------------------------------------------

create function public._move_paused_s(p_game_id uuid, p_round integer, p_from timestamptz, p_to timestamptz)
returns integer
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(greatest(0, extract(epoch from
           least(p_to, m.ends_at, coalesce(m.ended_at, 'infinity')) - greatest(p_from, m.started_at)))), 0)::integer
    from (
      select (e.payload ->> 'started_at')::timestamptz as started_at,
             (e.payload ->> 'ends_at')::timestamptz as ends_at,
             (select min(coalesce((x.payload ->> 'at')::timestamptz, x.created_at))
                from public.events x
               where x.game_id = e.game_id and x.seq > e.seq and x.type in ('hider_moved', 'move_cancelled')
                 and x.payload ->> 'round' = e.payload ->> 'round') as ended_at
        from public.events e
       where e.game_id = p_game_id and e.type = 'move_started' and e.payload ->> 'round' = p_round::text
    ) m;
$$;

-- ---------------------------------------------------------------------------
-- found_hider: as in 20261219090100_rounds_scoring.sql, but the hide time leaves out Move
-- periods. Still allowed during one: the hiders can be spotted while moving.
-- ---------------------------------------------------------------------------

create or replace function public.found_hider(p_game_id uuid, p_client_action_id uuid, p_last_seen_seq bigint)
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
  -- Anything due before now (seeking start, missed deadlines, a Move period) happened first.
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
          greatest(0, floor(extract(epoch from now() - v_seeking_at))
                      - public._move_paused_s(p_game_id, v_game.round, v_seeking_at, now()))::integer,
          v_bonus)
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

-- ---------------------------------------------------------------------------
-- Push: as in 20261224090000_tidy_abandoned_games.sql, plus the Move to the seekers.
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
    when 'move_started' then
      v_mins := ceil(coalesce((p_payload ->> 'duration_s')::numeric, 600) / 60);
      v_alert := jsonb_build_object('audience', 'seekers', 'title', 'Frozen: the hiders are moving',
        'body', format('Stay where you are for %s min. They left %s, which is on your map.',
                       v_mins, coalesce(p_payload -> 'from' ->> 'name', 'their bar')));
    when 'hider_moved' then
      if (p_payload ->> 'period_over')::boolean then
        v_alert := jsonb_build_object('audience', 'seekers', 'title', 'Move over',
          'body', 'You can move and ask questions again.');
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
      if p_payload ->> 'reason' is distinct from 'inactive' then
        v_alert := jsonb_build_object('audience', 'all', 'title', 'Game over', 'body', 'Open the app to see who won.');
      end if;
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

revoke execute on function
  public.play_card(uuid, uuid, uuid, bigint, jsonb),
  public.choose_bar(uuid, text, uuid, bigint),
  public._settle_timers(uuid),
  public._move_paused_s(uuid, integer, timestamptz, timestamptz),
  public.found_hider(uuid, uuid, bigint),
  public._push_for_event(text, public.event_visibility, jsonb)
from public, anon, authenticated;

grant execute on function
  public.play_card(uuid, uuid, uuid, bigint, jsonb),
  public.choose_bar(uuid, text, uuid, bigint),
  public.found_hider(uuid, uuid, bigint)
to authenticated;
