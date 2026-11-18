-- Playtest 2 follow-ups (18/11/26).
--
-- * Video proofs: params.proof = 'video' (Bird Guide, Sculling) is collected by the app like
--   'photo'. drink-photos takes video (mp4, mov, webm) up to 50 MB, the free plan's per-file
--   cap; the phone records or squeezes videos to fit. Object names may end in a video extension.
-- * Hider first step: curses with params.hider_proof ('photo' or 'video', e.g. Unguided
--   Tourist's Street View screenshot, Bird Guide's video) open a proof for the hiders as well
--   (drink_proofs.kind 'setup', public proof_due with team 'hiders'). The seekers can't say
--   they did it until it is in (clear_effect already waits for every open proof of the effect).
--   A rejected confirm_clear only reopens the seekers' evidence, never the hiders' setup.
-- * drink_proved carries the proof's kind and label, and alerts the other team by push.

-- ---------------------------------------------------------------------------
-- Content
-- ---------------------------------------------------------------------------

update public.cards set params = params || '{"hider_proof": "photo"}'::jsonb
 where id in ('unguided_tourist', 'luxury_car', 'menu') and not params ? 'hider_proof';
update public.cards set params = params || '{"hider_proof": "video"}'::jsonb
 where id in ('bird_guide', 'sculling') and not params ? 'hider_proof';

-- ---------------------------------------------------------------------------
-- Storage: videos
-- ---------------------------------------------------------------------------

update storage.buckets
   set file_size_limit = 52428800,
       allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm']
 where id = 'drink-photos';

-- As in 20261129090000_more_question_types.sql, plus video extensions.
create or replace function public._photo_path_ids(p_name text, out game_id uuid, out question_id uuid)
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9_-]{1,64}\.(jpg|jpeg|png|webp|mp4|mov|webm)$' then
    return;
  end if;
  game_id := split_part(p_name, '/', 1)::uuid;
  question_id := split_part(p_name, '/', 2)::uuid;
end;
$$;

-- ---------------------------------------------------------------------------
-- Setup proofs
-- ---------------------------------------------------------------------------

alter table public.drink_proofs drop constraint drink_proofs_kind_check;
alter table public.drink_proofs add constraint drink_proofs_kind_check check (kind in ('drink', 'evidence', 'setup'));
drop index public.drink_proofs_effect_idx;
create unique index drink_proofs_effect_idx on public.drink_proofs (effect_id, kind) where effect_id is not null;

-- Open the proofs a curse's effect needs: the hiders' first step (params.hider_proof), then
-- the seekers' evidence (params.proof photo or video, for curses they clear). True if any.
create function public._curse_proofs(p_game public.games, p_effect public.card_effects, p_card public.game_cards)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
  v_any boolean := false;
begin
  if p_card.params ->> 'hider_proof' in ('photo', 'video') then
    insert into public.drink_proofs (game_id, round, team, cost, label, kind, effect_id)
    values (p_game.id, p_game.round, 'hiders', null, p_card.name, 'setup', p_effect.id)
    returning id into v_id;
    perform public._append_event(p_game.id, 'proof_due', jsonb_build_object(
      'round', p_game.round, 'proof_id', v_id, 'team', 'hiders', 'kind', 'setup',
      'media', p_card.params ->> 'hider_proof', 'label', p_card.name, 'effect_id', p_effect.id), 'all', null);
    v_any := true;
  end if;
  if p_card.params ->> 'proof' in ('photo', 'video')
     and (p_effect.behaviour = 'until_cleared' or p_effect.followup_s is not null) then
    perform public._evidence_due(p_game, p_effect, p_card.name);
    v_any := true;
  end if;
  return v_any;
end;
$$;

-- ---------------------------------------------------------------------------
-- play_card: as in 20261217090000_playtest2_fixes.sql, proofs via _curse_proofs
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

  -- Curse proofs (params.hider_proof, params.proof): open them now, so both teams can
  -- upload while it runs. clear_effect waits for them.
  if v_effect.id is not null and not v_check then
    perform public._curse_proofs(v_game, v_effect, v_card);
  end if;

  return public._record_result(p_client_action_id, v_uid, p_game_id, jsonb_build_object(
    'game_id', p_game_id,
    'seq', (select last_seq from public.games where id = p_game_id),
    'effect_id', v_effect.id,
    'question_id', v_new.id));
end;
$$;


-- ---------------------------------------------------------------------------
-- check_curse: as in 20261217090000_playtest2_fixes.sql, proofs via _curse_proofs
-- ---------------------------------------------------------------------------

create or replace function public.check_curse(
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

  if p_applies and public._curse_proofs(v_game, v_e, v_card) then
    v_seq := (select last_seq from public.games where id = p_game_id);
  end if;

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq));
end;
$$;

-- ---------------------------------------------------------------------------
-- confirm_clear: as in 20261208090000_card_proofs_picking.sql, a rejection reopens only
-- the seekers' evidence
-- ---------------------------------------------------------------------------

create or replace function public.confirm_clear(
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
    -- The photo didn't convince the hider: the seekers send a new one with the next try.
    update public.drink_proofs set photo_path = null, proved_by = null, proved_at = null
     where effect_id = v_e.id and kind = 'evidence' and resolution is null;
    v_seq := public._append_event(p_game_id, 'effect_clear_rejected', jsonb_build_object(
      'round', v_game.round, 'effect_id', v_e.id));
  end if;

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq));
end;
$$;

-- ---------------------------------------------------------------------------
-- submit_drink_proof: as in 20261202090000_powerups_vetoes_proofs.sql, plus kind and label
-- in drink_proved (for the alert and the toast)
-- ---------------------------------------------------------------------------

create or replace function public.submit_drink_proof(
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
    'round', v_d.round, 'proof_id', v_d.id, 'team', v_d.team, 'path', v_path, 'by', v_uid,
    'kind', v_d.kind, 'label', v_d.label));

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq));
end;
$$;

-- ---------------------------------------------------------------------------
-- Push alerts: as in 20261217090000_playtest2_fixes.sql, plus drink_proved (other team)
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
    when 'drink_proved' then
      -- Tell the other team a drink or proof is done (the team that sent it saw it go).
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
-- Privileges
-- ---------------------------------------------------------------------------

revoke execute on function
  public._photo_path_ids(text),
  public._curse_proofs(public.games, public.card_effects, public.game_cards),
  public.play_card(uuid, uuid, uuid, bigint, jsonb),
  public.check_curse(uuid, uuid, boolean, uuid, bigint),
  public.confirm_clear(uuid, uuid, boolean, uuid, bigint),
  public.submit_drink_proof(uuid, uuid, text, uuid, bigint),
  public._push_for_event(text, public.event_visibility, jsonb)
from public, anon, authenticated;

grant execute on function
  public.play_card(uuid, uuid, uuid, bigint, jsonb),
  public.check_curse(uuid, uuid, boolean, uuid, bigint),
  public.confirm_clear(uuid, uuid, boolean, uuid, bigint),
  public.submit_drink_proof(uuid, uuid, text, uuid, bigint)
to authenticated;
