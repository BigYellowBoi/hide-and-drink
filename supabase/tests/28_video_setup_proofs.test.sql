-- Video and setup proofs (20261218090000_video_and_setup_proofs.sql): a curse with
-- params.hider_proof opens a proof for the hiders first, the seekers can't clear it until it
-- is in, a rejection reopens only the seekers' evidence, video proofs are collected, and
-- drink_proved alerts the other team.
-- Players: H = host (seeker), A = hider, S = seeker. Cards are put in the hand directly.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(17);

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
create function pg_temp.radar(n int, p_option text, p_params jsonb default '{"center":[153.025,-27.47]}')
returns uuid language plpgsql as $$
begin
  perform pg_temp.seeker();
  return (public.ask_question(pg_temp.gid(), 'radar', p_option, p_params, pg_temp.uid(n), pg_temp.seq())
    ->> 'question_id')::uuid;
end;
$$;
create function pg_temp.answer(q uuid, n int) returns void language plpgsql as $$
begin
  perform pg_temp.hider();
  perform public.answer_question(pg_temp.gid(), q, 'yes', pg_temp.uid(n), pg_temp.seq());
end;
$$;
create function pg_temp.to_hand(p_card text) returns uuid language sql as $$
  update public.card_instances set location = 'hand'
   where id = (select id from public.card_instances
                where game_id = pg_temp.gid() and card_id = p_card and location in ('pile', 'drawn')
                order by pile_pos limit 1)
  returning id;
$$;
create function pg_temp.play(p uuid, n int) returns jsonb language plpgsql as $$
begin
  perform pg_temp.hider();
  return public.play_card(pg_temp.gid(), p, pg_temp.uid(n), pg_temp.seq());
end;
$$;
create function pg_temp.last_event(p_type text) returns public.events language sql security definer as $$
  select * from public.events where game_id = pg_temp.gid() and type = p_type order by seq desc limit 1;
$$;
grant execute on all functions in schema pg_temp to authenticated;

-- ---------------------------------------------------------------- setup

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
set local role authenticated;
select set_config('test.game_id',
  public.create_game('Host', pg_temp.uid(1), 'brisbane', '{"hiding_period_s":1800,"hand_limit":6,
    "deck":{"unguided_tourist":1,"bird_guide":1,"bonus_red":10}}'::jsonb) ->> 'game_id', true);
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
select set_config('test.tourist', pg_temp.to_hand('unguided_tourist')::text, true);
select set_config('test.bird', pg_temp.to_hand('bird_guide')::text, true);
select is((select params ->> 'hider_proof' from public.cards where id = 'unguided_tourist'), 'photo',
  'Unguided Tourist: the hiders send a photo first');
select is((select params ->> 'hider_proof' from public.cards where id = 'bird_guide'), 'video',
  'Bird Guide: the hiders send a video first');
select is((select file_size_limit from storage.buckets where id = 'drink-photos'), 52428800::bigint,
  'drink-photos takes files up to 50 MB');
select ok((select 'video/mp4' = any (allowed_mime_types) from storage.buckets where id = 'drink-photos'),
  'and videos');
set local role authenticated;

-- ---------------------------------------------------------------- setup proof

select set_config('test.e1', pg_temp.play(current_setting('test.tourist')::uuid, 10) ->> 'effect_id', true);
reset role;
select is(
  array(select kind || ':' || team from public.drink_proofs where effect_id = current_setting('test.e1')::uuid order by kind),
  array['evidence:seekers', 'setup:hiders'],
  'the curse opens the hiders'' setup proof and the seekers'' evidence');
select set_config('test.setup',
  (select id::text from public.drink_proofs where effect_id = current_setting('test.e1')::uuid and kind = 'setup'), true);
select set_config('test.evidence',
  (select id::text from public.drink_proofs where effect_id = current_setting('test.e1')::uuid and kind = 'evidence'), true);
select is(
  (select array[payload ->> 'team', payload ->> 'kind', payload ->> 'media', visibility::text]
     from public.events where game_id = pg_temp.gid() and type = 'proof_due' order by seq limit 1),
  array['hiders', 'setup', 'photo', 'all'],
  'proof_due for the setup goes to everyone, hiders first');
insert into storage.objects (bucket_id, name)
values ('drink-photos', pg_temp.gid() || '/' || current_setting('test.evidence') || '/e.jpg'),
       ('drink-photos', pg_temp.gid() || '/' || current_setting('test.setup') || '/s.png');
set local role authenticated;

select pg_temp.seeker();
select lives_ok(format($$ select public.submit_drink_proof(pg_temp.gid(), %L, %L, pg_temp.uid(11), pg_temp.seq()) $$,
  current_setting('test.evidence'), pg_temp.gid() || '/' || current_setting('test.evidence') || '/e.jpg'),
  'seekers send their photo');
select throws_ok(format($$ select public.clear_effect(pg_temp.gid(), %L, pg_temp.uid(12), pg_temp.seq()) $$, current_setting('test.e1')),
  'P0001', 'proof_needed', 'seekers can''t say they did it before the hiders sent theirs');
select throws_ok(format($$ select public.submit_drink_proof(pg_temp.gid(), %L, %L, pg_temp.uid(13), pg_temp.seq()) $$,
  current_setting('test.setup'), pg_temp.gid() || '/' || current_setting('test.setup') || '/s.png'),
  'P0001', 'hiders_only', 'only the hiders send the setup');
select pg_temp.hider();
select lives_ok(format($$ select public.submit_drink_proof(pg_temp.gid(), %L, %L, pg_temp.uid(14), pg_temp.seq()) $$,
  current_setting('test.setup'), pg_temp.gid() || '/' || current_setting('test.setup') || '/s.png'),
  'the hiders send the screenshot');
reset role;
select is(
  (select array[payload ->> 'kind', payload ->> 'label', payload ->> 'team']
     from public.events where game_id = pg_temp.gid() and type = 'drink_proved' order by seq desc limit 1),
  array['setup', 'Curse of Unguided Tourist', 'hiders'],
  'drink_proved carries kind and label');
select is(
  (select array[audience::text, title] from public.push_outbox where game_id = pg_temp.gid() order by id desc limit 1),
  array['seekers', 'Hiders sent the Curse of Unguided Tourist proof'],
  'and alerts the seekers');
set local role authenticated;

select pg_temp.seeker();
select lives_ok(format($$ select public.clear_effect(pg_temp.gid(), %L, pg_temp.uid(15), pg_temp.seq()) $$, current_setting('test.e1')),
  'then the seekers can say they did it');
select pg_temp.hider();
select public.confirm_clear(pg_temp.gid(), current_setting('test.e1')::uuid, false, pg_temp.uid(16), pg_temp.seq());
reset role;
select is(
  array(select kind || ':' || (photo_path is not null)::text from public.drink_proofs
         where effect_id = current_setting('test.e1')::uuid order by kind),
  array['evidence:false', 'setup:true'],
  'a rejection reopens only the seekers'' evidence');
set local role authenticated;

-- ---------------------------------------------------------------- video

select set_config('test.e2', pg_temp.play(current_setting('test.bird')::uuid, 20) ->> 'effect_id', true);
reset role;
select is(
  array(select kind || ':' || team from public.drink_proofs where effect_id = current_setting('test.e2')::uuid order by kind),
  array['evidence:seekers', 'setup:hiders'],
  'a video curse opens both proofs too');
select set_config('test.vid',
  (select id::text from public.drink_proofs where effect_id = current_setting('test.e2')::uuid and kind = 'setup'), true);
insert into storage.objects (bucket_id, name)
values ('drink-photos', pg_temp.gid() || '/' || current_setting('test.vid') || '/v.mp4');
set local role authenticated;
select pg_temp.hider();
select lives_ok(format($$ select public.submit_drink_proof(pg_temp.gid(), %L, %L, pg_temp.uid(21), pg_temp.seq()) $$,
  current_setting('test.vid'), pg_temp.gid() || '/' || current_setting('test.vid') || '/v.mp4'),
  'the hiders send a video');
reset role;
select is((select (public._photo_path_ids(pg_temp.gid() || '/' || current_setting('test.vid') || '/v.mov')).game_id),
  pg_temp.gid(), 'video names are valid object paths');

select * from finish();
rollback;
