# Snow Route

A phone tool for a small snow-clearing contractor in Newfoundland: the client list, tonight's route in order, a big
Plowed button with a photo at each stop, a status link each client can check, and a month-end count of pushes per
client for billing. Overnight build 2026-09-14, lead `sr-lead`, slices `sr1` (Worker) and `sr2` (app).

Read PLAN.md first (the Rig contract), then docs/API.md (the contract between slices), then DECISIONS.md.

## Stack and ports

- `worker/`: Cloudflare Worker, plain JS ESM, no build, no npm deps (`wrangler` on PATH, 4.131+). D1 binding `DB`
  (`snow-route`), R2 binding `PHOTOS` (`snow-route-photos`). Serves `/api/*` and the static app in `app/public/`.
- `app/public/`: plain HTML/JS/CSS, no build. `/owner/` owner side (PIN) · `/d/?k=` driver · `/s/?k=` client status.
- `app/tests/`: Playwright 1.63, chromium + webkit, 390 and 1280, against the real Worker.
- Ports: sr1 Worker 7602 (inspector 7612), sr1 negative controls 7605 (inspector 7615) · sr2 dev Worker 7601
  (inspector 7611), e2e Worker 7603 (inspector 7613), queue negative control 7606 (inspector 7616) · QA 7609 (inspector 7619).
  Always pass `--inspector-port`: other crews run wrangler too and the default 9229 collides.
- SAMPLE owner PIN `2468`.

## Rules that bite here

- **Local only.** `wrangler dev --local`. No `wrangler deploy`, `secret put`, `d1 create`, `r2 bucket create`, `--remote`, Pages or DNS.
- **Nothing is sent.** No SMS, email or Slack; messages to clients are "copy this text" buttons.
- **SAMPLE on every screen.** The company is "SAMPLE Snow Clearing — Grand Falls-Windsor (demo)". Client names are SAMPLE.
  Streets are real, house numbers are deliberately absent.
- **Map tiles:** Leaflet + OpenStreetMap tiles, attribution always visible, no prefetching or bulk download. Tests never
  fetch real tiles: they route `tile.openstreetmap.org` to a local placeholder.
- **Times are NL time** (`America/St_Johns`). A check-in keeps the time the driver tapped, not the time it synced.
- **Billing counts only plowed, non-voided check-ins.** A skipped stop never bills.
- **Driver tap targets are at least 56 px.** Gloves.
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
