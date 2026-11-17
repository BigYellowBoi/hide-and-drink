-- City packs: map data built by pipeline/ (stations, venues, question layers, suburbs), in PostGIS.
--
-- One row per city in city_packs, one row per feature in map_features. A feature's layer is the
-- id from data/map-layers.json, which equals the `source` string question options use, so a
-- question finds its layer by id. Packs are pipeline-owned: loading a pack replaces every feature
-- for that city. Per-game venue curation will live in game state, not here.
-- Venues and stations are public to every player (seekers see remaining bars); nothing here is
-- hider-only.

create extension if not exists postgis with schema extensions;

create table public.city_packs (
  city text primary key check (city ~ '^[a-z0-9_]+$'),
  label text not null check (char_length(label) between 1 and 80),
  built_at timestamptz not null,
  extent extensions.geometry(Geometry, 4326) not null,
  meta jsonb not null default '{}'::jsonb check (jsonb_typeof(meta) = 'object'),
  loaded_at timestamptz not null default now()
);

create table public.map_features (
  city text not null references public.city_packs (city) on delete cascade,
  layer text not null check (char_length(layer) between 1 and 64),
  feature_id text not null check (char_length(feature_id) between 1 and 200),
  name text not null,
  geom extensions.geometry(Geometry, 4326) not null,
  props jsonb not null default '{}'::jsonb check (jsonb_typeof(props) = 'object'),
  primary key (city, layer, feature_id)
);

create index map_features_geom_idx on public.map_features using gist (geom);

alter table public.city_packs enable row level security;
alter table public.map_features enable row level security;

create policy "signed-in users read city packs" on public.city_packs
  for select to authenticated using (true);
create policy "signed-in users read map features" on public.map_features
  for select to authenticated using (true);

revoke all on public.city_packs, public.map_features from anon, authenticated;
grant select on public.city_packs, public.map_features to authenticated;

-- Loader, called only by generated migrations (pipeline/to_sql.py). Replaces the city's pack.
create function public._load_city_pack(p_pack jsonb)
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
end;
$$;

-- Whole pack (or some layers) as one GeoJSON FeatureCollection for the client.
-- Security invoker: RLS on the tables applies.
create function public.get_city_pack(p_city text, p_layers text[] default null)
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
      where f.city = p.city and (p_layers is null or f.layer = any (p_layers))
    ), '[]'::jsonb)
  )
  from public.city_packs p
  where p.city = p_city;
$$;

revoke execute on function public._load_city_pack(jsonb) from public, anon, authenticated;
revoke execute on function public.get_city_pack(text, text[]) from public, anon, authenticated;
grant execute on function public.get_city_pack(text, text[]) to authenticated;
