-- Card proofs, keeping a just-drawn card out of the hand, and live bar picking for hider teams.
--
-- 1. Per-card photo proof (params.proof = 'photo'):
--    * A curse the seekers clear (until_cleared, or timed with a follow-on) opens an evidence
--      proof for the seekers when it is played: a drink_proofs row with kind 'evidence' and the
--      effect it belongs to, and a public proof_due event. The seekers upload the photo with
--      submit_drink_proof (same bucket and policies as drink photos); clear_effect refuses
--      proof_needed until it is sent. If the hider answers "not yet" (confirm_clear false),
--      the proof reopens for a new photo.
--    * A card's params.drinks open drink proofs only when the card asks for a photo (e.g.
--      Cheers). Cast costs, vetoes and missed deadlines are unchanged (config
--      photo_proof_for_drinks).
--    The library turns photo proof on for the seeker curses that need evidence and for Cheers.
--
-- 2. keep_cards: the cards to discard may include cards kept from this draw, so a hider with a
--    full hand can throw away the card just drawn. Kept cards that are also discarded go
--    straight to the discard pile; cards_kept.kept lists only cards that reach the hand.
--
-- 3. report_picking (hiders): which bar this hider has selected in the picker while the team
--    has no bar (or is moving). Ephemeral, latest-wins, not in the event log: broadcast as
--    'picking' on the hiders' topic only, never to seekers. choose_bar stays first to lock in.

-- ---------------------------------------------------------------------------
-- Evidence proofs
-- ---------------------------------------------------------------------------

alter table public.drink_proofs
  add column kind text not null default 'drink' check (kind in ('drink', 'evidence')),
  add column effect_id uuid references public.card_effects (id) on delete cascade,
  alter column cost drop not null;
alter table public.drink_proofs drop constraint drink_proofs_cost_check;
alter table public.drink_proofs add constraint drink_proofs_cost_check
  check (case kind when 'drink' then cost in ('drink', 'shot') else cost is null and effect_id is not null end);
create unique index drink_proofs_effect_idx on public.drink_proofs (effect_id) where effect_id is not null;

-- Open the evidence proof for a curse's effect and tell everyone.
create function public._evidence_due(p_game public.games, p_effect public.card_effects, p_label text)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.drink_proofs (game_id, round, team, cost, label, kind, effect_id)
  values (p_game.id, p_game.round, 'seekers', null, p_label, 'evidence', p_effect.id)
  returning id into v_id;
  perform public._append_event(p_game.id, 'proof_due', jsonb_build_object(
    'round', p_game.round, 'proof_id', v_id, 'team', 'seekers', 'label', p_label, 'effect_id', p_effect.id), 'all', null);
  return v_id;
end;
$$;

-- play_card: as in 20261203090000_cast_cost_payer.sql, plus the evidence proof, and
-- params.drinks proofs only for cards with params.proof = 'photo'.
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

-- clear_effect: as in 20261204090000_clear_timed_tasks.sql, plus the evidence check.
create or replace function public.clear_effect(
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
  if v_e.status <> 'active'
     or not (v_e.behaviour = 'until_cleared'
             or (v_e.behaviour = 'timed' and v_e.followup_s is not null and v_e.followup_ends_at is null)) then
    raise exception 'effect_not_active' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.drink_proofs where effect_id = v_e.id and proved_at is null) then
    raise exception 'proof_needed' using errcode = 'P0001';
  end if;

  update public.card_effects set status = 'clear_requested', clear_requested_by = v_uid where id = v_e.id;

  v_seq := public._append_event(p_game_id, 'effect_clear_requested', jsonb_build_object(
    'round', v_game.round, 'effect_id', v_e.id, 'by', v_uid));

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq));
end;
$$;

-- confirm_clear: as in 20261130090000_cards.sql; "not yet" reopens the effect's evidence proof.
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
    update public.drink_proofs set photo_path = null, proved_by = null, proved_at = null where effect_id = v_e.id;
    v_seq := public._append_event(p_game_id, 'effect_clear_rejected', jsonb_build_object(
      'round', v_game.round, 'effect_id', v_e.id));
  end if;

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq));
end;
$$;

-- ---------------------------------------------------------------------------
-- keep_cards: as in 20261130090000_cards.sql, discards may include this draw's kept cards
-- ---------------------------------------------------------------------------

create or replace function public.keep_cards(
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
  v_to_hand uuid[];
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
  -- Each discard is a hand card or one of the cards kept from this draw.
  if (select count(distinct d) from unnest(v_discard) d) <> cardinality(v_discard)
     or (select count(*) from public.card_instances
          where game_id = p_game_id and round = v_game.round and id = any (v_discard)
            and (location = 'hand' or id = any (v_keep)))
        <> cardinality(v_discard) then
    raise exception 'card_not_in_hand' using errcode = 'P0001';
  end if;
  v_to_hand := array(select k from unnest(v_keep) k where not k = any (v_discard));

  select count(*) into v_hand from public.card_instances
   where game_id = p_game_id and round = v_game.round and location = 'hand' and not id = any (v_discard);
  if v_hand + cardinality(v_to_hand) > public._hand_limit(v_game.config) then
    raise exception 'hand_full' using errcode = 'P0001',
      detail = format('hand limit %s', public._hand_limit(v_game.config));
  end if;

  select coalesce(jsonb_agg(id order by pile_pos), '[]') into v_dropped from public.card_instances
   where (draw_id = v_draw.id and location = 'drawn' and not id = any (v_to_hand)) or id = any (v_discard);

  update public.card_instances set location = 'hand' where id = any (v_to_hand);
  update public.card_instances set location = 'discarded'
   where (draw_id = v_draw.id and location = 'drawn') or id = any (v_discard);
  update public.card_draws set kept_at = now() where id = v_draw.id;

  v_seq := public._append_event(p_game_id, 'cards_kept', jsonb_build_object(
    'round', v_game.round,
    'draw_id', v_draw.id,
    'kept', to_jsonb(v_to_hand),
    'discarded', v_dropped
  ), 'hiders');

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq));
end;
$$;

-- ---------------------------------------------------------------------------
-- report_picking (hiders, ephemeral)
-- ---------------------------------------------------------------------------

create function public.report_picking(p_game_id uuid, p_venue_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public._require_user();
  v_game public.games;
  v_name text;
begin
  select * into v_game from public.games where id = p_game_id;
  if not found then
    raise exception 'game_not_found' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.players where game_id = p_game_id and user_id = v_uid and team = 'hiders') then
    raise exception 'hiders_only' using errcode = 'P0001';
  end if;
  if v_game.status not in ('hiding', 'seeking') then
    raise exception 'round_not_running' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.hider_bars where game_id = p_game_id and round = v_game.round and not move_pending) then
    raise exception 'bar_already_chosen' using errcode = 'P0001';
  end if;
  if p_venue_id is not null then
    select b.name into v_name from public._valid_bars(v_game) b where b.feature_id = p_venue_id;
    if not found then
      raise exception 'venue_not_found' using errcode = 'P0001';
    end if;
  end if;

  -- Hiders' topic only. Not an event: no seq, nothing in the log.
  perform realtime.send(jsonb_build_object('game_id', p_game_id, 'user_id', v_uid, 'round', v_game.round,
    'venue_id', p_venue_id, 'name', v_name, 'at', now()), 'picking', public.topic_for(p_game_id, 'hiders'), true);

  return jsonb_build_object('ok', true, 'at', now());
end;
$$;

-- ---------------------------------------------------------------------------
-- Library: photo proof for the curses that need evidence, and for Cheers
-- ---------------------------------------------------------------------------

update public.cards set params = params || '{"proof":"photo"}'::jsonb, updated_at = now()
 where id in ('cheers', 'distant_cuisine', 'bridge', 'pokies', 'clash', 'hammered', 'quan', 'louis', 'cruz')
   and not params ? 'proof';
update public.cards set params = params || '{"proof":"video"}'::jsonb, updated_at = now()
 where id = 'sculling' and not params ? 'proof';

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke execute on function
  public._evidence_due(public.games, public.card_effects, text),
  public.play_card(uuid, uuid, uuid, bigint, jsonb),
  public.clear_effect(uuid, uuid, uuid, bigint),
  public.confirm_clear(uuid, uuid, boolean, uuid, bigint),
  public.keep_cards(uuid, uuid, uuid[], uuid[], uuid, bigint),
  public.report_picking(uuid, text)
from public, anon, authenticated;

grant execute on function
  public.play_card(uuid, uuid, uuid, bigint, jsonb),
  public.clear_effect(uuid, uuid, uuid, bigint),
  public.confirm_clear(uuid, uuid, boolean, uuid, bigint),
  public.keep_cards(uuid, uuid, uuid[], uuid[], uuid, bigint),
  public.report_picking(uuid, text)
to authenticated;
