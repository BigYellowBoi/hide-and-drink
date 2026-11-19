-- Playtest 3 follow-ups (19/11/26).
--
-- * Media sent with the card: the hiders attach the photo of the drink they pay to cast a
--   card, and a curse's first step (params.hider_proof, e.g. Sculling's chug video), before
--   they cast it. They upload to drink-photos at <game_id>/<instance_id>/<file> while the card
--   is in their hand, and play_card takes p_choice.media {cost, setup}: the proofs it opens are
--   proved in the same transaction (drink_proved right after card_played), so the seekers get
--   the curse and the video together. play_card becomes a thin front over the previous
--   version, renamed _play_card_core (as host_override over _host_override_core).
-- * Not applicable: curses with params.not_applicable (Escape) start at once; while running,
--   the seekers can cancel one with check_curse(p_applies false) (public curse_checked).
--   Escape drops its "Are you in a bar?" question for this.
-- * Train stations for matching, tentacles and photos: layer 'gtfs:train stations' (rail
--   stations, data/map-layers.json), copied here from the loaded pack's stations layer; the
--   next pipeline build makes it from GTFS like the others.

-- ---------------------------------------------------------------------------
-- Content
-- ---------------------------------------------------------------------------

update public.cards
   set params = (params - 'seeker_confirm') || '{"not_applicable": "Only if you are in a bar when it lands."}'::jsonb
 where id = 'escape' and params ->> 'seeker_confirm' = 'Are you in a bar right now?';

update public.question_types
   set options = options || '[{"id": "train_station", "label": "Train station", "source": "gtfs:train stations"}]'::jsonb
 where city = 'brisbane' and type = 'matching'
   and not exists (select 1 from jsonb_array_elements(options) o where o ->> 'id' = 'train_station');
update public.question_types
   set options = options || '[{"id": "train_stations", "label": "Train stations", "radius_m": 1000, "source": "gtfs:train stations"}]'::jsonb
 where city = 'brisbane' and type = 'tentacles'
   and not exists (select 1 from jsonb_array_elements(options) o where o ->> 'id' = 'train_stations');
update public.question_types
   set options = options || '[{"id": "train_station", "label": "Train station"}]'::jsonb
 where city = 'brisbane' and type = 'photos'
   and not exists (select 1 from jsonb_array_elements(options) o where o ->> 'id' = 'train_station');

insert into public.map_features (city, layer, feature_id, name, geom, props)
select city, 'gtfs:train stations', feature_id, name, geom, props
  from public.map_features
 where layer = 'stations' and props -> 'modes' ? 'rail'
on conflict do nothing;

update public.city_packs p
   set meta = jsonb_set(p.meta, '{layers}', coalesce((
         select jsonb_agg(l order by i)
           from (
             select l, i::numeric as i from jsonb_array_elements(p.meta -> 'layers') with ordinality t(l, i)
              where l ->> 'id' <> 'gtfs:train stations'
             union all
             select jsonb_build_object('id', 'gtfs:train stations', 'label', 'Train stations', 'geometry', 'point',
                                       'from', 'gtfs', 'count', (select count(*) from public.map_features f
                                                                  where f.city = p.city and f.layer = 'gtfs:train stations')),
                    coalesce((select i from jsonb_array_elements(p.meta -> 'layers') with ordinality t(l, i)
                               where l ->> 'id' = 'gtfs:ferry stops'), 0) + 0.5
           ) x), '[]'::jsonb))
 where jsonb_typeof(p.meta -> 'layers') = 'array'
   and exists (select 1 from public.map_features f where f.city = p.city and f.layer = 'gtfs:train stations');

-- ---------------------------------------------------------------------------
-- Uploads before casting: <game_id>/<instance_id>/<file>, by a hider, while the card is in
-- the hand. As in 20261202090000_powerups_vetoes_proofs.sql otherwise.
-- ---------------------------------------------------------------------------

create or replace function public.can_upload_drink_photo(p_name text)
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
    join public.players p on p.game_id = d.game_id and p.user_id = (select auth.uid())
    where d.proved_at is null and p.team = d.team
  ) or exists (
    select 1
    from public._photo_path_ids(p_name) ids
    join public.card_instances c on c.id = ids.question_id and c.game_id = ids.game_id
    join public.games g on g.id = c.game_id and g.round = c.round
    join public.players p on p.game_id = c.game_id and p.user_id = (select auth.uid())
    where c.location = 'hand' and p.team = 'hiders' and g.status in ('hiding', 'seeking')
  );
$$;

-- ---------------------------------------------------------------------------
-- play_card: media sent with the card
-- ---------------------------------------------------------------------------

do $do$
begin
  if to_regprocedure('public._play_card_core(uuid, uuid, uuid, bigint, jsonb)') is null then
    alter function public.play_card(uuid, uuid, uuid, bigint, jsonb) rename to _play_card_core;
  end if;
end;
$do$;
revoke execute on function public._play_card_core(uuid, uuid, uuid, bigint, jsonb)
  from public, anon, authenticated;

-- Prove an open proof with a file uploaded under the card's folder before it was cast.
create function public._prove_with_cast_media(p_game public.games, p_proof_id uuid, p_instance_id uuid, p_path text)
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
     or not exists (select 1 from storage.objects o where o.bucket_id = 'drink-photos' and o.name = v_path) then
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
  v_media jsonb := case when jsonb_typeof(p_choice -> 'media') = 'object' then p_choice -> 'media' end;
  v_result jsonb;
  v_game public.games;
  v_proof uuid;
begin
  v_result := public._play_card_core(p_game_id, p_instance_id, p_client_action_id, p_last_seen_seq,
                                     case when p_choice is null then null else p_choice - 'media' end);
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
-- check_curse: as in 20261218090000_video_and_setup_proofs.sql, plus Not applicable on a
-- running curse with params.not_applicable
-- ---------------------------------------------------------------------------

create or replace function public.check_curse(
  p_game_id uuid,
  p_effect_id uuid,
  p_applies boolean,
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
  v_duration integer;
  v_seq bigint;
  v_opt_out boolean;
begin
  if v_prev is not null then
    return v_prev;
  end if;

  v_game := public._lock_game(p_game_id);
  perform public._require_team(p_game_id, v_uid, 'seekers');
  if v_game.status not in ('hiding', 'seeking') then
    raise exception 'round_not_running' using errcode = 'P0001';
  end if;
  if p_applies is null then
    raise exception 'invalid_choice' using errcode = 'P0001';
  end if;
  perform public._require_fresh(p_game_id, v_uid, p_last_seen_seq);

  v_e := public._lock_effect(v_game, p_effect_id);
  select * into v_card from public.game_cards
   where game_id = p_game_id and round = v_game.round and card_id = v_e.card_id;
  -- Not applicable: a running curse that lets the seekers cancel it (before any lock starts).
  v_opt_out := not p_applies and v_e.status = 'active' and v_e.followup_ends_at is null
               and coalesce(v_card.params ->> 'not_applicable', '') not in ('', 'false');
  if v_e.status <> 'awaiting_seekers' and not v_opt_out then
    raise exception 'effect_not_awaiting' using errcode = 'P0001';
  end if;

  if p_applies then
    v_duration := public._cfg_num(v_card.params, '{duration_s}', 0)::integer;
    update public.card_effects
       set status = 'active',
           ends_at = case when behaviour = 'timed' then now() + make_interval(secs => greatest(v_duration, 1)) end
     where id = v_e.id
    returning * into v_e;
  else
    update public.card_effects set status = 'cleared', cleared_at = now() where id = v_e.id
    returning * into v_e;
  end if;

  v_seq := public._append_event(p_game_id, 'curse_checked', jsonb_build_object(
    'round', v_game.round, 'effect_id', v_e.id, 'applies', p_applies,
    'ends_at', public._iso(v_e.ends_at), 'by', v_uid, 'not_applicable', v_opt_out));

  if p_applies and public._curse_proofs(v_game, v_e, v_card) then
    v_seq := (select last_seq from public.games where id = p_game_id);
  end if;

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq));
end;
$$;

revoke execute on function
  public.play_card(uuid, uuid, uuid, bigint, jsonb),
  public._prove_with_cast_media(public.games, uuid, uuid, text),
  public.check_curse(uuid, uuid, boolean, uuid, bigint)
from public, anon, authenticated;

grant execute on function
  public.play_card(uuid, uuid, uuid, bigint, jsonb),
  public.check_curse(uuid, uuid, boolean, uuid, bigint)
to authenticated;
