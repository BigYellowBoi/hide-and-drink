-- Saved play areas: show who made each one, and let players delete clutter (test maps).
--
-- creator_name is the creator's player name when they saved it (players are per game, so
-- the name is copied onto the area). Filled by a trigger so save_play_area stays as is.
--
-- delete_play_area: any signed-in player may delete a player-made area (the group shares
-- one list, and the point is cleaning up anyone's test maps). Built-in areas (seeded, no
-- creator) can't be deleted, nor can an area an open lobby has chosen. Started games keep
-- their own snapshot of the polygon, so deleting never changes a game in progress.
-- Not a game action: no game, no event; idempotent through client_action_id.

alter table public.play_areas
  add column creator_name text check (creator_name is null or char_length(creator_name) between 1 and 80);

update public.play_areas a
   set creator_name = (select p.name from public.players p
                        where p.user_id = a.created_by order by p.joined_at desc limit 1)
 where a.created_by is not null;

create function public._play_area_creator_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.created_by is not null and new.creator_name is null then
    -- Latest game they joined: the lobby they're saving from.
    select p.name into new.creator_name from public.players p
     where p.user_id = new.created_by order by p.joined_at desc limit 1;
  end if;
  return new;
end;
$$;

create trigger play_areas_creator_name
before insert on public.play_areas
for each row execute function public._play_area_creator_name();

create function public.delete_play_area(
  p_play_area_id uuid,
  p_client_action_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public._require_user();
  v_prev jsonb := public._previous_result(p_client_action_id, v_uid);
  v_area public.play_areas;
begin
  if v_prev is not null then
    return v_prev;
  end if;

  select * into v_area from public.play_areas where id = p_play_area_id for update;
  if not found then
    raise exception 'play_area_not_found' using errcode = 'P0001';
  end if;
  if v_area.created_by is null then
    raise exception 'play_area_protected' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.games where play_area_id = p_play_area_id and status = 'lobby') then
    raise exception 'play_area_in_use' using errcode = 'P0001';
  end if;

  delete from public.play_areas where id = p_play_area_id;

  return public._record_result(p_client_action_id, v_uid, null,
    jsonb_build_object('play_area_id', p_play_area_id, 'name', v_area.name));
end;
$$;

revoke execute on function public._play_area_creator_name() from public, anon, authenticated;
revoke execute on function public.delete_play_area(uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_play_area(uuid, uuid) to authenticated;
