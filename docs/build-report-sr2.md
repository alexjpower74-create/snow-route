# Build report: sr2 (driver offline, client status, owner side, Playwright)

Branch `rig/sr2`. Newest milestone at the bottom of each section. This file is a record: items are marked DONE or REJECTED in place.

## M1 — 2026-09-14

### What was built (DONE)

- **`app/public/theme.css` + `style.css`**: Design tokens exactly as PLAN.md (ground, surface, raised, action colours, status
  colours, amber SAMPLE outline, radius 14), system fonts only, everything quiet under `prefers-reduced-motion`.
- **`/` landing**: company name + SAMPLE badge from `GET /api/company`, "Owner sign-in" (links to `/owner/`, which is M2),
  and "Drivers and clients use the links the owner sends them."
- **`app/public/api.js`**: the only door to the Worker. Same-origin fetch; errors carry the API's `error` text as is; no signal
  is `ApiError` with code `network`. The driver check-in / photo / undo calls answer `{ status, data }` because the queue must
  tell 201, 200 duplicate, 409 and 5xx apart.
- **`app/public/api.mock.js` + generated `mock-data.js`** (`?mock=1`, development only): same shapes and error texts as API.md for
  company, driver route/check-ins/photo/undo and status. `app/tools/build-mock-data.mjs` copies the 25 SAMPLE clients from
  `data/sample-clients.json`. Demo keys: `demo-truck-1-sample`, `demo-truck-2-sample`, `demo-truck-3-sample` (no storm),
  `demo-status-sample-NN`. The mock answers "no signal" while `navigator.onLine` is false, so offline can be shown without the Worker.
- **Driver `/d/?k=`** (`d/driver.js`): loads `GET /api/driver/route`, caches it in `localStorage` `snow-route:route:<truck id>`
  (with the key, so the right copy is found offline), "No storm on right now", "Stop N of M", the next pending stop (name 36 px,
  address 22 px, priority and opening-time chips, notes 20 px in a raised amber-edged box), **Navigate** (Apple Maps on
  iPhone/iPad, Google Maps directions elsewhere, real link, `target="_blank"`), **Plowed** (label over
  `<input type=file accept=image/* capture=environment>`; `at` is taken the moment the photo is chosen, then a canvas downscale to
  ≤ 1600 px JPEG 0.7), **Plowed, no photo**, **Skip this stop** → sheet (Car in the way / Gate locked / Client cancelled / Other
  with an optional note). After any check-in the next stop shows at once and an **Undo** bar stays 15 s (queued → removed from the
  queue; sent → a queued DELETE). All stops listed below with status; skipped stops offer **Plowed now** (brings that stop back as
  the card). A "Not accepted" list shows refused items with the server's message and "Remove from this phone".
  A 700 ms lock after each check-in so a second glove tap cannot land on the next stop's button.
- **Offline queue `d/queue.js`**: IndexedDB `snow-route` / store `queue`. Every check-in is written there first (photo as bytes +
  type). The screen is route + queue. The sender goes oldest first; an item is removed only after 200/201 (then the photo is PUT and
  removed only after 200); 409 `already_plowed` and any other 4xx move it to `rejected` with the server's message; no signal, 5xx
  and 401 leave the queue untouched. Runs on each new check-in, `online`, `visibilitychange` → visible, and every 20 s while
  anything is queued, backing off 20 s → 40 s → … → 5 min after failures. An undo tapped while its check-in is in flight queues a
  DELETE once the server has it.
- **Sync strip** per Design: "All sent" or "No signal. 2 check-ins saved on this phone. They send when signal comes back and keep
  the time you tapped.", plus "Route saved on this phone at h:mm AM." when the screen is the saved copy.
- **Service worker `d/sw.js`** (scope `/d/`): caches the driver page, `driver.js`, `queue.js`, `theme.css`, `style.css`,
  `api.js`, `ui.js` on install (plus the mock files when present), serves them cache-first with a background refresh, and
  returns early for anything under `/api/`.
- **Client status `/s/?k=`**: one card (company + SAMPLE badge, address, the big answer: "On the route tonight. You're stop N." +
  "N stops are done so far.", "Plowed at 6:42 AM" + date + photo, "We couldn't clear it tonight: gate locked.", or "Not plowed yet
  this storm."). Polls every 60 s and on `visibilitychange`. A bad or missing key shows the API's plain 404 text with the badge.
  `<meta name="referrer" content="no-referrer">` on `/d/` and `/s/`.
- **`app/serve.mjs`**: dev server on 7601 (static `public/`, `/api/*` proxied to 7602; `ROOT=` serves a copy for controls).
- **Screenshots** (chromium, mock) in `app/tests/shots/`, each at 390 and 1280: `driver-storm`, `driver-no-storm`,
  `driver-skip-sheet`, `driver-offline`, `status-waiting`, `status-plowed`, plus `landing` and `status-bad-link`.

### How it was verified

`app/tests/shots-m1.mjs` (from `app/`: `node tests/shots-m1.mjs [--engine chromium|webkit|all]`), against the mock on the dev
server, because sr1's Worker is not merged yet. **It is not the M2 suite and it does not count as a Worker test.** Real input
only: every tap goes through `tap()`, which hit-tests the centre with `elementFromPoint` first; photos through the real file
chooser with a generated 1200 × 900 PNG; offline is `context.setOffline`; every request to a host other than 127.0.0.1 is
aborted and fails the scenario. Both engines, 390 and 1280:

| run | result |
|---|---|
| chromium-390 + chromium-1280 | **137 passed, 0 failed** |
| webkit-390 (iPhone 14) + webkit-1280 | **133 passed, 0 failed** |

It covers: badge + company name on every page; Stop 3 of 13; name ≥ 34 px; notes at 20 px; Navigate href exact for Google (chromium,
webkit-1280) and Apple (webkit iPhone); every driver button, sheet button, Undo and Plowed now ≥ 56 × 56; Plowed with a photo → the
next stop, Undo bar, row Plowed with a time and All sent; Undo of a sent check-in → the stop is back and the server has the undo;
skip sheet → Other opens the note → Gate locked → next; Plowed now on a skipped stop; **offline**: Plowed with a photo + Skip →
"No signal. 2 check-ins saved on this phone.", both rows marked saved, **reload while offline (chromium) → the service worker serves
the page and it still shows the route and 2 saved**, back online → All sent → a fresh load (waiting until it is not the saved copy)
shows both check-ins from the server; no storm; status waiting / plowed with the photo loaded / bad link; no horizontal scroll at 390.

**Checks that were wrong and got fixed while building** (each would have let a bug through):
- The "both check-ins reached the server" check read the list before the fresh route arrived, so it was reading the copy saved on
  the phone. Chromium passed on that; WebKit was slower and went red. Now it waits for the saved-copy note to go away and demands
  exactly 4 decided rows.
- A notes check had `|| true` on it. Replaced by a real visibility + 20 px assertion.

**Bugs the hit-test found in the app** (DONE, fixed):
- At 1280 × 800 the Undo bar was `position: fixed` at the bottom and sat on top of "Skip this stop": the next tap would have undone
  instead of skipped. The Undo bar is now inline above the stop, 76 px tall whether Undo is still offered or it has turned into
  "Last stop: …, plowed at 6:42 AM", so nothing moves under a glove when the 15 s run out.
- The sender re-rendered the stop card on every state change, replacing the buttons between a finger landing and the tap. Sections
  are now written only when their markup changes.

### Negative control (M1)

Queue: a copy of `app/public` in `app/.negative/m1-queue/` whose `queue.js` does `await remove(item.qid)` **before** the request
is sent, served on 7606, `shots-m1.mjs --only offline --engine chromium`. Recorded in `app/tests/negative-control.log`
(runs 1–3; run 1 also tripped over the re-render race above, runs 2–3 are clean). Run 3, the red output:

```
mock chromium-390 offline
  FAIL offline Plowed is kept on the phone and the next stop shows (counter still says Stop 3 of 12)
mock chromium-1280 offline
  FAIL offline Plowed is kept on the phone and the next stop shows (counter still says Stop 3 of 12)
0 passed, 2 failed
exit 1
```

The shipped `queue.js` has no switch for this; the break exists only in the git-ignored copy. The M2 controls (a) queue against
the real Worker, (b) time, (c) overlay are not done yet: they are M2.

### Left for later / not done

- **All Playwright specs against the real Worker, `playwright.config.mjs`, `start-worker.mjs`, the shared fixture, the tile
  placeholder**: M2, as the brief orders (sr1 M1 is not merged into this branch yet).
- **Offline reload on WebKit** was not tried in the M1 smoke; M2's `offline.spec.mjs` decides it, with a written reason if skipped.
- **`/owner/`** does not exist yet (M2), so the landing page's Owner sign-in link 404s until then.
- Leaflet is not copied into `app/public/vendor/leaflet/` yet: only the owner side uses a map (M2).
- A photo the browser cannot decode (for example HEIC on a desktop browser) is saved as "plowed with no photo", with a visible note
  saying so. A real iPhone camera hands the page a JPEG, so this should be rare.
- A void (undo) against a plowed stop that had an earlier skip shows "pending" on the phone until the route reloads (then the
  server's "skipped" shows). Cosmetic, and short-lived.

### For the lead / sr1

- **Question for the lead (not blocking):** API.md does not say whether a plowed check-in body should carry `reason` at all. The
  app sends `reason` only for skips (plowed bodies omit it). If sr1's Worker rejects a missing `reason` on plowed, that is a
  contract mismatch; I would rather the contract said "ignored for plowed".
- **For sr1:** the app matches `*_label` text with a plain space ("6:42 AM"). Node and both browsers here print a plain space,
  but some ICU versions print U+202F before AM/PM. If workerd's does, labels from the Worker will not equal the app's own queued
  labels (`timeLabel` in `ui.js` builds them from parts with a plain space).
- `rig guard --agent sr2`: ok, all inside the slice. This report is under `docs/` because the brief names that path.

## M2 — 2026-09-14

### Cross-review of sr1 M1 (read-only, `worker/src/index.js` at 110f190 against docs/API.md, from the app's side)

Read before writing M2. Checked: the JSON shapes the pages read (Company, Client, Truck, Stop, Checkin, Storm, the driver
route, client status), status codes, error texts and `field`, label format, headers, and the test routes.

Matches the contract (no action):
- Company, Client, Truck, Stop, Checkin and Storm views have every field API.md names, with the listed labels. Driver views
  carry no `messages`, prices or billing; owner storm views add `messages` with the exact templates.
- Labels are cleaned to a plain space before AM/PM (clarification 1): the app's own queued labels match them.
- Check-ins: 201 new, 200 `duplicate: true` for a known id whatever the body says (including a body that would be refused),
  409 `already_plowed` with `checkin`, 400 with `field` for id/kind/reason/note/at/has_photo, 404 for an unknown storm or a
  client that is not a stop. Accepted for an ended storm. The time window rule is as written. `reason` is stored null on plowed.
- Photo PUT: 415 before reading the body, 413 on Content-Length or actual size, 404 for another truck's check-in, a new token on
  every upload. Photo GET 404 for a voided check-in; SVG gets the CSP.
- Status: `tonight` only for an active storm that has the client; `stops_done` counts plowed + skipped on that truck; `last` is the
  latest non-voided plowed; no notes/price/trucks in the answer. Unknown key 404 with the contract's text.
- `sample` is derived from the name; `status_url`/`driver_url`/`photo_url` are absolute from the request origin.
- Every JSON answer carries `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `nosniff` (clarification 9).
- Owner 401 for a missing/expired token is "Please sign in again." (not in the table; the app shows it as is).

Mismatches and gaps (built against the contract anyway; for the lead to relay):
1. **`note` is stored on a plowed check-in.** Clarification 10 says `reason` *and* `note` are ignored on plowed; `checkinInput`
   keeps `note.trim()` for plowed too (only `reason` is nulled). The app sends no note on plowed, so nothing shows, but a plowed
   row can carry a note if another client sends one. Minor.
2. **500 text.** Clarification 6 gives `"Something went wrong on our side. Try again in a minute."`; the Worker answers
   `"Something went wrong on our side. Please try again."`. The app shows whatever comes back, so this is wording only.
3. **Not in the Worker yet (sr1 M2 by plan, noted so nobody reads a green run as coverage):** `DELETE /api/driver/checkins/:id`
   (undo), the sign-in and status-key rate guards (429), `PUT /api/owner/pin`, company PUT, reset-link, messages, trucks POST/PUT,
   route PUT, stops, end, summary, billing. The app's Undo on a *sent* check-in therefore gets 404 "There's nothing here." today,
   and per clarification 5 that undo lands in "Not accepted". `driver.spec.mjs` probes for the route and skips its Undo test with
   that reason until the route exists; it runs by itself once sr1 M2 is merged.
4. **Unknown check-in path shape.** The photo PUT route only matches a 36-character hex/hyphen id; a malformed id falls through to
   404 "There's nothing here." rather than "We couldn't find that check-in." Harmless for the app (it only sends its own UUIDs).
5. **`POST /api/test/storms/:id/end` accepts any `at`**, including one before `started_at`. Test-only; the app never calls it.

### What was built (DONE)

- **Contract changes taken in:** clarification 11 (a 429 is kept and retried; a photo refused 404/413/415 drops only the photo,
  removes the item and the stop's row says "Photo not sent: <server message>", never "Not accepted"), clarification 10 (the app
  already omitted `reason`/`note` on plowed), clarification 3 (the two test routes are used by the specs only).
- **Queue fix found by the suite:** signal coming back (`online`) now resets the backoff. Failed tries while offline had pushed
  the next try to 80 s, so a truck regaining signal waited for no reason.
- **Photo decode** uses `createImageBitmap(file)` first (no URL load), `<img>` as the fallback.
- **Owner `/owner/`** (`owner/index.html`, `owner/owner.js`, owner section of `style.css`), on sr1's M1 routes only:
  PIN sign-in (token in `localStorage` `snow-route:owner-token`, Sign out, any owner 401 returns to sign-in with the API's text);
  **Tonight**: "No storm on right now" → **Start a storm** → every active client and truck ticked, **Tick all / Untick all**, count →
  **Build tonight's route** → per-truck ordered stop lists with priority and status, the order note, and a map with each truck's
  line from the yard and numbered round pins coloured by status (refreshes every 30 s while shown); **Clients**: list with
  type / priority (+ opening time) / billing + price / truck / inactive chips, a map of every active client (tap a pin to edit),
  **Add a client** / **Edit** with the pin placed by tapping the map or dragging it, price typed in dollars, every API message shown
  by its field (the pin message by the pin); **Trucks**: each driver link with **Copy link** (falls back to selecting the link).
- **Leaflet 1.9.4** copied into `app/public/vendor/leaflet/` (js, css, images, LICENSE). Tiles are OpenStreetMap's standard
  tiles; attribution "© OpenStreetMap contributors" links to the copyright page and is always visible.
- **Playwright** (`app/playwright.config.mjs`): the four projects, `workers: 1`, `webServer` = `tests/start-worker.mjs` (fresh
  `app/tests/.state-<port>`, migrations, `wrangler dev --local` on 7603, inspector 7613, `--var TEST_MODE:1`, `E2E_WORKER_DIR`
  for copies). `tests/helpers.mjs`: auto fixtures (`seed` = `POST /api/test/reset` before every test; `guarded` = tiles answered by a
  generated 256 px PNG and any other non-127.0.0.1 request aborted and failing the test), `tap()` / `tapAt()` hit-testing the
  point with `elementFromPoint` before a real touch or click, typing via `page.keyboard`, photos through the real file chooser
  with a generated PNG, selects via `selectOption` only.
- **Specs:** `driver.spec.mjs`, `offline.spec.mjs`, `status.spec.mjs`, `owner.spec.mjs`, `targets.spec.mjs` as PLAN.md lists.
  Owner screenshots per project land in `app/tests/shots/<project>-*.png`.
- `app/package.json` scripts: `npm test` (the suite), `npm run negative` (controls a–c), `npm run dev` (serve.mjs on 7601).

### Verified (full suite, real Worker at the merged sr1 M1, all four projects)

`npx playwright test` from `app/`: **52 passed, 0 failed, 8 skipped (2.7 min).**

The 8 skips, each with its reason in the test:
- `driver.spec` "Undo on a check-in the server already has…" × 4 projects: it probes `DELETE /api/driver/checkins/:id` and skips
  while the Worker answers 404 "There's nothing here." (sr1 M2 route). It runs by itself once that route is merged.
- `targets.spec` "every driver button ≥ 56 px…" and "no horizontal scroll at 390" × the two 1280 projects: phone-width checks.

What each spec proves, and how it could have lied:
- **driver:** Stop 1 is the Worker's medical stop with the Medical chip; the Navigate `href` is exactly the Apple URL on the iPhone
  project and the Google URL elsewhere; Plowed with a generated photo → stop 2; Skip → Gate locked → stop 3; then through the
  owner API the plowed stop has `photo: "stored"` (and the photo URL serves `image/jpeg`), the skip has `reason_text` "Gate locked",
  and the database holds exactly two check-ins.
- **offline:** in Chromium, `context.setOffline(true)`, phone clock pinned at T (`clock.setFixedTime`), Plowed with a photo + Skip
  → "No signal. 2 check-ins saved on this phone. …", both rows marked saved, **0 rows in the database**; reload while offline →
  the service worker serves the page, the route (stop 3) and "2 saved" come back, "Route saved on this phone at …"; phone clock
  + 40 min and server `X-Test-Now` + 40 min, online → "All sent" → both rows have **`at` = T exactly**, `at_adjusted` 0,
  `received_at` = T + 40 min, the photo `stored`, the skip "Car in the way". **500 once:** the first POST after signal returns is
  answered 500 by `page.route` (Playwright's, not the Worker's; the Worker has no switch for it), the strip says "Could not send
  yet", exactly one POST was made and the database is empty; `clock.runFor(21 s)` → the sender's next try → All sent and 2 rows.
- **status:** the status page's "You're stop N" equals the number the driver's list shows for that client (stop 2, not stop 1,
  so an off-by-one shows); the driver plows stops 1 and 2 through the page; the open status page polls by itself
  (`clock.runFor(61 s)`, no reload) → "Plowed at <the check-in's at_label from the owner API>" and the photo decodes; bad link →
  the plain 404 text with the badge.
- **owner:** wrong PIN → the `POST /api/owner/signin` response is 401 (`waitForResponse`) and "That PIN is not right."; then
  sign in and out (token set, then gone). Add a client: 25 listed and 25 pins; Save with no pin → 400 and the API's "Put a pin on
  the map for this client." by the pin; a real tap on the map places the pin; Save → 26 in the list, a pin titled with the name on
  the map, the chips, and through the API `price_cents` 4250, `walkway`, lat/lng inside Grand Falls-Windsor. Start a storm:
  25 ticked, Untick all → 0, Tick all → 25, both trucks; build → on each truck stop 1 is medical and every medical stop is before
  every other; "Order is by distance, not road time."; 25 numbered pins; the attribution is visible, contains OpenStreetMap, links
  to the copyright page and hit-tests to itself. Trucks: both driver links match the reset answer; Copy link responds.
- **targets:** at 390 in both engines every driver button (Navigate, Plowed, Plowed no photo, Skip, the four reasons, Back, the
  note field, Skip with note, Undo, Plowed now, Back to the next stop) is ≥ 56 × 56 **and** hit-tests to itself; the SAMPLE badge
  and company name on `/`, `/owner/`, `/d/`, `/s/`; no horizontal scroll at 390 on landing, driver, status and all owner
  screens; Navigate / Plowed / Skip use the Design tokens and each pair is ≥ 4.5 : 1 (the contrast function is shown to go below
  4.5 on muted-on-amber); **the guard itself**: a fresh guarded context gets a tile answered locally (200 image/png) and a fetch
  to example.com is caught and recorded.

**WebKit and "no signal" (the written reason, PLAN allows skipping only the reload step):** a probe (`app/.negative/probe/`,
not shipped) shows that in Playwright's WebKit, once `context.setOffline(true)` is on, a file given to the file chooser cannot be
read at all: `createImageBitmap` throws InvalidStateError, `<img>` from a blob URL fails, and `file.arrayBuffer()` throws
NotReadableError, whether the file is a buffer or on disk and whether it was chosen before or after going offline. Online every
step works. A real iPhone's camera photo is on the phone and reads fine with no signal. So on **WebKit only**, "no signal" in
the first offline test is every `/api/*` request aborted at the network layer (`internetdisconnected`, which is what the queue
sees with no signal), the service worker is blocked for that test so the aborts apply, the send after signal returns comes from
the sender's own retry timer (no `online` event), and the offline-reload step is skipped with that reason as a test annotation.
The time, photo and database assertions are the same on both engines. The 500 test runs with the service worker blocked on every
project, because in WebKit a controlled page's `/api` fetches are made by the worker, where `page.route` cannot answer them.

**Checks that were wrong while building (fixed):** `clock.install` let the phone time run, so the tap was stamped T + 171 ms and
the at = T check failed for the wrong reason (now `setFixedTime`); the status test read the API while the photo check-in was still
being prepared (it now waits for stop 3); "Tick all" also matched "Untick all" (exact names); with the service worker blocked,
`serviceWorker.ready` never resolves (the setup no longer waits for it there).

### Negative controls (M2), final specs

Each control copies `app/public` + `worker` into `app/.negative/<name>/`, runs the spec against the **unbroken** copy on 7606
first (it must pass, else VOID), breaks the copy, runs again; exit 0 only if red. All three recorded in
`app/tests/negative-control.log` (an earlier run of each against the pre-WebKit-fix spec is also in the log, also red).

| control | break (copy only) | unbroken copy | broken copy, the red |
|---|---|---|---|
| (a) `tests/negative-queue.mjs` | `queue.js` removes the item from IndexedDB before sending | 1 passed | `#stop-name` expected "SAMPLE Pharmacy lot", received "Pat (SAMPLE)": the photo check-in made with no signal was gone from the phone before any server answered, so it never reached the server |
| (b) `tests/negative-time.mjs` | `queue.js` sends `at` = the phone clock at send time | 1 passed | "Pat (SAMPLE): at is the time the driver tapped, not the sync time", expected `2026-09-14T09:00:00.000Z`, received `2026-09-14T09:40:00.000Z` |
| (c) `tests/negative-overlay.mjs` | a transparent, full-size element over the Plowed button (still 76 px tall by its rectangle) | 1 passed | "Plowed: hit-tests to itself", received `<div class="negative-overlay" aria-hidden="true"></div>` |

### Left undone / for the lead

- Undo against a sent check-in is only exercised once sr1's `DELETE /api/driver/checkins/:id` is merged (the test skips itself
  until then; nothing to change on the app side).
- The owner side has no refresh when a driver checks in, other than Tonight's 30 s poll. Editing a storm, ending it, billing,
  settings, truck add/rename/new link: M3, as planned.
- `api.mock.js` covers only the driver and status routes (M1); the owner side has no mock, and the suite never uses the mock.
- The 500-once test uses Playwright's routing to produce the 500. The Worker has no switch to fail on demand, and adding one would
  put a test lever in shipped code.

## M3a — 2026-09-14 (review fixes only)

Merged main first (sr1 M2–M4, API.md clarifications 12–25). Code commit `38cc37e`.

### Fixed (DONE), each with the clarification and review item
1. **Clarification 25 / M2-2.** The Undo probe-and-skip is gone from `driver.spec.mjs`: the Undo test runs on all four projects and
   passes. The phone-width tests are tagged `@phone` and the 1280 projects filter them out (`grepInvert` in the config), so they are
   not counted as skipped. **The suite now has 0 skips.** The one WebKit limit left is a skipped *step* inside the offline test (the
   offline reload), written as a test annotation with its reason; the test itself runs and passes on WebKit.
2. **Clarifications 17 and 24 / R1, M2-5.** A 401 marks only that item's key dead and the sender goes on. When the page's route loads,
   the page tells the sender its key works and its truck; every check-in under a dead key is re-keyed to the page's key, and a photo or
   undo only when the dead key's truck (stored on each item as `truck_id`, falling back to the route saved with that key) is the page's
   truck. Otherwise it is marked stuck and listed with **Remove from this phone**, never sent. Items saved under another link of the same
   truck, and re-keyed items until they are sent, show in **Saved under an old driver link** ("Saved under an old driver link, sending
   with this one."). The strip shows the 401 text only when the page's own key is refused.
3. **Clarification 18 / R2, R3.** The status page shows its own bad-link text for any 404, clears its timer, and ignores
   `visibilitychange` until a reload.
4. **Clarification 19 / R4.** Undo on an item in Not accepted removes it from the phone only: no DELETE is queued and the refusal text
   is not replaced.
5. **Clarification 20 / R5.** Queued check-ins for a stop no longer on this route (moved truck, or another storm) show in **Saved for
   stops on another route** with the stop name, what and when, and an **Undo** (≥ 56 px) that takes it back the same way.
6. **Clarification 21 / M2-1.** `api.js`: an owner 401 **with** a `field` is thrown as a form error and keeps the session; only a 401
   without `field` clears the token and signs out. (No page calls `PUT /api/owner/pin` yet; Change PIN is M3b and its spec will cover a
   wrong current PIN.)
7. **Clarification 22 / M2-3.** A 409 `bad_state` on Build tonight's route closes the picker and shows the running storm with the API's
   message above it.
8. **Clarification 23 / M2-4.** Price accepts `45`, `45.5`, `45.50`, `.50`, `45.`, `$1,200.00`; anything else shows "Type a price in
   dollars and cents." by the field and nothing is sent.
9. **M2-6.** The faked 500 in `offline.spec.mjs` carries the Worker's text "Something went wrong on our side. Try again in a minute."

**A regression the suite caught while fixing R1 (DONE):** telling the sender "this key works" after every route load started an
immediate send, and a send requested during a failing send ran straight after it. The 500 test went red (2 POSTs where 1 was
expected): a route refresh was skipping the backoff. Now `setPage` sends at once only when it is news (the key just started working,
or dead-key items wait), and a send requested during a failed send waits for the backoff timer.

### New and changed tests
- `queue.spec.mjs` (service worker blocked, so `page.route` sees every `/api` request in both engines):
  - **link reset:** phone clock pinned at T, no signal, Plowed no photo + Skip → Gate locked, "2 saved"; the owner resets the truck's
    link through the API; with every check-in POST held by a gate, the phone opens the **new** link at T + 40 min: the route shows,
    **Saved under an old driver link** lists both stops, the strip has no dead-link text; release → All sent, the row is gone, the new
    key was used, and the database holds both rows with `at` = T, `received_at` = T + 40 min, `truck_id` = the truck, the skip "Gate locked".
  - **moved stop:** a queued Plowed; the owner moves that stop to the other truck (route PUT); with check-in POSTs failing at the
    network, the page reloads its route: the stop is off the list, **Saved for stops on another route** shows it "Plowed at 6:30 AM";
    Undo removes it; after sends are allowed again, the database has 0 rows.
  - **refused undo:** a queued Plowed; another check-in marks that stop plowed through the API; signal returns → Not accepted "This
    stop is already marked plowed."; Undo inside the 15 s → Not accepted gone, **no DELETE request**, the other check-in not voided.
- `status.spec.mjs` **trailing dot:** the Worker answers the key with a `.` 404; the page shows the bad-link text and the badge; after
  that, two tab returns make **no** status lookup. Headless Playwright never changes `visibilityState` on a tab switch (probed in
  chromium and webkit), so the test dispatches `visibilitychange` itself, and first proves that dispatch reaches the page: on a good
  link one dispatch makes exactly one more lookup. That in-test control is what stops "no lookup" from passing on a listener that is
  simply never called.
- `owner.spec.mjs`: **storm started elsewhere** (picker open, a storm started through the API, Build → the 409 response's `error`
  shown in `#storm-notice`, picker gone, the storm lists and order note shown); **price input** (`4.5.0` → the message and no PUT;
  `.50` → 50 cents; `45.` → 4500 cents, through the API).

### Verified
Full suite against the merged Worker, all four projects: **80 passed, 0 failed, 0 skipped (3.2 min).**

### Negative controls, run last this turn (7606 was free), all on the final code
Each passes on its unbroken copy first, then goes red on the break (`app/tests/negative-control.log`, entries from 09:26Z):

| control | break (copy only) | red |
|---|---|---|
| (a) queue | removes the item before sending | `#stop-name` expected "SAMPLE Pharmacy lot", received "Pat (SAMPLE)" |
| (b) time | sends `at` = phone clock at send time | expected `2026-09-14T09:00:00.000Z`, received `2026-09-14T09:40:00.000Z` |
| (c) overlay | transparent element over Plowed | "Plowed: hit-tests to itself", received the overlay `<div>` |
| **(d) relink** (`tests/negative-relink.mjs`) | the sender stops the whole queue on a 401, as in M1 | expected "All sent", received "This driver link doesn't work any more. Ask the owner for a new one. 2 items still saved on this phone." |

### Left undone / for the lead
- Clarification 21 has no page yet to exercise it (Change PIN is M3b); the `api.js` rule is in place and M3b's settings spec will
  test a wrong current PIN staying on the form.
- The in-test proof that `visibilitychange` reaches the status page uses a dispatched event, because headless Playwright cannot
  produce a real one. A real phone switching tabs fires the same event.

## M3b — 2026-09-14

Merged main first (sr1 M5). In-progress commit `7a9876c` (route editing and End storm, for sr1's early review); code `7774fa4`;
the phone tab fix and this report in the final commit.

### Built (DONE)
- **Tonight.** Each stop has a drag handle (pointer events with pointer capture, `touch-action: none`, a drop line showing where it
  lands, across trucks too), **Move up / Move down** (disabled at the ends), and **Move to <other truck>**. Every change goes through
  `PUT /route`; a 409 (or a 400 on `trucks`, the stop set changed) reloads the storm and shows the API's message above it.
  **Add a stop** (client and truck selects, appended by the Worker). **Texts to copy** per stop from its `messages` (clipboard, then
  "Copied"; if the browser refuses, the text is shown to select). **End storm** with an inline confirm ("Keep it going" / "Yes, end
  the storm"), then the **summary** at `#storm/<id>`: tiles (stops, plowed, skipped, not reached, pushes to bill), a per-truck
  table (plowed, skipped, not reached, first and last check-in), skipped stops with reason, time and a copy button for the
  "skipped" text, and the not-reached list. **Past storms** under Tonight open their summaries. The storm view refreshes every 30 s,
  except while a confirm, a form, a drag, a save or an open text list is on screen.
- **Trucks.** Add, Rename (inline form), Deactivate / Make active again, driver link with Copy link, **New link** with an inline
  confirm that says the old link stops working at once (and that check-ins saved under it send when the new link is opened).
- **Clients.** In the edit form: the status link, its "status link" text with **Copy status text**, **New status link** with an
  inline confirm, and **Deactivate client** / Make active again (the active checkbox is gone; one clear button instead).
- **Billing.** Month select from `/billing/months` plus the current NL month (months without pushes say so), opening on the newest
  month with pushes; table of client, billing, pushes, push dates, price, amount, HST, total with a totals row; the seasonal note;
  **Download CSV for the accountant** (fetch with the token, then a blob download named from `Content-Disposition`). The pushes cell
  is `pushesOf(row)`, which returns the API row's count and nothing else.
- **Settings.** Company name, yard name, the yard pin (tap the map or drag), Save; **Change PIN** (current, new). A 401 with
  `field: current` is shown by that field and the owner stays signed in; a 429 is a message on the form (clarification 21).
- **Design fixes from the lead's screenshots.** (1) At ≥ 900 px the map column is `align-self: start; position: sticky; top: 16px`
  with a viewport-based height, so it stays on screen while the list scrolls. (2) Medical client pins were red (`#f87171`, not a
  token): they are now white (`--text`) with an ice-blue ring, other clients ice blue (`--accent`), and the Clients map has a legend
  (Client, Medical client (goes first), Yard). Truck lines now use tokens too (ice blue, white, grey) and the Tonight legend names them.
- **Layout bugs the final screenshots showed (fixed):** table number cells used the class `.num`, which is also the round stop-number
  badge, so billing and summary numbers drew as overlapping circles; they are `.cell-num` now. At 390 the five owner tabs did not fit
  and scrolled "Tonight" out of sight; below 520 px they wrap onto two rows.

### Specs (all against the real Worker)
- `route-edit.spec.mjs`: **@desktop** a real `page.mouse` drag of stop 3's handle (hit-tested first) above stop 1 → the PUT answers
  200, the list and the Worker have `[3, 1, 2, …]`, a reload keeps it, and the driver page shows that stop as Stop 1. **@phone** Move up
  and Move down (each checked through the API), then Move to Truck 2 → last on truck 2, and both drivers' pages agree. A stop added
  through the API from "another screen" → a Move up built from the old list is refused, the page shows the Worker's message and the
  reloaded route has the added stop. Add a stop through the page → last on the chosen truck.
- `storm-end.spec.mjs`: one plowed and one "Gate locked" skip arranged through the driver API; End storm → Keep it going (still on)
  → End storm → Yes → the summary: the skip with "Gate locked at <the API's at_label>" and its copy button, not reached = stops − 2
  (count and list), plowed 1, the truck row 1 / 1 / 11; the driver page says "No storm on right now"; Back to Tonight → Past storms
  lists it and reopens the summary.
- `billing.spec.mjs`: a storm with Pat ($45 per push), SAMPLE Clinic walkway ($50 per push) and Taylor (seasonal) on truck 1; the
  driver page plows the first two and skips Taylor; the owner page ends the storm and opens Billing. Checked: the select opens on
  the newest month with pushes; the API's rows against the rule written out in the test (amount = pushes × price, HST
  `floor((amount × 15 + 50) / 100)`, seasonal 0, totals); **every** API row against its table row, cell by cell; Taylor's pushes
  **0** and no dates; the totals row; the seasonal note; the CSV download's filename, CRLF, header, and every CSV row against the
  table row, plus the total row.
- `copy.spec.mjs`: a stop's "on the route" text and a client's status text → "Copied" and, in Chromium (clipboard permissions
  granted), the clipboard holds the exact API text. **WebKit:** "Copied" is checked and only the clipboard read is skipped, as a
  test annotation: Playwright cannot grant clipboard-read in WebKit.
- `settings.spec.mjs`: wrong current PIN → the PUT answers 401, "That PIN is not right." by the field, no form-wide error, still
  signed in (token kept, Clients loads 25); right PIN → 204 and the message; sign out; the old PIN is refused and the new PIN signs in.
  Five wrong tries → the sixth answers 429 → "Too many tries. Wait 15 minutes and try again." on the form, still signed in. Company
  name, yard name and a yard pin tapped on the map save, the bar shows the new name (still SAMPLE), and the API has the new yard.
- `owner.spec.mjs` adds **@desktop** "the map stays on screen": after real wheel scrolling past 1500 px, the map's box is inside the
  viewport, hit-tests to itself, and its attribution is in view; the Clients legend has its three entries, the medical pin is
  `rgb(238, 243, 251)`, the other pins `rgb(124, 196, 255)`, and the legend dot matches the pin.
- `shots.spec.mjs`: every screen for each project on the Worker's demo seed, each checked for its key element before the picture
  (landing, sign-in, Tonight, Tonight with a stop's texts open and Add a stop, End storm confirm, Clients, client edit with the status
  link, Trucks with the New link confirm, Billing, Settings, a past storm's summary, Tonight with no storm and past storms, Start a
  storm, driver, driver skip sheet, client status). 96 files in `app/tests/shots/`.
- Project filtering: `@phone` tests are not run by the 1280 projects and `@desktop` tests are not run by the 390 projects
  (`grepInvert`), so nothing is reported as skipped.

### Verified
Full suite, four projects, on the final code: **122 passed, 0 failed, 0 skipped (4.9 min).**

### Negative controls, run last (7606 free), on the final code
Each passes on its unbroken copy first, then goes red on the break (`app/tests/negative-control.log`):

| control | break (copy only) | red |
|---|---|---|
| (a) queue | removes the item before sending | expected "SAMPLE Pharmacy lot", received "Pat (SAMPLE)" |
| (b) time | sends `at` = phone clock at send time | expected `…09:00:00.000Z`, received `…09:40:00.000Z` |
| (c) overlay | transparent element over Plowed | "Plowed: hit-tests to itself", received the overlay `<div>` |
| (d) relink | stops the whole queue on a 401 | expected "All sent", received "This driver link doesn't work any more. … 2 items still saved on this phone." |
| **(e) billing** (`tests/negative-billing.mjs`) | the billing screen shows pushes as the client's storm-stop count, not the API row | "Taylor (SAMPLE): pushes", expected "0", received "1" |

### Left undone / for the lead
- Removing a stop from a storm (`DELETE …/stops/:client_id`) has no button: PLAN lists "Add a stop" only.
- Drag to reorder does not scroll the page while dragging; a stop far down a long list is moved with Move up / Move down, or by
  dragging in steps. Both are real input and both are tested.
- The summary's copy buttons come from the storm view's `messages` (the summary JSON has no messages), so a past storm's summary makes
  two requests.

## M3c — 2026-09-14 (review fixes only)

Merged main first (sr1 M6: `route_version`, `yard.label` / `yard.pin`; API.md clarifications 26–37). Commits: `0994459` (steps 1–2,
committed as soon as they were green), `5fb04e6` (steps 3–11), and the final commit with this report and control (h).

### Fixed (DONE), most harmful first
1. **Clarification 26 / M3a-1: two tabs can no longer void a push.** Undo is an explicit mark: the driver's Undo sets an unsent item
   to `undone` inside one IndexedDB readwrite transaction (`queue.update`). After a 200/201 the sender decides from the item as it is
   **now**, in the same kind of transaction: missing means another tab sent it (nothing happens), `undone` means the driver tapped Undo
   while it was on its way (a DELETE is queued), otherwise the photo goes next or the item is removed. `undone` items the sender never
   sent are deleted at the top of each send loop, inside the lock. Every send loop runs inside
   `navigator.locks.request('snow-route-send', …)`, so two tabs never send at once. Undo on a sent check-in (item gone) still queues
   the DELETE, from what the screen last knew about it.
2. **Clarification 32:** the route PUT carries the `route_version` of the Storm on screen. A 409 reloads the storm and shows the message.
   `route-edit.spec` now requires **409, `bad_state` and the exact text** "The route changed while you were editing it. Reload and try
   again." for a stale edit (a stop added through the API between loading and editing); `[400, 409]` is gone.
3. **Clarification 27 / M3a-2:** every queued item carries `truck_id`, including the undo the sender makes itself (from the item, or
   the key store). Keys map to trucks in `localStorage` `snow-route:keys`, written when a route loads and never overwritten for another
   key.
4. **Clarification 29 / M3a-4:** tested and controlled (below).
5. **Clarification 34 / M3b-2:** Pat's price is set to 3550 through the API before the storm; the spec asserts HST `$5.33` and every
   money cell equal to the API row. **See the note on control (h): the named break cannot go red.**
6. **Clarification 35 / M3b-3:** the downloaded CSV's bytes are compared with `GET /api/owner/billing.csv` fetched with the token.
7. **Clarification 28 / M3a-3:** queued check-ins from a storm that has ended (or an earlier storm) are listed under "Saved from the storm
   that ended, still sending", separate from stops moved to another route. An Undo that would delete a check-in that has not been sent
   asks first: "This check-in has not reached the office yet. Delete it from this phone?" (Delete it / Keep it, both ≥ 56 px), in the
   Undo bar and in those lists. A refused (Not accepted) item and a sent check-in do not ask.
8. **Clarification 36 / M3b-5, M3b-6:** a 409 from End storm closes the confirm and opens that storm's summary with the API's message;
   from Add a stop or a route edit it closes the form and repaints Tonight with the message. "Past storms" is a link (`#past`) while a
   storm is on.
9. **Clarification 37 / M3b-7:** "Remove from tonight" on stops with no check-in, behind an inline confirm, calling
   `DELETE …/stops/:client_id`. A 409 reloads the storm: if it ended, Tonight repaints with the message; otherwise the message shows on
   that stop (and its Remove button is gone because it now has a check-in).
10. **Clarification 33:** `yard.label` errors show under the yard name, `yard.pin` errors under the map.
11. **Clarifications 30 and 31 / M3a-5, -6, -7:** a photo refused for a stop not on this route keeps a "Photo not sent: <message>" row
    (with the stop name) under "Saved for stops on another route" until Dismiss; a "storm already on" notice is dropped when Tonight
    finds no storm; a re-keyed check-in for another route is listed once there, with "Moved from an old driver link.".

### New and changed tests
- `queue.spec.mjs`:
  - **two open tabs** (26): tab 1 plows a stop while every check-in POST is held; tab 2 of the same link is reloaded so its sender
    starts on the shared queue; release → both tabs "All sent", **one** stored check-in, **not voided**, **no DELETE**, and one POST
    (the lock);
  - **cross-truck** (29): tab 1 of truck 1's link plows stop 1 (sent), tab 2 of the same link plows stop 2 with a photo (the check-in is
    sent, the photo held back), tab 1 undoes stop 1 (sent, so no question; the DELETE held back); the owner resets truck 1's link;
    truck 2's link is opened with nothing held back → both rows say "This photo / undo belongs to another truck's link, so this link
    cannot send it.", no PUT or DELETE under truck 2's key, stop 1 not voided, stop 2's photo still `waiting`;
  - **ended storm** (28): a queued check-in, the owner ends the storm, the page shows "No storm on right now" and the check-in under
    "Saved from the storm that ended, still sending" (not "moved"); Undo asks, Keep it keeps it; it then sends and is stored, not voided;
  - **photo refused for a moved stop** (30): the photo PUT answers the Worker's own 413 text (fulfilled locally: the page downscales
    photos, so a real one never gets that big), the stop moves to the other truck, the page reloads → the "Photo not sent" row is there
    and Dismiss removes it;
  - the moved-stop test now confirms its Undo (Delete it) and sends `route_version` with its route PUT.
- `route-edit.spec.mjs`: exact 409 for a stale edit (above); **Remove from tonight** (a stop with a check-in has no Remove; Keep it;
  Yes → gone from the owner list, the Worker and the driver page; a check-in landing after the button was shown → the DELETE answers
  409 and the API's message shows on that stop, with no Remove after the reload).
- `storm-end.spec.mjs`: End storm answered 409 because another screen ended it → that storm's summary with the message, confirm gone;
  Add a stop answered 409 because the storm ended → "No storm on right now" with the message, form gone; Past storms during a storm
  opens the list (ended storms only) and a summary.
- `billing.spec.mjs`: Pat at $35.50, HST cell `$5.33`, every money cell equal to the API row, CSV bytes equal to the Worker's.
- `settings.spec.mjs`: an empty yard name → the error by the yard name, none by the map; the map zoomed right out with its own control and
  a pin tapped far west → 400 `field: yard.pin` and the error by the map, none by the yard name.

**Test mistakes caught while writing (fixed):** a route pattern `…/checkins/*` matched the undo's DELETE but not the photo's PUT
(`/checkins/<id>/photo`), so the "photo waits" step failed for the wrong reason; after Save, typing without tapping the yard name left
it empty; an apostrophe inside a single-quoted assertion message broke `billing.spec`'s syntax.

### Verified
Full suite on the final code, all four projects: **158 passed, 0 failed, 0 skipped (8.8 min).** Steps 1–2 were also run by themselves
on webkit-390 and webkit-1280 before the first commit (22 passed).

### Negative controls, run last (7606 free), on the final code

| control | break (copy only) | red |
|---|---|---|
| (a) queue | removes the item before sending | expected "SAMPLE Clinic walkway", received "Pat (SAMPLE)" |
| (b) time | sends `at` = phone clock at send time | expected `…09:00:00.000Z`, received `…09:40:00.000Z` |
| (c) overlay | transparent element over Plowed | "Plowed: hit-tests to itself", received the overlay `<div>` |
| (d) relink | stops the whole queue on a 401 | expected "All sent", received the dead-link text with "2 items still saved" |
| (e) billing | pushes from the storm-stop count | "Taylor (SAMPLE): pushes", expected "0", received "1" |
| **(f) twotabs** | a missing item after 200/201 read as undone, and no Web Lock | "the push was not voided", received `voided_at` `2026-09-14T09:00:00.000Z` |
| **(g) crosstruck** | photos and undos re-keyed across trucks (no truck comparison) | the two "another truck's link" rows: expected 2, received 0 (both were sent under truck 2's key and refused) |
| **(h) hst** | the page shows HST as `Math.floor(amount * 0.15)` | "$5.33" expected, "$5.32" received |

### For the lead: clarification 34's break cannot go red (decide)
Clarification 34 (and sr1's M3b-2) names the break `Math.round(amount * 0.15)`, on the premise that `3550 * 0.15` is `532.4999…`. In
JavaScript it is exactly `532.5`, so `Math.round` gives **533**, the same as the rule. I ran that control first: **GREEN**, recorded
in `negative-control.log`. A search over every amount from 1 to 1,000,000 cents found **no** amount where
`Math.round(amount * 0.15)` differs from `Math.floor((amount * 15 + 50) / 100)`, so no price can make that break visible. Control (h)
therefore uses a page that **truncates** (`Math.floor(amount * 0.15)`, $5.32), which the $35.50 data does expose, with the reason in
the control's header. The spec's data and assertions are as clarification 34 says. If you want a different recomputation as the
control, say which; the clarification's wording should change either way.

### Left undone / for the lead
- The two-tab test proves the lock and the explicit undo together; each alone would also close the path (DECISIONS 41), and control (f)
  removes both at once as asked, so there is no separate control for each half.
- A photo refused for a stop that is still on this route shows on that stop's row, as before; only off-route refusals get the
  dismissable row.
- Browsers without Web Locks (Safari before 15.4) send without the lock; the explicit undo mark still stops the voided-push path there.

## M3d — 2026-09-14 (review fixes only, short)

Merged main (clarifications 38–41). Code commit `aa04bba`.

### Fixed (DONE)
1. **38, a tapped Undo is never lost.** The sender writes `attempted: true` (one IndexedDB transaction) before a POST leaves, only
   while `navigator.onLine`. An `undone` item never attempted is deleted with no DELETE; an attempted one always becomes a DELETE,
   whichever sender finds it. A DELETE answering 404 is removed quietly. The confirm reads "It may already be at the office. Undo
   it?" (Undo it) for an attempted item, otherwise "This check-in has not reached the office yet. Delete it from this phone?"
   (Delete it). The strip keeps counting an attempted undo until its DELETE is done.
2. **41.** The two-tab test also runs with `navigator.locks` removed through `addInitScript` (one stored push, not voided, no
   DELETE; up to two POSTs).
3. **39.** `AbortSignal.timeout(30000)` on every driver call; a timeout (also while reading the body) is a network failure. A tab
   that is not visible asks for the send lock with `{ ifAvailable: true }` and skips the pass if another tab holds it.
   **Timeout test (honest, no switch in the app):** `@phone` projects only. A POST route that never answers; the strip shows
   "Sending…", then "No signal. 1 check-in saved…" after ≥ 29 s of real time; signal "comes back" and the check-in is stored,
   not voided. The page clock cannot drive it: `AbortSignal.timeout` runs on the browser's own timer, not the page's `setTimeout`,
   so the test waits the real 30 s. The `ifAvailable` branch has no test (headless Playwright never reports a page as not visible).
4. **40.** The owner's refresh counts edits started on the screen (save, drag, add, remove) and drops an answer if one started
   while it was on its way, or if its `route_version` is lower than the one on screen.

### Specs
- `queue.spec.mjs`: **answer lost** (the Worker stores the POST through `route.fetch()`, the page's response is aborted; Undo →
  the attempted question → Undo it → the database shows the check-in voided); **tried but never stored** (Undo → the DELETE
  answers 404 → no "Not accepted", nothing stored); **two tabs without Web Locks**; **POST that never answers** (above).
  The moved-stop and ended-storm tests now see an attempted item, so they expect the attempted wording.
- `route-edit.spec.mjs`: the 30 s refresh fires (`page.clock.runFor`), its GET is answered by the Worker at once and held; a Move
  answers 200; the held (older) answer is released and dropped; the moved order stays; the next Move answers 200, not 409.

**Test mistakes caught (fixed):** an assertion that the strip must not say "All sent" right after Undo raced a fast, correct app
(a debug run at 1280 showed the DELETE answered 200 about 250 ms after the tap); the spec now polls the database for `voided_at`.
A replacement string containing `$'` in a JavaScript `String.replace` mangled control (f)'s file; it was rewritten.

### Verified
Full suite, four projects, final code: **176 passed, 0 failed, 0 skipped (10.1 min).**

### Negative controls, run last (7606 free), on the final code
Each passes on its unbroken copy first, then goes red on the break (`app/tests/negative-control.log`, 10:51–10:56Z).

| control | break (copy only) | red |
|---|---|---|
| (a) queue | removes the item before sending | expected "SAMPLE Clinic walkway", received "Pat (SAMPLE)" |
| (b) time | `at` = phone clock at send time | expected `…09:00:00.000Z`, received `…09:40:00.000Z` |
| (c) overlay | transparent element over Plowed | "Plowed: hit-tests to itself", received the overlay |
| (d) relink | whole queue stops on a 401 | expected "All sent", received the dead-link text |
| (e) billing | pushes from the storm-stop count | Taylor pushes expected "0", received "1" |
| (f) twotabs | missing read as undone and no lock (with-locks run) | "the push was not voided", received a `voided_at` |
| (g) crosstruck | photos and undos re-keyed across trucks | "another truck's link" rows expected 2, received 0 |
| (h) hst | page shows `Math.floor(amount * 0.15)` | expected "$5.33", received "$5.32" |
| **(i) attempted** | an undone item is deleted with no DELETE even when attempted | "the tapped Undo reached the Worker: the push is voided", received `null` |
| **(j) missingundo** | only "missing after 200/201 means undone" (lock code untouched), no-locks run | "the push was not voided", received a `voided_at` |
