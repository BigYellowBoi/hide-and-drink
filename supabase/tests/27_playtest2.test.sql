-- Playtest 2 fixes (20261217090000_playtest2_fixes.sql): each question once per run,
-- Randomize on a thermometer acts as a veto, seeker_confirm curses (Prison), Curse of Moll
-- needing 1 of 3, push alerts for drink cards.
-- Players: H = host (seeker), A = hider, S = seeker. Cards are put in the hand directly.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(37);

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
  select ('ffffffff-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid
$$;
create function pg_temp.hider() returns void language sql as $$
  select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
$$;
create function pg_temp.seeker() returns void language sql as $$
  select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
$$;
create function pg_temp.radar(n int, p_option text, p_params jsonb default '{"center":[153.025,-27.47]}')
returns uuid language plpgsql as $$
begin
  perform pg_temp.seeker();
  return (public.ask_question(pg_temp.gid(), 'radar', p_option, p_params, pg_temp.uid(n), pg_temp.seq())
    ->> 'question_id')::uuid;
end;
$$;
create function pg_temp.answer(q uuid, n int) returns void language plpgsql as $$
begin
  perform pg_temp.hider();
  perform public.answer_question(pg_temp.gid(), q, 'yes', pg_temp.uid(n), pg_temp.seq());
end;
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
create function pg_temp.last_event(p_type text) returns public.events language sql security definer as $$
  select * from public.events where game_id = pg_temp.gid() and type = p_type order by seq desc limit 1;
$$;
grant execute on all functions in schema pg_temp to authenticated;

-- ---------------------------------------------------------------- setup

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
set local role authenticated;
select set_config('test.game_id',
  public.create_game('Host', pg_temp.uid(1), 'brisbane', '{"hiding_period_s":1800,"hand_limit":6,
    "deck":{"randomize":2,"prison":1,"moll":1,"drinks_all_round":1,"bonus_red":10}}'::jsonb) ->> 'game_id', true);
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

reset role;
update public.games set round_started_at = now() - interval '31 minutes' where id = pg_temp.gid();
select set_config('test.rand1', pg_temp.to_hand('randomize')::text, true);
select set_config('test.rand2', pg_temp.to_hand('randomize')::text, true);
select set_config('test.prison', pg_temp.to_hand('prison')::text, true);
select set_config('test.moll', pg_temp.to_hand('moll')::text, true);
select set_config('test.drinks', pg_temp.to_hand('drinks_all_round')::text, true);
select is((select extra ->> 'randomize_vetoes' from public.question_types where city = 'brisbane' and type = 'thermometer'),
  'true', 'thermometer: Randomize vetoes');
select is((select o ->> 'reusable' from public.question_types, jsonb_array_elements(options) o
            where city = 'brisbane' and type = 'radar' and o ->> 'id' = 'custom'),
  'true', 'the custom radar can be asked again');
set local role authenticated;

-- ---------------------------------------------------------------- once per run

select pg_temp.answer(pg_temp.radar(10, '1km'), 11);
select throws_ok($$ select pg_temp.radar(12, '1km') $$, 'P0001', 'question_used', 'a 1 km radar is asked once per run');
select pg_temp.answer(pg_temp.radar(13, 'custom', '{"center":[153.025,-27.47],"distance_m":1500}'), 14);
select lives_ok($$ select pg_temp.answer(pg_temp.radar(15, 'custom', '{"center":[153.025,-27.47],"distance_m":1500}'), 16) $$,
  'a custom radar can be asked again');

-- Randomize only picks options not asked yet: with 1 km used, a 500 m radar can only become 2 or 3 km.
select set_config('test.q500', pg_temp.radar(17, '500m')::text, true);
select set_config('test.r', pg_temp.play(current_setting('test.rand1')::uuid, 18)::text, true);
reset role;
select ok((select option_id in ('2km', '3km') from public.questions
            where id = (current_setting('test.r')::jsonb ->> 'question_id')::uuid),
  'Randomize skips options already asked');
set local role authenticated;
select throws_ok($$ select pg_temp.answer(pg_temp.radar(19, '500m'), 20) $$, 'P0001', 'question_pending',
  'the randomized question is pending');
select pg_temp.answer((current_setting('test.r')::jsonb ->> 'question_id')::uuid, 21);
select throws_ok($$ select pg_temp.radar(22, '500m') $$, 'P0001', 'question_used',
  'the randomized-away question counts as asked');

-- ---------------------------------------------------------------- randomize a thermometer

select pg_temp.seeker();
select set_config('test.qt', (public.ask_question(pg_temp.gid(), 'thermometer', '250m',
  '{"start":[153.02,-27.47],"end":[153.024,-27.47]}', pg_temp.uid(23), pg_temp.seq()) ->> 'question_id'), true);
select set_config('test.r2', pg_temp.play(current_setting('test.rand2')::uuid, 24)::text, true);
reset role;
select is((select closed_by from public.questions where id = current_setting('test.qt')::uuid), 'veto',
  'Randomize closes a thermometer like a veto');
select is((current_setting('test.r2')::jsonb ->> 'question_id'), null, 'no new question');
select is((select payload ->> 'as_veto' from pg_temp.last_event('card_played')), 'true', 'card_played says so');
select is((select count(*)::int from public.questions where game_id = pg_temp.gid() and answered_at is null), 0,
  'nothing pending');
set local role authenticated;
select pg_temp.seeker();
select throws_ok($$ select public.ask_question(pg_temp.gid(), 'thermometer', '250m',
  '{"start":[153.02,-27.47],"end":[153.024,-27.47]}', pg_temp.uid(25), pg_temp.seq()) $$,
  'P0001', 'question_used', 'and the seekers lose that thermometer');

-- ---------------------------------------------------------------- seeker_confirm (Prison)

select set_config('test.pe', pg_temp.play(current_setting('test.prison')::uuid, 30) ->> 'effect_id', true);
reset role;
select is((select array[status, (ends_at = 'infinity')::text] from public.card_effects
            where id = current_setting('test.pe')::uuid),
  array['awaiting_seekers', 'true'], 'Prison waits for the seekers, its timer not started');
select is((select array[payload ->> 'awaiting_seekers', payload ->> 'seeker_confirm', coalesce(payload ->> 'ends_at', 'null')]
             from pg_temp.last_event('card_played')),
  array['true', 'Are you in the hiders'' bar right now?', 'null'], 'card_played carries the question for the seekers');
set local role authenticated;
select pg_temp.hider();
select throws_ok(format($$ select public.check_curse(pg_temp.gid(), %L, true, pg_temp.uid(31), pg_temp.seq()) $$,
  current_setting('test.pe')), 'P0001', 'seekers_only', 'only the seekers answer');
select pg_temp.seeker();
select lives_ok(format($$ select public.check_curse(pg_temp.gid(), %L, true, pg_temp.uid(32), pg_temp.seq()) $$,
  current_setting('test.pe')), 'seekers say it applies');
reset role;
select is((select array[status, (ends_at between now() + interval '9 minutes' and now() + interval '11 minutes')::text]
             from public.card_effects where id = current_setting('test.pe')::uuid),
  array['active', 'true'], 'the 10 minutes start now');
select is((select array[visibility::text, payload ->> 'applies'] from pg_temp.last_event('curse_checked')),
  array['all', 'true'], 'curse_checked is public');
select is((select array[audience::text, title] from public.push_outbox
            where game_id = pg_temp.gid() order by id desc limit 1),
  array['hiders', 'Curse applies'], 'the hiders hear about it');
set local role authenticated;
select pg_temp.seeker();
select throws_ok(format($$ select public.check_curse(pg_temp.gid(), %L, false, pg_temp.uid(33), pg_temp.seq()) $$,
  current_setting('test.pe')), 'P0001', 'effect_not_awaiting', 'answered once');

-- And "no": back in the hand to play it again, the seekers say it doesn't apply.
reset role;
update public.card_effects set status = 'cleared' where id = current_setting('test.pe')::uuid;
delete from public.card_effects where id = current_setting('test.pe')::uuid;
update public.card_instances set location = 'hand' where id = current_setting('test.prison')::uuid;
set local role authenticated;
select set_config('test.pe2', pg_temp.play(current_setting('test.prison')::uuid, 34) ->> 'effect_id', true);
select pg_temp.seeker();
select lives_ok(format($$ select public.check_curse(pg_temp.gid(), %L, false, pg_temp.uid(35), pg_temp.seq()) $$,
  current_setting('test.pe2')), 'seekers say it does not apply');
reset role;
select is((select status from public.card_effects where id = current_setting('test.pe2')::uuid), 'cleared',
  'the curse is dropped');
set local role authenticated;

-- ---------------------------------------------------------------- Moll: 1 of 3

select set_config('test.me', pg_temp.play(current_setting('test.moll')::uuid, 40) ->> 'effect_id', true);
reset role;
select is((select params ->> 'need_right' from public.game_cards where game_id = pg_temp.gid() and card_id = 'moll'),
  '1', 'Moll needs one right');
set local role authenticated;
select pg_temp.hider();
select lives_ok(format($$ select public.set_trivia(pg_temp.gid(), %L, array['q1', 'q2', 'q3'], pg_temp.uid(41), pg_temp.seq()) $$,
  current_setting('test.me')), 'hider sends three');
select pg_temp.seeker();
select public.answer_trivia(pg_temp.gid(), current_setting('test.me')::uuid, array['a', 'b', 'c'], pg_temp.uid(42), pg_temp.seq());
select pg_temp.hider();
select lives_ok(format($$ select public.mark_trivia(pg_temp.gid(), %L, array[false, false, false], pg_temp.uid(43), pg_temp.seq()) $$,
  current_setting('test.me')), 'all three wrong');
reset role;
select is((select array[payload ->> 'reset', payload ->> 'need'] from pg_temp.last_event('trivia_marked')),
  array['true', '1'], 'the set is thrown out');
select is((select count(*)::int from public.trivia_questions where effect_id = current_setting('test.me')::uuid), 0,
  'no questions left');
select is((select status from public.card_effects where id = current_setting('test.me')::uuid), 'active', 'still cursed');
set local role authenticated;
select pg_temp.hider();
select lives_ok(format($$ select public.set_trivia(pg_temp.gid(), %L, array['q4', 'q5', 'q6'], pg_temp.uid(44), pg_temp.seq()) $$,
  current_setting('test.me')), 'the hider sends three new ones');
select pg_temp.seeker();
select public.answer_trivia(pg_temp.gid(), current_setting('test.me')::uuid, array['d', 'e', 'f'], pg_temp.uid(45), pg_temp.seq());
select pg_temp.hider();
select lives_ok(format($$ select public.mark_trivia(pg_temp.gid(), %L, array[false, true, false], pg_temp.uid(46), pg_temp.seq()) $$,
  current_setting('test.me')), 'one right');
reset role;
select is((select status from public.card_effects where id = current_setting('test.me')::uuid), 'cleared',
  'one right clears Moll');
select is((select payload ->> 'reset' from pg_temp.last_event('trivia_marked')), 'false', 'no reset this time');
set local role authenticated;

-- ---------------------------------------------------------------- drink cards alert both teams

select pg_temp.play(current_setting('test.drinks')::uuid, 50);
reset role;
select is((select array[audience::text, title] from public.push_outbox
            where game_id = pg_temp.gid() and tag like '%card_played' order by id desc limit 1),
  array['all', 'Drinks All Round'], 'Drinks All Round alerts both teams');
select is(public._push_for_event('card_played', 'all',
    '{"card":{"name":"X","category":"drink","params":{"drinks":["seekers"]}}}'::jsonb) ->> 'audience',
  'seekers', 'a drink for one team alerts that team');
select is(public._push_for_event('card_played', 'hiders',
    '{"card":{"name":"X","category":"drink","params":{"drinks":["hiders","seekers"]}}}'::jsonb),
  null, 'never wider than the event');

-- ---------------------------------------------------------------- privileges

select ok(has_function_privilege('authenticated', 'public.check_curse(uuid, uuid, boolean, uuid, bigint)', 'execute'),
  'clients can call check_curse');
select ok(not has_function_privilege('authenticated', 'public._question_used(public.games, text, text)', 'execute'),
  'but not the helpers');

select * from finish();
rollback;
