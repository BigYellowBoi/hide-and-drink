-- Presence (who has the app open) on the shared game topic only.
--
-- Presence is ephemeral and never game state: it is not in the event log and no action
-- depends on it. It only drives the online dots next to player names. It lives on the
-- shared game:<id> topic, so it carries nothing team-private (just user id and a time).
--
-- Clients may still never send broadcasts: insert is allowed for the presence extension
-- only, so a phone cannot inject fake game events into a topic.

create function public.can_use_presence(p_topic text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_topic ~ '^game:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     and public.can_join_topic(p_topic);
$$;

revoke execute on function public.can_use_presence(text) from public, anon, authenticated;
-- RLS policies evaluate as the calling role, so authenticated needs execute (like can_join_topic).
grant execute on function public.can_use_presence(text) to authenticated;

create policy "players see presence on their game topic" on realtime.messages
  for select to authenticated
  using (realtime.messages.extension = 'presence' and public.can_use_presence((select realtime.topic())));

create policy "players share presence on their game topic" on realtime.messages
  for insert to authenticated
  with check (realtime.messages.extension = 'presence' and public.can_use_presence((select realtime.topic())));
