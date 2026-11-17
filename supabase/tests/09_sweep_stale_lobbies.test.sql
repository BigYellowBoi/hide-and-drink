-- Creating a game deletes lobbies that never started and have been idle for 24 hours.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(7);

insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');

create function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$$;
create function pg_temp.new_game(p_action uuid) returns uuid language sql as $$
  select (public.create_game('Host', p_action, 'brisbane', '{}'::jsonb) ->> 'game_id')::uuid;
$$;

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
set local role authenticated;
select set_config('test.stale', pg_temp.new_game('eeeeeeee-0000-0000-0000-000000000001')::text, true);
select set_config('test.recent', pg_temp.new_game('eeeeeeee-0000-0000-0000-000000000002')::text, true);
select set_config('test.started', pg_temp.new_game('eeeeeeee-0000-0000-0000-000000000003')::text, true);
select set_config('test.code', (select code from public.games where id = current_setting('test.stale')::uuid), true);
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select public.join_game(current_setting('test.code'),
  'Amy', 'eeeeeeee-0000-0000-0000-000000000004');
reset role;

-- Age two games past 24 hours (bypassing the append-only trigger as a cascade would);
-- one of them has started, so it must survive.
set local session_replication_role = replica;
update public.games set created_at = now() - interval '25 hours'
  where id in (current_setting('test.stale')::uuid, current_setting('test.started')::uuid);
update public.events set created_at = now() - interval '25 hours'
  where game_id in (current_setting('test.stale')::uuid, current_setting('test.started')::uuid);
update public.games set status = 'hiding' where id = current_setting('test.started')::uuid;
-- The recent game is old but had activity an hour ago.
update public.games set created_at = now() - interval '3 days' where id = current_setting('test.recent')::uuid;
update public.events set created_at = now() - interval '1 hour' where game_id = current_setting('test.recent')::uuid;
set local session_replication_role = origin;

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
set local role authenticated;
select set_config('test.fresh', pg_temp.new_game('eeeeeeee-0000-0000-0000-000000000005')::text, true);
reset role;

select is((select count(*) from public.games where id = current_setting('test.stale')::uuid), 0::bigint,
  'an idle unstarted lobby is deleted');
select is((select count(*) from public.players where game_id = current_setting('test.stale')::uuid), 0::bigint,
  'its players go with it');
select is((select count(*) from public.events where game_id = current_setting('test.stale')::uuid), 0::bigint,
  'its events go with it');
select is((select count(*) from public.processed_actions where game_id = current_setting('test.stale')::uuid), 0::bigint,
  'its stored action results go with it');
select is((select count(*) from public.games where id = current_setting('test.recent')::uuid), 1::bigint,
  'a lobby with recent activity is kept');
select is((select count(*) from public.games where id = current_setting('test.started')::uuid), 1::bigint,
  'a started game is kept however old');
select is((select count(*) from public.games where id = current_setting('test.fresh')::uuid), 1::bigint,
  'the new game is created');

select * from finish();
rollback;
