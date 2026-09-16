# Deploying Book a Bay

**Demo deployed 2026-09-15** at Alexander's go: D1 `book-a-bay` (id `3648979d-4957-4b0c-b9e3-7dee87cfb2b7`), migrations
0001–0003 applied remotely, Worker `book-a-bay` at <https://book-a-bay.alexjpower74.workers.dev>, `SHOP_BOARD_URL` unset
(the demo does not push into a real Shop Board). One deployment serves one shop (DECISIONS.md #1); a real shop follows
the checklist below with its own database.

## What gets created

| Thing | Name | Command (run from `worker/`) |
|---|---|---|
| D1 database | `book-a-bay` | `wrangler d1 create book-a-bay`, then paste the printed id into `worker/wrangler.toml` `database_id` (replaces the all-zero placeholder) |
| Schema + default settings | migrations `0001…` | `wrangler d1 migrations apply book-a-bay --remote` (deploy does **not** migrate; smoke-test a data route after) |
| Worker + static app | `book-a-bay` | `wrangler deploy` (serves `/api/*` from the Worker and everything else from `app/public`) |

## Settings and secrets

| Name | Kind | Needed? | What it does |
|---|---|---|---|
| `SHOP_BOARD_URL` | var | optional | The shop's Shop Board origin, e.g. `https://shop-board.<account>.workers.dev`. Turns on "Send to Shop Board". Without it the button says it is not set up and the JSON/CSV export still works. |
| `TEST_MODE` | var | **never in production** | Test clock, test IP and `/api/test/*` routes. Must be absent from `wrangler.toml` and the dashboard. |

No secrets are required: the shop PIN is stored hashed in D1, not as a Worker secret.

## Before a real shop uses it

1. **Change the PIN.** The sample PIN `2468` ships in migration `0002`. Sign in at `/shop/`, Settings, Change PIN.
2. **Rename the shop** and remove "SAMPLE" / "(demo)" in Settings, set its real hours, bays, services and holiday closures.
3. Do not run `/api/test/seed` (it only exists with `TEST_MODE=1` anyway).
4. Decide the domain: a `workers.dev` URL, or a custom route such as `book.<shopdomain>` (DNS in Cloudflare, route in `wrangler.toml`).
5. Point the shop's Shop Board at nothing new: Shop Board needs no change, Book a Bay calls its existing `PUT /api/bookings/:id`.

## Cron

None. Slots are computed on request; there is no scheduled job.

## After deploying

- `curl https://<worker>/api/shop` returns the shop and services (proves migrations ran).
- Book one request from a phone, confirm it at `/shop/`, check the status link shows Confirmed and the `.ics` opens.
- If `SHOP_BOARD_URL` is set: push that booking and see it on the Shop Board day sheet, then delete it there.
