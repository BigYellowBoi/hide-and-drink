-- Questions stage 2: matching, measuring, tentacles (null answers), photos (Storage) and bonus.
-- Players: H = host (hider), A = hider, S = seeker, T = seeker.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(49);

-- Written before 20261217090000_playtest2_fixes.sql: same option asked more than once, and
-- the cards as they were (no seeker_confirm curses, Moll needs all three). Those are
-- tested in 27_playtest2.test.sql.
update public.question_types set options = (select jsonb_agg(o || '{"reusable": true}'::jsonb order by i)
                                              from jsonb_array_elements(options) with ordinality t(o, i));
update public.question_types set extra = extra - 'randomize_vetoes';
update public.cards set params = params - 'seeker_confirm' - 'need_right';

insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333'),
  ('44444444-4444-4444-4444-444444444444');

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
create function pg_temp.pending() returns uuid language sql security definer as $$
  select id from public.questions where game_id = current_setting('test.game_id')::uuid and answered_at is null;
$$;
grant execute on all functions in schema pg_temp to authenticated;

-- ---------------------------------------------------------------- setup: started game

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
set local role authenticated;
select set_config('test.game_id',
  public.create_game('Host', 'dddddddd-0000-0000-0000-000000000001', 'brisbane',
    '{"answer_deadline_s":{"default":300,"photos":900},"hiding_period_s":1800}'::jsonb) ->> 'game_id', true);
select set_config('test.code', (select code from public.games where id = pg_temp.gid()), true);
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select public.join_game(current_setting('test.code'), 'Amy', 'dddddddd-0000-0000-0000-000000000002');
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select public.join_game(current_setting('test.code'), 'Sam', 'dddddddd-0000-0000-0000-000000000003');
select pg_temp.as_user('44444444-4444-4444-4444-444444444444');
select public.join_game(current_setting('test.code'), 'Tia', 'dddddddd-0000-0000-0000-000000000004');

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select public.set_team(pg_temp.gid(), 'hiders', 'dddddddd-0000-0000-0000-000000000010');
select public.set_team(pg_temp.gid(), 'hiders', 'dddddddd-0000-0000-0000-000000000011', '22222222-2222-2222-2222-222222222222');
select public.set_team(pg_temp.gid(), 'seekers', 'dddddddd-0000-0000-0000-000000000012', '33333333-3333-3333-3333-333333333333');
select public.set_team(pg_temp.gid(), 'seekers', 'dddddddd-0000-0000-0000-000000000013', '44444444-4444-4444-4444-444444444444');
select public.set_play_area(pg_temp.gid(), current_setting('test.area_id')::uuid, 'dddddddd-0000-0000-0000-000000000014', pg_temp.seq());

-- Before start
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select throws_ok(
  $$ select public.ask_question(pg_temp.gid(), 'bonus', 'pool', '{}', 'dddddddd-0000-0000-0000-000000000020', pg_temp.seq()) $$,
  'P0001', 'round_not_running', 'no questions in the lobby'
);

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select public.start_game(pg_temp.gid(), 'dddddddd-0000-0000-0000-000000000015', pg_temp.seq());

-- ---------------------------------------------------------------- refusals

select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select throws_ok(
  $$ select public.ask_question(pg_temp.gid(), 'bonus', 'pool', '{}', 'dddddddd-0000-0000-0000-000000000021', pg_temp.seq()) $$,
  'P0001', 'still_hiding', 'no questions during the hiding period'
);

-- End the hiding period.
reset role;
update public.games set round_started_at = now() - interval '31 minutes' where id = pg_temp.gid();
set local role authenticated;

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select throws_ok(
  $$ select public.ask_question(pg_temp.gid(), 'bonus', 'pool', '{}', 'dddddddd-0000-0000-0000-000000000022', pg_temp.seq()) $$,
  'P0001', 'seekers_only', 'hiders cannot ask'
);

select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select throws_ok(
  $$ select public.ask_question(pg_temp.gid(), 'bonus', 'pool', '{}', 'dddddddd-0000-0000-0000-000000000023', 1) $$,
  'P0001', 'stale_state', 'asking needs an up-to-date view'
);
select throws_ok(
  $$ select public.ask_question(pg_temp.gid(), 'bonus', 'pool', '[]', 'dddddddd-0000-0000-0000-000000000024', pg_temp.seq()) $$,
  'P0001', 'invalid_params', 'params must be an object'
);
select throws_ok(
  $$ select public.ask_question(pg_temp.gid(), 'bonus', 'nope', '{}', 'dddddddd-0000-0000-0000-000000000025', pg_temp.seq()) $$,
  'P0001', 'option_not_found', 'unknown option is refused'
);
select throws_ok(
  $$ select public.ask_question(pg_temp.gid(), 'matching', 'suburb', '{}', 'dddddddd-0000-0000-0000-000000000026', pg_temp.seq()) $$,
  'P0001', 'invalid_position', 'map questions need the asker''s position'
);
select throws_ok(
  $$ select public.ask_question(pg_temp.gid(), 'matching', 'suburb', '{"center":[151.2093,-33.8688]}', 'dddddddd-0000-0000-0000-000000000027', pg_temp.seq()) $$,
  'P0001', 'position_outside_map', 'a position far outside the city pack is refused'
);

-- ---------------------------------------------------------------- matching

-- Queen Street Mall, Brisbane City.
select lives_ok(
  $$ select set_config('test.r1', public.ask_question(pg_temp.gid(), 'matching', 'suburb', '{"center":[153.0251,-27.4698]}', 'dddddddd-0000-0000-0000-000000000030', pg_temp.seq())::text, true) $$,
  'seeker asks a matching question'
);
select is(
  public.ask_question(pg_temp.gid(), 'matching', 'suburb', '{"center":[153.0251,-27.4698]}', 'dddddddd-0000-0000-0000-000000000030', 0),
  current_setting('test.r1')::jsonb,
  'retrying ask_question returns the same result'
);
select is(
  (select count(*)::int from public.events where game_id = pg_temp.gid() and type = 'question_asked'),
  1, 'one question_asked event even after a retry'
);
select is(
  (select payload #>> '{params,name}' from public.events where game_id = pg_temp.gid() and type = 'question_asked'),
  'Brisbane City', 'matching reference is the seekers'' containing suburb'
);
select is(
  (select jsonb_build_object('vis', visibility, 'pos', payload #> '{params,center}', 'reward', payload -> 'reward')
     from public.events where game_id = pg_temp.gid() and type = 'question_asked'),
  '{"vis":"all","pos":[153.0251,-27.4698],"reward":{"draw":3,"pick":1}}'::jsonb,
  'question_asked is public and carries position and reward'
);
select ok(
  (select (payload ->> 'deadline_at')::timestamptz - (payload ->> 'asked_at')::timestamptz = interval '300 seconds'
     from public.events where game_id = pg_temp.gid() and type = 'question_asked'),
  'deadline uses the game default (300 s)'
);

select pg_temp.as_user('44444444-4444-4444-4444-444444444444');
select throws_ok(
  $$ select public.ask_question(pg_temp.gid(), 'bonus', 'pool', '{}', 'dddddddd-0000-0000-0000-000000000031', pg_temp.seq()) $$,
  'P0001', 'question_pending', 'only one question at a time'
);
select throws_ok(
  $$ select public.answer_question(pg_temp.gid(), pg_temp.pending(), 'same', 'dddddddd-0000-0000-0000-000000000032', pg_temp.seq()) $$,
  'P0001', 'hiders_only', 'seekers cannot answer'
);

select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select throws_ok(
  $$ select public.answer_question(pg_temp.gid(), pg_temp.pending(), 'closer', 'dddddddd-0000-0000-0000-000000000033', pg_temp.seq()) $$,
  'P0001', 'invalid_answer', 'answer shape must match the type'
);
select throws_ok(
  $$ select public.answer_question(pg_temp.gid(), pg_temp.pending(), 'none', 'dddddddd-0000-0000-0000-000000000034', pg_temp.seq()) $$,
  'P0001', 'invalid_answer', 'matching has no null answer'
);
select throws_ok(
  $$ select public.answer_question(pg_temp.gid(), pg_temp.pending(), 'Same!', 'dddddddd-0000-0000-0000-000000000035', pg_temp.seq()) $$,
  'P0001', 'invalid_answer', 'answers are exact words'
);
select lives_ok(
  $$ select public.answer_question(pg_temp.gid(), pg_temp.pending(), 'different', 'dddddddd-0000-0000-0000-000000000036', pg_temp.seq()) $$,
  'hider answers matching'
);
select is(
  (select payload ->> 'answer' from public.events where game_id = pg_temp.gid() and type = 'question_answered'),
  'different', 'question_answered carries the answer'
);
select is(
  (select count(*)::int from public.events where game_id = pg_temp.gid() and type = 'answer_overdue'),
  0, 'no penalty for an answer in time'
);
select throws_ok(
  $$ select public.answer_question(pg_temp.gid(), (select (payload ->> 'question_id')::uuid from public.events
       where game_id = pg_temp.gid() and type = 'question_asked'), 'same',
       'dddddddd-0000-0000-0000-000000000037', pg_temp.seq()) $$,
  'P0001', 'question_not_pending', 'a question is answered once'
);

-- ---------------------------------------------------------------- measuring

select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select lives_ok(
  $$ select public.ask_question(pg_temp.gid(), 'measuring', 'gabba', '{"center":[153.0251,-27.4698]}', 'dddddddd-0000-0000-0000-000000000040', pg_temp.seq()) $$,
  'seeker asks a measuring question'
);
select ok(
  (select (payload #>> '{params,distance_m}')::numeric between 1800 and 2600
     from public.events where game_id = pg_temp.gid() and type = 'question_asked' order by seq desc limit 1),
  'measuring reference is the seekers'' distance to the target (CBD to the Gabba ~2.2 km)'
);
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select lives_ok(
  $$ select public.answer_question(pg_temp.gid(), pg_temp.pending(), 'closer', 'dddddddd-0000-0000-0000-000000000041', pg_temp.seq()) $$,
  'hider answers measuring'
);

-- ---------------------------------------------------------------- tentacles

select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select lives_ok(
  $$ select public.ask_question(pg_temp.gid(), 'tentacles', 'cinemas', '{"center":[153.0251,-27.4698]}', 'dddddddd-0000-0000-0000-000000000050', pg_temp.seq()) $$,
  'seeker asks a tentacles question'
);
select ok(
  (select jsonb_array_length(payload #> '{params,candidates}') > 0
          and (select bool_and((c ->> 'distance_m')::numeric <= 1000) from jsonb_array_elements(payload #> '{params,candidates}') c)
     from public.events where game_id = pg_temp.gid() and type = 'question_asked' order by seq desc limit 1),
  'tentacles reference lists the cinemas within 1 km'
);
select is(
  (select payload #>> '{params,null_answer}' from public.events where game_id = pg_temp.gid() and type = 'question_asked' order by seq desc limit 1),
  'None within range', 'tentacles question carries its null answer label'
);
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select throws_ok(
  $$ select public.answer_question(pg_temp.gid(), pg_temp.pending(), 'not-a-cinema', 'dddddddd-0000-0000-0000-000000000051', pg_temp.seq()) $$,
  'P0001', 'invalid_answer', 'tentacles answer must be one of the candidates'
);
select lives_ok(
  $$ select public.answer_question(pg_temp.gid(), pg_temp.pending(), 'none', 'dddddddd-0000-0000-0000-000000000052', pg_temp.seq()) $$,
  'hider sends a null tentacles answer'
);
select is(
  (select payload ->> 'answer' from public.events where game_id = pg_temp.gid() and type = 'question_answered' order by seq desc limit 1),
  'none', 'null answer is recorded'
);

select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select public.ask_question(pg_temp.gid(), 'tentacles', 'cinemas', '{"center":[153.0251,-27.4698]}', 'dddddddd-0000-0000-0000-000000000053', pg_temp.seq());
select set_config('test.cinema', (select payload #>> '{params,candidates,0,feature_id}' from public.events
  where game_id = pg_temp.gid() and type = 'question_asked' order by seq desc limit 1), true);
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select lives_ok(
  $$ select public.answer_question(pg_temp.gid(), pg_temp.pending(),
       current_setting('test.cinema'), 'dddddddd-0000-0000-0000-000000000054', pg_temp.seq()) $$,
  'hider names a tentacles candidate'
);
select is(
  (select payload ->> 'answer' from public.events where game_id = pg_temp.gid() and type = 'question_answered' order by seq desc limit 1),
  current_setting('test.cinema'), 'tentacles answer names the feature'
);

-- ---------------------------------------------------------------- photos

select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select lives_ok(
  $$ select public.ask_question(pg_temp.gid(), 'photos', 'sky', '{}', 'dddddddd-0000-0000-0000-000000000060', pg_temp.seq()) $$,
  'photo questions need no position'
);
select ok(
  (select (payload ->> 'deadline_at')::timestamptz - (payload ->> 'asked_at')::timestamptz = interval '900 seconds'
     from public.events where game_id = pg_temp.gid() and type = 'question_asked' order by seq desc limit 1),
  'per-type deadline from the game config (photos 900 s)'
);
select set_config('test.photo', pg_temp.gid()::text || '/' || pg_temp.pending()::text || '/abc123.jpg', true);

-- Storage RLS
select ok(not public.can_upload_question_photo(current_setting('test.photo')), 'seekers cannot upload answer photos');
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select ok(public.can_upload_question_photo(current_setting('test.photo')), 'hiders can upload for the pending photo question');
select ok(not public.can_upload_question_photo(pg_temp.gid()::text || '/' || gen_random_uuid()::text || '/x.jpg'),
  'no uploads for other questions');
select throws_ok(
  $$ select public.answer_question(pg_temp.gid(), pg_temp.pending(), current_setting('test.photo'),
       'dddddddd-0000-0000-0000-000000000061', pg_temp.seq()) $$,
  'P0001', 'photo_not_uploaded', 'photo answer needs the uploaded file'
);
insert into storage.objects (bucket_id, name, owner)
values ('question-photos', current_setting('test.photo'), '22222222-2222-2222-2222-222222222222');
select lives_ok(
  $$ select public.answer_question(pg_temp.gid(), pg_temp.pending(), current_setting('test.photo'),
       'dddddddd-0000-0000-0000-000000000062', pg_temp.seq()) $$,
  'hider answers with the uploaded photo'
);
select pg_temp.as_user('44444444-4444-4444-4444-444444444444');
select is((select count(*)::int from storage.objects where name = current_setting('test.photo')), 1,
  'seekers can read the game''s photos');
reset role;
insert into auth.users (id) values ('55555555-5555-5555-5555-555555555555');
set local role authenticated;
select pg_temp.as_user('55555555-5555-5555-5555-555555555555');
select is((select count(*)::int from storage.objects where name = current_setting('test.photo')), 0,
  'outsiders cannot read the game''s photos');

-- ---------------------------------------------------------------- bonus + late answer

select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select public.ask_question(pg_temp.gid(), 'bonus', 'syllables', '{}', 'dddddddd-0000-0000-0000-000000000070', pg_temp.seq());
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select throws_ok(
  $$ select public.answer_question(pg_temp.gid(), pg_temp.pending(), 'three', 'dddddddd-0000-0000-0000-000000000071', pg_temp.seq()) $$,
  'P0001', 'invalid_answer', 'bonus answer kind comes from the option (number)'
);
select throws_ok(
  $$ select public.answer_question(pg_temp.gid(), pg_temp.pending(), '2.5', 'dddddddd-0000-0000-0000-000000000072', pg_temp.seq()) $$,
  'P0001', 'invalid_answer', 'numbers must be whole'
);
reset role;
update public.questions set deadline_at = now() - interval '1 second' where id = pg_temp.pending();
set local role authenticated;
select lives_ok(
  $$ select public.answer_question(pg_temp.gid(), pg_temp.pending(), '3', 'dddddddd-0000-0000-0000-000000000073', pg_temp.seq()) $$,
  'a late answer is still accepted'
);
select is(
  (select jsonb_build_object('late', a.payload -> 'late', 'penalty', p.payload ->> 'penalty', 'team', p.payload ->> 'team')
     from public.events a, public.events p
    where a.game_id = pg_temp.gid() and a.type = 'question_answered'
      and p.game_id = pg_temp.gid() and p.type = 'answer_overdue'
    order by a.seq desc limit 1),
  '{"late":true,"penalty":"shot","team":"hiders"}'::jsonb,
  'late answer is flagged and logs a penalty'
);

select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select public.ask_question(pg_temp.gid(), 'bonus', 'last_beer', '{}', 'dddddddd-0000-0000-0000-000000000080', pg_temp.seq());
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select lives_ok(
  $$ select public.answer_question(pg_temp.gid(), pg_temp.pending(), '  XXXX Gold  ', 'dddddddd-0000-0000-0000-000000000081', pg_temp.seq()) $$,
  'hider answers a text bonus question'
);
select is(
  (select payload ->> 'answer' from public.events where game_id = pg_temp.gid() and type = 'question_answered' order by seq desc limit 1),
  'XXXX Gold', 'text answers are trimmed'
);

select * from finish();
rollback;
