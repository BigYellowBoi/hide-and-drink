-- The hiding spot is always a bar; stations are only transport. Drop the optional station
-- zone (bars within a radius of a station) carried over from the original game: choose_bar
-- and hiding_bars now accept every venue inside the play area snapshot, whatever the config.

create or replace function public._valid_bars(p_game public.games)
returns setof public.map_features
language plpgsql
stable
set search_path = ''
as $$
declare
  v_area extensions.geometry;
begin
  if p_game.play_area_snapshot is null then
    return;
  end if;
  -- Force the SRID: on some PostGIS versions the repaired union comes back with SRID 0.
  v_area := extensions.st_setsrid(public._play_area_geom(p_game.play_area_snapshot), 4326);
  return query
    select f.* from public.map_features f
     where f.city = p_game.city and f.layer = 'venues'
       and extensions.st_covers(v_area, f.geom);
end;
$$;

revoke execute on function public._valid_bars(public.games) from public, anon, authenticated;
