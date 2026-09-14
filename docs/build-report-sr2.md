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
