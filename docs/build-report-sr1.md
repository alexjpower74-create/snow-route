# Build report: sr1 (Worker, D1, R2, routing, check-ins, billing)

Branch `rig/sr1`. Numbers below come from my working tree on 7602 (unit + API) and 7605 (negative controls). The lead's
numbers come from `rig qa`.

## M1: DONE

### What I built (`worker/`)
- `wrangler.toml` as PLAN.md says (D1 `DB`, R2 `PHOTOS`, assets `../app/public`, `run_worker_first = ["/api/*"]`, no `[vars]`).
- `migrations/0001_init.sql`: company (single row, `CHECK (id = 1)`), sessions (SHA-256 of the token), signin_attempts,
  trucks, clients, storms, storm_trucks, storm_stops `PRIMARY KEY (storm_id, client_id)`, checkins `id TEXT PRIMARY KEY` with
  `checkins_one_plowed`, photos. Two additions beyond the brief's list, both needed:
  - `storm_trucks`: a truck can be in a storm with no stops (route PUT in M2 allows an empty list), so the storm's trucks can't
    be read from its stops.
  - `storms_one_active` (unique partial index): two Start taps at once get one storm and one 409, enforced by the database.
- `migrations/0002_company.sql`: the SAMPLE company, yard, PIN 2468 (PBKDF2-SHA256, 100 000 iterations, from `tools/hash-pin.mjs`).
- `src/route.js` (pure): haversine (R 6 371 008.8 m), tiers, nearest neighbour (ties: lower client_id), open-path 2-opt
  (start fixed, end free, gain > 0.5 m, at most 200 passes), truck assignment, `buildRoute`.
- `src/time.js`: NL time, date and full labels, NL date/month of an instant, UTC bounds of an NL month (DST-correct), month
  label, duration label. `src/clock.js`: now and IP with the TEST_MODE rule. `src/auth.js`: keys, SHA-256, PBKDF2, UUID v4 check.
- `src/sample.js` + generated `src/sample-data.js` (`tools/build-sample-data.mjs`, `npm run build:sample`).
- `src/index.js`: every M1 route. Check-ins: `INSERT … ON CONFLICT(id) DO NOTHING` and `meta.changes` decide 201 or 200
  duplicate; a second plowed hits `checkins_one_plowed`; a skip on a plowed stop is refused by a guard statement in the same
  `DB.batch()` (a `json()` of a non-JSON string raises and rolls the batch back). The duplicate lookup by id runs only when a body
  would otherwise be refused, so a resend with an odd body still gets its 200 while the normal path is enforced by the database alone.
- `npm test` (`tests/run.mjs`), `npm run dev`, `npm run migrate`, `npm run negative` and `negative:<name>`.

### Verified
`npm test`: **18 unit tests pass, 34 API tests pass, 0 fail, 0 skipped** (7602, fresh `.state-7602`).
- `tests/route.test.mjs` (10): haversine against the formula written out in the test (Harris Ave to Hardy Ave); tiers on 50 seeded
  instances; 2-opt local optimum on the same 50 (every single reversal of every returned tier path checked, >1000 reversals); a
  crafted crossing instance (nearest neighbour gives 2, 4, 1, 3, 5 and crosses; the test asserts that it crosses, that the result
  does not, and the exact order 2, 3, 5, 4, 1); length ≤ nearest neighbour; deterministic (also with the input reversed); NN ties;
  empty and one-stop; truck assignment (own truck kept, orphan to the nearest stop's truck, a client whose truck isn't out, a tie
  on distance goes to fewer stops, then the lower id); `buildRoute` per truck.
- `tests/unit.test.mjs` (8): labels, the NL month boundary (`2026-02-01T03:00:00Z` → `2026-01-31`, January), DST month bounds, the
  TEST_MODE rule, `/api/test/*` 404 without TEST_MODE **before the database is touched** (a DB proxy that throws on any access),
  wrangler.toml has no TEST_MODE, sample-data.js not stale and every name SAMPLE with no digits in addresses, migration 0002's hash
  really verifies 2468 and refuses 2469.
- `tests/api.test.mjs` (34): everything the brief lists for M1, and also: the storm order equals `buildRoute` on the same data;
  the exact message texts for status_link, on_route, plowed, skipped; session expiry after 30 days; the driver route contains no
  `messages`, `price`, `billing`, `status_url` or `k=`; the check-in time window edges (10 min before start kept, 11 min adjusted);
  a 5 000 000-byte photo accepted; SVG upload refused 415; another truck's photo PUT 404; status after the storm ends (`tonight` null,
  `last` kept); status JSON never contains the notes text or the words notes/price/billing/truck/driver/messages.

### Negative controls (all four RED; full output appended to `worker/tests/negative-control.log`)
Each control copies `worker/` to `worker/.negative/<name>` (git-ignored), first runs the named tests on the **unbroken** copy (they
must pass), applies a literal break that must match exactly once, runs again, and exits 0 only if every named test shows ✖.
API controls serve the copy on 7605 from a fresh state folder.

| control | break (in the copy only) | red output |
|---|---|---|
| (a) `negative:twoopt` | `src/route.js`: `return twoOpt(start, nearestNeighbour(start, stops))` → `return nearestNeighbour(start, stops)` | ✖ 2-opt local optimum; ✖ crossing |
| (b) `negative:tiers` | `src/route.js`: `tiers[tierOf(s.priority)].push(s)` → `tiers[2].push(s)` | ✖ tiers |
| (c) `negative:idempotent` | `migrations/0001_init.sql`: `id TEXT PRIMARY KEY` → `id TEXT NOT NULL`; `src/index.js`: ` ON CONFLICT(id) DO NOTHING` removed | ✖ the same id again: `skipped resend … actual: 201, expected: 200` |
| (d) `negative:time` | `src/index.js`: `const at = inWindow ? iso(input.at) : iso(ctx.now)` → `const at = iso(ctx.now)` | ✖ original time kept: `actual: '2026-01-12T09:50:00.000Z', expected: '2026-01-12T09:05:00.000Z'` |

One note on (c): with the primary key gone, a resent **plowed** check-in is still refused by `checkins_one_plowed` (a second guard)
and answered as a duplicate. That's why the same-id test resends both a plowed and a **skipped** check-in, and the skipped resend is
the one that goes red (201 and two stored rows). The test counts stored rows through the test-only route below, as well as reading
the owner storm view.

### Choices I made that the contract leaves open (lead: confirm or change)
1. **Test-only helper routes** (TEST_MODE only, 404 otherwise): `POST /api/test/storms/:id/end` `{ at? }` ends a storm directly in D1
   (the brief lets me choose; the owner End storm route is M2), and `GET /api/test/checkins?storm_id=` returns the raw rows, voided
   included, so a test can count what the database holds. Please append them to API.md's clarifications if sr2 may use them.
2. **AM/PM space.** ICU writes a narrow no-break space (U+202F) before AM/PM. The Worker replaces it with a plain space so labels read
   exactly "6:42 AM" as API.md shows. **sr2 should do the same** when formatting a queued check-in, or "Plowed at 6:42 AM" text
   matches will differ between a queued and a sent check-in.
3. API.md's example pairs `2026-01-12T10:42:00.000Z` with "6:42 AM"; in January NL time that instant is **7:12 AM** (NST, −3:30).
   The Worker follows the rule, not the example. Worth fixing in API.md so nobody copies the example into a test.
4. Error texts the contract doesn't give: start storm `client_ids` "Tick the clients to clear tonight." / "One of those clients is not
   on your active list.", `truck_ids` "Tick the trucks going out tonight." / "One of those trucks is not on your active list.";
   client `active` not a boolean "Say whether this client is active."; check-in `id` "This check-in has no proper id. Reload the
   driver page and try again.", `kind` "A check-in is either plowed or skipped.", `reason` "Pick why you're skipping.", `note` "Keep
   the note under 120 characters.", `at` "The check-in time could not be read.", `has_photo` "The photo flag could not be read.";
   404s "We couldn't find that storm." / "That client is not a stop in this storm." / "We couldn't find that check-in."; 415 "The photo
   has to be a JPEG, PNG or WebP picture."; 413 "That photo is too big. It has to be under 5 MB."; unexpected failure 500
   `server_error` (a code not in the table).
5. `POST /api/owner/storms` answers 409 `bad_state` before validating the body when a storm is already on.
6. Duplicate client or truck ids in a start body → 400. A `storm_id`/`client_id` that isn't an integer → 404 (as unknown).
7. A deactivated truck's driver link and a deactivated client's status link still work. The contract only says a *reset* key
   stops working. Say if deactivating should also shut them off.
8. A repeat photo upload makes a new photo token, so the old `photo_url` answers 404 (and a cached old photo can't be served under
   the new URL). `has_photo` becomes true on any upload, even for a check-in sent with `has_photo: false`.
9. Check-in ids are stored lower-cased.
10. Every `/api/*` JSON answer carries `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and `nosniff`, not just driver and status.

### Needs from other slices / environment
- **`app/public` doesn't exist in this worktree** (sr2 owns it), and `wrangler dev` refuses to start with a missing assets folder.
  `tests/run.mjs` passes `--assets <empty folder under .state-<port>-assets>` only when `../app/public` is missing. With sr2's
  pages merged, the Worker serves `app/public` as `wrangler.toml` says. Nothing for sr2 to do.
- `rig-harness` (with `check()`) isn't installed on this machine. The controls use the copy-and-break pattern above and require
  the unbroken copy to pass first, which gives the same VOID protection.
- Cross-review: sr2, please read `src/index.js` against API.md before M2, especially the check-in answers and the Stop/Checkin shapes.

### Not done in M1 (by design; M2)
Sign-in rate guard (the `signin_attempts` table exists, unused), unknown-status-key guard, PIN change, company PUT, client
reset-link and messages route, trucks POST/PUT/reset-link, storms list, route PUT, stops POST/DELETE, end, summary, billing
(months, JSON, CSV), driver undo, `POST /api/test/seed`, and negative controls (e)–(h).
