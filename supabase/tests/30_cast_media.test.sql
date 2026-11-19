-- Media sent with the card, Not applicable, train stations
-- (20261221090000_cast_media_escape_stations.sql).
-- Players: H = host (seeker), A = hider, S = seeker. Cards are put in the hand directly.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(18);

insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333');

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
  select ('ffffffff-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid
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
create function pg_temp.path(p_instance text, p_file text) returns text language sql as $$
  select pg_temp.gid() || '/' || p_instance || '/' || p_file
$$;
grant execute on all functions in schema pg_temp to authenticated;

-- ---------------------------------------------------------------- content

select is((select array[params ? 'seeker_confirm', params ? 'not_applicable'] from public.cards where id = 'escape'),
  array[false, true], 'Escape starts at once, with Not applicable');
select is(
  (select array_agg(type order by type) from public.question_types
    where city = 'brisbane' and exists (select 1 from jsonb_array_elements(options) o where o ->> 'id' like 'train_station%')),
  array['matching', 'photos', 'tentacles'], 'train stations in matching, tentacles and photos');
select ok((select count(*) > 10 from public.map_features where city = 'brisbane' and layer = 'gtfs:train stations'),
  'the train stations layer is loaded');
select ok((select bool_and(props -> 'modes' ? 'rail') from public.map_features where layer = 'gtfs:train stations'),
  'with rail stations only');

-- ---------------------------------------------------------------- setup

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
set local role authenticated;
select set_config('test.game_id',
  public.create_game('Host', pg_temp.uid(1), 'brisbane', '{"hiding_period_s":1800,"hand_limit":6,
    "deck":{"sculling":1,"bridge":1,"escape":1,"prison":1,"bonus_red":10}}'::jsonb) ->> 'game_id', true);
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

reset role;
update public.games set round_started_at = now() - interval '31 minutes' where id = pg_temp.gid();
select set_config('test.sculling', pg_temp.to_hand('sculling')::text, true);
select set_config('test.bridge', pg_temp.to_hand('bridge')::text, true);
select set_config('test.escape', pg_temp.to_hand('escape')::text, true);
select set_config('test.prison', pg_temp.to_hand('prison')::text, true);
set local role authenticated;

-- ---------------------------------------------------------------- uploads before casting

select pg_temp.hider();
select ok(public.can_upload_drink_photo(pg_temp.path(current_setting('test.sculling'), 'v.mp4')),
  'hiders may upload under a card in their hand');
select pg_temp.seeker();
select ok(not public.can_upload_drink_photo(pg_temp.path(current_setting('test.sculling'), 'v.mp4')),
  'seekers may not');

reset role;
insert into storage.objects (bucket_id, name)
values ('drink-photos', pg_temp.path(current_setting('test.sculling'), 'v.mp4')),
       ('drink-photos', pg_temp.path(current_setting('test.bridge'), 'd.jpg'));
set local role authenticated;

-- ---------------------------------------------------------------- Sculling: the video with the curse

select pg_temp.hider();
select throws_ok(format($$ select public.play_card(pg_temp.gid(), %L, pg_temp.uid(10), pg_temp.seq(), %L) $$,
  current_setting('test.sculling'), jsonb_build_object('media', jsonb_build_object('setup', pg_temp.path(current_setting('test.bridge'), 'nope.mp4')))),
  'P0001', 'photo_not_uploaded', 'a file that isn''t there refuses the cast');
reset role;
select is((select location from public.card_instances where id = current_setting('test.sculling')::uuid), 'hand',
  'and the card stays in the hand');
set local role authenticated;

select pg_temp.hider();
select set_config('test.e1', (public.play_card(pg_temp.gid(), current_setting('test.sculling')::uuid, pg_temp.uid(11), pg_temp.seq(),
  jsonb_build_object('media', jsonb_build_object('setup', pg_temp.path(current_setting('test.sculling'), 'v.mp4'))))) ->> 'effect_id', true);
reset role;
select is(
  (select array[photo_path, (proved_at is not null)::text] from public.drink_proofs
    where effect_id = current_setting('test.e1')::uuid and kind = 'setup'),
  array[pg_temp.path(current_setting('test.sculling'), 'v.mp4'), 'true'],
  'the hiders'' video proves the setup in the same call');
select is(
  array(select type from public.events where game_id = pg_temp.gid()
         and seq > (select seq from public.events where game_id = pg_temp.gid() and type = 'card_played' order by seq desc limit 1) - 1
         order by seq),
  array['card_played', 'proof_due', 'proof_due', 'drink_proved'],
  'card_played, then the proofs, then the video, in one go');
select is((select status from public.card_effects where id = current_setting('test.e1')::uuid), 'active',
  'the transport block runs from the start');
set local role authenticated;

-- ---------------------------------------------------------------- Bridge: the cost photo with the card

select pg_temp.hider();
select lives_ok(format($$ select public.play_card(pg_temp.gid(), %L, pg_temp.uid(20), pg_temp.seq(), %L) $$,
  current_setting('test.bridge'), jsonb_build_object('media', jsonb_build_object('cost', pg_temp.path(current_setting('test.bridge'), 'd.jpg')))),
  'Bridge cast with the drink photo');
reset role;
select is(
  (select array[d.team::text, d.kind, d.photo_path] from public.drink_proofs d
    where d.id = (select (payload ->> 'proof_id')::uuid from public.events
                   where game_id = pg_temp.gid() and type = 'drink_due' and payload ->> 'instance_id' = current_setting('test.bridge'))),
  array['hiders', 'drink', pg_temp.path(current_setting('test.bridge'), 'd.jpg')],
  'the cast cost is proved with it');
select is(
  (select array[payload ->> 'with_cast', visibility::text] from public.events
    where game_id = pg_temp.gid() and type = 'drink_proved' order by seq desc limit 1),
  array['true', 'all'], 'drink_proved says it came with the card');
set local role authenticated;

-- ---------------------------------------------------------------- Escape: Not applicable

select pg_temp.hider();
select set_config('test.e2', (public.play_card(pg_temp.gid(), current_setting('test.escape')::uuid, pg_temp.uid(30), pg_temp.seq())) ->> 'effect_id', true);
reset role;
select is(
  (select array[status, (ends_at > now() and ends_at < now() + interval '4 minutes')::text] from public.card_effects
    where id = current_setting('test.e2')::uuid),
  array['active', 'true'], 'Escape''s 3 minutes start at once');
set local role authenticated;

select pg_temp.seeker();
select lives_ok(format($$ select public.check_curse(pg_temp.gid(), %L, false, pg_temp.uid(31), pg_temp.seq()) $$, current_setting('test.e2')),
  'seekers say it doesn''t apply');
reset role;
select is(
  (select array[(select status from public.card_effects where id = current_setting('test.e2')::uuid),
                payload ->> 'not_applicable', payload ->> 'applies']
     from public.events where game_id = pg_temp.gid() and type = 'curse_checked' order by seq desc limit 1),
  array['cleared', 'true', 'false'], 'which cancels it');
set local role authenticated;

select pg_temp.seeker();
select throws_ok(format($$ select public.check_curse(pg_temp.gid(), %L, false, pg_temp.uid(32), pg_temp.seq()) $$, current_setting('test.e1')),
  'P0001', 'effect_not_awaiting', 'a curse without Not applicable can''t be cancelled that way');

select * from finish();
rollback;
