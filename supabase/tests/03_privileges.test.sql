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
    'answer_question', 'ask_question', 'can_join_topic', 'can_read_drink_photo', 'can_read_question_photo', 'can_see', 'can_see_seeker_position',
    'can_upload_drink_photo', 'can_upload_question_photo', 'can_use_presence',
    'choose_bar', 'clear_effect', 'confirm_clear', 'create_game', 'delete_deck_preset', 'delete_play_area', 'get_city_pack', 'hiding_bars',
    'is_player', 'join_game', 'keep_cards', 'leave_game',
    'my_team', 'play_card', 'remove_player', 'report_position', 'roll_dice', 'save_card', 'save_category', 'save_deck_preset', 'save_play_area', 'server_time',
    'set_card_active', 'set_category_active', 'set_deck', 'set_play_area', 'set_team', 'settle_timers', 'spin_wheel', 'start_followup', 'start_game', 'submit_drink_proof', 'topic_for',
    'update_config', 'veto_curse'
  ],
  'signed-in clients can call only the allow-listed functions'
);

select * from finish();
rollback;
