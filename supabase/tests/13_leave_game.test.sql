-- leave_game: leaving a lobby removes the player, hands over the host, and deletes the
-- lobby when the last player leaves. Players: H = host, A, S.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(12);

insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333');

create function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
end;
$$;
create function pg_temp.gid() returns uuid language sql as $$ select current_setting('test.game_id')::uuid $$;
grant execute on all functions in schema pg_temp to authenticated;

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
set local role authenticated;
select set_config('test.game_id',
  public.create_game('Host', 'eeeeeeee-0000-0000-0000-000000000001') ->> 'game_id', true);
select set_config('test.code', (select code from public.games where id = pg_temp.gid()), true);
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select public.join_game(current_setting('test.code'), 'Amy', 'eeeeeeee-0000-0000-0000-000000000002');
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select public.join_game(current_setting('test.code'), 'Sam', 'eeeeeeee-0000-0000-0000-000000000003');

-- The host leaves: Amy (joined first) takes over.
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is((public.leave_game(pg_temp.gid(), 'eeeeeeee-0000-0000-0000-000000000010') ->> 'deleted')::boolean,
  false, 'the host leaves a lobby with others in it');
select throws_ok(
  $$ select public.leave_game(pg_temp.gid(), 'eeeeeeee-0000-0000-0000-000000000011') $$,
  'P0001', 'not_a_player', 'leaving twice is refused'
);

select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select is((select host_id from public.games where id = pg_temp.gid()),
  '22222222-2222-2222-2222-222222222222'::uuid, 'the longest-standing player becomes host');
select is((select count(*)::int from public.players where game_id = pg_temp.gid() and is_host), 1, 'one host');
select is(
  (select payload ->> 'new_host_id' from public.events where game_id = pg_temp.gid() and type = 'player_left'),
  '22222222-2222-2222-2222-222222222222', 'player_left names the new host'
);
select is(
  (select count(*)::int from public.players where game_id = pg_temp.gid() and user_id = '11111111-1111-1111-1111-111111111111'),
  0, 'the leaver is gone'
);

-- Sam leaves: no host change.
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select public.leave_game(pg_temp.gid(), 'eeeeeeee-0000-0000-0000-000000000012');
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select is(
  (select payload -> 'new_host_id' from public.events where game_id = pg_temp.gid() and type = 'player_left' order by seq desc limit 1),
  'null'::jsonb, 'no host change when a non-host leaves'
);

-- The last player leaves: the lobby is abandoned and deleted.
select is((public.leave_game(pg_temp.gid(), 'eeeeeeee-0000-0000-0000-000000000013') ->> 'deleted')::boolean,
  true, 'the last player leaving deletes the lobby');
select is(
  (public.leave_game(pg_temp.gid(), 'eeeeeeee-0000-0000-0000-000000000013') ->> 'deleted')::boolean,
  true, 'a retried leave returns the same result'
);
reset role;
select is((select count(*)::int from public.games where id = pg_temp.gid()), 0, 'the game row is gone');
select is((select count(*)::int from public.events where game_id = pg_temp.gid()), 0, 'its events are gone');

-- Once a round has started, leaving is refused (teams are locked).
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
set local role authenticated;
select set_config('test.game_id',
  public.create_game('Host', 'eeeeeeee-0000-0000-0000-000000000020') ->> 'game_id', true);
reset role;
update public.games set status = 'hiding' where id = pg_temp.gid();
set local role authenticated;
select throws_ok(
  $$ select public.leave_game(pg_temp.gid(), 'eeeeeeee-0000-0000-0000-000000000021') $$,
  'P0001', 'teams_locked', 'cannot leave a running game on the server'
);

select * from finish();
rollback;
