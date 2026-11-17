-- Game actions, sequencing, idempotency and team isolation.
-- Run with `supabase test db` (CI) or scripts/test-db/run.sh (plain Postgres fallback).
--
-- Players: H = host (hiders), A = hider, S = seeker, O = outsider (not in the game).
-- Acting as a player: set request.jwt.claims, then switch to the authenticated role.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(37);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'host@test.local'),
  ('22222222-2222-2222-2222-222222222222', 'hider@test.local'),
  ('33333333-3333-3333-3333-333333333333', 'seeker@test.local'),
  ('44444444-4444-4444-4444-444444444444', 'outsider@test.local');

-- ---------------------------------------------------------------- create / join

select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
set local role authenticated;

select lives_ok(
  $$ select set_config('test.created', public.create_game('Louis', 'aaaaaaaa-0000-0000-0000-000000000001')::text, true) $$,
  'host can create a game'
);
select is(
  public.create_game('Louis', 'aaaaaaaa-0000-0000-0000-000000000001'),
  current_setting('test.created')::jsonb,
  'retrying create_game with the same client_action_id returns the same result'
);

reset role;
select set_config('test.game_id', current_setting('test.created')::jsonb ->> 'game_id', true);
select set_config('test.code', current_setting('test.created')::jsonb ->> 'code', true);

select is((select count(*)::int from public.games where host_id = '11111111-1111-1111-1111-111111111111'), 1,
  'the retry did not create a second game');
select matches(current_setting('test.code'), '^[A-HJ-NP-Z]{4}$', 'join code is 4 unambiguous letters');

select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
set local role authenticated;
select lives_ok(
  $$ select public.join_game(current_setting('test.code'), 'Amy', 'aaaaaaaa-0000-0000-0000-000000000002') $$,
  'a player can join by code'
);
select is(
  (public.join_game(current_setting('test.code'), 'Amy', 'aaaaaaaa-0000-0000-0000-000000000099') ->> 'rejoined')::boolean,
  true,
  'joining again from a new session rejoins without a duplicate player'
);

select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
set local role authenticated;
select lives_ok(
  $$ select public.join_game('  ' || lower(current_setting('test.code')) || ' ', 'Sam', 'aaaaaaaa-0000-0000-0000-000000000003') $$,
  'join code is case and whitespace tolerant'
);
select throws_ok(
  $$ select public.join_game('ZZZZZZ', 'Sam', 'aaaaaaaa-0000-0000-0000-000000000004') $$,
  'P0001', 'game_not_found', 'unknown join code is refused'
);
select throws_ok(
  $$ select public.join_game(current_setting('test.code'), 'Sam', 'aaaaaaaa-0000-0000-0000-000000000001') $$,
  'P0001', 'client_action_id_in_use', 'another user cannot reuse someone else''s client_action_id'
);

-- ---------------------------------------------------------------- teams

select lives_ok(
  $$ select public.set_team(current_setting('test.game_id')::uuid, 'seekers', 'aaaaaaaa-0000-0000-0000-000000000005') $$,
  'seeker picks seekers'
);
select throws_ok(
  $$ select public.set_team(current_setting('test.game_id')::uuid, 'seekers', 'aaaaaaaa-0000-0000-0000-000000000006',
                            '22222222-2222-2222-2222-222222222222') $$,
  'P0001', 'host_only', 'a non-host cannot move another player'
);

select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
set local role authenticated;
select lives_ok(
  $$ select public.set_team(current_setting('test.game_id')::uuid, 'hiders', 'aaaaaaaa-0000-0000-0000-000000000007') $$,
  'hider picks hiders'
);

select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
set local role authenticated;
select lives_ok(
  $$ select public.set_team(current_setting('test.game_id')::uuid, 'hiders', 'aaaaaaaa-0000-0000-0000-000000000008') $$,
  'host picks hiders'
);
select lives_ok(
  $$ select public.set_team(current_setting('test.game_id')::uuid, 'seekers', 'aaaaaaaa-0000-0000-0000-000000000009',
                            '22222222-2222-2222-2222-222222222222') $$,
  'host can move another player'
);
select lives_ok(
  $$ select public.set_team(current_setting('test.game_id')::uuid, 'hiders', 'aaaaaaaa-0000-0000-0000-000000000010',
                            '22222222-2222-2222-2222-222222222222') $$,
  'host moves them back'
);

-- ---------------------------------------------------------------- sequencing

reset role;
select results_eq(
  $$ select seq from public.events where game_id = current_setting('test.game_id')::uuid order by seq $$,
  $$ select generate_series(1::bigint, (select last_seq from public.games where id = current_setting('test.game_id')::uuid)) $$,
  'event sequence numbers are contiguous from 1 and match games.last_seq'
);
select is(
  (select count(*)::int from public.events where game_id = current_setting('test.game_id')::uuid),
  8,
  'exactly one event per accepted action (retries and rejoins add none)'
);

-- A hider-only event (stands in for e.g. the hider's chosen bar).
select lives_ok(
  $$ select public._append_event(current_setting('test.game_id')::uuid, 'bar_chosen',
       '{"bar":"secret"}'::jsonb, 'hiders', '22222222-2222-2222-2222-222222222222') $$,
  'server appends a hider-only event'
);

-- ---------------------------------------------------------------- isolation

select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.events where type = 'bar_chosen'), 0,
  'a seeker cannot read hider-only events');
select ok((select count(*) from public.events) > 0, 'a seeker can read shared events');
select ok(not public.can_join_topic('game:' || current_setting('test.game_id') || ':hiders'),
  'a seeker cannot join the hiders topic');
select ok(public.can_join_topic('game:' || current_setting('test.game_id') || ':seekers'),
  'a seeker can join the seekers topic');
select ok(public.can_join_topic('game:' || current_setting('test.game_id')),
  'a seeker can join the shared game topic');

select set_config('realtime.topic', 'game:' || current_setting('test.game_id') || ':hiders', true);
select is((select count(*)::int from realtime.messages), 0,
  'Realtime denies a seeker on the hiders topic');
select set_config('realtime.topic', 'game:' || current_setting('test.game_id'), true);
select ok((select count(*) from realtime.messages) > 0,
  'Realtime allows a seeker on the shared topic');

select throws_ok(
  $$ insert into public.events (game_id, seq, type) values (current_setting('test.game_id')::uuid, 999, 'cheat') $$,
  '42501', null, 'clients cannot write events directly'
);
select throws_ok(
  $$ update public.games set status = 'ended' where id = current_setting('test.game_id')::uuid $$,
  '42501', null, 'clients cannot write games directly'
);
select throws_ok(
  $$ select public._append_event(current_setting('test.game_id')::uuid, 'cheat') $$,
  '42501', null, 'clients cannot call internal helpers'
);
select throws_ok(
  $$ select public.update_config(current_setting('test.game_id')::uuid, '{}'::jsonb,
       'aaaaaaaa-0000-0000-0000-000000000011', 999) $$,
  'P0001', 'host_only', 'only the host can change config'
);

select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.events where type = 'bar_chosen'), 1,
  'a hider can read hider-only events');
select ok(public.can_join_topic('game:' || current_setting('test.game_id') || ':hiders'),
  'a hider can join the hiders topic');

select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}', true);
set local role authenticated;
select is(
  (select count(*)::int from public.games) + (select count(*)::int from public.players) + (select count(*)::int from public.events),
  0,
  'an outsider sees no games, players or events'
);
select ok(not public.can_join_topic('game:' || current_setting('test.game_id')), 'an outsider cannot join the game topic');
select ok(not public.can_join_topic('not-a-topic'), 'malformed topics are refused');

-- ---------------------------------------------------------------- stale state

select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
set local role authenticated;
select throws_ok(
  $$ select public.update_config(current_setting('test.game_id')::uuid, '{"answer_deadline_s":300}'::jsonb,
       'aaaaaaaa-0000-0000-0000-000000000012', 1) $$,
  'P0001', 'stale_state', 'an action based on an out-of-date view is refused'
);
select lives_ok(
  $$ select public.update_config(current_setting('test.game_id')::uuid, '{"answer_deadline_s":300}'::jsonb,
       'aaaaaaaa-0000-0000-0000-000000000013', (select max(seq) from public.events)) $$,
  'the same action succeeds once the caller is up to date'
);

-- ---------------------------------------------------------------- broadcast

reset role;
select is(
  (select count(*)::int from realtime.messages
    where topic = 'game:' || current_setting('test.game_id') || ':hiders' and payload ->> 'type' = 'bar_chosen'),
  1,
  'hider-only events are broadcast on the hiders topic only'
);

select * from finish();
rollback;
