-- Abandoned and test games (20261224090000_tidy_abandoned_games.sql): end_stale_games deletes
-- games where nothing happened (no scored round, no answered question) and dev-mode games,
-- ends the rest with no push, keeps games with media for a manual Delete, deletes ended games
-- where nothing happened a day later; list_past_games leaves them out.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(14);

insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');

select set_config('test.area_id',
  (select id::text from public.play_areas where city = 'brisbane' and created_by is null order by name limit 1), true);
create function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
end;
$$;
create function pg_temp.uid(n int) returns uuid language sql as $$
  select ('ffffffff-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid
$$;
create function pg_temp.seq(p_game uuid) returns bigint language sql security definer as $$
  select last_seq from public.games where id = p_game;
$$;
-- A started game: host seeker, Amy hider. n spaces out the client action ids.
create function pg_temp.started(n int, p_config jsonb) returns uuid language plpgsql as $$
declare
  v_game uuid;
  v_code text;
begin
  perform pg_temp.as_user('11111111-1111-1111-1111-111111111111');
  v_game := public.create_game('Host', pg_temp.uid(n), 'brisbane', p_config) ->> 'game_id';
  select code into v_code from public.games where id = v_game;
  perform pg_temp.as_user('22222222-2222-2222-2222-222222222222');
  perform public.join_game(v_code, 'Amy', pg_temp.uid(n + 1));
  perform public.set_team(v_game, 'hiders', pg_temp.uid(n + 2));
  perform pg_temp.as_user('11111111-1111-1111-1111-111111111111');
  perform public.set_team(v_game, 'seekers', pg_temp.uid(n + 3));
  perform public.set_play_area(v_game, current_setting('test.area_id')::uuid, pg_temp.uid(n + 4), pg_temp.seq(v_game));
  perform public.start_game(v_game, pg_temp.uid(n + 5), pg_temp.seq(v_game));
  return v_game;
end;
$$;
grant execute on all functions in schema pg_temp to authenticated;

set local role authenticated;
select set_config('test.empty', pg_temp.started(10, '{"hiding_period_s":1800}')::text, true);
select set_config('test.played', pg_temp.started(20, '{"hiding_period_s":1800}')::text, true);
select set_config('test.dev', pg_temp.started(30, '{"hiding_period_s":1800,"dev_mode":true}')::text, true);
select set_config('test.media', pg_temp.started(40, '{"hiding_period_s":1800,"dev_mode":true}')::text, true);
select set_config('test.fresh', pg_temp.started(50, '{"hiding_period_s":1800}')::text, true);
select set_config('test.ended', pg_temp.started(60, '{"hiding_period_s":1800}')::text, true);
select public.end_game(current_setting('test.ended')::uuid, pg_temp.uid(70), pg_temp.seq(current_setting('test.ended')::uuid));
reset role;

-- A scored round in "played" and in "dev"; a photo in "media".
insert into public.game_rounds (game_id, round, hiders, seekers, hide_s)
values (current_setting('test.played')::uuid, 1, '[]', '[]', 600),
       (current_setting('test.dev')::uuid, 1, '[]', '[]', 600);
insert into public.media_objects (name, game_id, bucket, content_type, bytes, quality, created_by, uploaded_at)
values (current_setting('test.media') || '/' || pg_temp.uid(90) || '/cost.jpg', current_setting('test.media')::uuid,
        'drink-photos', 'image/jpeg', 1234, 'original', '22222222-2222-2222-2222-222222222222', now());

-- The ended game is listed for a day only if something happened in it: it isn't.
set local role authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is((select count(*)::int from jsonb_array_elements(public.list_past_games())), 0,
  'past games leave out a game where nothing happened');
reset role;

-- Everything but "fresh" goes a day without events.
alter table public.events disable trigger events_append_only;
update public.events set created_at = now() - interval '25 hours'
 where game_id <> current_setting('test.fresh')::uuid;
alter table public.events enable trigger events_append_only;
update public.games set updated_at = now() - interval '25 hours' where id <> current_setting('test.fresh')::uuid;
select set_config('test.pushes', (select count(*)::text from public.push_outbox
  where game_id in (current_setting('test.played')::uuid, current_setting('test.media')::uuid)), true);

set local role authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is(public.end_stale_games(), 5, 'four stale running games and the ended one are handled');
reset role;

create function pg_temp.exists_(p text) returns boolean language sql as $$
  select exists (select 1 from public.games where id = current_setting(p)::uuid)
$$;
create function pg_temp.status(p text) returns text language sql as $$
  select status::text from public.games where id = current_setting(p)::uuid
$$;
select is(pg_temp.exists_('test.empty'), false, 'a game where nothing happened is deleted');
select is((select count(*)::int from public.events where game_id = current_setting('test.empty')::uuid), 0,
  'its events go with it');
select is(pg_temp.status('test.played'), 'ended', 'a game with a scored round is ended');
select is((select payload ->> 'reason' from public.events
            where game_id = current_setting('test.played')::uuid and type = 'game_ended'), 'inactive',
  'ended for inactivity');
select is((select count(*)::int from public.push_outbox
             where game_id in (current_setting('test.played')::uuid, current_setting('test.media')::uuid)),
  current_setting('test.pushes')::int,
  'auto-ending sends no push');
select is(pg_temp.exists_('test.dev'), false, 'a dev-mode game is deleted even with a scored round');
select is(pg_temp.status('test.media'), 'ended', 'a game with media is ended, not deleted');
select is(pg_temp.status('test.fresh'), 'hiding', 'a game with recent events keeps going');
select is(pg_temp.exists_('test.ended'), false, 'an ended game where nothing happened is deleted a day later');

set local role authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is((select array_agg(e ->> 'id' order by e ->> 'id') from jsonb_array_elements(public.list_past_games()) e),
  (select array_agg(x order by x) from unnest(array[current_setting('test.played'), current_setting('test.media')]) x),
  'past games list the played game and the one with media');
select is(public.end_stale_games(), 0, 'kept games are left alone on the next run');
reset role;

-- The host ending a game still sends the usual Game over push.
set local role authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select public.end_game(current_setting('test.fresh')::uuid, pg_temp.uid(80), pg_temp.seq(current_setting('test.fresh')::uuid));
reset role;
select is((select title from public.push_outbox where game_id = current_setting('test.fresh')::uuid order by id desc limit 1),
  'Game over', 'the host ending a game still sends Game over');

select * from finish();
rollback;
