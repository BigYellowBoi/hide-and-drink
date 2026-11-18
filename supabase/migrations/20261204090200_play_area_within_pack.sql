-- save_play_area refuses areas that reach past the city pack's extent
-- (play_area_outside_map_data): outside it the map has no stations, venues or streets, which
-- is how a hand-drawn area once played with most of its stations missing. Same signature and
-- grants as before; otherwise unchanged from 20261123090000_save_play_area.sql.

create or replace function public.save_play_area(
  p_game_id uuid,
  p_client_action_id uuid,
  p_last_seen_seq bigint,
  p_name text,
  p_geojson jsonb,
  p_play_area_id uuid default null,
  p_source text default null
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
  v_name text := btrim(coalesce(p_name, ''));
  v_source text := nullif(left(btrim(coalesce(p_source, '')), 200), '');
  v_geom extensions.geometry;
  v_area_km2 numeric;
  v_geojson jsonb;
  v_area public.play_areas;
  v_seq bigint;
  v_extent extensions.geometry;
begin
  if v_prev is not null then
    return v_prev;
  end if;

  v_game := public._lock_game(p_game_id);

  if v_game.host_id <> v_uid then
    raise exception 'host_only' using errcode = 'P0001';
  end if;
  if v_game.status <> 'lobby' then
    raise exception 'play_area_locked' using errcode = 'P0001';
  end if;
  if char_length(v_name) not between 1 and 80 then
    raise exception 'invalid_play_area_name' using errcode = 'P0001';
  end if;

  v_geom := public._play_area_geom(p_geojson);
  if extensions.st_npoints(v_geom) > 5000 then
    raise exception 'play_area_too_detailed' using errcode = 'P0001';
  end if;
  v_area_km2 := round((extensions.st_area(v_geom::extensions.geography) / 1e6)::numeric, 1);
  if v_area_km2 < 0.1 then
    raise exception 'play_area_too_small' using errcode = 'P0001';
  end if;
  if v_area_km2 > 2000 then
    raise exception 'play_area_too_large' using errcode = 'P0001';
  end if;
  -- Stations, venues and streets exist only inside the city pack's extent; an area past it
  -- would play with missing data. Cities with no pack loaded yet are not checked.
  select extent into v_extent from public.city_packs where city = v_game.city;
  if v_extent is not null and not extensions.st_covers(v_extent, v_geom) then
    raise exception 'play_area_outside_map_data' using errcode = 'P0001';
  end if;

  if p_play_area_id is not null then
    select * into v_area from public.play_areas where id = p_play_area_id and city = v_game.city for update;
    if not found then
      raise exception 'play_area_not_found' using errcode = 'P0001';
    end if;
    if v_area.created_by is distinct from v_uid then
      raise exception 'play_area_not_yours' using errcode = 'P0001';
    end if;
  end if;
  if exists (select 1 from public.play_areas
             where city = v_game.city and name = v_name and id is distinct from p_play_area_id) then
    raise exception 'play_area_name_taken' using errcode = 'P0001';
  end if;

  perform public._require_fresh(p_game_id, v_uid, p_last_seen_seq);

  v_geojson := jsonb_build_object(
    'type', 'FeatureCollection',
    'features', jsonb_build_array(jsonb_build_object(
      'type', 'Feature',
      'properties', jsonb_strip_nulls(jsonb_build_object('name', v_name, 'area_km2', v_area_km2, 'source', v_source)),
      'geometry', extensions.st_asgeojson(v_geom, 6)::jsonb
    ))
  );

  if p_play_area_id is null then
    insert into public.play_areas (name, city, geojson, created_by)
    values (v_name, v_game.city, v_geojson, v_uid)
    returning * into v_area;
  else
    update public.play_areas set name = v_name, geojson = v_geojson
     where id = p_play_area_id
    returning * into v_area;
  end if;

  update public.games set play_area_id = v_area.id where id = p_game_id;

  v_seq := public._append_event(p_game_id, 'play_area_changed',
    jsonb_build_object('play_area_id', v_area.id, 'name', v_area.name, 'saved', true));

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq, 'play_area_id', v_area.id,
      'area_km2', v_area_km2));
end;
$$;

revoke execute on function public.save_play_area(uuid, uuid, bigint, text, jsonb, uuid, text)
  from public, anon, authenticated;
grant execute on function public.save_play_area(uuid, uuid, bigint, text, jsonb, uuid, text) to authenticated;
