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

- Game actions: one Postgres function per action (`ask_question`, `answer_question`, `play_card`, ...), each taking `game_id`, `client_action_id` (idempotency) and `last_seen_seq`.
- Events table is append-only. Game state is derived from it or updated in the same transaction.
- Channels: `game:{id}` (everyone), `game:{id}:seekers`, `game:{id}:hiders`.
- Units: metres and seconds in data; display km/min.
- Keep this file short. Update it when a decision changes.

## Current phase

Phase 0: foundations (repo, Supabase project, GitHub Pages deploy, seed data). See `docs/spec.md` for the phases and their gates.
