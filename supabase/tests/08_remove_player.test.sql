-- Host removes a player from the lobby.
-- Players: H = host, A = player, S = player.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(11);

insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333');

create function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$$;
create function pg_temp.seq() returns bigint language sql as $$
  select last_seq from public.games where id = current_setting('test.game_id')::uuid;
$$;

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
set local role authenticated;
select set_config('test.game_id',
  public.create_game('Host', 'dddddddd-0000-0000-0000-000000000001', 'brisbane', '{}'::jsonb) ->> 'game_id', true);
select set_config('test.code', (select code from public.games where id = current_setting('test.game_id')::uuid), true);

select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select public.join_game(current_setting('test.code'), 'Amy', 'dddddddd-0000-0000-0000-000000000002');
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select public.join_game(current_setting('test.code'), 'Sam', 'dddddddd-0000-0000-0000-000000000003');

-- Sam (not host) can't remove Amy.
select throws_ok(
  $$ select public.remove_player(current_setting('test.game_id')::uuid, '22222222-2222-2222-2222-222222222222',
       'dddddddd-0000-0000-0000-000000000010', pg_temp.seq()) $$,
  'P0001', 'host_only', 'only the host can remove players'
);

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select throws_ok(
  $$ select public.remove_player(current_setting('test.game_id')::uuid, '11111111-1111-1111-1111-111111111111',
       'dddddddd-0000-0000-0000-000000000011', pg_temp.seq()) $$,
  'P0001', 'cannot_remove_host', 'the host cannot remove themselves'
);
select throws_ok(
  $$ select public.remove_player(current_setting('test.game_id')::uuid, '22222222-2222-2222-2222-222222222222',
       'dddddddd-0000-0000-0000-000000000012', pg_temp.seq() - 1) $$,
  'P0001', 'stale_state', 'removing needs an up-to-date view'
);
select lives_ok(
  $$ select public.remove_player(current_setting('test.game_id')::uuid, '22222222-2222-2222-2222-222222222222',
       'dddddddd-0000-0000-0000-000000000013', pg_temp.seq()) $$,
  'the host removes Amy'
);
select is(
  public.remove_player(current_setting('test.game_id')::uuid, '22222222-2222-2222-2222-222222222222',
    'dddddddd-0000-0000-0000-000000000013', 0) ->> 'seq',
  pg_temp.seq()::text,
  'a retried removal returns the same result'
);
select is((select count(*)::int from public.players where game_id = current_setting('test.game_id')::uuid), 2,
  'Amy is no longer a player');
select is(
  (select payload ->> 'name' from public.events where game_id = current_setting('test.game_id')::uuid and seq = pg_temp.seq()),
  'Amy', 'player_removed event names the player'
);
select throws_ok(
  $$ select public.remove_player(current_setting('test.game_id')::uuid, '22222222-2222-2222-2222-222222222222',
       'dddddddd-0000-0000-0000-000000000014', pg_temp.seq()) $$,
  'P0001', 'player_not_found', 'removing someone not in the game fails'
);

-- Amy loses access straight away.
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select is((select count(*)::int from public.events where game_id = current_setting('test.game_id')::uuid), 0,
  'a removed player can no longer read the game');
select ok(not public.can_join_topic('game:' || current_setting('test.game_id')), 'nor join its live topic');

-- Teams lock at start.
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
reset role;
update public.games set status = 'hiding' where id = current_setting('test.game_id')::uuid;
set local role authenticated;
select throws_ok(
  $$ select public.remove_player(current_setting('test.game_id')::uuid, '33333333-3333-3333-3333-333333333333',
       'dddddddd-0000-0000-0000-000000000015', pg_temp.seq()) $$,
  'P0001', 'teams_locked', 'players can only be removed in the lobby'
);

select * from finish();
rollback;
