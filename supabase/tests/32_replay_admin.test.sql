-- Replays, past games, admins and deleting games (20261223090000_replay_admin.sql): the
-- position track is recorded for every player during play and stays hidden from every client
-- until the game ends (leak test), get_replay then shows both teams everything, list_past_games,
-- the admin PIN rate limit, and delete_game (host or admin, ended games only, no media left).
-- Players: H = host (seeker), A = hider, S = seeker, X = outsider (made admin later),
-- Y = outsider, O = host of a lobby.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(56);

insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333'),
  ('44444444-4444-4444-4444-444444444444'),
  ('55555555-5555-5555-5555-555555555555'),
  ('66666666-6666-6666-6666-666666666666');

select set_config('test.area_id',
  (select id::text from public.play_areas where city = 'brisbane' and created_by is null order by name limit 1), true);
create function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
end;
$$;
create function pg_temp.seq() returns bigint language sql as $$
  select last_seq from public.games where id = current_setting('test.game_id')::uuid;
$$;
create function pg_temp.gid() returns uuid language sql as $$ select current_setting('test.game_id')::uuid $$;
create function pg_temp.uid(n int) returns uuid language sql as $$
  select ('acacacac-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid
$$;
create function pg_temp.host() returns void language sql as $$ select pg_temp.as_user('11111111-1111-1111-1111-111111111111') $$;
create function pg_temp.amy() returns void language sql as $$ select pg_temp.as_user('22222222-2222-2222-2222-222222222222') $$;
create function pg_temp.sam() returns void language sql as $$ select pg_temp.as_user('33333333-3333-3333-3333-333333333333') $$;
create function pg_temp.xen() returns void language sql as $$ select pg_temp.as_user('44444444-4444-4444-4444-444444444444') $$;
create function pg_temp.yan() returns void language sql as $$ select pg_temp.as_user('55555555-5555-5555-5555-555555555555') $$;
-- Rows of the game, read past RLS.
create function pg_temp.rows(p_table text) returns integer language plpgsql security definer as $$
declare n integer;
begin
  execute format('select count(*)::int from public.%I where game_id = %L', p_table, pg_temp.gid()) into n;
  return n;
end;
$$;
grant execute on all functions in schema pg_temp to authenticated;

-- ---------------------------------------------------------------- setup

select pg_temp.host();
set local role authenticated;
select set_config('test.game_id',
  public.create_game('Host', pg_temp.uid(1), 'brisbane', '{"hiding_period_s":1800}'::jsonb) ->> 'game_id', true);
select set_config('test.code', (select code from public.games where id = pg_temp.gid()), true);
select pg_temp.amy();
select public.join_game(current_setting('test.code'), 'Amy', pg_temp.uid(2));
select public.set_team(pg_temp.gid(), 'hiders', pg_temp.uid(3));
select pg_temp.sam();
select public.join_game(current_setting('test.code'), 'Sam', pg_temp.uid(4));
select public.set_team(pg_temp.gid(), 'seekers', pg_temp.uid(5));
select pg_temp.host();
select public.set_team(pg_temp.gid(), 'seekers', pg_temp.uid(6));
select public.set_play_area(pg_temp.gid(), current_setting('test.area_id')::uuid, pg_temp.uid(7), pg_temp.seq());

select throws_ok($$ select public.report_track(pg_temp.gid(), 153.0123, -27.4567) $$,
  'P0001', 'round_not_running', 'nothing is recorded in the lobby');

select public.start_game(pg_temp.gid(), pg_temp.uid(8), pg_temp.seq());
select pg_temp.amy();
select set_config('test.bars', array_to_string(public.hiding_bars(pg_temp.gid()), ','), true);
select public.choose_bar(pg_temp.gid(), split_part(current_setting('test.bars'), ',', 1), pg_temp.uid(9), pg_temp.seq());

-- O hosts a lobby of their own.
select pg_temp.as_user('66666666-6666-6666-6666-666666666666');
select set_config('test.other', public.create_game('Olly', pg_temp.uid(50), 'brisbane', '{}'::jsonb) ->> 'game_id', true);

-- ---------------------------------------------------------------- recording the track

select pg_temp.amy();
select is(public.report_track(pg_temp.gid(), 153.0123, -27.4567, 8) ->> 'recorded', 'true', 'the hider''s position is recorded');
select is(public.report_track(pg_temp.gid(), 153.0124, -27.4568, 8) ->> 'recorded', 'false',
  'at most one point every 2 s per player');
select pg_temp.sam();
select lives_ok($$ select public.report_position(pg_temp.gid(), 153.0301, -27.4701, 5) $$, 'a seeker reports as usual');
select pg_temp.xen();
select throws_ok($$ select public.report_track(pg_temp.gid(), 153.0, -27.4) $$,
  'P0001', 'not_a_player', 'outsiders record nothing');
select pg_temp.amy();
select throws_ok($$ select public.report_track(pg_temp.gid(), 200, -27.4) $$,
  'P0001', 'invalid_position', 'positions are checked');

reset role;
select is(pg_temp.rows('position_track'), 2, 'one point each for the hider and the seeker');
select is((select array_agg(team::text order by team) from public.position_track where game_id = pg_temp.gid()),
  array['hiders', 'seekers'], 'each with the team they were on');
-- An earlier point, so the hider's next report is past the 2 s gap.
update public.position_track set recorded_at = now() - interval '30 seconds' where game_id = pg_temp.gid();
set local role authenticated;
select pg_temp.amy();
select is(public.report_track(pg_temp.gid(), 153.0125, -27.4569, 8) ->> 'recorded', 'true', 'and the next one later');

-- ---------------------------------------------------------------- leak test: hidden while the game runs

select ok(not has_table_privilege('authenticated', 'public.position_track', 'select')
      and not has_table_privilege('anon', 'public.position_track', 'select'),
  'no client role may read the track');
select pg_temp.sam();
select throws_ok($$ select count(*) from public.position_track $$, '42501', null, 'a seeker reading it is refused');
select pg_temp.amy();
select throws_ok($$ select count(*) from public.position_track $$, '42501', null, 'so is the hider');
select pg_temp.sam();
select throws_ok($$ select public.get_replay(pg_temp.gid()) $$, 'P0001', 'game_not_ended',
  'no replay while the game runs, for seekers');
select pg_temp.amy();
select throws_ok($$ select public.get_replay(pg_temp.gid()) $$, 'P0001', 'game_not_ended', 'nor for hiders');
select pg_temp.sam();
select is(jsonb_array_length(public.list_past_games()), 0, 'a running game is not a past game');
reset role;
select is((select count(*)::int from realtime.messages
            where payload::text like '%153.0123%' or payload::text like '%153.0125%'), 0,
  'the hider''s track is never broadcast, on any topic');
select is((select count(*)::int from public.events
            where game_id = pg_temp.gid() and (payload::text like '%153.0123%' or payload::text like '%153.0125%')), 0,
  'nor written to the event log');
select ok(not has_function_privilege('authenticated', 'public._track_position(public.games, uuid, double precision, double precision, real)', 'execute'),
  'clients can only add to the track, through report_position and report_track');

-- ---------------------------------------------------------------- media of the game

-- A hider-only cost photo in R2 and an old answer photo in the Supabase bucket.
select set_config('test.m_r2', pg_temp.gid() || '/' || pg_temp.uid(90) || '/cost.jpg', true);
select set_config('test.m_sb', pg_temp.gid() || '/' || pg_temp.uid(91) || '/answer.jpg', true);
insert into public.media_objects (name, game_id, bucket, content_type, bytes, quality, created_by, uploaded_at)
values (current_setting('test.m_r2'), pg_temp.gid(), 'drink-photos', 'image/jpeg', 1234, 'original',
        '22222222-2222-2222-2222-222222222222', now());
insert into storage.objects (bucket_id, name) values ('question-photos', current_setting('test.m_sb'));
select is(array(select name from public.media_read_grant('33333333-3333-3333-3333-333333333333'::uuid,
                  array[current_setting('test.m_r2')])),
  array[]::text[], 'while the game runs a seeker gets no URL for hider-only media');

-- ---------------------------------------------------------------- the game ends

set local role authenticated;
select pg_temp.host();
select public.end_game(pg_temp.gid(), pg_temp.uid(20), pg_temp.seq());

select pg_temp.sam();
select is((public.get_replay(pg_temp.gid()) -> 'events') @> '[{"type":"bar_chosen","visibility":"hiders"}]'::jsonb, true,
  'after the end, seekers see the hider-only events');
select is((select array_agg(e ->> 'seq' order by (e ->> 'seq')::int) = array_agg(e ->> 'seq')
             from jsonb_array_elements(public.get_replay(pg_temp.gid()) -> 'events') e), true, 'in order');
select is(jsonb_array_length(public.get_replay(pg_temp.gid()) -> 'events'), pg_temp.seq()::int, 'every event');
select is((select count(*)::int from jsonb_array_elements(public.get_replay(pg_temp.gid()) -> 'track') t
            where t ->> 'user_id' = '22222222-2222-2222-2222-222222222222'), 2, 'and the hider''s track');
select is((public.get_replay(pg_temp.gid()) -> 'track' -> 0 ->> 'team'), 'hiders', 'oldest point first');
select is((select array_agg(m ->> 'store' order by m ->> 'store') from jsonb_array_elements(public.get_replay(pg_temp.gid()) -> 'media') m),
  array['r2', 'supabase'], 'with every media file');
select is(public.get_replay(pg_temp.gid()) ->> 'can_delete', 'false', 'a seeker may not delete it');
select pg_temp.host();
select is(public.get_replay(pg_temp.gid()) ->> 'can_delete', 'true', 'the host may');
select pg_temp.yan();
select throws_ok($$ select public.get_replay(pg_temp.gid()) $$, 'P0001', 'not_a_player', 'outsiders see nothing');
select is(jsonb_array_length(public.list_past_games()), 0, 'nor any past game');
select pg_temp.sam();
select throws_ok($$ select count(*) from public.position_track $$, '42501', null, 'the table itself stays closed');

reset role;
select is(array(select name from public.media_read_grant('33333333-3333-3333-3333-333333333333'::uuid,
                  array[current_setting('test.m_r2'), current_setting('test.m_sb')]) order by name),
  array(select unnest(array[current_setting('test.m_r2'), current_setting('test.m_sb')]) order by 1),
  'after the end, seekers read all of the game''s media');
select is(array(select name from public.media_read_grant('55555555-5555-5555-5555-555555555555'::uuid,
                  array[current_setting('test.m_r2')])),
  array[]::text[], 'outsiders still read nothing');

set local role authenticated;
select pg_temp.sam();
select is(jsonb_array_length(public.list_past_games()), 1, 'Sam''s past games list the game');
select is((public.list_past_games() -> 0 ->> 'id'), pg_temp.gid()::text, 'this one');
select is((public.list_past_games() -> 0 ->> 'can_delete'), 'false', 'without a delete for Sam');
select is((public.list_past_games() -> 0 ->> 'play_area') is not null, true, 'with its play area');
select ok((public.media_usage() ->> 'r2_bytes')::bigint >= 1234 and (public.media_usage() ->> 'r2_free_bytes')::bigint = 10000000000,
  'storage used, out of 10 GB');

-- ---------------------------------------------------------------- admin PIN

reset role;
select is(public.admin_pin_attempt('44444444-4444-4444-4444-444444444444', false), 'wrong_pin', 'a wrong PIN');
select public.admin_pin_attempt('44444444-4444-4444-4444-444444444444', false) from generate_series(1, 4);
select is(public.admin_pin_attempt('44444444-4444-4444-4444-444444444444', true), 'rate_limited',
  'after 5 tries in 15 min even the right PIN is refused');
set local role authenticated;
select pg_temp.xen();
select ok(not public.is_admin(), 'so X is not an admin');
reset role;
update public.admin_pin_attempts set at = now() - interval '16 minutes';
select is(public.admin_pin_attempt('44444444-4444-4444-4444-444444444444', true), 'ok', '15 min later the right PIN works');

-- 20 wrong tries overall (fresh anonymous users) stop everyone.
select public.admin_pin_attempt(gen_random_uuid(), false) from generate_series(1, 20);
select is(public.admin_pin_attempt('55555555-5555-5555-5555-555555555555', true), 'rate_limited',
  'many wrong tries from many users stop everyone for 15 min');
delete from public.admin_pin_attempts;

select ok(not has_table_privilege('authenticated', 'public.admins', 'insert')
      and not has_table_privilege('authenticated', 'public.admins', 'select')
      and not has_function_privilege('authenticated', 'public.admin_pin_attempt(uuid, boolean)', 'execute'),
  'no client writes to admins (only the admin-pin Edge Function)');

set local role authenticated;
select pg_temp.xen();
select ok(public.is_admin(), 'X is an admin now');
select is((public.list_past_games() -> 0 ->> 'can_delete') || '/' || (public.list_past_games() -> 0 ->> 'mine'), 'true/false',
  'admins see every ended game and may delete it');
select lives_ok($$ select public.get_replay(pg_temp.gid()) $$, 'and watch its replay');

-- ---------------------------------------------------------------- delete_game

select pg_temp.sam();
select throws_ok($$ select public.delete_game(pg_temp.gid(), pg_temp.uid(30)) $$,
  'P0001', 'host_or_admin_only', 'a player who is neither host nor admin is refused');
select pg_temp.as_user('66666666-6666-6666-6666-666666666666');
select throws_ok(format($$ select public.delete_game(%L, pg_temp.uid(31)) $$, current_setting('test.other')),
  'P0001', 'game_not_ended', 'only ended games');
select pg_temp.host();
select throws_ok($$ select public.delete_game(pg_temp.gid(), pg_temp.uid(32)) $$,
  'P0001', 'media_left', 'not while any media is left');

reset role;
select throws_ok($$ select public.game_delete_media('33333333-3333-3333-3333-333333333333', pg_temp.gid()) $$,
  'P0001', 'host_or_admin_only', 'the Edge Function checks the same rule');
select is(array(select store from public.game_delete_media('44444444-4444-4444-4444-444444444444', pg_temp.gid()) order by store),
  array['r2', 'supabase'], 'and gets every file to delete');
-- What the Edge Function does: delete the R2 objects and forget them, delete through the Storage API.
select is(public.media_forget(pg_temp.gid(), array[current_setting('test.m_r2')]), 1, 'R2 rows forgotten');
-- (Supabase blocks direct deletes on storage.objects unless the Storage API's setting is on.)
select set_config('storage.allow_delete_query', 'true', true);
delete from storage.objects where name = current_setting('test.m_sb');
select set_config('storage.allow_delete_query', 'false', true);

set local role authenticated;
select pg_temp.xen();
select lives_ok($$ select public.delete_game(pg_temp.gid(), pg_temp.uid(33)) $$, 'an admin deletes it');
reset role;
select ok(not exists (select 1 from public.games where id = pg_temp.gid())
      and pg_temp.rows('players') = 0 and pg_temp.rows('events') = 0 and pg_temp.rows('position_track') = 0,
  'game, players, events and track are gone');
select is(pg_temp.rows('media_objects') + (select count(*)::int from storage.objects where starts_with(name, pg_temp.gid()::text)), 0,
  'no media left');
set local role authenticated;
select pg_temp.sam();
select is(jsonb_array_length(public.list_past_games()), 0, 'it disappears from the other players'' lists');

select * from finish();
rollback;
