-- Saved play areas: creator name, deleting clutter, protected built-ins, areas in use.
-- Players: H = host (Hana), A = another player (Amy).

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(11);

insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');

create function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$$;
create function pg_temp.seq() returns bigint language sql as $$
  select last_seq from public.games where id = current_setting('test.game_id')::uuid;
$$;
create function pg_temp.save(p_name text, p_action uuid) returns uuid language sql as $$
  select (public.save_play_area(current_setting('test.game_id')::uuid, p_action, pg_temp.seq(), p_name,
    '{"type":"Polygon","coordinates":[[[153.02,-27.47],[153.03,-27.47],[153.03,-27.46],[153.02,-27.46],[153.02,-27.47]]]}'::jsonb)
    ->> 'play_area_id')::uuid;
$$;

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
set local role authenticated;
select set_config('test.game_id',
  public.create_game('Hana', 'ffffffff-0000-0000-0000-000000000001') ->> 'game_id', true);

select set_config('test.test_map', pg_temp.save('Test map', 'ffffffff-0000-0000-0000-000000000010')::text, true);
select set_config('test.real_map', pg_temp.save('Real map', 'ffffffff-0000-0000-0000-000000000011')::text, true);

select is((select creator_name from public.play_areas where id = current_setting('test.test_map')::uuid), 'Hana',
  'a saved area records who made it');
select ok((select created_at > now() - interval '1 minute' from public.play_areas where id = current_setting('test.test_map')::uuid),
  'and when');

-- Amy is in no game at all: any signed-in player may tidy the list.
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');

select throws_ok(
  $$ select public.delete_play_area(current_setting('test.real_map')::uuid, 'ffffffff-0000-0000-0000-000000000020') $$,
  'P0001', 'play_area_in_use', 'an area an open lobby has chosen cannot be deleted'
);
select throws_ok(
  $$ select public.delete_play_area((select id from public.play_areas where created_by is null limit 1),
       'ffffffff-0000-0000-0000-000000000021') $$,
  'P0001', 'play_area_protected', 'built-in areas cannot be deleted'
);
select throws_ok(
  $$ select public.delete_play_area('00000000-0000-0000-0000-000000000000', 'ffffffff-0000-0000-0000-000000000022') $$,
  'P0001', 'play_area_not_found', 'deleting a missing area fails'
);
select lives_ok(
  $$ select public.delete_play_area(current_setting('test.test_map')::uuid, 'ffffffff-0000-0000-0000-000000000023') $$,
  'any player can delete a test map'
);
select is((select count(*)::int from public.play_areas where id = current_setting('test.test_map')::uuid), 0,
  'it is gone');
select is(
  public.delete_play_area(current_setting('test.test_map')::uuid, 'ffffffff-0000-0000-0000-000000000023') ->> 'name',
  'Test map', 'a retried delete returns the same result');
select is((select count(*)::int from public.events where game_id = current_setting('test.game_id')::uuid
             and type not in ('game_created', 'play_area_changed')), 0,
  'deleting adds no game event');

-- Once the game starts, the lobby no longer holds the area: it can go (the game has a snapshot).
reset role;
update public.games set status = 'hiding', play_area_snapshot = '{"type":"FeatureCollection","features":[]}'
 where id = current_setting('test.game_id')::uuid;
set local role authenticated;
select lives_ok(
  $$ select public.delete_play_area(current_setting('test.real_map')::uuid, 'ffffffff-0000-0000-0000-000000000024') $$,
  'an area used only by a started game can be deleted'
);
reset role;
select isnt((select play_area_snapshot from public.games where id = current_setting('test.game_id')::uuid), null,
  'the started game keeps its snapshot');

select * from finish();
rollback;
