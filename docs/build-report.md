# Book a Bay: build report (lead)

Overnight build 2026-09-14. Lead `bb-lead` (Opus 5 xhigh), slices `bb1` Worker and `bb2` app (Opus 5 medium, auto mode), run with Rig.
Every number below was measured by the lead in a QA worktree pinned to the named sha on port 7309, never in a slice's own tree.
The slices' own reports (`docs/build-report-bb1.md`, `docs/build-report-bb2.md`) hold their reasoning and every attempt.

## QA history (Worker)

| Merge | sha | Unit (pure) | API (`wrangler dev --local`) | Negative controls run by the lead |
|---|---|---|---|---|
| bb1 M1 | `a60a943` | 15 / 15 | 9 / 9 | race: guard removed, 8 of 8 customers booked the one place (red as required) |
| bb1 M2 | `6e90d03` | 20 / 20 | 30 / 30 | race, status race, closures, bays, adapter mapping, lenient fake Shop Board: all red |
| bb1 M3 | `81c58f5` | 20 / 20 | 31 / 31 | the six above plus bays-in-flight: all red |
| bb1 M3b | `8e71df5` | 20 / 20 | 33 / 33 | the seven above plus shop `offer.bays` and the one readable `/api/r` 404: all nine red |
| bb1 M4 | `c64ffdb` | 20 / 20 | 36 / 36 | the nine above plus own-hold-free customer slots and the PIN 401 `field: current`: all eleven red |

0 skipped in every run.

## Negative controls (what each break proved)

| Check | Break (in a copy, never the shipped code) | Seen red |
|---|---|---|
| Last-slot race: exactly one of 8 wins | RACE-GUARD region replaced by read-check-then-insert, UNIQUE indexes dropped | 8 winners, 0 losers |
| Confirm and Decline at the same time leave holds matching the status | release DELETEs no longer tied to the transition's `rev` | 5 of 10 runs ended confirmed with no bay time held |
| Lowering bays while bookings are in flight | the in-transaction bay guard replaced by a no-op (25 ms stand-in latency in both copies; see limits) | guarded copy 0 of 20 bad; unguarded 6 of 20 saved bays=2 with a booking on bay 3 |
| Closure dates are closed | `dayInfo` ignores `closures` | the closure test fails |
| Slots respect the bay count | `pickBays` looks at 10 bays | the bay-count change test fails |
| Shop Board row mapping | 12:45 maps to `12:00 PM` | the mapping table fails |
| Fake Shop Board refuses what the real one refuses | the fake accepts any slot | the contract test fails |
| Shop view offer carries its bays | `bays` dropped from the shop offer | the offered-request test fails |
| A cut-short status link reads like an unknown one | the old `{16,128}` token pattern restored | `GET /api/r/nope` answers the bare "Not found." |
| A customer can move into time only their own booking blocks | `/api/r/:token/slots` counts the request's own hold | the own-hold time is not offered |
| The PIN form tells a wrong PIN from a dead session | `field: "current"` dropped from the wrong-PIN 401 | the PIN refusal test fails |
| App: status page shows Confirmed (bb2) | `confirmed` label shown as "Requested" | journey fails at 390 and 1280, against the mock and against the real Worker |
| App: taps hit the button they aim at (bb2) | transparent overlay over Send request | 4 taps fail the `elementFromPoint` hit-test |
| App: never the browser clock (bb2) | `new Date()` added to a copy | the clock guard fails; its pattern self-tests every run |

## Shop Board adapter, real round trip

At `6e90d03`: Book a Bay on 7308 with `SHOP_BOARD_URL` pointing at a throwaway local `git clone` of Shop Board (`25c6faa`) on 7306.
A confirmed 9:30 oil change pushed → 200; Shop Board's day sheet shows `bab-…` on the 9:00 row, bay 1, est. 30m, issue "Oil change
(booked online for 9:30 AM)", updated by "Book a Bay". A second confirmed 9:00 job on the same bay → `502 "Shop Board did not take it:
9:00 is taken"`, `pushed_at` empty. The Shop Board folder was never written to and the live Shop Board was never called.

## Cross-review

bb2 walked its M1 pages against bb1's real Worker before building M2 (178 passed, 0 failed in chromium and webkit at 390 and 1280).
Of its 11 findings, 8 were fixed on the app side or needed no change; 3 were contract gaps for bb1: message grammar (fixed in M2),
`offer.bays` missing from the shop view (API.md 17) and a bare "Not found." for a short status link (API.md 18).

bb1 then read bb2's M2 API calls against its Worker (read only). Every path, body, header and refusal matched, and so did the Settings
body against `validateSettings`. It found 5 gaps, all adopted (API.md 19–22, DECISIONS.md 20–22): the move pickers used the customer
day and time lists (broken once a service is taken offline, and hiding times blocked only by the request's own booking), the block label
limit, the PIN-change 401 ambiguity, and `pushed_at` not shown. bb1 built the routes in M4; bb2 switches the screens.

## Known limits so far

- **The bays-in-flight control needs stand-in latency.** Local D1 answers in about a millisecond, so without an added 25 ms wait in
  the test copies the unguarded code never double-booked in 20 runs. The guard exists for production round trips; the control shows
  that with realistic latency it is the only thing preventing the bad ending.
- **Shop Board holds one car per bay per hourly row** (DECISIONS.md 14); the second car in that hour is refused with Shop Board's message.
- Pending requests created in the same millisecond order by id.
