-- The group's custom cards (20261227090000_custom_curses.sql): hider counts (Brothel, Beer
-- Bonus), optional first steps (Equivalent Exchange), Minefield, Happy Hour, Plagued World,
-- Prosperous Home, Time Bank, Rewind.
-- Players: H = host (seeker), A = hider, S = seeker.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(69);

insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333');

-- The cards as the migration leaves them (they were made in the app, so tests add them).
insert into public.cards (id, name, category_id, behaviour, body, params, cast_cost, can_veto, default_copies) values
  ('t_brothel', 'Curse of Brothel', 'curse', 'until_cleared', 'Shots per 2 people in the call.',
   '{"proof": "photo", "hider_proof": "photo", "blocks_questions": true,
     "hider_count": {"prompt": "People in the call?", "per": 2, "unit": "shot"}}', 'free', false, 1),
  ('t_exchange', 'Curse of Equivalent Exchange', 'curse', 'until_cleared', 'Drink as much as you can.',
   '{"proof": "video", "blocks_questions": true, "hider_proof": "photo", "hider_proof_optional": true,
     "hider_count": {"prompt": "Standard drinks?", "per": 1, "unit": "standard drink", "time_s": 300}}', 'free', true, 1),
  ('t_mine', 'Curse of Minefield', 'curse', 'until_cleared', 'A mine.',
   '{"mine": true, "proof": "photo"}', 'free', true, 1),
  ('t_happy', 'Curse of Happy Hour', 'curse', 'timed', 'A drink per question.',
   '{"duration_s": 1200, "drink_per_question": "drink"}', 'free', true, 1),
  ('t_plague', 'Curse of Plagued World', 'curse', 'timed', 'No questions near the last.',
   '{"duration_s": 1800, "plague_radius_m": 250}', 'free', true, 1),
  ('t_home', 'Curse of Prosperous Home', 'curse', 'text', 'Bigger zone.',
   '{"zone_radius_multiplier": 1.5}', 'free', false, 1),
  ('t_bank', 'Curse of Time Bank', 'curse', 'text', 'Discard time bonuses.',
   '{"bank_time_bonuses": {"minutes_per": 4, "unit": "drink"}}', 'free', true, 1),
  ('t_rewind', 'Curse of Rewind', 'curse', 'until_cleared', 'Same place.',
   '{"blocks_questions": true, "self_clear": true}', 'free', true, 1),
  ('t_beer', 'Beer Bonus', 'drink', 'text', 'Drink for cards.',
   '{"hider_count": {"prompt": "Drinks?", "per": 1, "unit": "card", "time_s": 300, "reward": "extra_draw"}}', null, null, 1);

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
-- Ask a question from a point (lng, lat).
create function pg_temp.ask(p_type text, p_option text, p_lng float8, p_lat float8, n int) returns jsonb language plpgsql as $$
begin
  perform pg_temp.seeker();
  return public.ask_question(pg_temp.gid(), p_type, p_option,
    jsonb_build_object('center', jsonb_build_array(p_lng, p_lat), 'here', jsonb_build_array(p_lng, p_lat)),
    pg_temp.uid(n), pg_temp.seq());
end;
$$;
create function pg_temp.pending() returns uuid language sql security definer as $$
  select id from public.questions where game_id = pg_temp.gid() and answered_at is null;
$$;
create function pg_temp.answer(n int, p_answer text default 'yes') returns jsonb language plpgsql as $$
begin
  perform pg_temp.hider();
  return public.answer_question(pg_temp.gid(),
    pg_temp.pending(), p_answer, pg_temp.uid(n), pg_temp.seq());
end;
$$;
create function pg_temp.to_hand(p_card text) returns uuid language sql as $$
  update public.card_instances set location = 'hand'
   where id = (select id from public.card_instances
                where game_id = pg_temp.gid() and card_id = p_card and location <> 'played' and location <> 'hand'
                order by pile_pos limit 1)
  returning id;
$$;
create function pg_temp.play(p uuid, p_choice jsonb, n int) returns jsonb language plpgsql as $$
begin
  perform pg_temp.hider();
  return public.play_card(pg_temp.gid(), p, pg_temp.uid(n), pg_temp.seq(), p_choice);
end;
$$;
create function pg_temp.count(p uuid, p_count int, n int) returns jsonb language plpgsql as $$
begin
  perform pg_temp.hider();
  return public.set_card_count(pg_temp.gid(), p, p_count, pg_temp.uid(n), pg_temp.seq());
end;
$$;
create function pg_temp.clear(p uuid, n int) returns jsonb language plpgsql as $$
begin
  perform pg_temp.seeker();
  return public.clear_effect(pg_temp.gid(), p, pg_temp.uid(n), pg_temp.seq());
end;
$$;
create function pg_temp.effect(p uuid) returns uuid language sql security definer as $$
  select id from public.card_effects where instance_id = p;
$$;
create function pg_temp.last_event(p_type text) returns public.events language sql as $$
  select * from public.events where game_id = pg_temp.gid() and type = p_type order by seq desc limit 1;
$$;
grant execute on all functions in schema pg_temp to authenticated;

-- ---------------------------------------------------------------- setup

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
set local role authenticated;
select set_config('test.game_id',
  public.create_game('Host', pg_temp.uid(1), 'brisbane', '{"hiding_period_s":1800,"hand_limit":20,
    "deck":{"t_brothel":1,"t_exchange":1,"t_mine":1,"t_happy":1,"t_plague":1,"t_home":1,"t_bank":1,"t_rewind":1,
            "t_beer":1,"bonus_red":3,"bonus_orange":2,"veto":10}}'::jsonb) ->> 'game_id', true);
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
select public.choose_bar(pg_temp.gid(), split_part(array_to_string(public.hiding_bars(pg_temp.gid()), ','), ',', 1),
  pg_temp.uid(9), pg_temp.seq());

reset role;
-- Seeking (the hiding period is over) and every card in the hand.
update public.games set round_started_at = now() - interval '31 minutes' where id = pg_temp.gid();
select set_config('test.brothel', pg_temp.to_hand('t_brothel')::text, true);
select set_config('test.exchange', pg_temp.to_hand('t_exchange')::text, true);
select set_config('test.mine', pg_temp.to_hand('t_mine')::text, true);
select set_config('test.happy', pg_temp.to_hand('t_happy')::text, true);
select set_config('test.plague', pg_temp.to_hand('t_plague')::text, true);
select set_config('test.home', pg_temp.to_hand('t_home')::text, true);
select set_config('test.bank', pg_temp.to_hand('t_bank')::text, true);
select set_config('test.rewind', pg_temp.to_hand('t_rewind')::text, true);
select set_config('test.beer', pg_temp.to_hand('t_beer')::text, true);
select set_config('test.red1', pg_temp.to_hand('bonus_red')::text, true);
select set_config('test.red2', pg_temp.to_hand('bonus_red')::text, true);
select set_config('test.orange', pg_temp.to_hand('bonus_orange')::text, true);
select set_config('test.veto', pg_temp.to_hand('veto')::text, true);
select set_config('test.lng', (select extensions.st_x(geom)::text from public.hider_bars where game_id = pg_temp.gid()), true);
select set_config('test.lat', (select extensions.st_y(geom)::text from public.hider_bars where game_id = pg_temp.gid()), true);
create function pg_temp.prove(p_effect uuid) returns void language sql as $$
  update public.drink_proofs set proved_at = now(), photo_path = 'x' where effect_id = p_effect and not optional;
$$;
create function pg_temp.confirm(p uuid, n int) returns jsonb language plpgsql as $$
begin
  perform pg_temp.hider();
  return public.confirm_clear(pg_temp.gid(), p, true, pg_temp.uid(n), pg_temp.seq());
end;
$$;
grant execute on all functions in schema pg_temp to authenticated;
set local role authenticated;

-- ---------------------------------------------------------------- Brothel: hider count

select lives_ok(format($$ select pg_temp.play(%L, null, 10) $$, current_setting('test.brothel')), 'hider casts Brothel');
reset role;
select is((select count(*)::int from public.drink_proofs where effect_id = pg_temp.effect(current_setting('test.brothel')::uuid)
            and kind = 'setup' and not optional), 1, 'Brothel opens the hiders'' screenshot proof');
select pg_temp.prove(pg_temp.effect(current_setting('test.brothel')::uuid));
set local role authenticated;
select throws_ok(format($$ select pg_temp.clear(%L, 11) $$, pg_temp.effect(current_setting('test.brothel')::uuid)),
  'P0001', 'count_needed', 'seekers cannot clear it before the hiders send the count');
select throws_ok(format($$ select pg_temp.count(%L, -1, 12) $$, current_setting('test.brothel')),
  'P0001', 'invalid_count', 'no negative counts');
select throws_ok(format($$ select pg_temp.count(%L, 3, 13) $$, current_setting('test.veto')),
  'P0001', 'card_not_found', 'only played cards take a count');
select pg_temp.seeker();
select throws_ok(format($$ select public.set_card_count(pg_temp.gid(), %L, 3, pg_temp.uid(14), pg_temp.seq()) $$,
  current_setting('test.brothel')), 'P0001', null, 'seekers cannot send the count');
select is((pg_temp.count(current_setting('test.brothel')::uuid, 5, 15)) ->> 'amount', '2', '5 people in the call = 2 shots');
reset role;
select is((select array[visibility::text, payload ->> 'amount', payload ->> 'count', payload ->> 'unit']
             from pg_temp.last_event('card_count_set')),
  array['all', '2', '5', 'shot'], 'card_count_set is public with the amount');
select is(public._push_for_event('card_count_set', 'all', (pg_temp.last_event('card_count_set')).payload) ->> 'body',
  'Drink 2 shots.', 'and pushes the seekers what to drink');
set local role authenticated;
select throws_ok(format($$ select pg_temp.count(%L, 6, 16) $$, current_setting('test.brothel')),
  'P0001', 'count_already_set', 'the count is sent once');
select lives_ok(format($$ select pg_temp.clear(%L, 17) $$, pg_temp.effect(current_setting('test.brothel')::uuid)),
  'with the count in, the seekers can say they did it');
select lives_ok(format($$ select pg_temp.confirm(%L, 18) $$, pg_temp.effect(current_setting('test.brothel')::uuid)),
  'hider confirms');

-- ---------------------------------------------------------------- Equivalent Exchange: optional photo

select lives_ok(format($$ select pg_temp.play(%L, null, 20) $$, current_setting('test.exchange')), 'hider casts Equivalent Exchange');
reset role;
select is((select optional from public.drink_proofs where effect_id = pg_temp.effect(current_setting('test.exchange')::uuid)
            and kind = 'setup'), true, 'its hiders'' photo is optional');
select is((select payload ->> 'optional' from public.events where game_id = pg_temp.gid() and type = 'proof_due'
            and payload ->> 'kind' = 'setup' and payload ->> 'effect_id' = pg_temp.effect(current_setting('test.exchange')::uuid)::text),
  'true', 'and proof_due says so');
select pg_temp.prove(pg_temp.effect(current_setting('test.exchange')::uuid));
set local role authenticated;
select is((pg_temp.count(current_setting('test.exchange')::uuid, 3, 21)) ->> 'amount', '3', '3 standard drinks');
select lives_ok(format($$ select pg_temp.clear(%L, 22) $$, pg_temp.effect(current_setting('test.exchange')::uuid)),
  'seekers clear it without the optional photo');
select lives_ok(format($$ select pg_temp.confirm(%L, 23) $$, pg_temp.effect(current_setting('test.exchange')::uuid)),
  'hider confirms');

-- ---------------------------------------------------------------- Beer Bonus: extra draw

select lives_ok(format($$ select pg_temp.play(%L, null, 30) $$, current_setting('test.beer')), 'hider plays Beer Bonus');
select is((pg_temp.count(current_setting('test.beer')::uuid, 2, 31)) ->> 'amount', '2', '2 drinks');
reset role;
select is(public._push_for_event('card_count_set', 'all', (pg_temp.last_event('card_count_set')).payload), null,
  'a reward count pushes nothing');
select is((select extra_draw from public.card_modifiers where instance_id = current_setting('test.beer')::uuid), 2,
  'two extra cards waiting');
set local role authenticated;
select lives_ok(format($$ select pg_temp.ask('radar', '500m', %s, %s, 32) $$,
  current_setting('test.lng'), current_setting('test.lat')), 'seekers ask');
select lives_ok($$ select pg_temp.answer(33) $$, 'hider answers');
reset role;
select is((select array[jsonb_array_length(payload -> 'cards'), (payload ->> 'extra')::int] from pg_temp.last_event('cards_drawn')),
  array[4, 2], 'radar draws 2, plus 2 for the drinks');
set local role authenticated;

-- ---------------------------------------------------------------- Minefield

select throws_ok(format($$ select pg_temp.play(%L, null, 40) $$, current_setting('test.mine')),
  'P0001', 'invalid_choice', 'Minefield needs a question to mine');
select throws_ok(format($$ select pg_temp.play(%L, '{"mine":{"type":"radar","option_id":"500m"}}', 41) $$, current_setting('test.mine')),
  'P0001', 'invalid_choice', 'not one already asked');
select lives_ok(format($$ select pg_temp.play(%L, '{"mine":{"type":"radar","option_id":"2km"}}', 42) $$, current_setting('test.mine')),
  'hider mines radar 2 km');
reset role;
select is((select visibility::text from pg_temp.last_event('mine_set')), 'hiders', 'mine_set is hider-only');
select ok((select payload::text not like '%2km%' from pg_temp.last_event('card_played')), 'card_played does not say which');
set local role authenticated;
select throws_ok(format($$ select pg_temp.clear(%L, 43) $$, pg_temp.effect(current_setting('test.mine')::uuid)),
  'P0001', 'mine_not_triggered', 'nothing to clear before it goes off');
select lives_ok(format($$ select pg_temp.ask('radar', '1km', %s, %s, 44) $$,
  current_setting('test.lng'), current_setting('test.lat')), 'another question is fine');
select lives_ok($$ select pg_temp.answer(45) $$, 'answered');
select is((pg_temp.ask('radar', '2km', current_setting('test.lng')::float8, current_setting('test.lat')::float8, 46)) ->> 'mined',
  'true', 'asking the mined one sets it off');
reset role;
select is((select array[closed_by, (answered_at is not null)::text] from public.questions
            where game_id = pg_temp.gid() and option_id = '2km'), array['veto', 'true'], 'the question is vetoed');
select is((select array[visibility::text, payload ->> 'label'] from pg_temp.last_event('mine_triggered')),
  array['all', '2km'], 'mine_triggered is public');
select is(public._push_for_event('mine_triggered', 'all', (pg_temp.last_event('mine_triggered')).payload) ->> 'audience',
  'seekers', 'and pushed to the seekers');
set local role authenticated;
select throws_ok(format($$ select pg_temp.ask('radar', '3km', %s, %s, 47) $$,
  current_setting('test.lng'), current_setting('test.lat')), 'P0001', 'questions_blocked', 'no questions until they drink');
reset role;
select pg_temp.prove(pg_temp.effect(current_setting('test.mine')::uuid));
set local role authenticated;
select lives_ok(format($$ select pg_temp.clear(%L, 48) $$, pg_temp.effect(current_setting('test.mine')::uuid)), 'seekers drank');
select lives_ok(format($$ select pg_temp.confirm(%L, 49) $$, pg_temp.effect(current_setting('test.mine')::uuid)), 'hider confirms');

-- ---------------------------------------------------------------- Happy Hour and Plagued World

select lives_ok(format($$ select pg_temp.play(%L, null, 50) $$, current_setting('test.happy')), 'hider casts Happy Hour');
select lives_ok(format($$ select pg_temp.play(%L, null, 51) $$, current_setting('test.plague')), 'and Plagued World');
select lives_ok(format($$ select pg_temp.ask('radar', '3km', %s, %s, 52) $$,
  current_setting('test.lng'), current_setting('test.lat')), 'seekers ask');
reset role;
select is((select array[payload ->> 'team', payload ->> 'instance_id'] from pg_temp.last_event('drink_due')),
  array['seekers', current_setting('test.happy')], 'Happy Hour: a drink for the question');
select is((select array[visibility::text, payload ->> 'radius_m'] from pg_temp.last_event('plague_spot')),
  array['all', '250'], 'Plagued World: a public spot');
set local role authenticated;
select lives_ok($$ select pg_temp.answer(53) $$, 'answered');
select throws_ok(format($$ select pg_temp.ask('matching', 'park', %s, %s + 0.001, 54) $$,
  current_setting('test.lng'), current_setting('test.lat')), 'P0001', 'plague_zone', 'not within 250 m of the last one');
select lives_ok(format($$ select pg_temp.ask('matching', 'park', %s, %s + 0.005, 55) $$,
  current_setting('test.lng'), current_setting('test.lat')), 'fine 550 m away');
select lives_ok($$ select pg_temp.answer(56, 'same') $$, 'answered');
reset role;
select is((select count(*)::int from public.drink_proofs where game_id = pg_temp.gid() and team = 'seekers' and label = 'Curse of Happy Hour'),
  2, 'one drink per question');
update public.card_effects set ends_at = now() - interval '1 second' where id in
  (pg_temp.effect(current_setting('test.happy')::uuid), pg_temp.effect(current_setting('test.plague')::uuid));
set local role authenticated;
select lives_ok(format($$ select pg_temp.ask('matching', 'museum', %s, %s + 0.001, 57) $$,
  current_setting('test.lng'), current_setting('test.lat')), 'once it ends, anywhere goes');
select lives_ok($$ select pg_temp.answer(58, 'same') $$, 'answered');
reset role;
select is((select count(*)::int from public.drink_proofs where game_id = pg_temp.gid() and team = 'seekers' and label = 'Curse of Happy Hour'),
  2, 'and no more Happy Hour drinks');

-- ---------------------------------------------------------------- Prosperous Home

-- A seeker 130 m north of the bar: outside 100 m, inside 150 m.
insert into public.seeker_positions (game_id, user_id, round, lng, lat)
values (pg_temp.gid(), '33333333-3333-3333-3333-333333333333', 1,
        current_setting('test.lng')::float8, current_setting('test.lat')::float8 + 130 / 111320.0)
on conflict (game_id, user_id) do update set lng = excluded.lng, lat = excluded.lat, reported_at = now();
select public._update_freeze((select g from public.games g where id = pg_temp.gid()));
select is((select frozen from public.hider_bars where game_id = pg_temp.gid()), false, 'not frozen at 130 m');
set local role authenticated;
select lives_ok(format($$ select pg_temp.play(%L, null, 60) $$, current_setting('test.home')), 'hider casts Prosperous Home');
reset role;
select is(public._zone_multiplier((select g from public.games g where id = pg_temp.gid())), 1.5::numeric, 'zone ×1.5');
select is((select frozen from public.hider_bars where game_id = pg_temp.gid()), true, 'now frozen at 130 m');
set local role authenticated;

-- ---------------------------------------------------------------- Time Bank

select throws_ok(format($$ select pg_temp.play(%L, %L, 70) $$, current_setting('test.bank'),
  jsonb_build_object('bonuses', jsonb_build_array(current_setting('test.veto')))), 'P0001', 'invalid_choice',
  'only time bonuses');
select lives_ok(format($$ select pg_temp.play(%L, %L, 71) $$, current_setting('test.bank'),
  jsonb_build_object('bonuses', jsonb_build_array(current_setting('test.red1'), current_setting('test.orange')))),
  'hider banks 6 minutes');
reset role;
select is((select array[location, (select location from public.card_instances where id = current_setting('test.orange')::uuid)]
             from public.card_instances where id = current_setting('test.red1')::uuid),
  array['discarded', 'discarded'], 'both discarded');
select is((select location from public.card_instances where id = current_setting('test.red2')::uuid), 'hand', 'the other stays');
select is((select array[visibility::text, payload ->> 'minutes'] from pg_temp.last_event('bonuses_banked')),
  array['hiders', '6'], 'what went is hider-only');
select is((select array[visibility::text, payload ->> 'amount', coalesce(payload ->> 'count', 'none')] from pg_temp.last_event('card_count_set')),
  array['all', '1', 'none'], '6 min = 1 drink, minutes not shown');
select is((select array[payload ->> 'team', payload ->> 'label'] from pg_temp.last_event('drink_due')),
  array['seekers', 'Curse of Time Bank: 1 drink'], 'and a seekers'' drink');
set local role authenticated;

-- ---------------------------------------------------------------- Rewind: self clear

select lives_ok(format($$ select pg_temp.play(%L, null, 80) $$, current_setting('test.rewind')), 'hider casts Rewind');
select throws_ok(format($$ select pg_temp.ask('radar', 'custom', %s, %s, 81) $$,
  current_setting('test.lng'), current_setting('test.lat')), 'P0001', 'questions_blocked', 'it blocks questions');
select lives_ok(format($$ select pg_temp.clear(%L, 82) $$, pg_temp.effect(current_setting('test.rewind')::uuid)),
  'seekers say Okay, done');
reset role;
select is((select status from public.card_effects where instance_id = current_setting('test.rewind')::uuid), 'cleared',
  'cleared with no hider confirm');
select is((select payload ->> 'self_cleared' from pg_temp.last_event('effect_cleared')), 'true', 'effect_cleared says so');

select * from finish();
rollback;
