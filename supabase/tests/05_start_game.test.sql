-- Lobby play area choice and the host's "lock and start" action.
-- Players: H = host, A = player, S = player, O = outsider.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(28);

insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333'),
  ('44444444-4444-4444-4444-444444444444');

select set_config('test.area_id', (select id::text from public.play_areas where city = 'brisbane' limit 1), true);
insert into public.play_areas (name, city, geojson)
values ('Sydney test', 'sydney', '{"type":"FeatureCollection","features":[]}');
select set_config('test.sydney_area', (select id::text from public.play_areas where city = 'sydney' limit 1), true);

-- ---------------------------------------------------------------- setup

select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
set local role authenticated;
select set_config('test.game_id',
  public.create_game('Host', 'cccccccc-0000-0000-0000-000000000001', 'brisbane',
    '{"answer_deadline_s":{"default":300},"hiding_period_s":null}'::jsonb) ->> 'game_id', true);

select is(
  (select payload -> 'config' -> 'answer_deadline_s' from public.events
    where game_id = current_setting('test.game_id')::uuid and type = 'game_created'),
  '{"default":300}'::jsonb,
  'game_created carries the starting config'
);
select set_config('test.code', (select code from public.games where id = current_setting('test.game_id')::uuid), true);

select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
set local role authenticated;
select public.join_game(current_setting('test.code'), 'Amy', 'cccccccc-0000-0000-0000-000000000002');
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
set local role authenticated;
select public.join_game(current_setting('test.code'), 'Sam', 'cccccccc-0000-0000-0000-000000000003');

-- ---------------------------------------------------------------- play area

select throws_ok(
  $$ select public.set_play_area(current_setting('test.game_id')::uuid, current_setting('test.area_id')::uuid,
       'cccccccc-0000-0000-0000-000000000010', (select last_seq from public.games where id = current_setting('test.game_id')::uuid)) $$,
  'P0001', 'host_only', 'only the host can choose the play area'
);

select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
set local role authenticated;

select throws_ok(
  $$ select public.set_play_area(current_setting('test.game_id')::uuid, current_setting('test.sydney_area')::uuid,
       'cccccccc-0000-0000-0000-000000000011', (select last_seq from public.games where id = current_setting('test.game_id')::uuid)) $$,
  'P0001', 'play_area_not_found', 'a play area from another city is refused'
);
select throws_ok(
  $$ select public.set_play_area(current_setting('test.game_id')::uuid, current_setting('test.area_id')::uuid,
       'cccccccc-0000-0000-0000-000000000012', 1) $$,
  'P0001', 'stale_state', 'choosing a play area needs an up-to-date view'
);

-- ---------------------------------------------------------------- start: refusals

select throws_ok(
  $$ select public.start_game(current_setting('test.game_id')::uuid, 'cccccccc-0000-0000-0000-000000000020',
       (select last_seq from public.games where id = current_setting('test.game_id')::uuid)) $$,
  'P0001', 'players_without_team', 'cannot start while someone has no team'
);

select public.set_team(current_setting('test.game_id')::uuid, 'hiders', 'cccccccc-0000-0000-0000-000000000021');
select public.set_team(current_setting('test.game_id')::uuid, 'hiders', 'cccccccc-0000-0000-0000-000000000022',
  '22222222-2222-2222-2222-222222222222');
select public.set_team(current_setting('test.game_id')::uuid, 'hiders', 'cccccccc-0000-0000-0000-000000000023',
  '33333333-3333-3333-3333-333333333333');

select throws_ok(
  $$ select public.start_game(current_setting('test.game_id')::uuid, 'cccccccc-0000-0000-0000-000000000024',
       (select last_seq from public.games where id = current_setting('test.game_id')::uuid)) $$,
  'P0001', 'needs_both_teams', 'cannot start without at least one seeker'
);

select public.set_team(current_setting('test.game_id')::uuid, 'seekers', 'cccccccc-0000-0000-0000-000000000025',
  '33333333-3333-3333-3333-333333333333');

select throws_ok(
  $$ select public.start_game(current_setting('test.game_id')::uuid, 'cccccccc-0000-0000-0000-000000000026',
       (select last_seq from public.games where id = current_setting('test.game_id')::uuid)) $$,
  'P0001', 'play_area_required', 'cannot start without a play area'
);

select lives_ok(
  $$ select public.set_play_area(current_setting('test.game_id')::uuid, current_setting('test.area_id')::uuid,
       'cccccccc-0000-0000-0000-000000000013', (select last_seq from public.games where id = current_setting('test.game_id')::uuid)) $$,
  'host chooses a saved play area'
);
select is(
  (select payload ->> 'play_area_id' from public.events
    where game_id = current_setting('test.game_id')::uuid and type = 'play_area_changed'),
  current_setting('test.area_id'),
  'play_area_changed event names the area'
);

select throws_ok(
  $$ select public.start_game(current_setting('test.game_id')::uuid, 'cccccccc-0000-0000-0000-000000000027',
       (select last_seq from public.games where id = current_setting('test.game_id')::uuid)) $$,
  'P0001', 'hiding_period_required', 'cannot start without a hiding period'
);

select public.update_config(current_setting('test.game_id')::uuid,
  '{"answer_deadline_s":{"default":300},"hiding_period_s":1800}'::jsonb,
  'cccccccc-0000-0000-0000-000000000028', (select last_seq from public.games where id = current_setting('test.game_id')::uuid));

select throws_ok(
  $$ select public.start_game(current_setting('test.game_id')::uuid, 'cccccccc-0000-0000-0000-000000000029', 1) $$,
  'P0001', 'stale_state', 'starting needs an up-to-date view'
);

select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
set local role authenticated;
select throws_ok(
  $$ select public.start_game(current_setting('test.game_id')::uuid, 'cccccccc-0000-0000-0000-000000000030',
       (select last_seq from public.games where id = current_setting('test.game_id')::uuid)) $$,
  'P0001', 'host_only', 'only the host can start'
);

-- ---------------------------------------------------------------- start: success

select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
set local role authenticated;
select lives_ok(
  $$ select set_config('test.started', public.start_game(current_setting('test.game_id')::uuid,
       'cccccccc-0000-0000-0000-000000000031',
       (select last_seq from public.games where id = current_setting('test.game_id')::uuid))::text, true) $$,
  'host locks and starts'
);
select is(
  public.start_game(current_setting('test.game_id')::uuid, 'cccccccc-0000-0000-0000-000000000031', 0),
  current_setting('test.started')::jsonb,
  'retrying start_game returns the same result'
);

reset role;
select is((select status::text from public.games where id = current_setting('test.game_id')::uuid), 'hiding',
  'game moves to the hiding period');
select is((select round from public.games where id = current_setting('test.game_id')::uuid), 1, 'round 1');
select is((select hiding_period_s from public.games where id = current_setting('test.game_id')::uuid), 1800,
  'hiding period is stored as a duration');
select ok((select round_started_at is not null from public.games where id = current_setting('test.game_id')::uuid),
  'round start time is stored (server time)');
select is(
  (select play_area_snapshot from public.games where id = current_setting('test.game_id')::uuid),
  (select geojson from public.play_areas where id = current_setting('test.area_id')::uuid),
  'play area polygon is snapshotted onto the game'
);
select is(
  (select count(*)::int from public.events where game_id = current_setting('test.game_id')::uuid and type = 'game_started'),
  1, 'exactly one game_started event, even after a retry'
);
select is(
  (select visibility::text from public.events where game_id = current_setting('test.game_id')::uuid and type = 'game_started'),
  'all', 'game_started is visible to everyone'
);
select is(
  (select jsonb_build_object(
     'hiding_period_s', payload -> 'hiding_period_s',
     'deadline', payload -> 'config' -> 'answer_deadline_s' -> 'default',
     'area', payload -> 'play_area' ->> 'id',
     'players', jsonb_array_length(payload -> 'players'))
   from public.events where game_id = current_setting('test.game_id')::uuid and type = 'game_started'),
  jsonb_build_object('hiding_period_s', 1800, 'deadline', 300, 'area', current_setting('test.area_id'), 'players', 3),
  'game_started carries the config, play area and teams snapshot'
);

-- Editing the saved area afterwards doesn't change the running game.
update public.play_areas set geojson = '{"type":"FeatureCollection","features":[]}' where id = current_setting('test.area_id')::uuid;
select isnt(
  (select play_area_snapshot from public.games where id = current_setting('test.game_id')::uuid),
  '{"type":"FeatureCollection","features":[]}'::jsonb,
  'later edits to the saved area do not affect the snapshot'
);

-- ---------------------------------------------------------------- locked

select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
set local role authenticated;
select throws_ok(
  $$ select public.start_game(current_setting('test.game_id')::uuid, 'cccccccc-0000-0000-0000-000000000040',
       (select last_seq from public.games where id = current_setting('test.game_id')::uuid)) $$,
  'P0001', 'already_started', 'cannot start twice'
);
select throws_ok(
  $$ select public.set_team(current_setting('test.game_id')::uuid, 'seekers', 'cccccccc-0000-0000-0000-000000000041',
       '22222222-2222-2222-2222-222222222222') $$,
  'P0001', 'teams_locked', 'teams are locked once started'
);
select throws_ok(
  $$ select public.update_config(current_setting('test.game_id')::uuid, '{}'::jsonb, 'cccccccc-0000-0000-0000-000000000042',
       (select last_seq from public.games where id = current_setting('test.game_id')::uuid)) $$,
  'P0001', 'config_locked', 'config is locked once started'
);
select throws_ok(
  $$ select public.set_play_area(current_setting('test.game_id')::uuid, null, 'cccccccc-0000-0000-0000-000000000043',
       (select last_seq from public.games where id = current_setting('test.game_id')::uuid)) $$,
  'P0001', 'play_area_locked', 'play area is locked once started'
);

select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}', true);
set local role authenticated;
select throws_ok(
  $$ select public.start_game(current_setting('test.game_id')::uuid, 'cccccccc-0000-0000-0000-000000000044', 999) $$,
  'P0001', 'host_only', 'an outsider cannot start a game'
);

select * from finish();
rollback;
