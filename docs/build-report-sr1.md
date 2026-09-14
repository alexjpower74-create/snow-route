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

### Not done in M1 (by design; M2): DONE in M2 below
Sign-in rate guard, unknown-status-key guard, PIN change, company PUT, client reset-link and messages route, trucks
POST/PUT/reset-link, storms list, route PUT, stops POST/DELETE, end, summary, billing (months, JSON, CSV), driver undo,
`POST /api/test/seed`, and negative controls (e)–(h).

## M2: DONE

Merged main first (`git merge --ff-only main` → 7b8013b: API.md clarifications 1–9, DECISIONS 18–21). From the clarifications:
the 500 text is now "Something went wrong on our side. Try again in a minute." (6), and labels replace U+2009 and U+00A0 as well
as U+202F with a plain space (1).

### What I built
- `src/billing.js` (pure): `isBillable` (plowed and not voided), `isPush` (plus inside the NL month's UTC bounds), HST
  `Math.floor((amount × 15 + 50) / 100)`, rows (clients with a push + every active seasonal client, sorted by name), totals as row
  sums, months newest first, money, RFC 4180 text cells with the formula guard, the CSV, the filename. The Worker's query only
  takes a padded window (the NL month ± 2 days); `billing.js` alone decides what bills, so every billing rule has one home.
- `src/index.js`, every remaining route: `PUT /api/owner/pin` (ends every other session), owner company GET/PUT, client
  `reset-link` and `messages`, trucks POST/PUT/`reset-link`, storms list (counts in SQL, checked equal to the storm view), route
  PUT, stops POST/DELETE (positions renumbered), end, summary, billing months/JSON/CSV, driver `DELETE` (undo).
- **Rate guards in one statement.** An attempt row is inserted only `WHERE (SELECT COUNT(*) …) < limit`, so parallel guesses
  can't overrun the limit with a read-then-write. Sign-in takes a slot before checking the PIN and gives it back when the PIN is
  right, so only wrong tries count. The 6th try inside 15 minutes gets 429, right PIN included. Status: an unknown key takes a slot;
  the 31st lookup inside 10 minutes gets 429, **and so does every lookup from that IP, known keys included**, so a guesser can't
  tell a hit by its answer.
- **Edits can't land on an ended storm.** Route PUT, stops POST and stops DELETE carry a guard statement in their batch that
  raises if the storm has ended since it was read (the same `json()` trick as the skip guard). Route PUT also refuses (409) if the
  number of stops changed under it. DELETE also rechecks for check-ins inside the batch.
- `src/sample.js` `seedDemo`: reset, then two ended storms 13 and 6 days before now (every stop plowed with a placeholder photo,
  one "Car in the way" skip each) and an active storm started 2 hours ago (each truck's first 5 stops plowed, truck 1's 5th still
  `photo: "waiting"`, the 6th skipped "Gate locked"). Placeholders are generated SVGs ("SAMPLE placeholder photo", the stop
  name, the time), XML-escaped, stored as `image/svg+xml` and served with the CSP header.

### Verified
`npm test`: **23 unit tests pass (18 + 5 in `tests/billing.test.mjs`), 53 API tests pass (34 M1 + 19 M2), 0 fail, 0 skipped.**
New API tests: PIN change (wrong current 401, four bad `next` values 400, other sessions end, old PIN refused, new PIN works);
company GET/PUT and validation, `sample` false after renaming; **messages text exact for each kind** (status_link for a driveway
and a parking lot, on_route, plowed "6:42 AM" at 10:12Z, skipped "client cancelled"; client messages add `plowed` only when the
latest check-in is plowed); client reset-link (old key 404, new works, deactivating keeps it); trucks POST/PUT/validation/order,
an inactive truck refused at storm start but its link still answers, reset-link (old key 401); storms list newest first with
counts equal to the storm view; **route PUT** refuses a missing stop, a duplicate stop, an extra foreign truck, a swapped-in
foreign truck, a missing truck, a truck twice and a non-array; a plowed stop moved to the other truck shows at the end of that
driver's route, still plowed, and is gone from the first; an empty list is allowed; ended → 409; stops POST refusals (truck not in
the storm, already a stop, unknown, inactive) and append; DELETE refused with a check-in, even a voided one, 404 for a non-stop,
positions renumbered; ended → 409 for both; **end and summary** exact (duration "3 h 40 min", skipped with reason and time,
not_reached in route order, per-truck counts and first/last, null for a truck with no check-ins), second end 409, driver sees no
storm; **undo** at exactly 15 min → voided, stop pending, no billing, status `last` null, photo 404, `last_plowed_at` null; undo
again 200; another truck 404; plowed again after undo 201; undo 16 min after arrival → 409 with the exact text; **billing** (3 ×
$35.50 → 10650 / 1598 / 12248; a second client at $35.50 → 533, so totals hst 2131 ≠ 15% of the subtotal 2130, proving row sums;
seasonal row with pushes and 0 amounts; active seasonal client with no pushes listed; inactive seasonal client not listed);
**a skipped stop never bills**; **a voided check-in never bills** (months list empty too); **NL month boundary**
(`2026-02-01T03:00:00Z` bills in January with date `2026-01-31`, not February; no `month` at that time defaults to January);
**CSV** (content type, filename with SAMPLE and without, CRLF only, trailing CRLF, header exact, `'=SUM(A1)` guarded, `"Doe,
""Jo"" (SAMPLE)"` quoted, total row, a row per JSON row); bad month 400 on JSON and CSV; **rate guards** with `X-Test-IP`
(including "a right PIN doesn't use up a try" and "known keys never count"); **demo seed** (unknown scenario 400; 10 plowed,
2 skipped, 1 photo waiting; an SVG photo served with the CSP header; storms 13 and 6 days back each with 24 plowed and one "Car in
the way"; this month's billing has 58 pushes and a non-zero total).

Two test mistakes of mine were caught along the way, and neither was a Worker bug: a sign-in guard assertion that expected 429
and 200 at the same instant, and an "ended_label" I worked out by hand wrong (11:25Z is 7:55 AM NST, not 7:25). Both tests were fixed to the rule.

### Negative controls: all eight RED in one run of the current tree (`worker/tests/negative-control.log`)
(a)–(d) were re-run because `index.js` changed: all still red with the same breaks and outputs as in M1.

| control | break (in the copy only) | red output |
|---|---|---|
| (e) `negative:skipbill` | `src/billing.js`: `  if (checkin.kind !== 'plowed') return false` removed | ✖ a skipped stop never bills: `actual: { … name: 'Jordan (SAMPLE)' … pushes: 1 … total_cents: 4600 }, expected: undefined` |
| (f) `negative:month` | `src/billing.js`: `const bounds = monthBounds(month)` → UTC midnight bounds | ✖ NL month boundary: `actual: [ undefined, undefined ], expected: [ 1, [ '2026-01-31' ] ]` |
| (g) `negative:csvguard` | `src/billing.js`: the `if (/^[=+\-@\t\r]/.test(s)) s = \`'${s}\`` line removed | ✖ billing CSV: `actual: '=SUM(A1),"Memorial Avenue, …` vs `expected: '\'=SUM(A1),…` |
| (h) `negative:voidbill` | `src/billing.js`: `  if (checkin.voided_at) return false` removed | ✖ a voided check-in never bills: `actual: { … name: 'Chris (SAMPLE)' … pushes: 1 … }, expected: undefined` |

### Choices the contract leaves open in M2 (lead: confirm or change)
1. Error texts not given by API.md: PIN `next` "A PIN is 4 to 8 digits."; company `name` "Give the company a name (up to 80
   characters)."; `yard` (field `yard` for both) "Give the yard a name (up to 80 characters)." / "Put a pin on the map for the yard.";
   truck `name` "Give the truck a name." / "Keep the truck name under 40 characters."; truck `active` "Say whether this truck is
   active."; route PUT `trucks` "List every truck in this storm once and every stop once."; stops `client_id` "Pick one of your
   active clients." / "That client is already on the route."; `truck_id` "Pick a truck that is out in this storm."; editing an
   ended storm "This storm has ended, so it can't be changed."; route changed underneath "The route changed while you were editing
   it. Reload and try again." (409 `bad_state`); stop with check-ins "This stop has check-ins, so it stays on the route."; second end
   "This storm has already ended."; `month` "Pick a month like 2026-01."; 429 for status links "Too many wrong status links from
   here. Wait 10 minutes and try again."; seed `scenario` "The only scenario is \"demo\"."
2. **Status guard blocks known keys too** once an IP hits 30 unknown lookups (reason above). The contract only says unknown lookups
   count; it doesn't say whether a known key from a blocked IP still answers.
3. **Summary per-truck `first_label`/`last_label`** come from the non-voided check-ins *made by* that truck (`checkin.truck_id`);
   `plowed/skipped/pending` count the stops *on* that truck now. After a stop moves between trucks the two can differ.
4. **"A check-in with voided ones still counts as having check-ins"**: DELETE of a stop is refused if it has any check-in, voided
   included, as API.md says ("no check-ins at all").
5. `POST …/stops` answers **200** with the Storm (API.md gives no 201 for it). Undo leaves the R2 photo in place; `GET` answers 404.
6. PIN change doesn't count wrong `current` tries toward the sign-in guard (the caller already holds a session).
7. The demo's ended storms have placeholder photos on every plowed stop too, so a client whose last push was days ago still has a
   photo on the status page.

### Known gaps
- A check-in racing a stop DELETE could, in a tiny window, insert a check-in for a client that was just removed from the route
  (the check-in insert checks the stop by reading first). The owner would see it in billing and not on the route. Closing it needs
  the check-in batch to carry a stop-exists guard; say if you want it.
- Billing reads every client and a padded month of check-ins per request: fine for one contractor, not for a fleet.

## M3: DONE

Merged main first (`git merge --ff-only main` → 2a9deca: API.md clarifications 12–16). Code commits `f87d1e5` (the two fixes, tests,
controls) and `ec5afb1` (log header only). All ten controls were re-run on `ec5afb1`.

### (1) Clarification 15: a check-in and a removal of the same stop, exactly one wins
- **Check-in:** its batch now starts with `STOP_GUARD_SQL`, a `json()` guard that raises if the client isn't a stop of that storm
  when the batch commits. The earlier read stays (it gives the plain 404 fast), but it no longer decides. On a guard refusal
  the Worker checks again: a stored id means duplicate (200), a missing stop means 404 "That client is not a stop in this storm.",
  otherwise 409 `already_plowed`.
- **Removal:** its batch already carried the "has check-ins" guard (409 "This stop has check-ins, so it stays on the route."). One
  more fix the race test found: removal renumbered positions from the position it had **read**, so several removals at once left
  gaps. It now renumbers inside the batch from a window-function snapshot
  (`UPDATE storm_stops SET position = r.rn FROM (SELECT … ROW_NUMBER() OVER (PARTITION BY truck_id ORDER BY position, client_id) …)`).
  My first try, a correlated `COUNT(*)` in the `UPDATE`, was also wrong: it reads rows the same statement has already rewritten.
  The guarded run of the control (all ten removals winning at once) caught it before commit.
- Tests: "stops: a check-in after the removal answers 404; a removal after the check-in answers 409" (exact texts, no stored row,
  the kept stop still on the route). "stop race": 10 pairs, each a check-in with its removal fired 5 ms later; asserts 0 check-ins
  on removed stops (raw rows via `/api/test/checkins`), exactly one winner per pair (201/409 or 404/200), positions 1..n per truck.
  It prints `STOPRACE orphans=N outcomes=…`. On the shipped code with no added gap, every pair ends 201/409 (the check-in finishes
  first), which is why the control below widens the gap.

### Negative control (i) `negative:stoprace`: RED, honest
- **Both runs** of the copy get `await scheduler.wait(25)` between the check-in's read of the stop and its write (setup patch before
  `// TIME-RULE:`). So the passing run isn't passing just because the gap was tiny: with the guard kept and the same 25 ms gap, **0 of
  10** check-ins landed on a removed stop, every pair ended 404/200 (all ten removals won), and positions stayed 1..n.
- **Break:** the `stmts.push(db.prepare(STOP_GUARD_SQL)…)` line removed, so the check-in trusts its earlier read. **10 of 10**
  check-ins landed on removed stops (`actual: 10, expected: 0`). They also answered **500**: the Worker then builds the stop view for
  a client that isn't on the route. That's one more reason the guard belongs in the batch.
- Exit 0 only if the guarded copy shows 0, the broken copy shows ≥ 1, and the test goes red. Took well under the 30-minute time box.
- **Not proven by a race:** the other ordering (the removal reads "no check-ins", then a check-in commits, then the removal writes).
  The removal's in-batch guard handles it, but the control only widens the check-in's gap. A second control would need a wait inside
  the removal path. Say if you want it.

### (2) Clarification 16: wrong current PINs on `PUT /api/owner/pin` count toward the sign-in guard
- PIN change takes a slot with the same one-statement `takeAttempt` as sign-in (5 per 15 min per IP), before checking `current`.
  A right `current` gives the slot back **at once**, before `next` is validated. The first version gave it back only after the whole
  change went through; M2's PIN test then got 429 (one wrong PIN plus four right-PIN-bad-`next` tries used all five slots). That
  was a Worker bug, fixed in the Worker; the test was left as it was.
- Test "PIN change: wrong current PINs count toward the sign-in guard, then 429 even for the right PIN, per IP": 5 wrong → 401 ×5,
  then the right current → 429 and sign-in from that IP → 429; 3 wrong sign-ins + 2 wrong changes share the 5 tries; another IP
  changes the PIN (204) and signs in with the new one.
- **Negative control `negative:pinguard`: RED** (`actual: 204, expected: 429`). Break: in the copy, the PIN change's
  `takeAttempt` call and its 429 are replaced by `const attempt = 0`. Not redundant with the sign-in guard: PIN change calls the
  shared helper on its own path, and no other control removes that call.

### Log header
Each section of `worker/tests/negative-control.log` now starts with the short sha: `=== ec5afb1 negative:stoprace <time> ===`.
`+uncommitted worker changes` follows the sha when files under `worker/` (other than the log itself) differ from that commit. The
M3 development runs on 2a9deca are marked that way.

### Verified
`npm test`: **23 unit tests pass, 56 API tests pass (53 + 3 new), 0 fail, 0 skipped.** Negative controls on `ec5afb1`: **all ten RED**
(a twoopt, b tiers, c idempotent, d time, e skipbill, f month, g csvguard, h voidbill, i stoprace, pinguard); no machine paths in the log.

## Cross-review of sr2 M1 app code

Read only, on 6df5a27 (sr2 M1 merged at 110f190): `app/public/api.js`, `app/public/ui.js`, `app/public/d/queue.js`,
`app/public/d/driver.js`, `app/public/s/status.js`, against docs/API.md (clarifications 1–16) and `worker/src/index.js`. No code changed,
no server run. Not re-reported: the 429 being filed as a refusal and the refused photo (clarification 11).

### Findings (most harmful first)

**R1. A dead driver key blocks every later check-in on the phone (high).** `app/public/d/queue.js:87` stops the whole send loop on a 401
(`return failed('unauthorized')` → `flush()` breaks at `queue.js:134`), and `queue.js:125,133` always retries the **oldest** item first,
whatever its `key`. What breaks: the owner taps "New link" for a truck while that phone still has check-ins queued under the old key
(the case DECISIONS 18 is about). The driver opens the new link and keeps working, but every new check-in sits behind the old items,
whose key the Worker now refuses at `worker/src/index.js:250`. Nothing from that phone reaches the server again, the new page shows
the 401 text "This driver link doesn't work any more" on a link that does work (`driver.js:142-143` reads the sender's shared
`problem`), and the old items are hidden from the new page (`driver.js:58`, `driver.js:129` filter on the current key). For whom: the
driver (a night of plowing never syncs), then the owner (billing and status links miss those pushes) and clients (status stays "on
the route"). Suggested direction (sr2 / lead to choose): skip items whose key got 401 and go on to the next item, and decide whether
items under a dead key may be resent with the page's current key. The check-in id makes a resend safe, and the Worker accepts a
check-in "whichever truck the stop is on now".

**R2. A mangled status link shows "There's nothing here." instead of the bad-link text (medium).** `app/public/s/status.js:246-248` shows
`e.message` for any 404. The Worker has two 404s: the status handler's text, and the router's generic "There's nothing here."
(`worker/src/index.js:1022`), which answers any key outside `[A-Za-z0-9_-]{1,128}` (`index.js:987`). Messaging apps often glue
punctuation or `%20`/`)` onto a pasted link, so `…/s/?k=abc123.` reaches the router 404. For whom: the client, who gets a dead-end
message that doesn't say to ask the company for a new link. Two ways to fix: the app shows its own `BAD_LINK` text for every 404 on
this page (sr2), or the Worker sends every `/api/status/*` path to the status handler (sr1; say if you want that instead).

**R3. After a 404 the status page keeps asking on every return to the tab, and each ask counts toward the per-IP guard (low-medium).**
`status.js:247` clears the 60 s timer on 404, but `status.js:257` still calls `check()` on every `visibilitychange`, and each unknown-key
lookup takes a slot (`worker/src/index.js:553-558`, clarification 12: 30 per 10 min, then **the whole IP** gets 429, known keys included).
For whom: every client behind the same public IP. That's one household's Wi-Fi, and on mobile data the carrier often shares one IP
across many phones. One stale bad-link tab being switched to repeatedly can make good links answer "Too many wrong status links from
here" for everyone behind that IP. Fix in the app: stop checking after a 404. **For the lead:** carrier-grade NAT makes a per-IP guard
blunt for this page; worth a line in DEPLOY.md, or a softer rule (for example, block only unknown keys) if it bites.

**R4. Undo on a check-in the server already refused throws away the refusal and queues an undo that can only fail (low-medium).**
`app/public/d/driver.js:343-349`: `undo()` treats any item that isn't `send` as "on the server". An item in `rejected` (for example 409
`already_plowed` because the other truck got there first, answered inside the 15 s Undo window) is removed from the phone at
`driver.js:346`, and a `void` is queued. The Worker answers that DELETE 404 "We couldn't find that check-in."
(`worker/src/index.js:933`), so "Not accepted" now shows an **Undo** with that text, and the real reason ("This stop is already marked
plowed.") is gone. For whom: the driver and owner, who lose the one message that explains what happened. Fix: for a `rejected` item,
Undo just removes it locally (or stays hidden), with no `void`.

**R5. A queued check-in for a stop that moved to another truck vanishes from the screen (low).** `driver.js:59-60` skips any queued item
whose `client_id` isn't in this truck's route (`if (!s) continue`). After the owner moves a stop (route PUT) and the phone reloads its
route, a check-in still waiting under this key shows only as a count in the strip. The Worker still accepts it (API.md: "whichever
truck the stop is on now"), so no data is lost, but the driver can't see or undo what's waiting. For whom: the driver. Fix: list such
items in the stop list or a small "saved for other stops" row.

### Checked and consistent (no action)
- **Check-in body** (`driver.js:316-317`): `id, storm_id, client_id, kind, note, at, has_photo`, `reason` only on a skip; `note` trimmed
  and cut to 120 before sending (the Worker counts code points, the app's `slice` counts UTF-16 units, so the app never exceeds the
  limit); `at` from `toISOString()` passes the Worker's ISO check; `uuid()` fallback (`ui.js:120-127`) sets the v4 version and variant bits.
- **Answers:** 201 and 200 `duplicate` both remove the item and use `data.stop` (`queue.js:103-113`); a phone-side undo while the POST was
  in flight queues the `void` (`queue.js:105-109`); 409 `already_plowed`, 400 and 404 go to "Not accepted" with the server's `error`
  (`queue.js:114`); 5xx and network errors keep the item (`queue.js:83-86`); a non-JSON 5xx body is handled (`api.js:45-48`). Undo `DELETE`
  200 uses `data.stop` (`queue.js:89-92`); 409 "Too late to undo" goes to "Not accepted" (the Worker allows 15 min from `received_at`,
  `index.js:935`; the app offers Undo for 15 s).
- **Photo PUT** (`api.js:68`, `driver.js:357-373`): raw JPEG bytes with `content-type: image/jpeg`, at most 1600 px at quality 0.7, well
  under 5 000 000 bytes; a photo that can't be read falls back to "Plowed, no photo".
- **Fields read:** Stop `position, name, address, notes, priority, priority_label, opens_at, type_label, status, checkin.{id, kind,
  reason_text, at_label, photo}`; route `company.{name, sample, timezone}, truck.{id, name}, storm.id`; status `client.{address,
  type_label}, last.{at_label, time_label, photo_url, photo_waiting}, tonight.{state, stop_number, stops_done, reason_text}, server_now`.
  All are in the Worker's answers with the same names and types.
- **Labels (clarification 1):** `ui.js:90-92` builds `hour:minute dayPeriod` from `formatToParts`, so a queued check-in reads "6:42 AM"
  with a plain space, the same as the Worker's `at_label`, in the company's zone (`driver.js:49`). `status.js:207` takes the day from
  `at_label` ("Mon Jan 12, 6:42 AM" → "Mon Jan 12"), which matches the Worker's full label.
- **Headers:** `X-Driver-Key` on every driver call (`api.js:58`); JSON calls send `content-type: application/json`; the Worker needs no
  other header. The photo `<img>` carries `referrerpolicy="no-referrer"` (`status.js:210`).

## M4: DONE

Merged main first (`git merge --ff-only main` → bc8e3c3: API.md clarifications 17–20, DECISIONS 29–31). Code commit `3e425fb`.

### What changed (Worker half of clarification 18)
- The status route is now `^/api/status/(.*)$`, so **every** `GET /api/status/<anything>` reaches the status handler, the empty key
  included. The old pattern `([A-Za-z0-9_-]{1,128})` sent anything else to the router's generic 404 "There's nothing here.", which never
  counted toward the guard.
- In the handler, a key that can't be a key (not 1–128 of `A-Z a-z 0-9 _ -`) is treated as unknown without a database lookup. It
  goes through the same path as any unknown key: the guard check first (429 once the IP has 30 inside 10 minutes), then a guard slot,
  then 404 "This status link doesn't work. Ask your snow clearing company for a new one."
- `/api/status` with no slash still gets the router 404. It isn't a status link the app ever builds.

### Verified
`npm test`: **23 unit tests pass, 57 API tests pass (56 + 1 new), 0 fail, 0 skipped.** New test "status link: a mangled key answers the
status 404 text and counts toward the unknown-key guard": a valid key with `.`, `)` or `%20` glued on, the empty key, 129 characters,
and a valid key with 200 characters added each answer 404 with the exact status text (and `Cache-Control: no-store`). Those 6 plus 24
more mangled lookups from one IP reach 30; the 31st (`%20`) answers 429, a **known** key from that IP answers 429, and the same known key
from another IP answers 200.

### Negative control `negative:statusroute`: RED
Break: in the copy, the status route pattern goes back to `^/api/status/([A-Za-z0-9_-]{1,128})$`. Red output: `actual: "There's nothing
here.", expected: "This status link doesn't work. Ask your snow clearing company for a new one."`. All **eleven** controls (a–i,
pinguard, statusroute) were re-run on `3e425fb`: all RED, each log section starting with `=== 3e425fb …`, no machine paths in the log.

## Cross-review of sr2 M2 (in progress, 4a8c8ba)

Read only through git (`git diff 110f190 4a8c8ba -- app/`, `git show 4a8c8ba:<path>`), never sr2's worktree. Checked against docs/API.md
(clarifications 1–20) and `worker/src/index.js` as merged (line numbers from 7ca9f24). No code changed, no server run. Files:
`app/public/owner/owner.js`, `app/public/owner/index.html`, the `api.js` / `d/queue.js` / `d/driver.js` changes since M1, and
`app/tests/{helpers,start-worker,owner.spec,driver.spec,offline.spec,status.spec,targets.spec}.mjs`. Clarifications 17–20 are sr2 M3 work, so
their absence here isn't a finding; only what this commit changes is measured against them.

### Findings (most harmful first)

**M2-1. The owner 401 handler will sign the owner out on a mistyped current PIN (medium, lands with Change PIN in sr2 M3).**
`app/public/api.js:65-71` (`owner()`) treats **every** 401 on an owner route as a dead session: it clears the token (`:70`) and fires
`SIGNED_OUT` (`:71`), which replaces the page with the sign-in form. But the Worker answers `PUT /api/owner/pin` with a wrong `current` as
**401 `unauthorized` with `field: "current"`** (API.md, `worker/src/index.js:632`) while the session stays valid on the server. Today no page
calls that route, so nothing breaks yet. Once Settings → Change PIN is built on `owner()`, one typo in "current PIN" throws the owner out
of a working session, loses what they typed, and hides "That PIN is not right." behind "Please sign in again". For whom: the owner.
Suggested rule for sr2: a 401 **with a `field`** is a form error shown by that field; only a 401 **without** `field` means the session
ended. (Wrong current PINs also count toward the sign-in guard, clarification 16, so the page should show a 429 there as a message, not a
sign-out.)

**M2-2. The Undo spec can skip itself on the exact failure it should catch (medium, test honesty).** `app/tests/driver.spec.mjs:59-61`
probes `DELETE /api/driver/checkins/<zero uuid>` and calls `test.skip` when the answer is 404 with the router's text "There's nothing here.".
That made sense before sr1 M2 was merged. Now it means a Worker that **lost** the undo route (a bad merge, a router typo) would show as
*skipped*, not red, and "Undo puts the stop back to pending" would silently stop being measured. With the route present the probe answers
404 "We couldn't find that check-in." (`worker/src/index.js:937`), so the skip never fires today. For whom: the lead's pinned QA, where a
skip can pass for green. Fix: remove the probe and the skip, since sr1 M2 is on main.

**M2-3. A storm started elsewhere leaves the owner on a dead picker (low-medium).** `app/public/owner/owner.js:201-204`: a failed
`POST /api/owner/storms` shows the error by the field or in `#form-error` and re-enables "Build tonight's route". A **409 `bad_state`**
"A storm is already on. End it before starting another." (`worker/src/index.js:376`) happens when the storm was started from another
device (the owner's phone and a desktop), or in another tab. The owner then sees the refusal but stays on the picker with no way to the
running storm except switching tabs, and pressing Build again only repeats the 409. For whom: the owner with two screens, on a storm night.
Fix: on 409 `bad_state`, clear `state.picking` and call `renderTonight()` (which loads the current storm).

**M2-4. Some ordinary price entries are refused (low).** `app/public/owner/owner.js:30-32` (`dollarsToCents`) accepts `45`, `45.5`, `45.50`
and `$1,200.00`, but `/^\d+(\.\d{1,2})?$/` refuses `.50` and `45.`, sending `price_cents: null`, so the owner gets "Type a price in dollars and
cents." for a price they typed in dollars and cents. For whom: the owner typing on a phone keypad. Fix: allow `\d*\.\d{1,2}` and a
trailing dot. Conversion is otherwise right: `Math.round(Number(t) * 100)` fixes float error (`0.29` → 29), and the Worker still enforces
0–10 000 000.

**M2-5. Note for clarification 17 (sr2 M3): re-keying must stay on the same truck for photos and undos (low, forward-looking).** The
Worker only accepts a photo PUT and an undo DELETE from the truck that made the check-in (`worker/src/index.js:517` photo, `:937` undo; both
404 otherwise). A pending `photo` or `void` item re-keyed to a *different* truck's key (one phone used by two trucks' drivers) will get 404.
With `app/public/d/queue.js:102` a photo 404 drops the photo (clarification 11), and a void 404 goes to "Not accepted". New check-in POSTs
re-keyed to another truck are fine: the Worker records the sending truck. For whom: the driver who shares a phone. Suggest sr2 re-key only
check-in items, or only items under a dead key of the **same** truck (the old key's route answer carried `truck.id`).

**M2-6. Nit: the faked 500 in the offline spec still carries the old 500 text.** `app/tests/offline.spec.mjs:98` fulfills
`{ error: 'Something went wrong on our side. Please try again.' }`; clarification 6 made it "Something went wrong on our side. Try again in
a minute.". The spec asserts the strip, not this text, so nothing fails. Worth matching so the fake stays a faithful copy of the Worker.

### Checked and consistent (no action)
- **Sign-in:** uses `call()`, not `owner()` (`api.js:84`), so a wrong PIN (401 `field: pin`) and a 429 stay on the form with the API's text
  (`owner.js:87-88`); the token goes in `localStorage` `snow-route:owner-token`; sign-out answers 204 with an empty body, which `send()`
  handles (`data` null). An expired token on page load → the first owner call answers 401 → the sign-in form with "Please sign in again."
- **Client POST/PUT bodies** (`owner.js:417-423`): every field in the API table, `active` always sent (PUT needs it), `opens_at` `null` when
  the time input is empty, `truck_id` as a number or `null`, `lat`/`lng` `null` without a pin (→ 400 field `lat`, shown at `#err-lat`, also
  exercised by `owner.spec.mjs:38-42`). Field errors land on `#err-<field>` for name, address, type, priority, opens_at, notes, billing,
  price_cents, truck_id; `active` falls back to `#form-error`. The pin is rounded to 5 decimals (`owner.js:25`, `:363`, `:387`); the Worker's
  NL box check refuses a pin dropped outside Newfoundland and Labrador.
- **Lists:** clients with `?include_inactive=1` (active first, as the Worker sorts), trucks (active first), the picker ticks active ones only.
- **Storm start body** (`owner.js:195-198`): `client_ids` and `truck_ids` as number arrays in list order; `err-client_ids` / `err-truck_ids`
  match the API's field names. **Storm reading** (`owner.js:214-262`): `name, started_label, counts.{plowed, skipped, pending}, order_note,
  trucks[].{id, name, stops[]}` and Stop `client_id, position, name, address, lat, lng, priority, priority_label, status, checkin.{at_label,
  photo, reason_text}`, all present with those names in the owner view. `messages` isn't read yet (sr2 M3).
- **Clarification 11:** a 429 is now a failure that keeps the item (`queue.js:88`); a photo refused 404/413/415 removes the item and shows
  "Photo not sent: <server message>" on the stop row (`queue.js:102`, `driver.js` `statusLine`); other photo answers retry (`queue.js:106`).
  Resetting backoff on `online` (`queue.js:171`) is harmless to the Worker.
- **Specs and the API:** state set through the API (storm start, sign-in token, raw `/api/test/checkins` counts) is arranging and reading
  data, and each such step also has a UI test that does it through the page (`owner.spec.mjs` starts a storm and adds a client by tapping the
  map). Every test resets first, which also clears the rate-guard table, so the e2e suite's shared 127.0.0.1 never trips the sign-in or status
  guards. `offline.spec.mjs` pins the server clock with `X-Test-Now` on the page's own requests and checks `at` / `received_at` / `at_adjusted` on
  the raw rows, which matches the Worker's time rule. `status.spec.mjs:46` uses a key-shaped unknown key; since sr1 M4, a mangled key gets the
  same text too.
- **Headers:** `Authorization: Bearer` only on owner routes, `X-Driver-Key` only on driver routes, JSON content type on bodies.

## M5: DONE

Merged main first (`git merge --ff-only main` → 69076b5, sr2 M2 merged). Code commit `035401f`. These are the two points from sr2's review
of my M1 (`rig/sr2:docs/build-report-sr2.md`, "Mismatches and gaps" 1 and 2).

### (1) Clarification 10: a plowed check-in stores no note and no reason
- sr2 was right: `checkinInput` nulled `reason` for plowed but kept `note.trim()`, and even refused a plowed check-in whose note was over
  120 characters. Now `note` is `''` for a plowed check-in whatever the body sends, and its note isn't validated (it's ignored, so it
  can't be refused). A skip keeps its trimmed note and the 120-character rule.
- Two M1 tests encoded the old behaviour and were changed to the contract: "check-ins: plowed 201" now expects `note: ''` for a body
  sending `note: 'Done.'`, and the "note over 120" refusal is now sent on a skip.
- New API test "check-ins: a plowed check-in stores no note and no reason, whatever the body sends": a plowed body with `note` and
  `reason: 'gate'` → 201, answer and **raw stored row** both `note ''` and `reason null`, owner view `note ''`; a plowed body with a 500-character
  note → 201 with `note ''`; a skip with `'  Truck blocking  '` keeps `'Truck blocking'` and `reason_text` "Other: Truck blocking".
- **Negative control `negative:plowednote`: RED.** Break: `const note = plowed || body.note === undefined …` → `const note = body.note ===
  undefined …`. Red output: `actual: 'Left a note', expected: ''`. It's a separate control because no other test looks at the note stored on a
  plowed check-in, so no existing control could turn red for this.

### (2) The 500 text
- **Confirmed:** on main the unexpected-failure answer was already exactly `{ "error": "Something went wrong on our side. Try again in a
  minute.", "code": "server_error" }` (since M2, clarification 6). sr2's point 2 was measured against my M1 commit.
- **One text did still say "Please try again":** the 400 for an unreadable request body ("That request could not be read. Please try
  again."). A malformed body won't read better on a retry, so it now says **"That request could not be read."** Lead: a one-line
  clarification if you want different wording.
- New unit tests: the 500 answer's exact body and `Cache-Control: no-store` (a database stub that throws); the unreadable-body 400's exact
  body, answered before the database is touched; a scan of every `worker/src/*.js` for "Please try again" that finds nothing, and is
  shown in the same test to catch the old line.

### Verified
`npm test`: **26 unit tests pass (23 + 3 new), 58 API tests pass (57 + 1 new), 0 fail, 0 skipped.** All **twelve** negative controls (a–i, pinguard,
statusroute, plowednote) re-run on `035401f`: all RED, each log section starting with `=== 035401f …`, no machine paths in the log.

### For sr2 (nothing for sr1 to change)
`app/tests/offline.spec.mjs:98` still fakes the 500 with the old text (my M2-6 note); with the Worker text confirmed above, the fake can
copy it exactly.

## Cross-review of sr2 M3a (38cc37e)

Read only through git (`git diff 69076b5 38cc37e -- app/`, `git show 38cc37e:<path>`), never sr2's worktree. Checked against docs/API.md
(clarifications 1–25) and `worker/src/index.js` (line numbers from main after M5). No code changed, no browser or server run: the
findings come from reading the code paths end to end, and each names the path so sr2 can confirm or refute it with a spec.

### Findings (most harmful first)

**M3a-1. Two open tabs can void a real push that nobody undid (high; the race predates M3a, and M3a makes two tabs likelier).**
`app/public/d/queue.js:138-144`: after a 200 or 201 the sender checks `await get(item.qid)`, and a **missing** item is read as "undone on the
phone while this check-in was on its way", so it queues a `void` (a DELETE). But every tab of the driver page runs its own sender over the
**same** IndexedDB store, and each sender removes an item once it's sent (`queue.js:146`). With two tabs sending at once, tab A's POST gets
201 and removes the item; tab B's POST of the same id gets 200 `duplicate` (the Worker's idempotency, `worker/src/index.js:511`), finds the
item gone, and queues a DELETE. The Worker accepts that undo within 15 minutes of `received_at` from the same truck (`index.js:932-941`),
so the push is **voided**: the stop goes back to pending, it never bills, the status page loses it, and nobody tapped Undo.
- **When two tabs happen:** a driver taps the link from a text again while an old tab is open (phone browsers keep tabs, and hidden tabs
  still get `online` events), and **clarification 17's own flow**: the old-link tab is still open when the driver opens the new link from
  the owner. After re-keying, both senders see items under the new key (the old tab's sender sends whatever key the item now carries,
  `queue.js:103-105`).
- **The Worker's side is harmless:** the same check-in under two keys, or twice under one, is one row (201 then 200). Only the app's
  "missing means undone" inference turns the duplicate into an undo.
- **For whom:** the owner (a push that happened doesn't bill), the client (status says not plowed), the driver (sees the stop pending again
  after reload).
- **Suggested fix (sr2):** make an undo explicit instead of inferring it. When Undo takes back an item that may be in flight, mark it
  (`state: 'undone'`) rather than deleting it, and queue the DELETE only for that mark. Or run one sender per origin (`navigator.locks`
  / BroadcastChannel). A spec with two pages of the same link sending one check-in would catch it.

**M3a-2. An undo the sender made itself gets stuck on the right truck after a link reset, and is never sent (medium).** `queue.js:143`
creates the in-flight undo `add({ qid: 'void:…', op: 'void', key: item.key, … })` **without `truck_id`**, so `rekey()` falls back to
`truckOf(item.key)` (`queue.js:80`). That lookup reads the saved route whose `key` matches (`driver.js:50`), but the route is saved under the
**truck id** (`driver.js:46`), so opening the new link overwrites the old key's entry for the same truck. The old key then maps to `null`,
`null === page.truckId` is false, and the undo is marked `stuck`. It's listed as "This undo belongs to another truck's link, so this link
cannot send it." (`driver.js:312`), which isn't true, with only "Remove from this phone". The check-in the driver undid stays plowed and
billed. Items saved before M3a (no `truck_id`) hit the same path for photos. For whom: the driver (misleading words, an undo that can't
happen) and the owner (a push billed that the driver took back). Fix: give that `add` the `truck_id` of the item it undoes. Also consider
keeping a key → truck map that the route cache doesn't overwrite.

**M3a-3. After End storm, queued check-ins are listed as "The owner moved these stops off this route", with an Undo that throws away real
work (medium-low).** `driver.js:87` (`elsewhere()`) includes every queued check-in when `route.storm` is null or a different storm, and
`driver.js:327` explains all of them as moved stops. The Worker accepts check-ins after the storm ends (API.md; clarification 9 in
DECISIONS), so a truck that syncs after the owner taps End storm sees real, still-sending plowed stops labelled "moved off this route",
each with **Undo** (`driver.js:430-431`: an unsent item is simply deleted from the phone). For whom: the driver, who may tidy away
"moved" entries and lose pushes before they reach the server, and the owner who then doesn't bill them. Fix: separate wording for "the
storm has ended" / "an earlier storm" ("Saved from the storm that ended, still sending"), and ask before an Undo that deletes an unsent
check-in.

**M3a-4. Clarification 24's cross-truck rule has no test and no negative control (medium-low, test honesty).** `app/tests/queue.spec.mjs`
covers a same-truck link reset (check-ins only), a moved stop, and Undo on a refused check-in. No spec saves a **photo** or an **undo**
under one truck's key and opens **another** truck's working link. `negative-relink.mjs` breaks only the 401 handling (M1 behaviour), so
a copy whose `rekey()` ignored the truck check (`queue.js:80`) would pass the whole suite while sending photos and undos to a truck that
answers 404 (`worker/src/index.js:939` for undo; the photo route checks the same). Clarifications 19 and 20 are tested but have no negative
control either. For whom: the lead's QA, which can't tell the rule from its absence. Suggest a spec (truck 1 link: plowed with a photo, the
photo PUT held; truck 1's link reset; open truck 2's link → the photo row shows "belongs to another truck's link", no PUT reaches the
Worker under truck 2's key) plus a control removing the truck comparison.

**M3a-5. A photo dropped for a stop that moved to another route leaves no visible trace (low).** `queue.js:129-131` removes the item and
calls `onPhotoDropped`; `driver.js:593` stores the note and `driver.js:267` shows "Photo not sent: …" **only on a stop row of this route**.
For a check-in listed under "Saved for stops on another route" the item disappears with its row, and the note has nowhere to show.
Clarification 11 asks for the message on that stop's row. For whom: the driver (and the owner, who sees a plowed stop without a photo
and no reason). Fix: keep a short "Photo not sent" row in the other-route section.

**M3a-6. The storm-start 409 notice can surface much later, on the wrong storm (low).** `owner/owner.js:204-207` puts the API message in
`state.stormNotice` and calls `renderTonight()` (`owner.js:125`). If that storm ended in the meantime, `renderTonight` shows "No storm on
right now." (`owner.js:133`) and never paints the notice, which is only consumed by `paintStorm` (`owner.js:223`). The next storm started
on that screen then opens with "A storm is already on. End it before starting another." above it. For whom: the owner, confused on the
next storm night. Fix: clear `stormNotice` when `renderTonight` finds no storm (or show it there).

**M3a-7. Nit: a re-keyed check-in whose stop isn't on this route appears twice** — once under "Saved under an old driver link"
(`driver.js:301`, because `rekeyed_from` is set) and once under "Saved for stops on another route" (`driver.js:87`), with Undo only in the
second. The strip counts it once. Cosmetic, but it makes the two lists harder to read.

### Answers to the lead's questions
- **How a dead key is detected:** only by a **401** on an item sent under that key (`queue.js:111-115`), kept in an in-memory set that a
  reload empties. After a reload, items under the old key are sent once more, get 401 again, and are re-learned; that costs one refused
  request per dead key per page load and is harmless to the Worker. A page learns its **own** key works only when its route loads
  (`driver.js:612`), and only then re-keys (`queue.js:76`). The Worker gives 401 only for an unknown or reset key (`index.js:250`), so there are
  no false positives.
- **Sent to a truck that answers 404?** Check-ins: no, the Worker accepts a check-in from any truck. Photos and undos: not while `truck_id`
  is right (`queue.js:80`); see M3a-2 for undos made without it (they're stuck rather than sent, so still no 404) and M3a-4 for the missing
  test.
- **Dropped without a visible row?** M3a-5 (a dropped photo for a moved stop), and M3a-3's Undo deletes unsent work from a row whose words are
  wrong. Stuck items stay listed with Remove (`driver.js:312`), so they aren't silent.
- **The same check-in under two keys at once?** Within one tab, no: one sender, `busy` guards it, and re-keying happens between steps. Across
  tabs, yes (M3a-1). The Worker makes the duplicate POST harmless (one row, 201 then 200 `duplicate`), and a repeated photo PUT only rotates
  the photo token (clarification 8). The harm is the app's undo inference, not the Worker.

### Checked and consistent (no action)
- **Owner 401 rule** (`app/public/api.js:70`): a 401 with `field` stays a form error, one without signs out. The Worker's session refusal
  carries no `field` (`worker/src/index.js:244`), and the only owner-side 401s with a field are a wrong current PIN (field `current`) and
  sign-in (field `pin`, which goes through `call()` anyway). `owner.js` form handlers now only bail out on a field-less 401.
- **Storm-start 409:** the picker closes and the running storm is painted with the API's message (`owner.js:204-207`), tested in
  `owner.spec.mjs` with the real 409 from a storm started through the API (M3a-6 is only about a storm that ended in between).
- **Price parsing** (`owner.js:31-32`): `45`, `45.5`, `45.50`, `.50`, `45.`, `$1,200.00`, `1,200,000` accepted; `4.5.0`, `12,50` (a
  European decimal comma is not silently read as 1250), `-5` refused on the form with the API's wording before sending (`owner.js:434`).
  `Math.round(Number(t) * 100)` avoids float error, and the Worker still enforces 0–10 000 000. The spec checks `.50` → 50 and `45.` → 4500
  through a real edit, and that no PUT is sent for `4.5.0`. Nit: `$ 45` (a space after the dollar sign) is refused.
- **Status page (clarification 18):** any 404 shows the page's own text and sets `stopped`, which both the interval and the
  `visibilitychange` listener honour (`status.js:69`, `:79-82`, `:91`). The interval is now created before the first check, which fixes an M2
  ordering where an immediate 404 cleared a timer not yet set. A 429 isn't a 404: the page keeps its 60 s poll, and the Worker doesn't count
  a blocked lookup toward the guard, so it recovers after 10 minutes. The spec proves the listener fires on a good link before relying on
  "no lookup after the 404".
- **queue.spec "a truck link reset"** measures what it claims: the owner resets the key first, so the page's first POST (old key) must get
  401 before anything can reach the database; both rows are then asserted with `at = T`, `received_at = T + 40 min` and the truck. The relink
  control restores M1's stop-on-401, which leaves both items unsent. "Undo on a check-in the server refused" watches for any DELETE from the
  start of the test, and a wrongly queued undo would be sent within the 500 ms wait because undo calls `flush()`.
- **The `@phone` tag** replaces `test.skip` for phone-width checks with a project filter (`playwright.config.mjs`), in line with clarification
  25; the removed self-skip in `driver.spec.mjs` closes my M2-2.

## Cross-review of sr2 M3b (in progress, 7a9876c)

Read only through git (`git diff 5f162b2 7a9876c -- app/`, `git show 7a9876c:<path>`), never sr2's worktree. Checked against docs/API.md
(clarifications 1–31) and `worker/src/index.js` (main after M5). No code changed, nothing run. Files: `app/public/owner/owner.js`,
`app/public/api.js`, `app/public/style.css`, `app/playwright.config.mjs`, `app/tests/{route-edit,storm-end,billing,settings,copy}.spec.mjs`,
`app/tests/negative-billing.mjs`.

### Findings (most harmful first)

**M3b-1. A route edited from a stale list gets the wrong refusal, and the spec accepts it (medium; the root cause is in sr1's Worker, and
the fix needs the lead's call).** A stop added (or removed) on another screen changes the storm's stop set. The page's next Move up / Move
down / Move to / drag sends the old lists (`app/public/owner/owner.js:437-445`). My Worker checks the body against the stored stop set
**before** its race guard, so it answers **400 `bad_request` field `trucks` "List every truck in this storm once and every stop once."**
(`worker/src/index.js:749`, `:763`). The 409 "The route changed while you were editing it. Reload and try again." (`:768`, `:779`) only fires
in a true race between that read and the write. The page handles both the same way (`owner.js:451-453`: reload and show the API's message),
so the owner, after a stop was added from their phone, reads "List every truck in this storm once and every stop once." That's a message
about a malformed request, with nothing telling them the route changed elsewhere. `app/tests/route-edit.spec.mjs:98` accepts `[400, 409]`
and checks only that the notice equals whatever the API said, so it can't tell the right answer from the wrong one. For whom: the owner
on two screens, on a storm night.
**Proposal (sr1, if the lead agrees):** when the body is well formed (each listed truck belongs to the storm, no truck or stop twice, only
integers) but its stop set differs from the stored one, the Worker answers **409 `bad_state` "The route changed while you were editing it.
Reload and try again."**, and keeps 400 for malformed bodies (duplicates, foreign trucks, non-arrays). Then the spec should require 409 and
that exact text. This is a contract change (API.md says 400 field `trucks` when a stop is missing), so I haven't touched it.

**M3b-2. The billing spec can't catch a page that recomputes money, because no HST in its data needs rounding (medium-low, test honesty).**
`app/tests/billing.spec.mjs` bills Pat (4500) and SAMPLE Clinic walkway (5000). Their HST is 675 and 750, exact. A page that computed amounts
itself in floating point would show the same numbers and pass. For example `Math.round(amount * 0.15)` gives 532 for 3550 (3550 × 0.15 is
532.4999…) where the API's half-up integer rule gives **533**. `negative-billing.mjs` breaks only the pushes cell, and its red comes from the
seasonal client's stop count. The page today does read every money cell from the API row (`owner.js:969-979`), but the check doesn't
measure "never recomputed" for amounts, HST or totals. For whom: the lead's QA and, through it, the accountant. Suggest giving one plowed
per-push client the price 3550 before the storm (one `PUT /api/owner/clients/:id` in arrangement, which is data, not UI state) and
asserting its HST cell reads `$5.33`, plus a control whose break recomputes HST with `Math.round(amount * 0.15)`.

**M3b-3. The CSV check would pass for a page that builds the CSV itself (low-medium, test honesty).** `billing.spec.mjs:111-132` compares the
downloaded file's parsed cells with the table and checks header, CRLF, filename and total row, all things a page could produce from its
own table. It never compares the **bytes** with what `GET /api/owner/billing.csv` returns, so "the bytes are the Worker's, unchanged" isn't
measured. The page today passes them through untouched (`app/public/api.js` `ownerCsv`: `res.blob()`, filename from
`Content-Disposition`; `owner.js:996-1002`). For whom: the accountant, if a later change rebuilds the CSV page-side and loses the formula
guard or the quoting. Suggest `expect(downloadedBytes).toEqual(await (await request.get('/api/owner/billing.csv?month=…', { headers:
{ Authorization } })).body())`.

**M3b-4. Two screens editing the route: the last save silently wins (low-medium, a contract gap for the lead).** When screen A moves a stop
and screen B then drags a different stop, B's PUT carries B's older order of every truck. With the same stop set the Worker accepts it
(API.md: statuses and check-ins unchanged, positions rewritten), so A's move is undone with no message on either screen. The 30 s refresh
(`owner.js:424-435`) is skipped while saving or dragging, so B rarely has A's order. For whom: an owner and a helper both editing on a storm
night. Neither the contract nor my Worker has a version on the route. A cheap option, if wanted: the Storm answer carries a
`route_version` (bumped by every route PUT, stop add and stop remove), and the route PUT takes it and answers 409 route-changed when it's
stale. That would also give M3b-1 a precise trigger.

**M3b-5. End storm or Add a stop refused because the storm ended elsewhere leaves the owner on a dead storm (low).** `owner.js:553-556`
shows the 409 "This storm has already ended." inside the still-open confirm, and `owner.js:539-542` shows the 409 "This storm has ended, so
it can't be changed." under the Add form. The page keeps painting the stale storm, and only the 30 s refresh (skipped while a confirm or
the Add form is open, `owner.js:425`) or a tab change would move on. Same shape as M2-3 (clarification 22). For whom: the owner with two
screens. Fix: on 409 `bad_state` from these calls, clear `confirm`/`adding` and call `renderTonight()` with the message as `stormNotice`
(for End storm, going straight to the summary is friendlier still).

**M3b-6. Past storms can't be opened while a storm is on (low).** The past-storms list is painted only on the no-storm view
(`owner.js:199-220`). During a storm there's no route to last week's summary, for example to copy a "skipped" text for a client who
calls. `#storm/<id>` works if typed. For whom: the owner. Suggest a "Past storms" link under the running storm too.

**M3b-7. Note: no way to take a stop off tonight's route.** `DELETE /api/owner/storms/:id/stops/:client_id` exists (API.md, clarification 15),
but `api.js` has no call for it and the page offers no Remove. PLAN.md M3 lists only "Add a stop", so this is a gap to decide on, not a
missed requirement.

**M3b-8. Nit: the yard's map error shows under "Yard name".** The Worker uses field `yard` for both the label and the coordinates (my M2
choice, adopted in clarification 14), and `owner.js:1025`, `:1072` put `err-yard` under the name input. So "Put a pin on the map for the
yard." appears under a text box, away from the map. Either the page shows `field: yard` errors by the map as well, or the Worker could
split the field (`yard.label` / `yard.lat`). Lead's choice; a field name change would be a clarification.

### Checked and consistent (no action)
- **Route PUT body** (`owner.js:437`, `:460-475`, `:519-526`): every truck of the storm listed once, including a truck with no stops, and
  every stop once, built from the last Storm the API returned; Move up/down swap within a list; Move to removes the stop everywhere and
  appends it to the chosen truck; a drag computes the same lists and doesn't PUT when nothing changed. Buttons and handles are disabled
  while saving. The handle is a real `<button>` at least 56 px tall with `touch-action: none` (`style.css:263-266`), so a finger drags instead of
  scrolling. The page repaints from the Storm the PUT returns, so positions and the "on the route" copy texts follow the new order.
- **Add a stop** (`owner.js:531-538`): body `{ client_id, truck_id }` as numbers, offering only active clients not already on the route; the
  Worker's 200 Storm is painted; field errors land on `err-client_id` / `err-truck_id`.
- **End storm and summary** (`owner.js:546-605`): inline confirm, `POST …/end`, then `#storm/<id>` loads the Storm and `GET …/summary`. Every
  field read (`storm_id, name, started_label, ended_label, duration_label, stops, plowed, billable_pushes, skipped[].{client_id, name,
  reason_text, at_label}, not_reached[].{client_id, name}, trucks[].{id, name, plowed, skipped, pending, first_label, last_label}`) exists
  with that name. The "skipped" copy text comes from that stop's own `messages`. **Past storms** read `storms[].{id, name, started_label,
  ended_label, counts}`.
- **Billing** (`owner.js:941-1011`): months from `/billing/months` plus the company-zone current month; the default is `months[0]`, the newest month
  with pushes, else the current month. Every cell and the totals come from the API row (`pushesOf` returns `row.pushes`); money is
  `toLocaleString('en-US')` with two decimals. The CSV is a real fetch with `Authorization: Bearer`, the filename parsed from the Worker's
  `Content-Disposition`, and the body passed on as a blob, so the bytes are unchanged. A 400 month or a 401 is handled.
  `negative-billing.mjs` is honest: the unbroken copy must pass first, and the break turns the skipped seasonal client's pushes from 0 into 1.
- **Trucks** (`owner.js:845-933`, `:1107-1112`, `:1216-1226`): POST `{ name }`; rename and deactivate PUT `{ name, active }` (both fields, as the
  Worker requires); New link behind an inline confirm whose words match clarification 17 (queued check-ins still send under the new link).
  **Clients** (`owner.js:768-837`): deactivate sends the full stored client with `active` flipped (a PUT needs every field); New status link behind
  a confirm, then the client and its messages are fetched again so the copy text carries the new link.
- **Settings** (`owner.js:1014-1095`): company PUT `{ name, yard: { label, lat, lng } }` with the pin from a map tap or drag (rounded to 5
  places), and the bar repainted from the Company answer (so the SAMPLE badge follows the name). **Change PIN** follows clarification 21: a
  401 with `field: current` lands on `err-current` and the session stays (`api.js` `owner()` only signs out on a field-less 401); a 400 on
  `err-next`; a 429 (clarification 16) on `pin-form-error`. `settings.spec.mjs` drives five wrong tries to a real 429 and proves the session still
  works afterwards.
- **Copy buttons** (`owner.js:64-94`): the text is put in `data-copy` with HTML escaping and read back through `dataset`, which unescapes it,
  so the clipboard gets the API's `text` byte for byte. `copy.spec.mjs` reads the clipboard back in chromium and compares it to the API
  message; webkit's skipped read carries the written reason allowed by clarification 25.
- **Specs and arrangement:** route-edit, storm-end, settings and copy arrange storms and check-ins through the API and then do the thing
  under test through the page; billing.spec plows and skips through the driver page and ends the storm through the owner page. The
  `@desktop` tag filters the mouse drag off the 390 projects rather than skipping it (clarification 25).

## M6: DONE (pinned for QA; merge waits for sr2 M3c)

Merged main first (`git merge --ff-only main` → 7d4b52b: API.md clarifications 32–37, DECISIONS 43–45). Code commit `a265921`. **Timing:** sr2's
current page doesn't send `route_version`, so on this commit its route edits answer 400 field `route_version` until sr2 M3c lands.

### (1) Clarification 32: the route has a version
- `migrations/0003_route_version.sql`: `ALTER TABLE storms ADD COLUMN route_version INTEGER NOT NULL DEFAULT 1` (existing and seeded storms start at
  1; the demo seed inserts storms directly and never edits a route, so it needed no change).
- The owner Storm view carries `route_version` (storm start, current, `GET …/:id`, route PUT, stop add/remove, end). The driver route and the storms
  list don't carry it (not in the contract).
- **Every edit bumps it inside its own batch:** route PUT, stop add and stop remove each add `UPDATE storms SET route_version = route_version + 1`
  to the batch that writes the change, so a refused or rolled-back edit (ended storm, duplicate stop, stop with check-ins) never bumps it.
- **Route PUT, in order:**
  1. `route_version` missing or not an integer → **400 field `route_version`** "Reload the route and try again."
  2. Malformed trucks (not arrays, a foreign truck, a truck or a stop twice, a non-integer id) → **400 field `trucks`**, whatever the version.
  3. Well formed but not this storm's trucks and stops (a stop added or removed since) → **409 `bad_state` "The route changed while you were
     editing it. Reload and try again."** when the version is stale, 400 `trucks` when it's current. This comparison reads the version, but it
     only chooses **which refusal** to send and can never allow a write.
  4. A body with the right trucks and stops is decided **only inside the write batch**: `ROUTE_VERSION_GUARD_SQL` (a `json()` guard that raises
     when the stored version isn't the body's), then the bump, then the position updates. A stale version, or the loser of a race, rolls back
     and answers 409 with the same text. The old count-of-stops guard is gone; the version covers it, because adds and removes bump it.

### (2) Clarification 33: yard errors name their part
Company PUT answers `field: "yard.label"` for a missing or too-long yard name and `field: "yard.pin"` for missing or out-of-province
coordinates (texts unchanged).

### Tests
`npm test`: **26 unit tests pass, 63 API tests pass (58 + 5 new), 0 fail, 0 skipped.** Updated: storm start asserts `route_version: 1`; the company test
expects `yard.label` / `yard.pin` (plus a yard with a name and no coordinates → `yard.pin`); the storms-list test leaves `route_version` out when
comparing with the Storm; the M2 route-PUT test sends the current version on every call. New:
- **bumps:** 1 at start, 2 after a PUT, 3 after an add, 4 after a remove; a refused PUT (duplicate stop) and a refused add leave it at 4; the driver
  route has no `route_version`.
- **a stale version with the same stop set** → 409 with the exact text; the stored route is still the first edit's and the version is 2.
- **a stale version after a stop was added** → 409, not 400; the same old lists with the current version → 400 `trucks`; a stale body naming a
  stop that was removed since → 409.
- **400s:** the current version with a duplicate stop, a truck twice, or a foreign truck → 400 `trucks`; a non-array with a stale version → 400
  `trucks`; `route_version` missing, `null`, `"1"` or `1.5` → 400 `route_version`; none of them bump the version.
- **two PUTs racing with the same version**, five rounds (each with the version the previous round left): every round exactly one 200 and one
  409 (`ROUTERACE round=0..4 statuses=200/409`), the stored route is the winner's lists, and the version went up by one.

### Negative control `negative:routeversion`: RED
Break: in the copy, the line `db.prepare(ROUTE_VERSION_GUARD_SQL).bind(stormId, body.route_version),` is removed from the write batch. Both named
tests passed on the unbroken copy, then went red: the stale same-set PUT answered `actual: 200, expected: 409`, and the race gave
`ROUTERACE round=0 statuses=200/200` (`actual: [ 200, 200 ], expected: [ 200, 409 ]`). It's honest because the page-shaped body (right
trucks and stops) has no read-then-refuse path: only the batch guard stands between a stale screen and the write.

All **thirteen** controls (a–i, pinguard, statusroute, plowednote, routeversion) re-run on `a265921`: all RED, each log section starting with
`=== a265921 …`, no machine paths in the log.

### For sr2 (M3c)
Send `route_version` from the last Storm the page painted on every route PUT. A 409 from it (stale, or lost a race) means reload and show the
text; a 400 `route_version` means the page sent none. Show `yard.label` by the yard name and `yard.pin` by the map. Adds and removes don't take a
version, but they bump it, so repaint from the Storm they return.
