-- The group's custom cards, made to work in the app (27/11/26). Every rule is a card param
-- (data); the code implements the param once, so any card can use it.
--
-- * params.hider_count {prompt, per, unit, time_s?, reward?}: after casting, the hiders send a
--   number (set_card_count, once). amount = floor(count / per) is public (card_count_set):
--   "the seekers drink <amount> <unit>s". time_s shows the hiders a countdown first (they
--   drink for 5 minutes, then count). reward 'extra_draw' instead adds amount cards to the
--   next reward's draw (card_modifiers.extra_draw, counted in _draw_reward). A curse with one
--   can't be cleared until the count is in (count_needed).
--   Brothel (people in the voice call / 2 = shots), Equivalent Exchange (standard drinks),
--   Beer Bonus (drinks = extra cards).
-- * params.hider_proof_optional: the hiders' first photo (hider_proof) is optional: not asked
--   at cast, sent with the count, never waited for (drink_proofs.optional).
-- * params.mine (Minefield, until_cleared): cast with p_choice.mine {type, option_id}, kept
--   in question_mines (no client access); hiders-only mine_set. When the seekers ask it,
--   ask_question closes it as a veto (no reward) and logs public mine_triggered; the curse
--   then blocks questions until the seekers drink (its proof) and the hider confirms. Before
--   that it can't be cleared (mine_not_triggered).
-- * params.drink_per_question (Happy Hour, timed): every question asked while it runs opens
--   a seekers' drink_due.
-- * params.plague_radius_m (Plagued World, timed): every question asked while it runs leaves
--   a public plague_spot; ask_question refuses plague_zone within the radius of one.
--   Position: p_params.here, center or end, else the asker's latest reported position.
-- * params.zone_radius_multiplier (Prosperous Home): the hiding zone and the freeze radius
--   grow for the round (zone_boosts; _update_freeze; phones from card_played).
-- * params.bank_time_bonuses {minutes_per, unit} (Time Bank): cast with p_choice.bonuses
--   (time bonus cards in the hand, any number). They're discarded (hiders-only
--   bonuses_banked); floor(minutes / minutes_per) drinks for the seekers (public
--   card_count_set, plus a drink_due).
-- * params.self_clear (Rewind): the seekers' "Okay, done" clears it, no hider confirm.
-- * Curse of Nathan: blocks transport until the seekers send a photo.

-- ---------------------------------------------------------------------------
-- Content: the library cards as made in the app, unless edited again since.
-- ---------------------------------------------------------------------------

update public.cards set params =
  '{"proof": "photo", "hider_proof": "photo", "blocks_questions": true,
    "proof_prompt": "Send a picture of the shots ordered.",
    "hider_proof_prompt": "Send a screenshot of the number of people in discord calls.",
    "hider_count": {"prompt": "How many people were in the Discord voice call?", "per": 2, "unit": "shot"}}'::jsonb
 where id = 'brothel' and params =
  '{"proof": "photo", "drinks": ["seekers"], "hider_proof": "photo", "proof_prompt": "Send a picture of the shots ordered.",
    "blocks_questions": true, "hider_proof_prompt": "Send a screenshot of the number of people in discord calls."}'::jsonb;

update public.cards set params =
  '{"proof": "video", "blocks_questions": true,
    "proof_prompt": "Send video evidence of the amount of drinks consumed.",
    "hider_proof": "photo", "hider_proof_optional": true,
    "hider_proof_prompt": "Optional: a photo of what your team drank.",
    "hider_count": {"prompt": "How many standard drinks did your team have in the 5 minutes?", "per": 1,
                    "unit": "standard drink", "time_s": 300}}'::jsonb
 where id = 'curse_of_equivalent_exchange' and params =
  '{"proof": "video", "drinks": ["hiders", "seekers"], "hider_proof": "video",
    "proof_prompt": "Send video evidence of the amount of drinks consumed.", "blocks_questions": true,
    "hider_proof_prompt": "Send video evidence of how many drinks were consumed in 5 minutes."}'::jsonb;

update public.cards set behaviour = 'until_cleared',
       params = '{"mine": true, "proof": "photo", "proof_prompt": "Photo of every seeker drinking."}'::jsonb
 where id = 'curse_of_minefield' and behaviour = 'text' and params = '{}'::jsonb;

update public.cards set behaviour = 'timed',
       body = case when body = 'For the next 20 minutes, the seekers must finish a drink before for each question asked.'
                   then 'For the next 20 minutes, the seekers must finish a drink for each question asked.' else body end,
       params = '{"duration_s": 1200, "drink_per_question": "drink"}'::jsonb
 where id = 'curse_of_happy_hour' and behaviour = 'text' and params = '{}'::jsonb;

update public.cards set params = '{"bank_time_bonuses": {"minutes_per": 4, "unit": "drink"}}'::jsonb
 where id = 'curse_of_time_bank' and behaviour = 'text' and params = '{}'::jsonb;

update public.cards set params = '{"zone_radius_multiplier": 1.5}'::jsonb
 where id = 'curse_of_prosperous_home' and behaviour = 'text' and params = '{}'::jsonb;

update public.cards set behaviour = 'timed', params = '{"duration_s": 1800, "plague_radius_m": 250}'::jsonb
 where id = 'curse_of_plagued_world' and behaviour = 'text' and params = '{}'::jsonb;

update public.cards set behaviour = 'until_cleared', params = '{"blocks_questions": true, "self_clear": true}'::jsonb
 where id = 'curse_of_rewind' and behaviour = 'text' and params = '{}'::jsonb;

update public.cards set behaviour = 'until_cleared',
       params = '{"proof": "photo", "blocks": "transport", "proof_prompt": "Photo of the video game ad."}'::jsonb
 where id = 'nathan' and behaviour = 'text'
   and params = '{"todo": "No text yet; copies set to 0 so it stays out of the deck"}'::jsonb;

update public.cards set params =
  '{"hider_count": {"prompt": "How many drinks did your team have in the 5 minutes?", "per": 1, "unit": "card",
                    "time_s": 300, "reward": "extra_draw"}}'::jsonb
 where id = 'beer_bonus' and behaviour = 'text' and params = '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- Tables (no client access: everything phones need is in events)
-- ---------------------------------------------------------------------------

create table public.card_counts (
  instance_id uuid primary key references public.card_instances (id) on delete cascade,
  game_id uuid not null references public.games (id) on delete cascade,
  round integer not null,
  count integer,
  amount integer not null check (amount >= 0),
  set_by uuid,
  set_at timestamptz not null default now()
);

create table public.question_mines (
  effect_id uuid primary key references public.card_effects (id) on delete cascade,
  game_id uuid not null references public.games (id) on delete cascade,
  round integer not null,
  type text not null,
  option_id text not null,
  label text not null,
  triggered_question_id uuid references public.questions (id) on delete set null,
  triggered_at timestamptz
);
create index question_mines_game_idx on public.question_mines (game_id, round);

create table public.zone_boosts (
  instance_id uuid primary key references public.card_instances (id) on delete cascade,
  game_id uuid not null references public.games (id) on delete cascade,
  round integer not null,
  multiplier numeric not null check (multiplier > 0)
);

create table public.plague_spots (
  id uuid primary key default gen_random_uuid(),
  effect_id uuid not null references public.card_effects (id) on delete cascade,
  game_id uuid not null references public.games (id) on delete cascade,
  round integer not null,
  question_id uuid references public.questions (id) on delete cascade,
  geom extensions.geometry(Point, 4326) not null,
  radius_m numeric not null
);
create index plague_spots_game_idx on public.plague_spots (game_id, round);

alter table public.card_counts enable row level security;
alter table public.question_mines enable row level security;
alter table public.zone_boosts enable row level security;
alter table public.plague_spots enable row level security;
revoke all on public.card_counts, public.question_mines, public.zone_boosts, public.plague_spots
  from anon, authenticated;

alter table public.drink_proofs add column optional boolean not null default false;
alter table public.card_modifiers add column extra_draw integer not null default 0 check (extra_draw >= 0);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- How much the round's hiding zone has grown (Prosperous Home), 1 = not at all. Vetoed
-- cards don't count.
create function public._zone_multiplier(p_game public.games)
returns numeric
language sql
stable
set search_path = ''
as $$
  select coalesce(exp(sum(ln(z.multiplier))), 1)
    from public.zone_boosts z
   where z.game_id = p_game.id and z.round = p_game.round
     and not exists (select 1 from public.curse_vetoes v where v.instance_id = z.instance_id);
$$;

-- The card a played instance is, or null.
create function public._played_card(p_game public.games, p_instance_id uuid)
returns public.game_cards
language sql
stable
set search_path = ''
as $$
  select g.* from public.card_instances i
    join public.game_cards g on g.game_id = i.game_id and g.round = i.round and g.card_id = i.card_id
   where i.id = p_instance_id and i.game_id = p_game.id and i.round = p_game.round;
$$;

-- Where a seeker asks from: p_params.here, center or end, else their latest reported
-- position this round. Null if none.
create function public._asked_from(p_game public.games, p_user uuid, p_params jsonb)
returns extensions.geometry
language plpgsql
stable
set search_path = ''
as $$
declare
  v_key text;
  v_geom extensions.geometry;
begin
  foreach v_key in array array['here', 'center', 'end'] loop
    if p_params is not null and jsonb_typeof(p_params -> v_key) = 'array' then
      begin
        return public._lonlat(p_params -> v_key);
      exception when others then
        null;
      end;
    end if;
  end loop;
  select extensions.st_setsrid(extensions.st_makepoint(sp.lng, sp.lat), 4326) into v_geom
    from public.seeker_positions sp
   where sp.game_id = p_game.id and sp.user_id = p_user and sp.round = p_game.round;
  return v_geom;
end;
$$;

-- Freeze: as in 20261213090000_host_overrides.sql, the radius grown by Prosperous Home.
create or replace function public._update_freeze(p_game public.games)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_bar public.hider_bars;
  v_radius numeric := public._cfg_num(p_game.config, '{hiding_zone,freeze_when_seeker_within_m}',
                        public._cfg_num(p_game.config, '{hiding_zone,bar_radius_m}', 100))
                      * public._zone_multiplier(p_game);
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

-- Curse proofs: as in 20261218090000_video_and_setup_proofs.sql, plus optional first steps.
create or replace function public._curse_proofs(p_game public.games, p_effect public.card_effects, p_card public.game_cards)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
  v_any boolean := false;
  v_optional boolean := coalesce(p_card.params -> 'hider_proof_optional' = 'true'::jsonb, false);
begin
  if p_card.params ->> 'hider_proof' in ('photo', 'video') then
    insert into public.drink_proofs (game_id, round, team, cost, label, kind, effect_id, optional)
    values (p_game.id, p_game.round, 'hiders', null, p_card.name, 'setup', p_effect.id, v_optional)
    returning id into v_id;
    perform public._append_event(p_game.id, 'proof_due', jsonb_build_object(
      'round', p_game.round, 'proof_id', v_id, 'team', 'hiders', 'kind', 'setup',
      'media', p_card.params ->> 'hider_proof', 'label', p_card.name, 'effect_id', p_effect.id)
      || case when v_optional then '{"optional": true}'::jsonb else '{}'::jsonb end, 'all', null);
    v_any := true;
  end if;
  if p_card.params ->> 'proof' in ('photo', 'video')
     and (p_effect.behaviour = 'until_cleared' or p_effect.followup_s is not null) then
    perform public._evidence_due(p_game, p_effect, p_card.name);
    v_any := true;
  end if;
  return v_any;
end;
$$;

-- Draw a reward: as in 20261130090000_cards.sql, plus extra cards from modifiers spent on
-- this question (Beer Bonus: card_modifiers.extra_draw).
create or replace function public._draw_reward(p_game public.games, p_question_id uuid, p_draw integer, p_pick integer)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_draw public.card_draws;
  v_n integer;
  v_cards jsonb;
  v_extra integer := 0;
begin
  if p_question_id is not null then
    select coalesce(sum(extra_draw), 0)::integer into v_extra from public.card_modifiers
     where game_id = p_game.id and used_question_id = p_question_id;
  end if;
  if coalesce(p_draw, 0) < 1 then
    return null;
  end if;
  select least(p_draw + v_extra, count(*))::integer into v_n from public.card_instances
   where game_id = p_game.id and round = p_game.round and location = 'pile';
  if v_n < 1 then
    return null;
  end if;

  insert into public.card_draws (game_id, round, question_id, drawn, pick)
  values (p_game.id, p_game.round, p_question_id, v_n, greatest(1, least(coalesce(p_pick, 1), v_n)))
  returning * into v_draw;

  update public.card_instances i
     set location = 'drawn', draw_id = v_draw.id
   where i.id in (select id from public.card_instances
                   where game_id = p_game.id and round = p_game.round and location = 'pile'
                   order by pile_pos limit v_n);

  select jsonb_agg(jsonb_build_object('instance_id', i.id, 'card_id', i.card_id) order by i.pile_pos)
    into v_cards from public.card_instances i where i.draw_id = v_draw.id;

  perform public._append_event(p_game.id, 'cards_drawn', jsonb_build_object(
    'round', p_game.round,
    'draw_id', v_draw.id,
    'question_id', p_question_id,
    'pick', v_draw.pick,
    'cards', v_cards,
    'pile_left', (select count(*) from public.card_instances
                   where game_id = p_game.id and round = p_game.round and location = 'pile')
  ) || case when v_extra > 0 then jsonb_build_object('extra', v_extra) else '{}'::jsonb end, 'hiders');
  return v_draw.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- play_card: as in 20261226090000_move_period.sql, plus mines, time bonus banking and zone
-- boosts after the core has played the card.
-- ---------------------------------------------------------------------------

create or replace function public.play_card(
  p_game_id uuid,
  p_instance_id uuid,
  p_client_action_id uuid,
  p_last_seen_seq bigint,
  p_choice jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public._require_user();
  v_media jsonb := case when jsonb_typeof(p_choice -> 'media') = 'object' then p_choice -> 'media' end;
  v_result jsonb;
  v_game public.games;
  v_proof uuid;
  v_card public.game_cards;
  v_fresh boolean;
  v_move boolean := false;
  v_duration integer;
  v_radius numeric;
  v_bar public.hider_bars;
  v_ids jsonb;
  v_effect uuid;
  v_qt public.question_types;
  v_option jsonb;
  v_bonus uuid[];
  v_minutes numeric;
  v_per numeric;
  v_amount integer;
  v_unit text;
  v_mult numeric;
begin
  v_fresh := public._previous_result(p_client_action_id, v_uid) is null;
  if v_fresh then
    select g.* into v_card from public.card_instances i
      join public.game_cards g on g.game_id = i.game_id and g.round = i.round and g.card_id = i.card_id
     where i.id = p_instance_id and i.game_id = p_game_id and i.location = 'hand';
    -- A Move with a period: checks the core doesn't make. Retries go straight to the core,
    -- which returns the first result.
    v_move := found and v_card.behaviour = 'powerup' and v_card.params ->> 'action' = 'move'
              and public._cfg_num(v_card.params, '{duration_s}', 0) >= 1;
    if v_move then
      v_game := public._lock_game(p_game_id);
      perform public._require_team(p_game_id, v_uid, 'hiders');
      -- Not settled here: new events before the core's freshness check would make it stale.
      if v_game.status = 'hiding'
         and now() < v_game.round_started_at + make_interval(secs => v_game.hiding_period_s) then
        raise exception 'not_seeking_yet' using errcode = 'P0001';
      end if;
      if exists (select 1 from public.hider_bars where game_id = p_game_id and round = v_game.round and frozen) then
        raise exception 'endgame' using errcode = 'P0001';
      end if;
    end if;
  end if;

  v_result := public._play_card_core(p_game_id, p_instance_id, p_client_action_id, p_last_seen_seq,
                                     case when p_choice is null then null else p_choice - 'media' end);
  if not v_fresh then
    return v_result;
  end if;
  select * into v_game from public.games where id = p_game_id;
  v_effect := (v_result ->> 'effect_id')::uuid;

  if v_move then
    v_duration := public._cfg_num(v_card.params, '{duration_s}', 0)::integer;
    v_radius := nullif(public._cfg_num(v_card.params, '{radius_m}', 0), 0);
    update public.hider_bars
       set move_from = geom, move_from_name = venue_name, move_radius_m = v_radius,
           move_ends_at = now() + make_interval(secs => v_duration)
     where game_id = p_game_id and round = v_game.round
    returning * into v_bar;
    -- The old bar goes to everyone: that's the card's price.
    perform public._append_event(p_game_id, 'move_started', jsonb_build_object(
      'round', v_game.round,
      'instance_id', p_instance_id,
      'from', jsonb_build_object(
        'name', v_bar.move_from_name,
        'lng', round(extensions.st_x(v_bar.move_from)::numeric, 6),
        'lat', round(extensions.st_y(v_bar.move_from)::numeric, 6)),
      'radius_m', v_radius,
      'duration_s', v_duration,
      'started_at', public._iso(now()),
      'ends_at', public._iso(v_bar.move_ends_at)));
    if v_card.params -> 'discard_hand' = 'true'::jsonb then
      with d as (
        update public.card_instances set location = 'discarded'
         where game_id = p_game_id and round = v_game.round and location = 'hand'
        returning id, card_id
      )
      select jsonb_agg(jsonb_build_object('instance_id', id, 'card_id', card_id)) into v_ids from d;
      if v_ids is not null then
        perform public._append_event(p_game_id, 'hand_discarded', jsonb_build_object(
          'round', v_game.round, 'instance_id', p_instance_id, 'cards', v_ids), 'hiders');
      end if;
    end if;
  end if;

  -- Minefield: the question the hiders mine, kept from the seekers.
  if v_card.params -> 'mine' = 'true'::jsonb and v_effect is not null then
    select * into v_qt from public.question_types where city = v_game.city and type = p_choice -> 'mine' ->> 'type';
    select o into v_option from jsonb_array_elements(v_qt.options) o where o ->> 'id' = p_choice -> 'mine' ->> 'option_id';
    if v_qt.type is null or v_option is null then
      raise exception 'invalid_choice' using errcode = 'P0001', detail = 'pick the question to mine';
    end if;
    if coalesce(v_option ->> 'reusable', 'false') <> 'true' and public._question_used(v_game, v_qt.type, v_option ->> 'id') then
      raise exception 'invalid_choice' using errcode = 'P0001', detail = 'that question was already asked';
    end if;
    insert into public.question_mines (effect_id, game_id, round, type, option_id, label)
    values (v_effect, p_game_id, v_game.round, v_qt.type, v_option ->> 'id',
            coalesce(v_option ->> 'label', v_option ->> 'id'));
    perform public._append_event(p_game_id, 'mine_set', jsonb_build_object(
      'round', v_game.round, 'effect_id', v_effect, 'instance_id', p_instance_id,
      'type', v_qt.type, 'option_id', v_option ->> 'id',
      'label', coalesce(v_option ->> 'label', v_option ->> 'id')), 'hiders');
  end if;

  -- Time Bank: discard any number of time bonuses from the hand; the seekers drink for them.
  if jsonb_typeof(v_card.params -> 'bank_time_bonuses') = 'object' then
    v_bonus := public._uuid_list(coalesce(p_choice -> 'bonuses', '[]'::jsonb));
    if (select count(distinct b) from unnest(v_bonus) b) <> cardinality(v_bonus)
       or (select count(*) from public.card_instances i
             join public.game_cards g on g.game_id = i.game_id and g.round = i.round and g.card_id = i.card_id
            where i.game_id = p_game_id and i.round = v_game.round and i.location = 'hand'
              and i.id = any (v_bonus) and g.behaviour = 'time_bonus') <> cardinality(v_bonus) then
      raise exception 'invalid_choice' using errcode = 'P0001', detail = 'pick time bonus cards from your hand';
    end if;
    select coalesce(sum(public._cfg_num(g.params, '{minutes}', 0)), 0) into v_minutes
      from public.card_instances i
      join public.game_cards g on g.game_id = i.game_id and g.round = i.round and g.card_id = i.card_id
     where i.id = any (v_bonus);
    update public.card_instances set location = 'discarded' where id = any (v_bonus);
    v_per := greatest(1, public._cfg_num(v_card.params, '{bank_time_bonuses,minutes_per}', 4));
    v_amount := floor(v_minutes / v_per)::integer;
    v_unit := coalesce(nullif(btrim(v_card.params -> 'bank_time_bonuses' ->> 'unit'), ''), 'drink');
    insert into public.card_counts (instance_id, game_id, round, count, amount, set_by)
    values (p_instance_id, p_game_id, v_game.round, null, v_amount, v_uid);
    perform public._append_event(p_game_id, 'bonuses_banked', jsonb_build_object(
      'round', v_game.round, 'instance_id', p_instance_id, 'discarded', to_jsonb(v_bonus),
      'minutes', v_minutes, 'amount', v_amount), 'hiders');
    perform public._append_event(p_game_id, 'card_count_set', jsonb_build_object(
      'round', v_game.round, 'instance_id', p_instance_id, 'effect_id', null, 'count', null,
      'amount', v_amount, 'unit', v_unit, 'name', v_card.name));
    if v_amount > 0 then
      perform public._card_drink_due(v_game, 'seekers', case when v_unit = 'shot' then 'shot' else 'drink' end,
        format('%s: %s %s%s', v_card.name, v_amount, v_unit, case when v_amount = 1 then '' else 's' end), p_instance_id);
    end if;
  end if;

  -- Prosperous Home: the hiding zone grows for the round.
  if jsonb_typeof(v_card.params -> 'zone_radius_multiplier') = 'number' then
    v_mult := (v_card.params ->> 'zone_radius_multiplier')::numeric;
    if v_mult > 0 and v_mult <= 10 then
      insert into public.zone_boosts (instance_id, game_id, round, multiplier)
      values (p_instance_id, p_game_id, v_game.round, v_mult);
      perform public._update_freeze(v_game);
    end if;
  end if;

  v_result := v_result || jsonb_build_object('seq', (select last_seq from public.games where id = p_game_id));
  if v_media is null then
    return v_result;
  end if;
  select * into v_game from public.games where id = p_game_id;

  -- The drink the hiders pay to cast it.
  if v_media ? 'cost' then
    select (e.payload ->> 'proof_id')::uuid into v_proof from public.events e
     where e.game_id = p_game_id and e.type = 'drink_due'
       and e.payload ->> 'instance_id' = p_instance_id::text and e.payload ->> 'team' = 'hiders'
     order by e.seq limit 1;
    if v_proof is not null then
      perform public._prove_with_cast_media(v_game, v_proof, p_instance_id, v_media ->> 'cost');
    end if;
  end if;
  -- The curse's first step (params.hider_proof).
  if v_media ? 'setup' then
    select d.id into v_proof from public.drink_proofs d
      join public.card_effects ce on ce.id = d.effect_id
     where ce.game_id = p_game_id and ce.instance_id = p_instance_id and d.kind = 'setup';
    if v_proof is not null then
      perform public._prove_with_cast_media(v_game, v_proof, p_instance_id, v_media ->> 'setup');
    end if;
  end if;

  return v_result || jsonb_build_object('seq', (select last_seq from public.games where id = p_game_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- set_card_count: the hiders' number for a card with params.hider_count (once).
-- ---------------------------------------------------------------------------

create function public.set_card_count(
  p_game_id uuid,
  p_instance_id uuid,
  p_count integer,
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
  v_card public.game_cards;
  v_inst public.card_instances;
  v_e public.card_effects;
  v_per numeric;
  v_amount integer;
  v_unit text;
  v_reward text;
  v_visibility public.event_visibility;
  v_seq bigint;
begin
  if v_prev is not null then
    return v_prev;
  end if;

  v_game := public._lock_game(p_game_id);
  perform public._require_team(p_game_id, v_uid, 'hiders');
  if v_game.status not in ('hiding', 'seeking') then
    raise exception 'round_not_running' using errcode = 'P0001';
  end if;
  perform public._require_fresh(p_game_id, v_uid, p_last_seen_seq);

  select * into v_inst from public.card_instances
   where id = p_instance_id and game_id = p_game_id and round = v_game.round and location = 'played';
  if not found then
    raise exception 'card_not_found' using errcode = 'P0001';
  end if;
  v_card := public._played_card(v_game, p_instance_id);
  if jsonb_typeof(v_card.params -> 'hider_count') <> 'object' then
    raise exception 'count_not_needed' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.card_counts where instance_id = p_instance_id) then
    raise exception 'count_already_set' using errcode = 'P0001';
  end if;
  if p_count is null or p_count < 0 or p_count > 1000 then
    raise exception 'invalid_count' using errcode = 'P0001';
  end if;
  select * into v_e from public.card_effects where instance_id = p_instance_id;
  if found and v_e.status not in ('active', 'clear_requested') then
    raise exception 'curse_over' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.curse_vetoes where instance_id = p_instance_id) then
    raise exception 'curse_over' using errcode = 'P0001';
  end if;

  v_per := greatest(1, public._cfg_num(v_card.params, '{hider_count,per}', 1));
  v_amount := floor(p_count / v_per)::integer;
  v_unit := coalesce(nullif(btrim(v_card.params -> 'hider_count' ->> 'unit'), ''), 'drink');
  v_reward := v_card.params -> 'hider_count' ->> 'reward';

  insert into public.card_counts (instance_id, game_id, round, count, amount, set_by)
  values (p_instance_id, p_game_id, v_game.round, p_count, v_amount, v_uid);

  -- As private as the card itself.
  select e.visibility into v_visibility from public.events e
   where e.game_id = p_game_id and e.type = 'card_played' and e.payload ->> 'instance_id' = p_instance_id::text
   order by e.seq desc limit 1;
  v_seq := public._append_event(p_game_id, 'card_count_set', jsonb_build_object(
    'round', v_game.round, 'instance_id', p_instance_id, 'effect_id', v_e.id, 'count', p_count,
    'amount', v_amount, 'unit', v_unit, 'name', v_card.name)
    || case when v_reward is not null then jsonb_build_object('reward', v_reward) else '{}'::jsonb end,
    coalesce(v_visibility, 'all'));

  -- Beer Bonus: that many more cards on the next reward's draw.
  if v_reward = 'extra_draw' and v_amount > 0 then
    insert into public.card_modifiers (game_id, round, instance_id, reward_multiplier, extra_draw)
    values (p_game_id, v_game.round, p_instance_id, 1, v_amount);
  end if;

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq, 'amount', v_amount));
end;
$$;

-- ---------------------------------------------------------------------------
-- clear_effect: as in 20261208090000_card_proofs_picking.sql, plus the hiders' count, mines,
-- optional first steps and self-cleared curses.
-- ---------------------------------------------------------------------------

create or replace function public.clear_effect(
  p_game_id uuid,
  p_effect_id uuid,
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
  v_e public.card_effects;
  v_card public.game_cards;
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

  v_e := public._lock_effect(v_game, p_effect_id);
  if v_e.status <> 'active'
     or not (v_e.behaviour = 'until_cleared'
             or (v_e.behaviour = 'timed' and v_e.followup_s is not null and v_e.followup_ends_at is null)) then
    raise exception 'effect_not_active' using errcode = 'P0001';
  end if;
  v_card := public._played_card(v_game, v_e.instance_id);
  if exists (select 1 from public.question_mines where effect_id = v_e.id and triggered_at is null) then
    raise exception 'mine_not_triggered' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.drink_proofs where effect_id = v_e.id and proved_at is null and not optional) then
    raise exception 'proof_needed' using errcode = 'P0001';
  end if;
  if jsonb_typeof(v_card.params -> 'hider_count') = 'object'
     and not exists (select 1 from public.card_counts where instance_id = v_e.instance_id) then
    raise exception 'count_needed' using errcode = 'P0001';
  end if;

  if v_card.params -> 'self_clear' = 'true'::jsonb then
    update public.card_effects set status = 'cleared', clear_requested_by = v_uid, cleared_at = now() where id = v_e.id;
    v_seq := public._append_event(p_game_id, 'effect_cleared', jsonb_build_object(
      'round', v_game.round, 'effect_id', v_e.id, 'by', v_uid, 'self_cleared', true));
  else
    update public.card_effects set status = 'clear_requested', clear_requested_by = v_uid where id = v_e.id;
    v_seq := public._append_event(p_game_id, 'effect_clear_requested', jsonb_build_object(
      'round', v_game.round, 'effect_id', v_e.id, 'by', v_uid));
  end if;

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq));
end;
$$;

-- ---------------------------------------------------------------------------
-- ask_question: as in 20261217090000_playtest2_fixes.sql, plus Plagued World, Minefield and
-- Happy Hour.
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
  v_q public.questions;
  v_from extensions.geometry;
  v_near numeric;
  v_mine public.question_mines;
  v_fx record;
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
  if exists (select 1 from public.card_effects
              where game_id = p_game_id and round = v_game.round and blocks_questions
                and status in ('active', 'clear_requested')) then
    raise exception 'questions_blocked' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.hider_bars where game_id = p_game_id and round = v_game.round and move_pending) then
    raise exception 'hider_moving' using errcode = 'P0001';
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
  if exists (select 1 from public.question_bans
              where game_id = p_game_id and round = v_game.round and type = p_type and option_id = p_option_id) then
    raise exception 'question_banned' using errcode = 'P0001';
  end if;
  -- Each question once per run (options with reusable = true, e.g. a custom radar, aside).
  if coalesce(v_option ->> 'reusable', 'false') <> 'true' and public._question_used(v_game, p_type, p_option_id) then
    raise exception 'question_used' using errcode = 'P0001';
  end if;

  -- Plagued World: no question within the radius of one asked while it runs.
  v_from := public._asked_from(v_game, v_uid, p_params);
  if v_from is not null then
    select min(extensions.st_distance(s.geom::extensions.geography, v_from::extensions.geography) - s.radius_m)
      into v_near
      from public.plague_spots s
      join public.card_effects ce on ce.id = s.effect_id
     where s.game_id = p_game_id and s.round = v_game.round
       and ce.status = 'active' and ce.ends_at > now()
       and extensions.st_dwithin(s.geom::extensions.geography, v_from::extensions.geography, s.radius_m::float8);
    if v_near is not null then
      raise exception 'plague_zone' using errcode = 'P0001',
        detail = format('%s m more to go', ceil(-v_near));
    end if;
  end if;

  v_q := public._insert_question(v_game, v_qt, p_option_id,
    public._question_params(v_game, p_type, v_option, v_qt.extra, p_params), v_uid, null);

  -- Curses that react to a question being asked, oldest first.
  for v_fx in
    select ce.*, g.name as card_name, g.params as card_params
      from public.card_effects ce
      join public.game_cards g on g.game_id = ce.game_id and g.round = ce.round and g.card_id = ce.card_id
     where ce.game_id = p_game_id and ce.round = v_game.round and ce.behaviour = 'timed'
       and ce.status = 'active' and ce.ends_at > now()
     order by ce.played_at
  loop
    -- Plagued World: this spot is off limits while it runs.
    if jsonb_typeof(v_fx.card_params -> 'plague_radius_m') = 'number' and v_from is not null then
      insert into public.plague_spots (effect_id, game_id, round, question_id, geom, radius_m)
      values (v_fx.id, p_game_id, v_game.round, v_q.id, v_from, (v_fx.card_params ->> 'plague_radius_m')::numeric);
      perform public._append_event(p_game_id, 'plague_spot', jsonb_build_object(
        'round', v_game.round, 'effect_id', v_fx.id, 'question_id', v_q.id,
        'lng', round(extensions.st_x(v_from)::numeric, 6), 'lat', round(extensions.st_y(v_from)::numeric, 6),
        'radius_m', (v_fx.card_params ->> 'plague_radius_m')::numeric, 'ends_at', public._iso(v_fx.ends_at)));
    end if;
    -- Happy Hour: a drink for every question.
    if v_fx.card_params ->> 'drink_per_question' in ('drink', 'shot') then
      perform public._card_drink_due(v_game, 'seekers', v_fx.card_params ->> 'drink_per_question',
        v_fx.card_name, v_fx.instance_id);
    end if;
  end loop;

  -- Minefield: the mined question is vetoed, and the curse blocks questions until they drink.
  select m.* into v_mine from public.question_mines m
    join public.card_effects ce on ce.id = m.effect_id
   where m.game_id = p_game_id and m.round = v_game.round and m.type = p_type and m.option_id = p_option_id
     and m.triggered_at is null and ce.status = 'active'
   order by ce.played_at limit 1
  for update of m;
  if found then
    update public.questions set answered_at = now(), answered_by = null, closed_by = 'veto', late = false
     where id = v_q.id;
    update public.question_mines set triggered_question_id = v_q.id, triggered_at = now() where effect_id = v_mine.effect_id;
    update public.card_effects set blocks_questions = true where id = v_mine.effect_id;
    perform public._append_event(p_game_id, 'mine_triggered', jsonb_build_object(
      'round', v_game.round, 'effect_id', v_mine.effect_id, 'question_id', v_q.id,
      'type', v_mine.type, 'option_id', v_mine.option_id, 'label', v_mine.label,
      'blocks_questions', true), 'all', null);
  end if;

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', (select last_seq from public.games where id = p_game_id),
                       'question_id', v_q.id, 'mined', v_mine.effect_id is not null));
end;
$$;

-- ---------------------------------------------------------------------------
-- Push: as in 20261226090000_move_period.sql, plus mines and counts to the seekers.
-- ---------------------------------------------------------------------------

create or replace function public._push_for_event(p_type text, p_visibility public.event_visibility, p_payload jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_type text := initcap(coalesce(p_payload ->> 'type', 'question'));
  v_mins integer;
  v_alert jsonb;
  v_n integer;
begin
  case p_type
    when 'question_asked' then
      v_mins := ceil(coalesce((p_payload ->> 'deadline_s')::numeric, 300) / 60);
      v_alert := jsonb_build_object('audience', 'hiders', 'title', 'New question',
        'body', format('%s question: answer within %s min.', v_type, v_mins));
    when 'question_answered' then
      v_alert := jsonb_build_object('audience', 'seekers', 'title', 'Question answered',
        'body', format('The hiders answered your %s question.', lower(v_type)));
    when 'card_played' then
      if p_payload -> 'card' ->> 'category' = 'curse' then
        v_alert := jsonb_build_object('audience', 'seekers',
          'title', 'Curse: ' || coalesce(p_payload -> 'card' ->> 'name', 'a curse'),
          'body', 'The hiders cast a curse on you. Open the app to see it.');
      elsif jsonb_typeof(p_payload -> 'card' -> 'params' -> 'drinks') = 'array'
            and jsonb_array_length(p_payload -> 'card' -> 'params' -> 'drinks') > 0 then
        v_alert := jsonb_build_object(
          'audience', case when jsonb_array_length(p_payload -> 'card' -> 'params' -> 'drinks') = 1
                           then p_payload -> 'card' -> 'params' -> 'drinks' ->> 0 else 'all' end,
          'title', coalesce(p_payload -> 'card' ->> 'name', 'Drinks'),
          'body', coalesce(p_payload -> 'card' ->> 'text', 'Time to drink.'));
      end if;
    when 'mine_triggered' then
      v_alert := jsonb_build_object('audience', 'seekers', 'title', 'Mine!',
        'body', format('%s was mined: it''s vetoed. Every seeker drinks before your next question.',
                       coalesce(p_payload ->> 'label', 'That question')));
    when 'card_count_set' then
      v_n := coalesce((p_payload ->> 'amount')::integer, 0);
      if p_payload ->> 'reward' is null then
        v_alert := jsonb_build_object('audience', 'seekers', 'title', coalesce(p_payload ->> 'name', 'Curse'),
          'body', case when v_n = 0 then 'You got off: nothing to drink.'
                       else format('Drink %s %s%s.', v_n, coalesce(p_payload ->> 'unit', 'drink'),
                                   case when v_n = 1 then '' else 's' end) end);
      end if;
    when 'move_started' then
      v_mins := ceil(coalesce((p_payload ->> 'duration_s')::numeric, 600) / 60);
      v_alert := jsonb_build_object('audience', 'seekers', 'title', 'Frozen: the hiders are moving',
        'body', format('Stay where you are for %s min. They left %s, which is on your map.',
                       v_mins, coalesce(p_payload -> 'from' ->> 'name', 'their bar')));
    when 'hider_moved' then
      if (p_payload ->> 'period_over')::boolean then
        v_alert := jsonb_build_object('audience', 'seekers', 'title', 'Move over',
          'body', 'You can move and ask questions again.');
      end if;
    when 'curse_checked' then
      v_alert := jsonb_build_object('audience', 'hiders',
        'title', case when (p_payload ->> 'applies')::boolean then 'Curse applies' else 'Curse doesn''t apply' end,
        'body', case when (p_payload ->> 'applies')::boolean
                     then 'The seekers confirmed your curse: it has started.'
                     else 'The seekers say your curse doesn''t apply, so it was dropped.' end);
    when 'drink_proved' then
      v_alert := jsonb_build_object(
        'audience', case p_payload ->> 'team' when 'hiders' then 'seekers' else 'hiders' end,
        'title', case p_payload ->> 'kind'
                   when 'setup' then 'Hiders sent the ' || coalesce(p_payload ->> 'label', 'curse') || ' proof'
                   when 'evidence' then 'Seekers sent proof'
                   else initcap(coalesce(p_payload ->> 'team', 'team')) || ' drank' end,
        'body', case p_payload ->> 'kind'
                  when 'setup' then 'Open the app to see what you have to beat.'
                  when 'evidence' then coalesce(p_payload ->> 'label', 'Curse') || ': check it and confirm.'
                  else coalesce(p_payload ->> 'label', 'Drink') || ': done, photo in the log.' end);
    when 'freeze_changed' then
      v_alert := case when (p_payload ->> 'frozen')::boolean
        then jsonb_build_object('audience', 'hiders', 'title', 'Freeze',
               'body', 'A seeker is near your bar. Stay where you are.')
        else jsonb_build_object('audience', 'hiders', 'title', 'Freeze over', 'body', 'You can move again.') end;
    when 'round_ended' then
      v_alert := jsonb_build_object('audience', 'all', 'title', 'Found!',
        'body', format('Round %s is over. Swap roles: the next round starts when the new hiders are ready.',
                       p_payload ->> 'round'));
    when 'game_started' then
      if (p_payload ->> 'next_round')::boolean then
        v_alert := jsonb_build_object('audience', 'all', 'title', format('Round %s', p_payload ->> 'round'),
          'body', 'The hiding period has started.');
      end if;
    when 'game_ended' then
      if p_payload ->> 'reason' is distinct from 'inactive' then
        v_alert := jsonb_build_object('audience', 'all', 'title', 'Game over', 'body', 'Open the app to see who won.');
      end if;
    else
      v_alert := null;
  end case;
  if v_alert is null then
    return null;
  end if;
  if p_visibility <> 'all' and v_alert ->> 'audience' <> p_visibility::text then
    return null;
  end if;
  return v_alert;
end;
$$;

revoke execute on function
  public._zone_multiplier(public.games),
  public._played_card(public.games, uuid),
  public._asked_from(public.games, uuid, jsonb),
  public._update_freeze(public.games),
  public._curse_proofs(public.games, public.card_effects, public.game_cards),
  public._draw_reward(public.games, uuid, integer, integer),
  public.play_card(uuid, uuid, uuid, bigint, jsonb),
  public.set_card_count(uuid, uuid, integer, uuid, bigint),
  public.clear_effect(uuid, uuid, uuid, bigint),
  public.ask_question(uuid, text, text, jsonb, uuid, bigint),
  public._push_for_event(text, public.event_visibility, jsonb)
from public, anon, authenticated;

grant execute on function
  public.play_card(uuid, uuid, uuid, bigint, jsonb),
  public.set_card_count(uuid, uuid, integer, uuid, bigint),
  public.clear_effect(uuid, uuid, uuid, bigint),
  public.ask_question(uuid, text, text, jsonb, uuid, bigint)
to authenticated;
