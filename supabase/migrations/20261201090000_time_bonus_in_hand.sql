-- Time bonuses are not played: they count for the hider only while held in the hand at the
-- end of the round (official rules). play_card now refuses them with card_not_playable;
-- everything else is as in 20261130090000_cards.sql. The hider's phone shows the bonus in
-- hand next to the main clock (hand is hider-only, so seekers never see it).

create or replace function public.play_card(
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
      -- Time bonuses only count while held in the hand at the end of the round.
      raise exception 'card_not_playable' using errcode = 'P0001';
    else
      raise exception 'card_behaviour_not_supported' using errcode = 'P0001';
  end case;

  update public.card_instances set location = 'played' where id = v_inst.id;

  v_seq := public._append_event(p_game_id, 'card_played', v_payload);

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq, 'effect_id', v_effect.id));
end;
$$;

revoke execute on function public.play_card(uuid, uuid, uuid, bigint) from public, anon, authenticated;
grant execute on function public.play_card(uuid, uuid, uuid, bigint) to authenticated;
