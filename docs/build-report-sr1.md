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
