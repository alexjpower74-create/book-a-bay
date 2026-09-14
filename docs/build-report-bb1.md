# Build report: bb1 (Worker, D1, slot maths, race guard)

Slice `bb1`, branch `rig/bb1`, owns `worker/**`. M1 written 2026-09-14, merged at a60a943. M2 written the same night, after the lead's prompt (section at the bottom).

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

- DONE in M2: **M2 routes** (were not started, by design): accept/repick/cancel/ics, decline/offer/cancel, `/api/shop/slots?exclude=`, blocks, settings
  GET/PUT, PIN change, signout, both rate guards (the `attempts` table exists but nothing writes it yet), `src/shopboard.js`, export, push.
- DONE in M2 (in-process test with a recording stub DB): The "test routes are 404 without `TEST_MODE`" check has no automated test yet; the gate is one line in the router. M2: start a second Worker without the var, or test the router directly.
- DONE in M2 (texts use the service as a name: "your Brakes booking"): Wording: "Your brakes is booked…". The service name is used as is, as in the contract's example. Worth a small phrasing rule in M2.
- DONE in M2 (created_at spread 97 minutes apart, oldest first): Seeded requests all share one `created_at`, so the seeded pending order is not meaningful.

## Needs from other slices

- bb2: decision 5 (prefix `location.origin` inside message text) and decision 2 (Sep 21 closure in the defaults).
- Lead: nothing blocking. Decisions 1–8 are readings of API.md you may want to fold into DECISIONS.md.

---

# M2 (after the lead's prompt, 2026-09-14)

Rebased onto main first (167f6f8, with API.md "Clarifications" 1–7). Ports: 7302 Worker, 7304 fake Shop Board, 7305 negative copies. Playwright not run (bb2's).

## M2: what I built

| Item | Status | Where |
|---|---|---|
| `POST /api/r/:token/accept` · `/repick` · `/cancel` · `GET /api/r/:token/ics` | DONE | `worker/src/index.js` |
| `POST /api/shop/requests/:id/decline` · `/offer` · `/cancel` · `/push`; confirm rewritten onto the same race-safe path | DONE | same |
| `GET /api/shop/slots?service=&date=&exclude=` | DONE | same |
| `POST /api/shop/blocks`, `DELETE /api/shop/blocks/:id` (busy + `conflicts`) | DONE | same |
| `GET`/`PUT /api/shop/settings` with full validation and `bays_in_use` | DONE | same |
| `PUT /api/shop/pin`, `POST /api/shop/signout` | DONE | same |
| Sign-in guard (5 wrong / 15 min / IP → 429), request guard (12 / hour / IP → 429) | DONE | same |
| `messages` texts that read right for every service name (lead item 3) | DONE | same |
| Seed with spread `created_at`, oldest request first (lead item 4) | DONE | same |
| `src/shopboard.js`: mapping, patch, CSV; `GET /api/shop/export/shop-board`; push with Shop Board's error text in the 502 | DONE | `worker/src/shopboard.js`, `index.js` |
| Race-safe status changes (lead item 1, clarification 7) | DONE | `index.js` `changeStatus`, `IF_APPLIED`; migration `0003_transitions.sql` |
| Fake Shop Board transcribed from Shop Board at **25c6faa** (`shared/domain.ts` validatePatch/rowsOf/spanOf/collision/busyMessage; `worker/src/index.ts` save() bodies) (lead item 5) | DONE | `worker/tests/fake-shop-board.mjs` |
| Test-routes 404 without `TEST_MODE`, proven in-process (lead item 2) | DONE | `worker/tests/api.test.mjs` |

**How status changes stay race-safe.** Each change is one `DB.batch()`. The `UPDATE … WHERE id = ? AND status IN (allowed)` also
stamps a fresh random `rev`. Every hold statement in that batch carries its own condition:
`DELETE … WHERE owner = ? AND (SELECT rev FROM requests WHERE id = ?) = <this rev>`, and the inserts use `INSERT … SELECT … WHERE` with the same check.
So holds are released or placed only if this exact transition happened, not merely "status is now X". Moves (offer, repick) release
and place in the same batch and keep the `UNIQUE` guard, so a move that collides rolls back whole and retries like a new request.
There is no JavaScript status pre-check in front of confirm, decline or cancel: the batch decides, and a 0-row UPDATE is re-read
into `409 bad_state` or `404`.

## M2: verified (working tree; the lead's `rig qa` numbers are the ones that count)

`npm test` (it starts the fake Shop Board on 7304 and `wrangler dev` on 7302 with `TEST_MODE=1` and `SHOP_BOARD_URL=http://127.0.0.1:7304`, then stops both):
**unit 20 passed, 0 failed · API 30 passed, 0 failed, 0 skipped.**

- `tests/shopboard.test.mjs`, 5 tests.
  - The mapping table: 9:30→9:00, 12:15→12:00 PM, 12:45→12:30 PM, 13:30→1:00, 7:45→8:00, 17:30→5:00, plus edges; minutes 30/45/60/120/200/300 (and 15/180/240).
  - `toPatch` field for field, with cuts to Shop Board's limits, and Shop Board's own `validatePatch` accepts the result.
  - CSV quoting.
  - **Contract, the fake refuses what Shop Board refuses**: bad slot, estTime, bay, date, `at`, over-long name, unknown field, missing slot, bad id. Each gives the exact 400 text; control: the same patch without the fault is 200.
  - **Contract, landing**: every mapping row lands 200 `{id, booking, rejected}`. A second id on the same row gives
    `409 {"error":"9:00 is taken","code":"taken","conflict":{"slot":"9:00","bay":"2"}}`. A 2h job from 12:30 PM gives
    `409 {"error":"Bay 2 is busy until 3:00 with Long job (sample)","code":"busy","conflict":{…,"until":"3:00",…}}`.
    Note the 3:00: `rowsOf('2h')` is 3 rows, and after 12:30 PM the rows are 1:00 and 2:00. My first expectation said 2:00 and the transcribed fake correctly failed it.
- `tests/api.test.mjs`, 21 new tests (9 from M1 still pass).
  - **Test routes:** reset/seed/holds are 404 with env `{}`, `TEST_MODE: '0'` and `'true'`, and the recording stub DB saw **zero calls**. Control: `TEST_MODE: '1'` is not 404 and does call the DB.
  - **Decline:** releases the time; the truck slot is offered again, holds `[]`. The note is kept and appears in the declined text. A second decline is `bad_state`, an unknown id 404, an over-long note 400.
  - **Offer then accept:** `/api/shop/slots` without `exclude` hides 9:30, and with `exclude` shows it. The offer moves the cells to Wed 10:00 (cells 40, 41, start n=1). The board lists the request at the offer. Accept gives `confirmed` at Wed 10:00, `offer: null`, `ics_url`, holds unchanged. A second accept is `bad_state`.
  - **Offer refusals:** busy over an all-bays block, with `conflicts: [{id, name: "Walk-in", label: "Wed Sep 16, 1:00 PM", bays: [1,2,3]}]`; `taken` + 3 `next` at a start already at `max_per_slot`, with nothing changed; 400 off the grid; `bad_state` once confirmed.
  - **Repick:** moves the cells to 14:00. `taken` + `next` leaves the hold where it was. Repick from offered clears the offer. Out of window is 400, confirmed is `bad_state`.
  - **Cancel:** the customer can cancel from requested or confirmed, releasing the hold; the shop can cancel only from confirmed, keeping the note, with no messages after.
  - **.ics:** `text/calendar; charset=utf-8`, `attachment; filename="booking.ics"`, CRLF only, `DTSTART:20260915T120000Z` for 9:30 AM NDT, `DTEND:…123000Z`, UID, SUMMARY, lines ≤ 75 octets. It is `bad_state` before confirm.
  - **Blocks:** the block removes 12:00/12:30 and appears on the board. Busy over a hold, with `conflicts` naming the customer. Bay 2 is still allowed. Delete gives the time back; a second delete is 404. Five 400s name their fields.
  - **Settings:** GET shape without `pin`; PUT round trip; 23 refusals, each naming its field; a refused save changes nothing.
    - A bay change is seen through `/api/slots`: 10:00 goes and comes back.
    - `bays_in_use`: `"Bay 3 has 1 booking from Tue Sep 15. Move or decline it first."`, and after declining it, the save goes through.
    - Renaming or deactivating a service keeps the request's snapshot, and the shop can still move that request.
  - **PIN change:** a wrong current PIN is 401 and a bad new PIN is 400 `field: next`. After a change, the old PIN is 401, the new one 200, this device stays signed in and the other session is 401. Reset restores 2468.
  - **Signout:** ends the session.
  - **Sign-in guard:** 5 wrong gives 401 ×5, then **429 even for the right PIN**. Another IP gets 200; 16 minutes later, 200.
  - **Request guard:** 12 × 201, then **429**. Another IP gets 201; 61 minutes later, 201.
  - **Messages:** every service name appears as written, with no "is booked" / "your brakes". The Brakes texts are checked exactly.
  - **Seed:** pending names in order Jordan, Sam, Terry, Morgan; `created_at` strictly ascending; every name ends "(sample)"; one block.
  - **Confirm and Decline at once, 10 times over** (reset between runs, send order alternating), giving
    `STATUS-RACE outcomes=confirmed:2c1s,declined:0c0s,…×5 bad=0`. Exactly one call gets 200 and the other 409 every run, and a holding status ⇔ the exact holds recorded at creation.
  - **Push:** a requested booking is `bad_state`. A confirmed one gets 200 `{pushed: true, shop_board: {status: 200, body: {id, booking, rejected}}}`, the fake holds `slot 9:00, bay 1, estTime 30m, issue "Oil change (booked online for 9:30 AM)"`, and `pushed_at` is set.
    - Over a taken row: `502 shop_board_error`, `shop_board: {status: 409, body: {"error":"10:00 is taken","code":"taken",…}}`, `error` contains `10:00 is taken`, `pushed_at` stays null.
    - Over a covering job: `502`, with `error` containing `Bay 1 is busy until 11:00 with Long job (sample)`.
  - **No `SHOP_BOARD_URL`:** in-process `501 not_configured`. Control: with a URL it gets past the gate to `409`.
  - **Export:** JSON `shop-board-patches/v1`, confirmed only, exact patch. CSV header and row exact, `text/csv`. An empty range is `[]`. `format=xml` and `to < from` are 400.
- **Settings race guard check (by hand, recorded here):** the `putSettings` batch starts with
  `SELECT json(CASE WHEN EXISTS (cells on a removed bay from today) THEN 'bays in use' ELSE '0' END)`.
  Against local D1, `json('bays in use')` raised `malformed JSON: SQLITE_ERROR`, and the probe file's own `CREATE TABLE` did not survive (the table is absent afterwards), so the failure rolled everything back. With the condition false it returned `"0"`.

### M2 negative controls (all red as required; full output in `worker/tests/negative-control.log`, which also keeps a re-run of M1's three)

| Control | Break | Result |
|---|---|---|
| status race (`npm run negative:status`) | in a copy, `IF_APPLIED` → `' AND ?2 IS NOT NULL AND ?3 IS NOT NULL'` (the release DELETEs no longer wait for the transition), run on 7305 | **RED**: `STATUS-RACE outcomes=confirmed:0c0s,declined:0c0s,…×5 bad=5`. Every run where Confirm landed first ends **confirmed with no cells**: the losing Decline still deleted the holds. |
| (d) mapping row (`npm run negative:shopboard`) | `['12:30 PM', 750]` → `766`, so 12:45 maps to `12:00 PM` | **RED**: "the mapping table" fails; the unbroken copy passes first. |
| (e) lenient fake (same script) | fake: `if (field === 'slot' && !isSlot(value))` → `&& false` | **RED**: "contract: the fake refuses what Shop Board refuses" fails; the unbroken copy passes first. |
| (a) closures, (b) bays, race: re-run on the M2 tree | as in M1 | **RED** again (race: 8 winners). The race copy's drop-indexes migration is now `0099_…`, so it cannot collide with `0003`. |

The runners share `tests/negative-lib.mjs`: a literal break that must match exactly once, the named test shown `✖` (a crash is not red),
and a log scrubbed of this machine's folder names. `npm run negative` runs all four.

## M2 decisions (lead: please confirm or overrule)

1. **`rev` column** (migration `0003`) instead of the status-only condition you sketched. It ties holds to *this* transition, so a
   decline that lost cannot act on a request that was declined and re-requested in between. It is one extra column beyond API.md's D1 list.
2. **Test-only `GET /api/test/holds?owner=r:<id>`** returns the raw `cells`/`starts` rows. The status-race test needs the holds, and no
   public route shows cells. It exists only with `TEST_MODE=1`, and the in-process test covers its 404. It is not in API.md: yours to add or veto.
3. **Offer refusal:** no bay set free at that time gives `409 busy` + `conflicts` (the holds in the way). A free bay but the start is full
   (`max_per_slot`, lead time, or a lost race) gives `409 taken` + `next`. A repick refusal is always `taken` + `next`.
4. **Shop-side times follow the customer rules** (window, lead time, cap); `exclude` only frees the request's own hold.
5. **Rate guards:** a request counts only once it passes validation, so typo retries don't lock a customer out. A wrong PIN counts on
   sign-in and on PIN change. The right PIN does not clear the count, so a 6th try inside 15 minutes is 429 even if correct.
6. **PIN change ends every other session**; the device that changed it stays signed in.
7. **Push error text:** `"Shop Board did not take it: <Shop Board's error>"`, with the untouched body in `shop_board.body`.
   Unreachable gives 502 with `status: 0`. `pushed_at` is set only on a 200.
8. **Export needs the Bearer token** like every shop route. **bb2:** a plain `<a href>` cannot send it, so fetch with the header and save the blob.
   Defaults: `from` = today, `to` = from + 59 days, `format` = json.
9. **Messages:** received "We got your request for Brakes on …", confirmed "Your Brakes booking is confirmed for …",
   declined "Sorry, we can't fit in your Brakes booking on …", offered "We can't do … for your Brakes booking, but we can take you on …".
   The shop note goes before the link.
10. **The fake does not model** Shop Board's per-cell stamp merge or drag swaps (a patch overwrites the fields it names; a move onto
    an occupied row is refused as `taken`). Book a Bay never sends a move, so the contract it tests is the part we use.

## M2: left undone / known gaps

- DONE in M3 (guard statement in every cell-writing batch, API.md clarification 16): **Lowering bays vs a booking in flight:** the settings batch refuses if a cell sits on a removed bay at commit time. A new booking
  that read the old bay count *before* the save, and commits *after* it, could still land on the removed bay. The window is milliseconds
  and it takes a shop edit, but it is not closed. Closing it means adding a `bay <= bays` guard statement to the booking batch, which
  would sit inside the RACE-GUARD region. I left that for your call rather than change the region you QA'd.
- DONE in M3 (the bays-in-flight test drives the settings guard's 409 side 5 times per `npm test`): The settings race guard's rollback was checked by hand against local D1, not by an automated race test.
- `npm test` against an **already running** Worker skips starting its own. The push tests then need that Worker to have been started with
  `SHOP_BOARD_URL=http://127.0.0.1:7304`.
- Pending order uses `created_at`; two real requests in the same millisecond fall back to id order.

## M2: needs from other slices

- **bb2:** decision 8 (export download needs a header, so fetch + blob); push 501 text is `Shop Board is not connected yet. Use "Download for Shop Board" instead.`;
  offer refusals are `busy` (show `conflicts`) or `taken` (show `next`); settings refusals name `field` (`hours`, `closures`, `services` are whole-section fields).
- **Lead:** decisions 1, 2 and the bays-in-flight gap.

---

# M3: bays in flight (API.md clarification 16, 2026-09-14)

Rebased onto main first (d5e3d86). Ports 7302, 7304 and 7305 only. `app/` untouched. Playwright not run.

## M3: what I built

| Item | Status | Where |
|---|---|---|
| `BAY_GUARD_SQL`: `SELECT json(CASE WHEN ?1 > (SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'bays') THEN 'bay removed' ELSE '0' END)`, bound to the highest bay the batch writes | DONE | `worker/src/index.js` |
| The guard in the **booking batch** (`stmts`, built just before the RACE-GUARD region; the region's catch now treats it like a UNIQUE loss) | DONE | `postRequest` |
| The guard in the **moveHold batch** (offer, repick) | DONE | `moveHold` |
| The guard in the **block-out batch** too (not asked for, same gap: it writes cells on shop-chosen bays); a refusal there is `400 field: bays` "The number of bays just changed. Please pick the bays again." | DONE | `createBlock` |
| On a guard refusal: **re-read settings and holds and retry**, exactly like a UNIQUE loss (`lostHold`), ending in `409 taken` + `next` computed with the fresh settings | DONE | `postRequest`, `moveHold` |
| RACE-GUARD markers kept; `negative:race` still replaces the region and still goes red (8 winners, re-run on this tree) | DONE | `worker/tests/negative-race.mjs` |
| Test: 6 concurrent bookings plus `PUT settings bays: 2`, 10 runs | DONE | `worker/tests/api.test.mjs` |
| `npm run negative:bays` | DONE | `worker/tests/negative-bays.mjs` |

Both writers are now transactions that read what the other writes. The settings save checks `cells` on removed bays at commit (M2),
and every cell-writing batch checks `settings.bays` at commit (M3). D1 serialises the two transactions, so whichever commits second sees
the first. Either the save wins and the booking retries into `taken`, or the booking wins and the save answers `bays_in_use`. Never both.

## M3: verified (working tree; the lead's `rig qa` numbers are the ones that count)

`npm test`: **unit 20 passed, 0 failed · API 31 passed, 0 failed, 0 skipped.** Race still `winners=1`, status race still `bad=0`.

**"lowering bays while bookings are in flight: never a hold above the stored bay count"**
- **Setup, each run:** bays 1–2 are blocked Tue 11:00–11:30, so only bay 3 can take an 11:00 oil change. Six `POST /api/requests` for it (distinct `X-Test-IP`) and `PUT /api/shop/settings { bays: 2 }` go out together. Reset between runs.
- **Timing:** the only thing varied is client-side send timing. The save goes 15 ms after the bookings in run 0, down to 12 ms before them in run 9 (`(run - 5) * 3` ms), so both orderings really happen.
- **Checked after every run:**
  - no winner holds a cell on a bay above the stored count
  - save 200 ⇒ stored bays 2 and no winner
  - save 409 ⇒ `bays_in_use`, stored bays 3, exactly one winner, on bay 3
  - every other booking is `409 taken`
- **Coverage:** the test also fails unless both endings occurred.
- **Result:** `BAYS-RACE outcomes=save409:bays3:1w:bay3 ×5, save200:bays2:0w:nobay3 ×5 bad=0`.
- **How I got there:** my first version fired the save first in every run and saw only `save200` endings, both guarded and unguarded. It passed while measuring one side. That is why the stagger and the "both endings" check exist.

## M3: negative control (`npm run negative:bays`, full output in `worker/tests/negative-control.log`)

**Break:** in a copy, only `BAY_GUARD_SQL` is replaced, by `"SELECT ?1 AS unguarded"`. It keeps its one binding and checks nothing, so the guard disappears from all three batches at once. The settings save keeps its own M2 guard.

**What I did, in order. All runs are in the log; the four NOT RED verdicts (runs 1, 2, 4, 6) are kept on purpose.**

| # | Setup | Result |
|---|---|---|
| 1 | Guard removed, no added latency, save fired first, 10 runs | **NOT RED**: every run `save200:bays2:0w`. The booking's read→batch gap is a few ms locally, and the save always committed first. |
| 2 | Guard removed, no added latency, the test's stagger (above), 10 runs | **NOT RED**: 5 × `save409:bays3:1w`, 5 × `save200:bays2:0w`. The windows never overlapped. |
| 3 | As brief allowed: **`await scheduler.wait(25)` between the booking's read and its batch, in the broken copy only** (after the plan is built, just before the RACE-GUARD region), 10 runs | **RED**: 3 of 10 runs `save200:bays2:1w:bay3`. But this had no guarded control yet. |
| 4 | Added a **control copy** with the same 25 ms wait and the guard kept, which must pass. 10 runs, 3 ms stagger | **NOT RED by the runner's rule**: the control kept the invariant (`bad=0`), but with 25 ms of latency and at most 15 ms of stagger no booking ever came first, so the test's "both endings" check failed. Broken copy: 5 doubled runs. |
| 5 | Stagger 9 ms, 10 runs | **RED**: control passed (2 booking-first, 8 save-first); broken copy 1 of 10 doubled. Too thin for a QA re-run. |
| 6 | Stagger 9 ms, 20 runs | **NOT RED**: 0 doubled. Most of the extra runs put the save 50–126 ms ahead, where no booking has read the old count yet. The sweep was aimed badly. |
| 7 | **Final:** a sweep over the window where a double booking can happen. 20 runs, 2 ms apart, bookings going out 40 ms down to 2 ms ahead of the save (`(run - 20) * 2`), 25 ms latency, same timing in both copies | **RED**, below. |

**Final red output (run 7):**
```
runs: 20 per copy, send stagger (run - 20) * 2 ms (bookings 40 ms ahead down to 2 ms ahead), added latency 25 ms
[bays-control] guard kept · extra: await scheduler.wait(25) between the booking's read and its batch
BAYS-RACE outcomes=save409:bays3:1w:bay3 ×16, save200:bays2:0w:nobay3 ×4 bad=0
✔ lowering bays while bookings are in flight
control: PASSES with the same latency and the guard kept (16 booking-first, 4 save-first runs).
[bays] break: BAY_GUARD_SQL -> "SELECT ?1 AS unguarded" · extra: await scheduler.wait(25) (this copy only)
BAYS-RACE outcomes=save409:bays3:1w:bay3 ×16, save200:bays2:1w:bay3 ×4 bad=8
✖ lowering bays while bookings are in flight
  'run 16: stored bays 2 but a booking holds bay 3'   (and 17, 18, 19)
verdict: RED as expected. With the same latency, the guarded copy passed and the unguarded copy let 4 of 20 runs save bays=2 while a booking held bay 3.
```
**Confirmation re-run** of the same default, before commit: RED again. The control passed (15 booking-first, 5 save-first) and the broken copy doubled 5 of 20 (runs 7, 16, 17, 18, 19).
Log tally at commit: 14 RED, 4 NOT RED (the M3 attempts above), 0 ERROR.

Runs 16–19 have identical send timing in both copies. With the guard, the save won and nobody holds bay 3. Without it, the save
won **and** a booking holds bay 3. The only difference between the two copies is the one guard line.

`npm run negative:bays` now does exactly run 7 by default (20 runs, step 2, offset 20, 25 ms). Overrides: `BAYS_RACE_RUNS`,
`BAYS_RACE_STAGGER_STEP_MS`, `BAYS_RACE_STAGGER_OFFSET`, `NEGATIVE_BAYS_WAIT_MS`. The wait exists only in the copies:
`grep "NEGATIVE CONTROL" worker/src` finds nothing.

## M3: notes for the lead

- **Honest limit of the control:** without added latency, the unguarded code did not double book in 20 local runs. Local D1 is too fast
  for the booking's read→batch gap to overlap a save. The red needs 25 ms of stand-in latency, recorded above. In production, D1
  round trips make that gap real, which is why the guard is there.
- **Stagger settings are test knobs, not product switches.** They only change when the test's client sends, in `api.test.mjs`.
- **The block-out guard** was not in the brief. It closes the same gap for a walk-in block on a bay being removed. Veto if you'd rather it wasn't there.
- `npm run negative` now also runs `negative:bays`: all five control scripts, six breaks.

## M3b: bb2's cross-review findings (API.md clarifications 17 and 18, 2026-09-14)

Rebased onto main first (4655f89). Ports 7302, 7304 and 7305 only. bb2's third finding, message grammar, was already fixed in M2.

| Item | Status | Where |
|---|---|---|
| **17.** The shop view's `offer` is `{ date, time, end, label, bays }`, with `bays` from `offer_bays`. The customer view's `offer` stays `{ date, time, end, label }`. | DONE | `worker/src/index.js`: `offerOf(row, { bays: true })` in `shopView` only |
| **18.** Every miss under `/api/r/*` is `404 {"error":"We could not find that booking. Please check the link the shop sent you.","code":"not_found"}`, whatever the token looks like | DONE | the router's token pattern `([A-Za-z0-9_-]{16,128})` becomes `([^/]*)`, so any shape reaches the handler, whose lookup answers that 404 |
| `npm run negative:contract` (both controls; an unbroken copy passes first, then the broken copy on 7305) | DONE | `worker/tests/negative-contract.mjs` |

### M3b: verified

`npm test`: **unit 20 passed, 0 failed · API 33 passed, 0 failed, 0 skipped.** Race `winners=1`, status race `bad=0` and bays race `bad=0` (5 booking-first, 5 save-first) are unchanged.

- **"shop view: an offered request carries the bays its offer holds; the customer view does not"**
  - Setup: a 2-bay truck job asks for Tue 10:00 (bays 1, 2). Bay 1 is blocked Wed 10:00–12:00, then the shop offers Wed 10:00, so the offer lands on **bays 2 and 3**.
  - The bays taken from the offer's actual cells (`/api/test/holds`) are `[2, 3]`.
  - The offer response, the board item and the pending card all carry `offer.bays` equal to that.
  - The request's own `bays` stay `[1, 2]`, and the customer view's offer has no `bays`.
  - The M2 offer/accept test now also expects `bays: [1]` on the shop offer and checks the customer offer's exact shape.
- **"every miss under /api/r/ is 404 with the booking text, whatever the token looks like"**
  - Ten requests, each giving exactly that body with 404: `GET /api/r/nope`, `GET /api/r/abc$def`, `POST /api/r/nope/accept`, `POST …/nope/repick`, `POST …/nope/cancel`, `GET …/nope/ics`, `POST /api/r/abc$def/cancel`, `GET /api/r/abc%20def`, a well-formed unknown 32-char token, and a 200-char token.
  - Control in the same test: a real token still opens its booking with 200.

### M3b: negative controls (red output from `worker/tests/negative-control.log`)

| Control | Break | Result |
|---|---|---|
| offer bays | `shopView`: `offer: offerOf(row, { bays: true })` → `offer: offerOf(row)` | **RED**. The unbroken copy passes first. Output: `✖ shop view: an offered request carries the bays its offer holds`, with `actual: { date: '2026-09-16', time: '10:00', end: '12:00', label: 'Wed Sep 16, 10:00 AM' }` and `expected: { …, bays: [ 2, 3 ] }`. |
| token pattern | `const TOKEN = '([^/]*)'` → `'([A-Za-z0-9_-]{16,128})'` (the old one) | **RED**. The unbroken copy passes first. Output: `✖ every miss under /api/r/ is 404 with the booking text`, `AssertionError: GET /api/r/nope`, with `actual: { error: 'Not found.', code: 'not_found' }` and `expected: { error: 'We could not find that booking. Please check the link the shop sent you.', code: 'not_found' }`. |

`npm run negative` now runs all six control scripts: slots, shopboard, race, status, bays, contract.

### M3b: one decision and its limit (lead: confirm or overrule)

- **No catch-all route for `/api/r/*`.** A fallback that answers the booking text for any unmatched `/api/r/…` path would also
  answer it while the old strict pattern was in place. The negative control could then never go red, so the fix lives in the
  token pattern itself. **The limit:** a path that is not one of the five customer routes, such as an unknown action
  (`GET /api/r/<token>/nope`) or a wrong method (`DELETE /api/r/<token>`), still gets the router's generic
  `404 {"error":"Not found.","code":"not_found"}`. The app never builds those links. If you want them covered too, a
  second-segment catch-all can be added without weakening this control, because `GET /api/r/nope` has no second segment.
