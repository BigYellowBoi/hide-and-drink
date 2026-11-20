-- Abandoned and test games are deleted, not kept as past games, and auto-ending sends no push.
--
-- * _game_worth_keeping: a game is worth keeping when something actually happened in it: a
--   round was scored (not voided) or a question was answered, and it isn't a dev-mode
--   (playtest) game. A game with media is always kept here: only the Edge Function
--   delete-game can remove media, so such a game stays in Past games for a manual Delete.
-- * _end_stale_games: a running game idle for 24 h is deleted when it isn't worth keeping
--   (otherwise ended as before, reason inactive). Ended games that aren't worth keeping are
--   deleted 24 h after their last event, so the final screen still works right after.
-- * list_past_games leaves out games that aren't worth keeping.
-- * _push_for_event: no "Game over" push when a game is ended for inactivity.

create function public._game_worth_keeping(p_game public.games)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (select 1 from public._game_media(p_game.id, false))
      or (not coalesce((p_game.config ->> 'dev_mode')::boolean, false)
          and (exists (select 1 from public.game_rounds r where r.game_id = p_game.id and not r.voided)
               or exists (select 1 from public.questions q
                           where q.game_id = p_game.id and q.answered_at is not null and q.answer is not null)));
$$;

-- As in 20261219090100_rounds_scoring.sql, plus deleting abandoned and test games.
-- Returns how many games were ended or deleted.
create or replace function public._end_stale_games()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
  v_game public.games;
  v_n integer := 0;
begin
  for v_id in
    select g.id from public.games g
     where g.status in ('hiding', 'seeking', 'round_over', 'ended')
       and coalesce((select e.created_at from public.events e where e.game_id = g.id and e.seq = g.last_seq),
                    g.updated_at) < now() - interval '24 hours'
     for update skip locked
  loop
    select * into v_game from public.games where id = v_id;
    if not public._game_worth_keeping(v_game) then
      delete from public.games where id = v_id;
      v_n := v_n + 1;
    elsif v_game.status <> 'ended' then
      perform public._finish_game(v_game, 'inactive', null);
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

-- As in 20261223090000_replay_admin.sql, minus games that aren't worth keeping.
create or replace function public.list_past_games()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with me as (
    select (select auth.uid()) as uid, public._is_admin((select auth.uid())) as admin
  ),
  g as (
    select g.*, ge.payload as result, ge.created_at as ended_at
      from public.games g
      cross join me
      left join lateral (
        select e.payload, e.created_at from public.events e
         where e.game_id = g.id and e.type = 'game_ended' order by e.seq desc limit 1
      ) ge on true
     where g.status = 'ended'
       and me.uid is not null
       and (me.admin or exists (select 1 from public.players p where p.game_id = g.id and p.user_id = me.uid))
       and exists (select 1 from public.events e where e.game_id = g.id and e.type = 'game_started')
       and public._game_worth_keeping(g)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', g.id,
      'city', g.city,
      'started_at', public._iso((select min(e.created_at) from public.events e
                                  where e.game_id = g.id and e.type = 'game_started')),
      'ended_at', public._iso(coalesce(g.ended_at, g.updated_at)),
      'play_area', coalesce(
        (select pa.name from public.play_areas pa where pa.id = g.play_area_id),
        (select e.payload ->> 'name' from public.events e
          where e.game_id = g.id and e.type = 'play_area_changed' order by e.seq desc limit 1)),
      'players', coalesce((select jsonb_agg(jsonb_build_object('user_id', p.user_id, 'name', p.name, 'team', p.team)
                                             order by p.joined_at)
                             from public.players p where p.game_id = g.id), '[]'::jsonb),
      'rounds', coalesce(g.result -> 'rounds', '[]'::jsonb),
      'winners', coalesce(g.result -> 'winners', '[]'::jsonb),
      'totals', coalesce(g.result -> 'players', '[]'::jsonb),
      'mine', exists (select 1 from public.players p, me where p.game_id = g.id and p.user_id = me.uid),
      'can_delete', g.host_id = me.uid or me.admin)
    order by coalesce(g.ended_at, g.updated_at) desc), '[]'::jsonb)
  from g cross join me;
$$;

-- As in 20261219090100_rounds_scoring.sql, but no push when a game is ended for inactivity.
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

revoke execute on function public._game_worth_keeping(public.games) from public, anon, authenticated;
