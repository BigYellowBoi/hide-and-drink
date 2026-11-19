-- Replays, past games, admins and deleting games (docs/admin.md).
--
-- * position_track: every player's GPS during a round (seekers from report_position, hiders
--   from the new report_track), one point per player every few seconds. No client access at
--   all: hider GPS still never reaches a seeker while the game runs. Once the game has ended,
--   get_replay hands it, with every event (hider-only ones included), to any player of the
--   game and to admins.
-- * Media of an ended game is readable by all its players (and admins): _can_read_media.
-- * Admins: a user who entered the admin PIN (Edge Function admin-pin, secret ADMIN_PIN,
--   5 tries per user and 20 wrong ones overall per 15 min). No client writes.
-- * list_past_games: ended games the caller played (admins: every ended game), newest first.
-- * delete_game (host or admin, ended games only): refuses media_left until the Edge Function
--   delete-game has removed the game's media from R2 and the Supabase buckets; then deletes
--   the game row, and players, events and the track cascade.
-- * media_usage: bytes in R2, for the storage meter on Home.

-- ---------------------------------------------------------------------------
-- Position track
-- ---------------------------------------------------------------------------

create table public.position_track (
  id bigint generated always as identity primary key,
  game_id uuid not null references public.games (id) on delete cascade,
  user_id uuid not null,
  round integer not null,
  team public.team not null,
  lng double precision not null,
  lat double precision not null,
  accuracy_m real,
  recorded_at timestamptz not null default now()
);
create index position_track_game_idx on public.position_track (game_id, user_id, recorded_at);
alter table public.position_track enable row level security;
revoke all on public.position_track from public, anon, authenticated;

-- At most one point per player every 2 s (phones send one every seeker_location_interval_s).
create function public._track_position(
  p_game public.games,
  p_user uuid,
  p_lng double precision,
  p_lat double precision,
  p_accuracy_m real
)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_team public.team;
  v_last public.position_track;
begin
  if p_game.status not in ('hiding', 'seeking') then
    return false;
  end if;
  select team into v_team from public.players where game_id = p_game.id and user_id = p_user;
  if v_team is null then
    return false;
  end if;
  select * into v_last from public.position_track
   where game_id = p_game.id and user_id = p_user order by recorded_at desc, id desc limit 1;
  if found and v_last.recorded_at > now() - interval '2 seconds' then
    return false;
  end if;
  insert into public.position_track (game_id, user_id, round, team, lng, lat, accuracy_m)
  values (p_game.id, p_user, p_game.round, v_team, p_lng, p_lat, p_accuracy_m);
  return true;
end;
$$;

create function public._check_position(p_lng double precision, p_lat double precision, p_accuracy_m real)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_lng is null or p_lat is null or p_lng = 'NaN' or p_lat = 'NaN'
     or p_lng not between -180 and 180 or p_lat not between -90 and 90
     or (p_accuracy_m is not null and (p_accuracy_m = 'NaN' or p_accuracy_m < 0)) then
    raise exception 'invalid_position' using errcode = 'P0001';
  end if;
end;
$$;

-- As in 20261128090000_hider_sees_seekers_leave_game.sql, plus the track.
create or replace function public.report_position(
  p_game_id uuid,
  p_lng double precision,
  p_lat double precision,
  p_accuracy_m real default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public._require_user();
  v_game public.games;
  v_msg jsonb;
begin
  perform public._check_position(p_lng, p_lat, p_accuracy_m);

  -- Serialise with actions on this game, so the freeze check sees every earlier report.
  v_game := public._lock_game(p_game_id);

  if not exists (select 1 from public.players where game_id = p_game_id and user_id = v_uid and team = 'seekers') then
    raise exception 'seekers_only' using errcode = 'P0001';
  end if;
  if v_game.status not in ('hiding', 'seeking') then
    raise exception 'round_not_running' using errcode = 'P0001';
  end if;

  insert into public.seeker_positions (game_id, user_id, round, lng, lat, accuracy_m, reported_at)
  values (p_game_id, v_uid, v_game.round, p_lng, p_lat, p_accuracy_m, now())
  on conflict (game_id, user_id) do update set
    round = excluded.round, lng = excluded.lng, lat = excluded.lat,
    accuracy_m = excluded.accuracy_m, reported_at = excluded.reported_at;
  perform public._track_position(v_game, v_uid, p_lng, p_lat, p_accuracy_m);

  -- Both teams, on their team topics (never the shared topic: players without a team don't
  -- need it). Not an event: no seq, nothing in the log.
  v_msg := jsonb_build_object('game_id', p_game_id, 'user_id', v_uid, 'round', v_game.round,
    'lng', p_lng, 'lat', p_lat, 'accuracy_m', p_accuracy_m, 'at', now());
  perform realtime.send(v_msg, 'position', public.topic_for(p_game_id, 'seekers'), true);
  perform realtime.send(v_msg, 'position', public.topic_for(p_game_id, 'hiders'), true);

  perform public._update_freeze(v_game);

  return jsonb_build_object('ok', true, 'at', now());
end;
$$;

-- Hiders (or any player on a team): record this phone's position for the replay. Not
-- broadcast, not an event, no client can read it back until the game has ended.
create function public.report_track(
  p_game_id uuid,
  p_lng double precision,
  p_lat double precision,
  p_accuracy_m real default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public._require_user();
  v_game public.games;
begin
  perform public._check_position(p_lng, p_lat, p_accuracy_m);
  select * into v_game from public.games where id = p_game_id;
  if not found or not exists (select 1 from public.players where game_id = p_game_id and user_id = v_uid) then
    raise exception 'not_a_player' using errcode = 'P0001';
  end if;
  if v_game.status not in ('hiding', 'seeking') then
    raise exception 'round_not_running' using errcode = 'P0001';
  end if;
  return jsonb_build_object('ok', true, 'recorded', public._track_position(v_game, v_uid, p_lng, p_lat, p_accuracy_m));
end;
$$;

-- ---------------------------------------------------------------------------
-- Admins
-- ---------------------------------------------------------------------------

create table public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;
revoke all on public.admins from public, anon, authenticated;

create table public.admin_pin_attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  ok boolean not null,
  at timestamptz not null default now()
);
create index admin_pin_attempts_at_idx on public.admin_pin_attempts (at);
alter table public.admin_pin_attempts enable row level security;
revoke all on public.admin_pin_attempts from public, anon, authenticated;

create function public._is_admin(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user is not null and exists (select 1 from public.admins where user_id = p_user);
$$;

-- This phone's user is an admin (Settings).
create function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public._is_admin((select auth.uid()));
$$;

-- The Edge Function admin-pin checked a PIN for this user (p_ok: it matched). Rate limited
-- before anything else: 5 tries per user and 20 wrong ones overall in 15 min (anonymous
-- users are free to make, so the overall cap is what stops guessing). Returns ok, wrong_pin
-- or rate_limited.
create function public.admin_pin_attempt(p_user uuid, p_ok boolean)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user is null then
    raise exception 'not_signed_in' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtext('public.admin_pin_attempts'));
  delete from public.admin_pin_attempts where at < now() - interval '1 day';
  if (select count(*) from public.admin_pin_attempts where user_id = p_user and at > now() - interval '15 minutes') >= 5
     or (select count(*) from public.admin_pin_attempts where not ok and at > now() - interval '15 minutes') >= 20 then
    return 'rate_limited';
  end if;
  insert into public.admin_pin_attempts (user_id, ok) values (p_user, coalesce(p_ok, false));
  if not coalesce(p_ok, false) then
    return 'wrong_pin';
  end if;
  insert into public.admins (user_id) values (p_user) on conflict do nothing;
  return 'ok';
end;
$$;

-- ---------------------------------------------------------------------------
-- Ended games: who may look, and their media
-- ---------------------------------------------------------------------------

-- A player of the game, or an admin, once the game has ended.
create function public._can_view_ended(p_user uuid, p_game_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user is not null
     and exists (select 1 from public.games where id = p_game_id and status = 'ended')
     and (public._is_admin(p_user)
          or exists (select 1 from public.players where game_id = p_game_id and user_id = p_user));
$$;

-- As in 20261222090000_r2_media.sql, plus: everything of an ended game, for its players and admins.
create or replace function public._can_read_media(p_user uuid, p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user is not null and (
    public._media_announced(p_user, p_name)
    or public._can_upload_question_photo(p_user, p_name)
    or public._can_upload_drink_photo(p_user, p_name)
    or exists (select 1 from public._photo_path_ids(p_name) ids
                where public._can_view_ended(p_user, ids.game_id)));
$$;

-- Every media file of a game: R2 objects (reservations too, for deleting) and files in the
-- Supabase buckets.
create function public._game_media(p_game_id uuid, p_uploaded_only boolean)
returns table (name text, store text, bucket text, bytes bigint, content_type text)
language sql
stable
security definer
set search_path = ''
as $$
  select m.name, 'r2', m.bucket, m.bytes, m.content_type
    from public.media_objects m
   where m.game_id = p_game_id and (m.uploaded_at is not null or not p_uploaded_only)
  union all
  select o.name, 'supabase', o.bucket_id,
         case when o.metadata ->> 'size' ~ '^[0-9]+$' then (o.metadata ->> 'size')::bigint end,
         o.metadata ->> 'mimetype'
    from storage.objects o
   where o.bucket_id in ('question-photos', 'drink-photos')
     and starts_with(o.name, p_game_id::text || '/');
$$;

-- ---------------------------------------------------------------------------
-- Replay and past games
-- ---------------------------------------------------------------------------

-- Everything about an ended game: every event in order (both teams'), each player's track
-- and the media list. Players of the game and admins only.
create function public.get_replay(p_game_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public._require_user();
  v_game public.games;
begin
  select * into v_game from public.games where id = p_game_id;
  if not found then
    raise exception 'game_not_found' using errcode = 'P0001';
  end if;
  if not public._is_admin(v_uid)
     and not exists (select 1 from public.players where game_id = p_game_id and user_id = v_uid) then
    raise exception 'not_a_player' using errcode = 'P0001';
  end if;
  if v_game.status <> 'ended' then
    raise exception 'game_not_ended' using errcode = 'P0001';
  end if;

  return jsonb_build_object(
    'game', jsonb_build_object(
      'id', v_game.id,
      'code', v_game.code,
      'city', v_game.city,
      'host_id', v_game.host_id,
      'created_at', public._iso(v_game.created_at),
      'ended_at', public._iso((select max(e.created_at) from public.events e
                                where e.game_id = p_game_id and e.type = 'game_ended'))),
    'can_delete', v_game.host_id = v_uid or public._is_admin(v_uid),
    'players', coalesce((select jsonb_agg(jsonb_build_object('user_id', p.user_id, 'name', p.name, 'team', p.team,
                                  'is_host', p.is_host) order by p.joined_at)
                           from public.players p where p.game_id = p_game_id), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object(
                                  'game_id', e.game_id, 'seq', e.seq, 'type', e.type, 'visibility', e.visibility,
                                  'actor_id', e.actor_id, 'payload', e.payload, 'created_at', public._iso(e.created_at))
                                  order by e.seq)
                          from public.events e where e.game_id = p_game_id), '[]'::jsonb),
    'track', coalesce((select jsonb_agg(jsonb_build_object(
                                 'user_id', t.user_id, 'round', t.round, 'team', t.team, 'lng', t.lng, 'lat', t.lat,
                                 'accuracy_m', t.accuracy_m, 'at', public._iso(t.recorded_at))
                                 order by t.recorded_at, t.id)
                         from public.position_track t where t.game_id = p_game_id), '[]'::jsonb),
    'media', coalesce((select jsonb_agg(jsonb_build_object('name', m.name, 'store', m.store, 'bucket', m.bucket,
                                 'bytes', m.bytes, 'content_type', m.content_type) order by m.name)
                         from public._game_media(p_game_id, true) m), '[]'::jsonb));
end;
$$;

-- Ended games the caller played in (admins: all of them), newest first, for Home. Lobbies
-- that were ended without starting are left out.
create function public.list_past_games()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with me as (
    select (select auth.uid()) as uid, public._is_admin((select auth.uid())) as admin
  ),
  g as (
    select g.*, ge.payload as result, ge.created_at as ended_at
      from public.games g
      cross join me
      left join lateral (
        select e.payload, e.created_at from public.events e
         where e.game_id = g.id and e.type = 'game_ended' order by e.seq desc limit 1
      ) ge on true
     where g.status = 'ended'
       and me.uid is not null
       and (me.admin or exists (select 1 from public.players p where p.game_id = g.id and p.user_id = me.uid))
       and exists (select 1 from public.events e where e.game_id = g.id and e.type = 'game_started')
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', g.id,
      'city', g.city,
      'started_at', public._iso((select min(e.created_at) from public.events e
                                  where e.game_id = g.id and e.type = 'game_started')),
      'ended_at', public._iso(coalesce(g.ended_at, g.updated_at)),
      'play_area', coalesce(
        (select pa.name from public.play_areas pa where pa.id = g.play_area_id),
        (select e.payload ->> 'name' from public.events e
          where e.game_id = g.id and e.type = 'play_area_changed' order by e.seq desc limit 1)),
      'players', coalesce((select jsonb_agg(jsonb_build_object('user_id', p.user_id, 'name', p.name, 'team', p.team)
                                             order by p.joined_at)
                             from public.players p where p.game_id = g.id), '[]'::jsonb),
      'rounds', coalesce(g.result -> 'rounds', '[]'::jsonb),
      'winners', coalesce(g.result -> 'winners', '[]'::jsonb),
      'totals', coalesce(g.result -> 'players', '[]'::jsonb),
      'mine', exists (select 1 from public.players p, me where p.game_id = g.id and p.user_id = me.uid),
      'can_delete', g.host_id = me.uid or me.admin)
    order by coalesce(g.ended_at, g.updated_at) desc), '[]'::jsonb)
  from g cross join me;
$$;

-- Bytes stored in R2, out of the free plan's 10 GB (Home's storage meter).
create function public.media_usage()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public._require_user();
  return jsonb_build_object(
    'r2_bytes', (select coalesce(sum(bytes), 0) from public.media_objects where uploaded_at is not null),
    'r2_free_bytes', 10000000000);
end;
$$;

-- ---------------------------------------------------------------------------
-- Deleting a game
-- ---------------------------------------------------------------------------

create function public._require_can_delete(p_user uuid, p_game public.games)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_game.host_id <> p_user and not public._is_admin(p_user) then
    raise exception 'host_or_admin_only' using errcode = 'P0001';
  end if;
  if p_game.status <> 'ended' then
    raise exception 'game_not_ended' using errcode = 'P0001';
  end if;
end;
$$;

-- Edge Function delete-game: the media to remove before delete_game, if this user may delete
-- the game.
create function public.game_delete_media(p_user uuid, p_game_id uuid)
returns table (name text, store text, bucket text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_game public.games;
begin
  select * into v_game from public.games where id = p_game_id;
  if not found then
    raise exception 'game_not_found' using errcode = 'P0001';
  end if;
  perform public._require_can_delete(p_user, v_game);
  return query select m.name, m.store, m.bucket from public._game_media(p_game_id, false) m;
end;
$$;

-- Edge Function delete-game: these R2 objects are gone.
create function public.media_forget(p_game_id uuid, p_names text[])
returns integer
language sql
security definer
set search_path = ''
as $$
  with d as (delete from public.media_objects where game_id = p_game_id and name = any (p_names) returning 1)
  select count(*)::integer from d;
$$;

-- The host or an admin deletes an ended game for everyone, once its media is gone (the Edge
-- Function delete-game removes it first, then calls this as the user). Players, events, the
-- track and every other row of the game cascade.
create function public.delete_game(p_game_id uuid, p_client_action_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public._require_user();
  v_prev jsonb := public._previous_result(p_client_action_id, v_uid);
  v_game public.games;
begin
  if v_prev is not null then
    return v_prev;
  end if;

  v_game := public._lock_game(p_game_id);
  perform public._require_can_delete(v_uid, v_game);
  if exists (select 1 from public._game_media(p_game_id, false)) then
    raise exception 'media_left' using errcode = 'P0001';
  end if;

  delete from public.games where id = p_game_id;
  -- Stored without a game id: processed_actions cascades with the game.
  return public._record_result(p_client_action_id, v_uid, null,
    jsonb_build_object('game_id', p_game_id, 'deleted', true));
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke execute on function
  public._track_position(public.games, uuid, double precision, double precision, real),
  public._check_position(double precision, double precision, real),
  public.report_position(uuid, double precision, double precision, real),
  public.report_track(uuid, double precision, double precision, real),
  public._is_admin(uuid),
  public.is_admin(),
  public.admin_pin_attempt(uuid, boolean),
  public._can_view_ended(uuid, uuid),
  public._can_read_media(uuid, text),
  public._game_media(uuid, boolean),
  public.get_replay(uuid),
  public.list_past_games(),
  public.media_usage(),
  public._require_can_delete(uuid, public.games),
  public.game_delete_media(uuid, uuid),
  public.media_forget(uuid, text[]),
  public.delete_game(uuid, uuid)
from public, anon, authenticated;

grant execute on function
  public.report_position(uuid, double precision, double precision, real),
  public.report_track(uuid, double precision, double precision, real),
  public.is_admin(),
  public.get_replay(uuid),
  public.list_past_games(),
  public.media_usage(),
  public.delete_game(uuid, uuid)
to authenticated;

grant execute on function
  public.admin_pin_attempt(uuid, boolean),
  public.game_delete_media(uuid, uuid),
  public.media_forget(uuid, text[])
to service_role;
