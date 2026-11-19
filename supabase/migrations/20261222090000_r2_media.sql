-- Media in Cloudflare R2 (docs/r2.md).
--
-- Photos and videos go to the R2 bucket untouched (no 48 MB squeeze), through two Edge
-- Functions: media-upload-url (checks, reserves room in the storage budget, presigned PUT)
-- and media-read-url (presigned GETs for media the caller's team may see). The functions
-- call the service-only functions below with the caller's user id, so every rule lives here
-- and is tested in pgTAP. Without the R2 secrets the app uploads to the Supabase buckets as
-- before; media already there keeps working.
--
-- * media_objects: one row per R2 object (game_id/folder/file, same names as the buckets).
--   Rows without uploaded_at are reservations: they count against the budget for 20 min.
-- * Budget: the Edge Function passes the cap (default 9 GB, under R2's free 10 GB). An upload
--   that would go past it goes to Supabase instead (shrunk, as before). Videos of cards with
--   params.video_quality = 'reduced' (Bird Guide: no people or drinks in it) stay original
--   only while the bucket is under the reduced share (default half); past that the phone
--   squeezes them to 480p first.
-- * Reading: a player reads a file if an event their team can see names it (drink_proved
--   path, a photo question's answer) or their team may upload it right now. The storage
--   policies of both Supabase buckets use the same rule, so seekers can no longer list a
--   hider-only file in the bucket either.

-- ---------------------------------------------------------------------------
-- Content: which videos stay full quality
-- ---------------------------------------------------------------------------

update public.cards set params = params || '{"video_quality": "reduced"}'::jsonb
 where id = 'bird_guide' and not params ? 'video_quality';

-- ---------------------------------------------------------------------------
-- R2 objects
-- ---------------------------------------------------------------------------

-- No foreign key to games: the bytes stay in R2 (and in the budget) even if a game row goes.
create table public.media_objects (
  name text primary key,
  game_id uuid not null,
  bucket text not null check (bucket in ('question-photos', 'drink-photos')),
  content_type text not null,
  bytes bigint not null check (bytes > 0),
  quality text not null check (quality in ('original', 'reduced', 'squeezed')),
  -- What the phone's file picker handed over: {bytes, type, name, user_agent, squeezed}.
  picked jsonb,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  uploaded_at timestamptz
);
create index media_objects_game_idx on public.media_objects (game_id);
alter table public.media_objects enable row level security;
revoke all on public.media_objects from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Upload and read rules, for a given user (the storage policies pass auth.uid())
-- ---------------------------------------------------------------------------

-- As can_upload_question_photo in 20261129090000_more_question_types.sql.
create function public._can_upload_question_photo(p_user uuid, p_name text)
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
    join public.players p on p.game_id = q.game_id and p.user_id = p_user
    where q.type = 'photos' and q.answered_at is null and p.team = 'hiders'
  );
$$;

-- As can_upload_drink_photo in 20261221090000_cast_media_escape_stations.sql.
create function public._can_upload_drink_photo(p_user uuid, p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public._photo_path_ids(p_name) ids
    join public.drink_proofs d on d.id = ids.question_id and d.game_id = ids.game_id
    join public.players p on p.game_id = d.game_id and p.user_id = p_user
    where d.proved_at is null and p.team = d.team
  ) or exists (
    select 1
    from public._photo_path_ids(p_name) ids
    join public.card_instances c on c.id = ids.question_id and c.game_id = ids.game_id
    join public.games g on g.id = c.game_id and g.round = c.round
    join public.players p on p.game_id = c.game_id and p.user_id = p_user
    where c.location = 'hand' and p.team = 'hiders' and g.status in ('hiding', 'seeking')
  );
$$;

-- Named by an event this user's team can see (as the events RLS policy, can_see).
create function public._media_announced(p_user uuid, p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public._photo_path_ids(p_name) ids
    join public.events e on e.game_id = ids.game_id
    join public.players p on p.game_id = e.game_id and p.user_id = p_user
    where (e.visibility = 'all' or p.team::text = e.visibility::text)
      and ((e.type = 'drink_proved' and e.payload ->> 'path' = p_name)
        or (e.type = 'question_answered' and e.payload ->> 'answer' = p_name))
  );
$$;

create function public._can_read_media(p_user uuid, p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user is not null and (
    public._media_announced(p_user, p_name)
    or public._can_upload_question_photo(p_user, p_name)
    or public._can_upload_drink_photo(p_user, p_name));
$$;

-- The Supabase bucket a name belongs to: question folders in question-photos, the rest
-- (drink proofs, cards in the hand) in drink-photos.
create function public._media_bucket(p_name text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when exists (select 1 from public._photo_path_ids(p_name) ids
                   join public.questions q on q.id = ids.question_id and q.game_id = ids.game_id)
      then 'question-photos'
    else 'drink-photos'
  end;
$$;

-- Uploaded to the Supabase bucket or to R2.
create function public._media_exists(p_bucket text, p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from storage.objects o where o.bucket_id = p_bucket and o.name = p_name)
      or exists (select 1 from public.media_objects m
                  where m.bucket = p_bucket and m.name = p_name and m.uploaded_at is not null);
$$;

-- Videos for a card with params.video_quality = 'reduced' (the proof's curse, or the card in
-- the hand the file is sent with).
create function public._media_reduced(p_game_id uuid, p_folder uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(bool_or(gc.params ->> 'video_quality' = 'reduced'), false)
    from (
      select ce.round, ce.card_id from public.drink_proofs d
        join public.card_effects ce on ce.id = d.effect_id
       where d.id = p_folder and d.game_id = p_game_id
      union all
      select c.round, c.card_id from public.card_instances c
       where c.id = p_folder and c.game_id = p_game_id
    ) f
    join public.game_cards gc on gc.game_id = p_game_id and gc.round = f.round and gc.card_id = f.card_id;
$$;

-- Storage policies: same rules as the R2 read URLs.
create or replace function public.can_upload_question_photo(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public._can_upload_question_photo((select auth.uid()), p_name);
$$;

create or replace function public.can_upload_drink_photo(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public._can_upload_drink_photo((select auth.uid()), p_name);
$$;

create or replace function public.can_read_question_photo(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public._can_read_media((select auth.uid()), p_name);
$$;

create or replace function public.can_read_drink_photo(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public._can_read_media((select auth.uid()), p_name);
$$;

-- ---------------------------------------------------------------------------
-- Service functions (Edge Functions only, with the caller's user id)
-- ---------------------------------------------------------------------------

-- Check an upload and reserve room for it. Returns
--   {store: 'r2', bucket, quality}     upload to R2 (the function presigns the PUT)
--   {squeeze: true, bucket}           a reduced-quality video: squeeze it, then ask again
--   {store: 'supabase', bucket, reason: 'storage_full'}  R2 is full: the old path
create function public.media_upload_grant(
  p_user uuid,
  p_name text,
  p_bytes bigint,
  p_content_type text,
  p_picked jsonb,
  p_budget bigint,
  p_reduced_share numeric,
  p_max_bytes bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game uuid;
  v_folder uuid;
  v_video boolean := p_name ~* '\.(mp4|mov|webm)$';
  v_bucket text;
  v_reduced boolean := false;
  v_squeezed boolean := coalesce(p_picked ->> 'squeezed', '') = 'true';
  v_used bigint;
  v_row public.media_objects;
begin
  select ids.game_id, ids.question_id into v_game, v_folder from public._photo_path_ids(p_name) ids;
  if v_game is null then
    raise exception 'invalid_media_path' using errcode = 'P0001';
  end if;
  if p_content_type is null or (v_video and p_content_type !~ '^video/') or (not v_video and p_content_type !~ '^image/') then
    raise exception 'invalid_media_type' using errcode = 'P0001';
  end if;
  if p_bytes is null or p_bytes <= 0 then
    raise exception 'invalid_media_size' using errcode = 'P0001';
  end if;
  if p_bytes > p_max_bytes then
    raise exception 'media_too_big' using errcode = 'P0001';
  end if;

  if public._can_upload_question_photo(p_user, p_name) then
    if v_video then
      raise exception 'invalid_media_type' using errcode = 'P0001';
    end if;
    v_bucket := 'question-photos';
  elsif public._can_upload_drink_photo(p_user, p_name) then
    v_bucket := 'drink-photos';
  else
    raise exception 'media_not_allowed' using errcode = 'P0001';
  end if;

  select * into v_row from public.media_objects where name = p_name;
  if found and (v_row.uploaded_at is not null or v_row.created_by <> p_user) then
    raise exception 'media_exists' using errcode = 'P0001';
  end if;

  v_reduced := v_video and public._media_reduced(v_game, v_folder);

  -- One reservation at a time, so two big uploads can't both squeeze into the last room.
  perform pg_advisory_xact_lock(hashtext('public.media_objects budget'));
  select coalesce(sum(m.bytes), 0) into v_used from public.media_objects m
   where m.name <> p_name and (m.uploaded_at is not null or m.created_at > now() - interval '20 minutes');

  if v_used + p_bytes > p_budget then
    delete from public.media_objects where name = p_name;
    return jsonb_build_object('store', 'supabase', 'bucket', v_bucket, 'reason', 'storage_full');
  end if;
  if v_reduced and not v_squeezed and v_used + p_bytes > p_budget * p_reduced_share then
    delete from public.media_objects where name = p_name;
    return jsonb_build_object('squeeze', true, 'bucket', v_bucket);
  end if;

  insert into public.media_objects (name, game_id, bucket, content_type, bytes, quality, picked, created_by)
  values (p_name, v_game, v_bucket, p_content_type, p_bytes,
          case when v_squeezed then 'squeezed' when v_reduced then 'reduced' else 'original' end,
          p_picked, p_user)
  on conflict (name) do update
     set content_type = excluded.content_type, bytes = excluded.bytes, quality = excluded.quality,
         picked = excluded.picked, created_at = now();

  return jsonb_build_object('store', 'r2', 'bucket', v_bucket,
    'quality', case when v_squeezed then 'squeezed' when v_reduced then 'reduced' else 'original' end);
end;
$$;

-- The object is in R2 with this many bytes (null: not there). p_user: the uploader confirming,
-- or null from the sweep of old reservations. Returns ok, missing (kept for a retry, or
-- dropped by the sweep), too_big (dropped: the function deletes the object) or unknown.
create function public.media_upload_done(p_user uuid, p_name text, p_bytes bigint)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.media_objects;
begin
  select * into v_row from public.media_objects where name = p_name for update;
  if not found then
    return 'unknown';
  end if;
  if p_user is not null and v_row.created_by <> p_user then
    raise exception 'media_not_allowed' using errcode = 'P0001';
  end if;
  if p_bytes is null then
    if p_user is null and v_row.uploaded_at is null then
      delete from public.media_objects where name = p_name;
    end if;
    return 'missing';
  end if;
  if p_bytes > v_row.bytes then
    delete from public.media_objects where name = p_name;
    return 'too_big';
  end if;
  update public.media_objects set bytes = p_bytes, uploaded_at = coalesce(uploaded_at, now()) where name = p_name;
  return 'ok';
end;
$$;

-- Reservations past their 20 minutes, for the sweep to check in R2.
create function public.media_stale_uploads(p_limit integer)
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select name from public.media_objects
   where uploaded_at is null and created_at < now() - interval '20 minutes'
   order by created_at limit greatest(p_limit, 0);
$$;

-- Of these names, the ones this user may see, and where each one is stored.
create function public.media_read_grant(p_user uuid, p_names text[])
returns table (name text, store text, bucket text)
language sql
stable
security definer
set search_path = ''
as $$
  select n.name,
         case when m.uploaded_at is not null then 'r2' else 'supabase' end,
         coalesce(case when m.uploaded_at is not null then m.bucket end, public._media_bucket(n.name))
    from (select distinct u as name from unnest(p_names[1:100]) u) n
    left join public.media_objects m on m.name = n.name
   where public._can_read_media(p_user, n.name);
$$;

-- ---------------------------------------------------------------------------
-- Actions: an upload in R2 counts as uploaded
-- ---------------------------------------------------------------------------

-- As in 20261129090000_more_question_types.sql, with _media_exists.
create or replace function public._check_answer(p_question public.questions, p_answer text)
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
        if public._media_exists('question-photos', v_a) then
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

-- As in 20261218090000_video_and_setup_proofs.sql, with _media_exists.
create or replace function public.submit_drink_proof(
  p_game_id uuid,
  p_proof_id uuid,
  p_path text,
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
  v_d public.drink_proofs;
  v_path text := btrim(coalesce(p_path, ''));
  v_seq bigint;
begin
  if v_prev is not null then
    return v_prev;
  end if;

  v_game := public._lock_game(p_game_id);
  select * into v_d from public.drink_proofs where id = p_proof_id and game_id = p_game_id for update;
  if not found or v_d.proved_at is not null then
    raise exception 'proof_not_pending' using errcode = 'P0001';
  end if;
  perform public._require_team(p_game_id, v_uid, v_d.team);
  perform public._require_fresh(p_game_id, v_uid, p_last_seen_seq);

  if not starts_with(v_path, p_game_id::text || '/' || v_d.id::text || '/')
     or not public._media_exists('drink-photos', v_path) then
    raise exception 'photo_not_uploaded' using errcode = 'P0001';
  end if;

  update public.drink_proofs set photo_path = v_path, proved_by = v_uid, proved_at = now() where id = v_d.id;

  v_seq := public._append_event(p_game_id, 'drink_proved', jsonb_build_object(
    'round', v_d.round, 'proof_id', v_d.id, 'team', v_d.team, 'path', v_path, 'by', v_uid,
    'kind', v_d.kind, 'label', v_d.label));

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq));
end;
$$;

-- As in 20261221090000_cast_media_escape_stations.sql, with _media_exists.
create or replace function public._prove_with_cast_media(p_game public.games, p_proof_id uuid, p_instance_id uuid, p_path text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_d public.drink_proofs;
  v_path text := btrim(coalesce(p_path, ''));
  v_visibility public.event_visibility;
begin
  select * into v_d from public.drink_proofs where id = p_proof_id for update;
  if not found or v_d.proved_at is not null then
    return;
  end if;
  if not starts_with(v_path, p_game.id::text || '/' || p_instance_id::text || '/')
     or public._photo_path_ids(v_path) is null
     or not public._media_exists('drink-photos', v_path) then
    raise exception 'photo_not_uploaded' using errcode = 'P0001';
  end if;
  -- As private as the proof's own announcement (a hiders-only drink_due stays hiders-only).
  select e.visibility into v_visibility from public.events e
   where e.game_id = p_game.id and e.type in ('drink_due', 'proof_due') and e.payload ->> 'proof_id' = v_d.id::text
   order by e.seq desc limit 1;

  update public.drink_proofs set photo_path = v_path, proved_by = auth.uid(), proved_at = now() where id = v_d.id;
  perform public._append_event(p_game.id, 'drink_proved', jsonb_build_object(
    'round', v_d.round, 'proof_id', v_d.id, 'team', v_d.team, 'path', v_path, 'by', auth.uid(),
    'kind', v_d.kind, 'label', v_d.label, 'with_cast', true), coalesce(v_visibility, 'all'));
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke execute on function
  public._can_upload_question_photo(uuid, text),
  public._can_upload_drink_photo(uuid, text),
  public._media_announced(uuid, text),
  public._can_read_media(uuid, text),
  public._media_bucket(text),
  public._media_exists(text, text),
  public._media_reduced(uuid, uuid),
  public.media_upload_grant(uuid, text, bigint, text, jsonb, bigint, numeric, bigint),
  public.media_upload_done(uuid, text, bigint),
  public.media_stale_uploads(integer),
  public.media_read_grant(uuid, text[])
from public, anon, authenticated;

grant execute on function
  public.media_upload_grant(uuid, text, bigint, text, jsonb, bigint, numeric, bigint),
  public.media_upload_done(uuid, text, bigint),
  public.media_stale_uploads(integer),
  public.media_read_grant(uuid, text[])
to service_role;
