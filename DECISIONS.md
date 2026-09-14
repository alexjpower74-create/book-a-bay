# Decisions

Alexander was asleep for this build; every real call is written here with its reason. Newest at the bottom.

## 2026-09-14, lead (contract)

1. **One deployment per shop.** Shop Board is single-shop (one Worker, one D1). Book a Bay matches it: one Worker + one D1 per shop,
   no shop id column. Multi-shop hosting is a later change, not a hidden assumption.
2. **One Worker serves the API and the app** (`/api/*` runs the Worker first, everything else is static from `app/public`). Same origin
   means no CORS and one thing to deploy. Plain JS, no build step, the Next Up pattern.
3. **The race guard is a D1 batch plus UNIQUE indexes, not a read-then-write.** D1 has no interactive `BEGIN…COMMIT`; `DB.batch()` is
   one transaction. Each held 15-minute bay cell is a row in `cells` with UNIQUE(date, bay, cell), and each start takes a numbered
   row in `starts` with UNIQUE(date, start_min, n) for the per-slot cap. Two racers for the last slot cannot both commit. The negative
   control swaps this for check-then-insert and shows the double booking.
4. **Requested and offered requests hold bay time, not just confirmed ones.** Otherwise two customers could both "request" the last slot
   and the shop would have to turn one away, which is the thing the brief says must not happen. An offer moves the hold to the offered
   time. Declined and cancelled release it.
5. **The customer's status token is stored as is, not hashed.** The shop needs to paste the status link into its own text message, so
   the server must be able to show it again. It is 128+ random bits and only grants view/accept/repick/cancel on one booking.
   Shop session tokens (which grant the whole board) are hashed.
6. **Lowering the bay count is refused while future bookings sit on the removed bays.** Shop Board hides such bays; for a booking page
   that would silently double-book the remaining bays. The shop gets a plain message saying which bay and from when.
7. **Vehicle is collected as year / make / model**, the same three columns Shop Board has, so the adapter maps field to field.
8. **Shop Board adapter.** Shop Board has a real write endpoint (`PUT /api/bookings/:id`, patch with stamped fields, no sign-in), so the
   adapter pushes to it server-side when `SHOP_BOARD_URL` is set, and also offers a JSON/CSV export. Shop Board's rows are fixed times
   (8:00…5:00 with two lunch rows) and its est. times are 30m…Day, so a 9:30 booking lands on the 9:00 row with "booked online for
   9:30 AM" in the issue. Tonight it is only ever tested against a local copy; never the live Shop Board (no deploys, nothing leaves).
   *Verified by the lead 02:00 against a throwaway `git clone` of Shop Board at `25c6faa` running `wrangler dev --local` on 7306:*
   `PUT /api/bookings/bab-probe01` with the mapped patch → 200 and the booking is on that day's sheet; a second id on the same
   (date, slot, bay) → `409 {"error":"9:00 is taken","code":"taken","conflict":{…}}`. A longer job covering the row answers
   `409 code "busy"` (read from its source). The Shop Board folder itself was never written to.
9. **Test clock and test IP are headers honoured only when `TEST_MODE=1`.** The browser clock is never used for shop dates; the app
   takes today/now from the API, which also keeps a customer in another time zone on the shop's calendar.
10. **15-minute cell grid.** Service durations and hours are on 15-minute marks; start times are offered every 15, 30 or 60 minutes
    (setting, default 30).
11. **Sample data.** The shop is "SAMPLE Auto Service — Grand Falls-Windsor (demo)" with SAMPLE on every screen; seeded customer names
    end in "(sample)"; the sample closure is "Staff training (sample)". Never Warrior Automotive or any real shop.
12. **Crew shape.** Two slices (rules allow at most two): bb1 Worker + D1 + slot maths + adapter, bb2 the three screens + Playwright.
    The lead owns the contract, README, deploy notes, QA and the real Shop Board round trip.

## 2026-09-14, lead (after bb1 M2)

13. **Real round trip verified 03:25 at `6e90d03`.** Book a Bay on 7308 with `SHOP_BOARD_URL` pointing at a throwaway local clone of
    Shop Board (`25c6faa`, port 7306): a confirmed oil change at 9:30 pushed → 200, and Shop Board's day sheet shows it on the 9:00 row,
    bay 1, est. 30m, issue "Oil change (booked online for 9:30 AM)", updated by "Book a Bay".
14. **Shop Board holds one car per bay per hourly row, and that is not hidden.** A second confirmed job at 9:00 on the same bay maps
    to the same Shop Board row, so its push answers `502 "Shop Board did not take it: 9:00 is taken"` and `pushed_at` stays empty. The
    JSON/CSV export still lists both. Book a Bay does not quietly move the car to another Shop Board bay: that would misreport which bay
    the shop planned. The shop moves it by hand in Shop Board, or Shop Board gains half-hour rows later.
15. **bb1's M2 readings adopted** (API.md clarifications 8–15): a `rev` column ties hold changes to one transition; a test-only holds
    route; `busy` vs `taken` offer refusals; rate-guard details; push/export behaviour; message wording.
16. **Lowering bays while a booking is in flight must be closed, not documented** (API.md clarification 16). The window is milliseconds,
    but the result would be a booking on a bay that no longer exists. Sent to bb1 as M3.
17. **`npm run demo` runs the local Worker with `TEST_MODE=1`** so it can seed the SAMPLE week. That is fine on this computer and is
    exactly what must never reach a deploy (docs/DEPLOY.md).

## 2026-09-14, lead (after bb2 M2)

18. **The primary button is darker than Shop Board's.** bb2 measured Shop Board's `#6366f1 → #8b5cf6` gradient at 4.47 : 1 and 4.2 : 1
    against white text, under the 4.5 : 1 minimum for normal text. Book a Bay uses `#4f46e5 → #7c3aed` (6.3 and 5.7 : 1), and a test
    checks every gradient stop. Still the same indigo-violet family, so the two products read as one; Shop Board itself should take the
    same fix (not touched tonight: another project's folder).
19. **No test may skip itself because a route is missing once every route exists.** bb2's M2 specs skipped while bb1's M2 routes were
    not yet on its branch. That was right for a few hours and would be a check that cannot fail afterwards, so the skip helper is removed
    before the final QA, and the final run must report 0 skipped.
