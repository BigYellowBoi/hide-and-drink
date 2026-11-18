-- Manual shading and question type colours.
--
-- * set_question_shading (seekers): replaces the app's shading of one answered question of
--   the running round with the seekers' own, as a fallback when the auto shading is wrong or
--   the app can't shade it. p_shading is null (back to the app's shading) or
--     {"mode": "keep" | "cut", "area": <GeoJSON Polygon or MultiPolygon>}  keep only / rule out the area
--     {"mode": "none"}                                                      this answer rules nothing out
--   The area is repaired and stored as a MultiPolygon (6 decimals). Public event
--   question_shading_set {round, question_id, shading, by}; every phone shades from it.
-- * Question type colours (as in the original game) live in question_types.extra.colour,
--   like the seed's data/questions.json.

alter table public.questions add column manual_shading jsonb
  check (manual_shading is null or jsonb_typeof(manual_shading) = 'object');

create function public.set_question_shading(
  p_game_id uuid,
  p_question_id uuid,
  p_shading jsonb,
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
  v_mode text;
  v_geom extensions.geometry;
  v_shading jsonb;
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

  select * into v_q from public.questions
   where id = p_question_id and game_id = p_game_id and round = v_game.round
   for update;
  if not found then
    raise exception 'question_not_found' using errcode = 'P0001';
  end if;
  if v_q.answer is null then
    raise exception 'question_not_answered' using errcode = 'P0001';
  end if;

  if p_shading is not null and jsonb_typeof(p_shading) <> 'null' then
    if jsonb_typeof(p_shading) <> 'object' then
      raise exception 'invalid_shading' using errcode = 'P0001';
    end if;
    v_mode := coalesce(p_shading ->> 'mode', '');
    if v_mode = 'none' then
      v_shading := jsonb_build_object('mode', 'none');
    elsif v_mode in ('keep', 'cut') then
      if coalesce(p_shading -> 'area' ->> 'type', '') not in ('Polygon', 'MultiPolygon') then
        raise exception 'invalid_shading' using errcode = 'P0001';
      end if;
      begin
        v_geom := extensions.st_setsrid(extensions.st_geomfromgeojson((p_shading -> 'area')::text), 4326);
      exception when others then
        raise exception 'invalid_shading' using errcode = 'P0001';
      end;
      if extensions.st_npoints(v_geom) > 5000 then
        raise exception 'shading_too_detailed' using errcode = 'P0001';
      end if;
      v_geom := extensions.st_multi(extensions.st_collectionextract(extensions.st_makevalid(v_geom), 3));
      if extensions.st_isempty(v_geom) or extensions.st_area(v_geom::extensions.geography) < 1 then
        raise exception 'invalid_shading' using errcode = 'P0001';
      end if;
      v_shading := jsonb_build_object('mode', v_mode, 'area', extensions.st_asgeojson(v_geom, 6)::jsonb);
    else
      raise exception 'invalid_shading' using errcode = 'P0001';
    end if;
  end if;

  perform public._require_fresh(p_game_id, v_uid, p_last_seen_seq);

  update public.questions set manual_shading = v_shading where id = v_q.id;

  v_seq := public._append_event(p_game_id, 'question_shading_set', jsonb_build_object(
    'round', v_game.round, 'question_id', v_q.id, 'shading', v_shading, 'by', v_uid));

  return public._record_result(p_client_action_id, v_uid, p_game_id,
    jsonb_build_object('game_id', p_game_id, 'seq', v_seq));
end;
$$;

revoke execute on function public.set_question_shading(uuid, uuid, jsonb, uuid, bigint) from public, anon, authenticated;
grant execute on function public.set_question_shading(uuid, uuid, jsonb, uuid, bigint) to authenticated;

update public.question_types set extra = extra || jsonb_build_object('colour', c.colour)
  from (values
    ('matching', '#2F6FD6'),
    ('measuring', '#3BA55C'),
    ('radar', '#F08A24'),
    ('thermometer', '#F2C744'),
    ('photos', '#35BFD8'),
    ('tentacles', '#9B5BD4'),
    ('bonus', '#A9B4BF')
  ) as c(type, colour)
 where public.question_types.type = c.type;
