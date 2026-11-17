-- Broadcast payloads carry prev_seq per audience so clients can detect real gaps.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(4);

insert into auth.users (id) values ('11111111-1111-1111-1111-111111111111');
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
set local role authenticated;
select set_config('test.game_id',
  public.create_game('Host', 'bbbbbbbb-0000-0000-0000-000000000001') ->> 'game_id', true);
reset role;

-- seq 1 game_created (all), 2 hiders, 3 seekers, 4 all
select public._append_event(current_setting('test.game_id')::uuid, 'secret_h', '{}', 'hiders');
select public._append_event(current_setting('test.game_id')::uuid, 'secret_s', '{}', 'seekers');
select public._append_event(current_setting('test.game_id')::uuid, 'shared', '{}', 'all');

create temp table msgs as
  select (payload ->> 'seq')::int as seq, payload -> 'prev_seq' as prev
  from realtime.messages where payload ->> 'game_id' = current_setting('test.game_id');

select is((select prev from msgs where seq = 1), '{"none":0,"hiders":0,"seekers":0}'::jsonb,
  'first event has no predecessors');
select is((select prev from msgs where seq = 3), '{"none":1,"hiders":2,"seekers":1}'::jsonb,
  'seekers event: seekers skip the hider-only seq 2');
select is((select prev from msgs where seq = 4), '{"none":1,"hiders":2,"seekers":3}'::jsonb,
  'shared event: each audience points at its own previous visible event');
select ok(not has_function_privilege('authenticated', 'public._broadcast_event()', 'execute'),
  'broadcast trigger stays locked');

select * from finish();
rollback;
