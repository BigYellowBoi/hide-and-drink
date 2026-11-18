-- Playtest 2 (18/11/26) fixes.
--
-- * Push alerts for drink cards (params.drinks) go to the teams that drink, and the hiders
--   hear when the seekers answer a seeker_confirm curse.
--
-- * Each question once per run: ask_question refuses question_used for an option already
--   asked this round (any question row not voided by the host, randomized or vetoed ones
--   included). Options with reusable = true (the custom radar) can be asked again.
--   Randomize only picks options not used yet.
-- * Question types with extra.randomize_vetoes (thermometer): Randomize closes the question
--   like a veto (closed_by 'veto', payload as_veto) instead of asking another distance.
-- * Curses with params.seeker_confirm (a question for the seekers, e.g. Prison: "Are you in
--   the hiders' bar?"): play_card leaves the effect 'awaiting_seekers' (timed: ends_at
--   infinity, nothing blocks, no evidence proof yet). The seekers answer with
--   check_curse: yes starts it as usual (timer from now), no clears it (public curse_checked).
--   Host fixes: Clear a curse / Put a curse back cover either answer.
-- * Trivia params.need_right (Curse of Moll: 1 of 3): the curse clears once that many are
--   right. A set that falls short is thrown out (trivia_marked.reset) and the hider writes a
--   new one; set_trivia works again since the rows are gone. Without need_right (or with
--   need_right = count) nothing changes: wrong answers go back to the seekers.

alter table public.card_effects drop constraint card_effects_status_check;
alter table public.card_effects add constraint card_effects_status_check
  check (status in ('active', 'clear_requested', 'cleared', 'vetoed', 'awaiting_seekers'));

-- ---------------------------------------------------------------------------
-- Content
-- ---------------------------------------------------------------------------

update public.question_types
   set options = (select jsonb_agg(case when o ->> 'id' = 'custom' then o || '{"reusable": true}'::jsonb else o end
                                   order by i)
                    from jsonb_array_elements(options) with ordinality t(o, i))
 where type = 'radar';

update public.question_types set extra = coalesce(extra, '{}'::jsonb) || '{"randomize_vetoes": true}'::jsonb
 where type = 'thermometer';

update public.cards set params = params || '{"seeker_confirm": "Are you in the hiders'' bar right now?"}'::jsonb
 where id = 'prison' and not params ? 'seeker_confirm';
update public.cards set params = params || '{"seeker_confirm": "Are you in a bar right now?"}'::jsonb
 where id = 'escape' and not params ? 'seeker_confirm';
update public.cards
   set params = params || '{"need_right": 1}'::jsonb,
       body = 'Seekers must get 1 of 3 Harry Potter trivia questions right before using transport. If all three are wrong, the hider sends three new ones. No Googling.'
 where id = 'moll' and not params ? 'need_right';

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Whether this option was already asked this run (host-voided questions don't count).
create function public._question_used(p_game public.games, p_type text, p_option_id text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (select 1 from public.questions
                  where game_id = p_game.id and round = p_game.round and type = p_type
                    and option_id = p_option_id and closed_by is distinct from 'void');
$$;

-- How many trivia answers must be right (params.need_right, 1..count; default all).
create function public._trivia_need(p jsonb)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case when jsonb_typeof(p -> 'need_right') = 'number'
                   and (p ->> 'need_right')::numeric between 1 and public._trivia_count(p)
              then floor((p ->> 'need_right')::numeric)::integer
              else public._trivia_count(p) end;
$$;

-- ---------------------------------------------------------------------------
-- ask_question: as in 20261202090000_powerups_vetoes_proofs.sql, plus question_used
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
  -- Each question once per run (options with reusable = true, e.g. a custom radar, aside).
  if coalesce(v_option ->> 'reusable', 'false') <> 'true' and public._question_used(v_game, p_type, p_option_id) then
    raise exception 'question_used' using errcode = 'P0001';
  end if;

  v_q := public._insert_question(v_game, v_qt, p_option_id,
    public._question_params(v_game, p_type, v_option, v_qt.extra, p_params), v_uid, null);

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', (select last_seq from public.games where id = p_game_id),
                       'question_id', v_q.id));
end;
$$;

-- ---------------------------------------------------------------------------
-- play_card: as in 20261214090000_playtest_tools_curse_cost.sql, plus seeker_confirm
-- curses and randomize_vetoes / unused options for Randomize
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
  v_as_veto boolean := false;
  v_check boolean := false;
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

  -- Curses with params.seeker_confirm (e.g. Prison: only if the seekers are in the bar)
  -- wait for the seekers to say whether they apply before anything starts.
  v_check := v_card.behaviour in ('timed', 'until_cleared', 'trivia')
             and coalesce(v_card.params ->> 'seeker_confirm', '') not in ('', 'false');

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
              case when v_check then 'infinity'::timestamptz else now() + make_interval(secs => v_duration) end,
              v_followup)
      returning * into v_effect;
      v_payload := v_payload || jsonb_build_object(
        'effect_id', v_effect.id, 'duration_s', v_duration,
        'ends_at', case when v_check then null else v_effect.ends_at end, 'followup_s', v_followup);
    when 'until_cleared' then
      insert into public.card_effects (game_id, round, instance_id, card_id, behaviour, blocks_questions)
      values (p_game_id, v_game.round, v_inst.id, v_card.card_id, 'until_cleared',
              coalesce(v_card.params -> 'blocks_questions' = 'true'::jsonb, false))
      returning * into v_effect;
      v_payload := v_payload || jsonb_build_object(
        'effect_id', v_effect.id, 'blocks_questions', v_effect.blocks_questions);
    when 'trivia' then
      insert into public.card_effects (game_id, round, instance_id, card_id, behaviour, blocks_questions)
      values (p_game_id, v_game.round, v_inst.id, v_card.card_id, 'trivia',
              coalesce(v_card.params -> 'blocks_questions' = 'true'::jsonb, false))
      returning * into v_effect;
      v_payload := v_payload || jsonb_build_object(
        'effect_id', v_effect.id, 'blocks_questions', v_effect.blocks_questions,
        'count', public._trivia_count(v_card.params));
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
          -- Types with extra.randomize_vetoes (thermometer): the seekers can't take another
          -- distance from where they stand, so Randomize closes it like a veto.
          if coalesce(v_qt.extra ->> 'randomize_vetoes', 'false') = 'true' then
            v_as_veto := true;
            update public.questions set answered_at = now(), answered_by = v_uid, closed_by = 'veto', late = false
             where id = v_q.id;
            v_payload := v_payload || jsonb_build_object('question_id', v_q.id, 'as_veto', true);
          else
          select o into v_option from jsonb_array_elements(v_qt.options) o
           where o ->> 'id' <> v_q.option_id
             and (o ->> 'reusable' = 'true' or not public._question_used(v_game, v_q.type, o ->> 'id'))
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
          end if;
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

  if v_check and v_effect.id is not null then
    update public.card_effects set status = 'awaiting_seekers' where id = v_effect.id returning * into v_effect;
    v_payload := v_payload || jsonb_build_object(
      'awaiting_seekers', true, 'seeker_confirm', v_card.params ->> 'seeker_confirm');
  end if;

  update public.card_instances set location = 'played' where id = v_inst.id;

  perform public._append_event(p_game_id, 'card_played', v_payload, v_visibility);

  -- After card_played, so phones read the log in order.
  if v_action = 'randomize' and not v_as_veto then
    v_new := public._insert_question(v_game, v_qt, v_option ->> 'id',
      public._question_params(v_game, v_q.type, v_option, v_qt.extra,
        v_q.params || jsonb_build_object('distance_m', v_option -> 'distance_m')),
      v_q.asked_by, jsonb_build_object('randomized_from', v_q.id));
  elsif v_action = 'discard_draw' then
    perform public._draw_reward(v_game, null, v_draw, v_draw);
  end if;

  v_cost := coalesce(v_card.cast_cost, v_card.params ->> 'cost');
  if v_cost in ('drink', 'shot') then
    v_team := coalesce(v_card.params ->> 'cost_team', 'hiders');
    if v_team in ('hiders', 'seekers') then
      perform public._card_drink_due(v_game, v_team::public.team, v_cost, v_card.name, v_inst.id);
    end if;
  end if;
  -- Drinks the card hands out (params.drinks) need a photo only when the card asks for one.
  if jsonb_typeof(v_card.params -> 'drinks') = 'array' and v_card.params ->> 'proof' = 'photo' then
    for v_team in select jsonb_array_elements_text(v_card.params -> 'drinks') loop
      if v_team in ('hiders', 'seekers') then
        perform public._card_drink_due(v_game, v_team::public.team, 'drink', v_card.name, v_inst.id);
      end if;
    end loop;
  end if;

  -- A curse the seekers clear with photo evidence (params.proof = 'photo'): open the proof
  -- now, so they can upload while it runs. clear_effect waits for it.
  if v_effect.id is not null and not v_check and v_card.params ->> 'proof' = 'photo'
     and (v_effect.behaviour = 'until_cleared' or v_effect.followup_s is not null) then
    perform public._evidence_due(v_game, v_effect, v_card.name);
  end if;

  return public._record_result(p_client_action_id, v_uid, p_game_id, jsonb_build_object(
    'game_id', p_game_id,
    'seq', (select last_seq from public.games where id = p_game_id),
    'effect_id', v_effect.id,
    'question_id', v_new.id));
end;
$$;

-- ---------------------------------------------------------------------------
-- mark_trivia: as in 20261209090000_trivia_curse.sql, plus params.need_right
-- ---------------------------------------------------------------------------

create or replace function public.mark_trivia(
  p_game_id uuid,
  p_effect_id uuid,
  p_marks boolean[],
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
  v_n integer;
  v_q public.trivia_questions;
  v_mark boolean;
  v_marks jsonb := '[]'::jsonb;
  v_seq bigint;
  v_params jsonb;
  v_need integer;
  v_right integer;
  v_reset boolean := false;
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

  v_e := public._lock_trivia(v_game, p_effect_id);
  select count(*) into v_n from public.trivia_questions where effect_id = v_e.id;
  if v_n = 0 or exists (select 1 from public.trivia_questions where effect_id = v_e.id and answer is null and not correct) then
    raise exception 'trivia_nothing_to_mark' using errcode = 'P0001';
  end if;
  if coalesce(cardinality(p_marks), 0) <> v_n then
    raise exception 'invalid_trivia_marks' using errcode = 'P0001', detail = format('mark %s answers', v_n);
  end if;

  for v_q in select * from public.trivia_questions where effect_id = v_e.id order by idx for update loop
    if v_q.correct then
      v_marks := v_marks || 'null'::jsonb;
      continue;
    end if;
    v_mark := p_marks[v_q.idx + 1];
    if v_mark is null then
      raise exception 'invalid_trivia_marks' using errcode = 'P0001', detail = format('mark answer %s', v_q.idx + 1);
    end if;
    if v_mark then
      update public.trivia_questions set correct = true where effect_id = v_e.id and idx = v_q.idx;
    else
      update public.trivia_questions set answer = null, answered_by = null, wrong_count = wrong_count + 1
       where effect_id = v_e.id and idx = v_q.idx;
    end if;
    v_marks := v_marks || jsonb_build_object('correct', v_mark, 'answer', v_q.answer);
  end loop;

  select params into v_params from public.game_cards
   where game_id = p_game_id and round = v_game.round and card_id = v_e.card_id;
  v_need := public._trivia_need(v_params);
  select count(*) filter (where correct) into v_right from public.trivia_questions where effect_id = v_e.id;
  -- Needing fewer right than asked (params.need_right): a set that falls short is thrown
  -- out and the hider writes a new one.
  if v_right < v_need and v_need < v_n then
    delete from public.trivia_questions where effect_id = v_e.id;
    v_reset := true;
  end if;

  v_seq := public._append_event(p_game_id, 'trivia_marked', jsonb_build_object(
    'round', v_game.round, 'effect_id', v_e.id, 'marks', v_marks, 'by', v_uid,
    'need', v_need, 'reset', v_reset));

  if v_right >= v_need then
    v_seq := public._clear_trivia(v_game, v_e);
  end if;

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq));
end;
$$;

-- ---------------------------------------------------------------------------
-- Push alerts: as in 20261211090100_push_alerts.sql, plus drink cards (to the teams that
-- drink) and curse_checked (to the hiders)
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
        -- Drinks for one or both teams (Drinks All Round, Cheers): everyone who drinks hears.
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
    when 'freeze_changed' then
      v_alert := case when (p_payload ->> 'frozen')::boolean
        then jsonb_build_object('audience', 'hiders', 'title', 'Freeze',
               'body', 'A seeker is near your bar. Stay where you are.')
        else jsonb_build_object('audience', 'hiders', 'title', 'Freeze over', 'body', 'You can move again.') end;
    else
      v_alert := null;
  end case;
  if v_alert is null then
    return null;
  end if;
  -- Never wider than the event: a team-only event alerts only that team.
  if p_visibility <> 'all' and v_alert ->> 'audience' <> p_visibility::text then
    return null;
  end if;
  return v_alert;
end;
$$;

-- ---------------------------------------------------------------------------
-- check_curse (seekers): does a seeker_confirm curse apply? Yes starts it, no clears it.
-- ---------------------------------------------------------------------------

create function public.check_curse(
  p_game_id uuid,
  p_effect_id uuid,
  p_applies boolean,
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
  v_card public.game_cards;
  v_duration integer;
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
  if p_applies is null then
    raise exception 'invalid_choice' using errcode = 'P0001';
  end if;
  perform public._require_fresh(p_game_id, v_uid, p_last_seen_seq);

  v_e := public._lock_effect(v_game, p_effect_id);
  if v_e.status <> 'awaiting_seekers' then
    raise exception 'effect_not_awaiting' using errcode = 'P0001';
  end if;
  select * into v_card from public.game_cards
   where game_id = p_game_id and round = v_game.round and card_id = v_e.card_id;

  if p_applies then
    v_duration := public._cfg_num(v_card.params, '{duration_s}', 0)::integer;
    update public.card_effects
       set status = 'active',
           ends_at = case when behaviour = 'timed' then now() + make_interval(secs => greatest(v_duration, 1)) end
     where id = v_e.id
    returning * into v_e;
  else
    update public.card_effects set status = 'cleared', cleared_at = now() where id = v_e.id
    returning * into v_e;
  end if;

  v_seq := public._append_event(p_game_id, 'curse_checked', jsonb_build_object(
    'round', v_game.round, 'effect_id', v_e.id, 'applies', p_applies,
    'ends_at', public._iso(v_e.ends_at), 'by', v_uid));

  if p_applies and v_card.params ->> 'proof' = 'photo'
     and (v_e.behaviour = 'until_cleared' or v_e.followup_s is not null) then
    perform public._evidence_due(v_game, v_e, v_card.name);
    v_seq := (select last_seq from public.games where id = p_game_id);
  end if;

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq));
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke execute on function
  public._question_used(public.games, text, text),
  public._trivia_need(jsonb),
  public.ask_question(uuid, text, text, jsonb, uuid, bigint),
  public.play_card(uuid, uuid, uuid, bigint, jsonb),
  public.mark_trivia(uuid, uuid, boolean[], uuid, bigint),
  public.check_curse(uuid, uuid, boolean, uuid, bigint)
from public, anon, authenticated;

grant execute on function
  public.ask_question(uuid, text, text, jsonb, uuid, bigint),
  public.play_card(uuid, uuid, uuid, bigint, jsonb),
  public.mark_trivia(uuid, uuid, boolean[], uuid, bigint),
  public.check_curse(uuid, uuid, boolean, uuid, bigint)
to authenticated;
