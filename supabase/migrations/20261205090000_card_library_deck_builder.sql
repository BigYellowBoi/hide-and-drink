-- Card library editing (shared, live) and the lobby deck builder.
--
-- Library (cards and categories): any signed-in player may add and edit cards and
-- categories. Nothing is ever deleted: cards and categories are retired (active = false)
-- and can be restored. Every change records its author (uid and the name they play
-- under) on the row and in the append-only library_edits history, then broadcasts on the
-- private Realtime topic 'library' so every open phone refetches. Games already started
-- keep their own snapshot (game_cards), so edits never change a game in progress.
--
-- * save_card (p_card_id null = new): validates the fields and the params the card's
--   behaviour reads. p_base_updated_at, when given, must match the stored updated_at, so a
--   phone never silently overwrites an edit it hasn't seen (card_changed).
-- * set_card_active: retire or restore a card.
-- * save_category / set_category_active: same for categories. A category with active cards
--   can't be retired (category_in_use): retire or move its cards first.
--
-- Deck builder:
-- * set_deck (host, lobby): sets config.deck ({card_id: copies}, null = library defaults)
--   and appends config_changed with the whole config, like update_config. No freshness
--   check (like set_team): the host is the only writer and each call sends the whole deck,
--   so rapid +/- taps never trip stale_state.
-- * update_config no longer touches config.deck (set_deck owns it), so saving settings from
--   an older draft can't undo deck changes.
-- * _deck_copies ignores retired or unknown cards in config.deck instead of failing the
--   start: retiring a card after the host built the deck just drops it.
-- * deck_presets: shared saved decks, like play areas. Built-in rows (no creator) can't be
--   deleted. deck null = library defaults. save_deck_preset overwrites your own preset of
--   the same name; delete_deck_preset deletes any player-made preset.

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------

alter table public.categories
  add column active boolean not null default true,
  add column updated_by uuid references auth.users (id) on delete set null,
  add column updated_by_name text check (updated_by_name is null or char_length(updated_by_name) between 1 and 80),
  add column updated_at timestamptz not null default now();

alter table public.cards
  add column updated_by_name text check (updated_by_name is null or char_length(updated_by_name) between 1 and 80);

alter table public.cards
  add constraint cards_body_length check (body is null or char_length(body) <= 2000),
  add constraint cards_copies_max check (default_copies <= 99);

create table public.library_edits (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('card', 'category')),
  item_id text not null,
  action text not null check (action in ('created', 'updated', 'retired', 'restored')),
  author uuid references auth.users (id) on delete set null,
  author_name text,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);

create index library_edits_item_idx on public.library_edits (kind, item_id, id);

create function public._library_edits_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'library_edits_append_only' using errcode = 'P0001';
end;
$$;

create trigger library_edits_append_only
before update or delete on public.library_edits
for each row execute function public._library_edits_append_only();

create table public.deck_presets (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (char_length(name) between 1 and 60),
  deck jsonb check (deck is null or jsonb_typeof(deck) = 'object'),
  sort integer not null default 100,
  created_by uuid references auth.users (id) on delete set null,
  creator_name text check (creator_name is null or char_length(creator_name) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.library_edits enable row level security;
alter table public.deck_presets enable row level security;

create policy "signed-in users read library edits" on public.library_edits
  for select to authenticated using (true);
create policy "signed-in users read deck presets" on public.deck_presets
  for select to authenticated using (true);

revoke all on public.library_edits, public.deck_presets from anon, authenticated;
grant select on public.library_edits, public.deck_presets to authenticated;

-- Live library updates: any signed-in user may receive broadcasts on 'library'.
create policy "signed-in users receive library changes" on realtime.messages
  for select to authenticated
  using (realtime.messages.extension = 'broadcast' and (select realtime.topic()) = 'library');

insert into public.deck_presets (name, deck, sort) values ('Library defaults', null, 0)
on conflict (name) do nothing;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Name to record for an edit: the one the phone sends, else the latest game they joined,
-- else the name on their last library edit.
create function public._author_name(p_uid uuid, p_name text)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
begin
  if v_name is null then
    select p.name into v_name from public.players p where p.user_id = p_uid order by p.joined_at desc limit 1;
  end if;
  if v_name is null then
    select e.author_name into v_name from public.library_edits e
     where e.author = p_uid and e.author_name is not null order by e.id desc limit 1;
  end if;
  return left(v_name, 80);
end;
$$;

-- Record a library change and tell every open phone.
create function public._library_changed(
  p_kind text, p_item_id text, p_action text, p_uid uuid, p_name text, p_before jsonb, p_after jsonb
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  insert into public.library_edits (kind, item_id, action, author, author_name, before, after)
  values (p_kind, p_item_id, p_action, p_uid, p_name, p_before, p_after);
  perform realtime.send(
    jsonb_build_object('kind', p_kind, 'id', p_item_id, 'action', p_action, 'by', p_name),
    'event', 'library', true);
end;
$$;

-- A new id from a name: lowercase words joined by _, unique in the table given.
create function public._new_library_id(p_name text, p_table text)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_base text := left(btrim(regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', '_', 'g'), '_'), 40);
  v_id text;
  v_n integer := 1;
  v_taken boolean;
begin
  if v_base = '' then
    v_base := case when p_table = 'categories' then 'category' else 'card' end;
  end if;
  v_id := v_base;
  loop
    if p_table = 'categories' then
      v_taken := exists (select 1 from public.categories where id = v_id);
    else
      v_taken := exists (select 1 from public.cards where id = v_id);
    end if;
    exit when not v_taken;
    v_n := v_n + 1;
    v_id := v_base || '_' || v_n;
  end loop;
  return v_id;
end;
$$;

create function public._is_int(p jsonb, p_min numeric, p_max numeric)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_typeof(p) = 'number'
     and (p #>> '{}')::numeric = trunc((p #>> '{}')::numeric)
     and (p #>> '{}')::numeric between p_min and p_max, false);
$$;

create function public._is_pos(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_typeof(p) = 'number' and (p #>> '{}')::numeric > 0, false);
$$;

-- The params each behaviour reads (see play_card). Raises invalid_card_params with the
-- offending key as detail. Other keys are free-form and kept as they are.
create function public._check_card_params(p_behaviour text, p jsonb)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_bad text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    v_bad := 'params';
  elsif p_behaviour = 'timed' and not public._is_pos(p -> 'duration_s') then
    v_bad := 'duration_s';
  elsif p_behaviour = 'time_bonus' and not public._is_pos(p -> 'minutes') then
    v_bad := 'minutes';
  elsif p_behaviour = 'powerup' and coalesce(p ->> 'action', '') not in ('veto', 'randomize', 'duplicate', 'move', 'discard_draw') then
    v_bad := 'action';
  elsif p_behaviour = 'powerup' and p ->> 'action' = 'discard_draw' and not public._is_int(p -> 'discard', 0, 10) then
    v_bad := 'discard';
  elsif p_behaviour = 'powerup' and p ->> 'action' = 'discard_draw' and not public._is_int(p -> 'draw', 1, 10) then
    v_bad := 'draw';
  elsif p_behaviour = 'question_ban' and p ? 'count' and not public._is_int(p -> 'count', 1, 10) then
    v_bad := 'count';
  elsif p_behaviour = 'next_question_modifier' and p ? 'reward_multiplier'
        and not (jsonb_typeof(p -> 'reward_multiplier') = 'number' and (p ->> 'reward_multiplier')::numeric >= 1) then
    v_bad := 'reward_multiplier';
  elsif p ? 'followup_s' and not public._is_pos(p -> 'followup_s') then
    v_bad := 'followup_s';
  elsif p ? 'utility' and coalesce(p ->> 'utility', '') not in ('dice', 'wheel') then
    v_bad := 'utility';
  elsif p ? 'dice' and not public._is_int(p -> 'dice', 1, 10) then
    v_bad := 'dice';
  elsif p ? 'wheel_options' and not (jsonb_typeof(p -> 'wheel_options') = 'array'
        and jsonb_array_length(p -> 'wheel_options') between 2 and 50) then
    v_bad := 'wheel_options';
  elsif p ? 'cost' and coalesce(p ->> 'cost', '') not in ('drink', 'shot') then
    v_bad := 'cost';
  elsif p ? 'cost_team' and coalesce(p ->> 'cost_team', '') not in ('hiders', 'seekers') then
    v_bad := 'cost_team';
  elsif p ? 'drinks' and not (jsonb_typeof(p -> 'drinks') = 'array' and not exists (
          select 1 from jsonb_array_elements(p -> 'drinks') t where t #>> '{}' not in ('hiders', 'seekers'))) then
    v_bad := 'drinks';
  end if;
  if v_bad is not null then
    raise exception 'invalid_card_params' using errcode = 'P0001', detail = v_bad;
  end if;
end;
$$;

create function public._card_row_json(c public.cards)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('id', c.id, 'name', c.name, 'category', c.category_id, 'behaviour', c.behaviour,
    'text', c.body, 'params', c.params, 'cast_cost', c.cast_cost, 'can_veto', c.can_veto,
    'copies', c.default_copies, 'active', c.active);
$$;

create function public._category_row_json(c public.categories)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('id', c.id, 'name', c.name, 'colour', c.colour, 'active', c.active);
$$;

-- ---------------------------------------------------------------------------
-- Library actions (not game actions: no game, no event log; idempotent)
-- ---------------------------------------------------------------------------

create function public.save_card(
  p_card_id text,
  p_card jsonb,
  p_client_action_id uuid,
  p_base_updated_at timestamptz default null,
  p_author_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public._require_user();
  v_prev jsonb := public._previous_result(p_client_action_id, v_uid);
  v_name text := public._author_name(v_uid, p_author_name);
  v_old public.cards;
  v_new public.cards;
  v_card_name text;
  v_category text;
  v_behaviour text;
  v_text text;
  v_params jsonb;
  v_cost text;
  v_veto boolean;
  v_copies jsonb;
  v_id text;
begin
  if v_prev is not null then
    return v_prev;
  end if;
  if p_card is null or jsonb_typeof(p_card) <> 'object' then
    raise exception 'invalid_card' using errcode = 'P0001';
  end if;

  v_card_name := btrim(coalesce(p_card ->> 'name', ''));
  v_category := p_card ->> 'category';
  v_behaviour := p_card ->> 'behaviour';
  v_text := nullif(btrim(coalesce(p_card ->> 'text', '')), '');
  v_params := coalesce(p_card -> 'params', '{}'::jsonb);
  v_cost := nullif(p_card ->> 'cast_cost', '');
  v_copies := p_card -> 'copies';

  if char_length(v_card_name) not between 1 and 80 then
    raise exception 'invalid_card_name' using errcode = 'P0001';
  end if;
  if v_text is not null and char_length(v_text) > 2000 then
    raise exception 'invalid_card_text' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.categories where id = v_category and active) then
    raise exception 'category_not_found' using errcode = 'P0001';
  end if;
  if coalesce(v_behaviour, '') not in
     ('text', 'timed', 'until_cleared', 'time_bonus', 'next_question_modifier', 'powerup', 'question_ban') then
    raise exception 'invalid_card_behaviour' using errcode = 'P0001';
  end if;
  if v_cost is not null and v_cost not in ('free', 'drink', 'shot') then
    raise exception 'invalid_card_cost' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_card -> 'can_veto') = 'boolean' then
    v_veto := (p_card ->> 'can_veto')::boolean;
  elsif p_card ? 'can_veto' and jsonb_typeof(p_card -> 'can_veto') <> 'null' then
    raise exception 'invalid_card' using errcode = 'P0001', detail = 'can_veto';
  end if;
  if v_copies is null or not public._is_int(v_copies, 0, 99) then
    raise exception 'invalid_card_copies' using errcode = 'P0001';
  end if;
  perform public._check_card_params(v_behaviour, v_params);

  if p_card_id is null then
    v_id := public._new_library_id(v_card_name, 'cards');
    insert into public.cards (id, name, category_id, behaviour, body, params, cast_cost, can_veto,
                              default_copies, sort, active, updated_by, updated_by_name, updated_at)
    values (v_id, v_card_name, v_category, v_behaviour, v_text, v_params, v_cost, v_veto,
            (v_copies #>> '{}')::integer,
            coalesce((select max(sort) + 1 from public.cards where category_id = v_category), 0),
            true, v_uid, v_name, clock_timestamp())
    returning * into v_new;
    perform public._library_changed('card', v_id, 'created', v_uid, v_name, null, public._card_row_json(v_new));
  else
    select * into v_old from public.cards where id = p_card_id for update;
    if not found then
      raise exception 'card_not_found' using errcode = 'P0001';
    end if;
    if p_base_updated_at is not null and v_old.updated_at <> p_base_updated_at then
      raise exception 'card_changed' using errcode = 'P0001';
    end if;
    update public.cards
       set name = v_card_name,
           category_id = v_category,
           behaviour = v_behaviour,
           body = v_text,
           params = v_params,
           cast_cost = v_cost,
           can_veto = v_veto,
           default_copies = (v_copies #>> '{}')::integer,
           sort = case when category_id = v_category then sort
                       else coalesce((select max(c.sort) + 1 from public.cards c where c.category_id = v_category), 0) end,
           updated_by = v_uid,
           updated_by_name = v_name,
           updated_at = clock_timestamp()
     where id = p_card_id
    returning * into v_new;
    perform public._library_changed('card', p_card_id, 'updated', v_uid, v_name,
      public._card_row_json(v_old), public._card_row_json(v_new));
  end if;

  return public._record_result(p_client_action_id, v_uid, null,
    jsonb_build_object('card_id', v_new.id, 'updated_at', v_new.updated_at));
end;
$$;

create function public.set_card_active(
  p_card_id text,
  p_active boolean,
  p_client_action_id uuid,
  p_author_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public._require_user();
  v_prev jsonb := public._previous_result(p_client_action_id, v_uid);
  v_name text := public._author_name(v_uid, p_author_name);
  v_card public.cards;
begin
  if v_prev is not null then
    return v_prev;
  end if;
  if p_active is null then
    raise exception 'invalid_card' using errcode = 'P0001';
  end if;
  select * into v_card from public.cards where id = p_card_id for update;
  if not found then
    raise exception 'card_not_found' using errcode = 'P0001';
  end if;
  if p_active and not exists (select 1 from public.categories where id = v_card.category_id and active) then
    raise exception 'category_retired' using errcode = 'P0001';
  end if;

  if v_card.active <> p_active then
    update public.cards set active = p_active, updated_by = v_uid, updated_by_name = v_name, updated_at = clock_timestamp()
     where id = p_card_id
    returning * into v_card;
    perform public._library_changed('card', p_card_id, case when p_active then 'restored' else 'retired' end,
      v_uid, v_name, null, public._card_row_json(v_card));
  end if;

  return public._record_result(p_client_action_id, v_uid, null,
    jsonb_build_object('card_id', p_card_id, 'active', v_card.active, 'updated_at', v_card.updated_at));
end;
$$;

create function public.save_category(
  p_category_id text,
  p_name text,
  p_colour text,
  p_client_action_id uuid,
  p_author_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public._require_user();
  v_prev jsonb := public._previous_result(p_client_action_id, v_uid);
  v_name text := public._author_name(v_uid, p_author_name);
  v_label text := btrim(coalesce(p_name, ''));
  v_old public.categories;
  v_new public.categories;
  v_id text;
begin
  if v_prev is not null then
    return v_prev;
  end if;
  if char_length(v_label) not between 1 and 40 then
    raise exception 'invalid_category_name' using errcode = 'P0001';
  end if;
  if coalesce(p_colour, '') !~ '^#[0-9A-Fa-f]{6}$' then
    raise exception 'invalid_category_colour' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.categories
              where lower(name) = lower(v_label) and id is distinct from p_category_id) then
    raise exception 'category_name_taken' using errcode = 'P0001';
  end if;

  if p_category_id is null then
    v_id := public._new_library_id(v_label, 'categories');
    insert into public.categories (id, name, colour, sort, created_by, updated_by, updated_by_name)
    values (v_id, v_label, upper(p_colour), coalesce((select max(sort) + 1 from public.categories), 0),
            v_uid, v_uid, v_name)
    returning * into v_new;
    perform public._library_changed('category', v_id, 'created', v_uid, v_name, null, public._category_row_json(v_new));
  else
    select * into v_old from public.categories where id = p_category_id for update;
    if not found then
      raise exception 'category_not_found' using errcode = 'P0001';
    end if;
    update public.categories
       set name = v_label, colour = upper(p_colour), updated_by = v_uid, updated_by_name = v_name, updated_at = now()
     where id = p_category_id
    returning * into v_new;
    perform public._library_changed('category', p_category_id, 'updated', v_uid, v_name,
      public._category_row_json(v_old), public._category_row_json(v_new));
  end if;

  return public._record_result(p_client_action_id, v_uid, null, jsonb_build_object('category_id', v_new.id));
end;
$$;

create function public.set_category_active(
  p_category_id text,
  p_active boolean,
  p_client_action_id uuid,
  p_author_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public._require_user();
  v_prev jsonb := public._previous_result(p_client_action_id, v_uid);
  v_name text := public._author_name(v_uid, p_author_name);
  v_cat public.categories;
begin
  if v_prev is not null then
    return v_prev;
  end if;
  if p_active is null then
    raise exception 'invalid_category' using errcode = 'P0001';
  end if;
  select * into v_cat from public.categories where id = p_category_id for update;
  if not found then
    raise exception 'category_not_found' using errcode = 'P0001';
  end if;
  if not p_active and exists (select 1 from public.cards where category_id = p_category_id and active) then
    raise exception 'category_in_use' using errcode = 'P0001';
  end if;

  if v_cat.active <> p_active then
    update public.categories set active = p_active, updated_by = v_uid, updated_by_name = v_name, updated_at = now()
     where id = p_category_id
    returning * into v_cat;
    perform public._library_changed('category', p_category_id, case when p_active then 'restored' else 'retired' end,
      v_uid, v_name, null, public._category_row_json(v_cat));
  end if;

  return public._record_result(p_client_action_id, v_uid, null,
    jsonb_build_object('category_id', p_category_id, 'active', v_cat.active));
end;
$$;

-- ---------------------------------------------------------------------------
-- Deck
-- ---------------------------------------------------------------------------

-- Copies per active card for this game: config.deck when set, else the library defaults.
-- Cards retired since the host built the deck are dropped rather than failing the start.
create or replace function public._deck_copies(p_config jsonb)
returns table (card_id text, copies integer)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_deck jsonb := p_config -> 'deck';
  v_key text;
  v_val jsonb;
begin
  if v_deck is null or jsonb_typeof(v_deck) = 'null' then
    return query
      select c.id, c.default_copies from public.cards c
        join public.categories cat on cat.id = c.category_id
       where c.active and cat.active and c.default_copies > 0;
    return;
  end if;
  if jsonb_typeof(v_deck) <> 'object' then
    raise exception 'invalid_deck' using errcode = 'P0001';
  end if;
  for v_key, v_val in select * from jsonb_each(v_deck) loop
    if not public._is_int(v_val, 0, 99) then
      raise exception 'invalid_deck' using errcode = 'P0001', detail = v_key;
    end if;
  end loop;
  return query
    select e.key, (e.value #>> '{}')::integer
      from jsonb_each(v_deck) e
      join public.cards c on c.id = e.key and c.active
      join public.categories cat on cat.id = c.category_id and cat.active
     where (e.value #>> '{}')::integer > 0;
end;
$$;

create function public.set_deck(
  p_game_id uuid,
  p_deck jsonb,
  p_client_action_id uuid
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
  v_deck jsonb;
  v_config jsonb;
  v_key text;
  v_val jsonb;
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

  if p_deck is null or jsonb_typeof(p_deck) = 'null' then
    v_deck := null;
  elsif jsonb_typeof(p_deck) <> 'object' then
    raise exception 'invalid_deck' using errcode = 'P0001';
  else
    v_deck := '{}'::jsonb;
    for v_key, v_val in select * from jsonb_each(p_deck) loop
      if not public._is_int(v_val, 0, 99)
         or not exists (select 1 from public.cards c where c.id = v_key and c.active) then
        raise exception 'invalid_deck' using errcode = 'P0001', detail = v_key;
      end if;
      v_deck := v_deck || jsonb_build_object(v_key, (v_val #>> '{}')::integer);
    end loop;
  end if;

  v_config := case when v_deck is null then v_game.config - 'deck'
                   else v_game.config || jsonb_build_object('deck', v_deck) end;
  update public.games set config = v_config where id = p_game_id;

  v_seq := public._append_event(p_game_id, 'config_changed', jsonb_build_object('config', v_config));

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq));
end;
$$;

-- update_config: as before, but config.deck always stays as set_deck left it.
create or replace function public.update_config(
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
  v_config jsonb;
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

  v_config := p_config - 'deck';
  if v_game.config ? 'deck' then
    v_config := v_config || jsonb_build_object('deck', v_game.config -> 'deck');
  end if;

  update public.games set config = v_config where id = p_game_id;

  v_seq := public._append_event(p_game_id, 'config_changed', jsonb_build_object('config', v_config));

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq));
end;
$$;

create function public.save_deck_preset(
  p_name text,
  p_deck jsonb,
  p_client_action_id uuid,
  p_author_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public._require_user();
  v_prev jsonb := public._previous_result(p_client_action_id, v_uid);
  v_name text := public._author_name(v_uid, p_author_name);
  v_label text := btrim(coalesce(p_name, ''));
  v_existing public.deck_presets;
  v_deck jsonb := '{}'::jsonb;
  v_key text;
  v_val jsonb;
  v_id uuid;
begin
  if v_prev is not null then
    return v_prev;
  end if;
  if char_length(v_label) not between 1 and 60 then
    raise exception 'invalid_preset_name' using errcode = 'P0001';
  end if;
  if p_deck is null or jsonb_typeof(p_deck) <> 'object' then
    raise exception 'invalid_deck' using errcode = 'P0001';
  end if;
  for v_key, v_val in select * from jsonb_each(p_deck) loop
    if not public._is_int(v_val, 0, 99) or not exists (select 1 from public.cards c where c.id = v_key) then
      raise exception 'invalid_deck' using errcode = 'P0001', detail = v_key;
    end if;
    if (v_val #>> '{}')::integer > 0 then
      v_deck := v_deck || jsonb_build_object(v_key, (v_val #>> '{}')::integer);
    end if;
  end loop;

  select * into v_existing from public.deck_presets where lower(name) = lower(v_label) for update;
  if found then
    if v_existing.created_by is distinct from v_uid then
      raise exception 'preset_name_taken' using errcode = 'P0001';
    end if;
    update public.deck_presets set deck = v_deck, name = v_label, updated_at = now()
     where id = v_existing.id;
    v_id := v_existing.id;
  else
    insert into public.deck_presets (name, deck, created_by, creator_name)
    values (v_label, v_deck, v_uid, v_name)
    returning id into v_id;
  end if;

  perform realtime.send(jsonb_build_object('kind', 'preset', 'id', v_id, 'action', 'saved', 'by', v_name),
    'event', 'library', true);

  return public._record_result(p_client_action_id, v_uid, null, jsonb_build_object('preset_id', v_id));
end;
$$;

create function public.delete_deck_preset(
  p_preset_id uuid,
  p_client_action_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public._require_user();
  v_prev jsonb := public._previous_result(p_client_action_id, v_uid);
  v_preset public.deck_presets;
begin
  if v_prev is not null then
    return v_prev;
  end if;
  select * into v_preset from public.deck_presets where id = p_preset_id for update;
  if not found then
    raise exception 'preset_not_found' using errcode = 'P0001';
  end if;
  if v_preset.created_by is null then
    raise exception 'preset_protected' using errcode = 'P0001';
  end if;

  delete from public.deck_presets where id = p_preset_id;

  perform realtime.send(jsonb_build_object('kind', 'preset', 'id', p_preset_id, 'action', 'deleted'),
    'event', 'library', true);

  return public._record_result(p_client_action_id, v_uid, null,
    jsonb_build_object('preset_id', p_preset_id, 'name', v_preset.name));
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke execute on function
  public._library_edits_append_only(),
  public._author_name(uuid, text),
  public._library_changed(text, text, text, uuid, text, jsonb, jsonb),
  public._new_library_id(text, text),
  public._is_int(jsonb, numeric, numeric),
  public._is_pos(jsonb),
  public._check_card_params(text, jsonb),
  public._card_row_json(public.cards),
  public._category_row_json(public.categories),
  public._deck_copies(jsonb),
  public.save_card(text, jsonb, uuid, timestamptz, text),
  public.set_card_active(text, boolean, uuid, text),
  public.save_category(text, text, text, uuid, text),
  public.set_category_active(text, boolean, uuid, text),
  public.set_deck(uuid, jsonb, uuid),
  public.update_config(uuid, jsonb, uuid, bigint),
  public.save_deck_preset(text, jsonb, uuid, text),
  public.delete_deck_preset(uuid, uuid)
from public, anon, authenticated;

grant execute on function
  public.save_card(text, jsonb, uuid, timestamptz, text),
  public.set_card_active(text, boolean, uuid, text),
  public.save_category(text, text, text, uuid, text),
  public.set_category_active(text, boolean, uuid, text),
  public.set_deck(uuid, jsonb, uuid),
  public.update_config(uuid, jsonb, uuid, bigint),
  public.save_deck_preset(text, jsonb, uuid, text),
  public.delete_deck_preset(uuid, uuid)
to authenticated;
