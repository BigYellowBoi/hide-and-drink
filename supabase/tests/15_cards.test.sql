-- Cards: deck snapshot, draw pile, draw/keep rewards, hand limit, playing cards and effects.
-- Time bonuses are not playable (20261201090000_time_bonus_in_hand.sql).
-- Players: H = host (seeker), A = hider, S = seeker.
-- now() is fixed inside this transaction, so the clock is "moved" by backdating rows, and
-- specific cards are put in the hand by moving rows directly (as the superuser).

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(65);

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
-- Ask a 1.5 km radar as S and answer it as A (radar rewards draw 2, keep 1). Returns the draw id.
create function pg_temp.ask_and_answer(n int) returns uuid language plpgsql as $$
declare
  v_q text;
  v_r jsonb;
begin
  perform pg_temp.as_user('33333333-3333-3333-3333-333333333333');
  v_q := public.ask_question(pg_temp.gid(), 'radar', 'custom', '{"center":[153.025,-27.47],"distance_m":1500}',
    pg_temp.uid(n), pg_temp.seq()) ->> 'question_id';
  perform pg_temp.as_user('22222222-2222-2222-2222-222222222222');
  v_r := public.answer_question(pg_temp.gid(), v_q::uuid, 'yes', pg_temp.uid(n + 1), pg_temp.seq());
  return (v_r ->> 'draw_id')::uuid;
end;
$$;
-- Put an unplayed card of this kind straight into the hand (test setup). Returns its instance id.
create function pg_temp.to_hand(p_card text) returns uuid language sql as $$
  update public.card_instances set location = 'hand'
   where id = (select id from public.card_instances
                where game_id = pg_temp.gid() and card_id = p_card and location <> 'played' order by pile_pos limit 1)
  returning id;
$$;
grant execute on all functions in schema pg_temp to authenticated;

-- ---------------------------------------------------------------- setup

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
set local role authenticated;
select set_config('test.game_id',
  public.create_game('Host', pg_temp.uid(1), 'brisbane',
    '{"hiding_period_s":1800,"hand_limit":3,"deck":{"cheers":1,"nope":2}}'::jsonb) ->> 'game_id', true);
select set_config('test.code', (select code from public.games where id = pg_temp.gid()), true);

select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select public.join_game(current_setting('test.code'), 'Amy', pg_temp.uid(2));
select public.set_team(pg_temp.gid(), 'hiders', pg_temp.uid(3));
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select public.join_game(current_setting('test.code'), 'Sam', pg_temp.uid(4));
select public.set_team(pg_temp.gid(), 'seekers', pg_temp.uid(5));
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select public.set_team(pg_temp.gid(), 'seekers', pg_temp.uid(6));
select public.set_play_area(pg_temp.gid(), current_setting('test.area_id')::uuid, pg_temp.uid(7), pg_temp.seq());

-- ---------------------------------------------------------------- deck snapshot

-- A deck set at create time may name cards that don't exist (or were retired since): start
-- drops them. set_deck refuses them outright.
select throws_ok(
  $$ select public.set_deck(pg_temp.gid(), '{"cheers":1,"nope":2}'::jsonb, pg_temp.uid(8)) $$,
  'P0001', 'invalid_deck', 'unknown cards in a deck are refused'
);
select public.set_deck(pg_temp.gid(), '{"cheers":0}'::jsonb, pg_temp.uid(9));
select throws_ok(
  $$ select public.start_game(pg_temp.gid(), pg_temp.uid(10), pg_temp.seq()) $$,
  'P0001', 'deck_empty', 'a deck with no cards is refused'
);
select public.set_deck(pg_temp.gid(), '{
  "cheers":1,"right_turn":1,"escape":1,"distant_cuisine":1,"clash":1,"bonus_red":4,"veto":1,"nathan":0}'::jsonb,
  pg_temp.uid(11));
select lives_ok($$ select public.start_game(pg_temp.gid(), pg_temp.uid(12), pg_temp.seq()) $$, 'game starts');

select is(
  (select jsonb_array_length(payload -> 'deck') from public.events where game_id = pg_temp.gid() and type = 'game_started'),
  7, 'game_started lists the deck: one entry per card with copies > 0'
);
select is(
  (select sum((c ->> 'copies')::int)::int from public.events e, jsonb_array_elements(e.payload -> 'deck') c
    where e.game_id = pg_temp.gid() and e.type = 'game_started'),
  10, 'deck list counts copies'
);
select is(
  (select c - 'params' from public.events e, jsonb_array_elements(e.payload -> 'deck') c
    where e.game_id = pg_temp.gid() and e.type = 'game_started' and c ->> 'card_id' = 'right_turn'),
  jsonb_build_object('card_id', 'right_turn', 'name', 'Curse of Right Turn', 'category', 'curse',
    'category_name', 'Curse', 'colour', '#EC353A',
    'behaviour', 'timed', 'text', (select body from public.cards where id = 'right_turn'),
    'cast_cost', 'drink', 'can_veto', true, 'copies', 1),
  'deck entries carry the card content'
);
select is((select (payload ->> 'hand_limit')::int from public.events
            where game_id = pg_temp.gid() and type = 'game_started'), 3, 'hand limit from config');

reset role;
select is((select count(*)::int from public.card_instances where game_id = pg_temp.gid() and location = 'pile'),
  10, 'one pile card per copy');
select is((select count(distinct pile_pos)::int from public.card_instances where game_id = pg_temp.gid()),
  10, 'every card has its own pile position');
-- Library edits after the start don't reach the running game.
update public.cards set body = 'edited' where id = 'cheers';
select is((select body from public.game_cards where game_id = pg_temp.gid() and card_id = 'cheers'),
  'One team member from each team must drink asap.', 'card content is snapshotted at the start');
update public.games set round_started_at = now() - interval '31 minutes' where id = pg_temp.gid();
set local role authenticated;


-- ---------------------------------------------------------------- draw and keep

select set_config('test.draw1', pg_temp.ask_and_answer(20)::text, true);
select is(
  (select array[visibility::text, jsonb_array_length(payload -> 'cards')::text, payload ->> 'pick', payload ->> 'pile_left']
     from public.events where game_id = pg_temp.gid() and type = 'cards_drawn'),
  array['hiders', '2', '1', '8'], 'answering draws the reward, hider-only'
);
select is(
  array(select type from public.events where game_id = pg_temp.gid() order by seq desc limit 2),
  array['cards_drawn', 'question_answered'], 'the draw is logged after the answer'
);

select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select is((select count(*)::int from public.events where game_id = pg_temp.gid() and type in ('cards_drawn', 'cards_kept')),
  0, 'seekers cannot read the draw');
select throws_ok(
  format($$ select public.keep_cards(pg_temp.gid(), %L, '{}', '{}', pg_temp.uid(30), pg_temp.seq()) $$, current_setting('test.draw1')),
  'P0001', 'hiders_only', 'seekers cannot keep cards'
);

select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
reset role;
select set_config('test.drawn', (select string_agg(id::text, ',' order by pile_pos) from public.card_instances
  where draw_id = current_setting('test.draw1')::uuid), true);
set local role authenticated;
select throws_ok(
  format($$ select public.keep_cards(pg_temp.gid(), %L, %L, '{}', pg_temp.uid(31), pg_temp.seq()) $$,
    current_setting('test.draw1'), '{' || current_setting('test.drawn') || '}'),
  'P0001', 'invalid_keep', 'must keep exactly pick cards (not more)'
);
select throws_ok(
  format($$ select public.keep_cards(pg_temp.gid(), %L, '{}', '{}', pg_temp.uid(32), pg_temp.seq()) $$, current_setting('test.draw1')),
  'P0001', 'invalid_keep', 'must keep exactly pick cards (not fewer)'
);
select throws_ok(
  format($$ select public.keep_cards(pg_temp.gid(), %L, %L, '{}', pg_temp.uid(33), pg_temp.seq()) $$,
    current_setting('test.draw1'), '{' || gen_random_uuid() || '}'),
  'P0001', 'invalid_keep', 'kept cards must come from the draw'
);
select lives_ok(
  format($$ select public.keep_cards(pg_temp.gid(), %L, %L, '{}', pg_temp.uid(34), pg_temp.seq()) $$,
    current_setting('test.draw1'), '{' || split_part(current_setting('test.drawn'), ',', 1) || '}'),
  'hider keeps one'
);
select is(
  (select array[visibility::text, payload -> 'kept' ->> 0, payload -> 'discarded' ->> 0]
     from public.events where game_id = pg_temp.gid() and type = 'cards_kept'),
  array['hiders', split_part(current_setting('test.drawn'), ',', 1), split_part(current_setting('test.drawn'), ',', 2)],
  'cards_kept lists kept and discarded, hider-only'
);
reset role;
select is(
  array(select location from public.card_instances where draw_id = current_setting('test.draw1')::uuid order by pile_pos),
  array['hand', 'discarded'], 'kept card is in the hand, the other discarded'
);
set local role authenticated;
select lives_ok(
  format($$ select public.keep_cards(pg_temp.gid(), %L, %L, '{}', pg_temp.uid(34), 0) $$,
    current_setting('test.draw1'), '{' || split_part(current_setting('test.drawn'), ',', 1) || '}'),
  'a retried keep returns the first result'
);
select is((select count(*)::int from public.events where game_id = pg_temp.gid() and type = 'cards_kept'), 1,
  'retry adds no event');
select throws_ok(
  format($$ select public.keep_cards(pg_temp.gid(), %L, %L, '{}', pg_temp.uid(35), pg_temp.seq()) $$,
    current_setting('test.draw1'), '{' || split_part(current_setting('test.drawn'), ',', 2) || '}'),
  'P0001', 'draw_not_pending', 'a draw is kept once'
);

-- ---------------------------------------------------------------- hand limit

reset role;
update public.card_instances set location = 'hand'
 where id in (select id from public.card_instances where game_id = pg_temp.gid() and location = 'pile'
               order by pile_pos limit 2);
set local role authenticated;
select set_config('test.draw2', pg_temp.ask_and_answer(40)::text, true);
reset role;
select set_config('test.d2', (select id::text from public.card_instances
  where draw_id = current_setting('test.draw2')::uuid order by pile_pos limit 1), true);
select set_config('test.h1', (select id::text from public.card_instances
  where game_id = pg_temp.gid() and location = 'hand' order by pile_pos limit 1), true);
select set_config('test.d2b', (select id::text from public.card_instances
  where draw_id = current_setting('test.draw2')::uuid order by pile_pos offset 1 limit 1), true);
set local role authenticated;
select throws_ok(
  format($$ select public.keep_cards(pg_temp.gid(), %L, %L, '{}', pg_temp.uid(42), pg_temp.seq()) $$,
    current_setting('test.draw2'), '{' || current_setting('test.d2') || '}'),
  'P0001', 'hand_full', 'keeping cannot go over the hand limit'
);
select throws_ok(
  format($$ select public.keep_cards(pg_temp.gid(), %L, %L, %L, pg_temp.uid(43), pg_temp.seq()) $$,
    current_setting('test.draw2'), '{' || current_setting('test.d2') || '}', '{' || current_setting('test.d2b') || '}'),
  'P0001', 'card_not_in_hand', 'only hand cards or kept cards can be discarded to make room'
);
select lives_ok(
  format($$ select public.keep_cards(pg_temp.gid(), %L, %L, %L, pg_temp.uid(44), pg_temp.seq()) $$,
    current_setting('test.draw2'), '{' || current_setting('test.d2') || '}', '{' || current_setting('test.h1') || '}'),
  'discarding from the hand makes room'
);
reset role;
select is((select count(*)::int from public.card_instances where game_id = pg_temp.gid() and location = 'hand'), 3,
  'hand stays at the limit');
select is((select location from public.card_instances where id = current_setting('test.h1')::uuid), 'discarded',
  'the hand card was discarded');
-- Clear the hand for the play tests.
-- Photo evidence for curses is covered in 19_card_proofs_picking.test.sql.
update public.game_cards set params = params - 'proof' where game_id = pg_temp.gid();
update public.card_instances set location = 'discarded' where game_id = pg_temp.gid() and location = 'hand';
select set_config('test.cuisine', pg_temp.to_hand('distant_cuisine')::text, true);
select set_config('test.clash', pg_temp.to_hand('clash')::text, true);
select set_config('test.escape', pg_temp.to_hand('escape')::text, true);
select set_config('test.right', pg_temp.to_hand('right_turn')::text, true);
select set_config('test.bonus', pg_temp.to_hand('bonus_red')::text, true);
select set_config('test.cheers', pg_temp.to_hand('cheers')::text, true);
select set_config('test.veto', pg_temp.to_hand('veto')::text, true);
set local role authenticated;

-- ---------------------------------------------------------------- until_cleared

select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select throws_ok(
  format($$ select public.play_card(pg_temp.gid(), %L, pg_temp.uid(50), pg_temp.seq()) $$, current_setting('test.cuisine')),
  'P0001', 'hiders_only', 'seekers cannot play cards'
);
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select throws_ok(
  $$ select public.play_card(pg_temp.gid(), gen_random_uuid(), pg_temp.uid(51), pg_temp.seq()) $$,
  'P0001', 'card_not_in_hand', 'only cards in the hand can be played'
);
select set_config('test.e1',
  public.play_card(pg_temp.gid(), current_setting('test.cuisine')::uuid, pg_temp.uid(52), pg_temp.seq()) ->> 'effect_id', true);
select is(
  (select array[visibility::text, payload #>> '{card,card_id}', payload #>> '{card,cast_cost}', payload ->> 'blocks_questions',
                payload ->> 'effect_id']
     from public.events where game_id = pg_temp.gid() and type = 'card_played'),
  array['all', 'distant_cuisine', 'free', 'true', current_setting('test.e1')],
  'card_played goes to everyone with the card and its effect'
);
select throws_ok(
  format($$ select public.play_card(pg_temp.gid(), %L, pg_temp.uid(53), pg_temp.seq()) $$, current_setting('test.cuisine')),
  'P0001', 'card_not_in_hand', 'a card is played once'
);

select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select throws_ok(
  $$ select public.ask_question(pg_temp.gid(), 'radar', '1km', '{"center":[153.025,-27.47]}', pg_temp.uid(54), pg_temp.seq()) $$,
  'P0001', 'questions_blocked', 'a blocking curse stops questions'
);
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select throws_ok(
  format($$ select public.clear_effect(pg_temp.gid(), %L, pg_temp.uid(55), pg_temp.seq()) $$, current_setting('test.e1')),
  'P0001', 'seekers_only', 'only seekers say they did it'
);
select throws_ok(
  format($$ select public.confirm_clear(pg_temp.gid(), %L, true, pg_temp.uid(56), pg_temp.seq()) $$, current_setting('test.e1')),
  'P0001', 'clear_not_requested', 'the hider confirms only after the seekers ask'
);
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select lives_ok(
  format($$ select public.clear_effect(pg_temp.gid(), %L, pg_temp.uid(57), pg_temp.seq()) $$, current_setting('test.e1')),
  'seekers tap Done'
);
select throws_ok(
  format($$ select public.clear_effect(pg_temp.gid(), %L, pg_temp.uid(58), pg_temp.seq()) $$, current_setting('test.e1')),
  'P0001', 'effect_not_active', 'Done once per request'
);
select throws_ok(
  $$ select public.ask_question(pg_temp.gid(), 'radar', '1km', '{"center":[153.025,-27.47]}', pg_temp.uid(59), pg_temp.seq()) $$,
  'P0001', 'questions_blocked', 'still blocked until the hider confirms'
);
select throws_ok(
  format($$ select public.confirm_clear(pg_temp.gid(), %L, true, pg_temp.uid(60), pg_temp.seq()) $$, current_setting('test.e1')),
  'P0001', 'hiders_only', 'seekers cannot confirm'
);
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select lives_ok(
  format($$ select public.confirm_clear(pg_temp.gid(), %L, false, pg_temp.uid(61), pg_temp.seq()) $$, current_setting('test.e1')),
  'hider says not yet'
);
reset role;
select is((select status from public.card_effects where id = current_setting('test.e1')::uuid), 'active',
  'rejected: back to active');
set local role authenticated;
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select public.clear_effect(pg_temp.gid(), current_setting('test.e1')::uuid, pg_temp.uid(62), pg_temp.seq());
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select lives_ok(
  format($$ select public.confirm_clear(pg_temp.gid(), %L, true, pg_temp.uid(63), pg_temp.seq()) $$, current_setting('test.e1')),
  'hider confirms'
);
select is(
  array(select type from public.events where game_id = pg_temp.gid() and type like 'effect_%' order by seq),
  array['effect_clear_requested', 'effect_clear_rejected', 'effect_clear_requested', 'effect_cleared'],
  'the clear flow is logged for everyone'
);

-- A non-blocking until_cleared curse leaves questions open.
select lives_ok(
  format($$ select public.play_card(pg_temp.gid(), %L, pg_temp.uid(64), pg_temp.seq()) $$, current_setting('test.clash')),
  'hider plays a non-blocking curse'
);
select lives_ok($$ select pg_temp.ask_and_answer(65) $$, 'questions open again once cleared, and with a non-blocking curse');
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');

-- ---------------------------------------------------------------- timed

select set_config('test.e2',
  public.play_card(pg_temp.gid(), current_setting('test.escape')::uuid, pg_temp.uid(70), pg_temp.seq()) ->> 'effect_id', true);
select is(
  (select array[payload ->> 'duration_s', payload ->> 'followup_s',
                ((payload ->> 'ends_at')::timestamptz - now())::text]
     from public.events where game_id = pg_temp.gid() and type = 'card_played' order by seq desc limit 1),
  array['180', '600', '00:03:00'], 'timed card: countdown from server time'
);
select throws_ok(
  format($$ select public.start_followup(pg_temp.gid(), %L, pg_temp.uid(71), pg_temp.seq()) $$, current_setting('test.e2')),
  'P0001', 'timer_still_running', 'follow-on only after the countdown'
);
reset role;
update public.card_effects set ends_at = now() - interval '1 second' where id = current_setting('test.e2')::uuid;
set local role authenticated;
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select lives_ok(
  format($$ select public.start_followup(pg_temp.gid(), %L, pg_temp.uid(72), pg_temp.seq()) $$, current_setting('test.e2')),
  'any player starts the follow-on timer'
);
select is(
  (select ((payload ->> 'ends_at')::timestamptz - now())::text from public.events
    where game_id = pg_temp.gid() and type = 'effect_followup_started'),
  '00:10:00', 'follow-on runs followup_s'
);
select throws_ok(
  format($$ select public.start_followup(pg_temp.gid(), %L, pg_temp.uid(73), pg_temp.seq()) $$, current_setting('test.e2')),
  'P0001', 'followup_already_started', 'follow-on starts once'
);
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select set_config('test.e3',
  public.play_card(pg_temp.gid(), current_setting('test.right')::uuid, pg_temp.uid(74), pg_temp.seq()) ->> 'effect_id', true);
select throws_ok(
  format($$ select public.start_followup(pg_temp.gid(), %L, pg_temp.uid(75), pg_temp.seq()) $$, current_setting('test.e3')),
  'P0001', 'no_followup', 'cards without followup_s have none'
);

-- Timed with a follow-on is a task: seekers can mark it done (hider confirms), until the lock starts.
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select throws_ok(
  format($$ select public.clear_effect(pg_temp.gid(), %L, pg_temp.uid(176), pg_temp.seq()) $$, current_setting('test.e2')),
  'P0001', 'effect_not_active', 'missed it: once the lock runs it can''t be cleared'
);
select throws_ok(
  format($$ select public.clear_effect(pg_temp.gid(), %L, pg_temp.uid(177), pg_temp.seq()) $$, current_setting('test.e3')),
  'P0001', 'effect_not_active', 'a plain timed curse just runs out'
);
reset role;
-- A fresh Escape: countdown running, no lock yet.
update public.card_effects set ends_at = now() + interval '3 minutes', followup_ends_at = null
 where id = current_setting('test.e2')::uuid;
set local role authenticated;
select lives_ok(
  format($$ select public.clear_effect(pg_temp.gid(), %L, pg_temp.uid(178), pg_temp.seq()) $$, current_setting('test.e2')),
  'seekers say they got out while the countdown runs'
);
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select lives_ok(
  format($$ select public.confirm_clear(pg_temp.gid(), %L, true, pg_temp.uid(179), pg_temp.seq()) $$, current_setting('test.e2')),
  'hider confirms'
);
reset role;
select is((select status from public.card_effects where id = current_setting('test.e2')::uuid), 'cleared', 'Escape cleared');
update public.card_effects set ends_at = now() - interval '1 second' where id = current_setting('test.e2')::uuid;
set local role authenticated;
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select throws_ok(
  format($$ select public.start_followup(pg_temp.gid(), %L, pg_temp.uid(181), pg_temp.seq()) $$, current_setting('test.e2')),
  'P0001', 'effect_not_active', 'a cleared task has no lock'
);
select throws_ok(
  format($$ select public.start_followup(pg_temp.gid(), %L, pg_temp.uid(182), pg_temp.seq()) $$, current_setting('test.e2')),
  'P0001', 'effect_not_active', 'still none on retry'
);
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');

-- ---------------------------------------------------------------- time bonus, text, unsupported

select throws_ok(
  format($$ select public.play_card(pg_temp.gid(), %L, pg_temp.uid(80), pg_temp.seq()) $$, current_setting('test.bonus')),
  'P0001', 'card_not_playable', 'time bonuses stay in the hand until the end of the round'
);
reset role;
select is((select location from public.card_instances where id = current_setting('test.bonus')::uuid), 'hand',
  'the refused time bonus is still in the hand');
set local role authenticated;
select lives_ok(
  format($$ select public.play_card(pg_temp.gid(), %L, pg_temp.uid(81), pg_temp.seq()) $$, current_setting('test.cheers')),
  'text card is shown to everyone'
);
select throws_ok(
  format($$ select public.play_card(pg_temp.gid(), %L, pg_temp.uid(82), pg_temp.seq()) $$, current_setting('test.veto')),
  'P0001', 'no_pending_question', 'a veto needs a pending question'
);

-- ---------------------------------------------------------------- short and empty pile

reset role;
-- Leave exactly one card in the pile.
update public.card_instances set location = 'discarded' where game_id = pg_temp.gid() and location = 'pile';
update public.card_instances set location = 'pile', draw_id = null
 where id = (select id from public.card_instances where game_id = pg_temp.gid() and location = 'discarded'
              order by pile_pos limit 1);
set local role authenticated;
select pg_temp.ask_and_answer(90);
select is(
  (select array[jsonb_array_length(payload -> 'cards')::text, payload ->> 'pick', payload ->> 'pile_left']
     from public.events where game_id = pg_temp.gid() and type = 'cards_drawn' order by seq desc limit 1),
  array['1', '1', '0'], 'a short pile draws what is left'
);
select is(pg_temp.ask_and_answer(92), null, 'an empty pile draws nothing');
select is(
  (select type from public.events where game_id = pg_temp.gid() order by seq desc limit 1),
  'question_answered', 'no draw event from an empty pile'
);

select * from finish();
rollback;
