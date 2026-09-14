# Build report — bb2 (customer booking, status page, shop side, Playwright)

## M1 — customer page `/` and status page `/r/?t=` — DONE

### What I built (all under `app/`)
- `public/theme.css`: Cosmic tokens copied from Shop Board `app/src/styles.css` (source lines named in the header comment).
  Aurora at 0.2, dot grid, glass, `.bar`, `.btn` raised to 44 px, status and bay colours, reduced-motion stand-down.
- `public/style.css`: layout for both pages, phone-first (390) with a 720 px breakpoint.
- `public/api.js`: the only door to the Worker. Same-origin `fetch('/api/…')`. Errors throw `ApiError` whose message is the API's `error` text as is
  (`code`, `field` and the body, e.g. `next`, are kept). `?mock=1` loads `api.mock.js` (remembered per tab, `?mock=0` turns it off).
- `public/api.mock.js`: dev-only in-browser stand-in for the customer routes with the same shapes as API.md and a copy of the slot rules.
  Fixed clock = the tests' `2026-09-14T11:30:00Z`. State lives in sessionStorage, so a status link survives navigation in the same tab.
  Demo tokens `demo-requested|confirmed|offered|declined`. `?taken=1` makes the next booking lose the race.
- `public/ui.js`: escaping, duration text, band, 24 h → 12 h label, status labels, day chips, time buttons, shop header, copy to clipboard.
- `public/index.html` + `book.js`: a progress header (Service / Day / Time / Details; done steps can be tapped to go back), then:
  - service cards with duration and a band colour;
  - 14 day chips (closed days disabled with their reason, open days with no times left "Full" and disabled, today marked "Today");
  - time buttons;
  - details form (name, phone, year, make, model, note) with inline plain-English validation that mirrors the API limits.
    API `field` errors land on that field; other errors show as is.
  - "Send request" → "Request sent" with the status link, "Copy link" ("Copied"), "Check on your request".
  - `409 taken` shows "Sorry, that time was just taken. Here are the next three:" with the `next` buttons. Tapping one makes it the chosen
    time and keeps the typed details (the wording adapts when `next` has fewer than 3).
- `public/r/index.html` + `status.js`: big status pill (Requested / Confirmed / Declined / New time offered / Cancelled), a line of plain
  English per status, the offered time, the shop note, and the booking details.
  - When offered: "Accept this time" and "Pick another time" (inline day chips and times, then "Ask for <time>"; a taken result shows the
    next three).
  - "Cancel my request" with an inline "Yes, cancel it / Keep it" question (no browser dialog).
  - "Add to calendar" linking `ics_url` once confirmed; "Book another time" after declined or cancelled; a dead link says so plainly.
  - Polls every 15 s and on `visibilitychange`, and does not redraw while the picker or the cancel question is open.
- `serve.mjs`: static server for `app/public` on 127.0.0.1:7301, `/api/*` proxied to `API_ORIGIN` (default `http://127.0.0.1:7302`).
- `tests/guard-clock.mjs`: fails on `new Date()` / `Date.now()` anywhere in `app/public`, after a self-test on known-bad lines.
- `tests/shots-m1.mjs`: M1 smoke + screenshots against the mock (see below). `tests/shots/`: the screenshots.

SAMPLE badge: every screen shows the shop name from the API and a SAMPLE badge while the API says `sample: true`.
Shop dates come only from the API; the guard enforces it.

### What I verified, and how it could have failed
`node tests/shots-m1.mjs` drives both pages with real input on chromium-390 (touch), chromium-1280, webkit-390 (iPhone 14, touch) and
webkit-1280. **182 passed, 0 failed.** Every tap goes through `tap()`: it hit-tests the target's centre with `elementFromPoint` and fails
if something else is on top. Typing is `page.keyboard`. `evaluate` only reads.

Scenarios:
- **journey:** SAMPLE badge + name; Sunday chip disabled and "Closed Sundays"; full Saturday "Full"; closure reason; 14 chips; times;
  empty Send shows the name/phone/make errors; the name error clears while typing; Send; "Request sent"; the link matches `/r/?t=<32+>`;
  Copy link puts exactly that link on the clipboard (chromium); primary buttons ≥ 44 px at 390; the status page says Requested with the
  right vehicle and time; cancel reaches Cancelled.
- **taken:** exactly three alternatives, the tapped one becomes the chosen time, typed details kept, reaches Request sent.
- **offered:** New time offered, offer time and shop note, Accept reaches Confirmed, Add to calendar href = `ics_url`.
- **repick:** pick another day/time, reaches Requested at the new time.
- **declined**, **bad link**, and no page errors in any scenario.

A real bug this caught: on webkit-390, after an empty Send, `focus()` on the name field let WebKit park it under the sticky header, and the
hit-test failed ("centre 195,24 lands on header.bar"). Fixed by focusing with `preventScroll` and centring the field, plus `scroll-margin-top`.

Negative controls (each broken, run, seen red, restored, then the full run green again):
- **(a) status label mapping broken** (`confirmed` shown as "Requested" in `ui.js`) → chromium run `85 passed, 2 failed`
  (`FAIL offered: locator.waitFor: Timeout 6000ms exceeded.` at 390 and 1280: the pill never says Confirmed).
- **(b) transparent overlay over Send request** (`#details::after`, 60 px, z-index 5) → `56 passed, 4 failed`, exit 1:
  `FAIL tap(Send request (empty)) hit-test: centre 195,733 lands on <form class="form" id="details" novalidate="">` (and the same at 1280).
- **(c) clock guard:** a copy of `public/` with `const today = new Date()` appended to `book.js` → `FAIL: browser clock used for dates …
  book.js:367: const today = new Date()`, exit 1. The guard also self-tests its pattern every run and exits 2 (VOID) if it cannot tell
  known-bad from known-good lines.

Screenshots (`app/tests/shots/`, chromium @2x, full page, scrolled to top with a real wheel):
`book-1-service`, `book-2-day`, `book-3-time`, `book-4-details-errors`, `book-4-details`, `book-5-sent`, `book-taken`, `status-requested`,
`status-cancelled`, `status-offered`, `status-confirmed`, `status-pick`, `status-declined`, `status-not-found`, each `-390` and `-1280`,
plus `pwshot-home-390.png` (pwshot chromium phone) and `pwshot-home-1280.png` (pwshot webkit).
I looked at them: the SAMPLE badge sits beside the name at 390 and wraps under it at 1280; nothing overlaps.

### Honest limits of M1
- **Nothing in M1 has run against the real Worker.** bb1's M1 is not on `rig/bb2` (it only had the contract commit when I started), so
  everything above ran against the mock. The mock follows API.md, but its validation wording is mine, and bb1's may differ (the app shows
  whatever the API says). The real-Worker Playwright specs are M2 work, as briefed.
- `shots-m1.mjs` is a dev smoke, not the `@playwright/test` suite; `playwright.config.mjs`, `start-worker.mjs` and the five specs are M2.
- In mock mode "Add to calendar" points at `/api/r/<token>/ics`, which the mock cannot serve through a real link; it works against the Worker.
- Duration bands are my call: short ≤ 45 min, medium ≤ 90, long > 90.
- The status page shows the customer "Pick another time" only when offered (as briefed), although API.md also allows repick while requested.

### Needs from other slices
- None blocking. For M2 I need bb1's M1 merged (`/api/test/reset`, `TEST_MODE`, the shop routes). A cross-review question for bb1:
  does `POST /api/requests` validation return `field` for each input (the form puts those errors inline)?

## Cross-review of bb1 M1 — DONE

Rebased on main (`a5e7cba`, bb1 M1 merged). I read the 7 API.md clarifications. Real Worker from this worktree:
`wrangler d1 migrations apply book-a-bay --local --persist-to .state-7303`, then
`wrangler dev --local --port 7303 --inspector-port 7313 --persist-to .state-7303 --var TEST_MODE:1`.
Every request below sent `X-Test-Now: 2026-09-14T11:30:00Z` after `POST /api/test/reset`, or after `/api/test/seed` where it says so.

**How I walked it.** `node tests/shots-m1.mjs --real` opens the Worker on 7303 directly: no mock, `extraHTTPHeaders` carries the clock,
and each scenario resets first. It covers chromium-390/1280 and webkit-390/1280. Setup goes through the API only: two other customers
taking 10:00, sign-in, board, confirm, seed.
**178 passed, 0 failed, 5 waiting on bb1 M2** (distinct steps, each on all 4 projects: ics returns text/calendar, Cancel → Cancelled,
Accept → Confirmed, Pick another time → Requested, a declined booking, which needs decline). The same run covers:
- journey → Request sent → the real status page says Requested;
- the shop confirms through the API → after a reload the page says Confirmed, and Add to calendar's href = `ics_url`;
- two real 201s at Tue 10:00, then this customer's Send gets the real 409 with exactly three alternatives, and one of them reaches Request sent;
- the seeded offered request shows New time offered with the board's `offer.label` and the shop note;
- a dead link shows the Worker's not-found text.

Negative control for the real walk: `confirmed` label broken to "Requested" in `ui.js`, chromium only →
red (output under "Numbers" below), restored, green again.

### Differences found

| # | What | Exact request → response | Verdict |
|---|---|---|---|
| 1 | Service ids | `GET /api/shop` → services `oil`, `tire-swap`, `brakes`, `diagnostic`, `truck-rv` (120 min, `bays_needed: 2`). My mock had `tires` and no `truck-rv`. | **fixed in app** (mock now copies `0002_defaults.sql`) |
| 2 | Error wording differs from the mock | e.g. `POST /api/requests {…"phone":"12"}` → `400 {"error":"Please enter a phone number the shop can call, like 709-555-0142.","code":"bad_request","field":"phone"}`; year `"Year should be 4 digits, like 2016."`; model `"Please keep the model to 40 characters or fewer."`; `GET /api/slots?service=oil&date=2026-10-30` → `400 {"error":"That day is not open for booking online.",…,"field":"date"}`; `date=nope` → `"Please pick a day."`; `service=tires` → `"Please pick a service."` | **fixed in app** (mock uses the Worker's texts and its validation order: service, date, time, then customer fields). The page's own inline messages stay as they were; they only show before a request is sent, and anything the server refuses is shown in its own words. |
| 3 | Off-grid `time` is a 400 on `time`, not a 409 (clarification 3) | `POST /api/requests {"service":"oil","date":"2026-09-15","time":"10:10",…}` → `400 {"error":"That time is not open for booking. Please pick another.","code":"bad_request","field":"time"}`. The form has no `time` input, so the message had nowhere to go and no way back. | **fixed in app**: `service`/`date`/`time` 400s show the text with a "Pick another time / day / service" button. The mock returns the same 400. |
| 4 | Short or malformed status token reads wrong to a customer | `GET /api/r/nope` → `404 {"error":"Not found.","code":"not_found"}`. A well-formed unknown token gets `404 {"error":"We could not find that booking. Please check the link the shop sent you.","code":"not_found"}`. The difference is the router's `{16,128}` token pattern: a link cut short when pasted into a text gets the bare "Not found.". | **for bb1**: answer every `/api/r/*` miss with the booking text. The app shows it under "We could not open that booking", so it is readable today, just thin. The mock copies the real behaviour. |
| 5 | Mock demo tokens were shorter than 16 | the real router would 404 `demo-offered` as "Not found." | **fixed in app** (`demo-offered-sample` etc.) |
| 6 | An offered request's `offer` has no `bays` | seeded, `GET /api/shop/board?days=7` → the Thu Sep 17 item `{"kind":"request","request":{"status":"offered","date":"2026-09-16","time":"14:00","bays":[1],"offer":{"date":"2026-09-17","time":"09:00","end":"10:00","label":"Thu Sep 17, 9:00 AM"},…}}`. Clarification 5 puts the item at the offer time, but `bays` is the original ask's bays, and the bays the offer holds (`offer_bays`) are not in the view, so the Today board cannot tell which bay column to draw it in. | **for bb1 / lead**: add `bays` to `offer` (`{date,time,end,label,bays}`). Until then the app draws an offered item in `request.bays`, which can be the wrong column. |
| 7 | Message grammar with plural or odd service names | seeded board, requested brakes: `"Hi Jordan, it's SAMPLE Auto Service. We got your request for your brakes on Tue Sep 15 at 9:00 AM. …"`; confirmed text reads "Your brakes is booked…"; diagnostic: "take your diagnostic on …". | **for bb1** (bb1 already listed it): e.g. "your Brakes appointment" / "your booking (Brakes)". The app copies the text as is, apart from the link (clarification 4). |
| 8 | A grid time inside the lead time answers "just taken" | `POST /api/requests {…"date":"2026-09-14","time":"09:30"}` at 9:00 AM NDT → `409 {"error":"Sorry, that time was just taken.","code":"taken","next":[10:00, 10:30, 11:00 Mon]}` | **no change**: that is clarification 3. A customer only gets here from a page left open past the lead time, and the three next times are the right recovery. |
| 9 | Status view of an offered request | `date`/`time`/`label` = the original ask, `offer` = the new time | matches the app ("You asked for" + the offer box); no change |
| 10 | Static serving | `GET /` 200 html · `GET /r/?t=abc` 200 html · `GET /r` → 307 `/r/` · `GET /shop/` → `404 application/json` | `/shop/` is the M2 page I have not built yet; no change for bb1 |
| 11 | Routes bb1 M1 does not have yet | `POST /api/r/<t>/accept`, `GET /api/r/<t>/ics` → `404 {"error":"Not found.","code":"not_found"}` | expected (bb1 M2), reported as WAIT, not as a mismatch |

Checked and matching API.md: `/api/shop` keys and `today`/`now` from the test clock; `/api/days` 14 entries with `Closed Sundays` and
`Staff training (sample)` on Sep 21 (clarification 2); `/api/slots` closed day `open:false, slots:[]`; `201 {id, token, status, status_url}`;
every 400 carries `field` (name, phone, year, make, model, note, time, date, service, days); wrong PIN
`401 {"error":"That PIN is not right.","code":"unauthorized"}`; board without a token `401 "Please sign in again."`; confirm on an unknown id
`404 "That request is not on the board any more."`; `days=3` → `400 field days`; `pending` and `messages` shapes (requested lists
received/confirmed/declined, offered lists offered; text holds the bare `/r/?t=` path, which the app will replace per clarification 4).

### Numbers (this worktree, after the fixes)
- `node tests/shots-m1.mjs --real`: `178 passed, 0 failed, 5 waiting on bb1 M2`, exit 0.
- `node tests/shots-m1.mjs --no-shots` (mock): `186 passed, 0 failed`, exit 0.
- Negative control, real walk: `confirmed: { label: 'Requested' }` in `ui.js`, `--real --engine chromium` → exit 1,
  `FAIL journey: locator.waitFor: Timeout 6000ms exceeded.` (390 and 1280: the pill never says Confirmed after the shop confirms),
  `83 passed, 2 failed`. Restored; the full real run is green again (above).

## M2 — in progress
