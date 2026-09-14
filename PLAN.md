# Snow Route: build contract

One plan file. It is the contract, and it lives at the repo root so every agent reads the same copy.
Then read `docs/API.md` (the contract between slices) and `DECISIONS.md`. `BRIEF.md` is the original brief. `AGENTS.md` has ports.

## The brief (Onyx for Alexander, 2026-09-14)
A phone tool for a small snow-clearing contractor in Newfoundland, sellable to the one- and two-truck operators in every NL town.

- **Owner (PIN):** clients (name, address placed as a map pin, type driveway/lot/walkway, priority medical/early commuter/business
  opening, notes shown at the stop, billing per push or seasonal, price), trucks, **Start a storm** (route: priorities first, then
  nearest neighbour + 2-opt on straight-line distance from the yard; drag to reorder; the screen says the order is "by distance,
  not road time"), **End storm** → summary. Leaflet + OpenStreetMap tiles with the attribution shown.
- **Driver (phone in a truck, gloves, bad signal):** the next stop huge (name, address, notes), **Navigate** (opens the phone's maps
  app with the address), **Plowed** (camera photo + time), **Skip** with a reason (car in the way, gate locked, client cancelled).
  **Works offline:** check-ins queue on the phone and sync when signal returns, keeping the original times. Tap targets ≥ 56 px.
- **Client:** an unguessable status link: last plowed time + photo; during a storm "on the route tonight, you're stop N" (no live
  GPS). No accounts. Messages to clients are "copy this text" buttons only; nothing is sent.
- **Billing:** month view of pushes per client, per-push totals or the seasonal flag, HST 15%, CSV export for the accountant.
  The count comes only from check-ins; a skipped stop never bills.
- **Data:** "SAMPLE Snow Clearing — Grand Falls-Windsor (demo)", 25 SAMPLE clients on real public streets
  (`data/sample-clients.json`: real street centre points from OpenStreetMap, SAMPLE names, no house numbers), 2 SAMPLE trucks.
  Photos in tests are generated placeholders.

## Design
Night-shift truck cab first: dark, calm, very high contrast, nothing decorative on the driver screen.
- Tokens (`app/public/theme.css`): ground `#0b1220`, surface `#131c2e`, raised `#1a2540`, line `rgba(255,255,255,0.10)`, text
  `#eef3fb`, muted `#a3b3cc`, accent ice blue `#7cc4ff`. Actions: **Plowed** `#15803d` with white text, **Skip** `#f59e0b` with ink
  `#1a1200`, **Navigate** `#1d4ed8` with white. Status: Pending muted, Plowed `#4ade80`, Skipped `#fbbf24`. SAMPLE badge: amber
  outline `#fbbf24`. Radius 14 px. Every text/background pair ≥ 4.5 : 1 (a test checks the action buttons).
- System font stack only (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`); no web
  fonts, so the driver page works with no signal. No emoji as icons (inline SVG where an icon helps).
- **Driver:** next stop name ≥ 34 px bold, address 22 px, notes 20 px in a raised amber-edged box. Buttons full width, ≥ 72 px tall
  (56 px is the floor), 16 px apart. Big stop counter "Stop 4 of 13". A sync strip always visible: "All sent" or "No signal. 2
  check-ins saved on this phone. They send when signal comes back and keep the time you tapped."
- **Owner:** phone-first at 390, comfortable at 1280 (list + map side by side). Map with numbered round markers coloured by status,
  the route as a line, attribution "© OpenStreetMap contributors" linking https://www.openstreetmap.org/copyright always visible.
- **Client status:** one card: company + SAMPLE badge, the client's address, then the big answer ("Plowed at 6:42 AM" + photo,
  or "On the route tonight. You're stop 4." + "2 stops are done so far.", or "Not plowed yet this storm."). No map.
- Plain English for Newfoundland: "Next stop", "Navigate", "Plowed", "takes a photo", "Plowed, no photo", "Skip this stop",
  "Why are you skipping?", "Car in the way", "Gate locked", "Client cancelled", "Other", "Undo", "Start a storm",
  "Build tonight's route", "Order is by distance, not road time.", "End storm", "Copy text", "Copied".
- Everything quiet under `prefers-reduced-motion`.

## Stack
- `worker/`: Cloudflare Worker, plain JS ESM, no build, **no npm dependencies** (use the `wrangler` on PATH, 4.131+).
  `worker/wrangler.toml`: name `snow-route`, `main = "src/index.js"`, `compatibility_date = "2026-09-01"`, D1 binding `DB`
  (`database_name = "snow-route"`, `database_id = "00000000-0000-0000-0000-000000000000"` with a comment that deploy replaces it,
  `migrations_dir = "migrations"`), R2 binding `PHOTOS` (`bucket_name = "snow-route-photos"`), `[assets] directory = "../app/public"`,
  `run_worker_first = ["/api/*"]`. **No `TEST_MODE` in `[vars]`, ever.**
- `app/public/`: plain HTML/JS/CSS served by the same Worker (`/`, `/owner/`, `/d/`, `/s/`). Leaflet 1.9.4 is installed in
  `app/node_modules/leaflet`; copy `dist/leaflet.js`, `dist/leaflet.css` and `dist/images/` into `app/public/vendor/leaflet/` with
  its LICENSE (no CDN: the owner may be on bad signal too).
- `app/tests/`: Playwright 1.63 (`app/node_modules` is installed on main; the lead symlinks it into your worktree).
- Local dev everywhere: `wrangler dev --local --port <p> --inspector-port <p+10> --persist-to <dir>`; tests add `--var TEST_MODE:1`.
  Migrations: `wrangler d1 migrations apply snow-route --local --persist-to <dir>` (run from `worker/`).
- **Reference, read only:** `~/Projects/Book a Bay` is a finished sibling build with the same shape. Its `worker/tests/run.mjs`,
  `worker/tests/negative-*.mjs` + `negative-lib.mjs` (copy-the-worker-and-break-it controls) and `app/tests/start-worker.mjs` +
  `app/playwright.config.mjs` + its `tap()` helper are good patterns to copy and adapt. Never write in that folder, never run from it.
- **Ports (never use another):** sr1 Worker 7602 (inspector 7612), sr1 negative-control Workers 7605 (inspector 7615).
  sr2 dev Worker 7601 (inspector 7611), e2e Worker 7603 (inspector 7613), queue negative control 7606 (inspector 7616).
  QA (lead) 7609 (inspector 7619). Other crews run wrangler on this machine; the default inspector port 9229 collides.

## Rules
- You own the files listed under your id and **nothing else**. If you need a change in someone else's file, say so in your report;
  do not reach in. `rig guard` enforces this. The lead owns `docs/API.md`: if the contract is wrong or unclear, write the question in
  your report and end your turn; do not invent a different contract.
- Verify, then commit, then report. Never leave a verified step uncommitted: a usage-limit pause lands mid-task with no warning.
- Your report goes in `docs/build-report-<your id>.md`, committed with your work: tests passed/failed/skipped, every negative control
  with the exact break and the red output, known gaps, and anything you want the lead to decide.
- Commit only your own paths: `git commit -- <paths>`. Never grade the shared tree; the lead's numbers come from `rig qa`.
- A check that cannot fail measured nothing. Every task below names its negative controls: make each red once, record it, restore.
  Controls break a **copy** (in `.negative/`, git-ignored), never the shipped code, and the shipped code has no switch that turns a guard off.
- **Milestones.** Finish the milestone, commit, update your report, and end your turn with a one-paragraph summary. The lead merges,
  sends a cross-review, then prompts you for the next milestone. Do not start the next one before that prompt.
- Local only: no deploy, no `--remote`, no `d1 create`, no `r2 bucket create`, no `secret put`. Nothing is sent anywhere. If auto mode
  denies something, do not work around it; note it in your report and carry on.
- No devils or demons, no emoji icons, SAMPLE on every screen, no real businesses, no house numbers on SAMPLE addresses.
- No request to a real third-party host from any test (tiles are routed to a local placeholder; a test asserts nothing left 127.0.0.1).

## Agents

### sr1 — Worker, D1, R2, routing, check-ins, billing
Owns:
- worker/**

Report: docs/build-report-sr1.md

Task:
Implement `docs/API.md` exactly, in `worker/src/` (suggested split: `index.js` router, `route.js` pure routing, `time.js` NL labels
and month bounds, `billing.js` pure money + CSV, `auth.js` PIN/tokens/keys, `clock.js` now/IP with the TEST_MODE rule, `sample.js` +
generated `sample-data.js`). `worker/tools/build-sample-data.mjs` reads `../data/sample-clients.json` and writes `src/sample-data.js`
(commit the output; the Worker never reads outside `worker/`). `npm test` = `node tests/run.mjs`: pure unit tests first, then wipe
`worker/.state-<PORT>`, apply migrations there, start `wrangler dev --local` with `--var TEST_MODE:1` on `PORT` (default 7602) if nothing
answers, run `node --test tests/api.test.mjs`, stop what it started. `npm run negative` runs every negative control; each appends its
output to `tests/negative-control.log` and exits 0 only if its check went red. `npm run dev` = migrate + wrangler dev on 7602.

**M1 (commit as soon as it is green, then stop):** `wrangler.toml`; `migrations/0001_init.sql` (company single row, sessions,
sign-in attempts, trucks, clients, storms, storm_stops PRIMARY KEY (storm_id, client_id), checkins with `id TEXT PRIMARY KEY` and the
`checkins_one_plowed` partial unique index, photos); `migrations/0002_company.sql` (the SAMPLE company, yard, PIN 2468 as PBKDF2 hash +
salt). Routes: `GET /api/company`; owner `signin`, `signout`, `GET clients`, `POST clients`, `PUT clients/:id`, `GET trucks`,
`GET storms/current`, `POST storms`, `GET storms/:id`; driver `GET route`, `POST checkins`, `PUT checkins/:id/photo`; `GET /api/photos/:token`;
`GET /api/status/:key`; `POST /api/test/reset`.
M1 tests. `tests/route.test.mjs` (pure): haversine against a known pair (two SAMPLE street points, expected value computed
independently in the test with the formula written out); every tier-0 before tier-1 before tier-2 on 50 seeded random instances;
**2-opt local optimum**: on those instances no single reversal of the returned tier path shortens it by more than 0.5 m; a crafted
crossing instance where plain nearest neighbour crosses itself and the result does not (assert the exact expected order); result length
≤ nearest-neighbour length; deterministic; empty and one-stop inputs; truck assignment (own truck kept, orphan goes to the truck with the
nearest stop, tie → fewer stops). `tests/api.test.mjs` M1: company shape; wrong PIN 401 with field `pin`, right PIN → token, no token
→ 401; clients list has 25 SAMPLE clients, POST validation (one test per field in the table) and a good POST/PUT; start a storm with
all clients and both trucks → 201, each truck's medical stops first, a second start → 409 `bad_state`; driver route with a bad key 401
and a good key shows only that truck's stops in order; **check-ins:** plowed → 201 and stop plowed; **the same id again → 200
`duplicate: true` and still exactly one check-in** (read back through the owner storm view); a different id plowed for the same stop →
409 `already_plowed`; skip without reason 400; skip then plowed → plowed; plowed then skip → 409; **original time kept**: `at` = T,
server now (X-Test-Now) = T + 45 min → stored `at` = T and `at_adjusted` false; `at` 2 h in the future → adjusted; a check-in after
the storm is ended (end it directly in D1 through a test-only helper route or SQL via reset state — your choice, say which) is still
accepted; photo PUT jpeg → `stored` and `GET photo_url` returns the same bytes and type; 415 for `text/plain`; 413 for 5 000 001 bytes;
status link: during the storm `tonight.state` waiting with the right `stop_number`, after plowed `last.time_label` and `photo_url`,
unknown key 404, and the JSON never contains the client's notes or price (assert on the raw text).
M1 negative controls: (a) `negative:twoopt` — the copy's 2-opt is skipped → the local-optimum and crossing tests go red;
(b) `negative:tiers` — the copy ignores priority → the tier test goes red; (c) `negative:idempotent` — the copy's check-in insert is a
plain `INSERT` on a table without the PRIMARY KEY (migration in the copy) → the same-id test shows two check-ins and goes red;
(d) `negative:time` — the copy stores server now instead of `at` → the original-time test goes red.

**M2 (after the lead's prompt):** every remaining route in API.md: owner PIN change, company GET/PUT, clients `reset-link` and
`messages`, trucks POST/PUT/`reset-link`, storms list, route PUT, stops POST/DELETE, end, summary, messages on owner stops, billing
months/JSON/CSV, driver undo (DELETE), sign-in rate guard (5 wrong / 15 min per IP → 429, then even the right PIN), unknown-status-key
guard (30 / 10 min → 429), `POST /api/test/seed {scenario: "demo"}` with generated SVG placeholder photos. Tests: every route's happy path
and its main refusals; route PUT refuses a missing stop, a duplicate stop and a foreign truck, and a stop moved between trucks shows up
on the other driver's route; summary counts, `not_reached`, per-truck first/last; **billing:** per-push amounts, HST half-up on a value
that rounds (e.g. 3 × $35.50 → amount 10650, hst 1598), totals = row sums, seasonal row with 0 amounts and its pushes counted, active
seasonal client with no pushes listed, **a skipped stop never bills**, a voided check-in never bills, **NL month boundary** (a plowed
check-in at `2026-02-01T03:00:00Z` is Jan 31 11:30 PM NST and bills in January, not February), CSV header exact, CRLF, quoting of a
name with a comma and a quote, formula guard on a client named `=SUM(A1)`, filename; undo within 15 min → voided and the stop pending
again and no billing, after 16 min → 409; messages text exact for each kind; rate guards with `X-Test-IP`; reset-link makes the old key
404 (status) / 401 (driver); the demo seed produces non-empty billing for the current month and a storm with 10 plowed stops.
M2 negative controls: (e) `negative:skipbill` — the copy's billing counts every check-in kind → the skipped-never-bills test goes red;
(f) `negative:month` — the copy uses UTC month bounds → the NL boundary test goes red; (g) `negative:csvguard` — the copy drops the
formula guard → the CSV test goes red; (h) `negative:voidbill` — the copy counts voided check-ins → the voided test goes red.

### sr2 — Driver (offline), client status, owner side, Playwright
Owns:
- app/**

Report: docs/build-report-sr2.md

Task:
Build the pages per the brief and Design, talking only to the API in `docs/API.md` through `app/public/api.js` (same-origin
`fetch('/api/…')`; errors surface the API's `error` text as is). Every screen shows the company name and a visible **SAMPLE** badge
while `sample` is true. Until sr1's M1 is merged into your branch you may develop against `app/public/api.mock.js` (`?mock=1`, in-memory,
same shapes as API.md), but **every Playwright test runs against the real Worker**.
Playwright (`app/playwright.config.mjs`): projects `chromium-390` (390×844, hasTouch, isMobile), `chromium-1280` (1280×800),
`webkit-390` (iPhone 14 device), `webkit-1280`; `workers: 1`; `webServer` = `node tests/start-worker.mjs` (from `../worker`: wipe
`app/tests/.state-<port>`, apply migrations `--local --persist-to` it, `wrangler dev` on `E2E_PORT` default 7603, inspector +10,
`--var TEST_MODE:1`; `E2E_WORKER_DIR` env may point it at a copy for negative controls); `baseURL` = that Worker. Every test starts with
`POST /api/test/reset`. A shared fixture routes `https://tile.openstreetmap.org/**` to a local 256 px placeholder PNG and fails the test if
any request goes to a host other than 127.0.0.1. **Real input only:** taps/clicks through a `tap()` helper that hit-tests the target's
centre with `elementFromPoint` first, typing via `page.keyboard`, drags via `page.mouse`, photos via the real file chooser
(`page.waitForEvent('filechooser')` after a real tap, then `setFiles` with a **generated** placeholder image buffer); never set app state
with `evaluate`. The one allowed exception: native `<select>` values via `selectOption`.

**M1 (commit when green, then stop):** `theme.css` + `style.css`; `/` landing; **driver page `/d/?k=`**: loads `GET /api/driver/route`
and caches it (`snow-route:route:<truck id>`); "No storm on right now" when `storm` is null; otherwise "Stop N of M", the next pending stop
huge (name, address, notes, opens_at when set, priority label), **Navigate** (`https://maps.apple.com/?daddr=<address>&dirflg=d` on
iPhone/iPad, `https://www.google.com/maps/dir/?api=1&destination=<address>` everywhere else; a real link, `target="_blank"`),
**Plowed** (a label-styled button over `<input type="file" accept="image/*" capture="environment">`; on a chosen photo: downscale to max
1600 px JPEG quality 0.7 with a canvas, record the check-in with `at` = the moment the photo was chosen), **Plowed, no photo**, **Skip this
stop** → a reason sheet (Car in the way / Gate locked / Client cancelled / Other with an optional note) → recorded. After any check-in:
the next stop shows at once, and an **Undo** bar stays for 15 s (a queued check-in is just removed; a sent one calls DELETE). A list of all
stops with status below the fold, with skipped stops offering "Plowed now". **Offline queue** (`app/public/d/queue.js`): every check-in is
written to IndexedDB first (with its photo blob), the screen updates from route + queue, and a sender posts oldest first: a check-in is
removed from the queue **only** after a 200/201 answer (a 409 `already_plowed` moves it to a visible "Not accepted" list with the server's
message, never silently dropped), then its photo is PUT and removed only after a 200. The sender runs on each new check-in, on `online`, on
`visibilitychange` to visible, and every 20 s while anything is queued, with backoff; network errors leave the queue untouched. The sync
strip per Design. **Service worker** `app/public/d/sw.js` (scope `/d/`): caches the driver page, its JS/CSS and theme on install, serves
them cache-first, never touches `/api/*`. **Client status page `/s/?k=`** per Design, polls every 60 s and on `visibilitychange`, plain 404
message for a bad link. Screenshots of the driver (storm on, no storm, skip sheet, offline strip) and status (waiting, plowed with photo)
at 390 and 1280 into `app/tests/shots/`.

**M2 (after the lead's prompt; `git rebase main` first, sr1 M1 is merged by then):** the Playwright suite for everything so far, against
the real Worker, plus the owner side on M1 routes. Owner `/owner/`: PIN sign-in (token in `localStorage` `snow-route:owner-token`, sign
out); **Clients** (list with type/priority/billing chips, a Leaflet map of every client, add/edit form where the pin is placed by
tapping/clicking the map or dragging the marker, fields per API.md with the API's messages inline; price typed in dollars); **Trucks**
(list, driver link with "Copy link"); **Tonight**: "Start a storm" → tick clients (all active ticked, "Untick all"/"Tick all") and trucks →
"Build tonight's route" → per-truck ordered stop lists with status, the route drawn on the map with numbered markers, "Order is by distance,
not road time." Specs: `driver.spec.mjs` (open the driver link → Stop 1 is a medical stop; Navigate href is the maps URL with the encoded
address; Plowed with a generated photo → next stop shows; Skip → Gate locked → next; the owner storm view via API shows the plowed stop with
`photo: "stored"` and the skip's reason; Undo on a sent check-in → stop pending again), `offline.spec.mjs` (**the queue**: load the driver
page online; go offline with `context.setOffline(true)`; with `page.clock` set to T, Plowed with a photo and Skip another stop; the strip
says 2 saved; reload the page while still offline and it still shows the route and "2 saved" (chromium; if WebKit's service worker cannot
do this under Playwright, skip only that reload step on webkit with a written reason); advance the phone clock 40 minutes; go online → the
strip says "All sent" → the API shows both check-ins with `at` equal to T (not the sync time) and the photo stored; also: going online
while the Worker answers 500 once leaves both queued and they send on the next try), `status.spec.mjs` (waiting → "You're stop N" matching
the driver's list; after the driver plows it → "Plowed at h:mm AM" and the photo loads; bad link → the plain 404 message), `owner.spec.mjs`
(wrong PIN "That PIN is not right." **and** the sign-in response is 401 via `waitForResponse`; add a client by typing and clicking the map →
it appears in the list and on the map; start a storm → medical stops first on each truck and the order note visible; the map attribution
"OpenStreetMap" is visible), `targets.spec.mjs` (every driver button ≥ 56 px tall and wide and hit-tests to itself at 390 in both engines;
the SAMPLE badge visible on `/`, `/owner/`, `/d/`, `/s/`; no horizontal scroll at 390; the action colours meet 4.5 : 1).
M2 negative controls: (a) `app/tests/negative-queue.mjs` — copy `app/public` + `worker` into `app/.negative/queue/`, change the copy's
queue to delete an item **before** the server answers, start that copy on 7606, run `offline.spec.mjs` against it → it must go red because a
check-in never reached the server; exit 0 only if red; append to `app/tests/negative-control.log`; (b) `negative-time.mjs` — the copy stamps
`at` when the item is sent instead of when it was tapped → the original-time assertion goes red; (c) a transparent overlay over the
Plowed button in a copy → the `tap()` hit-test goes red. Record all three with the red output.

**M3 (after the lead's prompt; rebase on main, sr1 M2 merged):** the owner side on M2 routes: Tonight — drag to reorder (a drag handle
with pointer events, plus "Move up"/"Move down" buttons on each stop, plus "Move to Truck 2"), saved through route PUT; "Add a stop"; copy
buttons for each stop's `messages` (clipboard, "Copied"); "End storm" with an inline confirm → the summary screen (plowed, skipped with
reasons, not reached, per truck, copy "skipped" texts); past storms list. Trucks: add, rename, deactivate, "New link" (inline confirm, says
the old link stops working). Clients: deactivate, "New status link", copy the status text. **Billing**: month select (from
`/billing/months` plus the current month; opens on the newest month with pushes), table (client, billing, pushes with dates, price,
amount, HST, total), the seasonal note, totals, "Download CSV for the accountant" (fetch with the token → blob download). Settings: company
name, yard pin on the map, change PIN. Specs: `route-edit.spec.mjs` (1280: a real mouse drag of stop 3 above stop 1 → the order persists after
reload and the driver sees it; 390: Move up / Move down; move a stop to the other truck → the other driver sees it), `storm-end.spec.mjs`
(end with confirm → summary lists the skipped stop with its reason and the not-reached count; the driver page then says no storm),
`billing.spec.mjs` (drive real check-ins for two stops through the driver page, skip a third, end the storm → billing shows the two pushes
with the right amounts, HST and total, the skipped client with no push, the seasonal note; the CSV download's text matches the table),
`copy.spec.mjs` (Copy text puts the exact API text on the clipboard: grant `clipboard-read`/`clipboard-write` in chromium; on webkit
assert "Copied" and skip the read with a written reason if the clipboard cannot be read). M3 negative control: (d) in a copy, the billing
screen reads `pushes` from the stop count instead of the API row → `billing.spec` goes red. Final screenshots of every screen per project
into `app/tests/shots/`.

## Main (sr-lead, not a slice)
Owns PLAN.md, AGENTS.md, DECISIONS.md, BRIEF.md, docs/API.md, docs/DEPLOY.md, docs/build-report.md, docs/shots/**, data/**,
README.md, package.json, demo.mjs, .gitignore. Merges each milestone after reading the diff, sends cross-reviews (sr2 reviews sr1's M1
against API.md before building M2; sr1 reviews sr2's M2 API calls read-only), runs `rig qa <sha>` on 7609 for the Worker suite, every
negative control and the Playwright suite, takes `pwshot` screenshots into `docs/shots/` from `npm run demo`, writes README / DEPLOY /
build report, pushes the private repo, closes the slice tabs by id, removes worktrees, writes the status file.

## Open questions
None blocking. Anything that needs Alexander goes under NEEDS ALEXANDER in the status file.
