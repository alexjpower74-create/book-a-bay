# Book a Bay: build contract

One plan file. It is the contract, and it lives at the repo root so every agent reads the same copy.
Then read `docs/API.md` (the contract between slices) and `DECISIONS.md`. `BRIEF.md` is the original brief.

## The brief (Onyx for Alexander, 2026-09-14)
An online booking page for small auto repair shops, sold as an add-on to **Shop Board** (`~/Projects/Shop Board`,
read-only reference: never edit, never run it from its own folder). A customer picks a service, a day and a time slot,
enters name / phone / vehicle, and sends a **request**. The shop confirms, declines, or offers another time from its own
board; the customer's status link shows what happened. Confirmed bookings can be pushed into Shop Board as jobs through
its real `PUT /api/bookings/:id`, or exported as JSON/CSV.

Shop rules (settings, PIN-gated): services with duration and bays needed, number of bays, weekly hours, closed days,
holiday closures, lead time, max bookings per slot, NL time zone. **Slots are computed** from hours × bays × durations
minus holds. Two customers racing for the last slot: exactly one wins (D1 batch transaction), the other sees "just taken,
here are the next three". **No SMS or email is ever sent**: the shop gets "copy this text" buttons.

One SAMPLE shop: **"SAMPLE Auto Service — Grand Falls-Windsor (demo)"**, labelled SAMPLE on every screen. Never Warrior
Automotive or any real shop. Seeded customer names end in "(sample)".

## Design
Match Shop Board's default **Cosmic** theme so the two feel like one product. Read `~/Projects/Shop Board/app/src/styles.css`
(lines 1–130 and the `.btn`, `.glass`, `.bar`, `.stat`, `.tabs` rules) and `app/index.html`, and copy the tokens you need into
`app/public/theme.css` with a comment naming the source. The essentials: ground `#0a0f1c`, glass surfaces
`rgba(17,24,42,0.72)` with a 1px `rgba(255,255,255,0.08)` line and blur, text `#eef2ff`, accent indigo `#818cf8`, primary
button gradient `#6366f1 → #8b5cf6`, radius 14 / 9 px, Inter + Inter Tight (Google Fonts, system fallback), a slow aurora at
opacity 0.2 plus the dot grid, bay colours `#22d3ee #a78bfa #fb923c #34d399 #f472b6 …`, duration bands cyan (short) / violet
(medium) / magenta `#fb7185` (long). Status colours: Requested amber `#fbbf24`, Confirmed green `#34d399`, Offered cyan
`#22d3ee`, Declined rose `#fb7185`, Cancelled muted. Everything quiet under `prefers-reduced-motion`.
Phone-first at 390, desktop at 1280. Tap targets at least 44 px. No emoji as icons (inline SVG if any). Plain English for
Newfoundland customers: "Pick a service", "Pick a day", "Pick a time", "Your details", "Send request", "Request sent",
"The shop will confirm your time. Keep this link to check on it."

## Stack
- `worker/`: Cloudflare Worker, plain JS ESM, no build, no npm dependencies (use the `wrangler` on PATH, 4.131+).
  `worker/wrangler.toml`: name `book-a-bay`, `main = "src/index.js"`, D1 binding `DB` (`database_name = "book-a-bay"`,
  `database_id = "00000000-0000-0000-0000-000000000000"` with a comment that deploy replaces it), `migrations_dir = "migrations"`,
  `[assets] directory = "../app/public"`, `run_worker_first = ["/api/*"]`. No `TEST_MODE` in `[vars]`, ever.
- `app/public/`: plain HTML/JS/CSS served by the same Worker. `/` customer booking · `/r/?t=<token>` status page · `/shop/` shop side.
- `app/tests/`: Playwright 1.63 (`app/node_modules` is installed on main; the lead symlinks it into your worktree).
- Local dev everywhere: `wrangler dev --local --port <p> --inspector-port <p+10> --persist-to <dir>`. Pass `--var TEST_MODE:1` for tests.
- **Ports.** bb1: Worker 7302 (inspector 7312), fake Shop Board 7304, race negative control 7305 (inspector 7315).
  bb2: static dev server 7301, e2e Worker 7303 (inspector 7313). QA (lead): 7309 (inspector 7319). Never use another port;
  two other crews are running wrangler on this machine.

## Rules
- You own the files listed under your id and **nothing else**. If you need a change in someone else's file, say so in your
  report; do not reach in. `rig guard` enforces this. The lead owns `docs/API.md`: if the contract is wrong, stop and say so.
- Verify, then commit, then report. Never leave a verified step uncommitted: a usage-limit pause lands mid-task with no warning.
- Your report goes in `docs/build-report-<your id>.md`, committed with your work (tests passed/failed/skipped, negative controls
  with the exact break and the red output, known gaps).
- Commit only your own paths: `git commit -- <paths>`. Never grade the shared tree; the lead's numbers come from `rig qa`.
- A check that cannot fail measured nothing. Every task below names its negative control: make it red once, record it, restore.
- **Work in two milestones.** Finish M1, commit, write the report, and end your turn with a one-paragraph summary. The lead
  merges, sends a cross-review, then prompts you for M2. Do not start M2 before that prompt.
- Local only: no deploy, no `--remote`, no `d1 create`, no `secret put`. Nothing is sent anywhere. Auto mode denies something:
  do not work around it; note it in your report and carry on.
- No devils or demons, no emoji icons, SAMPLE on every screen, no real businesses.

## Agents

### bb1 — Worker, D1, slot maths, race guard, Shop Board adapter
Owns:
- worker/**

Report: docs/build-report-bb1.md

Task:
Implement `docs/API.md` exactly.

**M1 (commit as soon as it is green, then stop):** `wrangler.toml`; migrations (`0001_init.sql` tables and UNIQUE indexes per
API.md; `0002_defaults.sql` default settings: bays 3, Mon–Fri 08:00–17:00, Sat 09:00–13:00, Sun closed, step 30, lead 60,
max_per_slot 2, window 14, services Oil change 30/1, Tire swap 45/1, Brakes 120/1, Diagnostic 60/1, Truck or RV service 120/2,
and the PIN 2468 as PBKDF2-SHA256 hash + salt). `src/slots.js` (pure: slot rules 1–7, day list, `next` three, labels, NL time
zone maths via `Intl`), `src/clock.js` (now/IP with the `TEST_MODE` header rule), `src/index.js` router with: `GET /api/shop`,
`/api/days`, `/api/slots`, `POST /api/requests` (with the batch race guard between `// RACE-GUARD:BEGIN` and `// RACE-GUARD:END`
markers), `GET /api/r/:token`, `POST /api/shop/signin`, `GET /api/shop/board`, `POST /api/shop/requests/:id/confirm`,
`POST /api/test/reset`, `POST /api/test/seed`. `npm run dev` (7302), `npm test` = `node tests/run.mjs`: runs the pure unit tests,
then wipes `worker/.state-<port>`, applies migrations with `--local --persist-to`, starts wrangler dev with `--var TEST_MODE:1` on
`PORT` (default 7302) if nothing answers there, runs `node --test tests/api.test.mjs`, stops what it started.
M1 tests: `tests/slots.test.mjs` (pure) covers an open day's grid and step, lead time dropping early starts, Sunday closed with
reason, a closure date closed with its reason, a 2 h service not offered where it would pass closing, **the bay-count change**
(holds fill bays 1–2 at 10:00: with `bays: 2` 10:00 is gone, with `bays: 3` it is back, and a hold on bay 3 does not use
capacity once `bays: 2`), `bays_needed: 2` needing two free bays, `max_per_slot`, declined/cancelled not holding, an offered
request holding its offer time, window edges. `tests/api.test.mjs` M1: shop/days/slots shapes against API.md, create → 201 and
the time's capacity drops, status view `requested`, wrong PIN → **401** (and `X-Test-Now` ignored without `TEST_MODE`, tested on
`clock.js` directly), right PIN → token, confirm → status view `confirmed` with `ics_url`, **the race**: reset, leave exactly one
free slot, fire 8 concurrent `POST /api/requests` for it with distinct `X-Test-IP` → exactly one 201, seven 409 `taken` each with
`next.length === 3` and every `next` entry currently offered by `/api/slots`, and the board shows one holding item at that time.
M1 negative controls: (a) make the closed-day check ignore `closures` → the closure test goes red; (b) make availability ignore
the `bays` count → the bay-change test goes red; (c) `npm run negative:race` = `tests/negative-race.mjs`: copy `worker/` to a temp
dir, replace the RACE-GUARD region with an unguarded read-check-then-insert (separate awaited statements; an honest
`await scheduler.wait(25)` between check and insert stands in for network latency), add a migration dropping the UNIQUE indexes
on `cells` and `starts`, start that copy on 7305, run only the race test, and exit 0 **only if the race test fails with more than
one winner**. Append each run's output to `tests/negative-control.log`. The shipped code must contain no switch that turns the guard off.

**M2 (after the lead's prompt):** every remaining route in API.md: `/api/r/:token/accept|repick|cancel|ics`, shop decline/offer/
cancel, `/api/shop/slots?exclude=`, blocks, settings GET/PUT with full validation and `bays_in_use`, PIN change, signout, sign-in
rate guard (5 wrong / 15 min → 429), request rate guard (12/hour), `messages` texts, `src/shopboard.js` mapping + export JSON/CSV
+ push. Tests: every route's happy path and its main refusal (bad_state, busy, taken on repick and offer, bays_in_use, 429s),
decline releases the time (it is offered again), offer then accept, block-out removes times and refuses over a hold, settings
bay change seen through `/api/slots`, `.ics` is `text/calendar` with the right UTC `DTSTART` for a NL date in September (NDT,
UTC−2:30), `tests/shopboard.test.mjs`: the mapping table (9:30, 12:15, 12:45, 13:30, 7:45, 17:30; 30/45/60/120/200/300 minutes)
and a contract test against `tests/fake-shop-board.mjs` (port 7304), a tiny server that applies Shop Board's `validatePatch`
rules transcribed from `~/Projects/Shop Board/shared/domain.ts` (cite the file and `git -C` its HEAD sha) and answers 409 for
an occupied (date, slot, bay): push → 200 and `pushed_at` set, push over a taken row → 502 `shop_board_error`, no URL → 501.
M2 negative control: break one mapping row (12:45 → `12:00 PM`) → the mapping test goes red; and make the fake accept an
invalid slot → the contract test goes red. Record both.

### bb2 — Customer booking, status page, shop side, Playwright
Owns:
- app/**

Report: docs/build-report-bb2.md

Task:
Build the three screens per the brief and Design, talking only to the API in `docs/API.md` via `app/public/api.js`
(same-origin `fetch('/api/…')`; errors surface `error` text as-is). `app/serve.mjs`: tiny static server for `app/public` on 7301
that proxies `/api/*` to `API_ORIGIN` (default `http://127.0.0.1:7302`). Until bb1's M1 is on your branch you may develop against
`app/public/api.mock.js` (`?mock=1`, in-memory, same shapes as API.md), but **every Playwright test runs against the real Worker**.
Every screen shows the shop name with a visible **SAMPLE** badge. Shop dates come from `GET /api/shop`, never `new Date()`.

**M1 (commit when green, then stop):** `theme.css` + `style.css` (Cosmic), the customer page `/` (one page, four steps with a
progress header: service cards showing duration → 14 day chips with closed days greyed and their reason, full days "Full" → time
buttons → details form: name, phone, year, make, model, note, with inline plain-English validation → "Send request" →
"Request sent" with the status link and a "Copy link" button; a `409 taken` shows "Sorry, that time was just taken. Here are the
next three:" with three buttons that book straight into the details step), and the status page `/r/?t=` (big status pill
Requested / Confirmed / Declined / New time offered / Cancelled, the booking details, shop note, "Accept this time" and "Pick
another time" when offered, "Cancel my request", "Add to calendar" linking `ics_url` once confirmed; polls every 15 s and on
`visibilitychange`). `pwshot`-quality screenshots of both at 390 and 1280 into `app/tests/shots/`.

**M2 (after the lead's prompt; bb1 M1 is merged by then, `git rebase main` first):** the shop side `/shop/`: PIN sign-in (token
in `localStorage` key `book-a-bay:shop-token`, sign out), header with SAMPLE badge, **pending requests on top** (card: customer,
vehicle, service, time, Confirm / Decline / Offer another time with an inline day + time picker from `/api/shop/slots?exclude=`,
and "Copy text" buttons for each `messages` entry that put the text on the clipboard and say "Copied"), a **Today / Week** board
by bay (Today: one column per bay, rows on the 30-minute grid, items as blocks spanning their time in their status colour; at 390
the bays become a segmented control like Shop Board's; Week: 7 day columns listing items), "Block out time" (walk-in) form,
"Send to Shop Board" on confirmed items (shows the 501 message plainly when not configured) and "Download for Shop Board"
(JSON/CSV links), and **Settings** (services add/edit/deactivate, bays, hours per weekday with Closed toggles, closures, lead
time, max per slot, time step, change PIN) with the API's refusal messages shown inline. Board polls every 15 s and never
replaces a card whose picker or menu is open.
**Playwright** (`app/playwright.config.mjs`): projects `chromium-390` (390×844, hasTouch, isMobile), `chromium-1280` (1280×800),
`webkit-390` (iPhone 14), `webkit-1280` (1280×800); `workers: 1`; `webServer` = `node tests/start-worker.mjs` which, from
`../worker`, wipes `app/tests/.state-7303`, applies migrations `--local --persist-to` it, and runs wrangler dev on `E2E_PORT`
(default 7303, inspector +10) with `--var TEST_MODE:1`; `baseURL` = that Worker (it serves `app/public`). Every test starts with
`POST /api/test/reset` and pins the clock with `context.setExtraHTTPHeaders({ 'X-Test-Now': '2026-09-14T11:30:00Z' })` (Mon 9:00 AM NDT).
REAL input only: taps/clicks through a `tap()` helper that hit-tests the target's centre with `elementFromPoint` first, real
typing via `page.keyboard`; never set state with `evaluate`. Specs: `journey.spec.mjs` (customer books service → day → time →
details → Send; Request sent; status page says Requested; a second context signs in to `/shop/` with the PIN, sees the card in
pending, taps Confirm; the customer's status page shows Confirmed and an Add to calendar link whose URL returns `text/calendar`),
`pin.spec.mjs` (wrong PIN shows "That PIN is not right." **and** the sign-in response is 401, via `waitForResponse`),
`taken.spec.mjs` (settings leave one slot; two contexts pick it; the second to send sees "just taken" and exactly three
alternatives; tapping one reaches Request sent), `offer.spec.mjs` (shop offers another time → customer sees New time offered →
Accept → Confirmed), `days.spec.mjs` (Sunday chip disabled and says Closed; the SAMPLE badge is visible on all three screens;
primary buttons at 390 are at least 44 px tall and hit-test to themselves). Screenshots of every screen per project to
`app/tests/shots/`.
M2 negative controls: (a) break the status label mapping on the status page (confirmed shown as Requested) → `journey` goes red;
(b) put a transparent overlay over the Send request button → the `tap()` hit-test goes red. Record both with the red output, restore.

## Main (bb-lead, not a slice)
Owns PLAN.md, AGENTS.md, DECISIONS.md, docs/API.md, README.md, docs/DEPLOY.md, docs/build-report.md, docs/shots/**.
Merges each milestone after reading the diff, sends cross-reviews (bb2 reviews bb1's M1 against API.md; bb1 reviews bb2's M2
calls), runs `rig qa <sha>` on 7309 for the worker suite, the race negative control and the Playwright suite, runs a real
Shop Board round trip against a throwaway local clone (never the live one), takes `pwshot` screenshots into `docs/shots/`,
writes README / DEPLOY / build report, pushes the private repo, `rig down`, writes the status file.

## Open questions
None blocking. Anything that needs Alexander goes under NEEDS ALEXANDER in the status file.
