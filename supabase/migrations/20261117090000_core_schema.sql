-- Hide + Drink core schema: content library, games, players, event log, live broadcast.
--
-- Rules this file enforces (see CLAUDE.md):
--   * Phones never write tables directly. Every change goes through a security-definer
--     action function that locks the game row, validates, appends to the event log and
--     returns. Tables only have SELECT grants for clients.
--   * Every event gets the next per-game sequence number. Clients apply in order and
--     refetch gaps.
--   * Team-private events are only readable (RLS) and only broadcast (private Realtime
--     topics) to that team.
--   * Retried actions are idempotent via client_action_id.

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

create type public.team as enum ('hiders', 'seekers');
create type public.game_status as enum ('lobby', 'hiding', 'seeking', 'ended');
create type public.event_visibility as enum ('all', 'hiders', 'seekers');

-- ---------------------------------------------------------------------------
-- Content library (cards, categories, questions, play areas)
-- Read-only for clients for now; editing arrives with the card library UI.
-- ---------------------------------------------------------------------------

create table public.categories (
  id text primary key check (id ~ '^[a-z0-9_]+$'),
  name text not null check (char_length(name) between 1 and 40),
  colour text not null default '#888888' check (colour ~ '^#[0-9A-Fa-f]{6}$'),
  sort integer not null default 0,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.cards (
  id text primary key check (id ~ '^[a-z0-9_]+$'),
  name text not null check (char_length(name) between 1 and 80),
  category_id text not null references public.categories (id),
  behaviour text not null check (
    behaviour in (
      'text', 'timed', 'until_cleared', 'time_bonus',
      'next_question_modifier', 'powerup', 'question_ban'
    )
  ),
  body text,
  params jsonb not null default '{}'::jsonb check (jsonb_typeof(params) = 'object'),
  cast_cost text check (cast_cost in ('free', 'drink', 'shot')),
  can_veto boolean,
  default_copies integer not null default 1 check (default_copies >= 0),
  sort integer not null default 0,
  active boolean not null default true,
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

create index cards_category_idx on public.cards (category_id);

create table public.question_types (
  city text not null check (city ~ '^[a-z0-9_]+$'),
  type text not null check (
    type in ('matching', 'measuring', 'thermometer', 'radar', 'tentacles', 'photos', 'bonus')
  ),
  prompt text not null,
  reward_draw integer not null check (reward_draw >= 1),
  reward_pick integer not null check (reward_pick >= 1),
  auto_shading boolean not null default false,
  options jsonb not null check (jsonb_typeof(options) = 'array'),
  extra jsonb not null default '{}'::jsonb check (jsonb_typeof(extra) = 'object'),
  sort integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (city, type),
  check (reward_pick <= reward_draw)
);

create table public.play_areas (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  city text not null check (city ~ '^[a-z0-9_]+$'),
  geojson jsonb not null check (jsonb_typeof(geojson) = 'object'),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (city, name)
);

-- ---------------------------------------------------------------------------
-- Games
-- ---------------------------------------------------------------------------

create table public.games (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z2-9]{6}$'),
  status public.game_status not null default 'lobby',
  host_id uuid not null references auth.users (id) on delete cascade,
  city text not null default 'brisbane',
  config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  play_area_id uuid references public.play_areas (id) on delete set null,
  last_seq bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.players (
  game_id uuid not null references public.games (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 24),
  team public.team,
  is_host boolean not null default false,
  joined_at timestamptz not null default now(),
  primary key (game_id, user_id)
);

create index players_user_idx on public.players (user_id);

-- Append-only event log. seq is contiguous per game (1, 2, 3, ...).
create table public.events (
  game_id uuid not null references public.games (id) on delete cascade,
  seq bigint not null check (seq >= 1),
  type text not null check (type ~ '^[a-z_]+$'),
  visibility public.event_visibility not null default 'all',
  actor_id uuid,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  primary key (game_id, seq)
);

-- Results of processed actions, so a retried request returns the same result
-- instead of applying twice. Private: no client access.
create table public.processed_actions (
  client_action_id uuid primary key,
  user_id uuid not null,
  game_id uuid references public.games (id) on delete cascade,
  result jsonb not null,
  created_at timestamptz not null default now()
);

create function public._events_are_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'events are append-only';
end;
$$;

create trigger events_append_only
before update or delete on public.events
for each row
when (pg_trigger_depth() = 0)
execute function public._events_are_append_only();

-- ---------------------------------------------------------------------------
-- Membership helpers (used by RLS policies; security definer so they can read
-- players without recursing through players' own policy)
-- ---------------------------------------------------------------------------

create function public.is_player(p_game_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.players
    where game_id = p_game_id and user_id = (select auth.uid())
  );
$$;

create function public.my_team(p_game_id uuid)
returns public.team
language sql
stable
security definer
set search_path = ''
as $$
  select team from public.players
  where game_id = p_game_id and user_id = (select auth.uid());
$$;

-- Can the current user see an event with this visibility in this game?
create function public.can_see(p_game_id uuid, p_visibility public.event_visibility)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.players
    where game_id = p_game_id
      and user_id = (select auth.uid())
      and (p_visibility = 'all' or team::text = p_visibility::text)
  );
$$;

-- Realtime topic naming: game:<id> (everyone), game:<id>:hiders, game:<id>:seekers.
create function public.topic_for(p_game_id uuid, p_visibility public.event_visibility)
returns text
language sql
immutable
set search_path = ''
as $$
  select 'game:' || p_game_id::text
    || case when p_visibility = 'all' then '' else ':' || p_visibility::text end;
$$;

-- Can the current user join this Realtime topic?
create function public.can_join_topic(p_topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_game uuid;
  v_vis public.event_visibility;
begin
  if p_topic is null
     or p_topic !~ '^game:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(:(hiders|seekers))?$' then
    return false;
  end if;
  v_game := split_part(p_topic, ':', 2)::uuid;
  v_vis := coalesce(nullif(split_part(p_topic, ':', 3), ''), 'all')::public.event_visibility;
  return public.can_see(v_game, v_vis);
end;
$$;

-- ---------------------------------------------------------------------------
-- Row-level security: clients may read, never write
-- ---------------------------------------------------------------------------

alter table public.categories enable row level security;
alter table public.cards enable row level security;
alter table public.question_types enable row level security;
alter table public.play_areas enable row level security;
alter table public.games enable row level security;
alter table public.players enable row level security;
alter table public.events enable row level security;
alter table public.processed_actions enable row level security;

create policy "signed-in users read categories" on public.categories
  for select to authenticated using (true);
create policy "signed-in users read cards" on public.cards
  for select to authenticated using (true);
create policy "signed-in users read questions" on public.question_types
  for select to authenticated using (true);
create policy "signed-in users read play areas" on public.play_areas
  for select to authenticated using (true);

create policy "players read their games" on public.games
  for select to authenticated using (public.is_player(id));
create policy "players read players in their games" on public.players
  for select to authenticated using (public.is_player(game_id));
create policy "players read events their team may see" on public.events
  for select to authenticated using (public.can_see(game_id, visibility));

-- processed_actions: RLS on with no policies = no client access.

-- Data API access is opt-in on this project, so grant explicitly.
revoke all on
  public.categories, public.cards, public.question_types, public.play_areas,
  public.games, public.players, public.events, public.processed_actions
from anon, authenticated;

grant select on
  public.categories, public.cards, public.question_types, public.play_areas,
  public.games, public.players, public.events
to authenticated;

-- Realtime: players may receive broadcasts only on their own game/team topics.
create policy "players receive their game topics" on realtime.messages
  for select to authenticated
  using (realtime.messages.extension = 'broadcast' and public.can_join_topic((select realtime.topic())));

-- ---------------------------------------------------------------------------
-- Internal helpers for action functions (not callable by clients)
-- ---------------------------------------------------------------------------

create function public._require_user()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not_signed_in' using errcode = 'P0001';
  end if;
  return v_uid;
end;
$$;

-- Lock the game row for the rest of the transaction. All actions on one game
-- therefore run one at a time, in arrival order.
create function public._lock_game(p_game_id uuid)
returns public.games
language plpgsql
set search_path = ''
as $$
declare
  v_game public.games;
begin
  select * into v_game from public.games where id = p_game_id for update;
  if not found then
    raise exception 'game_not_found' using errcode = 'P0001';
  end if;
  return v_game;
end;
$$;

-- Refuse an action if the caller has not yet seen an event visible to them.
create function public._require_fresh(p_game_id uuid, p_user uuid, p_last_seen_seq bigint)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.events e
    join public.players p on p.game_id = e.game_id and p.user_id = p_user
    where e.game_id = p_game_id
      and e.seq > coalesce(p_last_seen_seq, 0)
      and (e.visibility = 'all' or e.visibility::text = p.team::text)
  ) then
    raise exception 'stale_state' using errcode = 'P0001',
      hint = 'Fetch events after your last seen seq, then retry.';
  end if;
end;
$$;

create function public._append_event(
  p_game_id uuid,
  p_type text,
  p_payload jsonb default '{}'::jsonb,
  p_visibility public.event_visibility default 'all',
  p_actor uuid default auth.uid()
)
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_seq bigint;
begin
  update public.games
     set last_seq = last_seq + 1, updated_at = now()
   where id = p_game_id
  returning last_seq into v_seq;

  if v_seq is null then
    raise exception 'game_not_found' using errcode = 'P0001';
  end if;

  insert into public.events (game_id, seq, type, visibility, actor_id, payload)
  values (p_game_id, v_seq, p_type, p_visibility, p_actor, coalesce(p_payload, '{}'::jsonb));

  return v_seq;
end;
$$;

create function public._previous_result(p_client_action_id uuid, p_user uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_row public.processed_actions;
begin
  if p_client_action_id is null then
    raise exception 'client_action_id_required' using errcode = 'P0001';
  end if;
  select * into v_row from public.processed_actions where client_action_id = p_client_action_id;
  if not found then
    return null;
  end if;
  if v_row.user_id <> p_user then
    raise exception 'client_action_id_in_use' using errcode = 'P0001';
  end if;
  return v_row.result;
end;
$$;

create function public._record_result(p_client_action_id uuid, p_user uuid, p_game_id uuid, p_result jsonb)
returns jsonb
language sql
set search_path = ''
as $$
  insert into public.processed_actions (client_action_id, user_id, game_id, result)
  values (p_client_action_id, p_user, p_game_id, p_result);
  select p_result;
$$;

create function public._new_game_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  -- No 0/O/1/I to avoid misreading codes aloud.
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code text;
begin
  loop
    v_code := '';
    for i in 1..6 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.games where code = v_code);
  end loop;
  return v_code;
end;
$$;

-- ---------------------------------------------------------------------------
-- Live broadcast: every new event goes to its topic on a private channel
-- ---------------------------------------------------------------------------

create function public._broadcast_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.send(
    jsonb_build_object(
      'game_id', new.game_id,
      'seq', new.seq,
      'type', new.type,
      'visibility', new.visibility,
      'actor_id', new.actor_id,
      'payload', new.payload,
      'created_at', new.created_at
    ),
    'event',
    public.topic_for(new.game_id, new.visibility),
    true
  );
  return null;
end;
$$;

create trigger events_broadcast
after insert on public.events
for each row execute function public._broadcast_event();

-- ---------------------------------------------------------------------------
-- Client-callable actions
-- ---------------------------------------------------------------------------

-- Server clock, for client clock-offset correction.
create function public.server_time()
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select now();
$$;

create function public.create_game(
  p_name text,
  p_client_action_id uuid,
  p_city text default 'brisbane',
  p_config jsonb default '{}'::jsonb
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
  v_seq bigint;
begin
  if v_prev is not null then
    return v_prev;
  end if;

  insert into public.games (code, host_id, city, config)
  values (public._new_game_code(), v_uid, coalesce(p_city, 'brisbane'), coalesce(p_config, '{}'::jsonb))
  returning * into v_game;

  insert into public.players (game_id, user_id, name, is_host)
  values (v_game.id, v_uid, btrim(p_name), true);

  v_seq := public._append_event(v_game.id, 'game_created',
    jsonb_build_object('code', v_game.code, 'city', v_game.city, 'host_id', v_uid, 'host_name', btrim(p_name)));

  return public._record_result(p_client_action_id, v_uid, v_game.id,
    jsonb_build_object('game_id', v_game.id, 'code', v_game.code, 'seq', v_seq));
end;
$$;

create function public.join_game(p_code text, p_name text, p_client_action_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public._require_user();
  v_prev jsonb := public._previous_result(p_client_action_id, v_uid);
  v_game_id uuid;
  v_game public.games;
  v_seq bigint;
begin
  if v_prev is not null then
    return v_prev;
  end if;

  select id into v_game_id from public.games where code = upper(btrim(p_code));
  if v_game_id is null then
    raise exception 'game_not_found' using errcode = 'P0001';
  end if;

  v_game := public._lock_game(v_game_id);

  if exists (select 1 from public.players where game_id = v_game.id and user_id = v_uid) then
    -- Rejoining (new device session, refresh): no new event.
    return public._record_result(p_client_action_id, v_uid, v_game.id,
      jsonb_build_object('game_id', v_game.id, 'code', v_game.code, 'seq', v_game.last_seq, 'rejoined', true));
  end if;

  if v_game.status = 'ended' then
    raise exception 'game_ended' using errcode = 'P0001';
  end if;

  insert into public.players (game_id, user_id, name)
  values (v_game.id, v_uid, btrim(p_name));

  v_seq := public._append_event(v_game.id, 'player_joined',
    jsonb_build_object('user_id', v_uid, 'name', btrim(p_name)));

  return public._record_result(p_client_action_id, v_uid, v_game.id,
    jsonb_build_object('game_id', v_game.id, 'code', v_game.code, 'seq', v_seq));
end;
$$;

-- Pick a team (self), or move another player (host only). Lobby only.
create function public.set_team(
  p_game_id uuid,
  p_team public.team,
  p_client_action_id uuid,
  p_user_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public._require_user();
  v_prev jsonb := public._previous_result(p_client_action_id, v_uid);
  v_target uuid := coalesce(p_user_id, v_uid);
  v_game public.games;
  v_seq bigint;
begin
  if v_prev is not null then
    return v_prev;
  end if;

  v_game := public._lock_game(p_game_id);

  if not exists (select 1 from public.players where game_id = p_game_id and user_id = v_uid) then
    raise exception 'not_a_player' using errcode = 'P0001';
  end if;
  if v_target <> v_uid and v_game.host_id <> v_uid then
    raise exception 'host_only' using errcode = 'P0001';
  end if;
  if v_game.status <> 'lobby' then
    raise exception 'teams_locked' using errcode = 'P0001';
  end if;

  update public.players set team = p_team
   where game_id = p_game_id and user_id = v_target;
  if not found then
    raise exception 'player_not_found' using errcode = 'P0001';
  end if;

  v_seq := public._append_event(p_game_id, 'team_changed',
    jsonb_build_object('user_id', v_target, 'team', p_team, 'by', v_uid));

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq));
end;
$$;

-- Host updates game config in the lobby. Requires an up-to-date view.
create function public.update_config(
  p_game_id uuid,
  p_config jsonb,
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
    raise exception 'config_locked' using errcode = 'P0001';
  end if;
  if p_config is null or jsonb_typeof(p_config) <> 'object' then
    raise exception 'invalid_config' using errcode = 'P0001';
  end if;
  perform public._require_fresh(p_game_id, v_uid, p_last_seen_seq);

  update public.games set config = p_config where id = p_game_id;

  v_seq := public._append_event(p_game_id, 'config_changed', jsonb_build_object('config', p_config));

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq));
end;
$$;

-- ---------------------------------------------------------------------------
-- Function privileges: clients may call only the public actions
-- ---------------------------------------------------------------------------

revoke execute on all functions in schema public from public, anon, authenticated;

-- Postgres grants EXECUTE to PUBLIC on every new function, so each later migration
-- must revoke and grant explicitly too. supabase/tests/03_privileges.test.sql fails
-- if any public function is callable by clients without being on the allow-list.
alter default privileges in schema public revoke execute on functions from anon, authenticated;

grant execute on function
  public.server_time(),
  public.create_game(text, uuid, text, jsonb),
  public.join_game(text, text, uuid),
  public.set_team(uuid, public.team, uuid, uuid),
  public.update_config(uuid, jsonb, uuid, bigint)
to authenticated;

-- RLS policies call these as the querying user.
grant execute on function
  public.is_player(uuid),
  public.my_team(uuid),
  public.can_see(uuid, public.event_visibility),
  public.can_join_topic(text),
  public.topic_for(uuid, public.event_visibility)
to authenticated;
