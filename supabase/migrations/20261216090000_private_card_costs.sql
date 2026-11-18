-- Drink costs of hider-only plays stay hider-only.
--
-- Duplicate and Discard/Draw log a hiders-only card_played, but if the library gives one a
-- cast cost (or params.drinks), _card_drink_due logged a public drink_due carrying the card's
-- name and instance id, so the seekers learnt what the hider had just played.
-- Now: when the card's card_played was hiders-only, a cost the hiders pay is a hiders-only
-- drink_due; one the seekers must pay stays public but says only "Hider card".

create or replace function public._card_drink_due(p_game public.games, p_team public.team, p_cost text, p_label text, p_instance_id uuid)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
  v_private boolean;
  v_visibility public.event_visibility := 'all';
  v_label text := p_label;
  v_instance uuid := p_instance_id;
begin
  if p_cost not in ('drink', 'shot') or p_game.config -> 'photo_proof_for_drinks' = 'false'::jsonb then
    return null;
  end if;

  select e.visibility = 'hiders' into v_private from public.events e
   where e.game_id = p_game.id and e.type = 'card_played' and e.payload ->> 'instance_id' = p_instance_id::text
   order by e.seq desc limit 1;
  if coalesce(v_private, false) then
    if p_team = 'hiders' then
      v_visibility := 'hiders';
    else
      v_label := 'Hider card';
      v_instance := null;
    end if;
  end if;

  insert into public.drink_proofs (game_id, round, team, cost, label)
  values (p_game.id, p_game.round, p_team, p_cost, v_label)
  returning id into v_id;
  perform public._append_event(p_game.id, 'drink_due', jsonb_build_object(
    'round', p_game.round, 'proof_id', v_id, 'team', p_team, 'cost', p_cost, 'label', v_label,
    'instance_id', v_instance), v_visibility, null);
  return v_id;
end;
$$;

revoke execute on function public._card_drink_due(public.games, public.team, text, text, uuid)
  from public, anon, authenticated;
