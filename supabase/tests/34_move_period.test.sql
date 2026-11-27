-- Move as a timed period (20261226090000_move_period.sql): seeking only, not in the endgame,
-- old bar to everyone, hand discarded, new bar within radius_m, seekers frozen, the period
-- ends in _settle_timers, hide time leaves it out.
-- Players: H = host (seeker), A = hider, S = seeker.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(32);

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
  select ('eeeeeeee-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid
$$;
create function pg_temp.hider() returns void language sql as $$
  select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
$$;
create function pg_temp.seeker() returns void language sql as $$
  select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
$$;
create function pg_temp.ask(n int) returns uuid language plpgsql as $$
begin
  perform pg_temp.seeker();
  return (public.ask_question(pg_temp.gid(), 'radar', '1km', '{"center":[153.025,-27.47]}',
    pg_temp.uid(n), pg_temp.seq()) ->> 'question_id')::uuid;
end;
$$;
create function pg_temp.to_hand(p_card text) returns uuid language sql as $$
  update public.card_instances set location = 'hand'
   where id = (select id from public.card_instances
                where game_id = pg_temp.gid() and card_id = p_card and location <> 'played' and location <> 'hand'
                order by pile_pos limit 1)
  returning id;
$$;
create function pg_temp.play(p uuid, n int) returns jsonb language plpgsql as $$
begin
  perform pg_temp.hider();
  return public.play_card(pg_temp.gid(), p, pg_temp.uid(n), pg_temp.seq(), null);
end;
$$;
create function pg_temp.choose(p_bar text, n int) returns jsonb language plpgsql as $$
begin
  perform pg_temp.hider();
  return public.choose_bar(pg_temp.gid(), p_bar, pg_temp.uid(n), pg_temp.seq());
end;
$$;
create function pg_temp.last_event(p_type text) returns public.events language sql as $$
  select * from public.events where game_id = pg_temp.gid() and type = p_type order by seq desc limit 1;
$$;
grant execute on all functions in schema pg_temp to authenticated;

-- ---------------------------------------------------------------- setup

select is((select params from public.cards where id = 'move'),
  '{"action": "move", "duration_s": 600, "radius_m": 1500, "discard_hand": true}'::jsonb,
  'the library Move has the period, radius and discard');

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
set local role authenticated;
select set_config('test.game_id',
  public.create_game('Host', pg_temp.uid(1), 'brisbane', '{"hiding_period_s":1800,"hand_limit":6,
    "deck":{"move":2,"veto":1,"duplicate":1,"bonus_red":10}}'::jsonb) ->> 'game_id', true);
select set_config('test.code', (select code from public.games where id = pg_temp.gid()), true);
select pg_temp.hider();
select public.join_game(current_setting('test.code'), 'Amy', pg_temp.uid(2));
select public.set_team(pg_temp.gid(), 'hiders', pg_temp.uid(3));
select pg_temp.seeker();
select public.join_game(current_setting('test.code'), 'Sam', pg_temp.uid(4));
select public.set_team(pg_temp.gid(), 'seekers', pg_temp.uid(5));
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select public.set_team(pg_temp.gid(), 'seekers', pg_temp.uid(6));
select public.set_play_area(pg_temp.gid(), current_setting('test.area_id')::uuid, pg_temp.uid(7), pg_temp.seq());
select public.start_game(pg_temp.gid(), pg_temp.uid(8), pg_temp.seq());

select pg_temp.hider();
select set_config('test.bars', array_to_string(public.hiding_bars(pg_temp.gid()), ','), true);
select set_config('test.bar1', split_part(current_setting('test.bars'), ',', 1), true);
select pg_temp.choose(current_setting('test.bar1'), 9);

reset role;
-- A bar within 1.5 km of the first and one well past it.
select set_config('test.near', (
  select b.feature_id from public._valid_bars((select g from public.games g where id = pg_temp.gid())) b,
         public.hider_bars h
   where h.game_id = pg_temp.gid() and b.feature_id <> h.venue_id
     and extensions.st_dwithin(b.geom::extensions.geography, h.geom::extensions.geography, 1400)
   order by b.feature_id limit 1), true);
select set_config('test.far', (
  select b.feature_id from public._valid_bars((select g from public.games g where id = pg_temp.gid())) b,
         public.hider_bars h
   where h.game_id = pg_temp.gid()
     and not extensions.st_dwithin(b.geom::extensions.geography, h.geom::extensions.geography, 1600)
   order by b.feature_id limit 1), true);
select isnt(current_setting('test.near'), '', 'there is a bar near the first');
select isnt(current_setting('test.far'), '', 'and one far from it');
select set_config('test.move', pg_temp.to_hand('move')::text, true);
select set_config('test.move2', pg_temp.to_hand('move')::text, true);
select set_config('test.veto', pg_temp.to_hand('veto')::text, true);
set local role authenticated;

-- ---------------------------------------------------------------- refusals

select throws_ok(format($$ select pg_temp.play(%L, 10) $$, current_setting('test.move')),
  'P0001', 'not_seeking_yet', 'no Move during the hiding period');

reset role;
update public.games set round_started_at = now() - interval '31 minutes' where id = pg_temp.gid();
update public.hider_bars set frozen = true where game_id = pg_temp.gid();
set local role authenticated;
select throws_ok(format($$ select pg_temp.play(%L, 11) $$, current_setting('test.move')),
  'P0001', 'endgame', 'no Move while a seeker is inside the bar zone (endgame)');
reset role;
update public.hider_bars set frozen = false where game_id = pg_temp.gid();
set local role authenticated;

-- ---------------------------------------------------------------- play

select lives_ok(format($$ select pg_temp.play(%L, 12) $$, current_setting('test.move')), 'hider plays Move');
reset role;
select is((select visibility::text from pg_temp.last_event('move_started')), 'all', 'move_started is public');
select is((select (payload ->> 'radius_m')::numeric from pg_temp.last_event('move_started')), 1500::numeric,
  'with the radius');
select is((select payload -> 'from' ->> 'name' from pg_temp.last_event('move_started')),
  (select venue_name from public.hider_bars where game_id = pg_temp.gid()), 'and the old bar');
select ok((select payload -> 'from' ? 'lng' and payload -> 'from' ? 'lat' from pg_temp.last_event('move_started')),
  'with its location');
select is((select (payload ->> 'ends_at')::timestamptz from pg_temp.last_event('move_started')),
  now() + interval '10 minutes', 'ends 10 minutes on');
select is((select count(*)::int from public.card_instances where game_id = pg_temp.gid() and location = 'hand'), 0,
  'the hand is discarded');
select is((select location from public.card_instances where id = current_setting('test.veto')::uuid), 'discarded',
  'other cards included');
select is((select array[visibility::text, jsonb_array_length(payload -> 'cards')::text] from pg_temp.last_event('hand_discarded')),
  array['hiders', '2'], 'hand_discarded is hider-only and lists them');
select is(public._move_paused_s(pg_temp.gid(), 1, now() - interval '1 hour', now() + interval '5 minutes'), 300,
  'the hide timer is paused while it runs');
set local role authenticated;

-- ---------------------------------------------------------------- frozen seekers, picking

select throws_ok($$ select pg_temp.ask(20) $$, 'P0001', 'hider_moving', 'seekers cannot ask');
select pg_temp.seeker();
select throws_ok($$ select public.found_hider(pg_temp.gid(), pg_temp.uid(21), pg_temp.seq()) $$,
  'P0001', 'hider_moving', 'or find them');
select throws_ok(format($$ select pg_temp.choose(%L, 22) $$, current_setting('test.far')),
  'P0001', 'too_far_to_move', 'new bar must be within the radius');
select lives_ok(format($$ select pg_temp.choose(%L, 23) $$, current_setting('test.near')), 'hider picks a near bar');
reset role;
select is((select array[visibility::text, payload ->> 'move_open'] from pg_temp.last_event('bar_chosen')),
  array['hiders', 'true'], 'the pick is hider-only and the move stays open');
select is((select count(*)::int from public.events where game_id = pg_temp.gid() and type = 'hider_moved'), 0,
  'no hider_moved yet');
set local role authenticated;
select lives_ok(format($$ select pg_temp.choose(%L, 24) $$, current_setting('test.bar1')),
  'hider can change their mind, back to the old bar too');
select lives_ok($$ select public.settle_timers(pg_temp.gid(), pg_temp.uid(25)) $$, 'settling early');
reset role;
select is((select count(*)::int from public.events where game_id = pg_temp.gid() and type = 'hider_moved'), 0,
  'does not end the period');

-- ---------------------------------------------------------------- period over

update public.hider_bars set move_ends_at = now() where game_id = pg_temp.gid();
set local role authenticated;
select pg_temp.seeker();
select lives_ok($$ select public.settle_timers(pg_temp.gid(), pg_temp.uid(26)) $$, 'settling at the end');
reset role;
select is((select array[visibility::text, coalesce(actor_id::text, 'none'), (payload ? 'lng')::text]
             from pg_temp.last_event('hider_moved')),
  array['all', 'none', 'false'], 'public hider_moved, no actor, no location');
select is((select move_pending from public.hider_bars where game_id = pg_temp.gid()), false, 'the move is over');
select is((select venue_id from public.hider_bars where game_id = pg_temp.gid()), current_setting('test.bar1'),
  'at the last pick');
select is(public._push_for_event('move_started', 'all', (pg_temp.last_event('move_started')).payload) ->> 'audience',
  'seekers', 'move_started pushes to the seekers');
select is(public._push_for_event('hider_moved', 'all', (pg_temp.last_event('hider_moved')).payload) ->> 'audience',
  'seekers', 'and so does the end of the period');
set local role authenticated;
select lives_ok($$ select pg_temp.ask(27) $$, 'seekers can ask again');
select throws_ok(format($$ select pg_temp.choose(%L, 28) $$, current_setting('test.near')),
  'P0001', 'bar_already_chosen', 'no more picks after the period');

select * from finish();
rollback;
