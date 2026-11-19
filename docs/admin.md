# Admin, replays and deleting games

## Admin PIN

Players are anonymous, so admins are whoever has entered the admin PIN on their phone. Admins see every ended game in Home's Past games list (not only their own) and can delete any of them.

The PIN lives only in Supabase as the Edge Function secret `ADMIN_PIN`. It is never in the client, the repo or the database.

### Set it up (once)

1. Pick a PIN (6+ digits; anything typed on a phone keypad works).
2. Save it as a secret (Supabase dashboard: Project Settings > Edge Functions > Secrets > Add, name `ADMIN_PIN`; or the CLI):

   ```bash
   supabase secrets set ADMIN_PIN=<your pin>
   ```

3. Deploy the two functions (from the repo root; `supabase/config.toml` keeps `verify_jwt = true`, so only signed-in phones can call them). Redeploy `admin-pin` after changing the secret:

   ```bash
   supabase functions deploy admin-pin
   ```

   ```bash
   supabase functions deploy delete-game
   ```

The migration (`20261223090000_replay_admin.sql`) deploys with the rest on merge to `main`.

### Becoming an admin

Settings (cog on Home) > Admin > enter the PIN. The Edge Function `admin-pin` compares it with `ADMIN_PIN` and calls `admin_pin_attempt`, which:

- rate-limits first: 5 tries per user and 20 wrong tries overall in 15 minutes (anonymous users are free to make, so the overall cap is what stops guessing). Past the limit even the right PIN is refused until the 15 minutes are up;
- records the try (`admin_pin_attempts`, kept a day);
- on the right PIN, adds the user to `admins`. Neither table has any client access.

A new phone, or one whose data was cleared, is a new anonymous user: enter the PIN again. To change the PIN, set the secret again and redeploy `admin-pin`. To remove an admin: `delete from public.admins where user_id = '<id>';` (or `delete from public.admins;` for everyone).

## Position track

During a round every player's position is recorded on the server (`position_track`): seekers through `report_position` as before, hiders through `report_track` (same interval, `seeker_location_interval_s`), at most one point every 2 s per player. The table has no client access at all, nothing about it is broadcast or written to the event log, so the hiders' track stays hidden while the game runs (pgTAP leak test in `supabase/tests/32_replay_admin.test.sql`). Phones send positions only while the app is open (web apps get no background GPS).

## Replay and download

Once a game has ended, `get_replay` gives any of its players (and admins) every event in order, both teams' (hider-only ones included), every player's track and the list of media files, and every media file of the game becomes readable to them (`_can_read_media`). The replay screen (Home > Past games, or the final screen) steps through it one moment at a time, with a scrubber and each player's path on the map.

Download (Past games, final screen, replay) builds one zip on the phone: `events.json` (everything `get_replay` returned), `summary.txt` (readable account), `city-pack.json` and `question-types.json` (the map data and question types, about 3 MB) and `media/<game>/<folder>/<file>` for every photo and video as stored (R2 originals; older files from the Supabase buckets as they were uploaded).

Home > **Open a saved game** plays a zip back in the same replay screen with no server: map, paths, steps, photos and videos all come from the zip, so it works offline and after the game (or the whole Supabase project) is gone. It only needs the app itself (the site, or the installed app, which works offline). The zip is read in place (`src/replay/unzip.ts` reads its index and slices files out on demand), so big videos aren't loaded into memory. Zips from before the map data was added still open, with the map loaded from the server. Desktop Chrome and Edge save it straight to disk; elsewhere it is built in memory first, so a game with gigabytes of video wants a laptop.

## Deleting a game

The game's host or any admin can delete an ended game from Past games (after a confirm that suggests downloading first). The phone calls the Edge Function `delete-game`, which:

1. checks the caller may delete it (`game_delete_media`: host or admin, ended games only) and lists its media;
2. deletes the R2 objects (the recorded ones and anything else under `<game_id>/` in the bucket), then forgets their `media_objects` rows (`media_forget`);
3. deletes files in the Supabase buckets through the Storage API (SQL deletes on `storage.objects` are blocked);
4. calls `delete_game` as the caller, which refuses `media_left` while any media remains and otherwise deletes the game row: players, events, the track and every other row of the game cascade.

Other players just see it disappear from their list.
