-- Powerups, next-question modifiers, question bans, seeker vetoes, dice/wheel and drink
-- proofs (20261202090000_powerups_vetoes_proofs.sql).
-- Players: H = host (seeker), A = hider, S = seeker. Cards are put in the hand directly.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(74);

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
  select ('eeeeeeee-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid
$$;
create function pg_temp.hider() returns void language sql as $$
  select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
$$;
create function pg_temp.seeker() returns void language sql as $$
  select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
$$;
-- Ask a radar as S. Returns the question id.
create function pg_temp.ask(n int, p_option text default '1km') returns uuid language plpgsql as $$
begin
  perform pg_temp.seeker();
  return (public.ask_question(pg_temp.gid(), 'radar', p_option, '{"center":[153.025,-27.47]}',
    pg_temp.uid(n), pg_temp.seq()) ->> 'question_id')::uuid;
end;
$$;
create function pg_temp.answer(q uuid, n int) returns uuid language plpgsql as $$
begin
  perform pg_temp.hider();
  return (public.answer_question(pg_temp.gid(), q, 'yes', pg_temp.uid(n), pg_temp.seq()) ->> 'draw_id')::uuid;
end;
$$;
-- An unplayed card of this kind straight into the hand. Returns its instance id.
create function pg_temp.to_hand(p_card text) returns uuid language sql as $$
  update public.card_instances set location = 'hand'
   where id = (select id from public.card_instances
                where game_id = pg_temp.gid() and card_id = p_card and location <> 'played'
                order by location = 'hand' desc, pile_pos limit 1)
  returning id;
$$;
create function pg_temp.play(p uuid, n int, p_choice jsonb default null) returns jsonb language plpgsql as $$
begin
  perform pg_temp.hider();
  return public.play_card(pg_temp.gid(), p, pg_temp.uid(n), pg_temp.seq(), p_choice);
end;
$$;
create function pg_temp.last_event(p_type text) returns public.events language sql as $$
  select * from public.events where game_id = pg_temp.gid() and type = p_type order by seq desc limit 1;
$$;
-- Test-only reads of tables clients can't see.
create function pg_temp.pending() returns uuid language sql security definer as $$
  select id from public.questions where game_id = pg_temp.gid() and answered_at is null;
$$;
create function pg_temp.drawn(p_draw uuid, n int) returns uuid[] language sql security definer as $$
  select array_agg(id) from (select id from public.card_instances where draw_id = p_draw order by pile_pos limit n) x;
$$;
grant execute on all functions in schema pg_temp to authenticated;

-- ---------------------------------------------------------------- setup

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
set local role authenticated;
select set_config('test.game_id',
  public.create_game('Host', pg_temp.uid(1), 'brisbane', '{"hiding_period_s":1800,"hand_limit":6,
    "veto":{"base_lock_s":600,"step_s":300},
    "deck":{"veto":1,"randomize":2,"duplicate":1,"move":1,"discard1_draw2":1,"double_next_rewards":1,
            "drained_brain":1,"right_turn":1,"distant_cuisine":1,"jammed_door":1,"impression":1,
            "u_turn":1,"cheers":1,"bonus_red":10}}'::jsonb) ->> 'game_id', true);
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

select pg_temp.hider();
select set_config('test.bars', array_to_string(public.hiding_bars(pg_temp.gid()), ','), true);
select public.choose_bar(pg_temp.gid(), split_part(current_setting('test.bars'), ',', 1), pg_temp.uid(9), pg_temp.seq());

reset role;
update public.games set round_started_at = now() - interval '31 minutes' where id = pg_temp.gid();
select set_config('test.veto', pg_temp.to_hand('veto')::text, true);
select set_config('test.rand', pg_temp.to_hand('randomize')::text, true);
select set_config('test.dup', pg_temp.to_hand('duplicate')::text, true);
select set_config('test.cheers', pg_temp.to_hand('cheers')::text, true);
set local role authenticated;

-- ---------------------------------------------------------------- veto (powerup)

select set_config('test.q1', pg_temp.ask(10)::text, true);
select lives_ok(format($$ select pg_temp.play(%L, 11) $$, current_setting('test.veto')), 'hider vetoes the pending question');
reset role;
select is((select closed_by from public.questions where id = current_setting('test.q1')::uuid), 'veto',
  'the question is closed by the veto');
select is((select answer from public.questions where id = current_setting('test.q1')::uuid), null, 'with no answer');
select is((select count(*)::int from public.card_draws where question_id = current_setting('test.q1')::uuid), 0,
  'and no reward');
select is((select array[visibility::text, payload ->> 'question_id'] from pg_temp.last_event('card_played')),
  array['all', current_setting('test.q1')], 'the veto is public and names the question');
set local role authenticated;
select pg_temp.hider();
select throws_ok(
  format($$ select public.answer_question(pg_temp.gid(), %L, 'yes', pg_temp.uid(12), pg_temp.seq()) $$, current_setting('test.q1')),
  'P0001', 'question_not_pending', 'a vetoed question cannot be answered'
);
select lives_ok($$ select pg_temp.ask(13) $$, 'seekers can ask again (the same question too)');

-- ---------------------------------------------------------------- randomize

select set_config('test.q2', pg_temp.pending()::text, true);
select set_config('test.r', pg_temp.play(current_setting('test.rand')::uuid, 14)::text, true);
reset role;
select is((select closed_by from public.questions where id = current_setting('test.q2')::uuid), 'randomize',
  'the old question is closed');
select isnt((current_setting('test.r')::jsonb ->> 'question_id'), null, 'a new question replaces it');
select is(
  (select array[type, (option_id <> '1km' and option_id <> 'custom')::text, (params -> 'center' = '[153.025, -27.47]'::jsonb)::text, asked_by::text]
     from public.questions where id = (current_setting('test.r')::jsonb ->> 'question_id')::uuid),
  array['radar', 'true', 'true', '33333333-3333-3333-3333-333333333333'],
  'same type, another fixed option, same position, same asker'
);
select is(
  array(select type from public.events where game_id = pg_temp.gid() order by seq desc limit 2),
  array['question_asked', 'card_played'], 'logged as card then new question'
);
select is((select payload ->> 'randomized_from' from pg_temp.last_event('question_asked')), current_setting('test.q2'),
  'the new question says what it replaced');
set local role authenticated;

-- ---------------------------------------------------------------- next question modifier

reset role;
select set_config('test.dbl', pg_temp.to_hand('double_next_rewards')::text, true);
set local role authenticated;
select lives_ok(format($$ select pg_temp.play(%L, 15) $$, current_setting('test.dbl')), 'hider plays double rewards');
reset role;
select is((select array[cost, team::text] from public.drink_proofs
            where game_id = pg_temp.gid() and label = 'Take a Shot to Double Next Question Rewards'),
  array['shot', 'hiders'], 'params.cost opens a shot proof for the hider');
set local role authenticated;
select set_config('test.draw2',
  pg_temp.answer((current_setting('test.r')::jsonb ->> 'question_id')::uuid, 16)::text, true);
reset role;
select is((select array[drawn, pick] from public.card_draws where id = current_setting('test.draw2')::uuid),
  array[4, 2], 'radar reward 2/1 doubled to 4/2');
select is((select payload -> 'reward' from pg_temp.last_event('question_answered')),
  '{"draw":4,"pick":2}'::jsonb, 'the answer event shows the doubled reward');
set local role authenticated;
select pg_temp.hider();
select public.keep_cards(pg_temp.gid(), current_setting('test.draw2')::uuid,
  pg_temp.drawn(current_setting('test.draw2')::uuid, 2),
  '{}', pg_temp.uid(17), pg_temp.seq());
select set_config('test.q3', pg_temp.ask(18)::text, true);
select set_config('test.draw3', pg_temp.answer(current_setting('test.q3')::uuid, 19)::text, true);
reset role;
select is((select array[drawn, pick] from public.card_draws where id = current_setting('test.draw3')::uuid),
  array[2, 1], 'the modifier is used up');
set local role authenticated;
select pg_temp.hider();
select public.keep_cards(pg_temp.gid(), current_setting('test.draw3')::uuid,
  pg_temp.drawn(current_setting('test.draw3')::uuid, 1),
  '{}', pg_temp.uid(20), pg_temp.seq());

-- ---------------------------------------------------------------- duplicate

select throws_ok(format($$ select pg_temp.play(%L, 21, '{"target":%s}') $$, current_setting('test.dup'),
    to_jsonb(current_setting('test.dup'))),
  'P0001', 'invalid_choice', 'duplicate cannot copy itself');
select lives_ok(format($$ select pg_temp.play(%L, 22, '{"target":%s}') $$, current_setting('test.dup'),
    to_jsonb(current_setting('test.cheers'))),
  'duplicate copies another card in the hand');
reset role;
select is((select count(*)::int from public.card_instances
            where game_id = pg_temp.gid() and card_id = 'cheers' and location = 'hand'), 2, 'two Cheers in the hand');
select is((select visibility::text from pg_temp.last_event('card_played')), 'hiders', 'duplicate is hider-only');
set local role authenticated;

-- ---------------------------------------------------------------- drink cards: proofs for both teams

select lives_ok(format($$ select pg_temp.play(%L, 23) $$, current_setting('test.cheers')), 'hider plays Cheers');
reset role;
select is(
  array(select team::text || ':' || cost from public.drink_proofs where game_id = pg_temp.gid() and label = 'Cheers' order by team),
  array['hiders:drink', 'seekers:drink'], 'params.drinks opens a proof per team'
);
select is((select array[visibility::text, (actor_id is null)::text] from pg_temp.last_event('drink_due')),
  array['all', 'true'], 'drink_due is public with no actor');
select set_config('test.proof', (select id::text from public.drink_proofs
  where game_id = pg_temp.gid() and label = 'Cheers' and team = 'seekers'), true);
set local role authenticated;

select pg_temp.hider();
select throws_ok(
  format($$ select public.submit_drink_proof(pg_temp.gid(), %L, 'x', pg_temp.uid(24), pg_temp.seq()) $$, current_setting('test.proof')),
  'P0001', 'seekers_only', 'only the team that drank sends its proof');
select is(public.can_upload_drink_photo(pg_temp.gid() || '/' || current_setting('test.proof') || '/a.jpg'), false,
  'the other team cannot upload it');
select pg_temp.seeker();
select is(public.can_upload_drink_photo(pg_temp.gid() || '/' || current_setting('test.proof') || '/a.jpg'), true,
  'the drinking team can upload while open');
select throws_ok(
  format($$ select public.submit_drink_proof(pg_temp.gid(), %L, %L, pg_temp.uid(25), pg_temp.seq()) $$,
    current_setting('test.proof'), pg_temp.gid() || '/' || current_setting('test.proof') || '/a.jpg'),
  'P0001', 'photo_not_uploaded', 'the photo must be in storage');
reset role;
insert into storage.objects (bucket_id, name) values ('drink-photos', pg_temp.gid() || '/' || current_setting('test.proof') || '/a.jpg');
set local role authenticated;
select pg_temp.seeker();
select lives_ok(
  format($$ select public.submit_drink_proof(pg_temp.gid(), %L, %L, pg_temp.uid(26), pg_temp.seq()) $$,
    current_setting('test.proof'), pg_temp.gid() || '/' || current_setting('test.proof') || '/a.jpg'),
  'seeker sends the photo');
reset role;
select is((select array[visibility::text, payload ->> 'team', payload ->> 'path'] from pg_temp.last_event('drink_proved')),
  array['all', 'seekers', pg_temp.gid() || '/' || current_setting('test.proof') || '/a.jpg'],
  'drink_proved is public with the photo');
set local role authenticated;
select pg_temp.hider();
select is(public.can_read_drink_photo(pg_temp.gid() || '/' || current_setting('test.proof') || '/a.jpg'), true,
  'the other team can see it');
select pg_temp.seeker();
select throws_ok(
  format($$ select public.submit_drink_proof(pg_temp.gid(), %L, %L, pg_temp.uid(27), pg_temp.seq()) $$,
    current_setting('test.proof'), pg_temp.gid() || '/' || current_setting('test.proof') || '/a.jpg'),
  'P0001', 'proof_not_pending', 'a proof is sent once');
select is(public.can_upload_drink_photo(pg_temp.gid() || '/' || current_setting('test.proof') || '/b.jpg'), false,
  'no uploads once proved');

-- ---------------------------------------------------------------- question ban

reset role;
select set_config('test.ban', pg_temp.to_hand('drained_brain')::text, true);
set local role authenticated;
select throws_ok(format($$ select pg_temp.play(%L, 30, '{"bans":[{"type":"radar","option_id":"500m"}]}') $$, current_setting('test.ban')),
  'P0001', 'invalid_choice', 'must ban exactly params.count questions');
select throws_ok(format($$ select pg_temp.play(%L, 31, '{"bans":[{"type":"radar","option_id":"500m"},
    {"type":"radar","option_id":"2km"},{"type":"photos","option_id":"tree"}]}') $$, current_setting('test.ban')),
  'P0001', 'invalid_choice', 'distinct_types: one per type');
select throws_ok(format($$ select pg_temp.play(%L, 32, '{"bans":[{"type":"radar","option_id":"nope"},
    {"type":"matching","option_id":"park"},{"type":"photos","option_id":"tree"}]}') $$, current_setting('test.ban')),
  'P0001', 'invalid_choice', 'banned questions must exist');
select lives_ok(format($$ select pg_temp.play(%L, 33, '{"bans":[{"type":"radar","option_id":"500m"},
    {"type":"matching","option_id":"park"},{"type":"photos","option_id":"tree"}]}') $$, current_setting('test.ban')),
  'hider bans three questions');
reset role;
select is((select jsonb_array_length(payload -> 'bans') from pg_temp.last_event('card_played')), 3,
  'the bans are public');
select is((select count(*)::int from public.drink_proofs where game_id = pg_temp.gid() and label = 'Curse of Drained Brain'),
  1, 'its shot cast cost opens a proof');
set local role authenticated;
select throws_ok($$ select pg_temp.ask(34, '500m') $$, 'P0001', 'question_banned', 'a banned question is refused');
select pg_temp.seeker();
select throws_ok(
  format($$ select public.veto_curse(pg_temp.gid(), %L, pg_temp.uid(35), pg_temp.seq()) $$, current_setting('test.ban')),
  'P0001', 'cannot_veto', 'curses marked Can''t veto cannot be vetoed');

-- ---------------------------------------------------------------- seeker veto with escalating locks

reset role;
select set_config('test.c1', pg_temp.to_hand('distant_cuisine')::text, true);
select set_config('test.c2', pg_temp.to_hand('right_turn')::text, true);
select set_config('test.c3', pg_temp.to_hand('jammed_door')::text, true);
set local role authenticated;
select set_config('test.e1', pg_temp.play(current_setting('test.c1')::uuid, 40) ->> 'effect_id', true);
select throws_ok($$ select pg_temp.ask(41) $$, 'P0001', 'questions_blocked', 'the curse blocks questions');
select pg_temp.hider();
select throws_ok(
  format($$ select public.veto_curse(pg_temp.gid(), %L, pg_temp.uid(42), pg_temp.seq()) $$, current_setting('test.c1')),
  'P0001', 'seekers_only', 'only seekers veto');
select pg_temp.seeker();
select lives_ok(
  format($$ select public.veto_curse(pg_temp.gid(), %L, pg_temp.uid(43), pg_temp.seq()) $$, current_setting('test.c1')),
  'seekers veto the curse');
reset role;
select is((select status from public.card_effects where id = current_setting('test.e1')::uuid), 'vetoed', 'its effect ends');
select is(
  (select array[payload ->> 'veto_number', payload ->> 'lock_s',
                ((payload ->> 'lock_ends_at')::timestamptz - now())::text]
     from pg_temp.last_event('curse_vetoed')),
  array['1', '600', '00:10:00'], 'first veto: base lock'
);
select is((select array[team::text, cost] from public.drink_proofs where game_id = pg_temp.gid() and label like 'Veto:%'),
  array['seekers', 'drink'], 'the veto opens a drink proof for the seekers');
set local role authenticated;
select lives_ok($$ select pg_temp.ask(44) $$, 'questions open again after the veto');
select pg_temp.seeker();
select throws_ok(
  format($$ select public.veto_curse(pg_temp.gid(), %L, pg_temp.uid(45), pg_temp.seq()) $$, current_setting('test.c1')),
  'P0001', 'already_vetoed', 'a curse is vetoed once');
select pg_temp.answer(pg_temp.pending(), 46);

select pg_temp.play(current_setting('test.c2')::uuid, 47);
select pg_temp.seeker();
select public.veto_curse(pg_temp.gid(), current_setting('test.c2')::uuid, pg_temp.uid(48), pg_temp.seq());
reset role;
select is(
  (select array[payload ->> 'veto_number', payload ->> 'lock_s',
                ((payload ->> 'lock_starts_at')::timestamptz - now())::text,
                ((payload ->> 'lock_ends_at')::timestamptz - now())::text]
     from pg_temp.last_event('curse_vetoed')),
  array['2', '900', '00:10:00', '00:25:00'], 'second veto: +step, starts when the first lock ends'
);
set local role authenticated;

-- ---------------------------------------------------------------- dice and wheel

select pg_temp.play(current_setting('test.c3')::uuid, 50);
select pg_temp.seeker();
select lives_ok(
  format($$ select public.roll_dice(pg_temp.gid(), %L, pg_temp.uid(51), pg_temp.seq()) $$, current_setting('test.c3')),
  'seekers roll for Jammed Door');
reset role;
select is(
  (select array[visibility::text, jsonb_array_length(payload -> 'dice')::text,
                ((payload ->> 'total')::int between 2 and 12)::text]
     from pg_temp.last_event('dice_rolled')),
  array['all', '2', 'true'], 'two server dice, public'
);
select ok((select bool_and(d::int between 1 and 6) from pg_temp.last_event('dice_rolled') e,
            jsonb_array_elements_text(e.payload -> 'dice') d), 'each die is 1 to 6');
set local role authenticated;
select pg_temp.hider();
select lives_ok(
  format($$ select public.roll_dice(pg_temp.gid(), %L, pg_temp.uid(52), pg_temp.seq()) $$, current_setting('test.c3')),
  'any player can roll');
select throws_ok(
  format($$ select public.spin_wheel(pg_temp.gid(), %L, pg_temp.uid(53), pg_temp.seq()) $$, current_setting('test.c3')),
  'P0001', 'no_utility', 'Jammed Door has no wheel');
select throws_ok(
  format($$ select public.roll_dice(pg_temp.gid(), %L, pg_temp.uid(54), pg_temp.seq()) $$, current_setting('test.c1')),
  'P0001', 'no_utility', 'cards without dice cannot roll');

reset role;
select set_config('test.imp', pg_temp.to_hand('impression')::text, true);
set local role authenticated;
select pg_temp.play(current_setting('test.imp')::uuid, 55);
select pg_temp.seeker();
select throws_ok(
  format($$ select public.spin_wheel(pg_temp.gid(), %L, pg_temp.uid(56), pg_temp.seq()) $$, current_setting('test.imp')),
  'P0001', 'wheel_not_configured', 'a wheel without wheel_options opens its link instead');
reset role;
update public.game_cards set params = params || '{"wheel_options":["Pirate","Robot","Cowboy"]}'
 where game_id = pg_temp.gid() and card_id = 'impression';
set local role authenticated;
select pg_temp.seeker();
select lives_ok(
  format($$ select public.spin_wheel(pg_temp.gid(), %L, pg_temp.uid(57), pg_temp.seq()) $$, current_setting('test.imp')),
  'seekers spin the wheel');
reset role;
select ok((select payload ->> 'result' in ('Pirate', 'Robot', 'Cowboy') and (payload ->> 'count')::int = 3
             from pg_temp.last_event('wheel_spun')), 'the wheel lands on one of its options');
-- Clear the blocking Impression curse for the rest of the test.
update public.card_effects set status = 'cleared' where game_id = pg_temp.gid() and card_id = 'impression';
set local role authenticated;

-- ---------------------------------------------------------------- discard / draw

reset role;
select set_config('test.dd', pg_temp.to_hand('discard1_draw2')::text, true);
select set_config('test.junk', (select id::text from public.card_instances
  where game_id = pg_temp.gid() and location = 'hand' and id <> current_setting('test.dd')::uuid
  order by pile_pos limit 1), true);
select set_config('test.hand_before', (select count(*)::text from public.card_instances
  where game_id = pg_temp.gid() and location = 'hand'), true);
set local role authenticated;
select throws_ok(format($$ select pg_temp.play(%L, 60, '{"discard":[%s]}') $$, current_setting('test.dd'),
    to_jsonb(current_setting('test.dd'))),
  'P0001', 'invalid_choice', 'discard_draw cannot discard itself');
select lives_ok(format($$ select pg_temp.play(%L, 61, '{"discard":[%s]}') $$, current_setting('test.dd'),
    to_jsonb(current_setting('test.junk'))),
  'hider discards 1 and draws 2');
reset role;
select is((select location from public.card_instances where id = current_setting('test.junk')::uuid), 'discarded',
  'the chosen card is discarded');
select is((select array[visibility::text, (payload ->> 'pick')::text, jsonb_array_length(payload -> 'cards')::text]
             from pg_temp.last_event('cards_drawn')),
  array['hiders', '2', '2'], 'then a hider-only draw of 2, keep 2');
select is((select visibility::text from pg_temp.last_event('card_played')), 'hiders', 'discard_draw is hider-only');
set local role authenticated;

-- ---------------------------------------------------------------- move

reset role;
select set_config('test.move', pg_temp.to_hand('move')::text, true);
set local role authenticated;
select set_config('test.q9', pg_temp.ask(70)::text, true);
select throws_ok(format($$ select pg_temp.play(%L, 71) $$, current_setting('test.move')),
  'P0001', 'question_pending', 'no move while a question is pending');
select pg_temp.answer(current_setting('test.q9')::uuid, 72);
select lives_ok(format($$ select pg_temp.play(%L, 73) $$, current_setting('test.move')), 'hider plays Move');
select throws_ok($$ select pg_temp.ask(74) $$, 'P0001', 'hider_moving', 'seekers wait while the hider moves');
select pg_temp.hider();
select throws_ok(
  format($$ select public.choose_bar(pg_temp.gid(), %L, pg_temp.uid(75), pg_temp.seq()) $$, split_part(current_setting('test.bars'), ',', 1)),
  'P0001', 'same_bar', 'must move to another bar');
select lives_ok(
  format($$ select public.choose_bar(pg_temp.gid(), %L, pg_temp.uid(76), pg_temp.seq()) $$, split_part(current_setting('test.bars'), ',', 2)),
  'hider picks a new bar');
reset role;
select is(
  array(select type || ':' || visibility::text from public.events where game_id = pg_temp.gid()
         and type in ('bar_chosen', 'hider_moved') order by seq desc limit 2),
  array['hider_moved:all', 'bar_chosen:hiders'], 'new bar is hider-only, seekers only hear the move is done'
);
select is((select payload ? 'venue_id' or payload ? 'lng' from pg_temp.last_event('hider_moved')), false,
  'hider_moved has no location');
select is((select venue_id from public.hider_bars where game_id = pg_temp.gid()), split_part(current_setting('test.bars'), ',', 2),
  'the bar is updated');
set local role authenticated;
select lives_ok($$ select pg_temp.ask(77) $$, 'seekers can ask again');
select pg_temp.hider();
select throws_ok(
  format($$ select public.choose_bar(pg_temp.gid(), %L, pg_temp.uid(78), pg_temp.seq()) $$, split_part(current_setting('test.bars'), ',', 3)),
  'P0001', 'bar_already_chosen', 'one move per Move card');

select * from finish();
rollback;
