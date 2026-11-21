-- City pack: loaded by migration into PostGIS, readable by players, never writable by clients.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(19);

select is((select count(*)::int from public.city_packs where city = 'brisbane'), 1, 'Brisbane pack is loaded');
select ok((select count(*) from public.map_features where city = 'brisbane' and layer = 'venues') > 100,
  'Brisbane pack has venues');
select ok((select count(*) from public.map_features where city = 'brisbane' and layer = 'stations') > 20,
  'Brisbane pack has stations');
select ok((select count(*) from public.map_features where city = 'brisbane' and layer = 'abs:suburbs_localities') > 10,
  'Brisbane pack has suburbs');
select ok((select count(*) from public.map_features where city = 'brisbane' and layer = 'gtfs:lines'
           and props ->> 'mode' = 'rail') > 5,
  'Brisbane pack has rail lines');
select ok((select count(*) from public.map_features where city = 'brisbane' and layer = 'osm:water'
           and name = 'Brisbane River') > 0,
  'Brisbane pack has the river');

select is(
  (select count(*)::int from public.map_features f join public.city_packs p using (city)
   where f.city = 'brisbane' and not st_coveredby(f.geom, st_buffer(p.extent, 0.00001))),
  0, 'every feature lies inside the pack extent');

select is(
  (select count(*)::int from public.map_features where city = 'brisbane' and st_srid(geom) <> 4326),
  0, 'all geometry is WGS84');

-- Every option with a layer-shaped source has a layer in the pack (data-driven questions).
select is(
  array(
    select distinct o ->> 'source'
    from public.question_types q, jsonb_array_elements(q.options) o
    where q.city = 'brisbane' and o ? 'source'
      and not exists (select 1 from public.map_features f where f.city = 'brisbane' and f.layer = o ->> 'source')
    order by 1
  ),
  array[]::text[],
  'every Brisbane question source has a map layer'
);

-- The CBD play area contains Central station and bars.
select ok(
  exists (
    select 1 from public.map_features f, public.play_areas a
    where f.city = 'brisbane' and f.layer = 'stations' and f.name = 'Central station'
      and a.city = 'brisbane' and st_contains(st_geomfromgeojson(a.geojson -> 'features' -> 0 -> 'geometry'), f.geom)
  ),
  'Central station is inside the seeded play area'
);

-- Reloading replaces the pack rather than duplicating it.
select lives_ok(
  $$ select public._load_city_pack(jsonb_build_object(
       'type', 'FeatureCollection',
       'pack', jsonb_build_object('schema_version', 1, 'city', 'testville', 'label', 'Testville',
         'built_at', '2026-01-01T00:00:00Z',
         'extent', '{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,1],[0,0]]]}'::jsonb),
       'features', jsonb_build_array(jsonb_build_object('type', 'Feature', 'id', 'osm:node/1',
         'geometry', '{"type":"Point","coordinates":[0.5,0.5]}'::jsonb,
         'properties', '{"layer":"venues","name":"Test Bar","kind":"bar"}'::jsonb)))) $$,
  'loader accepts a pack'
);
select public._load_city_pack(jsonb_build_object(
  'type', 'FeatureCollection',
  'pack', jsonb_build_object('schema_version', 1, 'city', 'testville', 'label', 'Testville',
    'built_at', '2026-01-02T00:00:00Z',
    'extent', '{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,1],[0,0]]]}'::jsonb),
  'features', '[]'::jsonb));
select is((select count(*)::int from public.map_features where city = 'testville'), 0,
  'reloading a pack replaces its features');
select is((select jsonb_array_length(geojson -> 'features') from public.city_packs where city = 'testville'), 0,
  'reloading a pack refreshes its cached GeoJSON');
select ok((select geojson = public._build_city_pack_json('brisbane') from public.city_packs where city = 'brisbane'),
  'the cached Brisbane GeoJSON matches the tables');

insert into auth.users (id, email) values ('77777777-7777-7777-7777-777777777777', 'map@test.local');
select set_config('request.jwt.claims', '{"sub":"77777777-7777-7777-7777-777777777777","role":"authenticated"}', true);
set local role authenticated;

select is(
  (select jsonb_array_length(public.get_city_pack('brisbane', array['stations']) -> 'features')),
  (select count(*)::int from public.map_features where city = 'brisbane' and layer = 'stations'),
  'players can fetch a layer of the pack as GeoJSON'
);
select is(
  (select jsonb_array_length(public.get_city_pack('brisbane') -> 'features')),
  (select count(*)::int from public.map_features where city = 'brisbane'),
  'players can fetch the whole pack'
);
select throws_ok(
  $$ delete from public.map_features where city = 'brisbane' $$,
  '42501', null, 'clients cannot change map features'
);
select throws_ok(
  $$ select public._load_city_pack('{}'::jsonb) $$,
  '42501', null, 'clients cannot load packs'
);

reset role;
set local role anon;
select throws_ok(
  $$ select count(*) from public.map_features $$,
  '42501', null, 'signed-out (anon) requests cannot read map features'
);

select * from finish();
rollback;
