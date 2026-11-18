-- Trivia curses (20261209090000_trivia_curse.sql): Curse of Moll.
-- Players: H = host (seeker), A and B = hiders, S = seeker. Cards are put in the hand directly.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(33);

insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333'),
  ('44444444-4444-4444-4444-444444444444');

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
create function pg_temp.hider2() returns void language sql as $$
  select pg_temp.as_user('44444444-4444-4444-4444-444444444444');
$$;
create function pg_temp.seeker() returns void language sql as $$
  select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
$$;
create function pg_temp.to_hand(p_card text) returns uuid language sql as $$
  update public.card_instances set location = 'hand'
   where id = (select id from public.card_instances
                where game_id = pg_temp.gid() and card_id = p_card and location in ('pile', 'drawn')
                order by pile_pos limit 1)
  returning id;
$$;
create function pg_temp.play(p uuid, n int) returns jsonb language plpgsql as $$
begin
  perform pg_temp.hider();
  return public.play_card(pg_temp.gid(), p, pg_temp.uid(n), pg_temp.seq());
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
  public.create_game('Host', pg_temp.uid(1), 'brisbane', '{"hiding_period_s":1800,
    "deck":{"moll":1,"bonus_red":10}}'::jsonb) ->> 'game_id', true);
select set_config('test.code', (select code from public.games where id = pg_temp.gid()), true);
select pg_temp.hider();
select public.join_game(current_setting('test.code'), 'Amy', pg_temp.uid(2));
select public.set_team(pg_temp.gid(), 'hiders', pg_temp.uid(3));
select pg_temp.hider2();
select public.join_game(current_setting('test.code'), 'Ben', pg_temp.uid(4));
select public.set_team(pg_temp.gid(), 'hiders', pg_temp.uid(5));
select pg_temp.seeker();
select public.join_game(current_setting('test.code'), 'Sam', pg_temp.uid(6));
select public.set_team(pg_temp.gid(), 'seekers', pg_temp.uid(7));
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select public.set_team(pg_temp.gid(), 'seekers', pg_temp.uid(8));
select public.set_play_area(pg_temp.gid(), current_setting('test.area_id')::uuid, pg_temp.uid(9), pg_temp.seq());
select public.start_game(pg_temp.gid(), pg_temp.uid(10), pg_temp.seq());

reset role;
select is((select behaviour from public.cards where id = 'moll'), 'trivia', 'Curse of Moll is a trivia curse');
select is((select params ->> 'count' from public.game_cards where game_id = pg_temp.gid() and card_id = 'moll'), '3',
  'with three questions');
select set_config('test.moll', pg_temp.to_hand('moll')::text, true);
set local role authenticated;

-- ---------------------------------------------------------------- play

select set_config('test.effect', (pg_temp.play(current_setting('test.moll')::uuid, 20) ->> 'effect_id'), true);
reset role;
select is((select array[behaviour, status, blocks_questions::text] from public.card_effects
            where id = current_setting('test.effect')::uuid),
  array['trivia', 'active', 'false'], 'playing it starts a trivia effect that does not block questions');
select is((select payload ->> 'count' from pg_temp.last_event('card_played')), '3', 'card_played says how many questions');
set local role authenticated;

-- Not an until_cleared curse: "We did it" does not apply.
select pg_temp.seeker();
select throws_ok(format($$ select public.clear_effect(pg_temp.gid(), %L, pg_temp.uid(21), pg_temp.seq()) $$,
  current_setting('test.effect')), 'P0001', 'effect_not_active', 'seekers cannot clear it with We did it');
select throws_ok(format($$ select public.answer_trivia(pg_temp.gid(), %L, array['a', 'b', 'c'], pg_temp.uid(22), pg_temp.seq()) $$,
  current_setting('test.effect')), 'P0001', 'trivia_not_set', 'nothing to answer before the questions are sent');

-- ---------------------------------------------------------------- questions

select throws_ok(format($$ select public.set_trivia(pg_temp.gid(), %L, array['a', 'b', 'c'], pg_temp.uid(23), pg_temp.seq()) $$,
  current_setting('test.effect')), 'P0001', 'hiders_only', 'seekers cannot write the questions');
select pg_temp.hider();
select throws_ok(format($$ select public.set_trivia(pg_temp.gid(), %L, array['a', 'b'], pg_temp.uid(24), pg_temp.seq()) $$,
  current_setting('test.effect')), 'P0001', 'invalid_trivia', 'exactly three questions');
select throws_ok(format($$ select public.set_trivia(pg_temp.gid(), %L, array['a', ' ', 'c'], pg_temp.uid(25), pg_temp.seq()) $$,
  current_setting('test.effect')), 'P0001', 'invalid_trivia', 'none of them blank');
select lives_ok(format($$ select public.set_trivia(pg_temp.gid(), %L,
    array[' Harry''s owl? ', 'Dobby''s gift?', 'Hagrid''s dog?'], pg_temp.uid(26), pg_temp.seq()) $$,
  current_setting('test.effect')), 'the hider sends three questions');
reset role;
select is((select array[visibility::text, payload -> 'questions' ->> 0] from pg_temp.last_event('trivia_set')),
  array['all', 'Harry''s owl?'], 'both teams see the questions (trimmed)');
set local role authenticated;
select pg_temp.hider2();
select throws_ok(format($$ select public.set_trivia(pg_temp.gid(), %L, array['a', 'b', 'c'], pg_temp.uid(27), pg_temp.seq()) $$,
  current_setting('test.effect')), 'P0001', 'trivia_already_set', 'questions are sent once');

-- ---------------------------------------------------------------- answers and marks

select pg_temp.hider();
select throws_ok(format($$ select public.answer_trivia(pg_temp.gid(), %L, array['a', 'b', 'c'], pg_temp.uid(28), pg_temp.seq()) $$,
  current_setting('test.effect')), 'P0001', 'seekers_only', 'hiders cannot answer');
select throws_ok(format($$ select public.mark_trivia(pg_temp.gid(), %L, array[true, true, true], pg_temp.uid(29), pg_temp.seq()) $$,
  current_setting('test.effect')), 'P0001', 'trivia_nothing_to_mark', 'nothing to mark before the answers');
select pg_temp.seeker();
select throws_ok(format($$ select public.answer_trivia(pg_temp.gid(), %L, array['Hedwig', 'A hat'], pg_temp.uid(30), pg_temp.seq()) $$,
  current_setting('test.effect')), 'P0001', 'invalid_trivia_answer', 'all three answers come at once');
select throws_ok(format($$ select public.answer_trivia(pg_temp.gid(), %L, array['Hedwig', ' ', 'Fluffy'], pg_temp.uid(31), pg_temp.seq()) $$,
  current_setting('test.effect')), 'P0001', 'invalid_trivia_answer', 'none of them blank');
select lives_ok(format($$ select public.answer_trivia(pg_temp.gid(), %L, array['Hedwig', 'A hat', 'Fluffy'], pg_temp.uid(32), pg_temp.seq()) $$,
  current_setting('test.effect')), 'a seeker sends all three answers');
reset role;
select is((select array[visibility::text, payload -> 'answers' ->> 1] from pg_temp.last_event('trivia_answered')),
  array['all', 'A hat'], 'both teams see the answers');
set local role authenticated;
select throws_ok(format($$ select public.answer_trivia(pg_temp.gid(), %L, array['x', 'y', 'z'], pg_temp.uid(33), pg_temp.seq()) $$,
  current_setting('test.effect')), 'P0001', 'trivia_already_answered', 'no new answers until the hider marks them');

select throws_ok(format($$ select public.mark_trivia(pg_temp.gid(), %L, array[true, true, true], pg_temp.uid(34), pg_temp.seq()) $$,
  current_setting('test.effect')), 'P0001', 'hiders_only', 'seekers cannot mark');
select pg_temp.hider();
select throws_ok(format($$ select public.mark_trivia(pg_temp.gid(), %L, array[true, null, true], pg_temp.uid(35), pg_temp.seq()) $$,
  current_setting('test.effect')), 'P0001', 'invalid_trivia_marks', 'every answer gets a mark');
select lives_ok(format($$ select public.mark_trivia(pg_temp.gid(), %L, array[true, false, true], pg_temp.uid(36), pg_temp.seq()) $$,
  current_setting('test.effect')), 'the hider marks all three at once, one wrong');
reset role;
select is((select array[payload -> 'marks' -> 1 ->> 'correct', payload -> 'marks' -> 1 ->> 'answer', visibility::text]
            from pg_temp.last_event('trivia_marked')),
  array['false', 'A hat', 'all'], 'the marks and the answers they were for are public');
select is((select array[coalesce(answer, 'none'), wrong_count::text] from public.trivia_questions
            where effect_id = current_setting('test.effect')::uuid and idx = 1),
  array['none', '1'], 'the wrong answer goes back to the seekers');
select is((select status from public.card_effects where id = current_setting('test.effect')::uuid), 'active',
  'still active with one left');
set local role authenticated;
select pg_temp.seeker();
select throws_ok(format($$ select public.answer_trivia(pg_temp.gid(), %L, array[null, ' ', null], pg_temp.uid(37), pg_temp.seq()) $$,
  current_setting('test.effect')), 'P0001', 'invalid_trivia_answer', 'the wrong one needs a new answer');
select lives_ok(format($$ select public.answer_trivia(pg_temp.gid(), %L, array[null, 'A sock', null], pg_temp.uid(38), pg_temp.seq()) $$,
  current_setting('test.effect')), 'the seekers answer just the wrong one again');
reset role;
select is((select answer from public.trivia_questions where effect_id = current_setting('test.effect')::uuid and idx = 0), 'Hedwig',
  'right answers stay as they were');
set local role authenticated;
select pg_temp.hider();
select public.mark_trivia(pg_temp.gid(), current_setting('test.effect')::uuid, array[null, true, null]::boolean[], pg_temp.uid(39), pg_temp.seq());
reset role;
select is((select status from public.card_effects where id = current_setting('test.effect')::uuid), 'cleared',
  'all three right clears the curse');
select is((select type from public.events where game_id = pg_temp.gid() order by seq desc limit 1), 'effect_cleared',
  'and says so');

-- ---------------------------------------------------------------- host clears by hand

update public.card_effects set status = 'active', cleared_at = null where id = current_setting('test.effect')::uuid;
update public.trivia_questions set correct = false, answer = null where effect_id = current_setting('test.effect')::uuid;
set local role authenticated;
select pg_temp.hider();
select throws_ok(format($$ select public.force_clear_trivia(pg_temp.gid(), %L, pg_temp.uid(43), pg_temp.seq()) $$,
  current_setting('test.effect')), 'P0001', 'host_only', 'only the host can clear it by hand');
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select lives_ok(format($$ select public.force_clear_trivia(pg_temp.gid(), %L, pg_temp.uid(44), pg_temp.seq()) $$,
  current_setting('test.effect')), 'the host (a seeker here) marks all right and clears the curse');
reset role;
select is((select array[status, (select count(*) from public.trivia_questions
                                  where effect_id = current_setting('test.effect')::uuid and correct)::text]
            from public.card_effects where id = current_setting('test.effect')::uuid),
  array['cleared', '3'], 'cleared with every question right');

select * from finish();
rollback;
