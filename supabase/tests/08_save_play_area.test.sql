-- Host saves a drawn/imported play area: validated, normalised, chosen for the game.
-- Players: H = host, A = player.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(17);

insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');

-- About 1 km x 1.1 km in the CBD, as a bare Feature with an extra hole-less polygon.
select set_config('test.square', '{"type":"Feature","properties":{},"geometry":{"type":"Polygon","coordinates":[[[153.02,-27.47],[153.03,-27.47],[153.03,-27.46],[153.02,-27.46],[153.02,-27.47]]]}}', true);
-- Self-intersecting bow tie: repaired, not refused.
select set_config('test.bowtie', '{"type":"Polygon","coordinates":[[[153.0,-27.5],[153.02,-27.48],[153.02,-27.5],[153.0,-27.48],[153.0,-27.5]]]}', true);

select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
set local role authenticated;
select set_config('test.game_id',
  public.create_game('Host', 'dddddddd-0000-0000-0000-000000000001', 'brisbane') ->> 'game_id', true);
select set_config('test.code', (select code from public.games where id = current_setting('test.game_id')::uuid), true);

select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
set local role authenticated;
select public.join_game(current_setting('test.code'), 'Amy', 'dddddddd-0000-0000-0000-000000000002');

create temp view seq as select last_seq from public.games where id = current_setting('test.game_id')::uuid;
grant select on seq to authenticated;

select throws_ok(
  $$ select public.save_play_area(current_setting('test.game_id')::uuid, 'dddddddd-0000-0000-0000-000000000010',
       (select last_seq from seq), 'Amy area', current_setting('test.square')::jsonb) $$,
  'P0001', 'host_only', 'only the host can save a play area'
);

select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
set local role authenticated;

select throws_ok(
  $$ select public.save_play_area(current_setting('test.game_id')::uuid, 'dddddddd-0000-0000-0000-000000000011',
       (select last_seq from seq), 'Points', '{"type":"Point","coordinates":[153,-27]}') $$,
  'P0001', 'invalid_play_area', 'non-polygon GeoJSON is refused'
);
select throws_ok(
  $$ select public.save_play_area(current_setting('test.game_id')::uuid, 'dddddddd-0000-0000-0000-000000000012',
       (select last_seq from seq), 'Tiny',
       '{"type":"Polygon","coordinates":[[[153.02,-27.47],[153.021,-27.47],[153.021,-27.469],[153.02,-27.47]]]}') $$,
  'P0001', 'play_area_too_small', 'a tiny area is refused'
);
-- The Gold Coast: no Brisbane map data there.
select throws_ok(
  $$ select public.save_play_area(current_setting('test.game_id')::uuid, 'dddddddd-0000-0000-0000-000000000019',
       (select last_seq from seq), 'Gold Coast',
       '{"type":"Polygon","coordinates":[[[153.40,-28.00],[153.43,-28.00],[153.43,-27.97],[153.40,-27.97],[153.40,-28.00]]]}') $$,
  'P0001', 'play_area_outside_map_data', 'an area past the city pack is refused'
);
select throws_ok(
  $$ select public.save_play_area(current_setting('test.game_id')::uuid, 'dddddddd-0000-0000-0000-000000000013',
       (select last_seq from seq), '  ', current_setting('test.square')::jsonb) $$,
  'P0001', 'invalid_play_area_name', 'a blank name is refused'
);
select throws_ok(
  $$ select public.save_play_area(current_setting('test.game_id')::uuid, 'dddddddd-0000-0000-0000-000000000014',
       (select last_seq from seq), 'Brisbane inner (AMB 2026 game 1)', current_setting('test.square')::jsonb) $$,
  'P0001', 'play_area_name_taken', 'names are unique per city'
);
select throws_ok(
  $$ select public.save_play_area(current_setting('test.game_id')::uuid, 'dddddddd-0000-0000-0000-000000000015',
       (select last_seq from seq), 'x', '{}') $$,
  'P0001', 'invalid_play_area', 'an empty object is refused'
);
select throws_ok(
  $$ select public.save_play_area(current_setting('test.game_id')::uuid, 'dddddddd-0000-0000-0000-000000000016',
       0, 'Stale', current_setting('test.square')::jsonb) $$,
  'P0001', 'stale_state', 'saving needs an up-to-date view'
);
select throws_ok(
  $$ select public.save_play_area(current_setting('test.game_id')::uuid, 'dddddddd-0000-0000-0000-000000000017',
       (select last_seq from seq), 'Edit seeded', current_setting('test.square')::jsonb,
       (select id from public.play_areas where city = 'brisbane' and created_by is null limit 1)) $$,
  'P0001', 'play_area_not_yours', 'seeded areas cannot be overwritten'
);

-- ---------------------------------------------------------------- save new

select set_config('test.saved', public.save_play_area(current_setting('test.game_id')::uuid,
  'dddddddd-0000-0000-0000-000000000020', (select last_seq from seq), ' CBD square ',
  current_setting('test.square')::jsonb, null, 'drawn') ->> 'play_area_id', true);

select is((select name from public.play_areas where id = current_setting('test.saved')::uuid), 'CBD square',
  'saved with a trimmed name');
select is(
  (select geojson #> '{features,0,properties}' from public.play_areas where id = current_setting('test.saved')::uuid),
  '{"name":"CBD square","area_km2":1.1,"source":"drawn"}'::jsonb,
  'stored as a normalised FeatureCollection with area and source');
select is((select play_area_id::text from public.games where id = current_setting('test.game_id')::uuid),
  current_setting('test.saved'), 'the saved area becomes the game''s area');
select is(
  (select payload from public.events where game_id = current_setting('test.game_id')::uuid order by seq desc limit 1),
  jsonb_build_object('play_area_id', current_setting('test.saved'), 'name', 'CBD square', 'saved', true),
  'play_area_changed is broadcast');

-- Idempotent retry returns the same result without a second row.
select is(
  public.save_play_area(current_setting('test.game_id')::uuid, 'dddddddd-0000-0000-0000-000000000020', 0,
    'CBD square', current_setting('test.square')::jsonb) ->> 'play_area_id',
  current_setting('test.saved'), 'retries with the same client_action_id are no-ops');

-- ---------------------------------------------------------------- overwrite own

select lives_ok(
  $$ select public.save_play_area(current_setting('test.game_id')::uuid, 'dddddddd-0000-0000-0000-000000000021',
       (select last_seq from seq), 'CBD bowtie', current_setting('test.bowtie')::jsonb,
       current_setting('test.saved')::uuid) $$,
  'the creator can overwrite their area (invalid rings are repaired)');
select is(
  (select st_isvalid(st_geomfromgeojson(geojson #> '{features,0,geometry}'))
     and geojson #>> '{features,0,geometry,type}' = 'MultiPolygon'
   from public.play_areas where id = current_setting('test.saved')::uuid),
  true, 'the repaired bow tie is a valid MultiPolygon');

-- ---------------------------------------------------------------- locked after start

reset role;
update public.games set status = 'hiding' where id = current_setting('test.game_id')::uuid;
set local role authenticated;
select throws_ok(
  $$ select public.save_play_area(current_setting('test.game_id')::uuid, 'dddddddd-0000-0000-0000-000000000030',
       (select last_seq from seq), 'Late', current_setting('test.square')::jsonb) $$,
  'P0001', 'play_area_locked', 'the play area is locked once the game starts'
);

select * from finish();
rollback;
