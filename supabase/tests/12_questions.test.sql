-- Questions: ask, answer, deadlines and late penalties.
-- Players: H = host (seeker), A = hider, S = seeker.
-- now() is fixed inside this transaction, so the clock is "moved" by backdating rows.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(34);

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
grant execute on all functions in schema pg_temp to authenticated;

-- ---------------------------------------------------------------- setup

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
set local role authenticated;
select set_config('test.game_id',
  public.create_game('Host', 'dddddddd-0000-0000-0000-000000000001', 'brisbane',
    '{"hiding_period_s":1800,"answer_deadline_s":{"default":300,"radar":120}}'::jsonb) ->> 'game_id', true);
select set_config('test.code', (select code from public.games where id = pg_temp.gid()), true);

select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select public.join_game(current_setting('test.code'), 'Amy', 'dddddddd-0000-0000-0000-000000000002');
select public.set_team(pg_temp.gid(), 'hiders', 'dddddddd-0000-0000-0000-000000000003');
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select public.join_game(current_setting('test.code'), 'Sam', 'dddddddd-0000-0000-0000-000000000004');
select public.set_team(pg_temp.gid(), 'seekers', 'dddddddd-0000-0000-0000-000000000005');
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select public.set_team(pg_temp.gid(), 'seekers', 'dddddddd-0000-0000-0000-000000000006');
select public.set_play_area(pg_temp.gid(), current_setting('test.area_id')::uuid,
  'dddddddd-0000-0000-0000-000000000007', pg_temp.seq());

-- Before the round starts
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select throws_ok(
  $$ select public.ask_question(pg_temp.gid(), 'radar', '1km', '{"center":[153.025,-27.47]}',
       'dddddddd-0000-0000-0000-000000000008', pg_temp.seq()) $$,
  'P0001', 'round_not_running', 'no questions in the lobby'
);

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select public.start_game(pg_temp.gid(), 'dddddddd-0000-0000-0000-000000000009', pg_temp.seq());

select pg_temp.as_user('33333333-3333-3333-3333-333333333333');

-- ---------------------------------------------------------------- ask: refusals

select throws_ok(
  $$ select public.ask_question(pg_temp.gid(), 'radar', '1km', '{"center":[153.025,-27.47]}',
       'dddddddd-0000-0000-0000-000000000020', pg_temp.seq()) $$,
  'P0001', 'still_hiding', 'no questions during the hiding period'
);

reset role;
update public.games set round_started_at = now() - interval '31 minutes' where id = pg_temp.gid();
set local role authenticated;

select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select throws_ok(
  $$ select public.ask_question(pg_temp.gid(), 'radar', '1km', '{"center":[153.025,-27.47]}',
       'dddddddd-0000-0000-0000-000000000021', pg_temp.seq()) $$,
  'P0001', 'seekers_only', 'hiders cannot ask'
);

select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select throws_ok(
  $$ select public.ask_question(pg_temp.gid(), 'matching', 'suburb', '{}',
       'dddddddd-0000-0000-0000-000000000022', pg_temp.seq()) $$,
  'P0001', 'invalid_position', 'map questions need the asker''s position'
);
select throws_ok(
  $$ select public.ask_question(pg_temp.gid(), 'radar', '7km', '{"center":[153.025,-27.47]}',
       'dddddddd-0000-0000-0000-000000000023', pg_temp.seq()) $$,
  'P0001', 'option_not_found', 'unknown option refused'
);
select throws_ok(
  $$ select public.ask_question(pg_temp.gid(), 'radar', '1km', '{"center":[953.025,-27.47]}',
       'dddddddd-0000-0000-0000-000000000024', pg_temp.seq()) $$,
  'P0001', 'invalid_position', 'bad position refused'
);
select throws_ok(
  $$ select public.ask_question(pg_temp.gid(), 'radar', 'custom', '{"center":[153.025,-27.47]}',
       'dddddddd-0000-0000-0000-000000000025', pg_temp.seq()) $$,
  'P0001', 'invalid_distance', 'custom radar needs a distance'
);
select throws_ok(
  $$ select public.ask_question(pg_temp.gid(), 'radar', '1km', '{"center":[153.025,-27.47]}',
       'dddddddd-0000-0000-0000-000000000026', 1) $$,
  'P0001', 'stale_state', 'asking needs an up-to-date view'
);

-- ---------------------------------------------------------------- radar

select set_config('test.q1', (public.ask_question(pg_temp.gid(), 'radar', 'custom',
  '{"center":[153.025,-27.47],"distance_m":1500}', 'dddddddd-0000-0000-0000-000000000027', pg_temp.seq())
  ->> 'question_id'), true);

select is(
  array(select type from public.events where game_id = pg_temp.gid() order by seq desc limit 2),
  array['question_asked', 'seeking_started'],
  'the first question also starts seeking (logged first)'
);
select is((select status::text from public.games where id = pg_temp.gid()), 'seeking', 'game is seeking');
select is(
  (select payload -> 'params' from public.events where game_id = pg_temp.gid() and type = 'question_asked'),
  '{"center":[153.025,-27.47],"distance_m":1500}'::jsonb,
  'custom radar keeps the seeker''s distance'
);
select is(
  (select (payload ->> 'deadline_s')::int from public.events where game_id = pg_temp.gid() and type = 'question_asked'),
  120, 'per-type deadline from config'
);
select is(
  (select payload -> 'reward' from public.events where game_id = pg_temp.gid() and type = 'question_asked'),
  '{"draw":2,"pick":1}'::jsonb, 'reward from the question data'
);
select is(
  public.ask_question(pg_temp.gid(), 'radar', 'custom', '{"center":[153.025,-27.47],"distance_m":1500}',
    'dddddddd-0000-0000-0000-000000000027', 0) ->> 'question_id',
  current_setting('test.q1'), 'a retried ask returns the same question'
);
select is(
  (select count(*)::int from public.events where game_id = pg_temp.gid() and type = 'question_asked'),
  1, 'retry adds no event'
);
select throws_ok(
  $$ select public.ask_question(pg_temp.gid(), 'radar', '1km', '{"center":[153.025,-27.47]}',
       'dddddddd-0000-0000-0000-000000000028', pg_temp.seq()) $$,
  'P0001', 'question_pending', 'one question at a time'
);

-- ---------------------------------------------------------------- answer

select throws_ok(
  format($$ select public.answer_question(pg_temp.gid(), %L, 'yes', 'dddddddd-0000-0000-0000-000000000030', pg_temp.seq()) $$,
    current_setting('test.q1')),
  'P0001', 'hiders_only', 'seekers cannot answer'
);

select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select throws_ok(
  format($$ select public.answer_question(pg_temp.gid(), %L, 'hotter', 'dddddddd-0000-0000-0000-000000000031', pg_temp.seq()) $$,
    current_setting('test.q1')),
  'P0001', 'invalid_answer', 'answer must fit the question type'
);
select lives_ok(
  format($$ select public.answer_question(pg_temp.gid(), %L, 'yes', 'dddddddd-0000-0000-0000-000000000032', pg_temp.seq()) $$,
    current_setting('test.q1')),
  'hider answers'
);
select is(
  (select payload ->> 'answer' || '/' || (payload ->> 'late') from public.events
    where game_id = pg_temp.gid() and type = 'question_answered'),
  'yes/false', 'answer is broadcast to everyone, on time'
);
select throws_ok(
  format($$ select public.answer_question(pg_temp.gid(), %L, 'no', 'dddddddd-0000-0000-0000-000000000033', pg_temp.seq()) $$,
    current_setting('test.q1')),
  'P0001', 'question_not_pending', 'cannot answer twice'
);

-- ---------------------------------------------------------------- thermometer + late penalty

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select throws_ok(
  $$ select public.ask_question(pg_temp.gid(), 'thermometer', '250m',
       '{"start":[153.02,-27.47],"end":[153.021,-27.47]}', 'dddddddd-0000-0000-0000-000000000040', pg_temp.seq()) $$,
  'P0001', 'not_far_enough', 'thermometer needs the full distance travelled'
);
select set_config('test.q2', (public.ask_question(pg_temp.gid(), 'thermometer', '250m',
  '{"start":[153.02,-27.47],"end":[153.024,-27.47]}', 'dddddddd-0000-0000-0000-000000000041', pg_temp.seq())
  ->> 'question_id'), true);
select is(
  (select (payload ->> 'deadline_s')::int from public.events
    where game_id = pg_temp.gid() and type = 'question_asked' order by seq desc limit 1),
  300, 'default deadline when the type has none'
);
select ok(
  (select (payload #>> '{params,travelled_m}')::int between 380 and 410 from public.events
    where game_id = pg_temp.gid() and type = 'question_asked' order by seq desc limit 1),
  'travelled distance is measured on the server'
);

select is((public.settle_timers(pg_temp.gid(), 'dddddddd-0000-0000-0000-000000000042') ->> 'settled')::int,
  0, 'nothing due before the deadline');

reset role;
update public.questions set deadline_at = now() - interval '1 second' where id = current_setting('test.q2')::uuid;
set local role authenticated;

select is((public.settle_timers(pg_temp.gid(), 'dddddddd-0000-0000-0000-000000000043') ->> 'settled')::int,
  1, 'a missed deadline is settled by any phone');
select is(
  (select payload ->> 'penalty' || '/' || (payload ->> 'team') || '/' || visibility::text from public.events
    where game_id = pg_temp.gid() and type = 'answer_overdue'),
  'shot/hiders/all', 'penalty shot for the hiders, logged for everyone'
);
select is(
  (select actor_id from public.events where game_id = pg_temp.gid() and type = 'answer_overdue'),
  null, 'penalty is a system event'
);
select is((public.settle_timers(pg_temp.gid(), 'dddddddd-0000-0000-0000-000000000044') ->> 'settled')::int,
  0, 'the penalty is logged once');

select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select lives_ok(
  format($$ select public.answer_question(pg_temp.gid(), %L, 'colder', 'dddddddd-0000-0000-0000-000000000045', pg_temp.seq()) $$,
    current_setting('test.q2')),
  'a late answer is still accepted'
);
select is(
  (select payload ->> 'late' from public.events
    where game_id = pg_temp.gid() and type = 'question_answered' order by seq desc limit 1),
  'true', 'and marked late'
);
select is(
  (select count(*)::int from public.events where game_id = pg_temp.gid() and type = 'answer_overdue'),
  1, 'still one penalty'
);

-- A deadline that passes with nobody calling settle_timers is caught by the answer itself.
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select set_config('test.q3', (public.ask_question(pg_temp.gid(), 'radar', '500m', '{"center":[153.025,-27.47]}',
  'dddddddd-0000-0000-0000-000000000050', pg_temp.seq()) ->> 'question_id'), true);
reset role;
update public.questions set deadline_at = now() - interval '1 second' where id = current_setting('test.q3')::uuid;
set local role authenticated;
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select public.answer_question(pg_temp.gid(), current_setting('test.q3')::uuid, 'no',
  'dddddddd-0000-0000-0000-000000000051', pg_temp.seq());
select is(
  array(select type from public.events where game_id = pg_temp.gid() and type <> 'cards_drawn' order by seq desc limit 2),
  array['question_answered', 'answer_overdue'],
  'answering after the deadline logs the penalty first'
);

select throws_ok(
  $$ select * from public.questions $$,
  '42501', null, 'clients cannot read the questions table'
);

select * from finish();
rollback;
