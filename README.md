# Snow Route

Routes, check-ins and billing for a small snow-clearing contractor in Newfoundland: the client list, tonight's route in order,
a big Plowed button with a photo at each stop that works with no signal, a status link for each client, and a month-end push count for the accountant.

> Overnight build 2026-09-14. **Local only: nothing is deployed.** Everything on screen is SAMPLE data.

## Run it locally

```sh
cd ~/Projects/"Snow Route"
npm run demo
```

That starts the Worker on <http://127.0.0.1:7601> with the SAMPLE contractor, a storm in progress and two past storms, and
prints the links (also written to `.logs/demo-links.txt`):

- **Owner:** <http://127.0.0.1:7601/owner/>, PIN `2468`
- **Drivers:** one link per truck (`/d/?k=…`)
- **Clients:** one status link per client (`/s/?k=…`), also on the owner's Clients screen

Ctrl+C stops it. Every run starts from a clean SAMPLE state.

Tests:

```sh
cd worker && npm test          # unit + API tests against wrangler dev --local (port 7602)
cd worker && npm run negative  # every Worker negative control; each must go red
cd app && npx playwright test  # chromium + webkit at 390 and 1280 against the real Worker (port 7603)
```

## What it does

- **Owner (PIN):** clients with a map pin, type, priority (medical, early commuter, business opening), notes for the driver, per-push
  or seasonal billing. Trucks with a secret driver link each. **Start a storm** builds each truck's route: medical first, then early
  commuters and businesses, then everyone else, each group ordered by nearest neighbour + 2-opt on straight-line distance from the yard.
  The screen says "Order is by distance, not road time." Drag or Move up/down to reorder, move a stop to the other truck, End storm →
  summary. Copy-this-text buttons for each client; nothing is ever sent.
- **Driver (phone, gloves, bad signal):** the next stop huge, Navigate (opens the phone's maps app), Plowed (camera photo), Plowed with
  no photo, Skip with a reason, Undo. Check-ins save on the phone first and send when signal comes back, **keeping the time the driver
  tapped**. Resending is harmless; a stop can't be billed twice.
- **Client:** a secret status link: "Plowed at 6:42 AM" with the photo, or "On the route tonight. You're stop 4." No accounts, no live GPS.
- **Billing:** pushes per client for a month in NL time, per-push amounts, seasonal contracts flagged, HST 15%, CSV for the accountant.
  Only plowed check-ins count: skipped and undone ones never bill.

## Real vs SAMPLE

- **SAMPLE:** the company ("SAMPLE Snow Clearing — Grand Falls-Windsor (demo)"), the 25 client names, the 2 trucks, prices, notes,
  every storm and check-in, and every photo (generated placeholders).
- **Real:** the street names and pin positions. Each is a real public street in Grand Falls-Windsor with the centre point OpenStreetMap
  gives for it (`data/sources/`, fetched 2026-09-14). There are **no house numbers**, so no pin points at anyone's home.
- Map tiles on the owner screens are OpenStreetMap's, with the attribution shown. Tests never fetch them.

## Test numbers

_Filled in from the final pinned QA run; see `docs/build-report.md`._

## What deploying needs

Nothing is deployed. Full steps in `docs/DEPLOY.md`. In short: D1 database `snow-route`, R2 bucket `snow-route-photos`, the Worker
`snow-route` (serves the app too), migrations applied remotely. **No secrets, no cron.** Never set `TEST_MODE`. HTTPS is required on the
phones (camera + offline). Before a real contractor: change PIN 2468, rename the company (the SAMPLE badge goes away), set the yard.
Optional custom domain.

## Where to pick this up

- `PLAN.md` is the build contract, `docs/API.md` the API contract with numbered clarifications, `DECISIONS.md` every call made overnight.
- `docs/build-report.md` has the QA history and every negative control; each slice's own report is beside it.
- Known gaps (settled so far; the final list is in `docs/build-report.md`):
  - **No address search.** The owner places each pin by tapping the map (no geocoding service tonight, DECISIONS.md 14).
  - **Route order is straight-line distance**, not road time; business opening times are shown, not used to reorder.
  - **Dragging a stop does not scroll the page.** On a long route, a stop far down the list is moved with Move up / Move down (or Move
    to Truck N) instead.
  - **`navigator.onLine` is trusted as a hint.** A check-in sent while the phone claims to be offline is not marked "may have reached the
    office"; if such a request does get through and the driver then undoes it, the undo stays on the phone (DECISIONS.md 56). Rare.
  - **The owner refresh's lower-version rule has no negative control of its own** (the edit-in-flight rule covers the same test).
  - **"Undo decisions are one transaction" has no negative control.** No test can close a page between two IndexedDB commits; the rule is
    verified by review (docs/build-report.md, M3e).
  - **The driver's Undo lasts 15 minutes.** After that only a future owner-side edit could fix a wrong check-in.
  - **One deployment per contractor.** Hosting many contractors from one Worker is a later change.
  - **Map tiles** are OpenStreetMap's standard tiles, fine for one contractor's owner screens; many contractors need a tile provider.
  - **The status-link guard is per IP**, which is blunt behind a mobile carrier's shared IP (DEPLOY.md).
  - **WebKit offline test:** Playwright's WebKit cannot read a chosen photo while set offline, so on WebKit the test fails every `/api`
    request instead and skips the offline reload step (DECISIONS.md 35). Chromium covers the true offline path.
