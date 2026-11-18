-- Playtest tools and cast cost payer (20261213090000_playtest_tools_curse_cost.sql).
-- Players: H = host (seeker), A = hider, S = seeker.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(16);

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
create function pg_temp.host() returns void language sql as $$
  select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
$$;
create function pg_temp.hider() returns void language sql as $$
  select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
$$;
create function pg_temp.seeker() returns void language sql as $$
  select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
$$;
create function pg_temp.to_hand(p_card text) returns uuid language sql as $$
  update public.card_instances set location = 'hand'
   where id = (select id from public.card_instances
                where game_id = pg_temp.gid() and card_id = p_card and location = 'pile'
                order by pile_pos limit 1)
  returning id;
$$;
create function pg_temp.last_event(p_type text) returns public.events language sql as $$
  select * from public.events where game_id = pg_temp.gid() and type = p_type order by seq desc limit 1;
$$;
grant execute on all functions in schema pg_temp to authenticated;

-- ---------------------------------------------------------------- setup (playtest mode off)

select pg_temp.host();
set local role authenticated;
select set_config('test.game_id',
  public.create_game('Host', pg_temp.uid(1), 'brisbane', '{"hiding_period_s":1800,
    "deck":{"bridge":1,"jammed_door":1,"double_next_rewards":1,"bonus_red":10}}'::jsonb) ->> 'game_id', true);
select set_config('test.code', (select code from public.games where id = pg_temp.gid()), true);
select pg_temp.hider();
select public.join_game(current_setting('test.code'), 'Amy', pg_temp.uid(2));
select public.set_team(pg_temp.gid(), 'hiders', pg_temp.uid(3));
select pg_temp.seeker();
select public.join_game(current_setting('test.code'), 'Sam', pg_temp.uid(4));
select public.set_team(pg_temp.gid(), 'seekers', pg_temp.uid(5));
select pg_temp.host();
select public.set_team(pg_temp.gid(), 'seekers', pg_temp.uid(6));
select public.set_play_area(pg_temp.gid(), current_setting('test.area_id')::uuid, pg_temp.uid(7), pg_temp.seq());
select public.start_game(pg_temp.gid(), pg_temp.uid(8), pg_temp.seq());

-- Hiding started a minute ago (now() is fixed inside a transaction).
reset role;
update public.games set round_started_at = now() - interval '60 seconds' where id = pg_temp.gid();
set local role authenticated;

-- ---------------------------------------------------------------- cast cost

reset role;
select set_config('test.bridge', pg_temp.to_hand('bridge')::text, true);
select set_config('test.door', pg_temp.to_hand('jammed_door')::text, true);
set local role authenticated;
select pg_temp.hider();
select public.play_card(pg_temp.gid(), current_setting('test.bridge')::uuid, pg_temp.uid(20), pg_temp.seq());
reset role;
select is((select array[team::text, cost] from public.drink_proofs where game_id = pg_temp.gid() and label = 'Curse of Bridge' and kind = 'drink'),
  array['hiders', 'drink'], 'a curse''s drink cast cost is the hiders''');
select is((select payload ->> 'instance_id' from pg_temp.last_event('drink_due')), current_setting('test.bridge'),
  'the drink_due names the card that caused it');

update public.game_cards set params = params || '{"cost_team":"seekers"}'::jsonb
 where game_id = pg_temp.gid() and card_id = 'jammed_door';
set local role authenticated;
select pg_temp.hider();
select public.play_card(pg_temp.gid(), current_setting('test.door')::uuid, pg_temp.uid(21), pg_temp.seq());
reset role;
select is((select array[team::text, cost] from public.drink_proofs where game_id = pg_temp.gid() and label = 'Curse of Jammed Door'),
  array['seekers', 'shot'], 'params.cost_team still names the payer');

-- ---------------------------------------------------------------- off unless playtest mode

set local role authenticated;
select pg_temp.seeker();
select throws_ok($$ select public.skip_hiding(pg_temp.gid(), pg_temp.uid(30), pg_temp.seq()) $$,
  'P0001', 'playtest_only', 'skip_hiding needs playtest mode');
select pg_temp.hider();
select throws_ok($$ select public.dev_draw_cards(pg_temp.gid(), 3, pg_temp.uid(31), pg_temp.seq()) $$,
  'P0001', 'playtest_only', 'dev_draw_cards needs playtest mode');

reset role;
update public.games set config = config || '{"dev_mode":true}'::jsonb where id = pg_temp.gid();
set local role authenticated;

-- ---------------------------------------------------------------- dev_draw_cards

select pg_temp.seeker();
select throws_ok($$ select public.dev_draw_cards(pg_temp.gid(), 3, pg_temp.uid(32), pg_temp.seq()) $$,
  'P0001', 'hiders_only', 'only hiders draw');
select pg_temp.hider();
select throws_ok($$ select public.dev_draw_cards(pg_temp.gid(), 11, pg_temp.uid(33), pg_temp.seq()) $$,
  'P0001', 'invalid_choice', 'at most 10 cards');
select lives_ok($$ select public.dev_draw_cards(pg_temp.gid(), 3, pg_temp.uid(34), pg_temp.seq()) $$, 'hider draws 3');
reset role;
select is((select array[visibility::text, payload ->> 'pick', jsonb_array_length(payload -> 'cards')::text]
             from pg_temp.last_event('cards_drawn')),
  array['hiders', '3', '3'], 'a keep-all hider-only draw with no question');
select ok((select payload -> 'question_id' = 'null'::jsonb from pg_temp.last_event('cards_drawn')), 'no question');

-- ---------------------------------------------------------------- skip_hiding

set local role authenticated;
select pg_temp.seeker();
select lives_ok($$ select public.skip_hiding(pg_temp.gid(), pg_temp.uid(40), pg_temp.seq()) $$, 'any player skips hiding');
reset role;
select is((select status::text from public.games where id = pg_temp.gid()), 'seeking', 'the game is seeking');
select is((select hiding_period_s from public.games where id = pg_temp.gid()), 60, 'hiding period is the time spent');
select is((select (payload ->> 'at')::timestamptz from pg_temp.last_event('seeking_started')), now(),
  'seeking_started says it started now');
select ok(exists (select 1 from pg_temp.last_event('hiding_skipped') where actor_id is not null), 'hiding_skipped is logged');
set local role authenticated;
select pg_temp.seeker();
select throws_ok($$ select public.skip_hiding(pg_temp.gid(), pg_temp.uid(41), pg_temp.seq()) $$,
  'P0001', 'not_hiding', 'only while hiding');

select * from finish();
rollback;
