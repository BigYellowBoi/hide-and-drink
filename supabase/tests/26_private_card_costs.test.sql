-- Drink costs of hider-only plays stay hider-only (20261216090000_private_card_costs.sql).
-- Players: H = host (seeker), A = hider, S = seeker. Cards are put in the hand directly.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(6);

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
-- An unplayed card of this kind straight into the hand. Returns its instance id.
create function pg_temp.to_hand(p_card text) returns uuid language sql as $$
  update public.card_instances set location = 'hand'
   where id = (select id from public.card_instances
                where game_id = pg_temp.gid() and card_id = p_card and location <> 'played'
                order by location = 'hand' desc, pile_pos limit 1)
  returning id;
$$;
create function pg_temp.play(p uuid, n int, p_choice jsonb default null) returns jsonb language plpgsql as $$
begin
  perform pg_temp.hider();
  return public.play_card(pg_temp.gid(), p, pg_temp.uid(n), pg_temp.seq(), p_choice);
end;
$$;
create function pg_temp.last_event(p_type text) returns public.events language sql as $$
  select * from public.events where game_id = pg_temp.gid() and type = p_type order by seq desc limit 1;
$$;
grant execute on all functions in schema pg_temp to authenticated;

-- ---------------------------------------------------------------- setup

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
set local role authenticated;
select set_config('test.game_id',
  public.create_game('Host', pg_temp.uid(1), 'brisbane', '{"hiding_period_s":1800,"hand_limit":6,
    "deck":{"duplicate":2,"cheers":1,"bonus_red":10}}'::jsonb) ->> 'game_id', true);
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
select public.choose_bar(pg_temp.gid(), split_part(current_setting('test.bars'), ',', 1), pg_temp.uid(9), pg_temp.seq());

reset role;
update public.games set round_started_at = now() - interval '31 minutes' where id = pg_temp.gid();
-- Give this game's Duplicate a cast cost the hiders pay.
update public.game_cards set cast_cost = 'shot' where game_id = pg_temp.gid() and card_id = 'duplicate';
select set_config('test.dup', pg_temp.to_hand('duplicate')::text, true);
select set_config('test.cheers', pg_temp.to_hand('cheers')::text, true);
set local role authenticated;

-- ---------------------------------------------------------------- hiders pay

select lives_ok(format($$ select pg_temp.play(%L, 10, '{"target":%s}') $$, current_setting('test.dup'),
    to_jsonb(current_setting('test.cheers'))),
  'duplicate with a cast cost plays');
reset role;
select is((select visibility::text from pg_temp.last_event('drink_due')), 'hiders',
  'its drink is hider-only');
select is((select count(*)::int from public.events
            where game_id = pg_temp.gid() and visibility = 'all'
              and payload ->> 'instance_id' = current_setting('test.dup')), 0,
  'no public event names the card');

-- ---------------------------------------------------------------- seekers pay

update public.game_cards set params = params || '{"cost_team":"seekers"}'
 where game_id = pg_temp.gid() and card_id = 'duplicate';
select set_config('test.dup2', pg_temp.to_hand('duplicate')::text, true);
set local role authenticated;
select lives_ok(format($$ select pg_temp.play(%L, 11, '{"target":%s}') $$, current_setting('test.dup2'),
    to_jsonb(current_setting('test.cheers'))),
  'a second duplicate the seekers pay for plays');
reset role;
select is((select visibility::text from pg_temp.last_event('drink_due')), 'all', 'the seekers see their drink');
select is((select array[payload ->> 'label', payload ->> 'instance_id'] from pg_temp.last_event('drink_due')),
  array['Hider card', null], 'but not which card');

select * from finish();
rollback;
