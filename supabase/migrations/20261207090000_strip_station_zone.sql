-- The station zone was removed (20261204090300_no_station_zone.sql): hiding is always at a bar.
-- Lobbies created before that still carry hiding_zone.station_zone in their config, and the
-- lobby's config is read from its events, so the settings screen kept showing it. Strip it from
-- every open lobby and log a config_changed (no actor: a server fix, not a player's edit) so
-- phones pick up the cleaned config. Running and ended games only lose it from games.config
-- (nothing reads it any more).

do $$
declare
  v_game record;
  v_config jsonb;
begin
  for v_game in
    select id, status, config from public.games
     where config #> '{hiding_zone,station_zone}' is not null
     for update
  loop
    v_config := v_game.config #- '{hiding_zone,station_zone}';
    update public.games set config = v_config where id = v_game.id;
    if v_game.status = 'lobby' then
      perform public._append_event(v_game.id, 'config_changed', jsonb_build_object('config', v_config),
                                   'all', null);
    end if;
  end loop;
end;
$$;
