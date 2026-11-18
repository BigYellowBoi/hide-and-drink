-- Host undo (20261211090000_host_undo.sql).
-- Players: H = host (hider), S = seeker.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(24);

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
create function pg_temp.questions() returns int language sql security definer as $$
  select count(*)::int from public.questions where game_id = current_setting('test.game_id')::uuid;
$$;
create function pg_temp.answer() returns text language sql security definer as $$
  select answer from public.questions where id = pg_temp.qid();
$$;
create function pg_temp.shading() returns jsonb language sql security definer as $$
  select manual_shading from public.questions where id = pg_temp.qid();
$$;
create function pg_temp.drawn() returns int language sql security definer as $$
  select count(*)::int from public.card_instances where game_id = current_setting('test.game_id')::uuid and location = 'drawn';
$$;
create function pg_temp.pile_top() returns text language sql security definer as $$
  select string_agg(id::text, ',' order by pile_pos) from (
    select id, pile_pos from public.card_instances
     where game_id = current_setting('test.game_id')::uuid and location = 'pile' order by pile_pos limit 3) t;
$$;
create function pg_temp.undo(p_n int) returns jsonb language sql as $$
  select public.undo_last_action(pg_temp.gid(), ('dddddddd-0000-0000-0001-' || lpad(p_n::text, 12, '0'))::uuid, pg_temp.seq());
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
select throws_ok($$ select pg_temp.undo(1) $$, 'P0001', 'round_not_running', 'nothing to undo in the lobby');
select public.set_team(pg_temp.gid(), 'hiders', 'dddddddd-0000-0000-0000-000000000010');
select public.set_team(pg_temp.gid(), 'seekers', 'dddddddd-0000-0000-0000-000000000011', '33333333-3333-3333-3333-333333333333');
select public.set_play_area(pg_temp.gid(), current_setting('test.area_id')::uuid, 'dddddddd-0000-0000-0000-000000000012', pg_temp.seq());
select public.start_game(pg_temp.gid(), 'dddddddd-0000-0000-0000-000000000013', pg_temp.seq());
reset role;
update public.games set round_started_at = now() - interval '31 minutes' where id = pg_temp.gid();
set local role authenticated;

select throws_ok($$ select pg_temp.undo(2) $$, 'P0001', 'nothing_to_undo', 'nothing to undo right after the start');

-- Undo an ask.
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select public.ask_question(pg_temp.gid(), 'radar', '1km', '{"center":[153.0251,-27.4698]}', 'dddddddd-0000-0000-0000-000000000020', pg_temp.seq());
select throws_ok($$ select pg_temp.undo(3) $$, 'P0001', 'host_only', 'only the host can undo');
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select throws_ok(
  $$ select public.undo_last_action(pg_temp.gid(), 'dddddddd-0000-0000-0001-000000000099', 1) $$,
  'P0001', 'stale_state', 'undo needs an up-to-date view'
);
select lives_ok($$ select pg_temp.undo(4) $$, 'the host undoes the ask');
select is(pg_temp.questions(), 0, 'the question is gone');
reset role;
select is(
  (select visibility::text || ':' || (payload ->> 'type') from public.events where game_id = pg_temp.gid() and type = 'action_undone' order by seq desc limit 1),
  'all:question_asked', 'a public action_undone names the undone ask'
);
select is(
  (select (payload ->> 'seq')::bigint from public.events where game_id = pg_temp.gid() and type = 'action_undone' order by seq desc limit 1),
  (select seq from public.events where game_id = pg_temp.gid() and type = 'question_asked' order by seq desc limit 1),
  'it points at the question_asked event'
);
set local role authenticated;
select throws_ok($$ select pg_temp.undo(5) $$, 'P0001', 'nothing_to_undo', 'undone events are skipped');

-- Undo an answer and its reward draw, then the ask before it.
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select public.ask_question(pg_temp.gid(), 'radar', '1km', '{"center":[153.0251,-27.4698]}', 'dddddddd-0000-0000-0000-000000000030', pg_temp.seq());
select set_config('test.pile_before', pg_temp.pile_top(), true);
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select public.answer_question(pg_temp.gid(), pg_temp.qid(), 'yes', 'dddddddd-0000-0000-0000-000000000031', pg_temp.seq());
select ok(pg_temp.drawn() > 0, 'the answer drew cards');
select lives_ok($$ select pg_temp.undo(6) $$, 'the host undoes the answer');
select is(pg_temp.answer(), null, 'the question is pending again');
select is(pg_temp.drawn(), 0, 'the drawn cards are back on the pile');
select is(pg_temp.pile_top(), current_setting('test.pile_before'), 'in the same order');
reset role;
select is(
  (select count(*)::int from public.card_draws where game_id = pg_temp.gid()),
  0, 'the draw is gone'
);
select is(
  (select visibility::text from public.events where game_id = pg_temp.gid() and type = 'action_undone' and payload ->> 'type' = 'cards_drawn'),
  'hiders', 'undoing the draw is hider-only'
);
set local role authenticated;
select lives_ok(
  $$ select public.answer_question(pg_temp.gid(), pg_temp.qid(), 'no', 'dddddddd-0000-0000-0000-000000000032', pg_temp.seq()) $$,
  'the hider can answer again'
);
select is(pg_temp.answer(), 'no', 'with the new answer');

-- A kept draw can't be undone.
reset role;
update public.card_draws set kept_at = now() where game_id = pg_temp.gid();
set local role authenticated;
select throws_ok($$ select pg_temp.undo(7) $$, 'P0001', 'cards_already_kept', 'kept cards stop an answer undo');
reset role;
update public.card_draws set kept_at = null where game_id = pg_temp.gid();
set local role authenticated;

-- Manual shading goes back one step at a time.
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select public.set_question_shading(pg_temp.gid(), pg_temp.qid(), jsonb_build_object('mode','cut','area',pg_temp.square()), 'dddddddd-0000-0000-0000-000000000040', pg_temp.seq());
select public.set_question_shading(pg_temp.gid(), pg_temp.qid(), '{"mode":"none"}', 'dddddddd-0000-0000-0000-000000000041', pg_temp.seq());
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select lives_ok($$ select pg_temp.undo(8) $$, 'undo the second shading');
select is(pg_temp.shading() ->> 'mode', 'cut', 'the first shading is back');
select lives_ok($$ select pg_temp.undo(9) $$, 'undo the first shading');
select is(pg_temp.shading(), null, 'back to the app''s shading');

-- Anything else is refused.
reset role;
select public._append_event(pg_temp.gid(), 'card_played', '{}'::jsonb);
set local role authenticated;
select throws_ok($$ select pg_temp.undo(10) $$, 'P0001', 'cannot_undo', 'other actions cannot be undone');

select * from finish();
rollback;
