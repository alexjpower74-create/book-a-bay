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

## M2 — not started (waiting for the lead's prompt, per PLAN)
