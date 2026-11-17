# Hide + Drink: Design

Visual source of truth for the app. Decided 17 Nov 2026. Clickable mockups of every screen: [Hide + Drink: App Design canvas](https://claude.ai/artifact/2w1qyoD2LKYKgnv5bCbQiK) (bar names, player names and timer values there are sample data). If this file and the canvas differ, this file wins.

## Principles

1. **Glanceable, one-handed, in a dark bar.** Dark theme only. Big targets, few words.
2. **One thing needs you at a time.** Anything that needs action (incoming question, freeze, curse to clear) sits at the top of the screen until handled.
3. **Your team colour is always visible** in the top bar. Hider-only screens show a lock and "Only you see this".
4. **Never act on stale state.** Anything but a green status dot disables actions and says why.
5. **Suggest, don't decide.** Suggested answers and shading are labelled as suggestions; the hider's tap is final.
6. **Content is data.** Cards and questions render from one template each; a new card needs no UI work.

## Logos

| File | What | Use |
| --- | --- | --- |
| `public/wordmark.svg` | "hide", red plus square, "drink" in white bold lowercase | Use instead of typing "Hide + Drink" as a heading (alt text "Hide + Drink"). About 240 px wide on Home, on dark backgrounds only |
| `public/mark.svg` | The red square with a white plus on its own | Small spaces: tab title, loading spinner, compact headers |
| `public/logo.svg` | Navy bottle with a white "O" on a red label, on white with a light grey ground band | App icon, favicon, Home hero. The bottle is the same navy as the app background, so on navy always show it as its own tile with ~24% corner radius |

PWA icons in `public/` are rendered from `logo.svg` (`maskable-512.png` from a scaled-down copy so the bottle stays inside the safe zone).

The wordmark's real font is **Helvetica Neue LT Pro** (bold), which is licensed and not in the repo. `wordmark.svg` is a close copy drawn as outlines in Liberation Sans Bold. Replace it with an outlined SVG export of the original artwork when available. Never set the wordmark as live text; the UI fonts below are for everything else.

## Colour

| Token | Hex | Use |
| --- | --- | --- |
| `--bg` | `#17222E` | App background, PWA theme and background colour |
| `--surface` | `#22313F` | Cards, sheets, tab bar, inputs |
| `--surface-2` | `#2C3E50` | Raised items inside cards, selected rows |
| `--line` | `#3A4E62` | Borders, dividers, secondary button outline |
| `--text` | `#F0F0F0` | Body text, primary button fill |
| `--text-muted` | `#A9B4BF` | Secondary text (7.6:1 on bg) |
| `--hider` | `#5BB4F0` | Hider chip (text `#17222E`), hider circle, pin and dots |
| `--seeker` | `#D42F35` | Seeker chip fill (text `#FFFFFF`, 4.9:1) |
| `--seeker-on-dark` | `#FF6B6F` | Seeker dots, radar circles and red text on navy (5.3:1) |
| `--brand-red` | `#EC353A` | Logo red; curse category band. Never for small text on navy |
| `--alert` | `#F2B705` | Freeze and "questions blocked" banners (text `#17222E`), penalty log entries, syncing dot |
| `--ok` | `#4FC88A` | Live dot, ticks |

Card categories: curse `#EC353A`, powerup `#9B8CF5`, time bonus `#4FC88A`, drink `#F2B705`.

Map: ground `#1C2A37`, streets `#2A3B4C`, river `#24506E`. Ruled-out area is a grey 45° hatch (`#2C3E50` with `#5C6B7A` lines) so streets stay visible underneath.

## Type

- Headings, timers, the join code and card names: **Space Grotesk** 600/700.
- Everything else: **Inter** 400/600/700.
- Scale (px): 13, 15, 17, 22, 26, 34, 40. Body 16 to 17. Nothing under 12.
- Timers and codes use `font-variant-numeric: tabular-nums`.

## Shape and size

- Primary button: `--text` fill, `--bg` text, pill, 56 to 64 px tall, full width.
- Secondary button: transparent, 2 px `--line` (or `--text`) outline, pill.
- Irreversible actions (start round, lock in a bar): slide-to-confirm pill with a navy knob.
- Radius: inputs 14, cards 16 to 18, bottom sheets 22 to 24 (top corners), chips fully round.
- Touch targets at least 44 px. Spacing on an 8 px grid.

## Picked patterns

| Decision | Choice |
| --- | --- |
| Navigation in play | Bottom tabs, map first. Hider: Map, Hand, Questions, Log. Seekers: Map, Ask, Effects, Log |
| Card style | Playing card: tall, category colour band on top, cost badge (Free / Drink / Shot), text below |
| Map shading | Grey hatch over ruled-out area. No bar count until the venue list is comprehensive (the list of bars still possible stays) |
| Timers | Ring + digits for deadlines; digits in the top bar for the main clock; thin bar for running curses |
| Top bar (every in-game screen) | Team chip left, main timer centre with a small caps label, status dot right |

## Screens

Flow: Home → Lobby → (host: setup) → Start round → each phone switches to its team view → hider found → back to Lobby with roles swapped.

| Screen | Who | Key content |
| --- | --- | --- |
| Home | Everyone | Logo tile, wordmark (no typed title), name field, Create game, inline 4-letter code + Join (no separate join screen). No resume banner: reopening the app goes straight back into the saved game |
| Join via QR | Anyone scanning | Code prefilled from `?join=`, name, Join |
| Lobby | Everyone | Big join code + QR. Hiders and Seekers as full-width lists, one above the other (not side-by-side columns: names get cut off on phones). Tap your name to switch team; the host can tap anyone's. "Join" button under the team you're not in; unassigned players listed below. Host setup checklist, slide to start |
| Deck builder | Host | Presets, category tabs with live totals, -/count/+ per card (0 greys out), "+ New card" |
| Pick a bar | Hider | Hiding countdown, map + list of valid bars by distance, 100 m circle preview, slide to lock in |
| Hider map | Hider | Own bar circle and position, seekers' name-tagged dots (tap for distance), freeze banner, "New question" card with deadline |
| Answer sheet | Hider | Question type + asker, deadline ring, mini map, suggested answer (flag if it differs across the circle), big answer buttons, reward reminder |
| Hand | Hider | Selected card large, Cast / Discard, hand strip below, lock label |
| Seeker map | Seekers | Hatched shading with the remaining area outlined in white, bars still possible, teammates' name-tagged dots, active curse strip, Ask button |
| Ask | Seekers | 7 type tiles with draw/keep, tool on the map (e.g. radar circle), option chips, Send |
| Effects | Seekers | "Questions blocked" banner, curse cards with timer or We did it / Veto, vetoes used |
| Log | Both (filtered) | Newest first, elapsed time, coloured dot by type, photo proof thumbnails, penalties in amber |

## Not decided yet

- Light mode: not planned.
- Curses stay `--brand-red` even though seekers are red too; switch curses to purple if it reads badly in testing.
