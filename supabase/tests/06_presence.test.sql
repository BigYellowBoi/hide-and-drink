-- Presence: players may track and see presence on the shared game topic only.
-- Clients may never send broadcasts (that would let a phone inject fake game events).

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(7);

insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('44444444-4444-4444-4444-444444444444');

select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
set local role authenticated;
select set_config('test.game_id',
  public.create_game('Host', 'cccccccc-0000-0000-0000-000000000001') ->> 'game_id', true);
select public.set_team(current_setting('test.game_id')::uuid, 'seekers', 'cccccccc-0000-0000-0000-000000000002');

-- ---------------------------------------------------------------- a player
select set_config('realtime.topic', 'game:' || current_setting('test.game_id'), true);
select lives_ok(
  $$ insert into realtime.messages (topic, extension, payload, event)
     values (current_setting('realtime.topic'), 'presence', '{"user_id":"me"}', 'presence') $$,
  'a player can track presence on the shared game topic'
);
select ok(
  (select count(*) from realtime.messages where extension = 'presence') > 0,
  'a player can see presence on the shared game topic'
);
select throws_ok(
  $$ insert into realtime.messages (topic, extension, payload, event)
     values (current_setting('realtime.topic'), 'broadcast', '{"seq":999}', 'event') $$,
  '42501', null, 'a player cannot send broadcasts on the game topic'
);

select set_config('realtime.topic', 'game:' || current_setting('test.game_id') || ':seekers', true);
select throws_ok(
  $$ insert into realtime.messages (topic, extension, payload, event)
     values (current_setting('realtime.topic'), 'presence', '{}', 'presence') $$,
  '42501', null, 'presence is not allowed on team topics'
);

-- ---------------------------------------------------------------- an outsider
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}', true);
select set_config('realtime.topic', 'game:' || current_setting('test.game_id'), true);
select throws_ok(
  $$ insert into realtime.messages (topic, extension, payload, event)
     values (current_setting('realtime.topic'), 'presence', '{}', 'presence') $$,
  '42501', null, 'a non-player cannot track presence'
);
select is(
  (select count(*)::int from realtime.messages where extension = 'presence'),
  0,
  'a non-player cannot see presence'
);

reset role;
select ok(not public.can_use_presence('game:not-a-uuid'), 'malformed topics are refused');

select * from finish();
rollback;
