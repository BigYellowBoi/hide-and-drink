-- Host undo: the host takes back the latest question action of the running round.
--
-- * undo_last_action (host only, round running): undoes the latest public event of the game
--   that has not been undone yet, if it is one of
--     question_asked        -> the question is removed (only while it is still unanswered)
--     question_answered     -> the question is pending again (same deadline; a missed deadline
--                              that was already logged stays logged), reward modifiers are
--                              unused again and an unkept reward draw goes back on the pile
--                              in its order. Refused with cards_already_kept once the hiders
--                              kept cards from it
--     question_shading_set  -> the question's manual shading goes back to what it was before
--   Anything else as the latest public event (a card played, a missed deadline, ...) is
--   refused with cannot_undo; nothing left is nothing_to_undo. seeking_started (the server
--   logging the end of the hiding period) is passed over: it depends on no action. Calling it again undoes the
--   action before, so several steps can be taken back in order.
-- * Events stay append-only: an undo appends action_undone {seq, type, question_id, by}
--   (public) naming the undone event, plus a hider-only action_undone for the reward draw's
--   cards_drawn event. Every phone drops events named by an action_undone before deriving
--   state (src/play/undo.ts), so the undo shows up everywhere at once.

-- Seqs of this game's events that were undone.
create function public._undone_seqs(p_game_id uuid)
returns bigint[]
language sql
stable
set search_path = ''
as $$
  select coalesce(array_agg((payload ->> 'seq')::bigint), '{}')
    from public.events
   where game_id = p_game_id and type = 'action_undone';
$$;

create function public.undo_last_action(
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
  v_undone bigint[];
  v_ev public.events;
  v_q public.questions;
  v_qid uuid;
  v_draw public.card_draws;
  v_drawn_seq bigint;
  v_shading jsonb;
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

  v_undone := public._undone_seqs(p_game_id);
  select * into v_ev from public.events
   where game_id = p_game_id and visibility = 'all' and type not in ('action_undone', 'seeking_started')
     and not (seq = any (v_undone))
   order by seq desc limit 1;
  if not found or v_ev.type = 'game_started' then
    raise exception 'nothing_to_undo' using errcode = 'P0001';
  end if;
  if v_ev.type not in ('question_asked', 'question_answered', 'question_shading_set') then
    raise exception 'cannot_undo' using errcode = 'P0001';
  end if;

  v_qid := (v_ev.payload ->> 'question_id')::uuid;
  select * into v_q from public.questions
   where id = v_qid and game_id = p_game_id and round = v_game.round for update;
  if not found then
    -- From an earlier round.
    raise exception 'cannot_undo' using errcode = 'P0001';
  end if;

  if v_ev.type = 'question_asked' then
    if v_q.answered_at is not null then
      raise exception 'cannot_undo' using errcode = 'P0001';
    end if;
    delete from public.questions where id = v_q.id;

  elsif v_ev.type = 'question_answered' then
    select * into v_draw from public.card_draws
     where game_id = p_game_id and round = v_game.round and question_id = v_q.id
     order by created_at desc limit 1 for update;
    if found and v_draw.kept_at is not null then
      raise exception 'cards_already_kept' using errcode = 'P0001';
    end if;
    if exists (select 1 from public.questions
                where game_id = p_game_id and answered_at is null and id <> v_q.id) then
      raise exception 'question_pending' using errcode = 'P0001';
    end if;

    update public.questions
       set answer = null, answered_by = null, answered_at = null, late = null, manual_shading = null
     where id = v_q.id;
    update public.card_modifiers set used_question_id = null, used_at = null
     where game_id = p_game_id and used_question_id = v_q.id;

    if v_draw.id is not null then
      -- Back on top of the pile: pile_pos never changed, and draws take the lowest first.
      update public.card_instances set location = 'pile', draw_id = null
       where draw_id = v_draw.id and location = 'drawn';
      select seq into v_drawn_seq from public.events
       where game_id = p_game_id and type = 'cards_drawn' and payload ->> 'draw_id' = v_draw.id::text
       order by seq desc limit 1;
      delete from public.card_draws where id = v_draw.id;
    end if;

  else
    select e.payload -> 'shading' into v_shading from public.events e
     where e.game_id = p_game_id and e.type = 'question_shading_set'
       and e.payload ->> 'question_id' = v_q.id::text
       and e.seq < v_ev.seq and not (e.seq = any (v_undone))
     order by e.seq desc limit 1;
    update public.questions
       set manual_shading = case when jsonb_typeof(v_shading) = 'object' then v_shading end
     where id = v_q.id;
  end if;

  v_seq := public._append_event(p_game_id, 'action_undone', jsonb_build_object(
    'seq', v_ev.seq,
    'type', v_ev.type,
    'question_id', v_q.id,
    'question_type', v_q.type,
    'by', v_uid));
  if v_drawn_seq is not null then
    v_seq := public._append_event(p_game_id, 'action_undone', jsonb_build_object(
      'seq', v_drawn_seq, 'type', 'cards_drawn', 'question_id', v_q.id), 'hiders');
  end if;

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq, 'undone_seq', v_ev.seq, 'undone_type', v_ev.type));
end;
$$;

revoke execute on function public._undone_seqs(uuid) from public, anon, authenticated;
revoke execute on function public.undo_last_action(uuid, uuid, bigint) from public, anon, authenticated;
grant execute on function public.undo_last_action(uuid, uuid, bigint) to authenticated;
