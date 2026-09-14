# Book a Bay — brief (Onyx, 2026-09-14)

**Prefix** `bb` · **Ports** app 7301, worker 7302, QA 7309 · **Repo** `book-a-bay` (private) · **Lead effort** xhigh

## What
An online booking page for small auto repair shops, sold as an add-on to **Shop Board**
(`~/Projects/Shop Board`, read it first: its data model, themes Cosmic/Classic/Dark, API). A customer picks a
service, a day and a time slot, enters name / phone / vehicle, and sends a **request**. The shop confirms,
declines, or offers another time from its own board; the customer's status link shows what happened. Confirmed
bookings can be pushed into Shop Board as jobs (an adapter against Shop Board's real API/data shape; if Shop
Board has no endpoint for it, export a JSON/CSV Shop Board can import and say so in DECISIONS.md).

## Rules of the shop (settings screen, PIN-gated)
Services with duration and bays needed (oil change 30 min, tire swap 45, brakes 2 h, diagnostic 1 h…);
number of bays; weekly hours + closed days + holiday closures; lead time (no same-hour bookings); max bookings
per slot; NL time zone. **Slots are computed** from hours × bays × durations minus existing bookings — never a
hand-typed list. Two customers racing for the last slot: exactly one wins (transaction in D1), the other sees
"just taken, here are the next three".

## Customer side
Phone-first, no account. Service → date (next 14 days, closed days greyed) → slot → details → "Request sent".
Status page by unguessable link: Requested / Confirmed / Declined / New time offered (accept or pick another).
Add-to-calendar .ics once confirmed. **No SMS or email is sent** — the shop gets "copy this text" buttons with
ready-made messages to paste into their own phone.

## Shop side
PIN sign-in, today/week board by bay, pending requests on top with Confirm / Decline / Offer another time,
walk-in block-out, settings. Match Shop Board's look (default theme) so they feel like one product.

## Data
One SAMPLE shop: "SAMPLE Auto Service — Grand Falls-Windsor (demo)", labelled SAMPLE on every screen. Never
Warrior Automotive or any real shop.

## Tests that matter
Slot maths across a bay-count change and a closed day; the race (two concurrent requests, one wins) with a
negative control that removes the transaction and shows the double booking; full journey customer → shop
confirms → status page shows confirmed (real clicks, chromium + webkit, 390 + 1280); PIN wrong = 401.
