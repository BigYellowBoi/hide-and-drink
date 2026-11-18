-- Custom venues: host adds and hides venues in the lobby (public, snapshotted at start), the
-- hider adds a bar during the round (hider-only, revealed when the round ends), and
-- _valid_bars / hiding_bars / choose_bar treat them like city-pack venues.
-- Players: H = host (hider), A and S = seekers.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(34);

insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333');

select set_config('test.area_id', (select id::text from public.play_areas where city = 'brisbane' limit 1), true);
-- Two city-pack venues inside that area: one the host hides, one hidden then shown again.
select set_config('test.hide', (
  select f.feature_id from public.map_features f, public.play_areas a
   where a.id = current_setting('test.area_id')::uuid and f.city = 'brisbane' and f.layer = 'venues'
     and st_covers(st_setsrid(public._play_area_geom(a.geojson), 4326), f.geom)
   order by f.feature_id limit 1), true);
select set_config('test.show', (
  select f.feature_id from public.map_features f, public.play_areas a
   where a.id = current_setting('test.area_id')::uuid and f.city = 'brisbane' and f.layer = 'venues'
     and st_covers(st_setsrid(public._play_area_geom(a.geojson), 4326), f.geom)
   order by f.feature_id offset 1 limit 1), true);

create function pg_temp.as_user(p_id text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
$$;
create function pg_temp.gid() returns uuid language sql as $$ select current_setting('test.game_id')::uuid $$;
create function pg_temp.last_seq() returns bigint language sql as $$
  select last_seq from public.games where id = pg_temp.gid();
$$;
create function pg_temp.has_bar(p_id text) returns boolean language sql as $$
  select p_id = any (public.hiding_bars(pg_temp.gid()));
$$;

-- ---------------------------------------------------------------- setup

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
set local role authenticated;
select set_config('test.game_id',
  public.create_game('Host', 'eeeeeeee-0000-0000-0000-000000000001', 'brisbane',
    '{"hiding_period_s":3600,"hiding_zone":{"bar_radius_m":100}}'::jsonb) ->> 'game_id', true);
select set_config('test.code', (select code from public.games where id = pg_temp.gid()), true);
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select public.join_game(current_setting('test.code'), 'Amy', 'eeeeeeee-0000-0000-0000-000000000002');
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select public.join_game(current_setting('test.code'), 'Sam', 'eeeeeeee-0000-0000-0000-000000000003');

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select public.set_team(pg_temp.gid(), 'hiders', 'eeeeeeee-0000-0000-0000-000000000004');
select public.set_team(pg_temp.gid(), 'seekers', 'eeeeeeee-0000-0000-0000-000000000005', '22222222-2222-2222-2222-222222222222');
select public.set_team(pg_temp.gid(), 'seekers', 'eeeeeeee-0000-0000-0000-000000000006', '33333333-3333-3333-3333-333333333333');
select public.set_play_area(pg_temp.gid(), current_setting('test.area_id')::uuid, 'eeeeeeee-0000-0000-0000-000000000007', pg_temp.last_seq());

-- ---------------------------------------------------------------- lobby: add and hide

select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select throws_ok(
  $$ select public.add_venue(pg_temp.gid(), 'Nope', 153.025, -27.468, 'eeeeeeee-0000-0000-0000-000000000010', pg_temp.last_seq()) $$,
  'P0001', 'host_only', 'only the host adds venues in the lobby');
select throws_ok(
  $$ select public.set_venue_hidden(pg_temp.gid(), current_setting('test.hide'), true, 'eeeeeeee-0000-0000-0000-000000000011', pg_temp.last_seq()) $$,
  'P0001', 'host_only', 'only the host hides venues');

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select throws_ok(
  $$ select public.add_venue(pg_temp.gid(), '   ', 153.025, -27.468, 'eeeeeeee-0000-0000-0000-000000000012', pg_temp.last_seq()) $$,
  'P0001', 'invalid_venue_name', 'a venue needs a name');
select throws_ok(
  $$ select public.add_venue(pg_temp.gid(), 'Sydney Pub', 151.2, -33.87, 'eeeeeeee-0000-0000-0000-000000000013', pg_temp.last_seq()) $$,
  'P0001', 'venue_outside_map_data', 'a venue must be inside the city pack');
select throws_ok(
  $$ select public.add_venue(pg_temp.gid(), 'Stale', 153.025, -27.468, 'eeeeeeee-0000-0000-0000-000000000014', 0) $$,
  'P0001', 'stale_state', 'add_venue checks freshness');

select set_config('test.lobby_venue',
  public.add_venue(pg_temp.gid(), '  Pop-up Bar ', 153.025, -27.468, 'eeeeeeee-0000-0000-0000-000000000015', pg_temp.last_seq()) ->> 'feature_id', true);
select ok(current_setting('test.lobby_venue') like 'custom:%', 'custom venues get custom: ids');
select is(
  public.add_venue(pg_temp.gid(), '  Pop-up Bar ', 153.025, -27.468, 'eeeeeeee-0000-0000-0000-000000000015', pg_temp.last_seq()) ->> 'feature_id',
  current_setting('test.lobby_venue'), 'retrying add_venue returns the same venue');

select public.set_venue_hidden(pg_temp.gid(), current_setting('test.hide'), true, 'eeeeeeee-0000-0000-0000-000000000016', pg_temp.last_seq());
select public.set_venue_hidden(pg_temp.gid(), current_setting('test.show'), true, 'eeeeeeee-0000-0000-0000-000000000017', pg_temp.last_seq());
select public.set_venue_hidden(pg_temp.gid(), current_setting('test.show'), false, 'eeeeeeee-0000-0000-0000-000000000018', pg_temp.last_seq());
select throws_ok(
  $$ select public.set_venue_hidden(pg_temp.gid(), 'osm:nope', true, 'eeeeeeee-0000-0000-0000-000000000019', pg_temp.last_seq()) $$,
  'P0001', 'venue_not_found', 'only listed venues can be hidden');

reset role;
select is(
  (select visibility::text || ':' || (payload #>> '{venue,name}') from public.events
    where game_id = pg_temp.gid() and type = 'venue_added'),
  'all:Pop-up Bar', 'a lobby venue is public, name trimmed');
select is(
  (select count(*)::int from public.events where game_id = pg_temp.gid() and type = 'venue_hidden' and visibility = 'all'),
  3, 'hiding and showing are public events');

-- ---------------------------------------------------------------- start: snapshot

set local role authenticated;
select public.start_game(pg_temp.gid(), 'eeeeeeee-0000-0000-0000-000000000020', pg_temp.last_seq());

reset role;
select is(
  (select payload #>> '{venues,added,0,feature_id}' from public.events where game_id = pg_temp.gid() and type = 'game_started'),
  current_setting('test.lobby_venue'), 'game_started snapshots the added venues');
select is(
  (select payload #> '{venues,hidden}' from public.events where game_id = pg_temp.gid() and type = 'game_started'),
  jsonb_build_array(current_setting('test.hide')), 'game_started snapshots the hidden venues (not the re-shown one)');

set local role authenticated;
select throws_ok(
  $$ select public.set_venue_hidden(pg_temp.gid(), current_setting('test.show'), true, 'eeeeeeee-0000-0000-0000-000000000021', pg_temp.last_seq()) $$,
  'P0001', 'venues_locked', 'the venue list locks at start');

select ok(pg_temp.has_bar(current_setting('test.lobby_venue')), 'hiding_bars offers the lobby venue');
select ok(not pg_temp.has_bar(current_setting('test.hide')), 'hiding_bars leaves out a hidden venue');
select ok(pg_temp.has_bar(current_setting('test.show')), 'a re-shown venue is offered again');

-- ---------------------------------------------------------------- round: the hider adds a bar

select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select throws_ok(
  $$ select public.add_venue(pg_temp.gid(), 'Seeker Bar', 153.025, -27.468, 'eeeeeeee-0000-0000-0000-000000000030', pg_temp.last_seq()) $$,
  'P0001', 'hiders_only', 'seekers cannot add venues during a round');

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select throws_ok(
  $$ select public.add_venue(pg_temp.gid(), 'Gold Coast', 153.43, -28.0, 'eeeeeeee-0000-0000-0000-000000000031', pg_temp.last_seq()) $$,
  'P0001', 'venue_outside_play_area', 'a hider venue must be inside the play area');
select throws_ok(
  $$ select public.choose_bar(pg_temp.gid(), current_setting('test.hide'), 'eeeeeeee-0000-0000-0000-000000000032', pg_temp.last_seq()) $$,
  'P0001', 'venue_not_allowed', 'a hidden venue cannot be chosen');

select set_config('test.secret',
  public.add_venue(pg_temp.gid(), 'Secret Speakeasy', 153.024, -27.469, 'eeeeeeee-0000-0000-0000-000000000033', pg_temp.last_seq()) ->> 'feature_id', true);
select ok(pg_temp.has_bar(current_setting('test.secret')), 'the hider sees their venue in hiding_bars');

-- ---------------------------------------------------------------- leak: seekers never receive it

reset role;
select is(
  (select visibility::text from public.events
    where game_id = pg_temp.gid() and type = 'venue_added' and payload #>> '{venue,feature_id}' = current_setting('test.secret')),
  'hiders', 'a hider venue_added is hider-only');
select is(
  (select count(*)::int from realtime.messages
    where topic in ('game:' || current_setting('test.game_id'), 'game:' || current_setting('test.game_id') || ':seekers')
      and payload::text like '%' || current_setting('test.secret') || '%'),
  0, 'the hider venue is never broadcast to seekers or the shared topic');

set local role authenticated;
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select is(
  (select count(*)::int from public.events
    where game_id = pg_temp.gid() and payload::text like '%' || current_setting('test.secret') || '%'),
  0, 'seekers cannot read any event naming the hider venue');
select throws_ok($$ select * from public.game_venues $$, '42501', null, 'seekers cannot read game_venues');
select throws_ok($$ select * from public.game_hidden_venues $$, '42501', null, 'nor game_hidden_venues');
select ok(not pg_temp.has_bar(current_setting('test.secret')), 'hiding_bars hides the hider venue from seekers');
select ok(pg_temp.has_bar(current_setting('test.lobby_venue')), 'seekers still see the public venue');

-- ---------------------------------------------------------------- choose_bar with it

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select throws_ok($$ select * from public.game_venues $$, '42501', null, 'not even hiders read game_venues directly');
select public.choose_bar(pg_temp.gid(), current_setting('test.secret'), 'eeeeeeee-0000-0000-0000-000000000034', pg_temp.last_seq());
reset role;
select is(
  (select payload ->> 'name' from public.events where game_id = pg_temp.gid() and type = 'bar_chosen'),
  'Secret Speakeasy', 'choose_bar locks in a hider venue like any other');
select is(
  (select round(st_x(geom)::numeric, 3)::text || ',' || round(st_y(geom)::numeric, 3)::text
     from public.hider_bars where game_id = pg_temp.gid()),
  '153.024,-27.469', 'hider_bars has its position');

-- ---------------------------------------------------------------- reveal at the round's end

update public.games set status = 'ended' where id = pg_temp.gid();
select is(
  (select visibility::text || ':' || coalesce(actor_id::text, 'none') || ':' || (payload #>> '{venues,0,name}')
     from public.events where game_id = pg_temp.gid() and type = 'venues_revealed'),
  'all:none:Secret Speakeasy', 'the round''s end reveals the hider venue to everyone, with no actor');
update public.games set updated_at = now() where id = pg_temp.gid();
select is(
  (select count(*)::int from public.events where game_id = pg_temp.gid() and type = 'venues_revealed'),
  1, 'revealed once');

set local role authenticated;
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select ok(pg_temp.has_bar(current_setting('test.secret')), 'once revealed, seekers get it from hiding_bars too');
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select throws_ok(
  $$ select public.add_venue(pg_temp.gid(), 'Too Late', 153.025, -27.468, 'eeeeeeee-0000-0000-0000-000000000040', pg_temp.last_seq()) $$,
  'P0001', 'round_not_running', 'no venues once the game is over');

select * from finish();
rollback;
