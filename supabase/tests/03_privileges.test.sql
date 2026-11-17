-- Guard: clients may only call functions on this allow-list. If you add a client action,
-- grant it in its migration AND add it here. Anything else (helpers, triggers) must stay
-- locked, because Postgres grants EXECUTE to PUBLIC on new functions by default.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(2);

select is(
  array(
    select p.proname::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')
    order by 1
  ),
  array[]::text[],
  'no public function is callable by signed-out (anon) clients'
);

select is(
  array(
    select p.proname::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'execute')
    order by 1
  ),
  array[
    'can_join_topic', 'can_see', 'can_use_presence', 'create_game', 'get_city_pack',
    'is_player', 'join_game', 'my_team', 'remove_player', 'save_play_area', 'server_time', 'set_play_area',
    'set_team', 'start_game', 'topic_for', 'update_config'
  ],
  'signed-in clients can call only the allow-listed functions'
);

select * from finish();
rollback;
