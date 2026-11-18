-- Undoing a host fix needs both teams to agree.
--
--   * Any player on a team asks (host_override kind 'undo', params.override_id, a reason).
--     That files a public override_requested (kind undo) and counts as their team's yes.
--   * A player on the other team agrees with host_override(p_kind 'confirm', p_request_id), or
--     either team says no (p_kind 'decline'). Each agreement logs override_confirmed.
--   * Once one hider and one seeker have agreed, the undo runs as before (rows restored,
--     undo_conflict if they changed since, override_undone, public override event).
--
-- host_override itself becomes a thin front: undo requests and their votes are handled here,
-- everything else goes to the original function, renamed _host_override_core.

-- Renamed from 20261214090000_undo_both_teams.sql: that version was already taken by
-- 20261214090000_playtest_tools_curse_cost.sql, so Supabase refused to apply it. Guarded so it
-- also runs cleanly on a database where the old copy did get applied.
alter table public.override_requests add column if not exists confirmed_hiders uuid;
alter table public.override_requests add column if not exists confirmed_seekers uuid;

do $do$
begin
  if to_regprocedure('public._host_override_core(uuid, text, jsonb, text, uuid, bigint, uuid)') is null then
    alter function public.host_override(uuid, text, jsonb, text, uuid, bigint, uuid) rename to _host_override_core;
  end if;
end;
$do$;
revoke execute on function public._host_override_core(uuid, text, jsonb, text, uuid, bigint, uuid)
  from public, anon, authenticated;

-- Ask to undo a fix. Counts as the asker's team agreeing.
create or replace function public._override_undo_request(
  p_game_id uuid,
  p_params jsonb,
  p_reason text,
  p_client_action_id uuid,
  p_last_seen_seq bigint
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_uid uuid := public._require_user();
  v_prev jsonb := public._previous_result(p_client_action_id, v_uid);
  v_game public.games;
  v_me public.players;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_target public.game_overrides;
  v_req public.override_requests;
  v_seq bigint;
begin
  if v_prev is not null then
    return v_prev;
  end if;

  v_game := public._lock_game(p_game_id);
  select * into v_me from public.players where game_id = p_game_id and user_id = v_uid;
  if not found or v_me.team is null then
    raise exception 'not_a_player' using errcode = 'P0001';
  end if;
  if v_game.status = 'ended' then
    raise exception 'game_ended' using errcode = 'P0001';
  end if;
  if v_game.status not in ('hiding', 'seeking') then
    raise exception 'round_not_running' using errcode = 'P0001';
  end if;
  if char_length(v_reason) not between 1 and 120 then
    raise exception 'invalid_reason' using errcode = 'P0001';
  end if;
  perform public._require_fresh(p_game_id, v_uid, p_last_seen_seq);

  select * into v_target from public.game_overrides
   where id = public._param_uuid(coalesce(p_params, '{}'::jsonb), 'override_id') and game_id = p_game_id;
  if not found then
    raise exception 'override_not_found' using errcode = 'P0001';
  end if;
  if v_target.undone_by is not null then
    raise exception 'already_undone' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.override_requests
              where game_id = p_game_id and kind = 'undo' and resolved_at is null
                and params ->> 'override_id' = v_target.id::text) then
    raise exception 'undo_already_requested' using errcode = 'P0001';
  end if;

  insert into public.override_requests (game_id, round, kind, params, reason, requested_by, confirmed_hiders, confirmed_seekers)
  values (p_game_id, v_game.round, 'undo', jsonb_build_object('override_id', v_target.id), v_reason, v_uid,
          case when v_me.team = 'hiders' then v_uid end, case when v_me.team = 'seekers' then v_uid end)
  returning * into v_req;

  v_seq := public._append_event(p_game_id, 'override_requested', jsonb_build_object(
    'request_id', v_req.id, 'kind', 'undo', 'reason', v_reason, 'by', v_uid, 'team', v_me.team,
    'params', v_req.params, 'summary', 'Undo: ' || coalesce(v_target.summary, v_target.kind)));

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq, 'request_id', v_req.id, 'pending', true));
end;
$$;

-- Agree to (or turn down) an undo. When both teams have agreed, the undo runs.
create or replace function public._override_undo_vote(
  p_game_id uuid,
  p_request_id uuid,
  p_kind text,
  p_client_action_id uuid,
  p_last_seen_seq bigint
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_uid uuid := public._require_user();
  v_prev jsonb := public._previous_result(p_client_action_id, v_uid);
  v_game public.games;
  v_me public.players;
  v_req public.override_requests;
  v_target public.game_overrides;
  v_oid uuid := gen_random_uuid();
  v_summary text;
  v_seq bigint;
begin
  if v_prev is not null then
    return v_prev;
  end if;

  v_game := public._lock_game(p_game_id);
  select * into v_me from public.players where game_id = p_game_id and user_id = v_uid;
  if not found or v_me.team is null then
    raise exception 'not_a_player' using errcode = 'P0001';
  end if;
  select * into v_req from public.override_requests
   where id = p_request_id and game_id = p_game_id and kind = 'undo' for update;
  if not found or v_req.resolved_at is not null then
    raise exception 'request_not_open' using errcode = 'P0001';
  end if;
  if p_kind not in ('confirm', 'decline') then
    raise exception 'invalid_override' using errcode = 'P0001', detail = 'confirm or decline';
  end if;
  if v_game.status not in ('hiding', 'seeking') then
    raise exception 'round_not_running' using errcode = 'P0001';
  end if;
  perform public._require_fresh(p_game_id, v_uid, p_last_seen_seq);

  if p_kind = 'decline' then
    update public.override_requests set resolved_at = now(), resolution = 'declined' where id = v_req.id;
    v_seq := public._append_event(p_game_id, 'override_declined', jsonb_build_object(
      'request_id', v_req.id, 'kind', 'undo', 'by', v_uid, 'team', v_me.team));
    return public._record_result(p_client_action_id, v_uid, p_game_id,
      jsonb_build_object('game_id', p_game_id, 'seq', v_seq));
  end if;

  if (v_me.team = 'hiders' and v_req.confirmed_hiders is not null)
     or (v_me.team = 'seekers' and v_req.confirmed_seekers is not null) then
    raise exception 'already_confirmed' using errcode = 'P0001';
  end if;
  update public.override_requests
     set confirmed_hiders = case when v_me.team = 'hiders' then v_uid else confirmed_hiders end,
         confirmed_seekers = case when v_me.team = 'seekers' then v_uid else confirmed_seekers end
   where id = v_req.id
  returning * into v_req;
  v_seq := public._append_event(p_game_id, 'override_confirmed', jsonb_build_object(
    'request_id', v_req.id, 'by', v_uid, 'team', v_me.team));

  if v_req.confirmed_hiders is null or v_req.confirmed_seekers is null then
    return public._record_result(p_client_action_id, v_uid, p_game_id,
      jsonb_build_object('game_id', p_game_id, 'seq', v_seq, 'pending', true));
  end if;

  -- Both teams agree: undo.
  select * into v_target from public.game_overrides
   where id = (v_req.params ->> 'override_id')::uuid and game_id = p_game_id for update;
  if not found then
    raise exception 'override_not_found' using errcode = 'P0001';
  end if;
  if v_target.undone_by is not null then
    raise exception 'already_undone' using errcode = 'P0001';
  end if;

  insert into public.game_overrides (id, game_id, round, kind, params, reason, private, by_user, request_id)
  values (v_oid, p_game_id, v_game.round, 'undo', v_req.params, v_req.reason, v_target.private, v_req.requested_by, v_req.id);
  perform set_config('hd.override_id', v_oid::text, true);
  perform public._undo_override(v_target.id);
  update public.game_overrides set undone_by = v_oid where id = v_target.id;
  if v_target.kind = 'undo' then
    update public.game_overrides set undone_by = null
     where id = public._param_uuid(v_target.params, 'override_id');
  end if;
  perform public._append_event(p_game_id, 'override_undone', jsonb_build_object('target_id', v_target.id));
  perform set_config('hd.override_id', '', true);
  perform public._settle_timers(p_game_id);

  v_summary := 'Undid: ' || coalesce(v_target.summary, v_target.kind);
  update public.game_overrides set summary = v_summary where id = v_oid;
  update public.override_requests set resolved_at = now(), resolution = 'approved', override_id = v_oid where id = v_req.id;

  v_seq := public._append_event(p_game_id, 'override', jsonb_build_object(
    'override_id', v_oid,
    'kind', 'undo',
    'reason', v_req.reason,
    'by', v_req.requested_by,
    'summary', v_summary,
    'private', v_target.private,
    'request_id', v_req.id,
    'target_id', v_target.id,
    'confirmed_by', jsonb_build_object('hiders', v_req.confirmed_hiders, 'seekers', v_req.confirmed_seekers),
    'params', jsonb_build_object('override_id', v_target.id)));

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq, 'override_id', v_oid));
end;
$$;

create or replace function public.host_override(
  p_game_id uuid,
  p_kind text,
  p_params jsonb,
  p_reason text,
  p_client_action_id uuid,
  p_last_seen_seq bigint,
  p_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_request_id is not null then
    if exists (select 1 from public.override_requests where id = p_request_id and game_id = p_game_id and kind = 'undo') then
      return public._override_undo_vote(p_game_id, p_request_id, p_kind, p_client_action_id, p_last_seen_seq);
    end if;
  elsif p_kind = 'undo' then
    return public._override_undo_request(p_game_id, p_params, p_reason, p_client_action_id, p_last_seen_seq);
  end if;
  return public._host_override_core(p_game_id, p_kind, p_params, p_reason, p_client_action_id, p_last_seen_seq, p_request_id);
end;
$$;

revoke execute on function
  public._override_undo_request(uuid, jsonb, text, uuid, bigint),
  public._override_undo_vote(uuid, uuid, text, uuid, bigint),
  public.host_override(uuid, text, jsonb, text, uuid, bigint, uuid)
from public, anon, authenticated;

grant execute on function public.host_override(uuid, text, jsonb, text, uuid, bigint, uuid) to authenticated;
