# Hide + Drink

Companion web app for our friend group's "Hide + Drink" variant of Jet Lag: The Game Hide and Seek. The hider hides at a bar; cards and curses are drinking themed. Private game, ~6 players (one hider team, one seeker team, ~3 each). Brisbane first, then Sydney.

Full spec: `docs/spec.md`. Seed data: `data/`. Read only the parts relevant to the current task.

## Non-negotiables

1. **Live sync, server-authoritative.** Phones never mutate game state. They call a game action function; the server validates against current state, writes in one transaction, assigns the next sequence number, then broadcasts. Every phone applies events in sequence order and fetches gaps.
2. **Resync on reopen.** On visibility change/reconnect, fetch all events after the last seen seq before allowing any action. Block actions while disconnected; never queue actions offline.
3. **Server time for every timer.** Store start + duration; clients correct for clock offset.
4. **No leaks between teams.** Hider-only data (position, chosen bar, hand, draw pile, suggested answers) goes only to the hider channel and is protected by RLS. Never send it to seekers and filter in the UI.
5. **Nothing game-content is hard-coded.** Cards, categories, questions, config and play areas are data. Code only implements the fixed set of card behaviours and question types.
6. **The hider always confirms answers manually.** The app suggests; the hider taps the final answer within the deadline.

## Stack

- Front end: React + Vite + TypeScript, installable PWA, hosted on GitHub Pages
- Map: MapLibre GL JS; drawing: Terra Draw; geometry: Turf.js
- Backend: Supabase (Postgres + PostGIS, database functions for game actions, RLS, anonymous auth, Realtime Broadcast from Database on private channels, Storage for photos)
- Data pipeline: Python (geopandas, Overpass/OSM, GTFS) in `pipeline/`
- Tests: Vitest for client logic; SQL tests for game action functions

## Conventions

- Game actions: one Postgres function per action (`ask_question`, `answer_question`, `play_card`, ...), each taking `game_id`, `client_action_id` (idempotency) and, for game-play actions, `last_seen_seq`. Pattern (see `create_game`/`update_config` in the core migration): `_require_user` → `_previous_result` → `_lock_game` → validate → `_require_fresh` → write → `_append_event` → `_record_result`. Errors are `raise exception '<snake_case_code>' using errcode = 'P0001'`.
- Every new function: `revoke execute ... from public, anon, authenticated`, then grant only client actions to `authenticated` and add them to the allow-list in `supabase/tests/03_privileges.test.sql`.
- Migrations live in `supabase/migrations/` and auto-deploy to production on merge to `main`. Never edit an applied migration; add a new one. Seed content ships as a migration (`scripts/seed_to_sql.py`).
- Events table is append-only. Game state is derived from it or updated in the same transaction.
- Channels: `game:{id}` (everyone), `game:{id}:seekers`, `game:{id}:hiders`.
- Units: metres and seconds in data; display km/min.
- Keep this file short. Update it when a decision changes.

## Commands

- `npm run dev`: local dev server (needs `.env.local`, see `.env.example`)
- `npm test`: Vitest unit tests (seed data checks live in `src/lib/seed.test.ts`)
- `npm run lint`: oxlint
- `npm run build`: type-check and production build into `dist/`
- `supabase start` then `supabase test db`: apply migrations to a local Supabase stack (Docker) and run the pgTAP tests in `supabase/tests/`
- `npm run latency`: latency harness, 6-10 simulated players against a running Supabase (see `scripts/latency/README.md`); CI fails if p95 > 1 s
- `scripts/test-db/run.sh`: same tests on plain Postgres with Supabase stand-ins (no Docker images needed; needs psql, pg_prove, pgTAP)
- CI (`.github/workflows/deploy.yml`) runs lint, unit tests, database tests, latency harness and build on every PR, and deploys `main` to GitHub Pages. `keep-alive.yml` queries Supabase every 3 days so the free project never pauses

## Layout

- `src/lib/supabase.ts`: Supabase client from `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`
- `src/lib/seed.ts`: typed access to `data/cards.json` and `data/questions.json`
- `src/lobby/`: lobby state derived from events (`state.ts`), data-driven config fields (`config.ts`), error messages. UI in `src/components/` (`Home`, `Lobby`, `ConfigEditor`, `JoinCode`, `Started`)
- Join links/QR open `<base>?join=CODE`, which prefills the join form
- `src/sync/`: client sync engine. `sequencer.ts` (pure ordering/gap logic), `engine.ts` (`GameSync`: topics, resync, status, actions), `transport.ts` (backend interface; `supabaseTransport.ts` in the app, fakes in tests), `clock.ts` (server clock offset), `useGameSync.ts` (React hook), `lockout.ts` (stale-state banner), `presence.ts`. Broadcasts carry `prev_seq` per audience so clients can skip the other team's seqs without a fetch.
- Presence (who has the app open) rides on `game:{id}` only; ephemeral, never game state. Clients may insert presence, never broadcasts.
- While not live the game screen is `inert` under a stale-state banner (`StaleBanner`)
- Vite `base` is `/hide-and-drink/` (GitHub Pages path); keep asset paths relative to it
- `supabase/migrations/`: schema, RLS, action functions, Realtime broadcast trigger; `supabase/tests/`: pgTAP tests

## Current phase

Phase 0 done. Phase 1 in progress: core schema done (games, players, event log, team-scoped RLS and Realtime topics, lobby actions, seeded content). Client sync engine done (anonymous sign-in, topics, ordered apply, gap fetch, resync on reopen, clock offset, status dot). Lobby done (create/join by code or QR, teams, host moves, config editor, saved play area, `start_game` locks and snapshots, hiding countdown placeholder). Presence dots, stale-state lockout banner and latency harness done. Next: run the six-phone test (`docs/six-phone-test.md`) to pass the phase 1 gate. See `docs/spec.md` for the phases and their gates.
