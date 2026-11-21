-- City pack cache: get_city_pack used to build the whole pack (8k+ features, ~3.4 MB) as JSON on
-- every call, which can pass the API's statement timeout on a small database. The client-facing
-- GeoJSON is now built once, when a pack is loaded, and stored on the pack's row.

alter table public.city_packs add column geojson jsonb;

-- The pack as one GeoJSON FeatureCollection, built from the tables.
create function public._build_city_pack_json(p_city text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'type', 'FeatureCollection',
    'pack', p.meta || jsonb_build_object(
      'city', p.city,
      'label', p.label,
      'built_at', p.built_at,
      'loaded_at', p.loaded_at,
      'extent', extensions.st_asgeojson(p.extent, 6)::jsonb
    ),
    'features', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'type', 'Feature',
          'id', f.feature_id,
          'geometry', extensions.st_asgeojson(f.geom, 6)::jsonb,
          'properties', f.props || jsonb_build_object('layer', f.layer, 'name', f.name)
        )
        order by f.layer, f.feature_id
      )
      from public.map_features f
      where f.city = p.city
    ), '[]'::jsonb)
  )
  from public.city_packs p
  where p.city = p_city;
$$;

-- Loader: as before, then refreshes the cache.
create or replace function public._load_city_pack(p_pack jsonb)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_meta jsonb := p_pack -> 'pack';
  v_city text := p_pack #>> '{pack,city}';
begin
  if p_pack ->> 'type' is distinct from 'FeatureCollection' or v_meta is null then
    raise exception 'invalid_city_pack' using errcode = 'P0001';
  end if;
  if (v_meta ->> 'schema_version')::int is distinct from 1 then
    raise exception 'unsupported_city_pack_version' using errcode = 'P0001';
  end if;

  insert into public.city_packs (city, label, built_at, extent, meta, loaded_at)
  values (
    v_city,
    v_meta ->> 'label',
    (v_meta ->> 'built_at')::timestamptz,
    extensions.st_setsrid(extensions.st_geomfromgeojson(v_meta -> 'extent'), 4326),
    v_meta - 'extent' - 'city' - 'label' - 'built_at',
    now()
  )
  on conflict (city) do update set
    label = excluded.label,
    built_at = excluded.built_at,
    extent = excluded.extent,
    meta = excluded.meta,
    loaded_at = excluded.loaded_at;

  delete from public.map_features where city = v_city;

  insert into public.map_features (city, layer, feature_id, name, geom, props)
  select
    v_city,
    f #>> '{properties,layer}',
    f ->> 'id',
    f #>> '{properties,name}',
    extensions.st_setsrid(extensions.st_geomfromgeojson(f -> 'geometry'), 4326),
    (f -> 'properties') - 'layer' - 'name'
  from jsonb_array_elements(p_pack -> 'features') as f;

  update public.city_packs set geojson = public._build_city_pack_json(v_city) where city = v_city;
end;
$$;

-- Whole pack (or some layers) from the cache. Security invoker: RLS on city_packs applies.
create or replace function public.get_city_pack(p_city text, p_layers text[] default null)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select case
    when p_layers is null then p.geojson
    else jsonb_set(p.geojson, '{features}', coalesce((
      select jsonb_agg(f order by i)
      from jsonb_array_elements(p.geojson -> 'features') with ordinality as t (f, i)
      where f #>> '{properties,layer}' = any (p_layers)
    ), '[]'::jsonb))
  end
  from public.city_packs p
  where p.city = p_city;
$$;

update public.city_packs set geojson = public._build_city_pack_json(city);

revoke execute on function public._build_city_pack_json(text) from public, anon, authenticated;
revoke execute on function public._load_city_pack(jsonb) from public, anon, authenticated;
