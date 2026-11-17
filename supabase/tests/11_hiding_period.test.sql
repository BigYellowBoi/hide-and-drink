-- Hiding period: choose_bar, hiding_bars, report_position and the hider-only freeze alert.
-- Players: H = host (hider), A and S = seekers, O = outsider.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(38);

insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333'),
  ('44444444-4444-4444-4444-444444444444');

-- A venue well outside every play area (Gold Coast), to prove the picker refuses it.
insert into public.map_features (city, layer, feature_id, name, geom)
values ('brisbane', 'venues', 'test:outside', 'Far Away Tavern',
        st_setsrid(st_makepoint(153.43, -28.0), 4326));

select set_config('test.area_id', (select id::text from public.play_areas where city = 'brisbane' limit 1), true);

create function pg_temp.as_user(p_id text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
$$;
create function pg_temp.last_seq() returns bigint language sql as $$
  select last_seq from public.games where id = current_setting('test.game_id')::uuid;
$$;

-- ---------------------------------------------------------------- setup: start a round

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
set local role authenticated;
select set_config('test.game_id',
  public.create_game('Host', 'dddddddd-0000-0000-0000-000000000001', 'brisbane',
    '{"hiding_period_s":3600,"seeker_location_interval_s":20,
      "hiding_zone":{"bar_radius_m":100,"freeze_when_seeker_within_m":100,
                     "station_zone":{"enabled":null,"radius_m":805,"layer":"stations","modes":["rail"]}}}'::jsonb) ->> 'game_id', true);
select set_config('test.code', (select code from public.games where id = current_setting('test.game_id')::uuid), true);

select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select public.join_game(current_setting('test.code'), 'Amy', 'dddddddd-0000-0000-0000-000000000002');
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select public.join_game(current_setting('test.code'), 'Sam', 'dddddddd-0000-0000-0000-000000000003');

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select public.set_team(current_setting('test.game_id')::uuid, 'hiders', 'dddddddd-0000-0000-0000-000000000004');
select public.set_team(current_setting('test.game_id')::uuid, 'seekers', 'dddddddd-0000-0000-0000-000000000005',
  '22222222-2222-2222-2222-222222222222');
select public.set_team(current_setting('test.game_id')::uuid, 'seekers', 'dddddddd-0000-0000-0000-000000000006',
  '33333333-3333-3333-3333-333333333333');
select public.set_play_area(current_setting('test.game_id')::uuid, current_setting('test.area_id')::uuid,
  'dddddddd-0000-0000-0000-000000000007', pg_temp.last_seq());

-- Before the round starts nothing can be chosen or reported.
select throws_ok(
  $$ select public.choose_bar(current_setting('test.game_id')::uuid, 'x', 'dddddddd-0000-0000-0000-000000000008', pg_temp.last_seq()) $$,
  'P0001', 'round_not_running', 'no bar before the round starts'
);
select public.start_game(current_setting('test.game_id')::uuid, 'dddddddd-0000-0000-0000-000000000009', pg_temp.last_seq());

-- ---------------------------------------------------------------- hiding_bars

select set_config('test.bars', array_to_string(public.hiding_bars(current_setting('test.game_id')::uuid), ','), true);
select ok(cardinality(string_to_array(current_setting('test.bars'), ',')) > 20, 'the play area has plenty of valid bars');
select ok(not ('test:outside' = any (string_to_array(current_setting('test.bars'), ','))),
  'a venue outside the play area is not offered');
select set_config('test.bar', split_part(current_setting('test.bars'), ',', 1), true);

select pg_temp.as_user('44444444-4444-4444-4444-444444444444');
select throws_ok(
  $$ select public.hiding_bars(current_setting('test.game_id')::uuid) $$,
  'P0001', 'not_a_player', 'outsiders cannot list bars'
);

-- ---------------------------------------------------------------- choose_bar refusals

select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select throws_ok(
  $$ select public.choose_bar(current_setting('test.game_id')::uuid, current_setting('test.bar'),
       'dddddddd-0000-0000-0000-000000000010', pg_temp.last_seq()) $$,
  'P0001', 'hiders_only', 'seekers cannot choose the bar'
);

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select throws_ok(
  $$ select public.choose_bar(current_setting('test.game_id')::uuid, 'osm:node/does-not-exist',
       'dddddddd-0000-0000-0000-000000000011', pg_temp.last_seq()) $$,
  'P0001', 'venue_not_found', 'unknown venue is refused'
);
select throws_ok(
  $$ select public.choose_bar(current_setting('test.game_id')::uuid, 'test:outside',
       'dddddddd-0000-0000-0000-000000000012', pg_temp.last_seq()) $$,
  'P0001', 'venue_not_allowed', 'venue outside the play area is refused'
);
select throws_ok(
  $$ select public.choose_bar(current_setting('test.game_id')::uuid, current_setting('test.bar'),
       'dddddddd-0000-0000-0000-000000000013', 1) $$,
  'P0001', 'stale_state', 'choosing a bar needs an up-to-date view'
);

-- Station zone on with a tiny radius: (almost) nothing qualifies, and the server enforces it.
reset role;
update public.games
   set config = jsonb_set(config, '{hiding_zone,station_zone}', '{"enabled":true,"radius_m":1,"layer":"stations","modes":["rail"]}')
 where id = current_setting('test.game_id')::uuid;
set local role authenticated;
select ok(
  cardinality(public.hiding_bars(current_setting('test.game_id')::uuid))
    < cardinality(string_to_array(current_setting('test.bars'), ',')),
  'station zone narrows the bar list'
);
select throws_ok(
  $$ select public.choose_bar(current_setting('test.game_id')::uuid, current_setting('test.bar'),
       'dddddddd-0000-0000-0000-000000000014', pg_temp.last_seq()) $$,
  'P0001', 'venue_not_allowed', 'bar outside the station zone is refused'
);
reset role;
update public.games
   set config = jsonb_set(config, '{hiding_zone,station_zone,enabled}', 'null')
 where id = current_setting('test.game_id')::uuid;
set local role authenticated;

-- ---------------------------------------------------------------- seekers already close

-- Amy stands at the bar before it is chosen: choosing it freezes the hider straight away.
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select public.report_position(current_setting('test.game_id')::uuid,
  (select st_x(geom) from public.map_features where city = 'brisbane' and layer = 'venues' and feature_id = current_setting('test.bar')),
  (select st_y(geom) from public.map_features where city = 'brisbane' and layer = 'venues' and feature_id = current_setting('test.bar')),
  10);
select set_config('test.seq_before_bar', pg_temp.last_seq()::text, true);
select is(pg_temp.last_seq(), current_setting('test.seq_before_bar')::bigint,
  'a position report with no bar yet adds no event');

-- ---------------------------------------------------------------- choose_bar

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select set_config('test.chosen', public.choose_bar(current_setting('test.game_id')::uuid, current_setting('test.bar'),
  'dddddddd-0000-0000-0000-000000000015', pg_temp.last_seq())::text, true);
select is((current_setting('test.chosen')::jsonb ->> 'frozen')::boolean, true, 'choose_bar reports the freeze state');
select is(
  public.choose_bar(current_setting('test.game_id')::uuid, current_setting('test.bar'),
    'dddddddd-0000-0000-0000-000000000015', 0)::text,
  current_setting('test.chosen'),
  'retrying choose_bar returns the same result'
);
select throws_ok(
  $$ select public.choose_bar(current_setting('test.game_id')::uuid, current_setting('test.bar'),
       'dddddddd-0000-0000-0000-000000000016', pg_temp.last_seq()) $$,
  'P0001', 'bar_already_chosen', 'the bar is locked in once per round'
);

reset role;
select is(
  (select visibility::text from public.events where game_id = current_setting('test.game_id')::uuid and type = 'bar_chosen'),
  'hiders', 'bar_chosen is hider-only'
);
select is(
  (select payload ->> 'venue_id' from public.events where game_id = current_setting('test.game_id')::uuid and type = 'bar_chosen'),
  current_setting('test.bar'), 'bar_chosen names the venue'
);
select is(
  (select (payload ->> 'late')::boolean from public.events where game_id = current_setting('test.game_id')::uuid and type = 'bar_chosen'),
  false, 'chosen within the hiding period'
);
select is(
  (select count(*)::int from realtime.messages
    where topic = 'game:' || current_setting('test.game_id') and payload ->> 'type' = 'bar_chosen'),
  0, 'bar_chosen is never broadcast on the shared topic'
);
select is(
  (select visibility::text || ':' || coalesce(actor_id::text, 'none') || ':' || (payload ->> 'frozen')
     from public.events where game_id = current_setting('test.game_id')::uuid and type = 'freeze_changed'
     order by seq desc limit 1),
  'hiders:none:true', 'freeze is hider-only, has no actor, and is on'
);

-- ---------------------------------------------------------------- what each team can read

set local role authenticated;
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select is(
  (select count(*)::int from public.events
    where game_id = current_setting('test.game_id')::uuid and type in ('bar_chosen', 'freeze_changed')),
  0, 'seekers cannot read the bar or freeze events'
);
select throws_ok($$ select * from public.hider_bars $$, '42501', null, 'seekers cannot read hider_bars');

select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select is((select count(*)::int from public.seeker_positions), 1, 'a seeker sees teammates'' positions');

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is((select count(*)::int from public.seeker_positions), 1, 'the hider sees the seekers'' positions too');
select throws_ok($$ select * from public.hider_bars $$, '42501', null, 'not even hiders read hider_bars directly');
select is(
  (select count(*)::int from public.events
    where game_id = current_setting('test.game_id')::uuid and type in ('bar_chosen', 'freeze_changed')),
  2, 'the hider reads the bar and freeze events'
);

-- ---------------------------------------------------------------- report_position

select throws_ok(
  $$ select public.report_position(current_setting('test.game_id')::uuid, 153.02, -27.47, 5) $$,
  'P0001', 'seekers_only', 'hiders never report positions'
);
select pg_temp.as_user('44444444-4444-4444-4444-444444444444');
select throws_ok(
  $$ select public.report_position(current_setting('test.game_id')::uuid, 153.02, -27.47, 5) $$,
  'P0001', 'seekers_only', 'outsiders cannot report positions'
);
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select throws_ok(
  $$ select public.report_position(current_setting('test.game_id')::uuid, 200, -27.47, 5) $$,
  'P0001', 'invalid_position', 'out-of-range coordinates are refused'
);

-- Amy walks 1 km away: freeze clears.
select set_config('test.seq', pg_temp.last_seq()::text, true);
select public.report_position(current_setting('test.game_id')::uuid,
  (select st_x(geom) + 0.01 from public.map_features where city = 'brisbane' and layer = 'venues' and feature_id = current_setting('test.bar')),
  (select st_y(geom) from public.map_features where city = 'brisbane' and layer = 'venues' and feature_id = current_setting('test.bar')),
  10);
reset role;
select is(
  (select (payload ->> 'frozen')::boolean from public.events
    where game_id = current_setting('test.game_id')::uuid and type = 'freeze_changed' order by seq desc limit 1),
  false, 'moving away clears the freeze'
);
select is(pg_temp.last_seq(), current_setting('test.seq')::bigint + 1, 'one event per change');

-- Same far position again: no change, no event.
set local role authenticated;
select public.report_position(current_setting('test.game_id')::uuid,
  (select st_x(geom) + 0.01 from public.map_features where city = 'brisbane' and layer = 'venues' and feature_id = current_setting('test.bar')),
  (select st_y(geom) from public.map_features where city = 'brisbane' and layer = 'venues' and feature_id = current_setting('test.bar')),
  10);
select is(pg_temp.last_seq(), current_setting('test.seq')::bigint + 1, 'no event when the freeze state is unchanged');

-- 99 m away: still within the 100 m radius.
select public.report_position(current_setting('test.game_id')::uuid,
  (select st_x(geom) from public.map_features where city = 'brisbane' and layer = 'venues' and feature_id = current_setting('test.bar')),
  (select st_y(geom) + 99.0 / 111320 from public.map_features where city = 'brisbane' and layer = 'venues' and feature_id = current_setting('test.bar')),
  10);
reset role;
select is(
  (select (payload ->> 'frozen')::boolean from public.events
    where game_id = current_setting('test.game_id')::uuid and type = 'freeze_changed' order by seq desc limit 1),
  true, 'a seeker 99 m away freezes the hider'
);

-- Amy's phone goes quiet for 5 minutes; Sam reports from far away: Amy no longer counts.
update public.seeker_positions set reported_at = now() - interval '5 minutes'
 where user_id = '22222222-2222-2222-2222-222222222222';
set local role authenticated;
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select public.report_position(current_setting('test.game_id')::uuid, 153.1, -27.6, 20);
reset role;
select is(
  (select (payload ->> 'frozen')::boolean from public.events
    where game_id = current_setting('test.game_id')::uuid and type = 'freeze_changed' order by seq desc limit 1),
  false, 'a stale position no longer freezes the hider'
);

-- Broadcasts: positions go to both team topics, never into the event log.
select ok(
  (select count(*) from realtime.messages
    where topic = 'game:' || current_setting('test.game_id') || ':seekers' and event = 'position') >= 4,
  'positions are broadcast to the seekers topic'
);
select is(
  (select count(*)::int from realtime.messages
    where event = 'position' and topic = 'game:' || current_setting('test.game_id') || ':hiders'),
  (select count(*)::int from realtime.messages
    where event = 'position' and topic = 'game:' || current_setting('test.game_id') || ':seekers'),
  'every position also goes to the hiders topic (and nowhere else, below)'
);
select is(
  (select count(*)::int from realtime.messages
    where event = 'position' and topic not in ('game:' || current_setting('test.game_id') || ':seekers',
                                                'game:' || current_setting('test.game_id') || ':hiders')),
  0, 'positions go nowhere else'
);
select is(
  (select count(*)::int from public.events where game_id = current_setting('test.game_id')::uuid and type like '%position%'),
  0, 'positions are not game events'
);

-- The hider cannot receive seeker broadcasts (topic authorisation).
set local role authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select set_config('realtime.topic', 'game:' || current_setting('test.game_id') || ':seekers', true);
select is((select count(*)::int from realtime.messages), 0, 'the hider cannot read the seekers topic');

select * from finish();
rollback;
