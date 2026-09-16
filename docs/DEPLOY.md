# Deploying Snow Route

**Status 2026-09-15 (Alexander's go):** the D1 database `snow-route` exists (id `87f52876-573a-46d9-9eae-be6f7797e4b8`, in
`worker/wrangler.toml`) and all three migrations are applied remotely. **Not yet live:** the R2 bucket could not be created because R2 is
not enabled on the Cloudflare account (API code 10042, "enable R2 through the Cloudflare Dashboard"); the Worker binds `PHOTOS` to that
bucket, so `wrangler deploy` waits on it. Remaining steps, in order, once R2 is enabled in the dashboard:

1. `cd worker && npx wrangler r2 bucket create snow-route-photos`
2. `npx wrangler deploy` → the app and API at `https://snow-route.<account>.workers.dev`
3. Smoke-test: `curl https://<host>/api/company` answers JSON; `curl -X POST https://<host>/api/test/reset` answers 404.
4. SAMPLE demo data for the live demo: the seed only exists behind `TEST_MODE`, so deploy once with `--var TEST_MODE:1`, POST
   `/api/test/seed` with `{"scenario":"demo"}`, then deploy again without the var and re-run step 3 (the 404 proves test mode is off).

One deployment = one contractor (DECISIONS.md 1).

## What gets created

| Thing | Name | How |
|---|---|---|
| D1 database | `snow-route` | `wrangler d1 create snow-route`, then put the id it prints into `worker/wrangler.toml` (`database_id`) |
| R2 bucket (photos) | `snow-route-photos` | `wrangler r2 bucket create snow-route-photos` |
| Tables | migrations in `worker/migrations/` | `cd worker && wrangler d1 migrations apply snow-route --remote` |
| Worker (API + app) | `snow-route` | `cd worker && wrangler deploy` (serves `app/public` as static assets) |

- **No secrets** are needed. **No cron**: nothing runs on a schedule.
- **Never set `TEST_MODE`** on a deploy. It turns on the test clock, test IPs and `/api/test/*` (reset and seed wipe everything).
  `wrangler.toml` has no `TEST_MODE` on purpose; tests pass it on the command line only.
- After the first deploy, smoke-test: `curl https://<host>/api/company` answers the company JSON, and
  `curl -X POST https://<host>/api/test/reset` answers **404** (proves test mode is off).

## Before a real contractor uses it

1. **Change the PIN.** The migration seeds PIN `2468` for the SAMPLE company. Owner → Settings → Change PIN.
2. **Rename the company** in Settings. The SAMPLE badge disappears once the name no longer contains "SAMPLE".
3. **Set the yard** pin in Settings (routes start from it).
4. The SAMPLE clients and trucks only exist in test mode (`/api/test/reset`); a deployed database starts with no clients or trucks.
5. Add trucks, copy each driver link to that truck's phone, add clients (tap the map to place each pin).

## Host and phones

- **HTTPS is required** on the phones: the camera input and the offline service worker only work on a secure origin
  (`localhost`/`127.0.0.1` are exempt, which is why local testing works). `*.workers.dev` or a custom domain both qualify.
- A custom domain such as `snow.apcosoftwaretools.ca` is optional (Porkbun DNS → Cloudflare route).
- The driver saves the driver link to the home screen once; after the first load the page works with no signal.

## Map tiles: OpenFreeMap

The owner screens draw OpenFreeMap's `positron` vector style (<https://tiles.openfreemap.org/styles/positron>) with MapLibre GL inside
Leaflet (both vendored in `app/public/vendor/`, pinned). OpenFreeMap's public instance is free, allows commercial use, needs no API key
or registration and has no request limits, so it is fit for selling Snow Route widely (DECISIONS.md 62). Driver and client pages have no map.

- **No SLA.** OpenFreeMap says it offers no SLA guarantees or support. If it is slow or down, the owner map shows a plain background; pins,
  lines, dragging, driver pages and billing are unaffected.
- **Switching needs no code change.** Set the Worker variable `MAP_STYLE_URL` to another MapLibre style URL (a self-hosted OpenFreeMap or
  any MapLibre style) in the Cloudflare dashboard, or pass `--var MAP_STYLE_URL:<url>` to `wrangler deploy`. Don't add a `[vars]` block to
  `wrangler.toml` without also updating the unit test that keeps `TEST_MODE` out of it. `GET /api/company` then answers the new URL.
- **Attribution stays on the map**: "OpenFreeMap © OpenMapTiles Data from OpenStreetMap", each linked (required by OpenFreeMap). If you
  switch provider, change `ATTRIBUTION` in `app/public/owner/owner.js` to what that provider requires.

## Photos and privacy

- Photos of clients' driveways live in R2 under `checkins/<check-in id>`, reachable only through an unguessable photo URL.
- Decide how long to keep them (an R2 lifecycle rule, e.g. delete after 13 months) before selling. Not set tonight.
- Status links and driver links are secret links. "New link" on the owner screens kills an old one.
- **The status-link guard is per IP** (30 unknown keys in 10 minutes blocks that IP for every status link, DECISIONS.md 24). Mobile
  carriers often put many phones behind one shared IP, so a stale bad link being retried somewhere on that carrier could make good
  links answer "Too many wrong status links" for ten minutes. The app stops retrying after a bad link (API.md 18), which keeps this
  rare for one contractor's clients. If it ever bites, loosen the rule (count per key prefix, or raise the limit) rather than drop it.

## Optional: drop the development mock

`app/public/api.mock.js` and `app/public/mock-data.js` let the driver and status pages be shown with no Worker (`?mock=1`). They hold
SAMPLE data only and switch on only with that URL flag (DECISIONS.md 22). To leave them out of a deploy, delete both files before
`wrangler deploy`; nothing else references them unless `?mock=1` is used.

## Where to change things

- Prices and HST: `worker/src/billing.js` (HST 15%, half-up per row).
- Route rules: `worker/src/route.js` (priority tiers, nearest neighbour, 2-opt).
- Wording of the copy-this-text messages: `worker/src` (see docs/API.md "Message").
