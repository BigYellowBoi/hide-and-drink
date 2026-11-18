-- Card library editing (cards, categories, retire/restore, author, live broadcast) and the
-- deck builder (set_deck, update_config keeps the deck, presets, retired cards at start).
-- Players: H = host, A = another player.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(46);

insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');

create function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
end;
$$;
create function pg_temp.gid() returns uuid language sql as $$ select current_setting('test.game_id')::uuid $$;
create function pg_temp.seq() returns bigint language sql as $$
  select last_seq from public.games where id = pg_temp.gid();
$$;
create function pg_temp.uid(n int) returns uuid language sql as $$
  select ('dddddddd-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid
$$;
create function pg_temp.deck_copies() returns table (card_id text, copies integer) language sql security definer as $$
  select * from public._deck_copies((select config from public.games where id = pg_temp.gid()))
$$;
create function pg_temp.lib_msgs() returns bigint language sql security definer as $$
  select count(*) from realtime.messages where topic = 'library'
$$;
grant execute on all functions in schema pg_temp to authenticated;

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
set local role authenticated;

-- ---------------------------------------------------------------- cards

select set_config('test.card', public.save_card(null,
  '{"name":"Curse of the Karaoke","category":"curse","behaviour":"timed","text":"Sing.",
    "params":{"duration_s":600},"cast_cost":"drink","can_veto":true,"copies":2}'::jsonb,
  pg_temp.uid(1), null, 'Hana') ->> 'card_id', true);

select is(current_setting('test.card'), 'curse_of_the_karaoke', 'a new card gets an id from its name');
select results_eq(
  $$ select name, category_id, behaviour, body, cast_cost, can_veto, default_copies, active, updated_by_name
       from public.cards where id = 'curse_of_the_karaoke' $$,
  $$ values ('Curse of the Karaoke', 'curse', 'timed', 'Sing.', 'drink', true, 2, true, 'Hana') $$,
  'the card is saved with its author'
);
select ok((select sort > 0 from public.cards where id = 'curse_of_the_karaoke'), 'new cards go to the end of their category');
select is(
  (select action || ':' || author_name from public.library_edits where item_id = 'curse_of_the_karaoke'),
  'created:Hana', 'the edit is logged'
);
select is(pg_temp.lib_msgs(), 1::bigint, 'and broadcast on the library topic');
select is(
  public.save_card(null, '{"name":"Curse of the Karaoke","category":"curse","behaviour":"text","copies":1}'::jsonb,
    pg_temp.uid(2)) ->> 'card_id',
  'curse_of_the_karaoke_2', 'a taken id gets a suffix'
);
select is(
  public.save_card(null, '{"name":"Curse of the Karaoke","category":"curse","behaviour":"timed",
    "params":{"duration_s":600},"cast_cost":"drink","can_veto":true,"copies":2}'::jsonb, pg_temp.uid(1)) ->> 'card_id',
  'curse_of_the_karaoke', 'a retried save returns the first result'
);

select throws_ok(
  $$ select public.save_card(null, '{"name":"","category":"curse","behaviour":"text","copies":1}'::jsonb, pg_temp.uid(3)) $$,
  'P0001', 'invalid_card_name', 'a card needs a name'
);
select throws_ok(
  $$ select public.save_card(null, '{"name":"X","category":"nope","behaviour":"text","copies":1}'::jsonb, pg_temp.uid(4)) $$,
  'P0001', 'category_not_found', 'a card needs a real category'
);
select throws_ok(
  $$ select public.save_card(null, '{"name":"X","category":"curse","behaviour":"teleport","copies":1}'::jsonb, pg_temp.uid(5)) $$,
  'P0001', 'invalid_card_behaviour', 'only the fixed behaviours'
);
select throws_ok(
  $$ select public.save_card(null, '{"name":"X","category":"curse","behaviour":"timed","copies":1}'::jsonb, pg_temp.uid(6)) $$,
  'P0001', 'invalid_card_params', 'a timed card needs a duration'
);
select throws_ok(
  $$ select public.save_card(null, '{"name":"X","category":"powerup","behaviour":"powerup","params":{"action":"discard_draw","discard":1},"copies":1}'::jsonb, pg_temp.uid(7)) $$,
  'P0001', 'invalid_card_params', 'discard/draw needs both counts'
);
select throws_ok(
  $$ select public.save_card(null, '{"name":"X","category":"curse","behaviour":"text","copies":100}'::jsonb, pg_temp.uid(8)) $$,
  'P0001', 'invalid_card_copies', 'copies stay between 0 and 99'
);
select throws_ok(
  $$ select public.save_card(null, '{"name":"X","category":"curse","behaviour":"text","cast_cost":"pint","copies":1}'::jsonb, pg_temp.uid(9)) $$,
  'P0001', 'invalid_card_cost', 'cast cost is free, drink or shot'
);
select throws_ok(
  $$ select public.save_card(null, '{"name":"X","category":"curse","behaviour":"text","params":{"drinks":["everyone"]},"copies":1}'::jsonb, pg_temp.uid(10)) $$,
  'P0001', 'invalid_card_params', 'drinks lists teams'
);

-- Amy edits it.
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select set_config('test.base', (select updated_at::text from public.cards where id = 'curse_of_the_karaoke'), true);
select lives_ok(
  $$ select public.save_card('curse_of_the_karaoke', '{"name":"Curse of Karaoke","category":"curse","behaviour":"timed",
       "params":{"duration_s":900,"followup_s":300},"cast_cost":"shot","can_veto":false,"copies":1}'::jsonb,
       pg_temp.uid(20), current_setting('test.base')::timestamptz, 'Amy') $$,
  'anyone can edit a card'
);
select results_eq(
  $$ select name, (params ->> 'duration_s')::int, cast_cost, can_veto, default_copies, updated_by_name
       from public.cards where id = 'curse_of_the_karaoke' $$,
  $$ values ('Curse of Karaoke', 900, 'shot', false, 1, 'Amy') $$,
  'the edit is stored with its author'
);
select is(
  (select before ->> 'name' from public.library_edits where item_id = 'curse_of_the_karaoke' and action = 'updated'),
  'Curse of the Karaoke', 'the history keeps what it was'
);
select throws_ok(
  $$ select public.save_card('curse_of_the_karaoke', '{"name":"Old","category":"curse","behaviour":"text","copies":1}'::jsonb,
       pg_temp.uid(21), current_setting('test.base')::timestamptz) $$,
  'P0001', 'card_changed', 'saving over an edit you have not seen is refused'
);
select throws_ok(
  $$ select public.save_card('nope', '{"name":"X","category":"curse","behaviour":"text","copies":1}'::jsonb, pg_temp.uid(22)) $$,
  'P0001', 'card_not_found', 'editing a missing card fails'
);

select lives_ok($$ select public.set_card_active('curse_of_the_karaoke_2', false, pg_temp.uid(23)) $$, 'cards can be retired');
select is((select active from public.cards where id = 'curse_of_the_karaoke_2'), false, 'retired, not deleted');
select is(
  (select author_name from public.library_edits where item_id = 'curse_of_the_karaoke_2' and action = 'retired'),
  'Amy', 'without a name sent, the author is their latest player name (or the one used before)'
);

-- ---------------------------------------------------------------- categories

select set_config('test.cat', public.save_category(null, 'Dares', '#ff8800', pg_temp.uid(30), 'Amy') ->> 'category_id', true);
select results_eq(
  $$ select id, name, colour, active from public.categories where id = current_setting('test.cat') $$,
  $$ values ('dares', 'Dares', '#FF8800', true) $$,
  'a new category'
);
select throws_ok(
  $$ select public.save_category(null, 'curse', '#ff0000', pg_temp.uid(31)) $$,
  'P0001', 'category_name_taken', 'category names are unique'
);
select throws_ok(
  $$ select public.save_category(null, 'Red', 'red', pg_temp.uid(32)) $$,
  'P0001', 'invalid_category_colour', 'colours are #RRGGBB'
);
select lives_ok($$ select public.save_category('dares', 'Dares!', '#FF9900', pg_temp.uid(33)) $$, 'categories can be renamed');
select public.save_card(null, '{"name":"Dare","category":"dares","behaviour":"text","copies":1}'::jsonb, pg_temp.uid(34));
select throws_ok(
  $$ select public.set_category_active('dares', false, pg_temp.uid(35)) $$,
  'P0001', 'category_in_use', 'a category with active cards stays'
);
select public.set_card_active('dare', false, pg_temp.uid(36));
select lives_ok($$ select public.set_category_active('dares', false, pg_temp.uid(37)) $$, 'an empty category can be retired');
select throws_ok(
  $$ select public.set_card_active('dare', true, pg_temp.uid(38)) $$,
  'P0001', 'category_retired', 'a card in a retired category cannot come back on its own'
);
select throws_ok(
  $$ select public.save_card(null, '{"name":"Y","category":"dares","behaviour":"text","copies":1}'::jsonb, pg_temp.uid(39)) $$,
  'P0001', 'category_not_found', 'new cards cannot go in a retired category'
);

-- ---------------------------------------------------------------- deck

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select set_config('test.game_id', public.create_game('Hana', pg_temp.uid(50)) ->> 'game_id', true);

select lives_ok(
  $$ select public.set_deck(pg_temp.gid(), '{"veto":2,"cheers":0,"curse_of_the_karaoke":3}'::jsonb, pg_temp.uid(51)) $$,
  'the host sets the deck'
);
select is((select config -> 'deck' from public.games where id = pg_temp.gid()),
  '{"veto":2,"cheers":0,"curse_of_the_karaoke":3}'::jsonb, 'stored in config.deck');
select is(
  (select payload #> '{config,deck,veto}' from public.events where game_id = pg_temp.gid() and type = 'config_changed'
    order by seq desc limit 1),
  '2'::jsonb, 'and announced as config_changed'
);
select public.update_config(pg_temp.gid(), '{"hand_limit":5,"deck":{"veto":9}}'::jsonb, pg_temp.uid(52), pg_temp.seq());
select is((select config -> 'deck' ->> 'veto' from public.games where id = pg_temp.gid()), '2',
  'update_config leaves the deck alone');
select is((select config ->> 'hand_limit' from public.games where id = pg_temp.gid()), '5', 'but saves the rest');
select throws_ok(
  $$ select public.set_deck(pg_temp.gid(), '{"curse_of_the_karaoke_2":1}'::jsonb, pg_temp.uid(53)) $$,
  'P0001', 'invalid_deck', 'retired cards cannot be added to a deck'
);
select throws_ok(
  $$ select public.set_deck(pg_temp.gid(), '{"veto":1.5}'::jsonb, pg_temp.uid(54)) $$,
  'P0001', 'invalid_deck', 'copies are whole numbers'
);

-- A card retired after the deck was built is dropped at start.
select public.set_card_active('curse_of_the_karaoke', false, pg_temp.uid(55));
select results_eq(
  $$ select card_id, copies from pg_temp.deck_copies() order by 1 $$,
  $$ values ('veto', 2) $$,
  'retired cards drop out of the deck at start'
);

select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select throws_ok(
  $$ select public.set_deck(pg_temp.gid(), null, pg_temp.uid(56)) $$,
  'P0001', 'host_only', 'only the host builds the deck'
);
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select public.set_deck(pg_temp.gid(), null, pg_temp.uid(57));
select ok((select not config ? 'deck' from public.games where id = pg_temp.gid()), 'null goes back to library defaults');

-- ---------------------------------------------------------------- presets

select set_config('test.preset',
  public.save_deck_preset('Big night', '{"veto":3,"cheers":0}'::jsonb, pg_temp.uid(60), 'Hana') ->> 'preset_id', true);
select results_eq(
  $$ select deck, creator_name from public.deck_presets where id = current_setting('test.preset')::uuid $$,
  $$ values ('{"veto":3}'::jsonb, 'Hana') $$,
  'a preset keeps the cards with copies'
);
select is(
  public.save_deck_preset('big night', '{"veto":1}'::jsonb, pg_temp.uid(61)) ->> 'preset_id',
  current_setting('test.preset'), 'saving your own preset again overwrites it'
);
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select throws_ok(
  $$ select public.save_deck_preset('Big night', '{"veto":1}'::jsonb, pg_temp.uid(62)) $$,
  'P0001', 'preset_name_taken', 'someone else''s preset name is taken'
);
select throws_ok(
  $$ select public.delete_deck_preset((select id from public.deck_presets where created_by is null limit 1), pg_temp.uid(63)) $$,
  'P0001', 'preset_protected', 'built-in presets stay'
);
select lives_ok(
  $$ select public.delete_deck_preset(current_setting('test.preset')::uuid, pg_temp.uid(64)) $$,
  'any player can delete a player-made preset'
);

select * from finish();
rollback;
