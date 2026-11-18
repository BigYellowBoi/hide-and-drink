-- A timed curse with a follow-on (params.followup_s, e.g. Curse of Escape: 3 minutes to get
-- out of the bar, else a 10 minute lock) is a task with a deadline. Seekers can now mark it
-- done like an until_cleared curse (clear_effect, hider confirms with confirm_clear) while
-- its countdown runs or before they start the lock; once cleared, start_followup refuses it
-- (effect_not_active). Plain timed curses (no follow-on) still just run out. Otherwise both
-- functions are as in 20261130090000_cards.sql.

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

  update public.card_effects set status = 'clear_requested', clear_requested_by = v_uid where id = v_e.id;

  v_seq := public._append_event(p_game_id, 'effect_clear_requested', jsonb_build_object(
    'round', v_game.round, 'effect_id', v_e.id, 'by', v_uid));

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq));
end;
$$;

create or replace function public.start_followup(
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
  if v_e.status <> 'active' then
    raise exception 'effect_not_active' using errcode = 'P0001';
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
