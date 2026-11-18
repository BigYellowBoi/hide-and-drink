-- Manual shading (20261210090000_manual_shading_type_colours.sql) and question type colours.
-- Players: H = host (hider), S = seeker.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(15);

insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('33333333-3333-3333-3333-333333333333');

select set_config('test.area_id', (select id::text from public.play_areas where city = 'brisbane' limit 1), true);

create function pg_temp.as_user(p_uid text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
$$;
create function pg_temp.seq() returns bigint language sql as $$
  select last_seq from public.games where id = current_setting('test.game_id')::uuid;
$$;
create function pg_temp.gid() returns uuid language sql as $$
  select current_setting('test.game_id')::uuid;
$$;
create function pg_temp.qid() returns uuid language sql security definer as $$
  select id from public.questions where game_id = current_setting('test.game_id')::uuid order by asked_at desc limit 1;
$$;
create function pg_temp.shading() returns jsonb language sql security definer as $$
  select manual_shading from public.questions where id = pg_temp.qid();
$$;
create function pg_temp.square() returns jsonb language sql as $$
  select '{"type":"Polygon","coordinates":[[[153.02,-27.47],[153.03,-27.47],[153.03,-27.46],[153.02,-27.46],[153.02,-27.47]]]}'::jsonb
$$;
grant execute on all functions in schema pg_temp to authenticated;

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
set local role authenticated;
select set_config('test.game_id',
  public.create_game('Host', 'dddddddd-0000-0000-0000-000000000001', 'brisbane', '{"hiding_period_s":1800}'::jsonb) ->> 'game_id', true);
select set_config('test.code', (select code from public.games where id = pg_temp.gid()), true);
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select public.join_game(current_setting('test.code'), 'Sam', 'dddddddd-0000-0000-0000-000000000002');
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select public.set_team(pg_temp.gid(), 'hiders', 'dddddddd-0000-0000-0000-000000000010');
select public.set_team(pg_temp.gid(), 'seekers', 'dddddddd-0000-0000-0000-000000000011', '33333333-3333-3333-3333-333333333333');
select public.set_play_area(pg_temp.gid(), current_setting('test.area_id')::uuid, 'dddddddd-0000-0000-0000-000000000012', pg_temp.seq());
select public.start_game(pg_temp.gid(), 'dddddddd-0000-0000-0000-000000000013', pg_temp.seq());
reset role;
update public.games set round_started_at = now() - interval '31 minutes' where id = pg_temp.gid();
set local role authenticated;

select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select public.ask_question(pg_temp.gid(), 'radar', '1km', '{"center":[153.0251,-27.4698]}', 'dddddddd-0000-0000-0000-000000000020', pg_temp.seq());

select throws_ok(
  format($$ select public.set_question_shading(pg_temp.gid(), %L, '{"mode":"none"}', 'dddddddd-0000-0000-0000-000000000021', pg_temp.seq()) $$, pg_temp.qid()),
  'P0001', 'question_not_answered', 'only answered questions can be shaded by hand'
);

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select public.answer_question(pg_temp.gid(), pg_temp.qid(), 'yes', 'dddddddd-0000-0000-0000-000000000022', pg_temp.seq());

select throws_ok(
  format($$ select public.set_question_shading(pg_temp.gid(), %L, '{"mode":"none"}', 'dddddddd-0000-0000-0000-000000000023', pg_temp.seq()) $$, pg_temp.qid()),
  'P0001', 'seekers_only', 'hiders cannot shade'
);

select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select throws_ok(
  format($$ select public.set_question_shading(pg_temp.gid(), %L, '{"mode":"keep"}', 'dddddddd-0000-0000-0000-000000000024', pg_temp.seq()) $$, pg_temp.qid()),
  'P0001', 'invalid_shading', 'keep needs an area'
);
select throws_ok(
  format($$ select public.set_question_shading(pg_temp.gid(), %L, '{"mode":"cut","area":{"type":"Point","coordinates":[153,-27]}}', 'dddddddd-0000-0000-0000-000000000025', pg_temp.seq()) $$, pg_temp.qid()),
  'P0001', 'invalid_shading', 'the area must be a polygon'
);
select throws_ok(
  format($$ select public.set_question_shading(pg_temp.gid(), %L, '{"mode":"flip"}', 'dddddddd-0000-0000-0000-000000000026', pg_temp.seq()) $$, pg_temp.qid()),
  'P0001', 'invalid_shading', 'unknown modes are refused'
);
select throws_ok(
  $$ select public.set_question_shading(pg_temp.gid(), gen_random_uuid(), '{"mode":"none"}', 'dddddddd-0000-0000-0000-000000000027', pg_temp.seq()) $$,
  'P0001', 'question_not_found', 'unknown question'
);
select throws_ok(
  format($$ select public.set_question_shading(pg_temp.gid(), %L, '{"mode":"none"}', 'dddddddd-0000-0000-0000-000000000028', 1) $$, pg_temp.qid()),
  'P0001', 'stale_state', 'shading needs an up-to-date view'
);

select lives_ok(
  format($$ select public.set_question_shading(pg_temp.gid(), %L, jsonb_build_object('mode','cut','area',pg_temp.square()), 'dddddddd-0000-0000-0000-000000000029', pg_temp.seq()) $$, pg_temp.qid()),
  'a seeker rules out a drawn area'
);
select is(pg_temp.shading() ->> 'mode', 'cut', 'the mode is stored');
select is(pg_temp.shading() -> 'area' ->> 'type', 'MultiPolygon', 'the area is stored as a MultiPolygon');

reset role;
select is(
  (select payload ->> 'question_id' from public.events where game_id = pg_temp.gid() and type = 'question_shading_set' order by seq desc limit 1),
  pg_temp.qid()::text,
  'question_shading_set is logged'
);
select is(
  (select visibility::text from public.events where game_id = pg_temp.gid() and type = 'question_shading_set' order by seq desc limit 1),
  'all', 'both teams see manual shading'
);
set local role authenticated;

select lives_ok(
  format($$ select public.set_question_shading(pg_temp.gid(), %L, null, 'dddddddd-0000-0000-0000-000000000030', pg_temp.seq()) $$, pg_temp.qid()),
  'back to the app''s shading'
);
select is(pg_temp.shading(), null, 'null clears the manual shading');

reset role;
select is(
  (select count(*)::int from public.question_types where extra ? 'colour'),
  (select count(*)::int from public.question_types),
  'every question type has a colour'
);

select * from finish();
rollback;
