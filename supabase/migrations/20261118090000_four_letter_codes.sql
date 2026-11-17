-- Join codes are now 4 letters (easier to read out and type). Letters only, without
-- I and O so they can't be mistaken for 1 and 0. 24^4 = 331,776 codes.
-- Existing games keep their 6-character codes, so the check accepts both.

alter table public.games drop constraint games_code_check;
alter table public.games add constraint games_code_check
  check (code ~ '^[A-HJ-NP-Z]{4}$' or code ~ '^[A-Z2-9]{6}$');

create or replace function public._new_game_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  v_code text;
begin
  loop
    v_code := '';
    for i in 1..4 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.games where code = v_code);
  end loop;
  return v_code;
end;
$$;

revoke execute on function public._new_game_code() from public, anon, authenticated;
