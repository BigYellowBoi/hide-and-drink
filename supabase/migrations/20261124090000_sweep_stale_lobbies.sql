-- Clean up abandoned lobbies. A game that never started and has had no activity
-- (no events) for 24 hours is deleted, with its players, events and stored action
-- results (all cascade). Started games are kept for history. Saved play areas are
-- separate rows and are never touched. Deleting also frees the join code.
--
-- There is no scheduler on the free plan, so the sweep runs whenever a new game is
-- created: that's exactly when test lobbies pile up, and it keeps the table small.

create function public._sweep_stale_lobbies()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.games g
  where g.status = 'lobby'
    and greatest(
          g.created_at,
          coalesce((select e.created_at from public.events e
                    where e.game_id = g.id and e.seq = g.last_seq), g.created_at)
        ) < now() - interval '24 hours';
  return null;
end;
$$;

revoke execute on function public._sweep_stale_lobbies() from public, anon, authenticated;

create trigger games_sweep_stale_lobbies
after insert on public.games
for each statement execute function public._sweep_stale_lobbies();
