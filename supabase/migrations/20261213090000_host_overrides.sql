-- Host overrides: every decision the app makes automatically can be fixed by hand, so a bug
-- never stops a game. See docs/overrides.md for the audit and what each override does.
--
--   * One action, host_override(kind, params, reason). The host calls it; any hider may call
--     it for kinds that touch hider-only data (the bar, the hand, the draw pile, moving a
--     player onto the hiders). A seeker host asking for one of those only files a request
--     (public override_requested, no details); a hider approves it by calling host_override
--     with p_request_id (and the details), or declines it (kind 'decline').
--   * Each override records a public `override` event: who, what, why. Hider-only details
--     go in a hiders-only `override_detail` event with the same override_id.
--   * Every event appended while an override runs carries payload.override_id, and every row
--     it changes is captured in override_changes. Kind 'undo' restores those rows (refusing
--     undo_conflict if something changed them since) and logs override_undone; phones then
--     drop the undone override's events (src/overrides/state.ts).
--   * Paused countdowns are stored with an end of 'infinity' (hiding: an enormous hiding
--     period), so every existing deadline check treats them as still running. The time left
--     is kept in timer_pauses for resume.

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------

create table public.game_overrides (
  id uuid primary key,
  game_id uuid not null references public.games (id) on delete cascade,
  round integer not null,
  kind text not null,
  params jsonb not null,
  reason text not null,
  private boolean not null,
  by_user uuid not null,
  request_id uuid,
  summary text,
  undone_by uuid,
  created_at timestamptz not null default now()
);
create index game_overrides_game_idx on public.game_overrides (game_id);

create table public.override_changes (
  id bigserial primary key,
  override_id uuid not null references public.game_overrides (id) on delete cascade,
  tbl text not null,
  pk jsonb not null,
  op text not null check (op in ('insert', 'update', 'delete')),
  before jsonb,
  after jsonb
);
create index override_changes_override_idx on public.override_changes (override_id);

create table public.override_requests (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  round integer not null,
  kind text not null,
  params jsonb not null default '{}'::jsonb,
  reason text not null,
  requested_by uuid not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution text check (resolution in ('approved', 'declined')),
  override_id uuid
);

-- Paused countdowns: time left when paused. target_id '' for the hiding period.
create table public.timer_pauses (
  game_id uuid not null references public.games (id) on delete cascade,
  timer text not null check (timer in ('hiding', 'answer', 'effect', 'followup', 'veto_lock')),
  target_id text not null,
  remaining_s numeric not null check (remaining_s >= 0),
  paused_at timestamptz not null default now(),
  primary key (game_id, timer, target_id)
);

-- None of these are client-readable: details may be hider-only.
alter table public.game_overrides enable row level security;
alter table public.override_changes enable row level security;
alter table public.override_requests enable row level security;
alter table public.timer_pauses enable row level security;
revoke all on public.game_overrides, public.override_changes, public.override_requests, public.timer_pauses
  from anon, authenticated;

alter table public.questions add column penalty_cancelled boolean not null default false;
alter table public.questions drop constraint questions_closed_by_check;
alter table public.questions add constraint questions_closed_by_check
  check (closed_by in ('veto', 'randomize', 'void'));

-- A proof closed by an override (no photo): cancelled (not owed) or waived (drunk, no photo).
alter table public.drink_proofs add column resolution text check (resolution in ('cancelled', 'waived'));
alter table public.drink_proofs add column question_id uuid;
alter table public.drink_proofs drop constraint drink_proofs_check;
alter table public.drink_proofs add constraint drink_proofs_check
  check (case when resolution is null then (photo_path is null) = (proved_at is null)
              else photo_path is null and proved_at is not null end);

-- Freeze forced on/off by an override (null: automatic), for one round.
alter table public.games add column freeze_forced boolean;
alter table public.games add column freeze_forced_round integer;

-- ---------------------------------------------------------------------------
-- Change capture for undo
-- ---------------------------------------------------------------------------

create function public._capture_override_change()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_id text := nullif(current_setting('hd.override_id', true), '');
  v_old jsonb;
  v_new jsonb;
  v_pk jsonb;
begin
  if v_id is null then
    return null;
  end if;
  if tg_op <> 'INSERT' then v_old := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then v_new := to_jsonb(new); end if;
  if tg_table_name = 'games' then
    -- Every event bumps these; they are never restored.
    v_old := v_old - 'last_seq' - 'updated_at';
    v_new := v_new - 'last_seq' - 'updated_at';
  end if;
  if tg_op = 'UPDATE' and v_old = v_new then
    return null;
  end if;
  select jsonb_object_agg(a.attname, coalesce(v_new, v_old) -> a.attname::text) into v_pk
    from pg_index i
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
   where i.indrelid = tg_relid and i.indisprimary;
  insert into public.override_changes (override_id, tbl, pk, op, before, after)
  values (v_id::uuid, tg_table_name, v_pk, lower(tg_op), v_old, v_new);
  return null;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'games', 'players', 'questions', 'card_effects', 'card_instances', 'card_draws', 'card_modifiers',
    'curse_vetoes', 'drink_proofs', 'hider_bars', 'question_bans', 'game_venues', 'game_cards',
    'trivia_questions', 'timer_pauses'
  ] loop
    execute format(
      'create trigger %I after insert or update or delete on public.%I for each row execute function public._capture_override_change()',
      t || '_capture_override', t);
  end loop;
end;
$$;

-- Restore every row an override changed, newest change first. Refuses if a row has changed
-- since (someone played on): the host fixes that by hand instead.
create function public._undo_override(p_override_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  c public.override_changes;
  v_keys text;
  v_where text;
  v_cur jsonb;
  v_cols text;
  k text;
begin
  for c in select * from public.override_changes where override_id = p_override_id order by id desc loop
    select string_agg(format('%I', key), ', ') into v_keys from jsonb_object_keys(c.pk) key;
    v_where := format('(%s) = (select %s from jsonb_populate_record(null::public.%I, $1))', v_keys, v_keys, c.tbl);
    execute format('select to_jsonb(t) from public.%I t where %s', c.tbl, v_where) into v_cur using c.pk;
    if c.tbl = 'games' then
      v_cur := v_cur - 'last_seq' - 'updated_at';
    end if;

    if c.op = 'insert' then
      if v_cur is null or v_cur <> c.after then
        raise exception 'undo_conflict' using errcode = 'P0001', detail = c.tbl;
      end if;
      execute format('delete from public.%I where %s', c.tbl, v_where) using c.pk;
    elsif c.op = 'delete' then
      if v_cur is not null then
        raise exception 'undo_conflict' using errcode = 'P0001', detail = c.tbl;
      end if;
      execute format('insert into public.%I select * from jsonb_populate_record(null::public.%I, $1)', c.tbl, c.tbl)
        using c.before;
    else
      v_cols := null;
      for k in select key from jsonb_object_keys(c.after) key loop
        if c.before -> k is distinct from c.after -> k then
          if v_cur is null or v_cur -> k is distinct from c.after -> k then
            raise exception 'undo_conflict' using errcode = 'P0001', detail = c.tbl || '.' || k;
          end if;
          v_cols := concat_ws(', ', v_cols, format('%I', k));
        end if;
      end loop;
      if v_cols is not null then
        execute format('update public.%I set (%s) = (select %s from jsonb_populate_record(null::public.%I, $2)) where %s',
          c.tbl, v_cols, v_cols, c.tbl, v_where) using c.pk, c.before;
      end if;
    end if;
  end loop;
end;
$$;

-- Events appended during an override are tagged with it, so phones can drop them on undo.
create or replace function public._append_event(
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
  v_override text := nullif(current_setting('hd.override_id', true), '');
begin
  update public.games
     set last_seq = last_seq + 1, updated_at = now()
   where id = p_game_id
  returning last_seq into v_seq;

  if v_seq is null then
    raise exception 'game_not_found' using errcode = 'P0001';
  end if;

  insert into public.events (game_id, seq, type, visibility, actor_id, payload)
  values (p_game_id, v_seq, p_type, p_visibility, p_actor,
          coalesce(p_payload, '{}'::jsonb)
            || case when v_override is null then '{}'::jsonb else jsonb_build_object('override_id', v_override) end);

  return v_seq;
end;
$$;

-- ---------------------------------------------------------------------------
-- Existing functions, adjusted
-- ---------------------------------------------------------------------------

-- Freeze: an override can force it on or off for the round.
create or replace function public._update_freeze(p_game public.games)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_bar public.hider_bars;
  v_radius numeric := public._cfg_num(p_game.config, '{hiding_zone,freeze_when_seeker_within_m}',
                        public._cfg_num(p_game.config, '{hiding_zone,bar_radius_m}', 100));
  v_fresh_s numeric := greatest(60, 3 * public._cfg_num(p_game.config, '{seeker_location_interval_s}', 20));
  v_frozen boolean;
begin
  select * into v_bar from public.hider_bars where game_id = p_game.id and round = p_game.round;
  if not found then
    return;
  end if;

  if p_game.freeze_forced is not null and p_game.freeze_forced_round = p_game.round then
    v_frozen := p_game.freeze_forced;
  else
    select exists (
      select 1 from public.seeker_positions sp
        join public.players p on p.game_id = sp.game_id and p.user_id = sp.user_id and p.team = 'seekers'
       where sp.game_id = p_game.id and sp.round = p_game.round
         and sp.reported_at > now() - make_interval(secs => v_fresh_s::float8)
         and extensions.st_dwithin(
               extensions.st_setsrid(extensions.st_makepoint(sp.lng, sp.lat), 4326)::extensions.geography,
               v_bar.geom::extensions.geography, v_radius::float8)
    ) into v_frozen;
  end if;

  if v_frozen is distinct from v_bar.frozen then
    update public.hider_bars set frozen = v_frozen where game_id = p_game.id and round = p_game.round;
    perform public._append_event(p_game.id, 'freeze_changed',
      jsonb_build_object('round', p_game.round, 'frozen', v_frozen), 'hiders', null);
  end if;
end;
$$;

-- Missed deadlines: link the shot's proof to its question, so cancelling the penalty closes it.
create or replace function public._settle_timers(p_game_id uuid)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_game public.games;
  v_q public.questions;
  v_n integer := 0;
  v_seeking_at timestamptz;
  v_proof uuid;
begin
  select * into v_game from public.games where id = p_game_id;

  if v_game.status = 'hiding' and v_game.round_started_at is not null and v_game.hiding_period_s is not null then
    v_seeking_at := v_game.round_started_at + make_interval(secs => v_game.hiding_period_s);
    if now() >= v_seeking_at then
      update public.games set status = 'seeking' where id = p_game_id;
      perform public._append_event(p_game_id, 'seeking_started',
        jsonb_build_object('round', v_game.round, 'at', v_seeking_at), 'all', null);
      v_n := v_n + 1;
    end if;
  end if;

  for v_q in
    select * from public.questions
    where game_id = p_game_id and answered_at is null and penalised_at is null and deadline_at <= now()
    for update
  loop
    update public.questions set penalised_at = now() where id = v_q.id;
    perform public._append_event(p_game_id, 'answer_overdue', jsonb_build_object(
      'question_id', v_q.id,
      'type', v_q.type,
      'deadline_at', v_q.deadline_at,
      'team', 'hiders',
      'penalty', 'shot'
    ), 'all', null);
    v_proof := public._drink_due(v_game, 'hiders', 'shot', 'Missed answer deadline');
    if v_proof is not null then
      update public.drink_proofs set question_id = v_q.id where id = v_proof;
    end if;
    v_n := v_n + 1;
  end loop;

  return v_n;
end;
$$;

-- Vetoes chain after earlier locks; a paused lock (end 'infinity') doesn't hold the next back.
create or replace function public.veto_curse(p_game_id uuid, p_instance_id uuid, p_client_action_id uuid, p_last_seen_seq bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public._require_user();
  v_prev jsonb := public._previous_result(p_client_action_id, v_uid);
  v_game public.games;
  v_inst public.card_instances;
  v_card public.game_cards;
  v_e public.card_effects;
  v_used integer;
  v_lock_s integer;
  v_starts timestamptz;
  v_veto public.curse_vetoes;
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
  perform public._require_fresh(p_game_id, v_uid, p_last_seen_seq);

  select * into v_inst from public.card_instances
   where id = p_instance_id and game_id = p_game_id and round = v_game.round and location = 'played' for update;
  if not found then
    raise exception 'card_not_found' using errcode = 'P0001';
  end if;
  select * into v_card from public.game_cards
   where game_id = p_game_id and round = v_game.round and card_id = v_inst.card_id;
  if v_card.can_veto is not true then
    raise exception 'cannot_veto' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.curse_vetoes where instance_id = v_inst.id) then
    raise exception 'already_vetoed' using errcode = 'P0001';
  end if;

  select * into v_e from public.card_effects where instance_id = v_inst.id for update;
  if found and (v_e.status in ('cleared', 'vetoed')
                or (v_e.behaviour = 'timed' and now() >= coalesce(v_e.followup_ends_at, v_e.ends_at))) then
    raise exception 'curse_over' using errcode = 'P0001';
  end if;

  select count(*) into v_used from public.curse_vetoes where game_id = p_game_id and round = v_game.round;
  v_lock_s := (public._cfg_num(v_game.config, '{veto,base_lock_s}', 600)
               + public._cfg_num(v_game.config, '{veto,step_s}', 600) * v_used)::integer;
  select greatest(now(), coalesce(max(lock_ends_at) filter (where isfinite(lock_ends_at)), now())) into v_starts
    from public.curse_vetoes where game_id = p_game_id and round = v_game.round;

  insert into public.curse_vetoes (game_id, round, instance_id, vetoed_by, lock_s, lock_starts_at, lock_ends_at)
  values (p_game_id, v_game.round, v_inst.id, v_uid, v_lock_s, v_starts, v_starts + make_interval(secs => v_lock_s))
  returning * into v_veto;

  if v_e.id is not null then
    update public.card_effects set status = 'vetoed', cleared_at = now() where id = v_e.id;
  end if;
  delete from public.question_bans where instance_id = v_inst.id;

  v_seq := public._append_event(p_game_id, 'curse_vetoed', jsonb_build_object(
    'round', v_game.round,
    'instance_id', v_inst.id,
    'effect_id', v_e.id,
    'card_id', v_card.card_id,
    'name', v_card.name,
    'veto_number', v_used + 1,
    'lock_s', v_lock_s,
    'lock_starts_at', v_veto.lock_starts_at,
    'lock_ends_at', v_veto.lock_ends_at,
    'penalty', coalesce(v_game.config #>> '{veto,penalty}', 'each seeker drinks')
  ));
  perform public._drink_due(v_game, 'seekers', 'drink', 'Veto: ' || v_card.name);

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', (select last_seq from public.games where id = p_game_id),
                       'lock_ends_at', v_veto.lock_ends_at));
end;
$$;

-- ---------------------------------------------------------------------------
-- Overrides
-- ---------------------------------------------------------------------------

-- Kinds that touch hider-only data: a seeker host can only request them.
create function public._override_is_private(p_game_id uuid, p_kind text, p_params jsonb)
returns boolean
language sql
stable
set search_path = ''
as $$
  select case
    when p_kind in ('set_bar', 'give_card', 'remove_card', 'draw_cards', 'reshuffle') then true
    when p_kind = 'move_player' then p_params ->> 'team' = 'hiders'
    when p_kind = 'undo' then coalesce((select o.private from public.game_overrides o
                                         where o.game_id = p_game_id and o.id::text = p_params ->> 'override_id'), false)
    else false
  end;
$$;

create function public._param_uuid(p_params jsonb, p_key text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
begin
  return (p_params ->> p_key)::uuid;
exception when invalid_text_representation then
  raise exception 'invalid_override' using errcode = 'P0001', detail = p_key;
end;
$$;

create function public._iso(p timestamptz)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select case when p is null or not isfinite(p) then 'null'::jsonb else to_jsonb(p) end;
$$;

-- Change one countdown: add (seconds, may be negative), end, pause or resume.
create function public._override_timer(p_game public.games, p_params jsonb)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_timer text := p_params ->> 'timer';
  v_op text := p_params ->> 'op';
  v_s numeric := 0;
  v_target text := '';
  v_id uuid;
  v_end timestamptz;
  v_new timestamptz;
  v_pause public.timer_pauses;
  v_q public.questions;
  v_e public.card_effects;
  v_v public.curse_vetoes;
  v_status public.game_status := p_game.status;
  v_left numeric;
begin
  if v_timer not in ('hiding', 'answer', 'effect', 'followup', 'veto_lock')
     or v_op not in ('add', 'end', 'pause', 'resume') then
    raise exception 'invalid_override' using errcode = 'P0001', detail = 'timer, op';
  end if;
  if v_op = 'add' then
    if jsonb_typeof(p_params -> 'seconds') <> 'number' or (p_params ->> 'seconds')::numeric = 0
       or abs((p_params ->> 'seconds')::numeric) > 86400 then
      raise exception 'invalid_override' using errcode = 'P0001', detail = 'seconds';
    end if;
    v_s := round((p_params ->> 'seconds')::numeric);
  end if;

  case v_timer
    when 'hiding' then
      v_end := p_game.round_started_at + make_interval(secs => p_game.hiding_period_s);
    when 'answer' then
      v_id := public._param_uuid(p_params, 'id');
      select * into v_q from public.questions where id = v_id and game_id = p_game.id for update;
      if not found then
        raise exception 'question_not_found' using errcode = 'P0001';
      end if;
      if v_q.answered_at is not null then
        raise exception 'question_not_pending' using errcode = 'P0001';
      end if;
      v_end := v_q.deadline_at;
    when 'effect', 'followup' then
      v_id := public._param_uuid(p_params, 'id');
      v_e := public._lock_effect(p_game, v_id);
      v_end := case v_timer when 'effect' then v_e.ends_at else v_e.followup_ends_at end;
      if v_end is null then
        raise exception 'no_timer' using errcode = 'P0001';
      end if;
    when 'veto_lock' then
      v_id := public._param_uuid(p_params, 'id');
      select * into v_v from public.curse_vetoes
       where instance_id = v_id and game_id = p_game.id and round = p_game.round for update;
      if not found then
        raise exception 'veto_not_found' using errcode = 'P0001';
      end if;
      v_end := v_v.lock_ends_at;
  end case;
  if v_id is not null then
    v_target := v_id::text;
  end if;

  select * into v_pause from public.timer_pauses
   where game_id = p_game.id and timer = v_timer and target_id = v_target for update;

  case v_op
    when 'add' then
      if v_pause.game_id is not null then
        update public.timer_pauses set remaining_s = greatest(0, remaining_s + v_s)
         where game_id = p_game.id and timer = v_timer and target_id = v_target;
        v_new := 'infinity';
      else
        v_new := v_end + make_interval(secs => v_s::float8);
      end if;
    when 'end' then
      delete from public.timer_pauses where game_id = p_game.id and timer = v_timer and target_id = v_target;
      v_new := now();
    when 'pause' then
      if v_pause.game_id is not null then
        raise exception 'timer_paused' using errcode = 'P0001';
      end if;
      if v_end <= now() then
        raise exception 'timer_not_running' using errcode = 'P0001';
      end if;
      insert into public.timer_pauses (game_id, timer, target_id, remaining_s)
      values (p_game.id, v_timer, v_target, extract(epoch from v_end - now()));
      v_new := 'infinity';
    when 'resume' then
      if v_pause.game_id is null then
        raise exception 'timer_not_paused' using errcode = 'P0001';
      end if;
      delete from public.timer_pauses where game_id = p_game.id and timer = v_timer and target_id = v_target;
      v_new := now() + make_interval(secs => v_pause.remaining_s::float8);
  end case;

  case v_timer
    when 'hiding' then
      update public.games set hiding_period_s = case
          when not isfinite(v_new) then 2147483647
          else greatest(0, ceil(extract(epoch from v_new - round_started_at)))::integer end,
        -- More hiding time after seeking began puts the round back in hiding.
        status = case when isfinite(v_new) and v_new <= now() then status
                      when status = 'seeking' then 'hiding'::public.game_status else status end
       where id = p_game.id
      returning status into v_status;
    when 'answer' then
      update public.questions set deadline_at = v_new where id = v_id;
    when 'effect' then
      update public.card_effects set ends_at = v_new where id = v_id;
    when 'followup' then
      update public.card_effects set followup_ends_at = v_new where id = v_id;
    when 'veto_lock' then
      update public.curse_vetoes set lock_ends_at = v_new where id = v_v.id;
  end case;

  select remaining_s into v_left from public.timer_pauses
   where game_id = p_game.id and timer = v_timer and target_id = v_target;
  perform public._append_event(p_game.id, 'timer_changed', jsonb_build_object(
    'round', p_game.round,
    'timer', v_timer,
    'id', v_id,
    'op', v_op,
    'ends_at', public._iso(v_new),
    'paused_left_s', v_left,
    'status', v_status,
    'hiding_period_s', case when v_timer = 'hiding' then
      (select hiding_period_s from public.games where id = p_game.id) end));

  return case v_timer
      when 'hiding' then 'hiding period'
      when 'answer' then 'answer deadline'
      when 'effect' then 'curse timer'
      when 'followup' then 'follow-on timer'
      else 'veto lock' end
    || case v_op
      when 'add' then format(' %s%s min', case when v_s > 0 then '+' else '' end, round(v_s / 60.0, 1))
      when 'end' then ' ended'
      when 'pause' then ' paused'
      else ' resumed' end;
end;
$$;

create function public.host_override(
  p_game_id uuid,
  p_kind text,
  p_params jsonb,
  p_reason text,
  p_client_action_id uuid,
  p_last_seen_seq bigint,
  p_request_id uuid default null
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
  v_me public.players;
  v_is_host boolean;
  v_is_hider boolean;
  v_req public.override_requests;
  v_kind text;
  v_params jsonb;
  v_reason text;
  v_private boolean;
  v_oid uuid := gen_random_uuid();
  v_summary text;
  v_detail text;
  v_seq bigint;
  -- per-kind
  v_q public.questions;
  v_qt public.question_types;
  v_option jsonb;
  v_e public.card_effects;
  v_d public.drink_proofs;
  v_v public.curse_vetoes;
  v_p public.players;
  v_gc public.game_cards;
  v_inst uuid;
  v_id uuid;
  v_text text;
  v_team text;
  v_cost text;
  v_n integer;
  v_pick integer;
  v_was_pending boolean;
  v_late boolean;
  v_reward jsonb;
  v_mult numeric := 1;
  v_draw integer;
  v_qparams jsonb;
  v_bar public.hider_bars;
  v_vid text;
  v_vname text;
  v_vgeom extensions.geometry;
  v_venue public.game_venues;
  v_target public.game_overrides;
  v_bans jsonb;
begin
  if v_prev is not null then
    return v_prev;
  end if;

  v_game := public._lock_game(p_game_id);
  select * into v_me from public.players where game_id = p_game_id and user_id = v_uid;
  if not found then
    raise exception 'not_a_player' using errcode = 'P0001';
  end if;
  v_is_host := v_game.host_id = v_uid;
  v_is_hider := v_me.team = 'hiders';

  if p_request_id is not null then
    select * into v_req from public.override_requests where id = p_request_id and game_id = p_game_id for update;
    if not found or v_req.resolved_at is not null then
      raise exception 'request_not_open' using errcode = 'P0001';
    end if;
    if p_kind = 'decline' then
      if not (v_is_hider or v_req.requested_by = v_uid) then
        raise exception 'hiders_only' using errcode = 'P0001';
      end if;
      perform public._require_fresh(p_game_id, v_uid, p_last_seen_seq);
      update public.override_requests set resolved_at = now(), resolution = 'declined' where id = v_req.id;
      v_seq := public._append_event(p_game_id, 'override_declined', jsonb_build_object(
        'request_id', v_req.id, 'kind', v_req.kind, 'by', v_uid));
      return public._record_result(p_client_action_id, v_uid, p_game_id,
        jsonb_build_object('game_id', p_game_id, 'seq', v_seq));
    end if;
    if not v_is_hider then
      raise exception 'hiders_only' using errcode = 'P0001';
    end if;
    v_kind := v_req.kind;
    v_params := coalesce(p_params, v_req.params);
    v_reason := v_req.reason;
  else
    v_kind := p_kind;
    v_params := coalesce(p_params, '{}'::jsonb);
    v_reason := btrim(coalesce(p_reason, ''));
    if char_length(v_reason) not between 1 and 120 then
      raise exception 'invalid_reason' using errcode = 'P0001';
    end if;
  end if;

  if v_kind is null or v_kind not in (
    'cancel_penalty', 'add_penalty', 'cancel_drink', 'waive_proof', 'timer', 'freeze',
    'set_answer', 'void_answer', 'reopen_question', 'ask_question', 'lift_ban', 'set_blocking',
    'clear_effect', 'reinstate_effect', 'cancel_veto', 'set_hand_limit', 'cancel_move',
    'move_player', 'set_host', 'set_bar', 'give_card', 'remove_card', 'draw_cards', 'reshuffle', 'undo'
  ) then
    raise exception 'unknown_override' using errcode = 'P0001';
  end if;
  if jsonb_typeof(v_params) <> 'object' then
    raise exception 'invalid_override' using errcode = 'P0001';
  end if;
  if v_game.status = 'ended' then
    raise exception 'game_ended' using errcode = 'P0001';
  end if;
  if v_game.status not in ('hiding', 'seeking') and v_kind <> 'set_host' then
    raise exception 'round_not_running' using errcode = 'P0001';
  end if;
  perform public._require_fresh(p_game_id, v_uid, p_last_seen_seq);

  v_private := public._override_is_private(p_game_id, v_kind, v_params);
  if p_request_id is null then
    if v_private and not v_is_hider then
      if not v_is_host then
        raise exception 'host_only' using errcode = 'P0001';
      end if;
      -- A seeker host never handles hider-only data: a hider does it (or says no).
      insert into public.override_requests (game_id, round, kind, params, reason, requested_by)
      values (p_game_id, v_game.round, v_kind,
              case when v_kind in ('move_player', 'undo') then v_params else '{}'::jsonb end,
              v_reason, v_uid)
      returning * into v_req;
      v_seq := public._append_event(p_game_id, 'override_requested', jsonb_build_object(
        'request_id', v_req.id, 'kind', v_kind, 'reason', v_reason, 'by', v_uid, 'params', v_req.params));
      return public._record_result(p_client_action_id, v_uid, p_game_id,
        jsonb_build_object('game_id', p_game_id, 'seq', v_seq, 'request_id', v_req.id, 'pending', true));
    elsif not v_private and not v_is_host then
      raise exception 'host_only' using errcode = 'P0001';
    end if;
  end if;

  insert into public.game_overrides (id, game_id, round, kind, params, reason, private, by_user, request_id)
  values (v_oid, p_game_id, v_game.round, v_kind, v_params, v_reason, v_private, v_uid, p_request_id);
  perform set_config('hd.override_id', v_oid::text, true);

  case v_kind
    -- ------------------------------------------------------------- penalties and drinks
    when 'cancel_penalty' then
      select * into v_q from public.questions
       where id = public._param_uuid(v_params, 'question_id') and game_id = p_game_id for update;
      if not found then
        raise exception 'question_not_found' using errcode = 'P0001';
      end if;
      if v_q.penalised_at is null or v_q.penalty_cancelled then
        raise exception 'no_penalty' using errcode = 'P0001';
      end if;
      update public.questions set penalty_cancelled = true where id = v_q.id;
      update public.drink_proofs set resolution = 'cancelled', proved_at = now(), proved_by = v_uid
       where question_id = v_q.id and proved_at is null
      returning * into v_d;
      perform public._append_event(p_game_id, 'penalty_cancelled', jsonb_build_object(
        'round', v_q.round, 'question_id', v_q.id, 'proof_id', v_d.id));
      if v_d.id is not null then
        perform public._append_event(p_game_id, 'drink_resolved', jsonb_build_object(
          'round', v_d.round, 'proof_id', v_d.id, 'team', v_d.team, 'resolution', 'cancelled'));
      end if;
      v_summary := format('Cancelled the missed-deadline shot (%s question)', v_q.type);

    when 'add_penalty' then
      v_team := v_params ->> 'team';
      v_cost := coalesce(v_params ->> 'cost', 'shot');
      v_text := coalesce(nullif(btrim(v_params ->> 'label'), ''), 'Penalty');
      if v_team not in ('hiders', 'seekers') or v_cost not in ('drink', 'shot') or char_length(v_text) > 80 then
        raise exception 'invalid_override' using errcode = 'P0001', detail = 'team, cost, label';
      end if;
      v_id := public._drink_due(v_game, v_team::public.team, v_cost, v_text);
      perform public._append_event(p_game_id, 'penalty_added', jsonb_build_object(
        'round', v_game.round, 'team', v_team, 'cost', v_cost, 'label', v_text, 'proof_id', v_id));
      v_summary := format('Added a %s for the %s: %s', v_cost, v_team, v_text);

    when 'cancel_drink', 'waive_proof' then
      select * into v_d from public.drink_proofs
       where id = public._param_uuid(v_params, 'proof_id') and game_id = p_game_id for update;
      if not found then
        raise exception 'proof_not_found' using errcode = 'P0001';
      end if;
      if v_d.proved_at is not null then
        raise exception 'proof_not_pending' using errcode = 'P0001';
      end if;
      update public.drink_proofs
         set resolution = case v_kind when 'cancel_drink' then 'cancelled' else 'waived' end,
             proved_at = now(), proved_by = v_uid
       where id = v_d.id;
      perform public._append_event(p_game_id, 'drink_resolved', jsonb_build_object(
        'round', v_d.round, 'proof_id', v_d.id, 'team', v_d.team,
        'resolution', case v_kind when 'cancel_drink' then 'cancelled' else 'waived' end));
      v_summary := case v_kind when 'cancel_drink' then 'Cancelled: ' else 'Marked done without a photo: ' end
        || v_d.label;

    -- ------------------------------------------------------------- timers and freeze
    when 'timer' then
      v_summary := public._override_timer(v_game, v_params);
      v_summary := upper(left(v_summary, 1)) || substr(v_summary, 2);
    when 'freeze' then
      if v_params ? 'frozen' and jsonb_typeof(v_params -> 'frozen') not in ('boolean', 'null') then
        raise exception 'invalid_override' using errcode = 'P0001', detail = 'frozen';
      end if;
      update public.games
         set freeze_forced = (v_params ->> 'frozen')::boolean, freeze_forced_round = round
       where id = p_game_id
      returning * into v_game;
      perform public._update_freeze(v_game);
      perform public._append_event(p_game_id, 'freeze_forced', jsonb_build_object(
        'round', v_game.round, 'forced', v_params -> 'frozen'));
      v_summary := case (v_params ->> 'frozen')::boolean
        when true then 'Forced the hider''s freeze alert on'
        when false then 'Forced the hider''s freeze alert off'
        else 'Freeze alert back to automatic' end;

    -- ------------------------------------------------------------- questions
    when 'set_answer' then
      select * into v_q from public.questions
       where id = public._param_uuid(v_params, 'question_id') and game_id = p_game_id for update;
      if not found then
        raise exception 'question_not_found' using errcode = 'P0001';
      end if;
      v_text := btrim(coalesce(v_params ->> 'answer', ''));
      if char_length(v_text) not between 1 and 500 then
        raise exception 'invalid_answer' using errcode = 'P0001';
      end if;
      v_was_pending := v_q.answered_at is null;
      v_late := case when v_was_pending then now() > v_q.deadline_at else coalesce(v_q.late, false) end;
      update public.questions
         set answer = v_text, closed_by = null, late = v_late,
             answered_by = coalesce(answered_by, v_uid), answered_at = coalesce(answered_at, now())
       where id = v_q.id
      returning * into v_q;
      if v_was_pending and coalesce(v_params ->> 'draw', 'true') <> 'false' and v_q.round = v_game.round then
        select e.payload -> 'reward' into v_reward from public.events e
         where e.game_id = p_game_id and e.type = 'question_asked' and e.payload ->> 'question_id' = v_q.id::text
         order by e.seq desc limit 1;
        select coalesce(exp(sum(ln(reward_multiplier))), 1) into v_mult from public.card_modifiers
         where game_id = p_game_id and round = v_game.round and used_at is null;
        update public.card_modifiers set used_question_id = v_q.id, used_at = now()
         where game_id = p_game_id and round = v_game.round and used_at is null;
        if jsonb_typeof(v_reward -> 'draw') = 'number' then
          v_draw := round((v_reward ->> 'draw')::numeric * v_mult)::integer;
          v_pick := round(coalesce((v_reward ->> 'pick')::numeric, 1) * v_mult)::integer;
        end if;
      end if;
      perform public._append_event(p_game_id, 'question_answered', jsonb_build_object(
        'question_id', v_q.id, 'type', v_q.type, 'answer', v_text, 'answered_by', v_q.answered_by,
        'answered_at', v_q.answered_at, 'late', v_late, 'by_override', true)
        || case when v_mult <> 1 then jsonb_build_object('reward_multiplier', round(v_mult, 3),
                  'reward', jsonb_build_object('draw', v_draw, 'pick', v_pick)) else '{}'::jsonb end);
      if v_draw is not null then
        perform public._draw_reward(v_game, v_q.id, v_draw, v_pick);
      end if;
      v_summary := format('%s the %s answer by hand: %s',
        case when v_was_pending then 'Entered' else 'Changed' end, v_q.type, left(v_text, 60));

    when 'void_answer' then
      select * into v_q from public.questions
       where id = public._param_uuid(v_params, 'question_id') and game_id = p_game_id for update;
      if not found then
        raise exception 'question_not_found' using errcode = 'P0001';
      end if;
      if v_q.closed_by = 'void' then
        raise exception 'already_void' using errcode = 'P0001';
      end if;
      update public.questions
         set answer = null, closed_by = 'void', answered_at = coalesce(answered_at, now()),
             late = coalesce(late, false)
       where id = v_q.id;
      perform public._append_event(p_game_id, 'question_voided', jsonb_build_object(
        'round', v_q.round, 'question_id', v_q.id));
      v_summary := format('Voided the %s question (no answer, no shading)', v_q.type);

    when 'reopen_question' then
      select * into v_q from public.questions
       where id = public._param_uuid(v_params, 'question_id') and game_id = p_game_id for update;
      if not found then
        raise exception 'question_not_found' using errcode = 'P0001';
      end if;
      if exists (select 1 from public.questions where game_id = p_game_id and answered_at is null) then
        raise exception 'question_pending' using errcode = 'P0001';
      end if;
      select * into v_qt from public.question_types where city = v_game.city and type = v_q.type;
      v_n := coalesce(nullif(floor(public._cfg_num(v_params, '{deadline_s}', 0)), 0)::integer,
                      public._answer_deadline_s(v_game.config, v_q.type, coalesce(v_qt.extra, '{}'::jsonb)));
      if v_n not between 1 and 86400 then
        raise exception 'invalid_override' using errcode = 'P0001', detail = 'deadline_s';
      end if;
      update public.questions
         set answer = null, answered_by = null, answered_at = null, late = null, closed_by = null,
             penalised_at = null, penalty_cancelled = false, deadline_at = now() + make_interval(secs => v_n)
       where id = v_q.id
      returning * into v_q;
      perform public._append_event(p_game_id, 'question_reopened', jsonb_build_object(
        'round', v_q.round, 'question_id', v_q.id, 'deadline_at', v_q.deadline_at, 'deadline_s', v_n));
      v_summary := format('Reopened the %s question (%s min to answer)', v_q.type, round(v_n / 60.0, 1));

    when 'ask_question' then
      if exists (select 1 from public.questions where game_id = p_game_id and answered_at is null) then
        raise exception 'question_pending' using errcode = 'P0001';
      end if;
      select * into v_qt from public.question_types where city = v_game.city and type = v_params ->> 'type';
      if not found then
        raise exception 'question_type_not_found' using errcode = 'P0001';
      end if;
      select o into v_option from jsonb_array_elements(v_qt.options) o where o ->> 'id' = v_params ->> 'option_id';
      if v_option is null then
        raise exception 'option_not_found' using errcode = 'P0001';
      end if;
      -- Skips blocks, bans, the hiding period and a pending move. If the app can't work out
      -- the question's map data, it goes out without it (answered and shaded by hand).
      begin
        v_qparams := public._question_params(v_game, v_qt.type, v_option, v_qt.extra,
          coalesce(v_params -> 'params', '{}'::jsonb));
      exception when sqlstate 'P0001' then
        v_qparams := jsonb_strip_nulls(jsonb_build_object(
          'label', v_option ->> 'label', 'distance_m', v_option -> 'distance_m', 'manual', true));
      end;
      perform public._insert_question(v_game, v_qt, v_option ->> 'id', v_qparams, v_uid,
        jsonb_build_object('by_override', true));
      v_summary := format('Asked a %s question (%s), skipping the app''s checks', v_qt.type,
        coalesce(v_option ->> 'label', v_option ->> 'id'));

    when 'lift_ban' then
      delete from public.question_bans
       where game_id = p_game_id and round = v_game.round
         and type = v_params ->> 'type' and option_id = v_params ->> 'option_id';
      if not found then
        raise exception 'ban_not_found' using errcode = 'P0001';
      end if;
      perform public._append_event(p_game_id, 'ban_lifted', jsonb_build_object(
        'round', v_game.round, 'type', v_params ->> 'type', 'option_id', v_params ->> 'option_id'));
      v_summary := format('Lifted the ban on %s %s', v_params ->> 'type', v_params ->> 'option_id');

    -- ------------------------------------------------------------- cards and effects
    when 'set_blocking' then
      v_e := public._lock_effect(v_game, public._param_uuid(v_params, 'effect_id'));
      if jsonb_typeof(v_params -> 'blocks') <> 'boolean' then
        raise exception 'invalid_override' using errcode = 'P0001', detail = 'blocks';
      end if;
      update public.card_effects set blocks_questions = (v_params ->> 'blocks')::boolean where id = v_e.id;
      perform public._append_event(p_game_id, 'effect_changed', jsonb_build_object(
        'round', v_game.round, 'effect_id', v_e.id, 'blocks_questions', (v_params ->> 'blocks')::boolean));
      v_summary := format('%s: %s', (select name from public.game_cards where game_id = p_game_id
                                       and round = v_game.round and card_id = v_e.card_id),
        case when (v_params ->> 'blocks')::boolean then 'blocks questions again' else 'no longer blocks questions' end);

    when 'clear_effect' then
      v_e := public._lock_effect(v_game, public._param_uuid(v_params, 'effect_id'));
      if v_e.status in ('cleared', 'vetoed') then
        raise exception 'effect_not_active' using errcode = 'P0001';
      end if;
      update public.card_effects set status = 'cleared', cleared_at = now() where id = v_e.id;
      for v_d in
        update public.drink_proofs set resolution = 'waived', proved_at = now(), proved_by = v_uid
         where effect_id = v_e.id and proved_at is null
        returning *
      loop
        perform public._append_event(p_game_id, 'drink_resolved', jsonb_build_object(
          'round', v_d.round, 'proof_id', v_d.id, 'team', v_d.team, 'resolution', 'waived'));
      end loop;
      perform public._append_event(p_game_id, 'effect_cleared', jsonb_build_object(
        'round', v_game.round, 'effect_id', v_e.id, 'by_override', true));
      v_summary := format('Cleared %s', (select name from public.game_cards where game_id = p_game_id
                                           and round = v_game.round and card_id = v_e.card_id));

    when 'reinstate_effect' then
      v_e := public._lock_effect(v_game, public._param_uuid(v_params, 'effect_id'));
      if v_e.status = 'active' and (v_e.behaviour <> 'timed' or v_e.ends_at > now()) then
        raise exception 'effect_active' using errcode = 'P0001';
      end if;
      select * into v_gc from public.game_cards where game_id = p_game_id and round = v_game.round and card_id = v_e.card_id;
      if v_e.behaviour = 'timed' then
        v_n := coalesce(nullif(floor(public._cfg_num(v_params, '{seconds}', 0)), 0),
                        public._cfg_num(v_gc.params, '{duration_s}', 600))::integer;
        if v_n not between 1 and 86400 then
          raise exception 'invalid_override' using errcode = 'P0001', detail = 'seconds';
        end if;
      end if;
      update public.card_effects
         set status = 'active', cleared_at = null, clear_requested_by = null,
             ends_at = case when behaviour = 'timed' then now() + make_interval(secs => v_n) end,
             followup_ends_at = null
       where id = v_e.id
      returning * into v_e;
      perform public._append_event(p_game_id, 'effect_reinstated', jsonb_build_object(
        'round', v_game.round, 'effect_id', v_e.id, 'ends_at', public._iso(v_e.ends_at), 'duration_s', v_n));
      v_summary := format('Put %s back in force', v_gc.name);

    when 'cancel_veto' then
      select * into v_v from public.curse_vetoes
       where instance_id = public._param_uuid(v_params, 'instance_id') and game_id = p_game_id
         and round = v_game.round for update;
      if not found then
        raise exception 'veto_not_found' using errcode = 'P0001';
      end if;
      delete from public.curse_vetoes where id = v_v.id;
      delete from public.timer_pauses where game_id = p_game_id and timer = 'veto_lock' and target_id = v_v.instance_id::text;
      update public.card_effects set status = 'active', cleared_at = null
       where instance_id = v_v.instance_id and status = 'vetoed'
      returning * into v_e;
      -- Bans the curse placed come back (from its card_played event).
      select e.payload -> 'bans' into v_bans from public.events e
       where e.game_id = p_game_id and e.type = 'card_played' and e.payload ->> 'instance_id' = v_v.instance_id::text
       order by e.seq desc limit 1;
      insert into public.question_bans (game_id, round, type, option_id, instance_id)
      select p_game_id, v_game.round, b ->> 'type', b ->> 'option_id', v_v.instance_id
        from jsonb_array_elements(coalesce(v_bans, '[]'::jsonb)) b
      on conflict do nothing;
      select g.* into v_gc from public.game_cards g join public.card_instances i on i.card_id = g.card_id
       and i.game_id = g.game_id and i.round = g.round where i.id = v_v.instance_id;
      update public.drink_proofs set resolution = 'cancelled', proved_at = now(), proved_by = v_uid
       where game_id = p_game_id and team = 'seekers' and proved_at is null
         and created_at = v_v.vetoed_at and label = 'Veto: ' || v_gc.name
      returning * into v_d;
      perform public._append_event(p_game_id, 'veto_cancelled', jsonb_build_object(
        'round', v_game.round, 'instance_id', v_v.instance_id, 'effect_id', v_e.id,
        'bans', coalesce(v_bans, '[]'::jsonb)));
      if v_d.id is not null then
        perform public._append_event(p_game_id, 'drink_resolved', jsonb_build_object(
          'round', v_d.round, 'proof_id', v_d.id, 'team', v_d.team, 'resolution', 'cancelled'));
      end if;
      v_summary := format('Cancelled the veto of %s (lock and veto drink cancelled)', v_gc.name);

    when 'set_hand_limit' then
      v_n := floor(public._cfg_num(v_params, '{limit}', 0))::integer;
      if v_n not between 1 and 30 then
        raise exception 'invalid_override' using errcode = 'P0001', detail = 'limit';
      end if;
      update public.games set config = jsonb_set(config, '{hand_limit}', to_jsonb(v_n)) where id = p_game_id;
      perform public._append_event(p_game_id, 'hand_limit_changed', jsonb_build_object(
        'round', v_game.round, 'hand_limit', v_n));
      v_summary := format('Hand limit set to %s', v_n);

    when 'cancel_move' then
      update public.hider_bars set move_pending = false
       where game_id = p_game_id and round = v_game.round and move_pending;
      if not found then
        raise exception 'not_moving' using errcode = 'P0001';
      end if;
      perform public._append_event(p_game_id, 'move_cancelled', jsonb_build_object('round', v_game.round));
      v_summary := 'Cancelled the hider''s move: they stay at their bar and questions can be asked';

    -- ------------------------------------------------------------- players
    when 'move_player' then
      select * into v_p from public.players
       where game_id = p_game_id and user_id = public._param_uuid(v_params, 'user_id') for update;
      if not found then
        raise exception 'player_not_found' using errcode = 'P0001';
      end if;
      if v_params ->> 'team' not in ('hiders', 'seekers') then
        raise exception 'invalid_override' using errcode = 'P0001', detail = 'team';
      end if;
      if v_p.team::text = v_params ->> 'team' then
        raise exception 'same_team' using errcode = 'P0001';
      end if;
      update public.players set team = (v_params ->> 'team')::public.team
       where game_id = p_game_id and user_id = v_p.user_id;
      if v_params ->> 'team' = 'hiders' then
        delete from public.seeker_positions where game_id = p_game_id and user_id = v_p.user_id;
      end if;
      perform public._append_event(p_game_id, 'team_changed', jsonb_build_object(
        'user_id', v_p.user_id, 'team', v_params ->> 'team', 'by', v_uid));
      perform public._update_freeze(v_game);
      v_summary := format('Moved %s to the %s', v_p.name, v_params ->> 'team');

    when 'set_host' then
      select * into v_p from public.players
       where game_id = p_game_id and user_id = public._param_uuid(v_params, 'user_id');
      if not found then
        raise exception 'player_not_found' using errcode = 'P0001';
      end if;
      if v_p.user_id = v_game.host_id then
        raise exception 'already_host' using errcode = 'P0001';
      end if;
      update public.games set host_id = v_p.user_id where id = p_game_id;
      update public.players set is_host = (user_id = v_p.user_id) where game_id = p_game_id;
      perform public._append_event(p_game_id, 'host_changed', jsonb_build_object('user_id', v_p.user_id, 'by', v_uid));
      v_summary := format('%s is now the host', v_p.name);

    -- ------------------------------------------------------------- hider-only
    when 'set_bar' then
      if v_params ? 'venue_id' then
        select b.feature_id, b.name, b.geom into v_vid, v_vname, v_vgeom
          from public._valid_bars(v_game) b where b.feature_id = v_params ->> 'venue_id';
        if v_vid is null then
          -- Any venue the app knows, even one it refuses (hidden, outside the area, unlisted).
          select f.feature_id, f.name, f.geom into v_vid, v_vname, v_vgeom from public.map_features f
           where f.city = v_game.city and f.layer = 'venues' and f.feature_id = v_params ->> 'venue_id';
        end if;
        if v_vid is null then
          select g.feature_id, g.name, g.geom into v_vid, v_vname, v_vgeom from public.game_venues g
           where g.game_id = p_game_id and g.feature_id = v_params ->> 'venue_id';
        end if;
        if v_vid is null then
          raise exception 'venue_not_found' using errcode = 'P0001';
        end if;
      else
        v_vname := btrim(coalesce(v_params ->> 'name', ''));
        if char_length(v_vname) not between 1 and 60
           or jsonb_typeof(v_params -> 'lng') <> 'number' or jsonb_typeof(v_params -> 'lat') <> 'number'
           or (v_params ->> 'lng')::float8 not between -180 and 180
           or (v_params ->> 'lat')::float8 not between -90 and 90 then
          raise exception 'invalid_override' using errcode = 'P0001', detail = 'venue_id or name, lng, lat';
        end if;
        -- A bar the app doesn't list: added for this round only, hider-only until it ends.
        insert into public.game_venues (game_id, feature_id, name, geom, round, added_by)
        values (p_game_id, 'custom:' || gen_random_uuid()::text, v_vname,
                extensions.st_setsrid(extensions.st_makepoint((v_params ->> 'lng')::float8, (v_params ->> 'lat')::float8), 4326),
                v_game.round, v_uid)
        returning * into v_venue;
        perform public._append_event(p_game_id, 'venue_added', jsonb_build_object('venue', public._venue_json(v_venue)), 'hiders');
        v_vid := v_venue.feature_id;
        v_vgeom := v_venue.geom;
      end if;

      select * into v_bar from public.hider_bars where game_id = p_game_id and round = v_game.round for update;
      if found then
        update public.hider_bars
           set venue_id = v_vid, venue_name = v_vname, geom = v_vgeom, chosen_by = v_uid, chosen_at = now(),
               move_pending = false
         where game_id = p_game_id and round = v_game.round;
      else
        insert into public.hider_bars (game_id, round, venue_id, venue_name, geom, chosen_by)
        values (p_game_id, v_game.round, v_vid, v_vname, v_vgeom, v_uid);
      end if;
      perform public._append_event(p_game_id, 'bar_chosen', jsonb_build_object(
        'round', v_game.round, 'venue_id', v_vid, 'name', v_vname,
        'lng', round(extensions.st_x(v_vgeom)::numeric, 6), 'lat', round(extensions.st_y(v_vgeom)::numeric, 6),
        'radius_m', public._cfg_num(v_game.config, '{hiding_zone,bar_radius_m}', 100),
        'late', false, 'moved', coalesce(v_bar.move_pending, false), 'by_override', true), 'hiders');
      if v_bar.move_pending then
        perform public._append_event(p_game_id, 'hider_moved', jsonb_build_object('round', v_game.round, 'at', now()));
      end if;
      perform public._update_freeze(v_game);
      v_summary := 'Changed the hider''s bar';
      v_detail := format('Bar set to %s', v_vname);

    when 'give_card' then
      select * into v_gc from public.game_cards
       where game_id = p_game_id and round = v_game.round and card_id = v_params ->> 'card_id';
      if not found then
        -- Not in this round's deck: snapshot it from the library (0 copies in the deck).
        insert into public.game_cards (game_id, round, card_id, name, category_id, category_name, category_colour,
                                       behaviour, body, params, cast_cost, can_veto, copies, sort)
        select p_game_id, v_game.round, c.id, c.name, c.category_id, cat.name, cat.colour, c.behaviour, c.body,
               c.params, c.cast_cost, c.can_veto, 0,
               coalesce((select max(sort) + 1 from public.game_cards where game_id = p_game_id and round = v_game.round), 1)
          from public.cards c join public.categories cat on cat.id = c.category_id
         where c.id = v_params ->> 'card_id'
        returning * into v_gc;
        if v_gc.card_id is null then
          raise exception 'card_not_found' using errcode = 'P0001';
        end if;
      end if;
      insert into public.card_instances (game_id, round, card_id, pile_pos, location)
      values (p_game_id, v_game.round, v_gc.card_id,
              coalesce((select max(pile_pos) + 1 from public.card_instances where game_id = p_game_id and round = v_game.round), 1),
              'hand')
      returning id into v_inst;
      perform public._append_event(p_game_id, 'card_given', jsonb_build_object(
        'round', v_game.round, 'instance_id', v_inst, 'card', public._card_json(v_gc)), 'hiders');
      v_summary := 'Changed the hider''s hand';
      v_detail := format('Gave the hider %s', v_gc.name);

    when 'remove_card' then
      update public.card_instances set location = 'discarded'
       where id = public._param_uuid(v_params, 'instance_id') and game_id = p_game_id
         and round = v_game.round and location = 'hand'
      returning id into v_inst;
      if v_inst is null then
        raise exception 'card_not_in_hand' using errcode = 'P0001';
      end if;
      perform public._append_event(p_game_id, 'card_removed', jsonb_build_object(
        'round', v_game.round, 'instance_id', v_inst), 'hiders');
      v_summary := 'Changed the hider''s hand';
      v_detail := format('Removed %s from the hand', (select g.name from public.card_instances i
        join public.game_cards g on g.game_id = i.game_id and g.round = i.round and g.card_id = i.card_id where i.id = v_inst));

    when 'draw_cards' then
      v_n := floor(public._cfg_num(v_params, '{count}', 1))::integer;
      v_pick := floor(public._cfg_num(v_params, '{pick}', v_n))::integer;
      if v_n not between 1 and 10 or v_pick not between 1 and v_n then
        raise exception 'invalid_override' using errcode = 'P0001', detail = 'count, pick';
      end if;
      if public._draw_reward(v_game, null, v_n, v_pick) is null then
        raise exception 'deck_empty' using errcode = 'P0001';
      end if;
      v_summary := 'The hider drew cards';
      v_detail := format('Drew %s, keep %s', v_n, v_pick);

    when 'reshuffle' then
      with r as (
        select id, row_number() over (order by random()) as n from public.card_instances
         where game_id = p_game_id and round = v_game.round and location in ('pile', 'discarded')
      )
      update public.card_instances i
         set location = 'pile', draw_id = null,
             pile_pos = (select max(pile_pos) from public.card_instances
                          where game_id = p_game_id and round = v_game.round) + r.n
        from r where i.id = r.id;
      select count(*) into v_n from public.card_instances
       where game_id = p_game_id and round = v_game.round and location = 'pile';
      perform public._append_event(p_game_id, 'deck_reshuffled', jsonb_build_object(
        'round', v_game.round, 'pile_left', v_n), 'hiders');
      v_summary := 'Reshuffled the discards into the draw pile';
      v_detail := format('Draw pile now %s cards', v_n);

    -- ------------------------------------------------------------- undo
    when 'undo' then
      select * into v_target from public.game_overrides
       where id = public._param_uuid(v_params, 'override_id') and game_id = p_game_id for update;
      if not found then
        raise exception 'override_not_found' using errcode = 'P0001';
      end if;
      if v_target.undone_by is not null then
        raise exception 'already_undone' using errcode = 'P0001';
      end if;
      perform public._undo_override(v_target.id);
      update public.game_overrides set undone_by = v_oid where id = v_target.id;
      if v_target.kind = 'undo' then
        -- Undoing an undo puts the original back.
        update public.game_overrides set undone_by = null
         where id = public._param_uuid(v_target.params, 'override_id');
      end if;
      perform public._append_event(p_game_id, 'override_undone', jsonb_build_object('target_id', v_target.id));
      v_summary := 'Undid: ' || coalesce(v_target.summary, v_target.kind);
  end case;

  perform set_config('hd.override_id', '', true);
  -- The round may have moved on (an ended countdown starts seeking, a deadline turns overdue).
  perform public._settle_timers(p_game_id);

  update public.game_overrides set summary = v_summary where id = v_oid;
  if p_request_id is not null then
    update public.override_requests set resolved_at = now(), resolution = 'approved', override_id = v_oid
     where id = p_request_id;
  end if;

  v_seq := public._append_event(p_game_id, 'override', jsonb_build_object(
    'override_id', v_oid,
    'kind', v_kind,
    'reason', v_reason,
    'by', v_uid,
    'summary', v_summary,
    'private', v_private,
    'request_id', p_request_id,
    'target_id', case when v_kind = 'undo' then v_params ->> 'override_id' end,
    -- Public, non-private details only (ids the timeline links to).
    'params', case when v_private then '{}'::jsonb else v_params end));
  if v_detail is not null then
    v_seq := public._append_event(p_game_id, 'override_detail', jsonb_build_object(
      'override_id', v_oid, 'summary', v_detail), 'hiders');
  end if;

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq, 'override_id', v_oid));
end;
$$;

revoke execute on function
  public._capture_override_change(),
  public._undo_override(uuid),
  public._override_is_private(uuid, text, jsonb),
  public._param_uuid(jsonb, text),
  public._iso(timestamptz),
  public._override_timer(public.games, jsonb),
  public._append_event(uuid, text, jsonb, public.event_visibility, uuid),
  public._update_freeze(public.games),
  public._settle_timers(uuid),
  public.veto_curse(uuid, uuid, uuid, bigint),
  public.host_override(uuid, text, jsonb, text, uuid, bigint, uuid)
from public, anon, authenticated;

grant execute on function
  public.veto_curse(uuid, uuid, uuid, bigint),
  public.host_override(uuid, text, jsonb, text, uuid, bigint, uuid)
to authenticated;
