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

## Sticky Save bar on Settings is solid too — DONE

**Defect** (lead's demo shot, Settings at webkit-390): the sticky Save settings bar used the `.glass` background `rgba(17, 24, 42, 0.72)`, and the
Earliest booking label and its "1 hour from now" value read through it. This is the same class as the header (DECISIONS 26).

**Fix** (`shop.css`): `.savebar` has its own solid `background: #0d1425` (Cosmic `--bg-2`). `shop.css` loads after `theme.css`, so it wins over `.glass`.

**Other sticky or fixed bars in `app/public`:** none left over content.
- The search (`position: sticky|fixed` in CSS, JS and HTML) found only `.bar` (already solid) and `.savebar`.
- `.aurora` and `.dots` are fixed decorative backgrounds behind everything (z-index −2 and −1, `pointer-events: none`).
- `ui.js`'s `position:fixed` textarea is an invisible element used only during a copy fallback.

**Test** `header.spec.mjs` › "Settings: fields under the sticky Save bar do not show through it", all 4 projects:
- Sign in, open Settings, scroll 400 px (a real wheel on 1280, a direct scroll on touch projects).
- The Save bar must be on screen.
- `elementsFromPoint` at five points across the bar must find settings content (inside a section panel or the PIN form) underneath it.
- `elementFromPoint` at the bar's centre must be the bar or its button, and the bar's computed background alpha must be ≥ 0.99.
- A viewport screenshot goes to `app/tests/shots/<project>-header-settings-savebar.png`.

**Negative control:** the `.savebar` background removed (back to the 0.72 glass), then the Settings test run on all 4 projects → **red on 4 of 4**, including webkit-390:
```
Error: Save bar background rgba(17, 24, 42, 0.72) is solid
Expected: >= 0.99
Received:    0.72
```
Restored from the backup and checked with `cmp` (byte for byte). With the fix, `header.spec` was 16/16 green before the break.

**Numbers:** `npx playwright test`, real Worker on 7303, after the restore:

| Project | Passed | Failed | Skipped |
|---|---|---|---|
| chromium-390 | 25 | 0 | 0 |
| chromium-1280 | 25 | 0 | 0 |
| webkit-390 | 25 | 0 | 0 |
| webkit-1280 | 25 | 0 | 0 |
| **Total** | **100** | **0** | **0** (6.2 min) |

**Screenshots looked at** (Settings, scrolled, 390, webkit and chromium): the Save bar is a solid dark band with the button on it. Nothing from the
form reads through it: in the webkit shot the Opening hours rows stop at its top edge, and in the chromium shot Wednesday's row is cut off cleanly at it.
Below the bar there is a thin strip of form content from its `bottom: 12px` gap. That strip is outside the bar and is how the floating bar was designed.

## Sticky header no longer shows scrolled content through it — DONE

**Defect** (lead's demo shot, webkit-390): after Send request the page scrolls to Request sent, and the progress tiles' labels read
crisply through the sticky header. Cause: `.bar` took the `.glass` background `rgba(17, 24, 42, 0.72)`, and WebKit on the phone did not blur what was
behind it. The same `.bar` is on the status page and the shop side, and all three showed it.

**Fix** (`theme.css`): `.bar` has its own solid `background: #0d1425` (Cosmic `--bg-2`). It sits after `.glass`, so it wins.
- **My first fix was not enough:** `rgba(13, 20, 37, 0.94)` passed a 0.9 check, but the fresh webkit-390 shots still showed card text legibly through the header ("709-555-0128 · Bay 1", "Winter tires are in the trunk." on the shop board; faint step labels and "Requested" on the other two pages). chromium-390's shop board showed it faintly too.
- So the header is solid, and the check requires it.

**Test** `header.spec.mjs` on all 4 projects, for Request sent, the status page and the seeded shop board:
- Scroll as far as the page goes: a real wheel on 1280. Touch projects have no wheel in Playwright, so there the page is scrolled directly; that is staging only, because the checks read paint and stacking.
- The header's computed background alpha must be **≥ 0.99**, and `elementFromPoint` at the header's centre must be inside the header.
- Where the page is tall enough to put content under the header, it must have been scrolled past the header.
- A viewport screenshot of each scrolled page goes to `app/tests/shots/<project>-header-<page>.png`.
- The first run, on the unfixed CSS, was red on the real defect: webkit-390 on all three pages, `header background rgba(17, 24, 42, 0.72) … Received: 0.72`.
- It also exposed my own test mistake: I required a scroll past the header even on pages shorter than the screen (`Expected: > 47 · Received: 0`). The scroll is now required only where the page has room for it.

**Negative controls** (after the fix; `theme.css` restored from the backup and checked with `cmp` after each):
- **A. Old glass background** (the `.bar` background removed): `header.spec` **12 of 12 red**, 3 of 3 on every project including webkit-390:
  `Error: request-sent: header background rgba(17, 24, 42, 0.72) is solid · Expected: >= 0.99 · Received: 0.72`
- **B. The 0.94 tint** (my first attempt): **12 of 12 red**, including webkit-390:
  `Error: request-sent: header background rgba(13, 20, 37, 0.94) is solid · Expected: >= 0.99 · Received: 0.94`
- With the fix, `header.spec` was 12/12 green before the breaks.

**Numbers:** `npx playwright test`, real Worker on 7303, after the restore:

| Project | Passed | Failed | Skipped |
|---|---|---|---|
| chromium-390 | 24 | 0 | 0 |
| chromium-1280 | 24 | 0 | 0 |
| webkit-390 | 24 | 0 | 0 |
| webkit-1280 | 24 | 0 | 0 |
| **Total** | **96** | **0** | **0** (6.0 min) |

**Screenshots looked at** after the solid fix, scrolled, at 390:
- webkit: `header-request-sent`, `header-status`, `header-shop-board`;
- chromium: `header-shop-board`; its Request sent and status pages are too short to scroll under the header.

In each, the header is a solid dark band: the Book a Bay logo, and Board/Settings on the shop, sit on it cleanly, and nothing from the page reads through. The
tiles, status pill and card text stop at the header's bottom edge.

## Guard for the M1 sticky-header bug that tap() could hide — DONE

`tap()` scrolls a target out from under the sticky header before hit-testing (accepted in M2b). That means a test that taps the name field
could no longer see the M1 WebKit bug, where the app parked the first invalid field under the header after an empty Send. A dedicated check now
guards it, with no test scrolling after Send.

**Test** `days.spec.mjs` › "after an empty Send, the name field is in view below the header (no test scrolling)", all 4 projects:
- Real taps to the details step, then a tap on Send request with the form empty. That tap's own scroll only ever moves the Send button, before the app moves focus.
- Checks: "Please enter your name." shows and `#f-name` is focused.
- Then, only reading the page (polled up to 3 s, nothing scrolled by the test):
  - `document.elementFromPoint` at the field's centre is the field itself;
  - that centre is below the `.bar` header's bottom edge;
  - and it is above the bottom of the screen.

**Negative control:** `focusField` in `book.js` changed to a plain `el.focus()` (the `preventScroll` + `scrollIntoView({ block: 'center' })` removed), then the check run on all 4 projects:
- **webkit-390: red**, as in M1:
  ```
  Error: the first invalid field is where a person can see and tap it
  -   "at": "ok",
  -   "belowHeader": true,
  -   "hitsItself": true,
  +   "at": "centre y 10, header bottom 47, screen 664",
  +   "belowHeader": false,
  +   "hitsItself": false,
  ```
- chromium-390, chromium-1280 and webkit-1280 stay green under the break: their plain `focus()` does not park the field under the header. The guard is therefore WebKit-phone specific, which is where the bug was.
- Restored from the backup and checked with `cmp` (byte for byte). Before the break, the check passed on all 4 projects.

**Numbers:** `npx playwright test`, real Worker on 7303, after the restore:

| Project | Passed | Failed | Skipped |
|---|---|---|---|
| chromium-390 | 21 | 0 | 0 |
| chromium-1280 | 21 | 0 | 0 |
| webkit-390 | 21 | 0 | 0 |
| webkit-1280 | 21 | 0 | 0 |
| **Total** | **84** | **0** | **0** (5.9 min) |

## M4 follow-up — API.md clarifications 19–22 in the app — DONE

Rebased on main (bb1 M4 merged: `/api/r/:token/days`, `/api/r/:token/slots`, `/api/shop/days`, `field: current` on the PIN 401).

### Numbers: `npx playwright test`, real Worker on 7303, final run after the control was restored

| Project | Passed | Failed | Skipped |
|---|---|---|---|
| chromium-390 | 20 | 0 | 0 |
| chromium-1280 | 20 | 0 | 0 |
| webkit-390 | 20 | 0 | 0 |
| webkit-1280 | 20 | 0 | 0 |
| **Total** | **80** | **0** | **0** (6.0 min) |

The 3 new tests per project: `move` (clarification 19), and `session` × 2 (clarifications 21 and 22). `move` was also run with
`--repeat-each 3`: 12/12 passed.

### What changed
1. **Clarification 19.** The customer "Pick another time" picker (`status.js`) now uses `GET /api/r/:token/days` and
   `GET /api/r/:token/slots?date=`. The shop "Offer another time" day list (`shop.js`) uses `GET /api/shop/days?exclude=<id>`, and its times already came from
   `/api/shop/slots?exclude=`. `api.mock.js` has the same token routes, plus clarification 18's single booking 404.
   - **Test** `move.spec`: a 1-bay shop with 1 booking per start, and an oil change at Tue 10:00. So a time held by the request is blocked for everyone else.
     - The shop's picker shows the request's own 10:00. The shop offers Wed 2:00 PM, and the customer's picker shows that 2:00 PM (held only by the offer).
     - The shop then unticks "Bookable online" for Oil change in Settings and saves. The customer page no longer lists Oil change.
     - The shop offers a different time (Thu 9:00 AM) from the board, and the customer picks another time (Fri 8:00 AM) and is Requested at it.
   - **Negative control:** `status.js` pointed back at `api.slots(v.req.service.id, p.date)` → **red** (chromium-390, webkit-1280):
     `Error: the time held only by this booking is offered to it · Locator: locator('.picker button.time[data-time="14:00"]') · Expected: visible · Error: element(s) not found`
     (`move.spec.mjs:46`, the own-hold step, before Oil change goes offline). Restored (`cmp`), full suite green.
   - **Found while building the test:** on chromium the first version tapped a day chip while the picker was drawing its days, and the chip was detached ("Element is not attached").
     The test now waits for all 14 chips and for the chosen day before going on. That is a test timing fix; nothing changed in the app.
2. **Clarification 20.** The block-out label input is `maxlength="40"`. It already was on this base (fixed in M2b, `shop.js:389`).
3. **Clarification 21.** `api.js` signs out on every shop 401 except `PUT /api/shop/pin` answering `field: "current"`.
   - **Test** `session.spec`: sign in, open Settings, end that session through the API (`POST /api/shop/signout` with the page's token), then submit Change PIN
     with the right current PIN. The response is 401 with no `field`, the page is back on sign-in showing the API's text, and the token is gone.
     The wrong-current-PIN case (the page stays on the form, "That PIN is not right.") is still covered by `shop.spec`.
4. **Clarification 22.** A confirmed item with `pushed_at` shows "Sent to Shop Board Mon Sep 14, 9:12 AM" in its card. `ui.js instantLabel()`
   formats the given instant in America/St_Johns with `Intl` and never reads the browser clock (`guard-clock` passes).
   - **Test** `session.spec`: the e2e Worker has no Shop Board to push to (its 501 is tested in `shop.spec`), so this one test adds
     `pushed_at: 2026-09-14T11:42:00Z` to the real board response with `page.route`. Everything else on the page is the Worker's answer. The item
     menu then reads "Sent to Shop Board Mon Sep 14, 9:12 AM". A real push round trip would need a fake Shop Board on a port outside this slice's three; the lead's QA did that at 7306.
5. **(Optional) Services refusal:** a `field: services` refusal already lands in the Services section, and the page scrolls it to the centre
   (`shop-settings.js`, the scroll to `[data-error]` after save). No extra code was needed, and there is no separate test.

### For bb1
Nothing failing: all new routes and the PIN 401 behaved as clarifications 19–22 say.

## M2b — every shop screen on the real M2 Worker, 0 skipped — DONE

Rebased on main (bb1 M2 + M3 merged; API.md clarifications 8–18). `needsRoute` and every call to it are deleted (DECISIONS 19);
`grep -rn "needsRoute\|test.skip\|test.fixme" app/tests` finds nothing.

### Numbers: `npx playwright test`, real Worker on 7303 (fresh state, TEST_MODE), final run after all controls were restored

| Project | Passed | Failed | Skipped |
|---|---|---|---|
| chromium-390 | 17 | 0 | 0 |
| chromium-1280 | 17 | 0 | 0 |
| webkit-390 | 17 | 0 | 0 |
| webkit-1280 | 17 | 0 | 0 |
| **Total** | **68** | **0** | **0** (4.8 min) |

17 tests per project:
- **board:** poll does not redraw an open Offer picker; JSON + CSV download; Today board within two screens, header one row, time labels one line.
- **days:** closed Sunday, SAMPLE on 3 screens, primary buttons.
- **journey:** the full flow; ics is `text/calendar`.
- **offer:** offer → accept → Confirmed.
- **pin:** wrong PIN 401; sign in and out.
- **shop:**
  - pending / Today / Week / item;
  - Send to Shop Board shows the 501 text;
  - decline with a note, which the customer sees;
  - cancel a confirmed booking;
  - block create + remove;
  - Settings refusal inline then save (Saturday closed for customers);
  - Change PIN (wrong current refused, old PIN refused, new PIN signs in).
- **taken:** two customers, one slot, three alternatives.

### What changed in the app
- **The shop screens now run against the real M2 routes.**
  - Offer picker: day chips, then `/api/shop/slots?exclude=`, an optional note, "Offer <time>".
  - Decline and shop cancel with notes; Send to Shop Board shows the 501 text as is.
  - Block create (label limit 40, the Worker's) and remove; the export fetch with the Bearer token, saved as a file.
  - Settings refusal inline (`bays_in_use` under Booking rules) and save; Change PIN.
- **Phone:**
  - (a) Each card folds its texts behind one "Texts to send (N)" button, at least 44 px, in the phone/bay row, so it adds no row. It is open by default only on a Just done card.
  - Compact cards on phones: the three actions on one row, the note and the shop's own note clamped to one line.
  - A one-row board toolbar ("Download (JSON)" on screen; the full "Download for Shop Board (JSON)" stays in the accessible name), and a smaller shop heading.
  - (b) The header is one row at 390: Sign out moves to a "This phone" panel at the bottom of Settings (the header button stays at ≥ 720 px).
  - (c) Time labels on the Today grid keep to one line (`white-space: nowrap`).
- **1280:** a card with an open Offer or Decline panel spans the whole card row, and its buttons may wrap. Before, "Offer Wed Sep 16, 2:00 PM" was clipped in a one-third-width card (seen in `chromium-1280-shop-offer.png`).
- Offered items are drawn in `offer.bays` (clarification 17), with `request.bays` as the fallback.

### What changed in the tests
- The copy-text step in `journey` opens "Texts to send (3)" first. The texts are checked by the full link (`Details: http://…/r/?t=…`), not by wording, so clarification 15's new wording needed no spec change.
- `taken`: a one-bay shop cannot keep the two-bay truck service (`400 "Truck or RV service needs 1 to 1 bays."`), so that test sets every service to 1 bay. The Worker was right; my test data was wrong.
- `tap()`: if the target's centre is under the sticky header, it scrolls the target to the middle first. A person would scroll too. Anything else on top still fails the hit-test (control (b) below still goes red).
- Screenshots on touch projects scroll to the top directly before the picture (Playwright has no wheel on mobile), so the sticky header is not painted mid-page. This happens after every check in the test.
- **Exception to "real input only":** native `<select>` values (block-out times, bay count) are picked with `selectOption`, because a native list has no drawn options to tap.

### New checks and their negative controls (each broken, run, red, restored with `cmp`, then the full suite green)
- **(4a) The poll does not redraw an open Offer picker.** `page.clock.install()`; open the picker; pick Wed Sep 16 and wait for its times.
  - Setup: hold the picker element; another customer books through the API; `clock.runFor(16 000)`; wait for the `/api/shop/board` poll response.
  - Checks: the same element is still connected, Sep 16 is still chosen, and the new customer is not drawn yet. Then close the picker, run the clock again, and the new customer appears, so the poll really ran with new data.
  - Control: `if (quiet && (b.menu || b.open || b.busy)) return` replaced by `if (false) return` → **red on all 4 projects**:
    `Error: the open picker is the same element after the poll · Expected: true · Received: false`.
- **(4b) The export downloads.** Week view Mon Sep 14 to Sun Sep 20.
  - JSON: `waitForEvent('download')` gives `shop-board-2026-09-14-to-2026-09-20.json`, with `format: "shop-board-patches/v1"`, items > 0 and every id `bab-…`.
  - CSV: the file's first line is `id,date,slot,bay,name,phone,year,make,model,issue,estTime`, with one row per JSON item.
  - Control: the export sent without the Bearer header (`!path.includes('/export/')` added to the header rule) → **red** on chromium-390 and webkit-1280:
    `Error: page.waitForEvent: Test timeout of 20000ms exceeded. · waiting for event "download"`.
  - My first run of this control and of the next one was **void, not red**: both `--project` flags went in as one quoted argument, so Playwright exited on its arguments before running a test. I caught it because no ✘ lines were printed, and re-ran both with separate arguments. The red output here is from the re-run.
- **(5) Seeded week, 4 pending cards.** At 390 the first bay column starts within two phone screens; each Texts to send button is ≥ 44 px; the header is one row (brand and Board/Settings centred within 12 px, header < 80 px); every time label is on one line (one line box).
  - First real run: `first bay column starts at 2095 px; two screens are 1688 px` (chromium-390) and `2094 px; 1328 px` (webkit-390, where the iPhone 14 viewport is 664 px). After the compaction: 1398 px on webkit-390, still red. After moving the toggle into the phone row: green on all 4.
  - Control: every text group open by default (`: true` instead of `: ctx === 'recent'`) → **red** on chromium-390 and webkit-390:
    `Error: first bay column starts at 1985 px; two screens are 1688 px`.
- The M2 controls (status label → journey, overlay over Send → hit-test, old gradient → contrast, bare link → journey) still stand (red outputs in the M2 section below). The suite they guard is the same, now with 0 skips.

### Screenshots looked at after the changes
- **shop-pending:** webkit-390 has four compact cards with folded texts; chromium-1280 has the 3-column cards.
- **shop-today:** webkit-390 shows the bay switcher, the walk-in and the truck job in Bay 2; 1280 shows the bay columns.
- **shop-offer:** webkit-390 has the picker in the card; chromium-1280 has the card spanning the row, and the Offer button now fits.
- **shop-settings:** webkit-390 and chromium-1280. The sticky Save bar shows part-way down a full-page picture, where the viewport bottom was. That is how a sticky bar looks in a full-page shot, not a layout bug.

### For bb1
Nothing failing. Every route behaved as API.md and clarifications 8–18 say, in 68 of 68 tests. Clarifications 17 (`offer.bays`) and 18 (one readable 404) were being built at the time; the app handles both the old and new shapes.

## M2 — shop side and the Playwright suite — DONE (six tests waiting on bb1 M2 routes; superseded by M2b above)

### What I built
- **Lead's changes.**
  - (a) `band()` follows Shop Board's `bandOf`: ≤ 60 min short, ≤ 180 mid, longer long.
  - (b) Send request was never disabled. `days.spec` now asserts it is enabled, has opacity 1, and measures the contrast of every gradient stop.
    Shop Board's `#6366f1 → #8b5cf6` measured 4.47 : 1 and 4.2 : 1 against white, so the primary gradient is now `#4f46e5 → #7c3aed`
    (6.3 and 5.7 : 1), and the selected day and time chips got the same darker treatment.
  - (c) `git rm -r --cached app/tests/shots` is in this commit; the files stay on disk.
  - (d) Every message `text` is shown and copied with `location.origin + status_url` (`fullLink` in `ui.js`).
- **`api.js`:** every shop route in API.md.
  - Bearer token from `localStorage` `book-a-bay:shop-token`.
  - A 401 on any shop route except `PUT /api/shop/pin` clears the token and returns to sign-in with the API's text.
  - The export fetches with the token and saves the file.
- **`shop/index.html` + `shop.js` + `shop.css`:**
  - PIN sign-in and Sign out; the header has Board / Settings; shop name and SAMPLE badge.
  - **Waiting for you** on top: a card per pending request (customer, phone, vehicle, service + duration, time, bay, offered time, note).
    - Requested: Confirm / Offer another time / Decline. Offered: Offer a different time / Decline.
    - Decline takes an optional note. Offer opens an inline day picker, with times from `/api/shop/slots?exclude=<id>`, and an optional note.
    - A "Copy text" button for each `messages` entry says "Copied".
    - After an action the request moves to **Just done** with its new texts, so the shop can copy the text it is about to send.
  - **Today / Week** board with day/week navigation from the API's `from`/`today`.
    - Today: one column per bay on the 30-minute grid; items are blocks spanning their time in their status colour, and blocks are hatched.
      At < 720 px the bays become a Shop Board-style segmented control with counts.
    - Week: 7 day columns (one list on narrow screens), and tapping a day header opens that day.
    - Tapping an item opens its details under the board: the same card; confirmed jobs get "Send to Shop Board" (the API's 501/502 text shown
      as is) and "Cancel booking"; blocks get "Remove this block".
  - **Block out time** form: day, from/to on 15-minute marks, label (default Walk-in), All bays or chosen bays. A `busy` 409 lists its conflicts.
  - **Download for Shop Board** JSON / CSV for the range on screen.
  - Polls every 15 s and on `visibilitychange`, but skips the redraw while a picker, note, item menu or the block form is open, or an action is in flight.
- **`shop-settings.js`:**
  - Booking rules: shop name, bays, start step, lead time, bookings per start, window.
  - Hours per weekday with Closed toggles.
  - Closed days: add / remove.
  - Services: add, rename, length, bays needed, "Bookable online" toggle. New ids come from the name; saved ids never change.
  - Save sends the whole object with PUT. The API's refusal is shown in the section its `field` names (`bays_in_use` goes under Booking rules).
  - Change PIN.
- **Playwright** (`playwright.config.mjs`):
  - Projects chromium-390 (390×844, touch, mobile), chromium-1280, webkit-390 (iPhone 14), webkit-1280; `workers: 1`.
  - `webServer` = `tests/start-worker.mjs`: it wipes `app/tests/.state-7303`, migrates `--local --persist-to` it, and runs `wrangler dev` on 7303
    (inspector 7313) with `--var TEST_MODE:1`. `baseURL` is that Worker.
  - `tests/helpers.mjs`:
    - `fresh()`: `POST /api/test/reset` plus the `X-Test-Now: 2026-09-14T11:30:00Z` headers.
    - `tap()`: `elementFromPoint` hit-test at the centre, then a real touch on coarse pointers or a real click.
    - `type()`: real `page.keyboard`.
    - `needsRoute()`: skips a test with "waiting on bb1 M2: …" only while that route answers the router's bare `404 "Not found."`.
- **Specs:**
  - `journey`: book with real input → Request sent → status Requested. A second context signs in with the PIN; the card is pending with the
    full link inside its text; Copy text says Copied (and the chromium clipboard holds the link); Confirm. The customer's page, **without a
    reload**, turns Confirmed by its poll, and Add to calendar's href = `ics_url`. A second test checks that URL returns `text/calendar`.
  - `pin`: wrong PIN shows "That PIN is not right." and `waitForResponse` sees 401 with no token stored. The right PIN signs in, survives a
    reload, and Sign out clears the token.
  - `taken`: settings leave one oil slot on Tue Sep 15 (1 bay, 1 per start, Tuesday 8:00–8:30). Two contexts pick it; the second sees
    "just taken" and exactly three alternatives; one tap on one reaches Request sent.
  - `offer`: shop offers Wed 2:00 PM with a note → customer sees New time offered → Accept → Confirmed at the new time.
  - `days`: Sunday disabled with "Closed", the Sep 21 closure, 14 chips, and the SAMPLE badge and name on the customer, status and shop
    screens (before and after sign-in). Send request (before and after errors), Sign in and Confirm are ≥ 44 px at 390, enabled, opacity 1,
    hit-test to themselves, and have ≥ 4.5 : 1 contrast.
  - `shop`: on the seeded week, pending count and cards, an offered card showing its offer, Today by bay (at 390 the truck job appears only
    after tapping Bay 2; at 1280 it shows in both its bays), the walk-in block, the item menu with Send to Shop Board, and the Week item
    count matching the API. Push, Block out and Settings (a `bays_in_use` refusal shown inline, then a save that closes Saturdays for customers)
    wait on bb1 M2.
- Screenshots per project in `app/tests/shots/` (not tracked): book-1-service, book-2-day, book-3-time, book-4-details-errors, book-5-sent,
  status-requested, status-confirmed, shop-signin, shop-signin-wrong, shop-pending, shop-today, shop-item, shop-week, shop-block-form; when bb1
  M2 lands, also book-taken, shop-offer, status-offered, shop-settings. I looked at shop-today (390 and 1280), shop-week-1280 and
  book-4-details-errors-390: the bay control, bay columns, hatched walk-in, week columns and a solid Send request all read right.

### Numbers (this worktree, real Worker on 7303)
`npx playwright test`: **20 passed, 0 failed, 24 skipped** (2.7 min), exit 0, run twice (before and after the negative controls).
The 24 skips are 6 tests × 4 projects, each "waiting on bb1 M2", **not failures**:

| Test | Waiting on |
|---|---|
| journey › the Add to calendar link returns text/calendar | `GET /api/r/:token/ics` |
| offer › shop offers another time → customer accepts → Confirmed | `POST /api/r/:token/accept`, `POST /api/shop/requests/:id/offer`, `GET /api/shop/slots` |
| taken › the second customer to send sees "just taken" and three alternatives | `GET/PUT /api/shop/settings` (to leave one slot) |
| shop › Send to Shop Board says plainly when it is not set up | `POST /api/shop/requests/:id/push` |
| shop › Block out time adds a walk-in block to the board | `POST /api/shop/blocks` (the form itself renders and is screenshotted first) |
| shop › Settings load, save, and show the API refusal inline | `GET/PUT /api/shop/settings` |

Passing on all 4 projects: journey (full flow), both pin tests, days, and shop › pending/Today/Week/item details.

### Negative controls (each broken, run on chromium-390, red, restored byte for byte with `cmp`, full suite green again)
- **(a) status label mapping** (`confirmed: { label: 'Requested' }` in `ui.js`) → `journey` red:
  `Error: expect(locator).toHaveText(expected) failed · Expected: "Confirmed" · Received: "Requested"` (1 failed).
- **(b) transparent overlay over Send request** (`#details::after`, 60 px, z-index 5) → `journey` red:
  `Error: tap(Send request) hit-test at 195,733: something else is on top · Expected: ""` (1 failed).
- **(c) old primary gradient** (`#6366f1 → #8b5cf6`) → `days` red: `Error: Send request text contrast (worst gradient stop)` (1 failed).
- **(d) message link left bare** (`fullLink` returns the text unchanged) → `journey` red:
  `Expected substring: "Details: http://127.0.0.1:7303/r/?t=sfPx…" · Received string: "Hi Pat, it's SAMPLE Auto Service. Your oil change is booked for Tue Sep 15 at 10:00 AM. Details: /r/?t=sfPx…"`.
- Still standing from M1: the clock guard (self-test + known-bad copy), and the real-Worker smoke control.

### Honest gaps
- **Written against the contract, not yet run:** offer/decline pickers, shop cancel, Send to Shop Board, block create/remove, export
  download, Settings and PIN change. Their specs exist and switch on by themselves when the routes stop answering the bare 404. Until bb1 M2
  is on main, those screens have only been checked by reading the code. The Settings refusal mapping assumes `field` starts with the part it
  names (`services…`, `hours…`, `closures…`, a rule key).
- `api.mock.js` covers the customer routes only (matched to the real Worker). I did not add mock shop routes: the shop screens ran against the
  real Worker instead.
- An offered item is drawn in `offer.bays` when present, else `request.bays` (cross-review #6 for bb1).
- Not tested: that the board poll skips while a picker is open (there is code for it, but no spec), and that the export file downloads.
- `shots-m1.mjs` (the M1 mock/real smoke) still runs: `--real` 178/0, mock 186/0 before the M2 changes. It is a dev tool now; the suite is the record.
