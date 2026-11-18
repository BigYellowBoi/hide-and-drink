-- Push alerts (web push) for new questions, answers, curses and freezes.
--
-- * push_subscriptions: one row per browser push endpoint, owned by the signed-in user that
--   saved it. save_push_subscription / delete_push_subscription (any signed-in user, own rows
--   only). Not game actions: no event log; an upsert is idempotent on its own.
-- * push_outbox: a trigger on events queues one alert per event that needs one, with the
--   audience it may go to. The audience is never wider than the event's visibility, so a
--   hider-only event (freeze_changed) can only alert hiders:
--     question_asked       -> hiders   "New question"
--     question_answered    -> seekers  "Question answered"
--     card_played (curse)  -> seekers  "Curse: <name>"
--     freeze_changed       -> hiders   "Freeze" / "Freeze over"
--   The actor (when the event has one) is left out: they did it.
-- * Sending: the Edge Function supabase/functions/send-push reads a queued row, sends it to
--   the subscriptions of the game's players in the audience and marks it sent. The trigger
--   calls it through pg_net when the Vault holds push_function_url and push_webhook_secret
--   (see docs/push.md); without them alerts are only queued. A failure here never blocks
--   the game action.

create table public.push_subscriptions (
  endpoint text primary key check (endpoint ~ '^https://' and char_length(endpoint) <= 1000),
  user_id uuid not null references auth.users (id) on delete cascade,
  p256dh text not null check (char_length(p256dh) between 1 and 200),
  auth text not null check (char_length(auth) between 1 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index push_subscriptions_user_idx on public.push_subscriptions (user_id);

create table public.push_outbox (
  id bigint generated always as identity primary key,
  game_id uuid not null references public.games (id) on delete cascade,
  seq bigint not null,
  audience public.event_visibility not null,
  exclude_user uuid,
  title text not null,
  body text not null,
  tag text not null,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  sent_count integer
);

create index push_outbox_unsent_idx on public.push_outbox (created_at) where sent_at is null;

alter table public.push_subscriptions enable row level security;
alter table public.push_outbox enable row level security;
revoke all on public.push_subscriptions, public.push_outbox from anon, authenticated;
-- RLS on with no policies = no client access. The Edge Function uses the service role.

-- ---------------------------------------------------------------------------
-- Client functions
-- ---------------------------------------------------------------------------

create function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public._require_user();
begin
  if p_endpoint is null or p_endpoint !~ '^https://' or char_length(p_endpoint) > 1000
     or coalesce(char_length(p_p256dh), 0) not between 1 and 200
     or coalesce(char_length(p_auth), 0) not between 1 and 100 then
    raise exception 'invalid_push_subscription' using errcode = 'P0001';
  end if;
  -- An endpoint belongs to one browser: whoever saves it last owns it.
  insert into public.push_subscriptions (endpoint, user_id, p256dh, auth)
  values (p_endpoint, v_uid, p_p256dh, p_auth)
  on conflict (endpoint) do update
    set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, updated_at = now();
  return jsonb_build_object('ok', true);
end;
$$;

create function public.delete_push_subscription(p_endpoint text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public._require_user();
begin
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = v_uid;
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Queue and send
-- ---------------------------------------------------------------------------

-- Ask the Edge Function to send one queued alert. Needs pg_net and two Vault secrets.
create function public._send_push(p_outbox_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
begin
  execute $q$select decrypted_secret from vault.decrypted_secrets where name = 'push_function_url'$q$ into v_url;
  execute $q$select decrypted_secret from vault.decrypted_secrets where name = 'push_webhook_secret'$q$ into v_secret;
  if v_url is null or v_secret is null then
    return;
  end if;
  execute $q$select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 5000)$q$
    using v_url, jsonb_build_object('outbox_id', p_outbox_id),
          jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret);
exception when others then
  -- No Vault or pg_net here (tests, local stacks without the function): queued only.
  return;
end;
$$;

-- What alert an event needs, if any: {audience, title, body}.
create function public._push_for_event(p_type text, p_visibility public.event_visibility, p_payload jsonb)
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
      end if;
    when 'freeze_changed' then
      v_alert := case when (p_payload ->> 'frozen')::boolean
        then jsonb_build_object('audience', 'hiders', 'title', 'Freeze',
               'body', 'A seeker is near your bar. Stay where you are.')
        else jsonb_build_object('audience', 'hiders', 'title', 'Freeze over', 'body', 'You can move again.') end;
    else
      v_alert := null;
  end case;
  if v_alert is null then
    return null;
  end if;
  -- Never wider than the event: a team-only event alerts only that team.
  if p_visibility <> 'all' and v_alert ->> 'audience' <> p_visibility::text then
    return null;
  end if;
  return v_alert;
end;
$$;

create function public._queue_push()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_alert jsonb := public._push_for_event(new.type, new.visibility, new.payload);
  v_id bigint;
begin
  if v_alert is null then
    return null;
  end if;
  insert into public.push_outbox (game_id, seq, audience, exclude_user, title, body, tag)
  values (new.game_id, new.seq, (v_alert ->> 'audience')::public.event_visibility, new.actor_id,
          v_alert ->> 'title', v_alert ->> 'body', new.game_id::text || ':' || new.type)
  returning id into v_id;
  perform public._send_push(v_id);
  return null;
end;
$$;

create trigger events_queue_push
after insert on public.events
for each row
execute function public._queue_push();

-- pg_net (Supabase) sends the HTTP call after the transaction commits.
do $$
begin
  create extension if not exists pg_net;
exception when others then
  raise notice 'pg_net not available: push alerts are queued only';
end;
$$;

revoke execute on function public._send_push(bigint) from public, anon, authenticated;
revoke execute on function public._push_for_event(text, public.event_visibility, jsonb) from public, anon, authenticated;
revoke execute on function public._queue_push() from public, anon, authenticated;
revoke execute on function public.save_push_subscription(text, text, text) from public, anon, authenticated;
revoke execute on function public.delete_push_subscription(text) from public, anon, authenticated;
grant execute on function public.save_push_subscription(text, text, text), public.delete_push_subscription(text)
  to authenticated;
