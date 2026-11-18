-- Push alerts (20261211090100_push_alerts.sql): subscriptions, and which events queue an
-- alert for whom. Sending is the Edge Function's job (supabase/functions/send-push).

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(20);

insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('33333333-3333-3333-3333-333333333333');

create function pg_temp.as_user(p_uid text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
$$;
create function pg_temp.gid() returns uuid language sql as $$
  select current_setting('test.game_id')::uuid;
$$;
create function pg_temp.last_alert() returns public.push_outbox language sql as $$
  select * from public.push_outbox where game_id = pg_temp.gid() order by id desc limit 1;
$$;
grant execute on all functions in schema pg_temp to authenticated;

-- ---------------------------------------------------------------- subscriptions
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
set local role authenticated;
select set_config('test.game_id',
  public.create_game('Host', 'dddddddd-0000-0000-0000-000000000001', 'brisbane', '{}'::jsonb) ->> 'game_id', true);

select lives_ok(
  $$ select public.save_push_subscription('https://push.example.com/abc', 'key', 'auth') $$,
  'a signed-in user saves a subscription'
);
select lives_ok(
  $$ select public.save_push_subscription('https://push.example.com/abc', 'key2', 'auth2') $$,
  'saving again updates it'
);
select throws_ok(
  $$ select public.save_push_subscription('http://push.example.com/abc', 'key', 'auth') $$,
  'P0001', 'invalid_push_subscription', 'endpoints must be https'
);
select throws_ok(
  $$ select count(*) from public.push_subscriptions $$,
  '42501', null, 'clients cannot read subscriptions'
);
select throws_ok(
  $$ select count(*) from public.push_outbox $$,
  '42501', null, 'clients cannot read the outbox'
);
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select lives_ok(
  $$ select public.delete_push_subscription('https://push.example.com/abc') $$,
  'deleting someone else''s subscription is a no-op'
);
reset role;
select is(
  (select p256dh || ':' || user_id::text from public.push_subscriptions where endpoint = 'https://push.example.com/abc'),
  'key2:11111111-1111-1111-1111-111111111111', 'the owner''s latest keys are kept'
);
set local role authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select public.delete_push_subscription('https://push.example.com/abc');
reset role;
select is((select count(*)::int from public.push_subscriptions), 0, 'the owner deletes it');

-- ---------------------------------------------------------------- alerts
select is((select count(*)::int from public.push_outbox where game_id = pg_temp.gid()), 0, 'lobby events queue nothing');

select public._append_event(pg_temp.gid(), 'question_asked', '{"type":"radar","deadline_s":300}'::jsonb, 'all',
  '33333333-3333-3333-3333-333333333333');
select is(
  (select audience::text || '|' || title || '|' || body || '|' || exclude_user::text from pg_temp.last_alert()),
  'hiders|New question|Radar question: answer within 5 min.|33333333-3333-3333-3333-333333333333',
  'a new question alerts the hiders, not the asker'
);

select public._append_event(pg_temp.gid(), 'question_answered', '{"type":"thermometer"}'::jsonb, 'all',
  '11111111-1111-1111-1111-111111111111');
select is(
  (select audience::text || '|' || body from pg_temp.last_alert()),
  'seekers|The hiders answered your thermometer question.', 'an answer alerts the seekers'
);

select public._append_event(pg_temp.gid(), 'card_played', '{"card":{"category":"curse","name":"Curse of the Spotty Memory"}}'::jsonb);
select is((select audience::text || '|' || title from pg_temp.last_alert()), 'seekers|Curse: Curse of the Spotty Memory', 'a curse alerts the seekers');

select set_config('test.n', (select count(*)::text from public.push_outbox), true);
select public._append_event(pg_temp.gid(), 'card_played', '{"card":{"category":"powerup","name":"Veto"}}'::jsonb);
select public._append_event(pg_temp.gid(), 'card_played', '{"card":{"category":"curse","name":"Hidden"}}'::jsonb, 'hiders');
select public._append_event(pg_temp.gid(), 'cards_drawn', '{}'::jsonb, 'hiders');
select is((select count(*)::text from public.push_outbox), current_setting('test.n'),
  'powerups, hider-only plays and draws queue nothing');

select public._append_event(pg_temp.gid(), 'freeze_changed', '{"frozen":true}'::jsonb, 'hiders', null);
select is(
  (select audience::text || '|' || title || '|' || coalesce(exclude_user::text, 'none') from pg_temp.last_alert()),
  'hiders|Freeze|none', 'a freeze alerts the hiders only'
);
select public._append_event(pg_temp.gid(), 'freeze_changed', '{"frozen":false}'::jsonb, 'hiders', null);
select is((select title from pg_temp.last_alert()), 'Freeze over', 'and when it ends');

select is(public._push_for_event('freeze_changed', 'seekers', '{"frozen":true}'::jsonb), null,
  'an alert never goes wider than its event');
select is(
  (select count(*)::int from public.push_outbox o
     join public.events e on e.game_id = o.game_id and e.seq = o.seq
    where o.game_id = pg_temp.gid() and e.visibility <> 'all' and o.audience::text <> e.visibility::text),
  0, 'every team-only event alerts only that team'
);

select ok(
  has_table_privilege('service_role', 'public.push_outbox', 'select')
    and has_table_privilege('service_role', 'public.push_outbox', 'update'),
  'send-push can read and mark the outbox'
);
select ok(
  has_table_privilege('service_role', 'public.push_subscriptions', 'select')
    and has_table_privilege('service_role', 'public.push_subscriptions', 'delete'),
  'send-push can read and prune subscriptions'
);
select ok(has_table_privilege('service_role', 'public.players', 'select'), 'send-push can read players');

select * from finish();
rollback;
