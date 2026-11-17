# Six-phone test (phase 1 gate)

Gate from `docs/spec.md` §9: **6 phones, p95 < 1 s, recovery < 3 s**. The CI latency harness covers p95 on a local stack. This checklist covers what only real phones on real networks can: the production backend, mobile data, locked screens and app switching.

## Setup

- [ ] 6 phones: at least 2 iPhones with the app **added to the home screen** (PWA) and at least 2 Android phones in Chrome. Note each phone's model and OS below.
- [ ] Everyone on **mobile data**, Wi-Fi off (Wi-Fi only where a step says so).
- [ ] Everyone on the latest build: the build hash at the bottom of the screen matches the latest `main` commit.
- [ ] One person is the **recorder**: a stopwatch, this checklist and the results table.
- [ ] Host creates a game. Other 5 join: 2 by typing the code, 2 by QR, 1 by the share link.
- [ ] Teams: 3 hiders, 3 seekers. Choose a play area. **Don't start the game yet** (lobby actions are the test actions).

| # | Name | Phone / OS | PWA or browser | Team |
| --- | --- | --- | --- | --- |
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |
| 4 | | | | |
| 5 | | | | |
| 6 | | | | |

How to time things: the sender says "go" as they tap; everyone else calls out when it appears. Anything over **1 s** is a fail, anything over **3 s** to recover is a fail. Note it with the step number.

## 1. Baseline (all phones open, screens on)

- [ ] All 6 show the green **Live** dot.
- [ ] Every player row shows a green **presence dot** on every phone.
- [ ] Host changes a setting (e.g. answer deadline). All 5 others see it within 1 s. Repeat 5 times.
- [ ] Each non-host player switches team and back. Everyone sees each move within 1 s.
- [ ] Two players switch team **at the same moment**. Both moves appear, in the same order, on all 6 phones (compare the event log under "Event log" at the bottom).
- [ ] Event log: the last `#seq` is the same on all 6 phones.

## 2. Airplane mode

Phone A (an iPhone PWA) and phone B (Android) take turns.

- [ ] A turns on airplane mode. Within a couple of seconds A shows a red **Offline** dot and the **No connection** banner, and the screen is dimmed and can't be tapped.
- [ ] A tries to tap a team button: nothing happens (no queued action, no error later).
- [ ] Other phones: A's presence dot goes to **away** (hollow) within about a minute.
- [ ] While A is offline, host changes a setting twice and someone switches team.
- [ ] A turns airplane mode off. Start the stopwatch. A shows **Live** and all the missed changes within **3 s**. Banner gone.
- [ ] A's last `#seq` matches everyone else's. Nothing was applied twice or out of order.
- [ ] A's presence dot goes back to green on other phones.
- [ ] Repeat with B.
- [ ] Repeat with A offline for **5+ minutes** (long gap): same results, still under 3 s.

## 3. Locked screen

- [ ] Phone C locks its screen for **30 s**. Meanwhile host changes a setting.
- [ ] C unlocks. The app catches up within **3 s** (the banner may flash "Catching up…" briefly; it must not stay). The change is there.
- [ ] Repeat with the screen locked for **5 minutes**, with 3+ changes while locked.
- [ ] Repeat with the screen locked for **20+ minutes** (iOS will usually kill the socket): reopen shows the banner, then Live with everything within 3 s.
- [ ] While C is locked, other phones show C as **away** after a while, then green again after unlock.

## 4. App switching

- [ ] Phone D switches to another app (Maps, camera) for 30 s while host makes a change. Switch back: caught up within 3 s.
- [ ] D takes a photo with the camera app and comes back (common in the real game): caught up within 3 s.
- [ ] D switches away for 5+ minutes, then back: caught up within 3 s.
- [ ] iPhone PWA: swipe the app away completely (force quit), reopen from the home screen. It reopens the same game, signed in as the same player, caught up within 3 s.
- [ ] Android: same, from the recent apps list.
- [ ] Tap a team button **immediately** after switching back: it is either blocked by the banner until caught up, or works. It never applies from an old view (no "Something changed" surprise after the fact).

## 5. Bad networks

- [ ] Walk somewhere with weak signal (stairwell, basement, lift) with one phone. It should show Offline or Catching up when signal drops, and recover by itself when it returns.
- [ ] Switch a phone from mobile data to Wi-Fi mid-game and back: recovers within 3 s each time.
- [ ] Ride one stop on a train through a tunnel if convenient: recovers after the tunnel.

## 6. Start the game

- [ ] Host taps **Lock and start**. All 6 see the hiding countdown within 1 s.
- [ ] Countdowns on all 6 phones agree to within 1 s (hold them side by side).
- [ ] Lock one phone for 1 minute and unlock: its countdown is still correct.
- [ ] Presence dots are shown on the started screen too.

## Results

| Check | Result | Notes |
| --- | --- | --- |
| p95 delivery < 1 s (count late deliveries in §1) | | |
| Recovery < 3 s after airplane mode | | |
| Recovery < 3 s after locked screen | | |
| Recovery < 3 s after app switching | | |
| No action ever applied from a stale view | | |
| Presence dots correct | | |
| `#seq` identical on all phones at the end | | |

Problems: write the step number, the phone, what happened and roughly when (the server keeps event times). File an issue for each.
