-- Media in R2 (20261222090000_r2_media.sql): upload grants, the storage budget, reduced
-- quality videos, uploads counted by the actions, and the leak test for read URLs (a
-- hider-only file never reaches a seeker). The Edge Functions call the service functions
-- with the caller's id, as here.
-- Players: H = host (seeker), A = hider, S = seeker, O = in another game. Cards are put in the hand directly.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(40);

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
  select ('abababab-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid
$$;
create function pg_temp.hider() returns void language sql as $$
  select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
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
create function pg_temp.path(p_folder text, p_file text) returns text language sql as $$
  select pg_temp.gid() || '/' || p_folder || '/' || p_file
$$;
-- Grant with a 10 000 byte budget, half of it for reduced videos, 8 000 bytes a file.
create function pg_temp.grant_as(p_user text, p_name text, p_bytes bigint, p_type text, p_picked jsonb default '{}')
returns jsonb language sql as $$
  select public.media_upload_grant(p_user::uuid, p_name, p_bytes, p_type, p_picked, 10000, 0.5, 8000)
$$;
grant execute on all functions in schema pg_temp to authenticated;

select set_config('test.A', '22222222-2222-2222-2222-222222222222', true);
select set_config('test.S', '33333333-3333-3333-3333-333333333333', true);
select set_config('test.O', '44444444-4444-4444-4444-444444444444', true);

-- ---------------------------------------------------------------- content

select is((select params ->> 'video_quality' from public.cards where id = 'bird_guide'), 'reduced',
  'Bird Guide videos are reduced quality');
select is((select params ->> 'video_quality' from public.cards where id = 'sculling'), null,
  'Sculling (people drinking) stays original');

-- ---------------------------------------------------------------- setup

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
set local role authenticated;
select set_config('test.game_id',
  public.create_game('Host', pg_temp.uid(1), 'brisbane', '{"hiding_period_s":1800,"hand_limit":8,
    "deck":{"duplicate":1,"cheers":1,"sculling":1,"bird_guide":1,"bonus_red":10}}'::jsonb) ->> 'game_id', true);
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
select set_config('test.bars', array_to_string(public.hiding_bars(pg_temp.gid()), ','), true);
select public.choose_bar(pg_temp.gid(), split_part(current_setting('test.bars'), ',', 1), pg_temp.uid(9), pg_temp.seq());

-- O plays in another game.
select pg_temp.as_user('44444444-4444-4444-4444-444444444444');
select public.create_game('Olly', pg_temp.uid(50), 'brisbane', '{}'::jsonb);

reset role;
update public.games set round_started_at = now() - interval '31 minutes' where id = pg_temp.gid();
-- Duplicate costs the hiders a shot here: its drink and photo are hider-only.
update public.game_cards set cast_cost = 'shot' where game_id = pg_temp.gid() and card_id = 'duplicate';
select set_config('test.dup', pg_temp.to_hand('duplicate')::text, true);
select set_config('test.cheers', pg_temp.to_hand('cheers')::text, true);
select set_config('test.sculling', pg_temp.to_hand('sculling')::text, true);
select set_config('test.bird', pg_temp.to_hand('bird_guide')::text, true);
select set_config('test.p_dup', pg_temp.path(current_setting('test.dup'), 'cost.jpg'), true);
select set_config('test.p_scull', pg_temp.path(current_setting('test.sculling'), 'chug.mov'), true);
select set_config('test.p_bird', pg_temp.path(current_setting('test.bird'), 'bird.mp4'), true);

-- ---------------------------------------------------------------- upload grants

select is(pg_temp.grant_as(current_setting('test.A'), current_setting('test.p_dup'), 100, 'image/jpeg', '{"bytes":100,"type":"image/jpeg"}'),
  '{"store":"r2","bucket":"drink-photos","quality":"original"}'::jsonb,
  'a hider may upload the cost photo for a card in the hand, untouched');
select is((select array[picked ->> 'bytes', created_by::text, (uploaded_at is null)::text] from public.media_objects
            where name = current_setting('test.p_dup')),
  array['100', current_setting('test.A'), 'true'], 'reserved with what the picker handed over');
select throws_ok($$ select pg_temp.grant_as(current_setting('test.S'), pg_temp.path(current_setting('test.dup'), 'x.jpg'), 100, 'image/jpeg') $$,
  'P0001', 'media_not_allowed', 'a seeker may not upload under a hider card');
select throws_ok($$ select pg_temp.grant_as(current_setting('test.O'), pg_temp.path(current_setting('test.dup'), 'x.jpg'), 100, 'image/jpeg') $$,
  'P0001', 'media_not_allowed', 'nor may a player of another game');
select throws_ok($$ select pg_temp.grant_as(current_setting('test.A'), pg_temp.gid() || '/x/../y.jpg', 100, 'image/jpeg') $$,
  'P0001', 'invalid_media_path', 'names must be <game>/<folder>/<file>');
select throws_ok($$ select pg_temp.grant_as(current_setting('test.A'), pg_temp.path(current_setting('test.dup'), 'x.jpg'), 100, 'video/mp4') $$,
  'P0001', 'invalid_media_type', 'the type must match the extension');
select throws_ok($$ select pg_temp.grant_as(current_setting('test.A'), pg_temp.path(current_setting('test.dup'), 'x.jpg'), 9000, 'image/jpeg') $$,
  'P0001', 'media_too_big', 'one file has a cap');
select throws_ok($$ select pg_temp.grant_as(current_setting('test.S'), current_setting('test.p_dup'), 100, 'image/jpeg') $$,
  'P0001', 'media_not_allowed', 'nobody else can take over a reservation');

select is(pg_temp.grant_as(current_setting('test.A'), current_setting('test.p_bird'), 6000, 'video/mp4'),
  '{"squeeze":true,"bucket":"drink-photos"}'::jsonb,
  'a big Bird Guide video past the reduced share is squeezed first');
select is((select count(*)::int from public.media_objects where name = current_setting('test.p_bird')), 0,
  'and reserves nothing');
select is(public.media_upload_grant(current_setting('test.A')::uuid, current_setting('test.p_bird'), 9000, 'video/mp4', '{}', 100000, 0.5, 8000),
  '{"squeeze":true,"bucket":"drink-photos"}'::jsonb,
  'a Bird Guide video past the file cap is squeezed, even with room to spare');
select throws_ok($$ select public.media_upload_grant(current_setting('test.A')::uuid, current_setting('test.p_scull'), 9000, 'video/quicktime', '{}', 100000, 0.5, 8000) $$,
  'P0001', 'media_too_big', 'a full-quality video past the file cap is refused');
select is(pg_temp.grant_as(current_setting('test.A'), current_setting('test.p_bird'), 3000, 'video/mp4', '{"squeezed":true}'),
  '{"store":"r2","bucket":"drink-photos","quality":"squeezed"}'::jsonb,
  'the squeezed copy goes to R2');
select is(pg_temp.grant_as(current_setting('test.A'), current_setting('test.p_scull'), 5000, 'video/quicktime'),
  '{"store":"r2","bucket":"drink-photos","quality":"original"}'::jsonb,
  'a Sculling video (people, drinks) stays original past the reduced share');
select is(pg_temp.grant_as(current_setting('test.A'), pg_temp.path(current_setting('test.dup'), 'big.jpg'), 2000, 'image/jpeg'),
  '{"store":"supabase","bucket":"drink-photos","reason":"storage_full"}'::jsonb,
  'past the budget (reservations count) uploads go to Supabase');

-- ---------------------------------------------------------------- uploaded

select throws_ok($$ select public.media_upload_done(current_setting('test.S')::uuid, current_setting('test.p_dup'), 100) $$,
  'P0001', 'media_not_allowed', 'only the uploader confirms');
select is(public.media_upload_done(current_setting('test.A')::uuid, current_setting('test.p_dup'), 90), 'ok',
  'the uploader confirms with the size R2 reports');
select is((select bytes from public.media_objects where name = current_setting('test.p_dup')), 90::bigint,
  'which is what counts');
select is(public.media_upload_done(current_setting('test.A')::uuid, current_setting('test.p_scull'), 5000), 'ok', 'video confirmed');
select is(public.media_upload_done(current_setting('test.A')::uuid, current_setting('test.p_bird'), null), 'missing',
  'not in R2 yet: the reservation stays for a retry');
select throws_ok($$ select pg_temp.grant_as(current_setting('test.A'), current_setting('test.p_dup'), 90, 'image/jpeg') $$,
  'P0001', 'media_exists', 'an uploaded name is never overwritten');

-- An object bigger than its reservation is dropped (the function deletes it from R2).
select pg_temp.grant_as(current_setting('test.A'), pg_temp.path(current_setting('test.cheers'), 'liar.jpg'), 10, 'image/jpeg');
select is(public.media_upload_done(current_setting('test.A')::uuid, pg_temp.path(current_setting('test.cheers'), 'liar.jpg'), 5000), 'too_big',
  'bigger than declared: refused');
select is((select count(*)::int from public.media_objects where name = pg_temp.path(current_setting('test.cheers'), 'liar.jpg')), 0,
  'and forgotten');

-- ---------------------------------------------------------------- actions see R2 uploads

set local role authenticated;
select pg_temp.hider();
select lives_ok(format($$ select public.play_card(pg_temp.gid(), %L, pg_temp.uid(10), pg_temp.seq(), %L) $$,
  current_setting('test.dup'), jsonb_build_object('target', current_setting('test.cheers'),
    'media', jsonb_build_object('cost', current_setting('test.p_dup')))),
  'Duplicate cast with its cost photo in R2');
select lives_ok(format($$ select public.play_card(pg_temp.gid(), %L, pg_temp.uid(11), pg_temp.seq(), %L) $$,
  current_setting('test.sculling'), jsonb_build_object('media', jsonb_build_object('setup', current_setting('test.p_scull')))),
  'Sculling cast with its video in R2');
select throws_ok(format($$ select public.play_card(pg_temp.gid(), %L, pg_temp.uid(12), pg_temp.seq(), %L) $$,
  current_setting('test.bird'), jsonb_build_object('media', jsonb_build_object('setup', current_setting('test.p_bird')))),
  'P0001', 'photo_not_uploaded', 'a reservation that never arrived is not an upload');
reset role;
select is(
  (select array_agg(visibility::text order by seq) from public.events
    where game_id = pg_temp.gid() and type = 'drink_proved'),
  array['hiders', 'all'], 'the cost photo is hider-only, the Sculling video public');

-- ---------------------------------------------------------------- leak test: read URLs

select is(array(select name from public.media_read_grant(current_setting('test.A')::uuid,
                  array[current_setting('test.p_dup'), current_setting('test.p_scull')]) order by name),
  array(select unnest(array[current_setting('test.p_dup'), current_setting('test.p_scull')]) order by 1),
  'the hiders read both');
select is(array(select name from public.media_read_grant(current_setting('test.S')::uuid,
                  array[current_setting('test.p_dup'), current_setting('test.p_scull')])),
  array[current_setting('test.p_scull')], 'a seeker never gets a read URL for the hider-only photo');
select is(array(select name from public.media_read_grant('11111111-1111-1111-1111-111111111111'::uuid,
                  array[current_setting('test.p_dup')])),
  array[]::text[], 'nor does the seeker host');
select is(array(select name from public.media_read_grant(current_setting('test.O')::uuid,
                  array[current_setting('test.p_scull')])),
  array[]::text[], 'players of other games read nothing');
select is((select array[store, bucket] from public.media_read_grant(current_setting('test.S')::uuid, array[current_setting('test.p_scull')])),
  array['r2', 'drink-photos'], 'R2 files are read from R2');
select is((select array[store, bucket] from public.media_read_grant(current_setting('test.A')::uuid,
                  array[pg_temp.path(current_setting('test.bird'), 'old.mp4')])),
  array['supabase', 'drink-photos'], 'anything else from its Supabase bucket');

-- The Supabase buckets follow the same rule (no listing a hider-only file).
set local role authenticated;
select pg_temp.seeker();
select ok(not public.can_read_drink_photo(current_setting('test.p_dup')), 'storage: the seeker may not read it');
select pg_temp.hider();
select ok(public.can_read_drink_photo(current_setting('test.p_dup')), 'storage: the hiders may');
reset role;

-- ---------------------------------------------------------------- old reservations, privileges

update public.media_objects set created_at = now() - interval '30 minutes' where name = current_setting('test.p_bird');
select is(array(select public.media_stale_uploads(5)), array[current_setting('test.p_bird')],
  'reservations past 20 min are swept');
select is(public.media_upload_done(null, current_setting('test.p_bird'), null), 'missing', 'not in R2: dropped');
select ok(not has_function_privilege('authenticated', 'public.media_upload_grant(uuid, text, bigint, text, jsonb, bigint, numeric, bigint)', 'execute')
      and has_function_privilege('service_role', 'public.media_read_grant(uuid, text[])', 'execute'),
  'only the Edge Functions (service role) call the media functions');

select * from finish();
rollback;
