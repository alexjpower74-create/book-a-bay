# Book a Bay: API contract (v1)

The contract between the Worker slice (bb1) and the app slice (bb2). If the code and this file disagree, this file wins
until the lead changes it. Written by the lead 2026-09-14.

One Worker `book-a-bay` serves the API under `/api/*` and the static app from `app/public/` (same origin, no CORS
needed). Local only tonight: `wrangler dev --local`. One deployment = one shop (Shop Board is single-shop too).

JSON in, JSON out. Errors are always `{ "error": "<plain English for a Newfoundland shop or customer>", "code": "<machine code>", "field"?: "<input name>" }`.

| code | HTTP | when |
|---|---|---|
| `bad_request` | 400 | validation; `field` names the input |
| `unauthorized` | 401 | missing/expired shop token, or wrong PIN |
| `not_found` | 404 | unknown token, request, block, service |
| `taken` | 409 | the slot went while the customer was choosing; body has `next` |
| `busy` | 409 | a shop action collides with held bay time; body has `conflicts` |
| `bad_state` | 409 | a status change that is not allowed from the current status |
| `bays_in_use` | 409 | lowering the bay count while future bookings sit on the removed bays |
| `rate_limited` | 429 | too many requests / PIN tries |
| `not_configured` | 501 | Shop Board push with no `SHOP_BOARD_URL` |
| `shop_board_error` | 502 | Shop Board answered with an error; body has `shop_board: { status, body }` |

## Time

- The shop's zone is `America/St_Johns` (setting `timezone`). Every date and time in this API is **shop local**:
  `date` is `YYYY-MM-DD`, `time` is 24 h `HH:MM`, `label` is for people (`"Tue Sep 15, 9:30 AM"`).
- **The app never uses the browser's clock for shop dates.** It takes `today` and `now` from `GET /api/shop`.
- Test clock: only when the Worker has var `TEST_MODE=1` (never in production), request header `X-Test-Now: <ISO instant>`
  replaces "now" and `X-Test-IP: <string>` replaces the client IP for rate limits. Without `TEST_MODE=1` both headers are ignored.

## Slot rules (the maths; bb1 implements them once in `worker/src/slots.js`, pure)

Bay time is a grid of 15-minute **cells** per bay per date. Service durations are multiples of 15.

1. A date is **closed** when `hours[weekday]` is `null` (reason `"Closed Sundays"` style: `"Closed <Weekday>s"`) or the date is
   in `closures` (reason = the closure's reason). Closed dates have no slots.
2. Candidate starts run from `open` in steps of `slot_step_min` while `start + service.minutes <= close`.
3. A start is dropped if its instant is earlier than `now + lead_time_min` (so no same-hour bookings), or the date is before
   today or at/after today + `window_days`.
4. A start is dropped if `max_per_slot` holding requests already start at that date and time (shop-wide).
5. A start is available only if some set of `service.bays_needed` bays among bays `1..bays` has every cell in
   `[start, start + minutes)` free. The server always picks the lowest-numbered free bays.
6. **Holding** = a request in status `requested`, `offered` (holds the offered time, not the original) or `confirmed`, and every
   block-out. `declined` and `cancelled` hold nothing.
7. Slots are always computed from settings and holds. There is no stored list of times anywhere.

**The race.** Creating or moving a hold writes the request row, one `cells(date, bay, cell)` row per occupied cell and one
`starts(date, start_min, n)` row in a single `DB.batch()` (D1 runs a batch as one transaction). Both tables have UNIQUE indexes,
so of two requests racing for the last slot exactly one batch commits; the other rolls back completely. The loser re-reads and, if
another bay set is still free, retries (max 3); otherwise it answers `409 taken` with `next`.

`next` = up to 3 available slots for the same service, chronologically after the requested start: the rest of that day first,
then the following days in the window. Each entry `{ date, time, label }`.

## Customer routes (no sign-in)

`GET /api/shop`
```json
{ "name": "SAMPLE Auto Service — Grand Falls-Windsor (demo)", "sample": true, "timezone": "America/St_Johns",
  "today": "2026-09-14", "now": "2026-09-14T11:00:00.000Z", "window_days": 14, "bays": 3,
  "services": [ { "id": "oil", "name": "Oil change", "minutes": 30, "bays_needed": 1 } ] }
```
Only `active` services are listed.

`GET /api/days?service=<id>` → the `window_days` dates starting today:
```json
{ "service": "oil", "days": [ { "date": "2026-09-14", "label": "Mon Sep 14", "open": true, "reason": null, "available": 6 },
                              { "date": "2026-09-20", "label": "Sun Sep 20", "open": false, "reason": "Closed Sundays", "available": 0 } ] }
```
An open day with `available: 0` is shown as "Full".

`GET /api/slots?service=<id>&date=YYYY-MM-DD`
```json
{ "service": "oil", "date": "2026-09-15", "open": true, "reason": null,
  "slots": [ { "time": "08:00", "label": "8:00 AM" }, { "time": "08:30", "label": "8:30 AM" } ] }
```
400 `bad_request` for an unknown service, a malformed date, or a date outside the window.

`POST /api/requests`
```json
{ "service": "oil", "date": "2026-09-15", "time": "09:30",
  "name": "Pat Sample", "phone": "709-555-0142", "year": "2016", "make": "Toyota", "model": "Corolla", "note": "" }
```
Validation: `name` 1–80, `phone` 7–32 characters of digits, spaces, `+ - ( ) .` with at least 7 digits, `make` 1–32,
`year` empty or 4 digits, `model` 0–40, `note` 0–280. Rate guard 12 per hour per IP.
→ `201 { "id": "r_…", "token": "<32+ url-safe chars>", "status": "requested", "status_url": "/r/?t=<token>" }`
→ `409 { "error": "Sorry, that time was just taken.", "code": "taken", "next": [ {date,time,label} ×≤3 ] }`

`GET /api/r/:token` → the customer's view of their request
```json
{ "id": "r_…", "status": "requested|confirmed|declined|offered|cancelled",
  "service": { "id": "oil", "name": "Oil change", "minutes": 30 },
  "date": "2026-09-15", "time": "09:30", "end": "10:00", "label": "Tue Sep 15, 9:30 AM",
  "offer": null, "shop_note": "", "customer": { "name": "…", "phone": "…", "year": "…", "make": "…", "model": "…", "note": "…" },
  "shop": { "name": "SAMPLE Auto Service — Grand Falls-Windsor (demo)", "sample": true },
  "ics_url": null, "updated_at": "ISO" }
```
`offer` is `{ date, time, end, label }` while status is `offered`. `ics_url` is `"/api/r/<token>/ics"` only when `confirmed`.

`POST /api/r/:token/accept` → offered → confirmed (the request's date/time become the offer). Returns the view above.
`POST /api/r/:token/repick { date, time }` → requested or offered → requested at the new time (hold moves in one batch). 409 `taken` + `next`.
`POST /api/r/:token/cancel` → requested/offered/confirmed → cancelled, hold released.
`GET  /api/r/:token/ics` → `200 text/calendar; charset=utf-8` (CRLF lines, `DTSTART`/`DTEND` in UTC `Z`, `UID:<id>@book-a-bay`,
`SUMMARY:<service> at <shop name>`), attachment `booking.ics`. 409 `bad_state` unless confirmed.

## Shop routes (`Authorization: Bearer <token>`)

`POST /api/shop/signin { "pin": "2468" }` → `200 { "token": "…", "expires_at": "ISO (14 days)" }` · wrong PIN `401 unauthorized`
(`"That PIN is not right."`) · 5 wrong tries in 15 minutes from one IP → `429`. PIN is 4–8 digits, stored as PBKDF2-SHA256 with a
random salt; session tokens stored hashed. The SAMPLE shop's PIN is `2468` (README says change it).
`POST /api/shop/signout` → `{ "ok": true }`. Any shop route without a valid token → `401`.

**Request (shop view)**, used by every shop route below:
```json
{ "id": "r_…", "status": "requested", "service": { "id": "oil", "name": "Oil change", "minutes": 30, "bays_needed": 1 },
  "date": "2026-09-15", "time": "09:30", "end": "10:00", "label": "Tue Sep 15, 9:30 AM", "bays": [1],
  "offer": null, "customer": { "name": "…", "phone": "…", "year": "…", "make": "…", "model": "…", "note": "…" },
  "shop_note": "", "status_url": "/r/?t=<token>", "created_at": "ISO", "updated_at": "ISO", "pushed_at": null,
  "messages": [ { "key": "confirmed", "label": "Text to confirm", "text": "Hi Pat, it's SAMPLE Auto Service. Your oil change is booked for Tue Sep 15 at 9:30 AM. Details: <status link>" } ] }
```
`messages` are ready-made texts for the shop to copy into its own phone. **Nothing is ever sent by the system.** The link inside a
message is the path `status_url`; the app prefixes `location.origin`. Keys: `received` (while requested), `confirmed`, `declined`,
`offered` (each offered while it applies).

`GET /api/shop/board?date=YYYY-MM-DD&days=1|7`
```json
{ "from": "2026-09-15", "to": "2026-09-15", "bays": 3, "today": "2026-09-14",
  "pending": [ request… ],
  "days": [ { "date": "2026-09-15", "label": "Tue Sep 15", "open": true, "reason": null, "hours": { "open": "08:00", "close": "17:00" },
              "items": [ { "kind": "request", "request": request… },
                         { "kind": "block", "block": { "id": "b_…", "date": "…", "time": "12:00", "end": "13:00", "bays": [1,2,3], "label": "Walk-in" } } ] } ] }
```
`pending` = every `requested` and `offered` request from today on, oldest first, whatever `date` is. `items` = holding requests and
blocks of that day (confirmed, requested, offered), sorted by time then bay.

`POST /api/shop/requests/:id/confirm` → requested → confirmed.
`POST /api/shop/requests/:id/decline { "note"?: "…" }` → requested/offered → declined, hold released.
`POST /api/shop/requests/:id/offer { "date", "time", "note"? }` → requested/offered → offered; the hold moves to the offered time in one
batch (409 `busy` or `taken` if it cannot). `GET /api/shop/slots?service=&date=&exclude=<request id>` lists times the shop can offer,
treating that request's own hold as free.
`POST /api/shop/requests/:id/cancel { "note"?: "…" }` → confirmed → cancelled, hold released.
Each returns the request (shop view). Wrong status → 409 `bad_state`.

`POST /api/shop/blocks { "date", "time", "end", "bays": [1] | "all", "label": "Walk-in" }` → `201 { block }`; collides with held time →
`409 { code: "busy", conflicts: [ { "id": "r_…", "name": "…", "label": "…", "bays": [1] } ] }`.
`DELETE /api/shop/blocks/:id` → `{ "ok": true }`.

`GET /api/shop/settings` →
```json
{ "shop_name": "SAMPLE Auto Service — Grand Falls-Windsor (demo)", "timezone": "America/St_Johns", "bays": 3,
  "slot_step_min": 30, "lead_time_min": 60, "max_per_slot": 2, "window_days": 14,
  "hours": { "0": null, "1": { "open": "08:00", "close": "17:00" }, "2": {…}, "3": {…}, "4": {…}, "5": {…}, "6": { "open": "09:00", "close": "13:00" } },
  "closures": [ { "date": "2026-09-21", "reason": "Staff training (sample)" } ],
  "services": [ { "id": "oil", "name": "Oil change", "minutes": 30, "bays_needed": 1, "active": true } ] }
```
`PUT /api/shop/settings` (the whole object) → the saved object. Validation: `shop_name` 1–80 · `bays` 1–10 · `slot_step_min` 15|30|60 ·
`lead_time_min` 0–2880 · `max_per_slot` 1–10 · `window_days` 1–60 · `hours` keys "0"–"6", `null` or `{open, close}` on 15-minute marks,
open < close · `closures` ≤ 100, date + reason 1–60 · `services` 1–30, `id` `[a-z0-9-]{1,32}` unique, `name` 1–40, `minutes` 15–480 in
15s, `bays_needed` 1..`bays`, `active` boolean · `timezone` stays `America/St_Johns` in v1.
Lowering `bays` while a holding request or block from today on uses a bay above the new count → `409 bays_in_use`
(`"Bay 3 has 2 bookings from Tue Sep 15. Move or decline them first."`). Requests keep a snapshot of their service, so editing or
deactivating a service never changes an existing request.
`PUT /api/shop/pin { "current", "next" }` → `{ "ok": true }`; wrong current → 401.

## Shop Board adapter

Shop Board (`~/Projects/Shop Board`, read-only reference) takes `PUT /api/bookings/:id` with a patch
`{ fields: { date, slot, bay, name, phone, year, make, model, issue, estTime }, at, by }`, no sign-in, and answers `409` when the bay
row is taken or busy. Its rows are fixed: `8:00 9:00 10:00 11:00 12:00 PM 12:30 PM 1:00 2:00 3:00 4:00 5:00`; its est. times are
`30m 1h 2h 3h 4h Day`; ids match `^[A-Za-z0-9_-]{6,64}$`. Mapping (bb1, `worker/src/shopboard.js`, pure):

- id `bab-<request id without the r_ prefix>` · `date` as is · `bay` = first assigned bay as a string
- `slot` = the latest Shop Board row at or before the start (9:30 → `9:00`, 12:15 → `12:00 PM`, 12:45 → `12:30 PM`, 13:30 → `1:00`);
  before 8:00 → `8:00`, after 5:00 PM → `5:00`
- `estTime` from minutes: ≤30 `30m`, ≤60 `1h`, ≤120 `2h`, ≤180 `3h`, ≤240 `4h`, else `Day`
- `issue` = `"<service> (booked online for 9:30 AM)"` + `" — <note>"` when there is one, cut to 280
- `name` ≤80, `phone` ≤32, `year` ≤8, `make` ≤32, `model` ≤40 · `at` = now ISO · `by` = `"Book a Bay"`

`GET /api/shop/export/shop-board?from=&to=&format=json|csv` → confirmed requests in range. JSON:
`{ "format": "shop-board-patches/v1", "target": "PUT /api/bookings/:id", "items": [ { "id": "bab-…", "patch": { fields, at, by } } ] }`.
CSV columns: `id,date,slot,bay,name,phone,year,make,model,issue,estTime`.
`POST /api/shop/requests/:id/push` → confirmed only. With var `SHOP_BOARD_URL` set, the Worker (not the browser) sends the PUT and
returns `{ "pushed": true, "shop_board": { "status": 200, "body": {…} } }` and sets `pushed_at`; Shop Board 409 → `502 shop_board_error`
with its message; no `SHOP_BOARD_URL` → `501 not_configured`. Never point it at the live Shop Board tonight.

## Test-only routes (exist only when `TEST_MODE=1`; 404 otherwise)

`POST /api/test/reset` → wipes requests, cells, starts, blocks, sessions and attempts; restores the default settings and PIN `2468`.
`POST /api/test/seed { "today"?: "YYYY-MM-DD" }` → a believable SAMPLE week (a few requested, confirmed, offered, one block). Customer
names end in "(sample)".

## D1 (bb1 owns the migrations)

`settings(key PK, value JSON)` · `requests(id PK, token UNIQUE, status, service_id, service_name, minutes, bays_needed, date, start_min,
end_min, bays JSON, offer_date, offer_start_min, offer_end_min, offer_bays JSON, name, phone, year, make, model, note, shop_note,
created_at, updated_at, pushed_at)` · `cells(date, bay, cell, owner, UNIQUE(date, bay, cell))` · `starts(date, start_min, n, owner,
UNIQUE(date, start_min, n))` · `blocks(id PK, date, start_min, end_min, bays JSON, label, created_at)` · `sessions(token_hash PK,
expires_at)` · `attempts(kind, key, created_at)`. `owner` is `r:<id>` or `b:<id>`. For `starts`, `n` is the smallest free number
1..`max_per_slot`, so a released number is reused and two racers picking the same `n` collide.
