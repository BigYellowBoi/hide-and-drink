-- Hiding period: the hider's bar, seekers' live positions and the hider-only freeze alert.
--
-- choose_bar (hiders only): lock in a bar for this round. Valid bars are venues in the city
--   pack inside the play area snapshot and, if the config's station zone is enabled, within its
--   radius of a station. One choice per round, irreversible. Writes hider_bars (no client
--   access) and a hider-only bar_chosen event. Allowed after the hiding period ends too, so a
--   late hider can't soft-lock the round (the event says late).
--
-- report_position (seekers only): the seeker's GPS, every ~20 s (config seeker_location_interval_s).
--   Ephemeral and latest-wins: upserts seeker_positions and broadcasts a 'position' message on
--   game:<id>:seekers only. Never in the event log, so it takes no client_action_id or
--   last_seen_seq (a retry or a stale view is harmless; a dropped report is replaced by the next).
--   The server then compares fresh seeker positions with the hider's bar and, when the answer
--   changes, appends a hider-only freeze_changed event with no actor (so it can't tell the hider
--   which seeker is close). Hider GPS never reaches the server.
--
-- hiding_bars: ids of the venues choose_bar accepts for this game. Not secret (seekers know the
--   play area and config), so any player may call it; the hider's pick is never exposed.

-- ---------------------------------------------------------------------------
-- Config with defaults (data/config.json shape; metres and seconds)
-- ---------------------------------------------------------------------------

create function public._cfg_num(p_config jsonb, p_path text[], p_default numeric)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case when jsonb_typeof(p_config #> p_path) = 'number' and (p_config #>> p_path)::numeric > 0
              then (p_config #>> p_path)::numeric else p_default end;
$$;

-- Venues choose_bar accepts in this game: inside the play area snapshot (and station zone if on).
create function public._valid_bars(p_game public.games)
returns setof public.map_features
language plpgsql
stable
set search_path = ''
as $$
declare
  v_area extensions.geometry;
  v_zone jsonb := p_game.config #> '{hiding_zone,station_zone}';
  v_layer text;
  v_modes jsonb;
  v_radius numeric;
begin
  if p_game.play_area_snapshot is null then
    return;
  end if;
  -- Force the SRID: on some PostGIS versions the repaired union comes back with SRID 0.
  v_area := extensions.st_setsrid(public._play_area_geom(p_game.play_area_snapshot), 4326);

  if v_zone is null or jsonb_typeof(v_zone -> 'enabled') <> 'boolean' or not (v_zone ->> 'enabled')::boolean then
    return query
      select f.* from public.map_features f
       where f.city = p_game.city and f.layer = 'venues'
         and extensions.st_covers(v_area, f.geom);
    return;
  end if;

  v_layer := coalesce(nullif(v_zone ->> 'layer', ''), 'stations');
  v_modes := case when jsonb_typeof(v_zone -> 'modes') = 'array' and jsonb_array_length(v_zone -> 'modes') > 0
                  then v_zone -> 'modes' end;
  v_radius := public._cfg_num(p_game.config, '{hiding_zone,station_zone,radius_m}', 805);

  return query
    select f.* from public.map_features f
     where f.city = p_game.city and f.layer = 'venues'
       and extensions.st_covers(v_area, f.geom)
       and exists (
         select 1 from public.map_features s
          where s.city = p_game.city and s.layer = v_layer
            -- A station matches if any of its modes is listed (props.modes is an array).
            and (v_modes is null or exists (
                   select 1 from jsonb_array_elements_text(
                     case when jsonb_typeof(s.props -> 'modes') = 'array' then s.props -> 'modes' else '[]'::jsonb end) m
                    where v_modes ? m))
            and extensions.st_dwithin(s.geom::extensions.geography, f.geom::extensions.geography, v_radius::float8)
       );
end;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- The hider's bar per round. Hider-only: no client access at all (RLS on, no policies, no
-- grants). Hiders learn it from the hider-only bar_chosen event.
create table public.hider_bars (
  game_id uuid not null references public.games (id) on delete cascade,
  round integer not null check (round >= 1),
  venue_id text not null,
  venue_name text not null,
  geom extensions.geometry(Point, 4326) not null,
  chosen_by uuid not null,
  chosen_at timestamptz not null default now(),
  frozen boolean not null default false,
  primary key (game_id, round)
);

alter table public.hider_bars enable row level security;
revoke all on public.hider_bars from anon, authenticated;

-- Latest position per seeker. Seekers of the game read their own team's current-round rows
-- (to draw teammates on reopen); hiders read nothing.
create table public.seeker_positions (
  game_id uuid not null references public.games (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  round integer not null check (round >= 1),
  lng double precision not null check (lng between -180 and 180),
  lat double precision not null check (lat between -90 and 90),
  accuracy_m real check (accuracy_m is null or accuracy_m >= 0),
  reported_at timestamptz not null default now(),
  primary key (game_id, user_id)
);

alter table public.seeker_positions enable row level security;
revoke all on public.seeker_positions from anon, authenticated;
grant select on public.seeker_positions to authenticated;

-- The row's owner must still be a seeker too: after roles swap, last round's seeker may now be
-- hiding, and their old position must not reach the new seekers.
create function public.can_see_seeker_position(p_game_id uuid, p_user_id uuid, p_round integer)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.my_team(p_game_id) = 'seekers'
     and exists (select 1 from public.players where game_id = p_game_id and user_id = p_user_id and team = 'seekers')
     and exists (select 1 from public.games where id = p_game_id and round = p_round and status in ('hiding', 'seeking'));
$$;

create policy "seekers read their team's positions" on public.seeker_positions
  for select to authenticated using (public.can_see_seeker_position(game_id, user_id, round));

-- ---------------------------------------------------------------------------
-- Freeze: is any seeker (fresh position, current round) within the radius of the bar?
-- ---------------------------------------------------------------------------

create function public._update_freeze(p_game public.games)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_bar public.hider_bars;
  v_radius numeric := public._cfg_num(p_game.config, '{hiding_zone,freeze_when_seeker_within_m}',
                        public._cfg_num(p_game.config, '{hiding_zone,bar_radius_m}', 100));
  -- A position older than three report intervals (min 60 s) no longer counts: that phone has
  -- stopped reporting. It is only re-checked on the next report from any seeker.
  v_fresh_s numeric := greatest(60, 3 * public._cfg_num(p_game.config, '{seeker_location_interval_s}', 20));
  v_frozen boolean;
begin
  select * into v_bar from public.hider_bars where game_id = p_game.id and round = p_game.round;
  if not found then
    return;
  end if;

  select exists (
    select 1 from public.seeker_positions sp
      join public.players p on p.game_id = sp.game_id and p.user_id = sp.user_id and p.team = 'seekers'
     where sp.game_id = p_game.id and sp.round = p_game.round
       and sp.reported_at > now() - make_interval(secs => v_fresh_s::float8)
       and extensions.st_dwithin(
             extensions.st_setsrid(extensions.st_makepoint(sp.lng, sp.lat), 4326)::extensions.geography,
             v_bar.geom::extensions.geography, v_radius::float8)
  ) into v_frozen;

  if v_frozen is distinct from v_bar.frozen then
    update public.hider_bars set frozen = v_frozen where game_id = p_game.id and round = p_game.round;
    -- No actor: the hider learns that someone is close, never who.
    perform public._append_event(p_game.id, 'freeze_changed',
      jsonb_build_object('round', p_game.round, 'frozen', v_frozen), 'hiders', null);
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Client functions
-- ---------------------------------------------------------------------------

create function public.hiding_bars(p_game_id uuid)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_game public.games;
begin
  perform public._require_user();
  if not public.is_player(p_game_id) then
    raise exception 'not_a_player' using errcode = 'P0001';
  end if;
  select * into v_game from public.games where id = p_game_id;
  return coalesce(array(select b.feature_id from public._valid_bars(v_game) b order by b.feature_id), array[]::text[]);
end;
$$;

create function public.choose_bar(
  p_game_id uuid,
  p_venue_id text,
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
  v_venue public.map_features;
  v_radius numeric;
  v_late boolean;
  v_seq bigint;
  v_frozen boolean;
begin
  if v_prev is not null then
    return v_prev;
  end if;

  v_game := public._lock_game(p_game_id);

  if not exists (select 1 from public.players where game_id = p_game_id and user_id = v_uid and team = 'hiders') then
    raise exception 'hiders_only' using errcode = 'P0001';
  end if;
  if v_game.status not in ('hiding', 'seeking') then
    raise exception 'round_not_running' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.hider_bars where game_id = p_game_id and round = v_game.round) then
    raise exception 'bar_already_chosen' using errcode = 'P0001';
  end if;
  perform public._require_fresh(p_game_id, v_uid, p_last_seen_seq);

  select * into v_venue from public.map_features
   where city = v_game.city and layer = 'venues' and feature_id = p_venue_id;
  if not found then
    raise exception 'venue_not_found' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public._valid_bars(v_game) b where b.feature_id = p_venue_id) then
    raise exception 'venue_not_allowed' using errcode = 'P0001';
  end if;

  v_radius := public._cfg_num(v_game.config, '{hiding_zone,bar_radius_m}', 100);
  v_late := now() > v_game.round_started_at + make_interval(secs => v_game.hiding_period_s);

  insert into public.hider_bars (game_id, round, venue_id, venue_name, geom, chosen_by)
  values (p_game_id, v_game.round, v_venue.feature_id, v_venue.name, v_venue.geom, v_uid);

  v_seq := public._append_event(p_game_id, 'bar_chosen', jsonb_build_object(
    'round', v_game.round,
    'venue_id', v_venue.feature_id,
    'name', v_venue.name,
    'lng', round(extensions.st_x(v_venue.geom)::numeric, 6),
    'lat', round(extensions.st_y(v_venue.geom)::numeric, 6),
    'radius_m', v_radius,
    'late', v_late
  ), 'hiders');

  -- Seekers may already be close: the hider hears about it straight away.
  perform public._update_freeze(v_game);
  select frozen into v_frozen from public.hider_bars where game_id = p_game_id and round = v_game.round;

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq, 'frozen', v_frozen));
end;
$$;

create function public.report_position(
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
  if p_lng is null or p_lat is null or p_lng = 'NaN' or p_lat = 'NaN'
     or p_lng not between -180 and 180 or p_lat not between -90 and 90
     or (p_accuracy_m is not null and (p_accuracy_m = 'NaN' or p_accuracy_m < 0)) then
    raise exception 'invalid_position' using errcode = 'P0001';
  end if;

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

  -- Teammates only. Not an event: no seq, nothing in the log.
  perform realtime.send(
    jsonb_build_object('game_id', p_game_id, 'user_id', v_uid, 'round', v_game.round,
      'lng', p_lng, 'lat', p_lat, 'accuracy_m', p_accuracy_m, 'at', now()),
    'position',
    public.topic_for(p_game_id, 'seekers'),
    true
  );

  perform public._update_freeze(v_game);

  return jsonb_build_object('ok', true, 'at', now());
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke execute on function
  public._cfg_num(jsonb, text[], numeric),
  public._valid_bars(public.games),
  public._update_freeze(public.games),
  public.can_see_seeker_position(uuid, uuid, integer),
  public.hiding_bars(uuid),
  public.choose_bar(uuid, text, uuid, bigint),
  public.report_position(uuid, double precision, double precision, real)
from public, anon, authenticated;

grant execute on function
  public.hiding_bars(uuid),
  public.choose_bar(uuid, text, uuid, bigint),
  public.report_position(uuid, double precision, double precision, real)
to authenticated;

-- RLS policies evaluate as the calling role (like can_join_topic).
grant execute on function public.can_see_seeker_position(uuid, uuid, integer) to authenticated;
