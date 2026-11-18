-- Host overrides (20261213090000_host_overrides.sql): one test block per override, undo, and
-- the leak test for hider-only overrides requested by a seeker host.
-- Players: H = host (seeker), A = hider, S = seeker.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(131);

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
create function pg_temp.n() returns uuid language sql as $$ select gen_random_uuid() $$;
create function pg_temp.host() returns void language sql as $$ select pg_temp.as_user('11111111-1111-1111-1111-111111111111') $$;
create function pg_temp.hider() returns void language sql as $$ select pg_temp.as_user('22222222-2222-2222-2222-222222222222') $$;
create function pg_temp.seeker() returns void language sql as $$ select pg_temp.as_user('33333333-3333-3333-3333-333333333333') $$;
-- Run an override as the current user.
create function pg_temp.ov(p_kind text, p_params jsonb default '{}', p_reason text default 'test fix', p_request uuid default null)
returns jsonb language sql as $$
  select public.host_override(pg_temp.gid(), p_kind, p_params, p_reason, pg_temp.n(), pg_temp.seq(), p_request);
$$;
-- Agree to (or turn down) a request as the current user.
create function pg_temp.vote(p_request uuid, p_kind text default 'confirm') returns jsonb language sql as $$
  select public.host_override(pg_temp.gid(), p_kind, null, null, pg_temp.n(), pg_temp.seq(), p_request);
$$;
create function pg_temp.last_event(p_type text) returns public.events language sql security definer as $$
  select * from public.events where game_id = pg_temp.gid() and type = p_type order by seq desc limit 1;
$$;
create function pg_temp.q(p uuid) returns public.questions language sql security definer as $$
  select * from public.questions where id = p;
$$;
create function pg_temp.ask() returns uuid language plpgsql as $$
begin
  perform pg_temp.seeker();
  return (public.ask_question(pg_temp.gid(), 'radar', '1km', '{"center":[153.025,-27.47]}', pg_temp.n(), pg_temp.seq())
    ->> 'question_id')::uuid;
end;
$$;
create function pg_temp.to_hand(p_card text) returns uuid language sql security definer as $$
  update public.card_instances set location = 'hand'
   where id = (select id from public.card_instances
                where game_id = pg_temp.gid() and card_id = p_card and location in ('pile', 'drawn') order by pile_pos limit 1)
  returning id;
$$;
create function pg_temp.loc(p uuid) returns text language sql security definer as $$
  select location from public.card_instances where id = p;
$$;
grant execute on all functions in schema pg_temp to authenticated;

-- ---------------------------------------------------------------- setup

select pg_temp.host();
set local role authenticated;
select set_config('test.game_id',
  public.create_game('Host', pg_temp.n(), 'brisbane', '{"hiding_period_s":1800,"hand_limit":6,
    "veto":{"base_lock_s":600,"step_s":300},
    "deck":{"veto":2,"randomize":1,"right_turn":1,"distant_cuisine":1,"bonus_red":10}}'::jsonb) ->> 'game_id', true);
select set_config('test.code', (select code from public.games where id = pg_temp.gid()), true);
select pg_temp.hider();
select public.join_game(current_setting('test.code'), 'Amy', pg_temp.n());
select public.set_team(pg_temp.gid(), 'hiders', pg_temp.n());
select pg_temp.seeker();
select public.join_game(current_setting('test.code'), 'Sam', pg_temp.n());
select public.set_team(pg_temp.gid(), 'seekers', pg_temp.n());
select pg_temp.host();
select public.set_team(pg_temp.gid(), 'seekers', pg_temp.n());
select public.set_play_area(pg_temp.gid(), current_setting('test.area_id')::uuid, pg_temp.n(), pg_temp.seq());
select public.start_game(pg_temp.gid(), pg_temp.n(), pg_temp.seq());
select pg_temp.hider();
select set_config('test.bars', array_to_string(public.hiding_bars(pg_temp.gid()), ','), true);
select public.choose_bar(pg_temp.gid(), split_part(current_setting('test.bars'), ',', 1), pg_temp.n(), pg_temp.seq());
reset role;
update public.games set round_started_at = now() - interval '31 minutes' where id = pg_temp.gid();
set local role authenticated;

-- ---------------------------------------------------------------- who may override

select pg_temp.seeker();
select throws_ok($$ select pg_temp.ov('add_penalty', '{"team":"hiders","cost":"shot"}') $$,
  'P0001', 'host_only', 'a seeker who is not the host cannot override');
select pg_temp.hider();
select throws_ok($$ select pg_temp.ov('add_penalty', '{"team":"hiders","cost":"shot"}') $$,
  'P0001', 'host_only', 'a hider who is not the host cannot make public overrides');
select pg_temp.host();
select throws_ok($$ select pg_temp.ov('add_penalty', '{"team":"hiders","cost":"shot"}', '  ') $$,
  'P0001', 'invalid_reason', 'a reason is required');
select throws_ok($$ select pg_temp.ov('nope') $$, 'P0001', 'unknown_override', 'unknown kinds are refused');
select throws_ok($$ select public.host_override(pg_temp.gid(), 'add_penalty', '{"team":"hiders","cost":"shot"}',
  'r', pg_temp.n(), 0) $$, 'P0001', 'stale_state', 'overrides need a fresh view');

-- ---------------------------------------------------------------- penalties and drinks

select set_config('test.q1', pg_temp.ask()::text, true);
reset role;
update public.questions set deadline_at = now() - interval '1 second' where id = current_setting('test.q1')::uuid;
set local role authenticated;
select pg_temp.host();
select public.settle_timers(pg_temp.gid(), pg_temp.n());
reset role;
select set_config('test.proof1', (select id::text from public.drink_proofs where question_id = current_setting('test.q1')::uuid), true);
select isnt(current_setting('test.proof1'), '', 'the missed-deadline shot proof is linked to its question');
set local role authenticated;
select pg_temp.host();
select set_config('test.ov1', (pg_temp.ov('cancel_penalty', jsonb_build_object('question_id', current_setting('test.q1')), 'GPS bug')) ->> 'override_id', true);
reset role;
select ok((pg_temp.q(current_setting('test.q1')::uuid)).penalty_cancelled, 'cancel_penalty: the penalty is cancelled');
select is((select resolution from public.drink_proofs where id = current_setting('test.proof1')::uuid), 'cancelled',
  'and its shot proof is closed as cancelled');
select is((select payload ->> 'override_id' from pg_temp.last_event('penalty_cancelled')), current_setting('test.ov1'),
  'domain events carry the override id');
select is((select array[visibility::text, payload ->> 'kind', payload ->> 'reason', payload ->> 'by', (payload ->> 'private')]
             from pg_temp.last_event('override')),
  array['all', 'cancel_penalty', 'GPS bug', '11111111-1111-1111-1111-111111111111', 'false'],
  'an override event records who, what and why, for everyone');
select ok((select payload ->> 'summary' from pg_temp.last_event('override')) like 'Cancelled the missed-deadline shot%',
  'with a one-line summary');
set local role authenticated;
select pg_temp.host();
select throws_ok(format($$ select pg_temp.ov('cancel_penalty', '{"question_id":"%s"}') $$, current_setting('test.q1')),
  'P0001', 'no_penalty', 'a penalty cannot be cancelled twice');

-- undo needs both teams: any player asks (their team's yes), the other team agrees
select pg_temp.seeker();
select set_config('test.ureq', (pg_temp.ov('undo', format('{"override_id":"%s"}', current_setting('test.ov1'))::jsonb, 'wrong question'))
  ->> 'request_id', true);
reset role;
select ok((pg_temp.q(current_setting('test.q1')::uuid)).penalty_cancelled, 'asking to undo changes nothing yet');
select is((select array[payload ->> 'kind', payload ->> 'team', payload #>> '{params,override_id}'] from pg_temp.last_event('override_requested')),
  array['undo', 'seekers', current_setting('test.ov1')], 'a seeker who is not host can ask for an undo');
set local role authenticated;
select pg_temp.host();
select throws_ok(format($$ select pg_temp.vote(%L) $$, current_setting('test.ureq')), 'P0001', 'already_confirmed',
  'the asker''s own team has already agreed');
select throws_ok(format($$ select pg_temp.ov('undo', '{"override_id":"%s"}') $$, current_setting('test.ov1')),
  'P0001', 'undo_already_requested', 'one undo request per fix at a time');
select pg_temp.hider();
select lives_ok(format($$ select pg_temp.vote(%L) $$, current_setting('test.ureq')), 'a hider agrees');
reset role;
select is((select payload ->> 'team' from pg_temp.last_event('override_confirmed')), 'hiders', 'override_confirmed names the team');
select is((select array[payload ->> 'kind', payload #>> '{confirmed_by,hiders}', payload #>> '{confirmed_by,seekers}'] from pg_temp.last_event('override')),
  array['undo', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333'],
  'the undo records who agreed for each team');
select ok(not (pg_temp.q(current_setting('test.q1')::uuid)).penalty_cancelled, 'undo: the penalty is back');
select is((select proved_at from public.drink_proofs where id = current_setting('test.proof1')::uuid), null,
  'undo: the shot proof is open again');
select is((select payload ->> 'target_id' from pg_temp.last_event('override_undone')), current_setting('test.ov1'),
  'override_undone names the undone override');
select isnt((select undone_by from public.game_overrides where id = current_setting('test.ov1')::uuid), null,
  'the override is marked undone');
set local role authenticated;
select pg_temp.host();
select throws_ok(format($$ select pg_temp.ov('undo', '{"override_id":"%s"}') $$, current_setting('test.ov1')),
  'P0001', 'already_undone', 'an override is undone once');

-- add a penalty, waive its photo, cancel a drink
select lives_ok($$ select pg_temp.ov('add_penalty', '{"team":"seekers","cost":"drink","label":"Ran"}') $$, 'add_penalty');
reset role;
select is((select array[payload ->> 'team', payload ->> 'cost', payload ->> 'label'] from pg_temp.last_event('penalty_added')),
  array['seekers', 'drink', 'Ran'], 'add_penalty logs the penalty');
select set_config('test.proof2', (select payload ->> 'proof_id' from pg_temp.last_event('drink_due')), true);
select is((select label from public.drink_proofs where id = current_setting('test.proof2')::uuid), 'Ran', 'and opens a drink proof');
set local role authenticated;
select pg_temp.host();
select lives_ok(format($$ select pg_temp.ov('waive_proof', '{"proof_id":"%s"}') $$, current_setting('test.proof2')), 'waive_proof');
reset role;
select is((select array[resolution, photo_path] from public.drink_proofs where id = current_setting('test.proof2')::uuid),
  array['waived', null], 'waive_proof: done without a photo');
set local role authenticated;
select pg_temp.host();
select throws_ok(format($$ select pg_temp.ov('cancel_drink', '{"proof_id":"%s"}') $$, current_setting('test.proof2')),
  'P0001', 'proof_not_pending', 'a closed proof cannot be cancelled');
select lives_ok(format($$ select pg_temp.ov('cancel_drink', '{"proof_id":"%s"}') $$, current_setting('test.proof1')), 'cancel_drink');
reset role;
select is((select resolution from public.drink_proofs where id = current_setting('test.proof1')::uuid), 'cancelled',
  'cancel_drink: the drink is not owed');
select pg_temp.hider();
set local role authenticated;
select throws_ok(format($$ select public.submit_drink_proof(pg_temp.gid(), %L, 'x', pg_temp.n(), pg_temp.seq()) $$,
  current_setting('test.proof1')), 'P0001', 'proof_not_pending', 'a cancelled proof takes no photo');

-- ---------------------------------------------------------------- timers

select pg_temp.host();
select lives_ok(format($$ select pg_temp.ov('timer', '{"timer":"answer","id":"%s","op":"add","seconds":600}') $$,
  current_setting('test.q1')), 'timer add on an answer deadline');
reset role;
select ok((pg_temp.q(current_setting('test.q1')::uuid)).deadline_at > now() + interval '9 minutes', 'the deadline moved');
set local role authenticated;
select pg_temp.host();
select lives_ok(format($$ select pg_temp.ov('timer', '{"timer":"answer","id":"%s","op":"pause"}') $$,
  current_setting('test.q1')), 'timer pause');
reset role;
select ok(not isfinite((pg_temp.q(current_setting('test.q1')::uuid)).deadline_at), 'a paused deadline never passes');
select ok((select payload ->> 'ends_at' is null and (payload ->> 'paused_left_s')::numeric between 500 and 600
             from pg_temp.last_event('timer_changed')), 'timer_changed says paused and the time left');
set local role authenticated;
select pg_temp.host();
select throws_ok(format($$ select pg_temp.ov('timer', '{"timer":"answer","id":"%s","op":"pause"}') $$,
  current_setting('test.q1')), 'P0001', 'timer_paused', 'pausing twice is refused');
select lives_ok(format($$ select pg_temp.ov('timer', '{"timer":"answer","id":"%s","op":"resume"}') $$,
  current_setting('test.q1')), 'timer resume');
reset role;
select ok((pg_temp.q(current_setting('test.q1')::uuid)).deadline_at between now() + interval '8 minutes' and now() + interval '11 minutes',
  'resume: the time left carries on');
set local role authenticated;
select pg_temp.host();
select lives_ok(format($$ select pg_temp.ov('timer', '{"timer":"answer","id":"%s","op":"end"}') $$,
  current_setting('test.q1')), 'timer end');
reset role;
select ok((pg_temp.q(current_setting('test.q1')::uuid)).deadline_at <= now(), 'end: the deadline is now');

-- hiding period: more time puts the round back in hiding, end starts seeking
set local role authenticated;
select pg_temp.host();
select lives_ok($$ select pg_temp.ov('timer', '{"timer":"hiding","op":"add","seconds":600}') $$, 'more hiding time');
reset role;
select is((select status::text from public.games where id = pg_temp.gid()), 'hiding', 'the round is back in hiding');
select is((select payload ->> 'status' from pg_temp.last_event('timer_changed')), 'hiding', 'timer_changed says so');
set local role authenticated;
select pg_temp.seeker();
select throws_ok($$ select public.ask_question(pg_temp.gid(), 'radar', '1km', '{"center":[153.025,-27.47]}', pg_temp.n(), pg_temp.seq()) $$,
  'P0001', 'still_hiding', 'seekers wait for the new end');
select pg_temp.host();
select lives_ok($$ select pg_temp.ov('timer', '{"timer":"hiding","op":"end"}') $$, 'end the hiding period now');
reset role;
select is((select status::text from public.games where id = pg_temp.gid()), 'seeking', 'seeking starts');
select is((select payload ->> 'override_id' from pg_temp.last_event('seeking_started')), null,
  'seeking_started is settled after the override (not undone with it)');

-- ---------------------------------------------------------------- questions

set local role authenticated;
select pg_temp.host();
select lives_ok(format($$ select pg_temp.ov('set_answer', '{"question_id":"%s","answer":"Yes, roughly"}') $$,
  current_setting('test.q1')), 'set_answer accepts a typed answer');
reset role;
select is((pg_temp.q(current_setting('test.q1')::uuid)).answer, 'Yes, roughly', 'the answer is stored as typed');
select is((select payload ->> 'by_override' from pg_temp.last_event('question_answered')), 'true', 'question_answered says by override');
select is((select visibility::text from pg_temp.last_event('cards_drawn')), 'hiders', 'the reward is drawn for the hider');
set local role authenticated;
select pg_temp.host();
select lives_ok(format($$ select pg_temp.ov('set_answer', '{"question_id":"%s","answer":"no"}') $$,
  current_setting('test.q1')), 'set_answer edits an answer');
reset role;
select is((select count(*)::int from public.card_draws where question_id = current_setting('test.q1')::uuid), 1,
  'editing an answer draws nothing more');
set local role authenticated;
select pg_temp.host();
select lives_ok(format($$ select pg_temp.ov('void_answer', '{"question_id":"%s"}') $$, current_setting('test.q1')), 'void_answer');
reset role;
select is(array[(pg_temp.q(current_setting('test.q1')::uuid)).closed_by, (pg_temp.q(current_setting('test.q1')::uuid)).answer],
  array['void', null], 'void: no answer');
set local role authenticated;
select pg_temp.host();
select lives_ok(format($$ select pg_temp.ov('reopen_question', '{"question_id":"%s","deadline_s":120}') $$,
  current_setting('test.q1')), 'reopen_question');
reset role;
select ok((pg_temp.q(current_setting('test.q1')::uuid)).answered_at is null
          and (pg_temp.q(current_setting('test.q1')::uuid)).deadline_at > now() + interval '100 seconds', 'reopened with a new deadline');
set local role authenticated;
select pg_temp.hider();
select lives_ok(format($$ select public.answer_question(pg_temp.gid(), %L, 'yes', pg_temp.n(), pg_temp.seq()) $$,
  current_setting('test.q1')), 'the hider can answer it again');

-- bans and blocks: lift a ban, or ask past it
reset role;
insert into public.question_bans (game_id, round, type, option_id, instance_id)
select pg_temp.gid(), 1, 'radar', '1km', (select id from public.card_instances where game_id = pg_temp.gid() limit 1);
set local role authenticated;
select pg_temp.seeker();
select throws_ok($$ select public.ask_question(pg_temp.gid(), 'radar', '1km', '{"center":[153.025,-27.47]}', pg_temp.n(), pg_temp.seq()) $$,
  'P0001', 'question_banned', 'a banned question is refused');
select pg_temp.host();
select lives_ok($$ select pg_temp.ov('ask_question', '{"type":"radar","option_id":"1km","params":{"center":[153.025,-27.47]}}') $$,
  'ask_question skips the ban');
reset role;
select is((select payload ->> 'by_override' from pg_temp.last_event('question_asked')), 'true', 'question_asked by override');
select set_config('test.q2', (select payload ->> 'question_id' from pg_temp.last_event('question_asked')), true);
set local role authenticated;
select pg_temp.host();
select lives_ok(format($$ select pg_temp.ov('void_answer', '{"question_id":"%s"}') $$, current_setting('test.q2')),
  'void_answer closes a pending question too');
select lives_ok($$ select pg_temp.ov('lift_ban', '{"type":"radar","option_id":"1km"}') $$, 'lift_ban');
select pg_temp.seeker();
select lives_ok($$ select pg_temp.ask() $$, 'the seekers can ask it again');
select pg_temp.host();
select throws_ok($$ select pg_temp.ov('lift_ban', '{"type":"radar","option_id":"1km"}') $$, 'P0001', 'ban_not_found', 'no ban to lift');
reset role;
select set_config('test.q3', (select id::text from public.questions where game_id = pg_temp.gid() and answered_at is null), true);
set local role authenticated;
select pg_temp.hider();
select public.answer_question(pg_temp.gid(), current_setting('test.q3')::uuid, 'no', pg_temp.n(), pg_temp.seq());

-- ---------------------------------------------------------------- effects and vetoes

reset role;
select set_config('test.curse', pg_temp.to_hand('distant_cuisine')::text, true);
select set_config('test.timed', pg_temp.to_hand('right_turn')::text, true);
set local role authenticated;
select pg_temp.hider();
select set_config('test.effect', public.play_card(pg_temp.gid(), current_setting('test.curse')::uuid, pg_temp.n(), pg_temp.seq()) ->> 'effect_id', true);
select set_config('test.teffect', public.play_card(pg_temp.gid(), current_setting('test.timed')::uuid, pg_temp.n(), pg_temp.seq()) ->> 'effect_id', true);
select pg_temp.seeker();
select throws_ok($$ select pg_temp.ask() $$, 'P0001', 'questions_blocked', 'the curse blocks questions');
select pg_temp.host();
select lives_ok(format($$ select pg_temp.ov('set_blocking', '{"effect_id":"%s","blocks":false}') $$, current_setting('test.effect')),
  'set_blocking');
select pg_temp.seeker();
select lives_ok($$ select pg_temp.ask() $$, 'questions_blocked overridden');
reset role;
select set_config('test.q4', (select id::text from public.questions where game_id = pg_temp.gid() and answered_at is null), true);
set local role authenticated;
select pg_temp.host();
select lives_ok(format($$ select pg_temp.ov('void_answer', '{"question_id":"%s"}') $$, current_setting('test.q4')), 'tidy up');
select pg_temp.seeker();
select throws_ok(format($$ select public.clear_effect(pg_temp.gid(), %L, pg_temp.n(), pg_temp.seq()) $$, current_setting('test.effect')),
  'P0001', 'proof_needed', 'clearing waits for the photo');
select pg_temp.host();
select lives_ok(format($$ select pg_temp.ov('clear_effect', '{"effect_id":"%s"}') $$, current_setting('test.effect')), 'clear_effect');
reset role;
select is((select status from public.card_effects where id = current_setting('test.effect')::uuid), 'cleared', 'force-cleared');
select is((select resolution from public.drink_proofs where effect_id = current_setting('test.effect')::uuid), 'waived',
  'and its evidence proof is waived');
set local role authenticated;
select pg_temp.host();
select lives_ok(format($$ select pg_temp.ov('reinstate_effect', '{"effect_id":"%s"}') $$, current_setting('test.effect')), 'reinstate_effect');
reset role;
select is((select status from public.card_effects where id = current_setting('test.effect')::uuid), 'active', 'back in force');
set local role authenticated;
select pg_temp.host();
select lives_ok(format($$ select pg_temp.ov('timer', '{"timer":"effect","id":"%s","op":"add","seconds":-300}') $$,
  current_setting('test.teffect')), 'curse timer shortened');
reset role;
select ok((select ends_at < now() + interval '16 minutes' from public.card_effects where id = current_setting('test.teffect')::uuid),
  'the curse ends 5 min sooner');

set local role authenticated;
select pg_temp.seeker();
select public.veto_curse(pg_temp.gid(), current_setting('test.timed')::uuid, pg_temp.n(), pg_temp.seq());
select pg_temp.host();
select lives_ok(format($$ select pg_temp.ov('timer', '{"timer":"veto_lock","id":"%s","op":"pause"}') $$,
  current_setting('test.timed')), 'veto lock paused');
select lives_ok(format($$ select pg_temp.ov('cancel_veto', '{"instance_id":"%s"}') $$, current_setting('test.timed')), 'cancel_veto');
reset role;
select is((select count(*)::int from public.curse_vetoes where instance_id = current_setting('test.timed')::uuid), 0, 'the veto is gone');
select is((select status from public.card_effects where id = current_setting('test.teffect')::uuid), 'active', 'the curse is back');
select is((select resolution from public.drink_proofs where label = 'Veto: Right Turn' or label like 'Veto:%'), 'cancelled',
  'the veto drink is cancelled');

-- ---------------------------------------------------------------- freeze

set local role authenticated;
select pg_temp.host();
select lives_ok($$ select pg_temp.ov('freeze', '{"frozen":true}') $$, 'force the freeze on');
reset role;
select ok((select frozen from public.hider_bars where game_id = pg_temp.gid()), 'the hider is frozen');
select is((select array[visibility::text, payload ->> 'frozen'] from pg_temp.last_event('freeze_changed')), array['hiders', 'true'],
  'freeze_changed goes to the hiders');
set local role authenticated;
select pg_temp.seeker();
select public.report_position(pg_temp.gid(), 153.2, -27.3);
reset role;
select ok((select frozen from public.hider_bars where game_id = pg_temp.gid()), 'a far seeker report keeps the forced freeze');
set local role authenticated;
select pg_temp.host();
select lives_ok($$ select pg_temp.ov('freeze', '{"frozen":null}') $$, 'freeze back to automatic');
reset role;
select ok(not (select frozen from public.hider_bars where game_id = pg_temp.gid()), 'automatic: nobody near, not frozen');

-- ---------------------------------------------------------------- hider-only: request, approve, decline, leak

set local role authenticated;
select pg_temp.host();
select set_config('test.req', (pg_temp.ov('give_card', '{"card_id":"randomize"}', 'Missed a draw')) ->> 'request_id', true);
reset role;
select is((select payload -> 'params' from pg_temp.last_event('override_requested')), '{}'::jsonb,
  'a seeker host''s request carries no hider-only details');
select is((select count(*)::int from public.game_overrides where game_id = pg_temp.gid() and kind = 'give_card'), 0,
  'nothing happens until a hider approves');
set local role authenticated;
select pg_temp.seeker();
select throws_ok(format($$ select pg_temp.ov('give_card', '{"card_id":"veto"}', 'x', %L) $$, current_setting('test.req')),
  'P0001', 'hiders_only', 'only a hider approves');
select pg_temp.hider();
select set_config('test.given', (pg_temp.ov('give_card', '{"card_id":"veto"}', null, current_setting('test.req')::uuid)) ->> 'override_id', true);
reset role;
select set_config('test.inst', (select payload ->> 'instance_id' from pg_temp.last_event('card_given')), true);
select is(pg_temp.loc(current_setting('test.inst')::uuid), 'hand', 'approved: the card is in the hand');
select is((select array[visibility::text, payload ->> 'private', payload ->> 'reason', payload ->> 'summary', payload ->> 'request_id']
             from pg_temp.last_event('override')),
  array['all', 'true', 'Missed a draw', 'Changed the hider''s hand', current_setting('test.req')],
  'the public override says only that it happened');
select is((select visibility::text from pg_temp.last_event('override_detail')), 'hiders', 'details are hider-only');
select is((select resolution from public.override_requests where id = current_setting('test.req')::uuid), 'approved', 'request approved');
select throws_ok(format($$ select pg_temp.ov('give_card', '{"card_id":"veto"}', null, %L) $$, current_setting('test.req')),
  'P0001', 'request_not_open', 'a request is used once');

-- set_bar by request, to a pin the app doesn't list
set local role authenticated;
select pg_temp.host();
select set_config('test.req2', (pg_temp.ov('set_bar', '{}', 'Wrong bar')) ->> 'request_id', true);
select pg_temp.hider();
select lives_ok(format($$ select pg_temp.ov('set_bar', '{"name":"Secret Spot","lng":153.0251,"lat":-27.4701}', null, %L) $$,
  current_setting('test.req2')), 'a hider sets the bar to an unlisted venue');
reset role;
select set_config('test.secret', (select venue_id from public.hider_bars where game_id = pg_temp.gid()), true);
select is((select venue_name from public.hider_bars where game_id = pg_temp.gid()), 'Secret Spot', 'the bar changed');
select is((select visibility::text from pg_temp.last_event('bar_chosen')), 'hiders', 'bar_chosen is hider-only');

-- decline
set local role authenticated;
select pg_temp.host();
select set_config('test.req3', (pg_temp.ov('reshuffle', '{}', 'Deck ran out')) ->> 'request_id', true);
select pg_temp.hider();
select lives_ok(format($$ select pg_temp.ov('decline', null, null, %L) $$, current_setting('test.req3')), 'a hider declines');
reset role;
select is((select resolution from public.override_requests where id = current_setting('test.req3')::uuid), 'declined', 'declined');

-- leak: nothing the seekers can read or receive names the hider-only details
reset role;
select is(
  (select count(*)::int from realtime.messages
    where topic in ('game:' || current_setting('test.game_id'), 'game:' || current_setting('test.game_id') || ':seekers')
      and (payload::text like '%' || current_setting('test.secret') || '%'
           or payload::text like '%' || current_setting('test.inst') || '%'
           or payload::text like '%Secret Spot%')),
  0, 'no hider-only override detail is broadcast to seekers or the shared topic');
set local role authenticated;
select pg_temp.host();
select is(
  (select count(*)::int from public.events
    where game_id = pg_temp.gid()
      and (payload::text like '%' || current_setting('test.secret') || '%'
           or payload::text like '%' || current_setting('test.inst') || '%' or payload::text like '%Secret Spot%')),
  0, 'the seeker host cannot read any event naming the new bar or the given card');
select throws_ok($$ select * from public.game_overrides $$, '42501', null, 'overrides are not client-readable');
select throws_ok($$ select * from public.override_changes $$, '42501', null, 'nor their captured rows');
select throws_ok($$ select * from public.override_requests $$, '42501', null, 'nor requests');

-- ---------------------------------------------------------------- hand and deck (hider calls directly)

select pg_temp.hider();
select lives_ok(format($$ select pg_temp.ov('remove_card', '{"instance_id":"%s"}', 'dup') $$, current_setting('test.inst')),
  'a hider removes a card directly');
select is(pg_temp.loc(current_setting('test.inst')::uuid), 'discarded', 'remove_card discards it');
select set_config('test.ureq2', (pg_temp.ov('undo', format('{"override_id":"%s"}', current_setting('test.given'))::jsonb, 'no'))
  ->> 'request_id', true);
select pg_temp.seeker();
select throws_ok(format($$ select pg_temp.vote(%L) $$, current_setting('test.ureq2')),
  'P0001', 'undo_conflict', 'undo refuses when the rows changed since');
select lives_ok(format($$ select pg_temp.vote(%L, 'decline') $$, current_setting('test.ureq2')), 'either team can turn an undo down');
reset role;
select is((select resolution from public.override_requests where id = current_setting('test.ureq2')::uuid), 'declined', 'turned down');
set local role authenticated;
select pg_temp.hider();
select throws_ok(format($$ select pg_temp.vote(%L) $$, current_setting('test.ureq2')), 'P0001', 'request_not_open', 'a closed request takes no votes');
select lives_ok($$ select pg_temp.ov('reshuffle', '{}', 'deck empty') $$, 'reshuffle');
reset role;
select is(pg_temp.loc(current_setting('test.inst')::uuid), 'pile', 'discards go back in the pile');
set local role authenticated;
select pg_temp.hider();
select lives_ok($$ select pg_temp.ov('draw_cards', '{"count":2,"pick":1}', 'missed reward') $$, 'draw_cards');
reset role;
select is((select (payload ->> 'pick')::int from pg_temp.last_event('cards_drawn')), 1, 'draw_cards deals a draw');
set local role authenticated;
select pg_temp.host();
select lives_ok($$ select pg_temp.ov('set_hand_limit', '{"limit":9}') $$, 'set_hand_limit');
reset role;
select is((select config ->> 'hand_limit' from public.games where id = pg_temp.gid()), '9', 'hand limit raised');

-- ---------------------------------------------------------------- move and players

update public.hider_bars set move_pending = true where game_id = pg_temp.gid();
set local role authenticated;
select pg_temp.host();
select lives_ok($$ select pg_temp.ov('cancel_move', '{}') $$, 'cancel_move');
reset role;
select ok(not (select move_pending from public.hider_bars where game_id = pg_temp.gid()), 'no longer moving');
set local role authenticated;
select pg_temp.host();
select is((pg_temp.ov('move_player', '{"user_id":"33333333-3333-3333-3333-333333333333","team":"hiders"}', 'swap')) ->> 'pending',
  'true', 'moving a player onto the hiders needs a hider to approve');
reset role;
select set_config('test.req4', (select payload ->> 'request_id' from pg_temp.last_event('override_requested')), true);
set local role authenticated;
select pg_temp.hider();
select lives_ok(format($$ select pg_temp.ov('move_player', null, null, %L) $$, current_setting('test.req4')), 'approved with its params');
reset role;
select is((select team::text from public.players where game_id = pg_temp.gid() and user_id = '33333333-3333-3333-3333-333333333333'),
  'hiders', 'the player is a hider now');
set local role authenticated;
select pg_temp.host();
select lives_ok($$ select pg_temp.ov('move_player', '{"user_id":"33333333-3333-3333-3333-333333333333","team":"seekers"}', 'back') $$,
  'moving onto the seekers is direct');
select lives_ok($$ select pg_temp.ov('set_host', '{"user_id":"22222222-2222-2222-2222-222222222222"}', 'host left') $$, 'set_host');
reset role;
select is((select host_id::text from public.games where id = pg_temp.gid()), '22222222-2222-2222-2222-222222222222', 'new host');
select is((select count(*)::int from public.players where game_id = pg_temp.gid() and is_host), 1, 'exactly one host');
set local role authenticated;
select pg_temp.host();
select throws_ok($$ select pg_temp.ov('add_penalty', '{"team":"hiders","cost":"shot"}') $$, 'P0001', 'host_only',
  'the old host can no longer override');

select * from finish();
rollback;
