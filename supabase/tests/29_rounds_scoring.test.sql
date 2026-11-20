-- Rounds, scoring and ending a game (20261219090100_rounds_scoring.sql): found_hider scores the
-- round and swaps teams, start_next_round, end_game with the winner, adjust_score and
-- redo_round overrides, auto-end after 24 h, join codes freed by ended games.
-- Players: H = host (seeker), A = hider, S = seeker.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(50);

insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333');

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
  select ('ffffffff-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid
$$;
create function pg_temp.host() returns void language sql as $$
  select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
$$;
create function pg_temp.amy() returns void language sql as $$
  select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
$$;
create function pg_temp.sam() returns void language sql as $$
  select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
$$;
create function pg_temp.team(p uuid) returns text language sql security definer as $$
  select team::text from public.players where game_id = pg_temp.gid() and user_id = p;
$$;
create function pg_temp.status() returns text language sql security definer as $$
  select status::text from public.games where id = pg_temp.gid();
$$;
create function pg_temp.last_event(p_type text) returns public.events language sql security definer as $$
  select * from public.events where game_id = pg_temp.gid() and type = p_type order by seq desc limit 1;
$$;
create function pg_temp.fix(p_kind text, p_params jsonb, n int) returns jsonb language plpgsql as $$
begin
  perform pg_temp.host();
  return public.host_override(pg_temp.gid(), p_kind, p_params, 'test', pg_temp.uid(n), pg_temp.seq());
end;
$$;
grant execute on all functions in schema pg_temp to authenticated;

-- ---------------------------------------------------------------- setup

select pg_temp.host();
set local role authenticated;
select set_config('test.game_id',
  public.create_game('Host', pg_temp.uid(1), 'brisbane', '{"hiding_period_s":1800,"hand_limit":6,
    "deck":{"bonus_red":10,"veto":2}}'::jsonb) ->> 'game_id', true);
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
select public.start_game(pg_temp.gid(), pg_temp.uid(8), pg_temp.seq());

-- ---------------------------------------------------------------- found_hider

select pg_temp.sam();
select throws_ok($$ select public.found_hider(pg_temp.gid(), pg_temp.uid(10), pg_temp.seq()) $$,
  'P0001', 'not_seeking_yet', 'not during the hiding period');
select pg_temp.amy();
select throws_ok($$ select public.found_hider(pg_temp.gid(), pg_temp.uid(11), pg_temp.seq()) $$,
  'P0001', 'seekers_only', 'only seekers say they found them');

-- Seeking started 40 minutes ago (hiding 30 min, round started 70 min ago); two 2-minute bonuses in hand.
reset role;
update public.games set round_started_at = now() - interval '70 minutes' where id = pg_temp.gid();
update public.card_instances set location = 'hand'
 where id in (select id from public.card_instances where game_id = pg_temp.gid() and card_id = 'bonus_red'
               order by pile_pos limit 2);
update public.card_instances set location = 'hand'
 where id in (select id from public.card_instances where game_id = pg_temp.gid() and card_id = 'veto'
               order by pile_pos limit 1);
insert into public.hider_bars (game_id, round, venue_id, venue_name, geom, chosen_by)
values (pg_temp.gid(), 1, 'test:bar', 'Test Bar', extensions.st_setsrid(extensions.st_makepoint(153.025, -27.47), 4326),
        '22222222-2222-2222-2222-222222222222');
set local role authenticated;

select pg_temp.sam();
select lives_ok($$ select public.found_hider(pg_temp.gid(), pg_temp.uid(12), pg_temp.seq()) $$, 'a seeker found them');
select lives_ok($$ select public.found_hider(pg_temp.gid(), pg_temp.uid(12), pg_temp.seq()) $$, 'a retry is idempotent');
reset role;
select is(pg_temp.status(), 'round_over', 'the round is over');
select ok((select (payload -> 'score' ->> 'hide_s')::int between 2395 and 2405 from pg_temp.last_event('round_ended')),
  'hide time: from the end of hiding to the find (40 min)');
select is((select (payload -> 'score' ->> 'bonus_s')::int from pg_temp.last_event('round_ended')), 240,
  'bonus: the time bonuses in the hand (2 × 2 min)');
select is((select payload -> 'bar' ->> 'name' from pg_temp.last_event('round_ended')), 'Test Bar',
  'the bar is revealed to everyone');
select is((select visibility::text from pg_temp.last_event('round_ended')), 'all', 'round_ended is public');
select is((select payload -> 'score' -> 'hiders' -> 0 ->> 'name' from pg_temp.last_event('round_ended')), 'Amy',
  'the round is credited to its hiders');
select is(array[pg_temp.team('11111111-1111-1111-1111-111111111111'), pg_temp.team('22222222-2222-2222-2222-222222222222'),
                pg_temp.team('33333333-3333-3333-3333-333333333333')],
  array['hiders', 'seekers', 'hiders'], 'teams swap');
select is((select count(*)::int from public.events where game_id = pg_temp.gid() and type = 'team_changed'
             and payload ->> 'swap' = 'true' and actor_id is null), 3, 'one team_changed each, no actor');
select is((select array[audience::text, title] from public.push_outbox where game_id = pg_temp.gid()
            and title = 'Found!' limit 1), array['all', 'Found!'], 'everyone hears it');
set local role authenticated;

-- Between rounds: nothing in-round works, nothing settles.
select pg_temp.amy();
select throws_ok($$ select public.ask_question(pg_temp.gid(), 'radar', '1km', '{"center":[153.025,-27.47]}', pg_temp.uid(13), pg_temp.seq()) $$,
  'P0001', 'round_not_running', 'no questions between rounds');
select is(public.settle_timers(pg_temp.gid(), pg_temp.uid(14)) ->> 'settled', '0', 'nothing settles between rounds');

-- The host can move players between rounds.
select pg_temp.host();
select lives_ok($$ select public.set_team(pg_temp.gid(), 'seekers', pg_temp.uid(15), '22222222-2222-2222-2222-222222222222') $$,
  'teams can change between rounds');

-- ---------------------------------------------------------------- overrides

select throws_ok($$ select pg_temp.fix('adjust_score', '{"round":1,"seconds":0}', 20) $$,
  'P0001', 'invalid_override', 'adjust_score needs a change');
select throws_ok($$ select pg_temp.fix('adjust_score', '{"round":7,"seconds":60}', 21) $$,
  'P0001', 'round_not_found', 'adjust_score needs a scored round');
select pg_temp.sam();
select throws_ok($$ select public.host_override(pg_temp.gid(), 'adjust_score', '{"round":1,"seconds":60}', 'x', pg_temp.uid(22), pg_temp.seq()) $$,
  'P0001', 'host_only', 'only the host adjusts scores');
select lives_ok($$ select pg_temp.fix('adjust_score', '{"round":1,"seconds":-300}', 23) $$, 'host takes 5 minutes off');
reset role;
select is((select adjust_s from public.game_rounds where game_id = pg_temp.gid() and round = 1), -300, 'stored');
select is((select payload ->> 'summary' from pg_temp.last_event('override')), 'Round 1: −5 min for Amy', 'summary');
select is((select (payload -> 'score' ->> 'total_s')::int - (payload -> 'score' ->> 'hide_s')::int
             from pg_temp.last_event('score_adjusted')), -60, 'score_adjusted carries the new total');
select ok((select payload ? 'override_id' from pg_temp.last_event('score_adjusted')), 'tagged with the override');
set local role authenticated;

-- ---------------------------------------------------------------- start_next_round

-- Now: Host and Sam hide, Amy seeks.
select pg_temp.amy();
select throws_ok($$ select public.start_next_round(pg_temp.gid(), pg_temp.uid(34), pg_temp.seq()) $$,
  'P0001', 'hiders_only', 'a seeker can''t start the next round');
select pg_temp.sam();
select lives_ok($$ select public.start_next_round(pg_temp.gid(), pg_temp.uid(35), pg_temp.seq()) $$,
  'the next round''s hider starts it');
reset role;
select is(pg_temp.status(), 'hiding', 'round 2 hiding');
select is((select array[payload ->> 'round', payload ->> 'next_round', (payload -> 'play_area' ->> 'id')]
             from pg_temp.last_event('game_started')),
  array['2', 'true', current_setting('test.area_id')], 'game_started for round 2, same play area');
select is((select count(*)::int from public.card_instances where game_id = pg_temp.gid() and round = 2), 12,
  'a fresh deck for round 2');
set local role authenticated;

-- ---------------------------------------------------------------- redo_round

select lives_ok($$ select pg_temp.fix('redo_round', '{}', 40) $$, 'host redoes the running round');
reset role;
select is(pg_temp.status(), 'round_over', 'back between rounds');
select is((select voided from public.game_rounds where game_id = pg_temp.gid() and round = 2), true,
  'the redone round doesn''t count');
select is(pg_temp.team('33333333-3333-3333-3333-333333333333'), 'hiders', 'the same hider plays it again');
set local role authenticated;
select pg_temp.sam();
select public.start_next_round(pg_temp.gid(), pg_temp.uid(41), pg_temp.seq());
reset role;
update public.games set round_started_at = now() - interval '40 minutes' where id = pg_temp.gid();
set local role authenticated;
select pg_temp.amy();
select public.found_hider(pg_temp.gid(), pg_temp.uid(42), pg_temp.seq());
-- Round 3 scored 10 min, then redone after the find: teams go back.
select lives_ok($$ select pg_temp.fix('redo_round', '{}', 43) $$, 'host redoes a round just found');
reset role;
select is(pg_temp.team('33333333-3333-3333-3333-333333333333'), 'hiders', 'teams back as they were for that round');
select is((select count(*)::int from public.game_rounds where game_id = pg_temp.gid() and not voided), 1,
  'only round 1 counts');
set local role authenticated;
select throws_ok($$ select pg_temp.fix('redo_round', '{}', 44) $$, 'P0001', 'round_not_found', 'redone once');

-- ---------------------------------------------------------------- end_game

select pg_temp.amy();
select throws_ok($$ select public.end_game(pg_temp.gid(), pg_temp.uid(50), pg_temp.seq()) $$,
  'P0001', 'host_only', 'only the host ends the game');
select pg_temp.host();
select lives_ok($$ select public.end_game(pg_temp.gid(), pg_temp.uid(51), pg_temp.seq()) $$, 'host ends the game');
reset role;
select is(pg_temp.status(), 'ended', 'ended');
select is((select payload -> 'winners' from pg_temp.last_event('game_ended')),
  '["22222222-2222-2222-2222-222222222222"]'::jsonb, 'Amy, who hid round 1, wins');
select is((select array[payload ->> 'reason', (payload -> 'players' -> 0 ->> 'total_s')]
             from pg_temp.last_event('game_ended')),
  array['host', ((select hide_s + bonus_s + adjust_s from public.game_rounds where game_id = pg_temp.gid() and round = 1))::text],
  'result: reason and totals');
select is((select jsonb_array_length(payload -> 'rounds') from pg_temp.last_event('game_ended')), 3,
  'every round is in the result (voided ones flagged)');
set local role authenticated;
select pg_temp.host();
select throws_ok($$ select public.end_game(pg_temp.gid(), pg_temp.uid(52), pg_temp.seq()) $$,
  'P0001', 'game_ended', 'ended once');

-- ---------------------------------------------------------------- codes return to the pool

select throws_ok(format($$ select public.join_game(%L, 'Zed', pg_temp.uid(53)) $$, current_setting('test.code')),
  'P0001', 'game_not_found', 'an ended game can''t be joined by code');
reset role;
select lives_ok(format($$ insert into public.games (code, host_id) values (%L, '11111111-1111-1111-1111-111111111111') $$,
  current_setting('test.code')), 'its code can be used by a new game');
select throws_ok(format($$ insert into public.games (code, host_id) values (%L, '11111111-1111-1111-1111-111111111111') $$,
  current_setting('test.code')), '23505', null, 'but only by one game that isn''t ended');

-- ---------------------------------------------------------------- auto-end

set local role authenticated;
select pg_temp.host();
select set_config('test.game_id',
  public.create_game('Host', pg_temp.uid(60), 'brisbane', '{"hiding_period_s":1800}'::jsonb) ->> 'game_id', true);
select set_config('test.code', (select code from public.games where id = pg_temp.gid()), true);
select pg_temp.amy();
select public.join_game(current_setting('test.code'), 'Amy', pg_temp.uid(61));
select public.set_team(pg_temp.gid(), 'hiders', pg_temp.uid(62));
select pg_temp.host();
select public.set_team(pg_temp.gid(), 'seekers', pg_temp.uid(63));
select public.set_play_area(pg_temp.gid(), current_setting('test.area_id')::uuid, pg_temp.uid(64), pg_temp.seq());
select public.start_game(pg_temp.gid(), pg_temp.uid(65), pg_temp.seq());
select is(public.end_stale_games(), 0, 'a game with recent events keeps going');
reset role;
alter table public.events disable trigger events_append_only;
update public.events set created_at = now() - interval '25 hours' where game_id = pg_temp.gid();
alter table public.events enable trigger events_append_only;
set local role authenticated;
select is(public.end_stale_games(), 1, 'a day without events ends it');
reset role;
-- Nothing happened in it, so it is deleted rather than ended (20261224090000_tidy_abandoned_games.sql).
select is((select count(*)::int from public.games where id = pg_temp.gid()), 0,
  'a game where nothing happened is deleted, not kept as a past game');

select * from finish();
rollback;
