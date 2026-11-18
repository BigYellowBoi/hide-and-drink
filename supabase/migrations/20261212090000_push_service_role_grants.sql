-- The send-push Edge Function connects as service_role. This project does not grant new
-- tables to the Data API roles automatically, so grant exactly what the function uses:
-- read and mark sent push_outbox rows, read and delete dead push_subscriptions, and read
-- players to find who is in the alert's audience. Clients (anon, authenticated) still have
-- no access to the push tables.

grant select, update on public.push_outbox to service_role;
grant select, delete on public.push_subscriptions to service_role;
grant select on public.players to service_role;
