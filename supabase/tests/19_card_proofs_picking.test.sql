-- Per-card photo proof, discarding a just-drawn card, and live bar picking
-- (20261208090000_card_proofs_picking.sql).
-- Players: H = host (seeker), A and B = hiders, S = seeker. Cards are put in the hand directly.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(29);

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
create function pg_temp.picks(p_topic_suffix text) returns int language sql as $$
  select count(*)::int from realtime.messages
   where topic = 'game:' || pg_temp.gid() || p_topic_suffix and event = 'picking';
$$;
grant execute on all functions in schema pg_temp to authenticated;

-- ---------------------------------------------------------------- setup

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
set local role authenticated;
select set_config('test.game_id',
  public.create_game('Host', pg_temp.uid(1), 'brisbane', '{"hiding_period_s":1800,"hand_limit":2,
    "deck":{"bridge":1,"cheers":1,"drinks_all_round":1,"bonus_red":10}}'::jsonb) ->> 'game_id', true);
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

-- ---------------------------------------------------------------- live bar picking

select pg_temp.hider();
select set_config('test.bars', array_to_string(public.hiding_bars(pg_temp.gid()), ','), true);
select set_config('test.seq_before_picks', pg_temp.seq()::text, true);
select pg_temp.hider2();
select lives_ok(format($$ select public.report_picking(pg_temp.gid(), %L) $$, split_part(current_setting('test.bars'), ',', 2)),
  'a hider reports the bar they are looking at');
select lives_ok($$ select public.report_picking(pg_temp.gid(), null) $$, 'or that they have none selected');
reset role;
select is(pg_temp.picks(':hiders'), 2, 'picks go to the hiders topic');
select is(pg_temp.picks(':seekers') + pg_temp.picks(''), 0, 'and never to the seekers or the shared topic');
select is(
  (select array[payload ->> 'user_id', payload ->> 'venue_id', (payload ->> 'name' is not null)::text]
     from realtime.messages where event = 'picking' and payload ->> 'venue_id' is not null),
  array['44444444-4444-4444-4444-444444444444', split_part(current_setting('test.bars'), ',', 2), 'true'],
  'a pick names the hider, the bar and its name');
select is(pg_temp.seq()::text, current_setting('test.seq_before_picks'), 'picks are not events');
set local role authenticated;
select pg_temp.seeker();
select throws_ok($$ select public.report_picking(pg_temp.gid(), null) $$, 'P0001', 'hiders_only', 'seekers cannot report picks');
select pg_temp.hider2();
select throws_ok($$ select public.report_picking(pg_temp.gid(), 'nope') $$, 'P0001', 'venue_not_found', 'only valid bars');

-- First to lock in wins; then there is nothing to pick.
select pg_temp.hider();
select public.choose_bar(pg_temp.gid(), split_part(current_setting('test.bars'), ',', 1), pg_temp.uid(11), pg_temp.seq());
select pg_temp.hider2();
select throws_ok(format($$ select public.choose_bar(pg_temp.gid(), %L, pg_temp.uid(12), pg_temp.seq()) $$,
    split_part(current_setting('test.bars'), ',', 2)),
  'P0001', 'bar_already_chosen', 'the second hider cannot lock in another bar');
select throws_ok($$ select public.report_picking(pg_temp.gid(), null) $$, 'P0001', 'bar_already_chosen',
  'no picks once the bar is locked in');

reset role;
update public.games set round_started_at = now() - interval '31 minutes' where id = pg_temp.gid();
select set_config('test.cheers', pg_temp.to_hand('cheers')::text, true);
select set_config('test.all', pg_temp.to_hand('drinks_all_round')::text, true);
set local role authenticated;

-- ---------------------------------------------------------------- drink cards: proof per card

select lives_ok(format($$ select pg_temp.play(%L, 20) $$, current_setting('test.cheers')), 'hider plays Cheers');
select lives_ok(format($$ select pg_temp.play(%L, 21) $$, current_setting('test.all')), 'and Drinks all round');
reset role;
select is(
  array(select label || ':' || team::text from public.drink_proofs where game_id = pg_temp.gid() order by label, team),
  array['Cheers:hiders', 'Cheers:seekers'], 'only the card with params.proof = photo asks for drink photos');

-- ---------------------------------------------------------------- curse evidence

select set_config('test.bridge', pg_temp.to_hand('bridge')::text, true);
set local role authenticated;
select set_config('test.effect', (pg_temp.play(current_setting('test.bridge')::uuid, 22) ->> 'effect_id'), true);
reset role;
select set_config('test.proof', (select id::text from public.drink_proofs where effect_id = current_setting('test.effect')::uuid), true);
select is((select array[kind, team::text, coalesce(cost, 'none')] from public.drink_proofs where id = current_setting('test.proof')::uuid),
  array['evidence', 'seekers', 'none'], 'a curse with photo proof opens an evidence proof for the seekers');
select is((select array[visibility::text, (actor_id is null)::text, payload ->> 'effect_id', payload ->> 'proof_id']
             from pg_temp.last_event('proof_due')),
  array['all', 'true', current_setting('test.effect'), current_setting('test.proof')], 'proof_due is public and names the effect');
set local role authenticated;

select pg_temp.seeker();
select throws_ok(format($$ select public.clear_effect(pg_temp.gid(), %L, pg_temp.uid(23), pg_temp.seq()) $$, current_setting('test.effect')),
  'P0001', 'proof_needed', 'seekers cannot say they did it without the photo');
select is(public.can_upload_drink_photo(pg_temp.gid() || '/' || current_setting('test.proof') || '/a.jpg'), true,
  'seekers can upload the evidence');
select pg_temp.hider();
select is(public.can_upload_drink_photo(pg_temp.gid() || '/' || current_setting('test.proof') || '/a.jpg'), false,
  'hiders cannot');
reset role;
insert into storage.objects (bucket_id, name) values ('drink-photos', pg_temp.gid() || '/' || current_setting('test.proof') || '/a.jpg');
set local role authenticated;
select pg_temp.seeker();
select lives_ok(format($$ select public.submit_drink_proof(pg_temp.gid(), %L, %L, pg_temp.uid(24), pg_temp.seq()) $$,
    current_setting('test.proof'), pg_temp.gid() || '/' || current_setting('test.proof') || '/a.jpg'), 'seekers send the photo');
select lives_ok(format($$ select public.clear_effect(pg_temp.gid(), %L, pg_temp.uid(25), pg_temp.seq()) $$, current_setting('test.effect')),
  'then say they did it');

select pg_temp.hider();
select lives_ok(format($$ select public.confirm_clear(pg_temp.gid(), %L, false, pg_temp.uid(26), pg_temp.seq()) $$, current_setting('test.effect')),
  'the hider says not yet');
reset role;
select is((select proved_at is null and photo_path is null from public.drink_proofs where id = current_setting('test.proof')::uuid), true,
  'which reopens the proof');
set local role authenticated;
select pg_temp.seeker();
select throws_ok(format($$ select public.clear_effect(pg_temp.gid(), %L, pg_temp.uid(27), pg_temp.seq()) $$, current_setting('test.effect')),
  'P0001', 'proof_needed', 'the next try needs a new photo');
reset role;
insert into storage.objects (bucket_id, name) values ('drink-photos', pg_temp.gid() || '/' || current_setting('test.proof') || '/b.jpg');
set local role authenticated;
select pg_temp.seeker();
select public.submit_drink_proof(pg_temp.gid(), current_setting('test.proof')::uuid,
  pg_temp.gid() || '/' || current_setting('test.proof') || '/b.jpg', pg_temp.uid(28), pg_temp.seq());
select public.clear_effect(pg_temp.gid(), current_setting('test.effect')::uuid, pg_temp.uid(29), pg_temp.seq());
select pg_temp.hider();
select lives_ok(format($$ select public.confirm_clear(pg_temp.gid(), %L, true, pg_temp.uid(30), pg_temp.seq()) $$, current_setting('test.effect')),
  'the hider accepts the second photo');

-- ---------------------------------------------------------------- discard the card just drawn

reset role;
select set_config('test.h1', pg_temp.to_hand('bonus_red')::text, true);
select set_config('test.h2', pg_temp.to_hand('bonus_red')::text, true);
set local role authenticated;
select pg_temp.seeker();
select set_config('test.q', public.ask_question(pg_temp.gid(), 'radar', 'custom', '{"center":[153.025,-27.47],"distance_m":1500}',
  pg_temp.uid(40), pg_temp.seq()) ->> 'question_id', true);
select pg_temp.hider();
select set_config('test.draw', public.answer_question(pg_temp.gid(), current_setting('test.q')::uuid, 'yes', pg_temp.uid(41), pg_temp.seq()) ->> 'draw_id', true);
reset role;
select set_config('test.d1', (select id::text from public.card_instances where draw_id = current_setting('test.draw')::uuid order by pile_pos limit 1), true);
set local role authenticated;
select pg_temp.hider();
select throws_ok(format($$ select public.keep_cards(pg_temp.gid(), %L, %L, '{}', pg_temp.uid(42), pg_temp.seq()) $$,
    current_setting('test.draw'), '{' || current_setting('test.d1') || '}'),
  'P0001', 'hand_full', 'a full hand cannot take the new card as it is');
select lives_ok(format($$ select public.keep_cards(pg_temp.gid(), %L, %L, %L, pg_temp.uid(43), pg_temp.seq()) $$,
    current_setting('test.draw'), '{' || current_setting('test.d1') || '}', '{' || current_setting('test.d1') || '}'),
  'the hider discards the card just drawn instead');
reset role;
select is(
  array(select id::text from public.card_instances where game_id = pg_temp.gid() and location = 'hand' order by id),
  array(select unnest(array[current_setting('test.h1'), current_setting('test.h2')]) order by 1),
  'the hand is unchanged');
select is((select location from public.card_instances where id = current_setting('test.d1')::uuid), 'discarded',
  'the drawn card went to the discard pile');
select is((select array[jsonb_array_length(payload -> 'kept')::text, ((payload -> 'discarded') ? current_setting('test.d1'))::text]
             from pg_temp.last_event('cards_kept')),
  array['0', 'true'], 'cards_kept lists nothing kept and the drawn card discarded');

select * from finish();
rollback;
