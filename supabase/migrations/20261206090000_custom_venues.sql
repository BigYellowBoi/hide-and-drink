-- Per-game custom venues and hidden venues.
--
-- * Lobby (host only): add_venue drops a named pin (public venue_added event); set_venue_hidden
--   hides or shows any listed venue, city pack or custom (public venue_hidden event). Both are
--   locked once the game starts: start_game snapshots them into game_started.venues
--   ({added, hidden}), like the play area.
-- * Round (hiders only): add_venue during hiding or seeking adds a bar that isn't on the list.
--   It must be inside the play area snapshot. Hider-only: the row has no client access and the
--   venue_added event goes to the hiders only, so seekers never receive it. hiding_bars leaves
--   it out for anyone but the hiders. When the round ends (status leaves hiding/seeking, or the
--   round number changes) a trigger marks that round's hider venues revealed and appends a
--   public venues_revealed event with them.
-- * _valid_bars, hiding_bars and choose_bar treat custom venues exactly like city-pack venues:
--   valid = (city-pack venues + public custom + revealed + this round's hider venues)
--   minus hidden, inside the play area snapshot.
-- * Ids: custom venues are 'custom:<uuid>', so they never clash with city-pack ids.

-- ---------------------------------------------------------------------------
-- Tables (no client access: phones learn venues from events)
-- ---------------------------------------------------------------------------

create table public.game_venues (
  game_id uuid not null references public.games (id) on delete cascade,
  feature_id text not null check (feature_id ~ '^custom:[0-9a-f-]{36}$'),
  name text not null check (char_length(name) between 1 and 60 and name = btrim(name)),
  kind text not null default 'bar',
  geom extensions.geometry(Point, 4326) not null,
  -- null: added by the host in the lobby (public). Otherwise the round a hider added it in
  -- (hider-only until revealed_at).
  round integer check (round is null or round >= 1),
  added_by uuid not null,
  added_at timestamptz not null default now(),
  revealed_at timestamptz,
  primary key (game_id, feature_id),
  check (round is not null or revealed_at is null)
);

create table public.game_hidden_venues (
  game_id uuid not null references public.games (id) on delete cascade,
  feature_id text not null,
  hidden_by uuid not null,
  hidden_at timestamptz not null default now(),
  primary key (game_id, feature_id)
);

alter table public.game_venues enable row level security;
alter table public.game_hidden_venues enable row level security;
revoke all on public.game_venues, public.game_hidden_venues from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create function public._venue_json(p public.game_venues)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'feature_id', p.feature_id,
    'name', p.name,
    'kind', p.kind,
    'lng', round(extensions.st_x(p.geom)::numeric, 6),
    'lat', round(extensions.st_y(p.geom)::numeric, 6),
    'round', p.round);
$$;

-- The lobby's public venues, as start_game snapshots them.
create function public._venues_snapshot(p_game_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'added', coalesce((select jsonb_agg(public._venue_json(v) order by v.added_at, v.feature_id)
                         from public.game_venues v where v.game_id = p_game_id and v.round is null), '[]'::jsonb),
    'hidden', coalesce((select jsonb_agg(h.feature_id order by h.feature_id)
                          from public.game_hidden_venues h where h.game_id = p_game_id), '[]'::jsonb));
$$;

-- Venues choose_bar accepts in this game (see top of file). Same row shape as before.
create or replace function public._valid_bars(p_game public.games)
returns setof public.map_features
language plpgsql
stable
set search_path = ''
as $$
declare
  v_area extensions.geometry;
begin
  if p_game.play_area_snapshot is null then
    return;
  end if;
  -- Force the SRID: on some PostGIS versions the repaired union comes back with SRID 0.
  v_area := extensions.st_setsrid(public._play_area_geom(p_game.play_area_snapshot), 4326);
  return query
    select b.* from (
      select f.* from public.map_features f
       where f.city = p_game.city and f.layer = 'venues'
      union all
      select p_game.city, 'venues'::text, v.feature_id, v.name, v.geom::extensions.geometry(Geometry, 4326),
             jsonb_build_object('kind', v.kind, 'custom', true)
        from public.game_venues v
       where v.game_id = p_game.id
         and (v.round is null or v.revealed_at is not null or v.round = p_game.round)
    ) b
     where extensions.st_covers(v_area, b.geom)
       and not exists (select 1 from public.game_hidden_venues h
                        where h.game_id = p_game.id and h.feature_id = b.feature_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- hiding_bars: hider-added venues only for the hiders until revealed
-- ---------------------------------------------------------------------------

create or replace function public.hiding_bars(p_game_id uuid)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_game public.games;
  v_hider boolean;
begin
  perform public._require_user();
  if not public.is_player(p_game_id) then
    raise exception 'not_a_player' using errcode = 'P0001';
  end if;
  select * into v_game from public.games where id = p_game_id;
  v_hider := public.my_team(p_game_id) = 'hiders';
  return coalesce(array(
    select b.feature_id from public._valid_bars(v_game) b
     where v_hider or not exists (
       select 1 from public.game_venues v
        where v.game_id = p_game_id and v.feature_id = b.feature_id
          and v.round is not null and v.revealed_at is null)
     order by b.feature_id), array[]::text[]);
end;
$$;

-- ---------------------------------------------------------------------------
-- add_venue / set_venue_hidden
-- ---------------------------------------------------------------------------

create function public.add_venue(
  p_game_id uuid,
  p_name text,
  p_lng double precision,
  p_lat double precision,
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
  v_name text := btrim(coalesce(p_name, ''));
  v_geom extensions.geometry;
  v_extent extensions.geometry;
  v_round integer;
  v_row public.game_venues;
  v_seq bigint;
begin
  if v_prev is not null then
    return v_prev;
  end if;

  v_game := public._lock_game(p_game_id);

  if not public.is_player(p_game_id) then
    raise exception 'not_a_player' using errcode = 'P0001';
  end if;
  if v_game.status = 'lobby' then
    if v_game.host_id <> v_uid then
      raise exception 'host_only' using errcode = 'P0001';
    end if;
  elsif v_game.status in ('hiding', 'seeking') then
    if not exists (select 1 from public.players where game_id = p_game_id and user_id = v_uid and team = 'hiders') then
      raise exception 'hiders_only' using errcode = 'P0001';
    end if;
    v_round := v_game.round;
  else
    raise exception 'round_not_running' using errcode = 'P0001';
  end if;

  if char_length(v_name) not between 1 and 60 then
    raise exception 'invalid_venue_name' using errcode = 'P0001';
  end if;
  if p_lng is null or p_lat is null or p_lng = 'NaN' or p_lat = 'NaN'
     or p_lng not between -180 and 180 or p_lat not between -90 and 90 then
    raise exception 'invalid_position' using errcode = 'P0001';
  end if;
  perform public._require_fresh(p_game_id, v_uid, p_last_seen_seq);

  v_geom := extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326);

  if v_round is null then
    -- Lobby: anywhere the city pack covers (the play area can still change).
    select extent into v_extent from public.city_packs where city = v_game.city;
    if v_extent is not null and not extensions.st_covers(extensions.st_setsrid(v_extent, 4326), v_geom) then
      raise exception 'venue_outside_map_data' using errcode = 'P0001';
    end if;
    if (select count(*) from public.game_venues where game_id = p_game_id and round is null) >= 200 then
      raise exception 'too_many_venues' using errcode = 'P0001';
    end if;
  else
    if v_game.play_area_snapshot is null
       or not extensions.st_covers(extensions.st_setsrid(public._play_area_geom(v_game.play_area_snapshot), 4326), v_geom) then
      raise exception 'venue_outside_play_area' using errcode = 'P0001';
    end if;
    if (select count(*) from public.game_venues where game_id = p_game_id and round = v_round) >= 5 then
      raise exception 'too_many_venues' using errcode = 'P0001';
    end if;
  end if;

  insert into public.game_venues (game_id, feature_id, name, geom, round, added_by)
  values (p_game_id, 'custom:' || gen_random_uuid()::text, v_name, v_geom, v_round, v_uid)
  returning * into v_row;

  v_seq := public._append_event(p_game_id, 'venue_added', jsonb_build_object('venue', public._venue_json(v_row)),
    case when v_round is null then 'all' else 'hiders' end::public.event_visibility);

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq, 'feature_id', v_row.feature_id));
end;
$$;

create function public.set_venue_hidden(
  p_game_id uuid,
  p_feature_id text,
  p_hidden boolean,
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
  v_name text;
  v_seq bigint;
begin
  if v_prev is not null then
    return v_prev;
  end if;

  v_game := public._lock_game(p_game_id);

  if v_game.host_id <> v_uid then
    raise exception 'host_only' using errcode = 'P0001';
  end if;
  if v_game.status <> 'lobby' then
    raise exception 'venues_locked' using errcode = 'P0001';
  end if;
  if p_hidden is null then
    raise exception 'invalid_venue' using errcode = 'P0001';
  end if;
  perform public._require_fresh(p_game_id, v_uid, p_last_seen_seq);

  select name into v_name from public.map_features
   where city = v_game.city and layer = 'venues' and feature_id = p_feature_id;
  if v_name is null then
    select name into v_name from public.game_venues
     where game_id = p_game_id and feature_id = p_feature_id and round is null;
  end if;
  if v_name is null then
    raise exception 'venue_not_found' using errcode = 'P0001';
  end if;

  if p_hidden then
    insert into public.game_hidden_venues (game_id, feature_id, hidden_by)
    values (p_game_id, p_feature_id, v_uid) on conflict do nothing;
  else
    delete from public.game_hidden_venues where game_id = p_game_id and feature_id = p_feature_id;
  end if;

  v_seq := public._append_event(p_game_id, 'venue_hidden',
    jsonb_build_object('feature_id', p_feature_id, 'name', v_name, 'hidden', p_hidden));

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq));
end;
$$;

-- ---------------------------------------------------------------------------
-- choose_bar: as in 20261202090000_powerups_vetoes_proofs.sql, venue looked up in _valid_bars
-- ---------------------------------------------------------------------------

create or replace function public.choose_bar(
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
  v_bar public.hider_bars;
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
  select * into v_bar from public.hider_bars where game_id = p_game_id and round = v_game.round for update;
  if found and not v_bar.move_pending then
    raise exception 'bar_already_chosen' using errcode = 'P0001';
  end if;
  perform public._require_fresh(p_game_id, v_uid, p_last_seen_seq);

  select * into v_venue from public._valid_bars(v_game) b where b.feature_id = p_venue_id;
  if not found then
    if exists (select 1 from public.map_features where city = v_game.city and layer = 'venues' and feature_id = p_venue_id)
       or exists (select 1 from public.game_venues where game_id = p_game_id and feature_id = p_venue_id) then
      raise exception 'venue_not_allowed' using errcode = 'P0001';
    end if;
    raise exception 'venue_not_found' using errcode = 'P0001';
  end if;
  if v_bar.move_pending and v_bar.venue_id = p_venue_id then
    raise exception 'same_bar' using errcode = 'P0001';
  end if;

  v_radius := public._cfg_num(v_game.config, '{hiding_zone,bar_radius_m}', 100);
  v_late := now() > v_game.round_started_at + make_interval(secs => v_game.hiding_period_s);

  if v_bar.move_pending then
    update public.hider_bars
       set venue_id = v_venue.feature_id, venue_name = v_venue.name, geom = v_venue.geom,
           chosen_by = v_uid, chosen_at = now(), move_pending = false
     where game_id = p_game_id and round = v_game.round;
  else
    insert into public.hider_bars (game_id, round, venue_id, venue_name, geom, chosen_by)
    values (p_game_id, v_game.round, v_venue.feature_id, v_venue.name, v_venue.geom, v_uid);
  end if;

  v_seq := public._append_event(p_game_id, 'bar_chosen', jsonb_build_object(
    'round', v_game.round,
    'venue_id', v_venue.feature_id,
    'name', v_venue.name,
    'lng', round(extensions.st_x(v_venue.geom)::numeric, 6),
    'lat', round(extensions.st_y(v_venue.geom)::numeric, 6),
    'radius_m', v_radius,
    'late', v_late,
    'moved', coalesce(v_bar.move_pending, false)
  ), 'hiders');

  if v_bar.move_pending then
    -- Seekers learn only that the move is done, never where.
    v_seq := public._append_event(p_game_id, 'hider_moved', jsonb_build_object('round', v_game.round, 'at', now()));
  end if;

  perform public._update_freeze(v_game);
  select frozen into v_frozen from public.hider_bars where game_id = p_game_id and round = v_game.round;

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq, 'frozen', v_frozen));
end;
$$;

-- ---------------------------------------------------------------------------
-- start_game: as in 20261130090000_cards.sql, plus the venues snapshot
-- ---------------------------------------------------------------------------

create or replace function public.start_game(
  p_game_id uuid,
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
  v_area public.play_areas;
  v_hiding jsonb;
  v_hiding_s integer;
  v_round integer;
  v_teams jsonb;
  v_deck jsonb;
  v_seq bigint;
begin
  if v_prev is not null then
    return v_prev;
  end if;

  v_game := public._lock_game(p_game_id);

  if v_game.host_id <> v_uid then
    raise exception 'host_only' using errcode = 'P0001';
  end if;
  if v_game.status <> 'lobby' then
    raise exception 'already_started' using errcode = 'P0001';
  end if;
  perform public._require_fresh(p_game_id, v_uid, p_last_seen_seq);

  if exists (select 1 from public.players where game_id = p_game_id and team is null) then
    raise exception 'players_without_team' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.players where game_id = p_game_id and team = 'hiders')
     or not exists (select 1 from public.players where game_id = p_game_id and team = 'seekers') then
    raise exception 'needs_both_teams' using errcode = 'P0001';
  end if;

  select * into v_area from public.play_areas where id = v_game.play_area_id;
  if not found then
    raise exception 'play_area_required' using errcode = 'P0001';
  end if;

  v_hiding := v_game.config -> 'hiding_period_s';
  if v_hiding is null or jsonb_typeof(v_hiding) <> 'number'
     or (v_hiding #>> '{}')::numeric <= 0
     or (v_hiding #>> '{}')::numeric <> trunc((v_hiding #>> '{}')::numeric) then
    raise exception 'hiding_period_required' using errcode = 'P0001';
  end if;
  v_hiding_s := (v_hiding #>> '{}')::integer;
  v_round := v_game.round + 1;

  select jsonb_agg(jsonb_build_object('user_id', user_id, 'name', name, 'team', team) order by joined_at)
    into v_teams
    from public.players where game_id = p_game_id;

  v_deck := public._deal_deck(v_game, v_round);

  update public.games
     set status = 'hiding',
         round = v_round,
         round_started_at = now(),
         hiding_period_s = v_hiding_s,
         play_area_snapshot = v_area.geojson
   where id = p_game_id;

  v_seq := public._append_event(p_game_id, 'game_started', jsonb_build_object(
    'round', v_round,
    'started_at', now(),
    'hiding_period_s', v_hiding_s,
    'config', v_game.config,
    'play_area', jsonb_build_object('id', v_area.id, 'name', v_area.name, 'geojson', v_area.geojson),
    'venues', public._venues_snapshot(p_game_id),
    'players', v_teams,
    'deck', v_deck,
    'hand_limit', public._hand_limit(v_game.config)
  ));

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq, 'round', v_round));
end;
$$;

-- ---------------------------------------------------------------------------
-- Reveal: when a round ends, its hider venues become public
-- ---------------------------------------------------------------------------

create function public._reveal_hider_venues()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_venues jsonb;
begin
  with r as (
    update public.game_venues set revealed_at = now()
     where game_id = old.id and round = old.round and revealed_at is null
    returning *
  )
  select jsonb_agg(public._venue_json(r) order by r.added_at, r.feature_id) into v_venues from r;

  if v_venues is not null then
    -- No actor: nobody did this, the round ended.
    perform public._append_event(old.id, 'venues_revealed',
      jsonb_build_object('round', old.round, 'venues', v_venues), 'all', null);
  end if;
  return null;
end;
$$;

create trigger games_reveal_hider_venues
after update of status, round on public.games
for each row
when (old.status in ('hiding', 'seeking')
      and (new.status not in ('hiding', 'seeking') or new.round is distinct from old.round))
execute function public._reveal_hider_venues();

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke execute on function
  public._venue_json(public.game_venues),
  public._venues_snapshot(uuid),
  public._valid_bars(public.games),
  public._reveal_hider_venues(),
  public.hiding_bars(uuid),
  public.add_venue(uuid, text, double precision, double precision, uuid, bigint),
  public.set_venue_hidden(uuid, text, boolean, uuid, bigint),
  public.choose_bar(uuid, text, uuid, bigint),
  public.start_game(uuid, uuid, bigint)
from public, anon, authenticated;

grant execute on function
  public.hiding_bars(uuid),
  public.add_venue(uuid, text, double precision, double precision, uuid, bigint),
  public.set_venue_hidden(uuid, text, boolean, uuid, bigint),
  public.choose_bar(uuid, text, uuid, bigint),
  public.start_game(uuid, uuid, bigint)
to authenticated;
