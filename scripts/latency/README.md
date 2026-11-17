# Latency harness

Simulates 6-10 players on one game. Each runs the app's real sync engine (`GameSync` + `supabaseTransport`) with its own anonymous user and socket. Measures **send to receive**: from the moment a player starts an action until each phone (sender included) has applied the event in order.

Fails if p95 > `LATENCY_P95_MS` (default 1000), if any broadcast never arrives, or if presence doesn't show every player online. CI runs it with 10 players on the local Supabase stack after the database tests; a failure fails the build, so `main` doesn't deploy.

```bash
supabase start
```

```bash
SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_ANON_KEY="$(supabase status -o json | jq -r .ANON_KEY)" npm run latency
```

Options (env): `LATENCY_PLAYERS` (6-10, default 8), `LATENCY_ROUNDS` (sequential actions, default 40), `LATENCY_BURSTS` (everyone taps at once, default 5), `LATENCY_P95_MS`, `LATENCY_REPORT` (write JSON results to this path).

Notes:

- The local stack has no real network in the way, so CI mostly guards against regressions in the sync path. Real-network numbers come from the six-phone test (`docs/six-phone-test.md`).
- It can point at production, but each run signs in new anonymous users and leaves a lobby game behind.
- Local Supabase allows 30 anonymous sign-ins per hour per IP (`supabase/config.toml`), so about three runs an hour.
