-- Trivia curses (behaviour 'trivia'), first used by Curse of Moll.
--
-- The hider writes params.count questions (default 3, on params.topic) and sends them with
-- set_trivia. The seekers send an answer to every question at once (answer_trivia), then the
-- hider marks them all at once, each right or wrong (mark_trivia). Wrong ones go back to the
-- seekers, who send new answers for just those; once every question is marked right the
-- curse clears (effect_cleared). The host can mark them all
-- right and clear the curse by hand (force_clear_trivia), e.g. when the hider's phone dies.
-- Questions, answers and marks are public: both teams see them in the curse and the log.
-- What the curse blocks (e.g. transport) stays on the honour system; params.blocks_questions
-- works as for until_cleared. Vetoes work as for any curse.

alter table public.cards drop constraint cards_behaviour_check;
alter table public.cards add constraint cards_behaviour_check check (
  behaviour in (
    'text', 'timed', 'until_cleared', 'trivia', 'time_bonus',
    'next_question_modifier', 'powerup', 'question_ban'
  )
);

alter table public.card_effects drop constraint card_effects_behaviour_check;
alter table public.card_effects add constraint card_effects_behaviour_check
  check (behaviour in ('timed', 'until_cleared', 'trivia'));

-- One row per question. Public through events only: no client access.
create table public.trivia_questions (
  effect_id uuid not null references public.card_effects (id) on delete cascade,
  idx integer not null check (idx >= 0),
  game_id uuid not null references public.games (id) on delete cascade,
  round integer not null,
  question text not null check (char_length(question) between 1 and 500),
  -- The answer waiting for a mark (null: the seekers owe one).
  answer text check (char_length(answer) between 1 and 500),
  answered_by uuid,
  correct boolean not null default false,
  wrong_count integer not null default 0,
  primary key (effect_id, idx),
  check (not (correct and answer is null))
);
alter table public.trivia_questions enable row level security;

create function public._trivia_count(p jsonb)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case when jsonb_typeof(p -> 'count') = 'number' and (p ->> 'count')::numeric between 1 and 10
              then floor((p ->> 'count')::numeric)::integer else 3 end;
$$;

-- The game's active trivia effect, locked. Raises effect_not_active otherwise.
create function public._lock_trivia(p_game public.games, p_effect_id uuid)
returns public.card_effects
language plpgsql
set search_path = ''
as $$
declare
  v_e public.card_effects;
begin
  v_e := public._lock_effect(p_game, p_effect_id);
  if v_e.behaviour <> 'trivia' or v_e.status <> 'active' then
    raise exception 'effect_not_active' using errcode = 'P0001';
  end if;
  return v_e;
end;
$$;

-- Clear a trivia curse once every question is right (or the host says so).
create function public._clear_trivia(p_game public.games, p_effect public.card_effects)
returns bigint
language plpgsql
set search_path = ''
as $$
begin
  update public.card_effects set status = 'cleared', cleared_at = now() where id = p_effect.id;
  return public._append_event(p_game.id, 'effect_cleared', jsonb_build_object(
    'round', p_game.round, 'effect_id', p_effect.id));
end;
$$;

-- ---------------------------------------------------------------------------
-- set_trivia (hiders): the questions, once per curse
-- ---------------------------------------------------------------------------

create function public.set_trivia(
  p_game_id uuid,
  p_effect_id uuid,
  p_questions text[],
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
  v_params jsonb;
  v_n integer;
  v_qs text[];
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

  v_e := public._lock_trivia(v_game, p_effect_id);
  if exists (select 1 from public.trivia_questions where effect_id = v_e.id) then
    raise exception 'trivia_already_set' using errcode = 'P0001';
  end if;
  select params into v_params from public.game_cards
   where game_id = p_game_id and round = v_game.round and card_id = v_e.card_id;
  v_n := public._trivia_count(v_params);
  v_qs := array(select btrim(q) from unnest(coalesce(p_questions, '{}')) q);
  if cardinality(v_qs) <> v_n
     or exists (select 1 from unnest(v_qs) q where q is null or char_length(q) not between 1 and 500) then
    raise exception 'invalid_trivia' using errcode = 'P0001', detail = format('write %s questions', v_n);
  end if;

  insert into public.trivia_questions (effect_id, idx, game_id, round, question)
  select v_e.id, i - 1, p_game_id, v_game.round, v_qs[i] from generate_subscripts(v_qs, 1) i;

  v_seq := public._append_event(p_game_id, 'trivia_set', jsonb_build_object(
    'round', v_game.round, 'effect_id', v_e.id, 'questions', to_jsonb(v_qs), 'by', v_uid));

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq));
end;
$$;

-- ---------------------------------------------------------------------------
-- answer_trivia (seekers): one answer for every question not yet right, all at once
-- ---------------------------------------------------------------------------

-- p_answers has one entry per question, in order; entries for questions already right are
-- ignored (send null).
create function public.answer_trivia(
  p_game_id uuid,
  p_effect_id uuid,
  p_answers text[],
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
  v_answers jsonb := '[]'::jsonb;
  v_q public.trivia_questions;
  v_a text;
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

  v_e := public._lock_trivia(v_game, p_effect_id);
  select count(*) into v_n from public.trivia_questions where effect_id = v_e.id;
  if v_n = 0 then
    raise exception 'trivia_not_set' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.trivia_questions where effect_id = v_e.id and answer is not null and not correct) then
    raise exception 'trivia_already_answered' using errcode = 'P0001';
  end if;
  if coalesce(cardinality(p_answers), 0) <> v_n then
    raise exception 'invalid_trivia_answer' using errcode = 'P0001', detail = format('send %s answers', v_n);
  end if;

  for v_q in select * from public.trivia_questions where effect_id = v_e.id order by idx for update loop
    if v_q.correct then
      v_answers := v_answers || 'null'::jsonb;
      continue;
    end if;
    v_a := btrim(coalesce(p_answers[v_q.idx + 1], ''));
    if char_length(v_a) not between 1 and 500 then
      raise exception 'invalid_trivia_answer' using errcode = 'P0001', detail = format('answer question %s', v_q.idx + 1);
    end if;
    update public.trivia_questions set answer = v_a, answered_by = v_uid where effect_id = v_e.id and idx = v_q.idx;
    v_answers := v_answers || to_jsonb(v_a);
  end loop;

  v_seq := public._append_event(p_game_id, 'trivia_answered', jsonb_build_object(
    'round', v_game.round, 'effect_id', v_e.id, 'answers', v_answers, 'by', v_uid));

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq));
end;
$$;

-- ---------------------------------------------------------------------------
-- mark_trivia (hiders): marks every waiting answer at once. Wrong ones go back to the
-- seekers; all right clears the curse.
-- ---------------------------------------------------------------------------

-- p_marks has one entry per question, in order; entries for questions already right are
-- ignored (send null).
create function public.mark_trivia(
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

  v_seq := public._append_event(p_game_id, 'trivia_marked', jsonb_build_object(
    'round', v_game.round, 'effect_id', v_e.id, 'marks', v_marks, 'by', v_uid));

  if not exists (select 1 from public.trivia_questions where effect_id = v_e.id and not correct) then
    v_seq := public._clear_trivia(v_game, v_e);
  end if;

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq));
end;
$$;

-- ---------------------------------------------------------------------------
-- force_clear_trivia (host, either team): mark all right and clear the curse
-- ---------------------------------------------------------------------------

create function public.force_clear_trivia(
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
  if v_game.host_id <> v_uid then
    raise exception 'host_only' using errcode = 'P0001';
  end if;
  if v_game.status not in ('hiding', 'seeking') then
    raise exception 'round_not_running' using errcode = 'P0001';
  end if;
  perform public._require_fresh(p_game_id, v_uid, p_last_seen_seq);

  v_e := public._lock_trivia(v_game, p_effect_id);
  update public.trivia_questions set correct = true, answer = coalesce(answer, '(marked by the host)')
   where effect_id = v_e.id and not correct;

  perform public._append_event(p_game_id, 'trivia_force_cleared', jsonb_build_object(
    'round', v_game.round, 'effect_id', v_e.id, 'by', v_uid));
  v_seq := public._clear_trivia(v_game, v_e);

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq));
end;
$$;

-- ---------------------------------------------------------------------------
-- play_card: as in 20261208090000_card_proofs_picking.sql, plus 'trivia'
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
    v_team := coalesce(v_card.params ->> 'cost_team', case when v_card.category_id = 'curse' then 'seekers' else 'hiders' end);
    if v_team in ('hiders', 'seekers') then
      perform public._drink_due(v_game, v_team::public.team, v_cost, v_card.name);
    end if;
  end if;
  -- Drinks the card hands out (params.drinks) need a photo only when the card asks for one.
  if jsonb_typeof(v_card.params -> 'drinks') = 'array' and v_card.params ->> 'proof' = 'photo' then
    for v_team in select jsonb_array_elements_text(v_card.params -> 'drinks') loop
      if v_team in ('hiders', 'seekers') then
        perform public._drink_due(v_game, v_team::public.team, 'drink', v_card.name);
      end if;
    end loop;
  end if;

  -- A curse the seekers clear with photo evidence (params.proof = 'photo'): open the proof
  -- now, so they can upload while it runs. clear_effect waits for it.
  if v_effect.id is not null and v_card.params ->> 'proof' = 'photo'
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
-- Library: 'trivia' is a behaviour cards can have (params.count 1-10)
-- ---------------------------------------------------------------------------

-- As in 20261205090000_card_library_deck_builder.sql, plus params.count for trivia.
create or replace function public._check_card_params(p_behaviour text, p jsonb)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_bad text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    v_bad := 'params';
  elsif p_behaviour = 'timed' and not public._is_pos(p -> 'duration_s') then
    v_bad := 'duration_s';
  elsif p_behaviour = 'time_bonus' and not public._is_pos(p -> 'minutes') then
    v_bad := 'minutes';
  elsif p_behaviour = 'powerup' and coalesce(p ->> 'action', '') not in ('veto', 'randomize', 'duplicate', 'move', 'discard_draw') then
    v_bad := 'action';
  elsif p_behaviour = 'powerup' and p ->> 'action' = 'discard_draw' and not public._is_int(p -> 'discard', 0, 10) then
    v_bad := 'discard';
  elsif p_behaviour = 'powerup' and p ->> 'action' = 'discard_draw' and not public._is_int(p -> 'draw', 1, 10) then
    v_bad := 'draw';
  elsif p_behaviour = 'trivia' and p ? 'count' and not public._is_int(p -> 'count', 1, 10) then
    v_bad := 'count';
  elsif p_behaviour = 'question_ban' and p ? 'count' and not public._is_int(p -> 'count', 1, 10) then
    v_bad := 'count';
  elsif p_behaviour = 'next_question_modifier' and p ? 'reward_multiplier'
        and not (jsonb_typeof(p -> 'reward_multiplier') = 'number' and (p ->> 'reward_multiplier')::numeric >= 1) then
    v_bad := 'reward_multiplier';
  elsif p ? 'followup_s' and not public._is_pos(p -> 'followup_s') then
    v_bad := 'followup_s';
  elsif p ? 'utility' and coalesce(p ->> 'utility', '') not in ('dice', 'wheel') then
    v_bad := 'utility';
  elsif p ? 'dice' and not public._is_int(p -> 'dice', 1, 10) then
    v_bad := 'dice';
  elsif p ? 'wheel_options' and not (jsonb_typeof(p -> 'wheel_options') = 'array'
        and jsonb_array_length(p -> 'wheel_options') between 2 and 50) then
    v_bad := 'wheel_options';
  elsif p ? 'cost' and coalesce(p ->> 'cost', '') not in ('drink', 'shot') then
    v_bad := 'cost';
  elsif p ? 'cost_team' and coalesce(p ->> 'cost_team', '') not in ('hiders', 'seekers') then
    v_bad := 'cost_team';
  elsif p ? 'drinks' and not (jsonb_typeof(p -> 'drinks') = 'array' and not exists (
          select 1 from jsonb_array_elements(p -> 'drinks') t where t #>> '{}' not in ('hiders', 'seekers'))) then
    v_bad := 'drinks';
  end if;
  if v_bad is not null then
    raise exception 'invalid_card_params' using errcode = 'P0001', detail = v_bad;
  end if;
end;
$$;

-- save_card: as in 20261205090000_card_library_deck_builder.sql, plus 'trivia'.
create or replace function public.save_card(
  p_card_id text,
  p_card jsonb,
  p_client_action_id uuid,
  p_base_updated_at timestamptz default null,
  p_author_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public._require_user();
  v_prev jsonb := public._previous_result(p_client_action_id, v_uid);
  v_name text := public._author_name(v_uid, p_author_name);
  v_old public.cards;
  v_new public.cards;
  v_card_name text;
  v_category text;
  v_behaviour text;
  v_text text;
  v_params jsonb;
  v_cost text;
  v_veto boolean;
  v_copies jsonb;
  v_id text;
begin
  if v_prev is not null then
    return v_prev;
  end if;
  if p_card is null or jsonb_typeof(p_card) <> 'object' then
    raise exception 'invalid_card' using errcode = 'P0001';
  end if;

  v_card_name := btrim(coalesce(p_card ->> 'name', ''));
  v_category := p_card ->> 'category';
  v_behaviour := p_card ->> 'behaviour';
  v_text := nullif(btrim(coalesce(p_card ->> 'text', '')), '');
  v_params := coalesce(p_card -> 'params', '{}'::jsonb);
  v_cost := nullif(p_card ->> 'cast_cost', '');
  v_copies := p_card -> 'copies';

  if char_length(v_card_name) not between 1 and 80 then
    raise exception 'invalid_card_name' using errcode = 'P0001';
  end if;
  if v_text is not null and char_length(v_text) > 2000 then
    raise exception 'invalid_card_text' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.categories where id = v_category and active) then
    raise exception 'category_not_found' using errcode = 'P0001';
  end if;
  if coalesce(v_behaviour, '') not in
     ('text', 'timed', 'until_cleared', 'trivia', 'time_bonus', 'next_question_modifier', 'powerup', 'question_ban') then
    raise exception 'invalid_card_behaviour' using errcode = 'P0001';
  end if;
  if v_cost is not null and v_cost not in ('free', 'drink', 'shot') then
    raise exception 'invalid_card_cost' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_card -> 'can_veto') = 'boolean' then
    v_veto := (p_card ->> 'can_veto')::boolean;
  elsif p_card ? 'can_veto' and jsonb_typeof(p_card -> 'can_veto') <> 'null' then
    raise exception 'invalid_card' using errcode = 'P0001', detail = 'can_veto';
  end if;
  if v_copies is null or not public._is_int(v_copies, 0, 99) then
    raise exception 'invalid_card_copies' using errcode = 'P0001';
  end if;
  perform public._check_card_params(v_behaviour, v_params);

  if p_card_id is null then
    v_id := public._new_library_id(v_card_name, 'cards');
    insert into public.cards (id, name, category_id, behaviour, body, params, cast_cost, can_veto,
                              default_copies, sort, active, updated_by, updated_by_name, updated_at)
    values (v_id, v_card_name, v_category, v_behaviour, v_text, v_params, v_cost, v_veto,
            (v_copies #>> '{}')::integer,
            coalesce((select max(sort) + 1 from public.cards where category_id = v_category), 0),
            true, v_uid, v_name, clock_timestamp())
    returning * into v_new;
    perform public._library_changed('card', v_id, 'created', v_uid, v_name, null, public._card_row_json(v_new));
  else
    select * into v_old from public.cards where id = p_card_id for update;
    if not found then
      raise exception 'card_not_found' using errcode = 'P0001';
    end if;
    if p_base_updated_at is not null and v_old.updated_at <> p_base_updated_at then
      raise exception 'card_changed' using errcode = 'P0001';
    end if;
    update public.cards
       set name = v_card_name,
           category_id = v_category,
           behaviour = v_behaviour,
           body = v_text,
           params = v_params,
           cast_cost = v_cost,
           can_veto = v_veto,
           default_copies = (v_copies #>> '{}')::integer,
           sort = case when category_id = v_category then sort
                       else coalesce((select max(c.sort) + 1 from public.cards c where c.category_id = v_category), 0) end,
           updated_by = v_uid,
           updated_by_name = v_name,
           updated_at = clock_timestamp()
     where id = p_card_id
    returning * into v_new;
    perform public._library_changed('card', p_card_id, 'updated', v_uid, v_name,
      public._card_row_json(v_old), public._card_row_json(v_new));
  end if;

  return public._record_result(p_client_action_id, v_uid, null,
    jsonb_build_object('card_id', v_new.id, 'updated_at', v_new.updated_at));
end;
$$;

-- Curse of Moll is a trivia curse: three Harry Potter questions from the hider.
update public.cards
   set behaviour = 'trivia',
       params = params || '{"count":3,"topic":"Harry Potter"}'::jsonb,
       updated_at = now()
 where id = 'moll' and behaviour = 'until_cleared';

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke execute on function
  public._trivia_count(jsonb),
  public._lock_trivia(public.games, uuid),
  public._clear_trivia(public.games, public.card_effects),
  public.set_trivia(uuid, uuid, text[], uuid, bigint),
  public.answer_trivia(uuid, uuid, text[], uuid, bigint),
  public.mark_trivia(uuid, uuid, boolean[], uuid, bigint),
  public.force_clear_trivia(uuid, uuid, uuid, bigint),
  public.play_card(uuid, uuid, uuid, bigint, jsonb),
  public._check_card_params(text, jsonb),
  public.save_card(text, jsonb, uuid, timestamptz, text)
from public, anon, authenticated;

grant execute on function
  public.set_trivia(uuid, uuid, text[], uuid, bigint),
  public.answer_trivia(uuid, uuid, text[], uuid, bigint),
  public.mark_trivia(uuid, uuid, boolean[], uuid, bigint),
  public.force_clear_trivia(uuid, uuid, uuid, bigint),
  public.play_card(uuid, uuid, uuid, bigint, jsonb),
  public.save_card(text, jsonb, uuid, timestamptz, text)
to authenticated;
