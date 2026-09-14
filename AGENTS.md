# Book a Bay

Online booking page for small auto repair shops, an add-on to Shop Board. A customer picks a service, a day and a
time and sends a request; the shop confirms, declines or offers another time; the customer's status link shows
what happened. Overnight build 2026-09-14, lead `bb-lead`, slices `bb1` (Worker) and `bb2` (app).

Read PLAN.md first (the Rig contract), then docs/API.md (the contract between slices), then DECISIONS.md.

## Stack and ports

- `worker/`: Cloudflare Worker, plain JS ESM, D1 binding `DB` (`book-a-bay`). Serves `/api/*` and the static app in `app/public/`.
- `app/public/`: plain HTML/JS/CSS, no build. `/` customer booking, `/r/?t=<token>` status page, `/shop/` shop side.
- `app/tests/`: Playwright, chromium + webkit, 390 and 1280, against the real Worker.
- Ports: bb1 Worker 7302 (inspector 7312) · bb2 static 7301, e2e Worker 7303 (inspector 7313) · QA 7309 (inspector 7319).
  Always pass `--inspector-port`: other crews run wrangler too and the default 9229 collides.
- Sample shop PIN `2468`.

## Rules that bite here

- **Local only.** `wrangler dev --local`. No `wrangler deploy`, `secret put`, `d1 create`, `--remote`, Pages or DNS.
- **Nothing is sent.** No SMS, email or Slack; the shop copies ready-made texts. Never push to the live Shop Board.
- **SAMPLE on every screen.** The shop is "SAMPLE Auto Service — Grand Falls-Windsor (demo)". Never Warrior Automotive or any real shop.
- **Shop dates come from the API**, never the browser clock. `TEST_MODE=1` (tests only) enables `X-Test-Now` / `X-Test-IP`.
- **Slots are computed**, never a typed list. The race guard is `DB.batch()` + UNIQUE cells/starts.
- Own only your slice's paths; `rig guard` enforces it. Verify → commit (own paths) → report.
- Every important check has a negative control: break it, watch it go red, restore, record it.
- Plain English for Newfoundland users. No emoji as icons. No devils or demons.

## Standing rules (every project, read by Claude Code and Codex alike)

CLAUDE.md is a symlink to this file, so Onyx (Claude Code) and Cobalt (Codex) read the same text. Edit AGENTS.md only.

- **Read PLAN.md first where it exists; it is the contract.** Own only your slice's files.
- **What "done" means:** verified, committed (only your own paths, with a message that says what and why), pushed, and shown: a screenshot via `pwshot` for anything visible. Never hand back an empty screen; seed demo data if the UI needs it. Never leave a green step uncommitted.
- **Nothing leaves without Alexander.** Emails, forms, applications, posts, marketplace submissions and pull requests to other people's repos are staged to one click; he presses send.
- **Tests that cannot lie.** A bug that reached a person gets a test that fails without the fix, proved by reverting the fix. Every guard (grep, lint, check) is shown to fail on a known-bad input in the same run: a check that cannot fail measured nothing. Real dependencies over mocks where practical. Hit-test with elementFromPoint, never rects.
- **Public-repo hygiene.** No secrets, no machine names, no home-folder paths, no invented businesses. Real businesses appear only where Alexander chose to show them. Run `check-no-personal-data` before pushing a public repo.
- **Browser work.** Playwright is the default; WebKit check before calling a WKWebView page done; the Chrome extension only for pages that need his real login.
- **Keep this file short:** commands, gotchas with a why, hard rules. Architecture belongs in the code and README.
