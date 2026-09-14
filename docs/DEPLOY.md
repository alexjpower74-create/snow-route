# Deploying Snow Route (not done: waits for Alexander)

Nothing in this build has been deployed. Everything below is what a deploy would need, written down so it can be done in one
sitting when Alexander says so. One deployment = one contractor (DECISIONS.md 1).

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

## Map tiles

The owner screens use OpenStreetMap's standard tile server with the attribution shown and no prefetching, which the
[tile usage policy](https://operations.osmfoundation.org/policies/tiles/) allows for light use like one contractor's owner screens.
If this is sold to many contractors, switch to a tile provider (MapTiler, Stadia, Thunderforest…) by changing the
`<meta name="tile-url">` in the owner page, and keep the attribution. Driver and client pages have no map.

## Photos and privacy

- Photos of clients' driveways live in R2 under `checkins/<check-in id>`, reachable only through an unguessable photo URL.
- Decide how long to keep them (an R2 lifecycle rule, e.g. delete after 13 months) before selling. Not set tonight.
- Status links and driver links are secret links. "New link" on the owner screens kills an old one.
- **The status-link guard is per IP** (30 unknown keys in 10 minutes blocks that IP for every status link, DECISIONS.md 24). Mobile
  carriers often put many phones behind one shared IP, so a stale bad link being retried somewhere on that carrier could make good
  links answer "Too many wrong status links" for ten minutes. The app stops retrying after a bad link (API.md 18), which keeps this
  rare for one contractor's clients. If it ever bites, loosen the rule (count per key prefix, or raise the limit) rather than drop it.

## Where to change things

- Prices and HST: `worker/src/billing.js` (HST 15%, half-up per row).
- Route rules: `worker/src/route.js` (priority tiers, nearest neighbour, 2-opt).
- Wording of the copy-this-text messages: `worker/src` (see docs/API.md "Message").
