-- Minimal stand-ins for the parts of Supabase the migrations use, so they can be
-- tested on plain Postgres when Docker images aren't available.
-- CI uses the real Supabase stack (supabase db start); this is a local fallback only.

-- Roles are cluster-wide, so they may exist from an earlier run.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end;
$$;
grant anon, authenticated, service_role to current_user;

create schema auth;
create schema realtime;
create schema extensions;
grant usage on schema auth, realtime, public, extensions to anon, authenticated, service_role;

create table auth.users (
  id uuid primary key,
  email text,
  is_anonymous boolean not null default true,
  created_at timestamptz not null default now()
);

-- Same logic as Supabase's auth.uid(): the JWT "sub" claim.
create function auth.uid()
returns uuid
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
grant execute on function auth.uid() to anon, authenticated, service_role;

create table realtime.messages (
  id bigserial primary key,
  topic text not null,
  extension text not null,
  payload jsonb,
  event text,
  private boolean default false,
  inserted_at timestamptz not null default now()
);
alter table realtime.messages enable row level security;
grant select, insert on realtime.messages to authenticated;
grant usage on all sequences in schema realtime to authenticated;

-- Realtime sets this per connection attempt; tests set it with set_config.
create function realtime.topic()
returns text
language sql
stable
as $$
  select nullif(current_setting('realtime.topic', true), '')
$$;
grant execute on function realtime.topic() to authenticated;

create function realtime.send(payload jsonb, event text, topic text, private boolean default true)
returns void
language sql
as $$
  insert into realtime.messages (topic, extension, payload, event, private)
  values (topic, 'broadcast', payload, event, private);
$$;
