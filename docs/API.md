# Snow Route: API contract (v1)

The contract between the Worker slice (sr1) and the app slice (sr2). If the code and this file disagree, this file wins
until the lead changes it. Written by the lead 2026-09-14. Clarifications are appended at the bottom, numbered.

One Worker `snow-route` serves the API under `/api/*` (Worker first) and the static app from `app/public/` (same origin,
no CORS). Local only tonight: `wrangler dev --local`. One deployment = one contractor.

## Conventions

JSON in, JSON out. Errors are always `{ "error": "<plain English>", "code": "<machine code>", "field"?: "<input name>" }`.

| code | HTTP | when |
|---|---|---|
| `bad_request` | 400 | validation; `field` names the input |
| `unauthorized` | 401 | missing/expired owner token, wrong PIN, unknown or reset driver key |
| `not_found` | 404 | unknown id, status key, photo, or a client that is not a stop in that storm |
| `bad_state` | 409 | a storm is already on; editing an ended storm; undo too late; removing a stop that has check-ins |
| `already_plowed` | 409 | a second plowed (or a skip) for a stop that already has a plowed check-in; body has `checkin` |
| `too_large` | 413 | photo over 5 000 000 bytes |
| `unsupported_photo` | 415 | photo not `image/jpeg`, `image/png` or `image/webp` |
| `rate_limited` | 429 | too many PIN tries or unknown status-link lookups |

- **Ids.** Clients, trucks and storms have integer `id`s. Check-in ids are **client-generated UUID v4 strings**: the id is
  the idempotency key that lets a phone resend a check-in safely.
- **Money** is integer cents everywhere. `hst_rate` is `0.15`.
- **Instants** are ISO 8601 UTC (`2026-01-12T10:42:00.000Z`). Every instant a person reads has a `*_label` beside it in
  NL time (`America/St_Johns`): a time label is `Intl.DateTimeFormat('en-US', { timeZone: 'America/St_Johns', hour: 'numeric',
  minute: '2-digit' })` → `"6:42 AM"`; a date label adds `weekday: 'short', month: 'short', day: 'numeric'` → `"Mon Jan 12"`;
  a full label is `"Mon Jan 12, 6:42 AM"`. The app formats a check-in that is still queued on the phone with the same call and
  the company's `timezone`, never the phone's own zone.
- **Keys.** Owner session tokens are hashed at rest (SHA-256). Driver keys and client status keys are ≥ 128 random bits,
  base64url, and stored as is, because the owner needs to copy the same link again (DECISIONS.md 4). The PIN is PBKDF2-SHA256
  (100 000 iterations, the Workers maximum) with a random salt.
- **Absolute links.** `status_url`, `driver_url` and `photo_url` are absolute, built from the request's origin
  (`new URL(request.url).origin`), so they work on whatever host serves the Worker.
- **Keys in URLs.** `/api/driver/*`, `/api/status/*` and `/api/photos/*` responses carry `Referrer-Policy: no-referrer` and
  `Cache-Control: no-store` (photos: `private, max-age=86400`). The `/d/` and `/s/` pages set `<meta name="referrer" content="no-referrer">`.
- **Test mode.** Only when the Worker has var `TEST_MODE=1` (never in production): request header `X-Test-Now: <ISO instant>`
  replaces server "now", `X-Test-IP: <string>` replaces the client IP for rate limits, and `/api/test/*` exist. Without
  `TEST_MODE=1` both headers are ignored and `/api/test/*` answers 404.

## Objects

**Company**
```json
{ "name": "SAMPLE Snow Clearing — Grand Falls-Windsor (demo)", "sample": true, "timezone": "America/St_Johns",
  "hst_rate": 0.15, "yard": { "label": "SAMPLE yard, Mill Road", "lat": 48.94346, "lng": -55.67465 } }
```
`sample` is `true` while the name contains `SAMPLE`. The app shows a SAMPLE badge on every screen while it is true.

**Client** (owner view)
```json
{ "id": 3, "name": "Sam (SAMPLE)", "address": "Harris Avenue, Grand Falls-Windsor, NL", "lat": 48.94434, "lng": -55.64701,
  "type": "driveway", "type_label": "Driveway", "priority": "none", "priority_label": "None", "opens_at": null,
  "notes": "Gate on left, don't pile by the hydrant.", "billing": "seasonal", "price_cents": 55000, "truck_id": 1,
  "active": true, "status_url": "http://127.0.0.1:7602/s/?k=…",
  "last_plowed_at": "2026-01-12T10:42:00.000Z", "last_plowed_label": "Mon Jan 12, 6:42 AM" }
```
- `type`: `driveway` "Driveway" · `lot` "Parking lot" · `walkway` "Walkway".
- `priority`: `medical` "Medical" · `commuter` "Early commuter" · `business` "Business opening" · `none` "None".
- `opens_at`: `HH:MM` (24 h) or `null`. Meant for `business`, allowed on any client, shown at the stop.
- `billing`: `per_push` "Per push" · `seasonal` "Seasonal contract". `price_cents` is the price per push, or the whole season's price.
- `truck_id`: the truck that normally does this client, or `null`.
- `last_plowed_*`: the latest non-voided plowed check-in in any storm, or `null`.

Client input (POST and PUT, all fields required on PUT): `name, address, lat, lng, type, priority, opens_at, notes, billing,
price_cents, truck_id, active` (`active` defaults to `true` on POST; `notes` and `opens_at` may be omitted on POST).
Validation → 400 `bad_request` with `field`:

| field | rule | message |
|---|---|---|
| name | 1–80 characters after trimming | "Give the client a name." / "Keep the name under 80 characters." |
| address | 1–160 characters after trimming | "Type the address the driver should look for." |
| lat, lng | numbers, lat 46.5–60.5 and lng −67.9 to −52.5 (Newfoundland and Labrador) | "Put a pin on the map for this client." (field `lat`) |
| type, priority, billing | one of the listed values | "Pick a type." / "Pick a priority." / "Pick how this client is billed." |
| opens_at | `HH:MM` 24 h (`00:00`–`23:59`) or null | "Opening time looks like 7:30 — use the time picker." |
| notes | ≤ 300 characters | "Keep the notes under 300 characters." |
| price_cents | integer 0–10 000 000 | "Type a price in dollars and cents." |
| truck_id | null or an existing truck | "Pick one of your trucks." |

**Truck**
```json
{ "id": 1, "name": "Truck 1 (SAMPLE)", "active": true, "driver_url": "http://127.0.0.1:7602/d/?k=…" }
```
`name` 1–40 characters.

**Checkin**
```json
{ "id": "6f1c2a3e-…", "storm_id": 7, "client_id": 3, "truck_id": 1, "kind": "plowed",
  "reason": null, "reason_text": null, "note": "",
  "at": "2026-01-12T10:42:00.000Z", "at_label": "6:42 AM", "at_adjusted": false, "received_at": "2026-01-12T11:20:05.000Z",
  "photo": "stored", "photo_url": "http://127.0.0.1:7602/api/photos/…", "voided": false }
```
- `kind`: `plowed` | `skipped`. `reason` (skipped only): `car` "Car in the way" · `gate` "Gate locked" · `cancelled`
  "Client cancelled" · `other` "Other". With a note, `reason_text` is `"Other: <note>"` for `other`, else the label alone.
- `photo`: `none` (sent with `has_photo: false`) · `waiting` (`has_photo: true`, bytes not uploaded yet) · `stored`.
  `photo_url` is non-null only when `stored`.

**Stop** (one client in one storm)
```json
{ "client_id": 3, "truck_id": 1, "position": 4, "name": "Sam (SAMPLE)", "address": "…", "lat": 48.94434, "lng": -55.64701,
  "type": "driveway", "type_label": "Driveway", "priority": "none", "priority_label": "None", "opens_at": null,
  "notes": "…", "status": "pending", "checkin": null }
```
- `position` is 1-based within its truck, contiguous.
- `status`: `plowed` if the stop has a non-voided plowed check-in; else `skipped` if it has a non-voided skipped one; else `pending`.
- `checkin`: the check-in that decided the status (the plowed one, else the latest skipped one), or `null`.
- Owner views add `"messages": [Message]` (below) to each stop. Driver views never include messages, prices or billing.

**Storm**
```json
{ "id": 7, "name": "Storm of Mon Jan 12", "status": "active", "started_at": "…", "started_label": "Mon Jan 12, 4:05 AM",
  "ended_at": null, "ended_label": null, "order_note": "Order is by distance, not road time.",
  "counts": { "stops": 25, "plowed": 9, "skipped": 1, "pending": 15 },
  "trucks": [ { "id": 1, "name": "Truck 1 (SAMPLE)", "stops": [ "Stop…" ] } ] }
```

**Message** (copy-this-text; nothing is ever sent by the app)
```json
{ "kind": "on_route", "label": "Copy \"on the route\" text", "text": "Hi Sam (SAMPLE), we're out clearing snow tonight. …" }
```
Exact templates (`{type}` = `driveway` / `parking lot` / `walkway`; `{company}` = company name):
- `status_link` "Copy status link text" (always): `Hi {name}, this is {company}. You can check when your {type} was last cleared here: {status_url}`
- `on_route` "Copy \"on the route\" text" (stop pending in the active storm): `Hi {name}, we're out clearing snow tonight. You're stop {position} on the route. This link shows the time and a photo once it's done: {status_url}`
- `plowed` "Copy \"done\" text" (stop plowed): `Hi {name}, your {type} was cleared at {at_label}. See it here: {status_url}`
- `skipped` "Copy \"skipped\" text" (stop skipped): `Hi {name}, we couldn't clear your {type} tonight: {reason_text, first letter lower-cased}. We'll be in touch about it.`

## Route building (sr1, pure functions in `worker/src/route.js`)

1. **Distance** is the haversine distance in metres on a sphere of radius 6 371 008.8 m. Straight line, never road time.
2. **Tiers.** Tier 0 = `medical`; tier 1 = `commuter` and `business`; tier 2 = `none`. Every tier-0 stop comes before every
   tier-1 stop, which comes before every tier-2 stop.
3. **Within a tier:** nearest neighbour from the current point (the yard for the first non-empty tier, otherwise the last stop
   of the previous non-empty tier), ties broken by the lower `client_id`; then **2-opt** on that tier's open path (start point
   fixed, end free), repeated until no segment reversal shortens the path by more than 0.5 m, at most 200 passes.
4. **Deterministic:** the same input always gives the same order.
5. **Truck assignment** at storm start: a client goes to its `truck_id` when that truck is in the storm. The others (no truck,
   or their truck is not out tonight) are placed one at a time in order of distance from the yard, each onto the storm truck
   whose nearest already-assigned stop (or the yard, if it has none) is closest; ties → the truck with fewer stops, then the
   lower truck id. Then each truck's stops are ordered by rules 1–4 from the yard.

## Public

`GET /api/company` → Company.

## Owner routes (header `Authorization: Bearer <token>`; missing or expired → 401)

`POST /api/owner/signin` `{ "pin": "2468" }` → 200 `{ "token": "…", "expires_at": "…" }` (30 days).
Wrong PIN → 401 `{ "error": "That PIN is not right.", "code": "unauthorized", "field": "pin" }`. After 5 wrong tries from one IP
in 15 minutes every try from that IP (even the right PIN) → 429 "Too many tries. Wait 15 minutes and try again."

`POST /api/owner/signout` → 204 (ends this token). `PUT /api/owner/pin` `{ "current", "next" }` → 204; `next` must be 4–8 digits
(400 field `next`); wrong `current` → 401 field `current`; ends every other session.

`GET /api/owner/company` → Company · `PUT /api/owner/company` `{ "name", "yard": { "label", "lat", "lng" } }` → Company.

**Clients.** `GET /api/owner/clients` → `{ "clients": [Client] }` active only, sorted by name; `?include_inactive=1` adds inactive
ones after the active ones. `POST /api/owner/clients` → 201 Client. `PUT /api/owner/clients/:id` → 200 Client.
`POST /api/owner/clients/:id/reset-link` → 200 Client with a new `status_url`; the old key answers 404 from then on.
`GET /api/owner/clients/:id/messages` → `{ "messages": [Message] }` (`status_link`, plus `plowed` when the client's latest
non-voided check-in overall is plowed). There is no delete: a client with history is set `active: false`.

**Trucks.** `GET /api/owner/trucks` → `{ "trucks": [Truck] }` (active first, then by name). `POST /api/owner/trucks` `{ "name" }`
→ 201 Truck. `PUT /api/owner/trucks/:id` `{ "name", "active" }` → Truck. `POST /api/owner/trucks/:id/reset-link` → Truck with a
new `driver_url`; the old key answers 401 from then on.

**Storms.**
- `GET /api/owner/storms` → `{ "storms": [{ id, name, status, started_at, started_label, ended_at, ended_label, counts }] }` newest first.
- `GET /api/owner/storms/current` → `{ "storm": Storm | null }` (the active storm, owner view with messages).
- `POST /api/owner/storms` `{ "client_ids": [..], "truck_ids": [..] }` → 201 Storm. Both arrays non-empty and every id an active
  client/truck (400 field `client_ids` / `truck_ids`). A storm already active → 409 `bad_state` "A storm is already on. End it
  before starting another." Name = `"Storm of " + date label of started_at`. The route is built by the rules above.
- `GET /api/owner/storms/:id` → Storm (owner view).
- `PUT /api/owner/storms/:id/route` `{ "trucks": [{ "truck_id": 1, "client_ids": [5, 2, 9] }] }` → Storm. Every truck of the
  storm is listed exactly once (a list may be empty), and every stop of the storm appears exactly once across them; otherwise
  400 field `trucks`. Stops may move between trucks. Positions are rewritten 1..n per truck; statuses and check-ins are unchanged.
  Ended storm → 409 `bad_state`.
- `POST /api/owner/storms/:id/stops` `{ "client_id", "truck_id" }` → Storm; appends the client as that truck's last stop.
  Already a stop, inactive client, or truck not in the storm → 400 (field `client_id` / `truck_id`). Ended → 409 `bad_state`.
- `DELETE /api/owner/storms/:id/stops/:client_id` → Storm; only a stop with no check-ins at all (else 409 `bad_state`).
- `POST /api/owner/storms/:id/end` → 200 `{ "storm": Storm, "summary": Summary }`. Already ended → 409 `bad_state`.
- `GET /api/owner/storms/:id/summary` → Summary:
```json
{ "storm_id": 7, "name": "Storm of Mon Jan 12", "status": "ended", "started_label": "Mon Jan 12, 4:05 AM", "ended_label": "Mon Jan 12, 7:45 AM",
  "duration_label": "3 h 40 min", "stops": 25, "plowed": 22, "billable_pushes": 22,
  "skipped": [ { "client_id": 4, "name": "…", "reason_text": "Car in the way", "at_label": "5:10 AM" } ],
  "not_reached": [ { "client_id": 9, "name": "…" } ],
  "trucks": [ { "id": 1, "name": "…", "plowed": 11, "skipped": 1, "pending": 1, "first_label": "4:20 AM", "last_label": "7:40 AM" } ] }
```
`duration_label` and `ended_label` are null while the storm is active. `first_label`/`last_label` are null for a truck with no check-ins.

**Billing.**
- `GET /api/owner/billing/months` → `{ "months": ["2026-01", "2025-12"] }`: NL months that have at least one push, newest first.
- `GET /api/owner/billing?month=YYYY-MM` (default: the current NL month; bad format → 400 field `month`) →
```json
{ "month": "2026-01", "label": "January 2026", "hst_rate": 0.15,
  "rows": [
    { "client_id": 2, "name": "Lee (SAMPLE)", "address": "…", "billing": "per_push", "billing_label": "Per push", "price_cents": 4000,
      "pushes": 3, "dates": ["2026-01-12", "2026-01-19", "2026-01-20"], "amount_cents": 12000, "hst_cents": 1800, "total_cents": 13800 },
    { "client_id": 3, "name": "Sam (SAMPLE)", "address": "…", "billing": "seasonal", "billing_label": "Seasonal contract", "price_cents": 55000,
      "pushes": 2, "dates": ["2026-01-12", "2026-01-19"], "amount_cents": 0, "hst_cents": 0, "total_cents": 0 } ],
  "totals": { "pushes": 5, "subtotal_cents": 12000, "hst_cents": 1800, "total_cents": 13800 },
  "seasonal_note": "Seasonal contracts are billed on the contract, not by the push. Their pushes are counted here for your records." }
```
  - **A push is a `plowed`, non-voided check-in whose `at` falls inside the month in NL time.** Skipped and voided check-ins
    never count. `dates` are NL dates, one entry per push, ascending.
  - Rows: every client with at least one push that month, plus every active seasonal client (0 pushes). Sorted by name.
  - `per_push`: `amount = pushes × price`; `hst = Math.floor((amount × 15 + 50) / 100)` (half up, integer maths);
    `total = amount + hst`. `seasonal`: amount, hst and total are 0. `totals` are the sums of the rows.
- `GET /api/owner/billing.csv?month=YYYY-MM` → `text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="snow-route-2026-01.csv"`
  (`snow-route-SAMPLE-2026-01.csv` while the company is sample). CRLF line ends. Header row exactly
  `Client,Address,Billing,Pushes,Push dates,Price,Amount,HST 15%,Total`; one row per billing row (Billing = label, Push dates
  joined with `; `, money as `123.45`); last row `Total,,,<pushes>,,,<subtotal>,<hst>,<total>`. RFC 4180 quoting (a field with a
  comma, quote or line break is quoted, quotes doubled). A text cell starting with `=`, `+`, `-`, `@`, tab or carriage return
  gets a leading `'` so a spreadsheet never runs it as a formula.

## Driver routes (header `X-Driver-Key: <key>`)

Unknown or reset key → 401 "This driver link doesn't work any more. Ask the owner for a new one."

`GET /api/driver/route` →
```json
{ "company": { "name": "…", "sample": true, "timezone": "America/St_Johns" },
  "truck": { "id": 1, "name": "Truck 1 (SAMPLE)" },
  "storm": { "id": 7, "name": "Storm of Mon Jan 12", "status": "active", "started_at": "…" },
  "stops": [ "Stop… (this truck's stops in position order)" ],
  "server_now": "…" }
```
`storm` is the active storm when this truck is in it, else `null` with `stops: []`.

`POST /api/driver/checkins`
```json
{ "id": "6f1c2a3e-…", "storm_id": 7, "client_id": 3, "kind": "skipped", "reason": "gate", "note": "",
  "at": "2026-01-12T10:42:00.000Z", "has_photo": false }
```
- 201 `{ "checkin": Checkin, "stop": Stop }` stored.
- 200 `{ "checkin": Checkin, "stop": Stop, "duplicate": true }` when a check-in with this `id` is already stored, whatever the
  body says. Nothing changes. **This is what makes resending safe.**
- 409 `already_plowed` `{ "error": "This stop is already marked plowed.", "code": "already_plowed", "checkin": <the plowed one> }`
  when the stop already has a non-voided plowed check-in with a different id (for a new plowed or a new skip).
- 400 `bad_request`: `id` not a UUID (field `id`), bad `kind`, a skip without a valid `reason` (field `reason`), `note` over 120
  characters, `at` not a valid ISO instant (field `at`), `has_photo` not a boolean.
- 404 `not_found`: unknown storm, or the client is not a stop in that storm.

Rules:
- **Accepted whether the storm is active or ended** (a phone can sync after the owner ends the storm), and whichever truck the
  stop is on now. `truck_id` records the driver's truck.
- **Time.** `at` is stored exactly as sent when `storm.started_at − 10 min ≤ at ≤ server now + 10 min`; otherwise `at` = server
  now and `at_adjusted: true`. `received_at` is always server now.
- **The database enforces both rules**, not a read-then-write: `checkins.id` is the PRIMARY KEY and the insert is
  `INSERT … ON CONFLICT(id) DO NOTHING` followed by reading the stored row; one plowed per stop is the partial unique index
  `CREATE UNIQUE INDEX checkins_one_plowed ON checkins(storm_id, client_id) WHERE kind = 'plowed' AND voided_at IS NULL`.
  A skip is refused with `already_plowed` by checking inside the same `DB.batch()`.
- A plowed check-in after a skip is allowed (the car moved). A second pass in one storm is not a thing: start a new storm.

`PUT /api/driver/checkins/:id/photo` — raw body, `Content-Type` `image/jpeg` | `image/png` | `image/webp` → 200 `{ "checkin": Checkin }`
with `photo: "stored"` (a repeat upload replaces it). Other type → 415; more than 5 000 000 bytes → 413; unknown id, or a check-in
from another truck → 404. Stored in R2 binding `PHOTOS` under `checkins/<id>`.

`DELETE /api/driver/checkins/:id` → 200 `{ "checkin": Checkin, "stop": Stop }` with `voided: true` (undo). Same truck only (else 404);
more than 15 minutes after `received_at` → 409 `bad_state` "Too late to undo. Ask the owner to fix it."; already voided → 200 as is.

## Photos

`GET /api/photos/:photo_token` → the stored bytes with their `Content-Type`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer`. `photo_token` is 128 random bits made when the photo is stored. Unknown token or voided check-in → 404.
Demo placeholders are generated SVGs stored with `image/svg+xml` and served with `Content-Security-Policy: default-src 'none';
style-src 'unsafe-inline'`; the upload route never accepts SVG.

## Client status (no sign-in)

`GET /api/status/:key` →
```json
{ "company": { "name": "…", "sample": true },
  "client": { "name": "Sam (SAMPLE)", "address": "Harris Avenue, Grand Falls-Windsor, NL", "type": "driveway", "type_label": "Driveway" },
  "last": { "at": "…", "at_label": "Mon Jan 12, 6:42 AM", "time_label": "6:42 AM", "photo_url": "…", "photo_waiting": false },
  "tonight": { "storm_name": "Storm of Mon Jan 12", "state": "waiting", "stop_number": 4, "stops_on_route": 13, "stops_done": 2, "reason_text": null },
  "server_now": "…" }
```
- `last`: the latest non-voided plowed check-in for this client in any storm, or `null`.
- `tonight`: only while an active storm has this client as a stop, else `null`. `state` is `waiting` | `plowed` | `skipped`;
  `stop_number` = position on its truck; `stops_on_route` = stops on that truck; `stops_done` = plowed + skipped on that truck;
  `reason_text` only when skipped.
- **Never** includes notes, price, billing, other clients, trucks or drivers.
- Unknown key → 404 "This status link doesn't work. Ask your snow clearing company for a new one." More than 30 unknown-key
  lookups from one IP in 10 minutes → 429.

## Test routes (only with `TEST_MODE=1`)

- `POST /api/test/reset` → wipes every table and the R2 bucket, then seeds the SAMPLE company (PIN 2468, yard), both SAMPLE
  trucks and the 25 SAMPLE clients from `data/sample-clients.json` (through the generated `worker/src/sample-data.js`), no storms.
  Answers `{ "pin": "2468", "trucks": [{ "id", "name", "driver_key", "driver_url" }], "clients": [{ "id", "ref", "name", "status_key", "status_url" }] }`.
- `POST /api/test/seed` `{ "scenario": "demo" }` → reset, then (all times relative to server now) two ended storms 13 and 6 days
  ago with every stop plowed except one "Car in the way" skip each, and an active storm started 2 hours ago where each truck's
  first 5 stops are plowed (placeholder photos; one with `photo: "waiting"`) and its 6th is skipped "Gate locked". Answers the reset
  shape plus `"storm_id"`.

## App pages (sr2)

- `/` — company name + SAMPLE badge, "Owner sign-in" button, and one line: "Drivers and clients use the links the owner sends them."
- `/owner/` — sign-in, Tonight (storm), Clients, Trucks, Billing, Settings.
- `/d/?k=<driver_key>` — driver. Service worker `/d/sw.js`, scope `/d/`. Never intercepts `/api/*`.
- `/s/?k=<status_key>` — client status.
- Storage: `localStorage` `snow-route:owner-token`, `snow-route:route:<truck id>` (last route seen); IndexedDB database
  `snow-route`, object store `queue` (check-ins and photo blobs waiting to send).

## Clarifications

1. **Labels use a plain space before AM/PM.** ICU writes U+202F (narrow no-break space) before `AM`/`PM`; the Worker replaces it
   (and U+2009) with a plain space, so labels read exactly `"6:42 AM"`. The app does the same when it formats a queued check-in.
2. **Examples fixed.** `10:42Z` in January is 7:12 AM NST (UTC−3:30). The examples above that pair an instant with "6:42 AM" mean
   `2026-01-12T10:12:00.000Z`. Follow the rule, never an example.
3. **Two more test routes** (TEST_MODE only, 404 otherwise; sr1 M1): `POST /api/test/storms/:id/end` `{ "at"?: ISO }` ends a storm
   directly in D1, and `GET /api/test/checkins?storm_id=` → `{ "checkins": [raw rows, voided included] }` so a test can count what the
   database holds. Tests may use both; the app never does.
4. **Deactivating a truck or client does not kill its link.** Only "New link" (`reset-link`) does. Deactivating hides it from lists
   and from new storms; a driver with check-ins still queued on the phone must never be locked out by a tidy-up.
5. **What the phone's queue does with each answer** (sr2): 200/201 → remove the item (then send its photo). 409 `already_plowed`,
   400 and 404 → move it to the visible "Not accepted" list with the server's `error` text (never retried, never silently dropped).
   401 → keep everything queued and show "This driver link doesn't work any more. Ask the owner for a new one." 5xx, 429 and network
   errors → keep and retry with backoff. A photo PUT: 200 → remove; 413/415/404 → drop the photo only, and say so in the list; else retry.
6. **Error texts.** sr1's wording for the cases the table does not give is adopted (docs/build-report-sr1.md, M1 choice 4), plus
   `500 server_error` "Something went wrong on our side. Try again in a minute." for an unexpected failure.
7. **Check-in ids** are stored lower-cased; the app sends `crypto.randomUUID()` (already lower case).
8. **A repeat photo upload gets a new photo token**: the old `photo_url` answers 404 from then on.
9. **Every `/api/*` JSON answer** carries `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`.
10. **`reason` and `note` are ignored on a plowed check-in.** The app omits them for plowed; the Worker stores `reason: null` for plowed
    whatever is sent.
11. **Queue, exactly** (sharpens 5, sr2 M1 differs): a **429** is a failure, not a refusal: keep it queued and retry with backoff. A
    photo PUT refused with 404/413/415 drops **only the photo**: the check-in is already on the server, so remove the item and show
    "Photo not sent: <server message>" on that stop's row; it never sits in "Not accepted".
12. **Status-link guard blocks the whole IP.** Once an IP has 30 unknown-key lookups inside 10 minutes, every status lookup from it
    answers 429, known keys included, so a guesser cannot spot a hit by a different answer.
13. **Summary per truck:** `plowed` / `skipped` / `pending` count the stops on that truck now; `first_label` / `last_label` come from the
    non-voided check-ins that truck made. After a stop moves between trucks the two can differ, on purpose.
14. **Small shapes from sr1 M2, adopted:** `POST /api/owner/storms/:id/stops` answers **200** with the Storm; route PUT answers 409
    `bad_state` "The route changed while you were editing it. Reload and try again." when the stop set changed underneath; undo leaves the
    R2 object but its `photo_url` answers 404; sr1's M2 error texts (docs/build-report-sr1.md, M2 choice 1) are the contract.
15. **(sr1 M3) A check-in for a stop being removed never lands.** The check-in insert and the stop DELETE each guard the other inside
    their own statement/batch, so of a racing check-in and removal exactly one wins: the check-in (and the DELETE answers 409), or the
    removal (and the check-in answers 404, which the phone puts in "Not accepted").
16. **(sr1 M3) Wrong `current` PINs on `PUT /api/owner/pin` count toward the sign-in guard** (same 5 per 15 minutes per IP). A stolen
    session must not be able to try every PIN and lock the owner out.
17. **(sr2 M3, sr1 review R1) A dead driver key never blocks the queue.** A 401 marks only that item's key as dead; the sender goes on
    to the next item. When the page's own key works (its route loaded), every item under a dead key is re-keyed to the page's key and
    sent again: the check-in id makes a resend harmless and the Worker accepts a check-in whichever truck the stop is on now. Items under
    a dead key stay listed on screen ("Saved under an old driver link, sending with this one") until they are sent. The strip shows the
    401 text only when the page's own key is the one refused.
18. **(sr1 M4 + sr2 M3, review R2/R3) A bad status link always reads as a bad status link.** Worker: every `GET /api/status/<anything>`
    goes to the status handler, so a key with a trailing `.`, `)` or `%20` answers the status 404 text (and counts toward the guard like
    any unknown key), never the router's "There's nothing here.". App: the status page shows its own bad-link text for any 404 and stops
    checking (no timer, no `visibilitychange` re-check) until the page is reloaded.
19. **(sr2 M3, review R4) Undo on an item in "Not accepted" only removes it from the phone.** The server never stored it, so no DELETE is
    queued and the refusal text is not replaced by a second error.
20. **(sr2 M3, review R5) A queued check-in for a stop that is no longer on this truck stays visible** in a "Saved for stops on another
    route" row with its stop name, time and Undo, until it is sent.
21. **(sr2 M3, review M2-1) An owner 401 with a `field` is a form error, not a sign-out.** Only a 401 **without** `field` means the session
    ended (clear the token, show sign-in). `PUT /api/owner/pin` with a wrong `current` answers 401 `field: "current"`: show "That PIN is not
    right." by that field and keep the session. A 429 on that form is a message on the form.
22. **(sr2 M3, review M2-3) Start storm answering 409 `bad_state`** (a storm was started on another screen) closes the picker and shows the
    running storm, with the API's message above it.
23. **(sr2 M3, review M2-4) Price input** accepts `45`, `45.5`, `45.50`, `.50`, `45.` and `$1,200.00`; anything else is refused on the form
    with the API's wording before sending.
24. **(sr2 M3, review M2-5, sharpens 17) Re-keying never crosses trucks for photos and undos.** Check-in items under a dead key are
    re-keyed to the page's key whatever truck it is. Photo and undo items are re-keyed only when the dead key's truck id (kept with the saved
    route) equals the page's truck id; otherwise they stay listed under "Saved under an old driver link" with a Remove button, never sent to
    a truck that would answer 404, never silently dropped.
25. **(sr2 M3, review M2-2) No spec skips itself because a route might be missing.** Every route in this contract exists on main, so a
    missing route must fail. The only allowed skips are named WebKit limits with a written reason (for example reading the clipboard).
26. **(sr2 M3c, review M3a-1) Only the driver's Undo tap ever sends a DELETE.** An undo is an explicit mark on the queued item
    (`state: 'undone'`); a check-in the sender finds missing from the queue after a 200/201 means another tab already sent it, never
    that it was undone. Every driver tab also runs its sends inside one Web Lock (`navigator.locks.request('snow-route-send', …)`), so two
    tabs of the driver page never send the same item at once. Two tabs sending one check-in must leave one stored, non-voided check-in.
27. **(sr2 M3c, review M3a-2) Every queued item carries the `truck_id` of the check-in it belongs to**, including an undo the sender creates
    itself. Keys are mapped to trucks in their own store (`snow-route:keys`), never overwritten by a newer route for the same truck.
28. **(sr2 M3c, review M3a-3) Queued check-ins from a storm that has ended read as that**, "Saved from the storm that ended, still
    sending", not as stops moved off the route. An Undo that would delete an unsent check-in from the phone asks first ("This check-in has
    not reached the office yet. Delete it from this phone?").
29. **(sr2 M3c, review M3a-4) The cross-truck rule is tested and has a negative control:** a photo and an undo saved under truck 1's link,
    truck 1's link reset, truck 2's link opened → both rows say they belong to another truck's link and no PUT or DELETE reaches the Worker
    under truck 2's key; the control removes the truck comparison and the test goes red.
30. **(sr2 M3c, review M3a-5) A photo dropped for a stop in "Saved for stops on another route"** keeps a short "Photo not sent: <message>"
    row there until the driver dismisses it.
31. **(sr2 M3c, review M3a-6/7)** The storm-start notice is cleared when Tonight finds no storm. A re-keyed check-in for a stop on another
    route is listed once, in "Saved for stops on another route", with a small "moved from an old driver link" note.
