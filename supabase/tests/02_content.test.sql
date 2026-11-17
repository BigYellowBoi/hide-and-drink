-- Seeded content and library access.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(7);

select is((select sum(default_copies)::int from public.cards where active), 81,
  'seeded deck is 81 cards');
select is((select count(*)::int from public.categories), 4, 'four starting categories');
select is((select count(*)::int from public.question_types where city = 'brisbane'), 7,
  'seven Brisbane question types');
select is((select count(*)::int from public.play_areas where city = 'brisbane'), 1,
  'last game''s Brisbane play area is seeded');

insert into auth.users (id, email) values ('55555555-5555-5555-5555-555555555555', 'reader@test.local');
select set_config('request.jwt.claims', '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated"}', true);
set local role authenticated;

select ok((select count(*) from public.cards) > 0, 'signed-in users can read the card library');
select throws_ok(
  $$ update public.cards set body = 'changed' where id = 'cheers' $$,
  '42501', null, 'clients cannot edit cards directly (yet)'
);

reset role;
set local role anon;
select throws_ok(
  $$ select count(*) from public.cards $$,
  '42501', null, 'signed-out (anon) requests cannot read the library'
);

select * from finish();
rollback;
