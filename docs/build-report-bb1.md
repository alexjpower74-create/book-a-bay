# Build report: bb1 (Worker, D1, slot maths, race guard)

Slice `bb1`, branch `rig/bb1`, owns `worker/**`. M1 written 2026-09-14. M2 not started (waiting for the lead's prompt, per PLAN.md).

## M1: what I built

| Item | Status | Where |
|---|---|---|
| `wrangler.toml` (name, main, D1 `DB` with placeholder id + comment, `migrations_dir`, `[assets]` `../app/public`, `run_worker_first = ["/api/*"]`, no `TEST_MODE`) | DONE | `worker/wrangler.toml` |
| `0001_init.sql`: every table in API.md "D1"; named UNIQUE indexes `cells_unique (date, bay, cell)` and `starts_unique (date, start_min, n)`; `token UNIQUE` | DONE | `worker/migrations/` |
| `0002_defaults.sql`: bays 3, Mon–Fri 08–17, Sat 09–13, Sun closed, step 30, lead 60, max 2, window 14, the five services, PIN 2468 as PBKDF2-SHA256 (100 000 iterations, random salt) | DONE | same |
| `src/slots.js`: pure rules 1–7, day list, `next` three, labels, NL time zone via `Intl` | DONE | `worker/src/slots.js` |
| `src/clock.js`: now / IP, test headers only when `TEST_MODE=1` | DONE | `worker/src/clock.js` |
| Routes `GET /api/shop`, `/api/days`, `/api/slots`, `POST /api/requests` (RACE-GUARD region), `GET /api/r/:token`, `POST /api/shop/signin`, `GET /api/shop/board`, `POST /api/shop/requests/:id/confirm`, `POST /api/test/reset`, `POST /api/test/seed` | DONE | `worker/src/index.js` |
| `npm run dev` (7302), `npm test` = `tests/run.mjs`, `npm run negative:race`, `npm run negative:slots` | DONE | `worker/package.json`, `worker/tests/` |

How the race guard works: `POST /api/requests` reads the holds, picks the lowest free bays and the smallest free start number `n`,
then writes the request row, one `cells` row per 15-minute cell per bay and one `starts` row in a single `DB.batch()`.
A UNIQUE violation means another customer won. The loser rolls back completely, re-reads, and retries if another bay set is
still free (up to 3 retries). Otherwise it answers `409 taken` with `next`, computed after re-reading.

## M1: verified (working tree, before commit; the lead's `rig qa` numbers are the ones that count)

`npm test` (it starts its own `wrangler dev --local` on 7302 with `--var TEST_MODE:1` and stops it afterwards): **24 passed, 0 failed, 0 skipped**.

- `tests/slots.test.mjs` (pure), 15 tests: the grid and step (30/60/15, Saturday); lead time dropping early starts (60/0/90/1 day);
  Sunday closed with "Closed Sundays"; a closure date closed with its reason, with an in-test control that the same
  Wednesday is open without it; a 2 h service ends 15:00, not 15:30; **the bay-count change** (bays 1–2 held across 10:00
  from different starts, so `max_per_slot` is not what removes it: `bays: 2` means 10:00 is gone, `bays: 3` brings it back on
  bay 3, and a hold on bay 3 does not use capacity at `bays: 2`); `bays_needed: 2`; `max_per_slot` (blocks do not count toward
  it; a released `n` is reused); declined/cancelled hold nothing, with a control that the same rows confirmed do hold; an offered
  request holds its offer time and date; window edges, including 11:30 PM NDT still being "today" in NL; `next` across a Sunday
  and a closure; NDT/NST instants; labels; lowest-bay picking.
- `tests/api.test.mjs`, 9 tests: `clock.js` directly (headers honoured with `TEST_MODE: '1'`, ignored with `{}`, `'0'`, `'true'`,
  `undefined`, and a garbage date); `/api/shop`, `/api/days`, `/api/slots` shapes, exact keys and 400 `field`s; create gives 201, then
  `truck-rv` loses exactly the 7 overlapping starts while `oil` at 10:00 still fits on bay 3; status view `requested` with every key;
  11 validation refusals each naming the field; wrong PIN is **401** `{ "error": "That PIN is not right.", "code": "unauthorized" }`, and
  shop routes with no token or a bad token are 401; right PIN gives a token expiring in 14 days; board shape plus the `confirmed`
  message text; confirm makes the status view `confirmed` with `ics_url`, a second confirm is 409 `bad_state`, and an unknown id is 404;
  **the race**: two brake jobs hold bays 1–2 from 8 to 10, then 8 concurrent `POST /api/requests` for oil at 9:00 (only bay 3
  free) with distinct `X-Test-IP`. Result: `statuses=201,409,409,409,409,409,409,409`. Each 409 is `taken` with `next.length === 3`
  and every `next` entry is in `/api/slots`. 9:00 is then gone, and the board shows exactly one item at 9:00, the winner, on bay 3.

### Negative controls (full red output in `worker/tests/negative-control.log`)

| Control | Break | Result |
|---|---|---|
| (a) closures | `npm run negative:slots`: in a copy, `dayInfo` gets `const closure = undefined` | **RED** as required: "a closure date is closed with its reason" fails, `actual: { open: true, … }`, `expected: { open: false, reason: 'Staff training (sample)' }`. The unbroken copy passes the same test first. |
| (b) bays | same script: `pickBays` loops `bay <= 10` instead of `bay <= bayCount` | **RED** as required: "the bay-count change" fails, `actual: { time: '10:00', … bays: [ 3 ] }`, `expected: undefined`. The unbroken copy passes first. |
| (c) race | `npm run negative:race`: copy `worker/` to `worker/.negative/race`, replace the RACE-GUARD region with SELECT check, `await scheduler.wait(25)`, then INSERTs one at a time; add `0003` dropping `cells_unique` and `starts_unique`; run only the race test on 7305 | **RED** as required: `RACE winners=8 losers=0 statuses=201,201,201,201,201,201,201,201`, `AssertionError: exactly one 201, got 8`. The script exits 0 only for "race test failed and winners > 1". |

How each runner could lie, and what stops it. Each break is a literal string that must match exactly once, or the runner
reports ERROR. The slot runner first runs the named test on the unbroken copy, and it counts as red only when that exact test
name shows `✖`, not a file-level crash. That rule caught a real mistake on the first run: my (b) replacement put a `//`
comment in front of the loop's `{`, the file stopped parsing, and the runner said **NOT RED** instead of passing it. The first
race run died on a `cpSync`-into-own-subfolder error and reported ERROR, not green. I fixed both and cleared the log; it holds only the final runs.

Other checks:
- The shipped code has no switch that turns the guard off: `grep "NEGATIVE CONTROL" worker/src` finds nothing, while the
  broken copy has it. `TEST_MODE` appears only in `clock.js` and the test-route gate.
- The log is committed, so both runners replace this machine's folder (plain and `file://` URL-encoded forms) with `<repo>`.
  A grep for home paths and the host name over `worker/` finds nothing. The same grep finds a known-bad line fed to it.
- A seed smoke run on 7302: 7 SAMPLE requests over Tue–Fri, one Walk-in block Tue 12–1 on all bays, and the offered request holds
  Thu 9:00 while keeping its own original bay.

## Decisions and small readings of the contract (lead: please confirm or overrule)

1. **Defaults live once.** `0002` stores each default under `default:<key>` and copies them to the live keys. `POST /api/test/reset`
   restores from those rows, so there is no second copy of the defaults in JS. `GET /api/shop/settings` (M2) reads only live keys.
2. **Sample closure is in the defaults:** `2026-09-21 "Staff training (sample)"`, from the API.md settings example and DECISIONS 11.
   bb2: Mon Sep 21 shows as closed with that reason in the pinned-clock tests.
3. **Service ids:** `oil`, `tire-swap`, `brakes`, `diagnostic`, `truck-rv`.
4. **Bad `time` on create:** a time that is not on the day's grid (off-step, past closing, closed day) is **400 `field: time`**. A grid
   time that is gone because of holds, the per-slot cap or lead time is **409 `taken`** with `next`.
5. **`messages` in M1:** the shop view already carries them. While `requested`, it lists `received`, `confirmed` and `declined`, so the shop can
   copy whichever it is about to send. `confirmed`, `offered` and `declined` show their own. `cancelled` shows none. The link in the text
   is the bare `status_url` path; **bb2 should replace that path inside `text` with `location.origin + status_url`**.
6. **`npm test` never wipes state under a running server.** If something already answers on `PORT`, it uses that server, and every API
   test resets first. It wipes `.state-<PORT>` and migrates only when it starts wrangler itself.
7. **The default PIN's salt is fixed in the migration.** It is random, but the same for every fresh install until the shop changes the PIN
   (M2 `PUT /api/shop/pin` makes a new one). README should keep saying "change it".
8. **Board `items` for an offered request** sit at the offer's date and time (where the hold is). The request's own `date`/`time`
   stay the original ask, and `offer` has the new time.
9. The Rig `check()` harness was not imported: it lives outside the worktree, and a home-folder import path would break the
   public-repo rule. Each negative control is instead a repeatable script with the same "must go red" rule.

## Left undone / known gaps

- **M2 routes** (not started, by design): accept/repick/cancel/ics, decline/offer/cancel, `/api/shop/slots?exclude=`, blocks, settings
  GET/PUT, PIN change, signout, both rate guards (the `attempts` table exists but nothing writes it yet), `src/shopboard.js`, export, push.
- The "test routes are 404 without `TEST_MODE`" check has no automated test yet; the gate is one line in the router. M2: start a second Worker without the var, or test the router directly.
- Wording: "Your brakes is booked…". The service name is used as is, as in the contract's example. Worth a small phrasing rule in M2.
- Seeded requests all share one `created_at`, so the seeded pending order is not meaningful.

## Needs from other slices

- bb2: decision 5 (prefix `location.origin` inside message text) and decision 2 (Sep 21 closure in the defaults).
- Lead: nothing blocking. Decisions 1–8 are readings of API.md you may want to fold into DECISIONS.md.
