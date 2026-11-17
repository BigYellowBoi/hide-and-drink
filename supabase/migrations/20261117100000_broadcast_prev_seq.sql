-- Broadcasts now carry prev_seq: for each audience, the seq of the previous event that
-- audience can see. seq is contiguous per game across all visibilities, so a seeker
-- legitimately skips hider-only seqs. With prev_seq a client can tell a hidden event
-- (prev_seq matches what it has applied) from a missed one (it doesn't) without a fetch.
--
-- Audiences: "none" = player with no team yet (sees 'all' only), "hiders", "seekers".
-- Events are inserted under the game row lock, so these maxima are stable.

create or replace function public._broadcast_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prev jsonb;
begin
  select jsonb_build_object(
    'none',    coalesce(max(seq) filter (where visibility = 'all'), 0),
    'hiders',  coalesce(max(seq) filter (where visibility in ('all', 'hiders')), 0),
    'seekers', coalesce(max(seq) filter (where visibility in ('all', 'seekers')), 0)
  )
  into v_prev
  from public.events
  where game_id = new.game_id and seq < new.seq;

  perform realtime.send(
    jsonb_build_object(
      'game_id', new.game_id,
      'seq', new.seq,
      'prev_seq', v_prev,
      'type', new.type,
      'visibility', new.visibility,
      'actor_id', new.actor_id,
      'payload', new.payload,
      'created_at', new.created_at
    ),
    'event',
    public.topic_for(new.game_id, new.visibility),
    true
  );
  return null;
end;
$$;

-- create or replace keeps existing privileges, but restate the rule from the core migration.
revoke execute on function public._broadcast_event() from public, anon, authenticated;
