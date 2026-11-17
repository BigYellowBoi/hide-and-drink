-- Questions, stage 2: Matching, Measuring, Tentacles (with null answers), Photos and Bonus.
--
-- Builds on 20261127090000_questions.sql: same actions and signatures, now accepting the
-- other five types. Radar and thermometer are unchanged (copied as they were).
--
-- * Map questions (matching, measuring, tentacles) take p_params.center, the asking
--   seeker's [lon, lat]. The server works out the seekers' side from the city pack and
--   stores it in params, so every phone sees the same thing:
--     matching:  their nearest feature of the option's layer (the containing one for areas)
--     measuring: the option's target point and their distance to it
--     tentacles: every feature of the layer within radius_m, nearest first (max 50)
-- * Photos and bonus take no position. Every new type's params carry the option label,
--   and the type's null_answer when it has one; bonus params carry the answer kind
--   (text, number, yes_no) and any count rule (auto-shading, data in question_types).
-- * Answers stay text:
--     matching same | different        measuring closer | further
--     tentacles <feature_id> | none    photos <storage path> | none
--     bonus: yes | no, a whole number 0-9999, or text (1-200 chars, trimmed)
--   "none" only where the question type has a null_answer.
-- * Photos: the hider uploads to the private Storage bucket question-photos at
--   <game_id>/<question_id>/<file>, allowed only while that photo question is pending, then
--   answers with the path (checked to exist). Every player of the game can read its photos.

-- ---------------------------------------------------------------------------
-- Content: measuring targets (the seed left them null) and the bars_50m count rule.
-- Only rows not yet edited in the app are touched.
-- ---------------------------------------------------------------------------

update public.question_types
   set options = '[{"id":"airport","label":"The Airport","point":[153.1175,-27.3842]},{"id":"star_casino","label":"The Star Casino","point":[153.0222,-27.4727]},{"id":"felons","label":"Felons Brewing Co","point":[153.036264,-27.462408]},{"id":"el_camino","label":"El Camino Southbank","point":[153.0236,-27.4789]},{"id":"gabba","label":"The Gabba","point":[153.0381,-27.4858]},{"id":"powerhouse","label":"The Powerhouse","point":[153.0532,-27.4683]}]'::jsonb,
       extra = (extra - 'todo') || '{"note":"Points are [lon, lat]. Felons is from the city pack; the rest are approximate, check them on the CBD walk test."}'::jsonb,
       updated_at = now()
 where city = 'brisbane' and type = 'measuring'
   and not exists (select 1 from jsonb_array_elements(options) o where jsonb_typeof(o -> 'point') = 'array');

update public.question_types
   set options = (select jsonb_agg(case when o ->> 'id' = 'bars_50m' and not o ? 'count'
                                        then o || '{"count":{"layer":"venues","within_m":50,"at_least":3}}'::jsonb
                                        else o end order by i)
                    from jsonb_array_elements(options) with ordinality as t(o, i)),
       extra = extra || '{"note":"Options with a count rule (layer, within_m, at_least) are auto-shaded from the city pack: the hider''s bar is a venue with at least at_least others of that layer within within_m."}'::jsonb,
       updated_at = now()
 where city = 'brisbane' and type = 'bonus';

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- The seekers' side of a map question, from the city pack (see top of file).
create function public._question_reference(p_city text, p_type text, p_option jsonb, p_pos extensions.geometry)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_ref jsonb;
  v_target extensions.geometry;
  v_radius numeric;
  v_here extensions.geography := p_pos::extensions.geography;
begin
  if p_type = 'matching' then
    select jsonb_build_object(
             'layer', f.layer, 'feature_id', f.feature_id, 'name', f.name,
             'feature_distance_m', round(extensions.st_distance(f.geom::extensions.geography, v_here)::numeric))
      into v_ref
      from public.map_features f
     where f.city = p_city and f.layer = p_option ->> 'source'
     order by extensions.st_distance(f.geom::extensions.geography, v_here), f.feature_id
     limit 1;
    if v_ref is null then
      raise exception 'no_map_data' using errcode = 'P0001';
    end if;
    return v_ref;
  end if;

  if p_type = 'measuring' then
    if jsonb_typeof(p_option -> 'point') is distinct from 'array' then
      raise exception 'option_not_configured' using errcode = 'P0001';
    end if;
    v_target := public._lonlat(p_option -> 'point');
    return jsonb_build_object(
      'target', public._lonlat_json(v_target),
      'distance_m', round(extensions.st_distance(v_target::extensions.geography, v_here)::numeric));
  end if;

  if p_type = 'tentacles' then
    if jsonb_typeof(p_option -> 'radius_m') is distinct from 'number' or (p_option ->> 'radius_m')::numeric <= 0 then
      raise exception 'option_not_configured' using errcode = 'P0001';
    end if;
    v_radius := (p_option ->> 'radius_m')::numeric;
    if not exists (select 1 from public.map_features where city = p_city and layer = p_option ->> 'source') then
      raise exception 'no_map_data' using errcode = 'P0001';
    end if;
    select jsonb_build_object(
             'layer', p_option ->> 'source',
             'radius_m', v_radius,
             'candidates', coalesce(jsonb_agg(c.item order by c.d, c.fid), '[]'::jsonb))
      into v_ref
      from (
        select f.feature_id as fid,
               extensions.st_distance(f.geom::extensions.geography, v_here) as d,
               jsonb_build_object(
                 'feature_id', f.feature_id,
                 'name', f.name,
                 'point', public._lonlat_json(extensions.st_pointonsurface(f.geom)),
                 'distance_m', round(extensions.st_distance(f.geom::extensions.geography, v_here)::numeric)
               ) as item
          from public.map_features f
         where f.city = p_city and f.layer = p_option ->> 'source'
           and extensions.st_dwithin(f.geom::extensions.geography, v_here, v_radius::float8)
         order by 2, 1
         limit 50
      ) c;
    return v_ref;
  end if;

  return '{}'::jsonb;
end;
$$;

-- Normalised answer text for a question, or invalid_answer (see top of file).
create function public._check_answer(p_question public.questions, p_answer text)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_a text := btrim(coalesce(p_answer, ''));
  v_kind text := coalesce(p_question.params ->> 'answer_kind', 'text');
begin
  if v_a = 'none' and p_question.params ? 'null_answer' then
    return 'none';
  end if;
  case p_question.type
    when 'radar' then
      if v_a in ('yes', 'no') then return v_a; end if;
    when 'thermometer' then
      if v_a in ('hotter', 'colder') then return v_a; end if;
    when 'matching' then
      if v_a in ('same', 'different') then return v_a; end if;
    when 'measuring' then
      if v_a in ('closer', 'further') then return v_a; end if;
    when 'tentacles' then
      if exists (select 1 from jsonb_array_elements(p_question.params -> 'candidates') c where c ->> 'feature_id' = v_a) then
        return v_a;
      end if;
    when 'photos' then
      if starts_with(v_a, p_question.game_id::text || '/' || p_question.id::text || '/') then
        if exists (select 1 from storage.objects o where o.bucket_id = 'question-photos' and o.name = v_a) then
          return v_a;
        end if;
        raise exception 'photo_not_uploaded' using errcode = 'P0001';
      end if;
    when 'bonus' then
      if v_kind = 'yes_no' and v_a in ('yes', 'no') then return v_a; end if;
      if v_kind = 'number' and v_a ~ '^[0-9]{1,4}$' then return (v_a::integer)::text; end if;
      if v_kind = 'text' and char_length(v_a) between 1 and 200 and v_a <> 'none' then return v_a; end if;
    else
      null;
  end case;
  raise exception 'invalid_answer' using errcode = 'P0001';
end;
$$;

-- ---------------------------------------------------------------------------
-- Actions (replacing stage 1's; radar and thermometer as before)
-- ---------------------------------------------------------------------------

create or replace function public.ask_question(
  p_game_id uuid,
  p_type text,
  p_option_id text,
  p_params jsonb,
  p_client_action_id uuid,
  p_last_seen_seq bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public._require_user();
  v_prev jsonb := public._previous_result(p_client_action_id, v_uid);
  v_game public.games;
  v_qt public.question_types;
  v_option jsonb;
  v_params jsonb;
  v_distance numeric;
  v_start extensions.geometry;
  v_end extensions.geometry;
  v_center extensions.geometry;
  v_travelled double precision;
  v_deadline_s integer;
  v_q public.questions;
  v_seq bigint;
begin
  if v_prev is not null then
    return v_prev;
  end if;

  v_game := public._lock_game(p_game_id);
  perform public._require_team(p_game_id, v_uid, 'seekers');
  if v_game.status not in ('hiding', 'seeking') then
    raise exception 'round_not_running' using errcode = 'P0001';
  end if;
  if now() < v_game.round_started_at + make_interval(secs => v_game.hiding_period_s) then
    raise exception 'still_hiding' using errcode = 'P0001';
  end if;
  perform public._require_fresh(p_game_id, v_uid, p_last_seen_seq);
  perform public._settle_timers(p_game_id);

  if exists (select 1 from public.questions where game_id = p_game_id and answered_at is null) then
    raise exception 'question_pending' using errcode = 'P0001';
  end if;

  select * into v_qt from public.question_types where city = v_game.city and type = p_type;
  if not found then
    raise exception 'question_type_not_found' using errcode = 'P0001';
  end if;
  if p_type not in ('radar', 'thermometer', 'matching', 'measuring', 'tentacles', 'photos', 'bonus') then
    raise exception 'question_type_not_supported' using errcode = 'P0001';
  end if;
  select o into v_option from jsonb_array_elements(v_qt.options) o where o ->> 'id' = p_option_id;
  if v_option is null then
    raise exception 'option_not_found' using errcode = 'P0001';
  end if;
  if p_params is null or jsonb_typeof(p_params) <> 'object' then
    raise exception 'invalid_params' using errcode = 'P0001';
  end if;

  if p_type in ('radar', 'thermometer') then
    -- Distance: the option's, or the seeker's own for a custom option.
    if jsonb_typeof(v_option -> 'distance_m') = 'number' then
      v_distance := (v_option ->> 'distance_m')::numeric;
    elsif jsonb_typeof(p_params -> 'distance_m') = 'number' then
      v_distance := round((p_params ->> 'distance_m')::numeric);
    end if;
    if v_distance is null or v_distance < 10 or v_distance > 100000 then
      raise exception 'invalid_distance' using errcode = 'P0001';
    end if;
  end if;

  if p_type = 'radar' then
    v_params := jsonb_build_object(
      'center', public._lonlat_json(public._lonlat(p_params -> 'center')),
      'distance_m', v_distance);
  elsif p_type = 'thermometer' then
    v_start := public._lonlat(p_params -> 'start');
    v_end := public._lonlat(p_params -> 'end');
    v_travelled := extensions.st_distance(v_start::extensions.geography, v_end::extensions.geography);
    if v_travelled < v_distance then
      raise exception 'not_far_enough' using errcode = 'P0001',
        detail = format('travelled %s m of %s m', round(v_travelled::numeric), v_distance);
    end if;
    v_params := jsonb_build_object(
      'start', public._lonlat_json(v_start),
      'end', public._lonlat_json(v_end),
      'distance_m', v_distance,
      'travelled_m', round(v_travelled::numeric));
  else
    v_params := jsonb_build_object('label', coalesce(v_option ->> 'label', v_option ->> 'id'));
    if v_qt.extra ? 'null_answer' then
      v_params := v_params || jsonb_build_object('null_answer', v_qt.extra -> 'null_answer');
    end if;
    if p_type in ('matching', 'measuring', 'tentacles') then
      v_center := public._lonlat(p_params -> 'center');
      if not exists (select 1 from public.city_packs c
                      where c.city = v_game.city and extensions.st_dwithin(c.extent, v_center, 0.05)) then
        raise exception 'position_outside_map' using errcode = 'P0001';
      end if;
      v_params := v_params || jsonb_build_object('center', public._lonlat_json(v_center))
        || public._question_reference(v_game.city, p_type, v_option, v_center);
    elsif p_type = 'bonus' then
      v_params := v_params || jsonb_build_object('answer_kind', coalesce(v_option ->> 'answer', 'text'));
      if v_option ? 'count' then
        v_params := v_params || jsonb_build_object('count', v_option -> 'count');
      end if;
    end if;
  end if;

  v_deadline_s := public._answer_deadline_s(v_game.config, p_type, v_qt.extra);

  insert into public.questions (game_id, round, type, option_id, params, asked_by, deadline_at)
  values (p_game_id, v_game.round, p_type, p_option_id, v_params, v_uid,
          now() + make_interval(secs => v_deadline_s))
  returning * into v_q;

  v_seq := public._append_event(p_game_id, 'question_asked', jsonb_build_object(
    'question_id', v_q.id,
    'round', v_q.round,
    'type', v_q.type,
    'option_id', v_q.option_id,
    'prompt', v_qt.prompt,
    'params', v_q.params,
    'asked_by', v_uid,
    'asked_at', v_q.asked_at,
    'deadline_at', v_q.deadline_at,
    'deadline_s', v_deadline_s,
    'reward', jsonb_build_object('draw', v_qt.reward_draw, 'pick', v_qt.reward_pick)
  ));

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq, 'question_id', v_q.id));
end;
$$;

create or replace function public.answer_question(
  p_game_id uuid,
  p_question_id uuid,
  p_answer text,
  p_client_action_id uuid,
  p_last_seen_seq bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public._require_user();
  v_prev jsonb := public._previous_result(p_client_action_id, v_uid);
  v_game public.games;
  v_q public.questions;
  v_answer text;
  v_late boolean;
  v_seq bigint;
begin
  if v_prev is not null then
    return v_prev;
  end if;

  v_game := public._lock_game(p_game_id);
  perform public._require_team(p_game_id, v_uid, 'hiders');
  perform public._require_fresh(p_game_id, v_uid, p_last_seen_seq);
  -- A missed deadline is logged before the (late) answer, so the log reads in order.
  perform public._settle_timers(p_game_id);

  select * into v_q from public.questions where id = p_question_id and game_id = p_game_id for update;
  if not found or v_q.answered_at is not null then
    raise exception 'question_not_pending' using errcode = 'P0001';
  end if;
  v_answer := public._check_answer(v_q, p_answer);

  v_late := now() > v_q.deadline_at;
  update public.questions
     set answer = v_answer, answered_by = v_uid, answered_at = now(), late = v_late
   where id = v_q.id;

  v_seq := public._append_event(p_game_id, 'question_answered', jsonb_build_object(
    'question_id', v_q.id,
    'type', v_q.type,
    'answer', v_answer,
    'answered_by', v_uid,
    'answered_at', now(),
    'late', v_late
  ));

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq, 'late', v_late));
end;
$$;

-- ---------------------------------------------------------------------------
-- Photo storage
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('question-photos', 'question-photos', false, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

-- Object names are <game_id>/<question_id>/<file>.<jpg|jpeg|png|webp>; anything else: nulls.
create function public._photo_path_ids(p_name text, out game_id uuid, out question_id uuid)
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9_-]{1,64}\.(jpg|jpeg|png|webp)$' then
    return;
  end if;
  game_id := split_part(p_name, '/', 1)::uuid;
  question_id := split_part(p_name, '/', 2)::uuid;
end;
$$;

-- Upload: a hider of the game, while that photo question is pending.
create function public.can_upload_question_photo(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public._photo_path_ids(p_name) ids
    join public.questions q on q.id = ids.question_id and q.game_id = ids.game_id
    join public.players p on p.game_id = q.game_id and p.user_id = (select auth.uid())
    where q.type = 'photos' and q.answered_at is null and p.team = 'hiders'
  );
$$;

-- Read: any player of the game (photos are for both teams).
create function public.can_read_question_photo(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public._photo_path_ids(p_name) ids where public.is_player(ids.game_id));
$$;

create policy "hiders upload photos for a pending photo question" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'question-photos' and public.can_upload_question_photo(name));

create policy "players read their game's photos" on storage.objects
  for select to authenticated
  using (bucket_id = 'question-photos' and public.can_read_question_photo(name));

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke execute on function
  public._question_reference(text, text, jsonb, extensions.geometry),
  public._check_answer(public.questions, text),
  public._photo_path_ids(text),
  public.can_upload_question_photo(text),
  public.can_read_question_photo(text),
  public.ask_question(uuid, text, text, jsonb, uuid, bigint),
  public.answer_question(uuid, uuid, text, uuid, bigint)
from public, anon, authenticated;

grant execute on function
  public.ask_question(uuid, text, text, jsonb, uuid, bigint),
  public.answer_question(uuid, uuid, text, uuid, bigint)
to authenticated;

-- Storage policies call these as the uploading/reading user.
grant execute on function
  public.can_upload_question_photo(text),
  public.can_read_question_photo(text)
to authenticated;
