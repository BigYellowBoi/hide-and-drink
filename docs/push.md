# Push alerts: setup

Web push for new questions (hiders), answers (seekers), curses (seekers) and freezes (hiders).

How it works: a trigger on `events` queues one row per alert in `push_outbox` (migration `20261211090100_push_alerts.sql`; the audience is never wider than the event's visibility). If the Vault holds the function URL and secret, the trigger calls the Edge Function `send-push` through `pg_net`, which sends the alert to every subscribed phone of a player in that audience (not the one who caused it). Phones subscribe from the "Alerts on this phone" toggle (Lobby, Settings, Timeline tab). The service worker shows nothing while the app is open on screen.

Until the steps below are done, alerts are only queued and the toggle is hidden (no `VITE_VAPID_PUBLIC_KEY`).

## One-time setup

1. VAPID key pair:

   ```bash
   npx web-push generate-vapid-keys
   ```

2. Edge Function secrets (pick any long random string for the webhook secret):

   ```bash
   supabase secrets set VAPID_PUBLIC_KEY=<public> VAPID_PRIVATE_KEY=<private> VAPID_SUBJECT=mailto:<contact> PUSH_WEBHOOK_SECRET=<random>
   ```

3. Deploy the function (it uses `verify_jwt = false` from `supabase/config.toml`; it checks the secret itself):

   ```bash
   supabase functions deploy send-push
   ```

4. Vault secrets, in the SQL editor:

   ```sql
   select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/send-push', 'push_function_url');
   select vault.create_secret('<same random string>', 'push_webhook_secret');
   ```

5. GitHub repository variable `VITE_VAPID_PUBLIC_KEY` = the public key (Settings > Secrets and variables > Actions > Variables), then redeploy. For local dev put it in `.env.local`.

## Notes

- iPhone: alerts only work from the Home Screen app (iOS 16.4+). The toggle says so in Safari.
- Subscriptions belong to the phone's anonymous user; the app saves the subscription again on start, so a new sign-in keeps getting alerts.
- Dead subscriptions (404/410 from the push service) are deleted when a send fails.
- `push_outbox.sent_at` / `sent_count` show what went out.
