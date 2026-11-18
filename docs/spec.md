# Hide + Drink: Spec

Source of truth for building the app. The shared roadmap doc is a read-only overview; this file wins if they differ.

## 1. Game flow

1. Host creates a lobby and gets a 4-letter join code + QR.
2. Host draws the play area (polygon) or loads a saved one (`data/play-areas/`).
3. Host sets config (defaults in `data/config.json`) and builds the deck from the card library (+/- copies per card, presets).
4. Players join with code + name and pick Hiders or Seekers. Host can move players.
5. Host locks teams and starts. Polygon, config and deck are snapshotted; draw pile is shuffled server-side.
6. Hiding period: hider travels and picks a bar from the in-app list (only valid venues). Seekers see only the countdown.
7. Seeking: seekers ask questions, hider answers, cards are drawn and played, until found. Host swaps roles and repeats from step 5.
8. Host ends the game. The app decides the winner, everyone sees the final screen, and the game can no longer be joined.

### Ending a game

- **Host ends it:** `end_game` action (host only) sets status `ended`, decides the winner from the round scores, and appends a `game_ended` event with the result. Every phone shows the final screen. Winner rules depend on scoring (see §11).
- **Auto-end:** a game with no new events for 24 h is ended automatically (no winner if no round finished). Runs from the scheduled keep-alive job; no extra infrastructure.
- **Join codes return to the pool:** a code only has to be unique among games that aren't ended (partial unique index), so ended games free their codes. Joining by code only finds games that aren't ended; old games keep their code for history.

## 2. Rules (AMB Hide & Drink 2026)

- Base rules: official Jet Lag Hide and Seek, **small game** (yellow text on cards).
- Hider picks a bar; may hide inside it or outdoors within **100 m** of it, but not in any other building.
- Hider can't move while a seeker is inside the 100 m circle; otherwise free inside it.
- Curse casting costs: ignore printed costs unless inherent to the curse. Cost is **Free**, **Drink** or **Shot**.
- Seekers can veto curses not marked Can't Veto: locked at a bar for 10 min and each seeker drinks. Each veto used adds 10 min to the next veto.
- No reply to a reasonable request within **5 min** = one shot for that team, unless the request naturally takes longer.
- Drinks taken for costs/curses are photographed and sent to the other team.
- Drinks can be redistributed within a team (no app logic).
- The hiding spot is always a bar. Stations are only for getting around: no station zones (that is the original game's rule, not ours).

## 3. How rules map to the app

| Rule | App behaviour |
| --- | --- |
| 100 m bar zone | Hiding zone = 100 m circle around the chosen bar. A bar stays possible for seekers while any part of its circle overlaps the remaining area. |
| Freeze when a seeker is within 100 m | Server compares seekers' live positions to the circle and pushes Freeze / Clear to the hider only. Guide, not referee. |
| Cast cost | Card field `cast_cost`: free / drink / shot, shown when cast. |
| Veto | Veto button on curses with `can_veto: true`. Server counts vetoes per run; lock = base + step x vetoes_used (from config), starting when any earlier lock ends. Opens a drink proof for the seekers. |
| 5 min reply | Default answer deadline 300 s, overridable per question type. Missed deadline logs a penalty shot event. |
| Photo proof | Each drink the app knows about (cast cost, drink cards, veto, missed deadline) asks the drinking team for a photo, shown to both teams in the log. A curse's cast cost is drunk by the seekers (card `params.cost_team` overrides); other cards' costs by the hider. |

## 4. Sync and concurrency

- Server-authoritative actions via Postgres functions; per-game row lock while processing.
- Append-only `events` table with monotonic `seq` per game. Broadcast from Database on private channels.
- Every action carries `client_action_id` (idempotent retries) and `last_seen_seq` (stale actions that conflict are refused and the client refreshes).
- Validation against live state (e.g. only one pending question; curses that block asking).
- Clients: apply in order, detect gaps, refetch from last seq; resync on every reopen; show live/offline dots; block actions when stale.
- Seeker GPS: ephemeral broadcast every 15 to 30 s, latest-wins, not in the event log. Hider GPS never goes to seekers.
- Push alerts (web push) for new questions, answers, curses and freezes.
- Targets: <500 ms typical, <1 s p95 delivery; full recovery <3 s after reopen.

## 5. Cards

- Library is shared and lives in the DB; categories are data. Cards are retired, never deleted. Edits record the author and broadcast live.
- Deck builder per game: copies per card (0 = excluded), live totals per category, presets. Locked and snapshotted at game start.
- Deck list is public; draw pile and hand are hider-only.
- Card fields: `id, name, category, behaviour, text, cast_cost, can_veto, copies, params, active`.

Behaviours (the only card logic in code):

| Behaviour | App does |
| --- | --- |
| `text` | Show to everyone; people enforce it |
| `timed` | Countdown on every phone; optional follow-on timer if a condition is missed (`params.duration_s`, `params.followup_s`) |
| `until_cleared` | Active until seekers tap Done and the hider confirms; `params.blocks_questions` |
| `trivia` | Hider writes `params.count` questions (default 3, on `params.topic`); seekers send all their answers at once, the hider marks them all at once (each right or wrong), wrong ones go back to be answered again (again as one set) until all are right, which clears it. Public to both teams. Host can mark all correct by hand. Anything it blocks (e.g. transport) is on the honour system; `params.blocks_questions` as for `until_cleared` |
| `time_bonus` | Add `params.minutes` to the hider's score |
| `next_question_modifier` | Modify the hider's reward on the next answer (`params.reward_multiplier`) |
| `question_ban` | Hider picks `params.count` questions (from different types if `params.distinct_types`); seekers can't ask them until `params.until` (e.g. end of run) |
| `powerup` | Built-in action: `veto`, `randomize`, `duplicate`, `move`, `discard_draw` (`params.discard`, `params.draw`) |

Seed deck: `data/cards.json` (81 cards: 12 powerups, 42 time bonuses, 5 drink cards, 22 curses). Curse values are the small-game values, the left-most of the `[small, medium, large]` options on the cards. Cards with `copies: 0` (Nathan, Brothel) are in the library but not the default deck.

Utilities: `params.utility` = `dice` (with `params.dice` count) or `wheel` (`params.wheel_options` to spin in the app, else `params.wheel_url` opens). Proof: `params.proof` = `photo` or `video`. With `photo`, a curse the seekers clear (until_cleared, or timed with a follow-on) needs a photo before they can say they did it (the hider sees it when confirming; "not yet" asks for a new one), and the card's `params.drinks` need a photo each. `video` is shown in person. Drinks: `params.drinks` lists the teams that drink when the card is played; `params.cost` is a cost for cards with no `cast_cost`.

## 6. Questions

- Stored as data per city (`data/questions.json`): type, prompt, options, hider reward (draw/pick), deadline override.
- Types with auto-shading: radar, thermometer, measuring, matching, tentacles. Manual: photos, bonus (except "3+ bars within 50 m").
- Suggested answer = computed from the hider's chosen bar (or GPS within the circle); flag when the answer differs across the 100 m circle.
- "Custom" distance options let seekers type a value. Tentacles allow a "none in range" answer.

## 7. Data

| Layer | Brisbane | Sydney |
| --- | --- | --- |
| Transit | TransLink SEQ GTFS (direct zip) | TfNSW Timetables Complete GTFS (free API key) |
| Venues | OSM: amenity=bar/pub/biergarten/nightclub, craft=brewery/winery, plus licensed restaurants added by hand; hand include/exclude lists by OSM id (`data/venues/<city>.json`) | same |
| Matching/Tentacles | OSM categories; ABS suburbs/localities and LGAs | same |
| Play area | Drawn in lobby or `data/play-areas/*.geojson` | same |

Pipeline (`pipeline/`): download, clip to the play areas plus the city's `coverage` circles (so hosts can draw new areas anywhere in them), merge stations, tag venues, export a city pack, load into PostGIS. Host curates venues in the lobby: adds venues (pin or location, plus a name) and hides any listed one; these are public and snapshotted at start. During a round the hider can add a bar that isn't listed (inside the play area); it stays hider-only until the round ends, then everyone sees it. `save_play_area` refuses areas reaching past the pack (`play_area_outside_map_data`).

Reuse: taibeled/JetLagHideAndSeek (MIT) for question geometry and OSM queries; keep its licence notice in any ported files. Its share links (`?hzc=`) are base64url zlib-compressed JSON (GeoJSON + settings), so they're importable.

## 8. Hosting

- GitHub Pages serves the static PWA (public repo on a free account). Supabase runs everything server-side.
- The Supabase anon key ships in the client; access is enforced by RLS.
- Supabase free projects pause after a week of inactivity: resume before game day or run a keep-alive GitHub Action.

## 9. Phases and gates

| Phase | Scope | Gate |
| --- | --- | --- |
| 0 Foundations | Repo, Vite PWA scaffold, Pages deploy, Supabase project, seed data loaded, Brisbane city pack | Rules + deck locked |
| 1 Live sync core | Lobby, join code, team picking, config, events, broadcast, resync, server clock, presence, latency harness | 6 phones, p95 < 1 s, recovery < 3 s |
| 2 Map + questions | Play-area drawing, stations, venues, bar picker, all question tools, shading, answer assist, remaining bars, freeze | CBD walk test: shading matches hand-checked answers |
| 3 Cards + timers | Card library, deck builder, draw/keep, behaviours, veto, photos, dice/wheel, timers, push, activity log | Every MVP feature works in a 3-phone test game |
| 4 Brisbane beta | Full game, end game + winner, auto-end, code reuse, bug bash, fixes, second game | One full game with no manual reconciliation |
| 5 Sydney + v1 | Sydney city pack, scoring/history | First Sydney game |

## 10. Testing

Latency harness (fail deploy if p95 > 1 s), leak test (seeker client never receives hider-only data), concurrency tests (simultaneous asks, curse mid-question, duplicate sends), disruption tests (airplane mode, locked screen, tunnels), geometry unit tests, rules tests, device matrix (iPhone home-screen PWA, Android Chrome), error tracking.

## 11. Open questions

- Rounds and scoring: official small-game values? (Hiding period default set to 1 hour.)
- Copies per curse (assumed 1 each).
- Curse of Nathan: no text yet.
- Who clears an until_cleared curse (default: seekers tap Done, hider confirms)?
- Curse of Prison: who draws the card?
