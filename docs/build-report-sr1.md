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

## Cross-review of sr2 M3c steps 1-2 (0994459)

Read only through git (`git diff 8e407e2 0994459 -- app/`, `git show 0994459:<path>`), never sr2's worktree. Checked against docs/API.md
(clarifications 26–32) and `worker/src/index.js` (main after M6). No code changed, nothing run: each finding follows a code path end to end
and names it, so sr2 can confirm it with a spec. Files: `app/public/d/queue.js`, `app/public/d/driver.js`, `app/public/owner/owner.js`,
`app/public/api.js`, `app/tests/queue.spec.mjs`, `app/tests/route-edit.spec.mjs`, `app/tests/negative-twotabs.mjs`.

### Findings (most harmful first)

**M3c-1. An Undo can be lost while the push stays billed, whenever the check-in reached the Worker but the phone didn't hear back (medium).**
Clarification 26's rule is that the sender "sends a DELETE only for an item that was on its way when it was marked". But "on its way" is
known only to the sender that is waiting on the POST, in memory. It isn't written to the item. Any other sender that finds an `undone`
item deletes it without a DELETE (`app/public/d/queue.js:194`). That's wrong whenever the POST did reach the Worker. Three paths:
- **The answer is lost** (the most likely in a truck): the POST is stored (`worker/src/index.js:512`), the signal drops before the response,
  and `fetch` rejects → `failed('network')` (`queue.js:134-135`), so the item stays `send`. The driver taps Undo. `unsent()` is true
  (`driver.js:476`, `:481`), so the page asks "This check-in has not reached the office yet. Delete it from this phone?" (`driver.js:376`),
  which isn't so. "Delete it" marks it `undone` (`driver.js:464`), the next send pass removes it with no DELETE (`queue.js:194`), and the
  push stays stored, plowed and billed.
- **The page goes away mid-send:** Undo is tapped while the POST is on its way, then the tab reloads, is closed, or is discarded by the phone
  before the answer. The waiting sender is gone; the next sender (a reload, or another tab) deletes the `undone` item (`queue.js:194`)
  and sends no DELETE.
- **No Web Locks** (`queue.js:80` falls back to sending without a lock; `navigator.locks` is missing on older iPhones and on any
  non-https origin): tab B's send pass removes the item tab A marked `undone` while tab A's POST is still out. Tab A's 200 then finds it
  missing → `gone` (`queue.js:170`) → no DELETE.

For whom: the owner (bills a push the driver took back), the client (status says plowed), the driver (the stop comes back plowed on the
next route load, after they undid it). It's not silent forever (the route shows it plowed), but nothing tells the driver the undo didn't
happen.
Suggested fix (sr2): write `attempted: true` to the item **before** its POST is sent. A sender that finds an `undone` item with `attempted`
queues the DELETE instead of deleting it; one without `attempted` is deleted, as now. The Worker makes that safe: a DELETE for a check-in it
never stored answers **404** "We couldn't find that check-in." (`worker/src/index.js:953`), which the sender should then treat as "nothing to
undo" (remove the void quietly) rather than put it in "Not accepted". The confirm text should also stop saying "has not reached the office
yet" for an attempted item ("It may already be at the office. Undo it?"). A spec that aborts the page's POST response after the Worker
stored it (`route.fetch()` then `route.abort()`), taps Undo and confirms, then expects a voided check-in in the database, would catch it.

**M3c-2. A tab whose send stalls holds the Web Lock, and every other tab of the link waits behind it (medium-low).** The lock wraps the
whole send loop, including every network call (`queue.js:191-213`), and the driver page's `fetch` has no timeout (`app/public/api.js:48`).
On a phone, a request on a dead cellular connection often doesn't reject for minutes. Until it does, tab A keeps the lock and tab B's
`navigator.locks.request` waits with no limit, while B's own flushes only set `again` (`queue.js:186`). If A is a hidden tab the driver
forgot, the tab they're looking at shows "Sending…" and can't send anything, including new check-ins. Not forever (the stalled request
settles eventually, and a discarded page releases its locks), but long enough to matter at 5 AM. For whom: the driver. Fix: an
`AbortSignal.timeout(…)` (say 30 s) on the driver calls in `api.js`, and consider `navigator.locks.request(name, { ifAvailable: true }, …)`
in the non-visible tab so a background tab never takes the lock ahead of the one on screen.

**M3c-3. The owner's 30 s refresh can overwrite a just-saved route with an older Storm, and the next correct edit is refused as stale
(medium-low).** `app/public/owner/owner.js:424-429`: `refreshStorm` checks `busy` (`state.saving`, a drag, …) **before** its GET and never
after. If the 30 s timer (`owner.js:421`) fires just before the owner taps Move, the GET is already out. The Move's PUT is answered first
and paints version n+1 (`owner.js:446`). Then the GET, answered with the Storm as it was when the Worker served it (version n), arrives:
`JSON.stringify(next) !== JSON.stringify(state.storm)` (`owner.js:429`), so `state.storm` goes back to version n with the old order. The screen
visually undoes the move for up to 30 s, and the owner's next Move sends `route_version` n and gets **409 "The route changed while you were
editing it"** although nobody else changed anything. The page reloads and shows that notice. For whom: the owner, who sees a move vanish,
then a false "changed on another screen". Fix: after the GET, drop the answer if `state.saving` or a drag is on, or if
`next.route_version < state.storm.route_version`.

**M3c-4. The two-tab control breaks two defences at once, so a return of the missing-means-undone rule alone would pass (low-medium, test
honesty).** `queue.spec.mjs` "two open tabs…" holds tab 1's POST, reloads tab 2, releases, and asserts one stored push, not voided, no DELETE,
and exactly one POST. With the Web Lock working, tab 2 never sends, so the `gone` → no-undo rule (`queue.js:170`) is never exercised.
`negative-twotabs.mjs` removes **both** the lock and that rule, so its red proves only that "no lock and the old rule" is caught. A copy that
restores only `if (!still) return { result: 'undone' }` passes the suite in chromium and webkit, and would void pushes on every phone
without Web Locks (M3c-1, third path). The `posts.length === 1` check does measure the lock alone. Suggest a second run of the test with
Web Locks removed (`context.addInitScript(() => { Object.defineProperty(navigator, 'locks', { value: undefined }) })`), expecting one stored,
non-voided push and no DELETE (two POSTs are fine there), and a control that restores only the old rule. The response-lost path in M3c-1
has no test at all.

**M3c-5. Nit: the Undo confirm is usually wrong about where the check-in is.** When the driver taps Undo online, the check-in is normally
in flight: still `send` (`driver.js:476`), so the page asks "This check-in has not reached the office yet. Delete it from this phone?"
(`driver.js:376`). "Delete it" then correctly ends in a DELETE (`queue.js:171`, `:175-177`), so the result is right and the words aren't. It
goes away with the `attempted` flag from M3c-1.

### Answers to the lead's questions
1. **A DELETE the driver didn't tap:** none found. A 200 duplicate or a missing item after 200/201 now queues nothing (`queue.js:169-174`); a
   void is queued only from `undone` (`queue.js:171`) or from the driver's own Undo on a sent or photo-waiting check-in (`driver.js:469`).
   Two tabs with the lock never send one item twice; without the lock they can, and the result is still one stored push with no DELETE.
   The opposite failure does exist: **an undo the driver did tap can be dropped** (M3c-1).
2. **The lock:** it wraps read–send–remove for the whole loop (`queue.js:191-213`), so two tabs can't send the same item at once. It doesn't
   wrap the driver's `takeBack` (`driver.js:461`), which is fine because `update()` decides in one IndexedDB transaction and the sender
   re-reads the item after the answer. If `navigator.locks` is missing, sending goes on without it (`queue.js:80`); if `request` itself
   rejected, `flush` would count a failure and retry with backoff (`queue.js:214-215`), so no send is lost, only delayed. Starvation: not
   forever, but for as long as a stalled `fetch` takes (M3c-2).
3. **route_version on the owner page:** the PUT sends the version of the Storm on screen (`owner.js:446`); the PUT answer, an Add a stop answer
   and a 409 reload (`renderTonight`) each replace `state.storm` with a Storm carrying the new version, and `state.saving` stops a second edit
   before the first is answered (`owner.js:442`). So consecutive edits on one screen are never stale, except through M3c-3's refresh race.
   There's no Remove a stop on the page yet, so that path can't be checked.
4. **The two-tab test and its control:** they measure the lock and the combined regression, but not the missing-item rule alone (M3c-4).
   The route-edit spec now requires exactly 409 with the exact text (`route-edit.spec.mjs`), which closes M3b-1's loose check, and the moved-
   stop spec sends `route_version` from the Storm it read.

## Cross-review of sr2 M3c steps 3-11 (f1d486d)

Read only through git (`git diff 0994459 f1d486d -- app/`, `git show f1d486d:<path>`), never sr2's worktree. Checked against docs/API.md
(clarifications 24–37) and `worker/src/index.js` (main after M6). No code changed, no server or browser run; one arithmetic check in plain
Node (below). Files: `app/public/owner/owner.js`, `app/public/d/driver.js`, `app/public/d/queue.js`, `app/public/api.js`,
`app/tests/{queue,billing,storm-end,route-edit,settings}.spec.mjs`, `app/tests/negative-{crosstruck,hst}.mjs`.

### First, a correction of my own M3b-2
My M3b-2 said `Math.round(3550 * 0.15)` gives 532 because "3550 × 0.15 is 532.4999…". **That was wrong.** In JavaScript `3550 * 0.15` is exactly
`532.5` and `Math.round` gives **533**, the same as the half-up rule. A Node check over every amount from 0 to 2 000 000 cents, then every 50
cents up to 100 000 000, found no amount where `Math.round(a * 0.15)` differs from `Math.floor((a * 15 + 50) / 100)`, confirming what sr2
found. So clarification 34's control as written (`Math.round`) could never go red, and sr2 was right to truncate instead (see "Checked"
below). Two leftovers from my mistake: **clarification 34 still names `Math.round(amount * 0.15)`** as the control (lead: please amend it to
the truncation `negative-hst.mjs` uses), and **`app/tests/billing.spec.mjs:39`'s comment still says "Math.round(3550 * 0.15) is 532"** (sr2:
the comment is wrong; the assertion it sits above is right).

### Findings (most harmful first)

**M3c-6. "Remove from tonight" is offered on a stop whose only check-in was undone, and my Worker always refuses it (medium-low; Worker or
contract, lead's call).** The page shows Remove when the stop has no deciding check-in: `${st.checkin ? '' : …Remove from tonight…}`
(`app/public/owner/owner.js:351`). The Stop's `checkin` only ever looks at **non-voided** check-ins (`worker/src/index.js:203`, `:190`). But my
Worker's removal refuses a stop with **any** check-in, voided ones included (`index.js:827`, 409 "This stop has check-ins, so it stays on the
route."). That's what API.md's "only a stop with no check-ins at all" says, and my M2 test asserts it (`worker/tests/api.test.mjs:810`, "Even a
voided check-in keeps the stop."). So when a driver plows a stop and taps Undo, the owner sees Remove; tapping it and confirming gives the
409 on that stop (`owner.js:614-633`), the reload still has `checkin: null`, and Remove comes back, forever. For whom: the owner, on exactly
the stop a driver wasn't sure about. Two ways to fix, both in my slice and both a contract change:
- (a) the owner Stop view carries **`removable: true|false`** (no check-ins at all, voided included), and the page shows Remove only when it's
  true; **or**
- (b) the Worker lets a stop go when **all** its check-ins are voided (the voided rows keep their `client_id`, so history stays), and my M2
  assertion flips.

I'd suggest (a): an undone check-in is still a record that the truck was there, and billing and the summary never see voided rows anyway.

**M3c-7. A check-in whose POST reached truck 1's link but whose answer was lost can still send its photo and undo to a truck that answers
404 (low-medium; the path clarification 24 promises can't happen).** `rekey()` moves every check-in that is still `send` to the page's key and
**stamps the page's `truck_id`** (`app/public/d/queue.js:107-109`). If that check-in was already stored under truck 1 (the answer was lost, so
the phone never learned it; M3c-1), the resend under truck 2's key is answered **200 duplicate with the stored check-in, `truck_id` 1**
(`worker/src/index.js:512`). The sender ignores that and moves the item to `photo` under truck 2 (`queue.js:166`, `:172`). The photo PUT
then gets 404 from `index.js:520` (only the truck that made the check-in may add its photo), so the photo is **dropped** (`queue.js:157`). An
Undo becomes a DELETE under truck 2 that gets 404 from `index.js:953` and lands in "Not accepted". For whom: the driver who shares a phone
across trucks on a bad-signal night; the owner gets a plowed stop with no photo. The cross-truck spec can't see this, because its photo and
undo belong to check-ins whose answers arrived. Fix (sr2, fits with M3d's `attempted`): after a 200/201, set the item's `truck_id` from
`data.checkin.truck_id`, and if that isn't the page's truck, mark the photo item `stuck` like any other cross-truck photo (and give a later
void that `truck_id`). Alternatively, don't re-key an `attempted` check-in across trucks at all.

**M3c-8. A removal refused with 404 (the stop was already removed on another screen) leaves the stale row on screen with an error (low).**
`removeStop` (`owner.js:614-633`) reloads the Storm only on 409 (`:625`); any other refusal just sets `state.stopErrors[clientId] = e.message`
(`:632`) and repaints the **old** Storm. After a removal from the owner's phone, the desktop's second "Yes, remove it" gets 404 "That client is
not a stop in this storm." and keeps showing that stop, with a stale `route_version`, so the next Move gets a 409 reload. For whom: the
owner on two screens. Fix: treat 404 like 409 (reload the current Storm, then show the message).

**M3c-9. After a storm ends, every "Photo not sent" note is listed as a stop "moved off this route" (low).** `renderElsewhere` builds its
note rows from all undismissed notes whose check-in isn't on the current route (`app/public/d/driver.js:353-354`). With no storm on,
`state.route.stops` is empty, so every note from tonight lands under "Saved for stops on another route … The owner moved these stops off
this route." (`driver.js:364`), which is the wording clarification 28 took out for check-ins. Notes also aren't filtered by storm or by
driver link, and they stay in `localStorage` until dismissed. For whom: the driver the morning after, told stops were moved when the storm
simply ended. Fix: put notes under a neutral "Photos not sent" heading (or under the ended-storm block when their storm isn't the current
one), keyed by storm.

**M3c-10. The billing totals would still pass a page that works out total HST from the subtotal (low, test honesty).** Clarification 34
now pins a row HST that needs rounding ($5.33), and control (h) proves the row cell is read from the API. But the spec's totals are
`hstOf(3550) + hstOf(5000) = 533 + 750 = 1283`, and 15 % of the subtotal 8550 rounded half up is also 1283. A page that showed
`Math.round(subtotal × 0.15)` in the totals row, instead of the API's sum of rows, would pass. Clarification 11's rule (totals are the sums
of the rows) is exactly where page arithmetic goes wrong. Suggest a second $35.50 per-push client: rows 533 + 533 = **1066**, while 15 % of
7100 = **1065**.

**M3c-11. Note: the keys store (clarification 27) is never exercised.** Every item the current code queues carries a `truck_id` (check-ins
at record, the driver's undo in `takeBack`, the sender's own undo, and every re-key), so `truckOfKey`'s store is consulted only for items saved
by older builds. No spec saves such an item, so a broken `rememberKey` would pass the suite. Low risk while no pre-M3c phones are in use; a
one-item spec (seed IndexedDB with an item lacking `truck_id`, reset the link, open the other truck's link, expect `stuck`) would cover it.

### Checked and consistent (no action)
- **Cross-truck test and control (g)** (`queue.spec.mjs` "a photo and an undo saved under truck 1's link…"; `negative-crosstruck.mjs`): the
  photo PUT and the undo DELETE are held by aborting `**/api/driver/checkins/**` (which doesn't match the POST, so the check-ins do reach the
  Worker). After truck 1's link reset and truck 2's link opened, both items are sent under the dead key first (401), then re-keyed or marked
  stuck. The spec records every PUT and DELETE with its `X-Driver-Key` and requires none under truck 2's key, the undo not applied, and the
  photo still `waiting`. Control (g) removes the truck comparison (`queue.js:108` → `checkin || true`), so the photo and undo go out under
  truck 2's key (the Worker answers 404 to both) and the `writes` assertion goes red. It measures the rule for items whose answers arrived;
  M3c-7 is the one path it can't see.
- **Control (h)** (`negative-hst.mjs`): its anchor matches exactly once, the **row** HST cell `owner.js:1052` (the totals cell on `:1058` is a
  different string), and the break shows `Math.floor(amount_cents * 0.15)`: $5.32 on the $35.50 row where the spec asserts $5.33. The
  unbroken copy must pass first (the lib's VOID rule). Honest.
- **CSV bytes** (`billing.spec.mjs`): the downloaded file is compared with `Buffer.compare` against `GET /api/owner/billing.csv?month=…` fetched with
  the owner's token. That's a byte check against my Worker's answer, so a page-built CSV can't pass (clarification 35).
- **Ended-storm wording and the confirm** (clarification 28): check-ins from a storm that isn't the current one are listed under "Saved from the storm
  that ended, still sending" (`driver.js:108`, `:357`), each once, with the "Moved from an old driver link" note when re-keyed (clarification 31).
  Undo on an unsent one asks "…Delete it from this phone?", and "Keep it" leaves it sending. The spec proves the kept check-in is accepted by
  my Worker after the storm ended, and not voided.
- **409 flows against my Worker** (clarification 36): End storm's only 409 is "This storm has already ended." → the page opens that storm's
  summary with the message (`owner.js:592` onwards). Add a stop's only 409 is the ended storm (`editableStorm`) → Tonight repaints with the
  message. The route PUT 409 (stale version or ended) reloads Tonight. A removal 409 is either the ended storm (the page sees no current storm
  and repaints Tonight) or "has check-ins" (the page reloads the Storm and shows the message on that stop). Each spec drives the real 409 by
  changing state through the API in between.
- **Past storms during a storm**: `#past` lists ended storms only (`pastList` filters `status === 'ended'`), each linking to its summary; the spec
  opens one while a storm is on.
- **Yard errors** (clarification 33): `err-yard.label` sits under the yard name (`owner.js:1104`) and `err-yard.pin` under the map (`:1123`);
  moving the pin clears it (`:1130`). The spec gets a real 400 `yard.pin` by zooming out with Leaflet's own control and tapping far west.
- **Storm notice and duplicate rows** (clarification 31): a "storm already on" notice is marked `needsStorm` and dropped when Tonight finds no
  storm (`takeNotice`); a re-keyed check-in for a stop off this route is listed only in the off-route block (`renderOldLink` excludes those).
- **Dropped photo for another route's stop** (clarification 30): the note keeps label and stop, is shown in the other-route block until
  dismissed, and the spec serves the Worker's exact 413 text. See M3c-9 for the wording after a storm ends.

## M7: DONE

Merged main first (`git merge --ff-only main` → 8cff8a3: API.md clarifications 42–47, DECISIONS 51–52). Code commit `5faa526`. Additive: nothing that
sr2's current page sends or reads changes shape.

### Clarification 42: owner stops say whether they can be removed
- `loadStorm` reads one more statement in the **same batch** as the storm, its stops and its check-ins:
  `SELECT DISTINCT client_id FROM checkins WHERE storm_id = ?1`. That's every stop with **any** check-in, voided ones included, so the flag and the
  Stop come from one snapshot.
- `stopView` adds `removable: true|false` **only when the view is the owner's** (next to `messages`): true only when that client isn't in
  that set. Every owner Storm answer goes through `stormView`, so the flag is on every stop of: storm start (201), `GET …/storms/current`,
  `GET …/storms/:id`, route PUT, stop add, stop remove, and the `storm` in the end answer. Driver views (`GET /api/driver/route`, the `stop` in
  check-in, photo and undo answers), the summary and the status page don't carry it.
- The removal rule is unchanged: `DELETE …/stops/:client_id` still refuses a stop with any check-in, voided included, with 409 "This stop has
  check-ins, so it stays on the route." So `removable: false` is exactly the set of stops the DELETE refuses for check-ins.

### Tests
`npm test`: **26 unit tests pass, 64 API tests pass (63 + 1 new), 0 fail, 0 skipped.** Updated: the M1 driver-route test now strips `removable` as
well as `messages` when comparing the driver's stops with the owner's, and requires the word `removable` never to appear in the driver answer.
New "removable: a fresh stop is removable; after a plowed check-in it is not; after that check-in is undone it still is not, and the DELETE
answers 409":
- **fresh:** every stop `true` on the storm-start answer and on `storms/current`;
- **plowed:** that stop `false`, its neighbour still `true`; the driver's check-in answer has no `removable`;
- **undone:** the stop is pending with `checkin: null` but still `removable: false`; the owner's DELETE answers 409 with the exact text; the
  undo answer has no `removable`;
- **skipped:** `false`;
- **every owner answer:** the route PUT, a stop add (the new stop `true`, the undone one `false`), a stop remove and the end answer each carry a
  boolean `removable` on every stop; the summary text has none.

### Negative control `negative:removable`: RED
Break: in the copy, the statement becomes `SELECT DISTINCT client_id FROM checkins WHERE storm_id = ?1 AND voided_at IS NULL`, so removable is
worked out from non-voided check-ins only. The unbroken copy passed first; the broken copy failed at the undone case:
`AssertionError: undone: an undone check-in is still a record, so not removable`, `actual: true, expected: false`. That's the exact mismatch
M3c-6 described: the page would offer Remove, and the Worker would refuse it.

All **fourteen** controls (a–i, pinguard, statusroute, plowednote, routeversion, removable) were re-run on `5faa526`: all RED, each log section
starting with `=== 5faa526 …`, and no machine paths in the log.

### For sr2 (M3e)
Show "Remove from tonight" only when the owner Stop has `removable: true`. The flag is fresh on every owner Storm answer, including the one a
route PUT, stop add or stop remove returns, so repainting from that answer keeps it right.

## Cross-review of sr2 M3d (aa04bba)

Last review round (DECISIONS 52). Read only through git (`git diff 2213dc3 aa04bba -- app/`, `git show aa04bba:<path>`), never sr2's worktree.
Checked against docs/API.md (clarifications 38–41) and `worker/src/index.js` (main after M7). No code changed, nothing run. Each finding is tagged
**DATA LOSS**, **BILLING**, **SECURITY** or **OTHER**; nothing I found is DATA LOSS or SECURITY. Files: `app/public/d/queue.js`, `app/public/api.js`,
`app/public/d/driver.js`, `app/public/owner/owner.js`, `app/tests/{queue,route-edit}.spec.mjs`, `app/tests/negative-{attempted,missingundo,twotabs}.mjs`.

### Findings (most harmful first)

**M3d-1 [BILLING]. Without Web Locks, an undo's DELETE can reach the Worker before the check-in's own POST, get 404, and be dropped quietly;
the POST then lands and bills.** Clarification 38 makes a void answering 404 "nothing to undo": the void is removed with no trace
(`app/public/d/queue.js:161-162`). That is only true if no earlier attempt of that POST can still arrive, and M3d has two ways for one to:
- **Two tabs, no Web Locks** (`queue.js:82`: older iPhones, any non-https origin). Tab A's POST is on its way. The driver taps Undo (the item
  is `attempted`, so it becomes `undone`). Tab B's send pass isn't blocked by any lock, so it turns the `undone` item into a void and removes
  it (`queue.js:208-216`), then sends the DELETE at once. If the DELETE reaches the Worker first, it gets 404 "We couldn't find that check-in."
  (`worker/src/index.js:953`) and is dropped. Tab A's POST is stored a moment later; tab A's 201 finds the item gone (`queue.js:183`) and
  queues nothing. The push stays stored, plowed and billed, and the driver's tapped Undo left no trace.
- **A POST that timed out on the phone** (`app/public/api.js:48-49`, 30 s) but whose request is still being delivered or run. The phone treats
  it as no signal (`queue.js:145-146`), the driver taps Undo ("It may already be at the office. Undo it?"), and the next pass sends the DELETE.
  If that beats the stalled POST, same outcome. I can't prove from here how long an aborted request can still arrive, so this one is "can't
  rule out", not "shown".

For whom: the owner bills a push the driver took back; the client's status says plowed. Suggested fix (sr2), which also closes M3d-2: for an
`attempted` undone item, **send the check-in's POST again under its own key first** (idempotent: 201 if it never arrived, 200 duplicate if it
did, and a late original then also answers duplicate), and **only then** the DELETE. The DELETE then always finds the row, so a 404 means
"another truck's check-in" and can go to "Not accepted". The cost: a check-in that never reached the office is stored and immediately voided.
That's harmless for billing and the summary, but by clarification 42 it makes the stop `removable: false`. Lead's call whether that
trade is right; the alternative is to keep the 404-as-nothing rule and retry the DELETE once after a delay before dropping it.

**M3d-2 [BILLING]. An undo sent under the wrong truck is now dropped silently instead of shown.** My Worker also answers the undo with **404**
when the check-in exists but belongs to another truck (`worker/src/index.js:953`: `row.truck_id !== truck.id`), with the same text as "never
stored". `queue.js:161-162` can't tell them apart. The known path to a wrong-truck void is M3c-7: a check-in whose POST reached truck 1 but
whose answer was lost, re-keyed to truck 2 (`queue.js:113-114`); its undo goes out under truck 2. Before M3d that undo landed in "Not accepted"
(visible, the owner can fix it); now it vanishes and the push stays billed. Clarification 43 (the stored truck wins, sr2 M3e) removes that path,
but until then a 404 isn't safe to drop. For whom: the owner and the client. Fix: M3d-1's POST-first order makes the DELETE carry the right
truck. Or, if the lead prefers a Worker-side fix, I can make the undo route answer a **different code for "another truck's check-in"** (for
example 403 `not_found`-style text with code `other_truck`), so the app can drop only the true "never stored" 404. That would be a contract
change.

**M3d-3 [BILLING, tiny window]. Two places delete the undone item and add its void in separate transactions; a page closed between them loses
the undo.** After a 200/201, `update()` deletes the `undone` item (`queue.js:184`) and only then, in a second transaction, `add`s the void
(`queue.js:188-190`). The driver's Undo on a check-in whose photo is still waiting does the same (`app/public/d/driver.js:496` deletes the photo
item in the deciding transaction, then `queue.add` the void at `driver.js:499-500`). A reload, crash or browser discard between the two commits
leaves neither item: no DELETE is ever sent, and the push stays billed. The flush loop does it the safe way round (add the void, then remove
the item: `queue.js:212-215`). For whom: the owner, rarely. Fix: in the deciding transaction, leave the item as `undone` + `attempted` (or photo
→ `undone`) and let the flush loop convert it (add then remove), or put the void in the same readwrite transaction.

**M3d-4 [BILLING, small window]. Re-keying writes back a stale copy and can overwrite an Undo tapped a moment before.** `rekey()` reads all items
(`queue.js:110`) and, for each item under a dead key, `put`s `{ ...item, key, truck_id, … }` from that snapshot (`queue.js:114`). The driver's
Undo (`driver.js:491`) runs outside the send lock. If it marks an item `undone` between the snapshot and that `put`, the `put` restores
`state: 'send'`, the check-in is sent, and the tapped Undo is gone. It needs a dead key being re-keyed at the same moment as the tap, so it's
rare. (`reject()` at `queue.js:129` is also a blind write, but only after a 4xx refusal, when nothing was stored, so it's harmless for billing.)
Fix: re-key through `update()` so the decision reads the item in the transaction that writes it.

**M3d-5 [OTHER]. The 30 s timeout on photo uploads can hold every later check-in back on a slow uplink.** `DRIVER_TIMEOUT_MS` (`app/public/api.js:104`)
also applies to the photo PUT (`api.js:143`). A 1600 px JPEG at quality 0.7 is often a few hundred KB; on a weak rural uplink (tens of kbit/s)
that takes longer than 30 s, so the PUT aborts **every** time. The photo item keeps its place at the head of the queue (`queue.js:143`), the
failure stops the whole pass (`queue.js:146`, `:227`), and every check-in the driver makes after it waits behind the photo until the signal
improves, while the strip says "No signal" when there is some. Nothing is lost, and times and billing are right once it sends, but the office
and the status pages are behind all night. For the README's known gaps, or a quick fix: send pending check-ins before any photo, and scale the
photo timeout with its size.

**M3d-6 [OTHER]. `attempted` is skipped whenever `navigator.onLine` is false** (`queue.js:134`), and the POST is still made (`queue.js:144`). When
`onLine` is false the request almost never leaves, so this is normally right, and it keeps the offline Undo wording "not reached the office".
But `onLine` is a hint: a POST that does get through while it says false would be stored without `attempted`, and a later Undo would delete it
from the phone with no DELETE. Rare; known gap.

**M3d-7 [OTHER, test honesty]. The no-Web-Locks two-tab run passes even when the second tab never sends.** `app/tests/queue.spec.mjs` (the
`for (const locks of [true, false])` block) requires at most two POSTs in the no-locks run (`toBeLessThanOrEqual(2)`). The rule it exists for
(missing after 200/201 isn't undone) is only exercised when **both** tabs POST the same check-in; if tab 2's pass hasn't reached the POST before
the gate is released (it gets 1.5 s), one POST happens and the run passes without measuring anything. Control (j) went red in sr2's run, which
shows the run *can* measure the rule, not that every QA run does. Suggest requiring exactly 2 POSTs in the no-locks run (both tabs held at the
gate before release), so a run that didn't set up the race fails instead of passing.

**M3d-8 [OTHER]. Clarification 40's lower-version drop has no test of its own.** `route-edit.spec.mjs`'s new refresh test proves the "an edit
started while the refresh was out" rule (`app/public/owner/owner.js:471`). But the same scenario is also stopped by the version rule
(`owner.js:472`), so removing either line alone leaves the test green, and there's no negative control for clarification 40. Known gap.

### Answers to the lead's questions
1. **The attempted flag.** On a first send it's written in its own committed transaction before `fetch` is called (`queue.js:134-139`), and only
   while the item is still `send`. A re-keyed item keeps it (the re-key copies the item after the mark). A reload mid-send finds `attempted`
   already on the item. A tab without Web Locks marks before its own POST too. It isn't written when `navigator.onLine` is false (M3d-6). **An
   attempted undone item deleted without a DELETE:** yes, through the two-transaction windows (M3d-3), the stale re-key write (M3d-4), and
   through the DELETE itself being dropped on a 404 that didn't mean "never stored" (M3d-1, M3d-2). **A DELETE the driver didn't tap:** none
   found; voids come only from an `undone` mark or the driver's own Undo, and a missing item after 200/201 queues nothing. **The DELETE 404** is
   handled as nothing to undo (`queue.js:161-162`), which is exactly what M3d-1 and M3d-2 question.
2. **The timeout** never removes or rejects an item: an abort, or a body that can't be read, is a network failure (`api.js:48-49`,
   `queue.js:145-146`), so the item stays and backs off. A timed-out POST that did reach the Worker can't double-bill (the check-in id is the
   primary key, so a resend answers 200 duplicate), but it can feed M3d-1's lost undo. **`ifAvailable` in a hidden tab** (`queue.js:84`) skips a
   pass only while another tab holds the lock, and the skipped pass still schedules the next try (`queue.js:240-241`). A lone hidden tab, for
   example with the screen locked, gets the lock, so items aren't left unsent for good.
3. **The owner refresh drop** (`owner.js:464-472`) drops an answer only if a route edit started on this screen while it was out (`edits` is
   bumped by a save, a drag start, an add and a remove), a save or drag is running, or the answer's `route_version` is lower than the screen's.
   It can't drop a newer Storm for good: an equal version with new check-in statuses is painted, and a dropped answer leaves the 30 s timer
   running, so the next refresh paints the latest. A drag start that doesn't end in a save drops one refresh, costing up to 30 s of stale
   statuses.
4. **The specs and controls.** The response-lost test stores the POST through `route.fetch()` and aborts the page's answer, then requires a
   voided row; control (i) forgets `attempted` and it goes red. Honest. The never-stored test requires a DELETE answered 404, nothing in "Not
   accepted" and no row. Honest. The timeout test lets a POST go unanswered and requires "No signal" after at least 29 s and the check-in kept.
   Honest. Control (f) now breaks the lock and the rule only in the with-locks run, and control (j) restores only the rule in the no-locks run;
   both are correct in shape, with the caveat in M3d-7. The owner refresh test is honest for the rule it names (M3d-8).

## Cross-review of sr2 M3e steps 1-2 (0590380)

Focused on clarifications 49 and 50. Read only through git (`git diff 1e44e16 0590380 -- app/`, `git show 0590380:<path>`), never sr2's worktree.
Checked against `worker/src/index.js` (main after M7). No code changed, nothing run. Tags as before: **DATA LOSS**, **BILLING**, **SECURITY**, **OTHER**.
No DATA LOSS or SECURITY found. Files: `app/public/d/queue.js`, `app/public/d/driver.js`, `app/tests/{queue,route-edit,billing}.spec.mjs`,
`app/tests/negative-{resend,attempted,missingundo,twotabs,crosstruck,lib}.mjs`.

### Findings (most harmful first)

**M3e-1 [BILLING, narrow]. The re-sent POST can itself create a push that then can't be undone.** For an attempted check-in that never reached the
office, the re-send stores it (`queue.js:163`, answered 201) with `received_at` = now, and the DELETE follows as the next step (`queue.js:179-180`, then
`:184`). If the signal drops in the second between those two requests and the phone stays without signal for **more than 15 minutes**, my Worker
answers the DELETE **409 "Too late to undo. Ask the owner to fix it."** (`worker/src/index.js:958`, `:967`). The void goes to "Not accepted"
(`queue.js:205`) and the push stays stored, non-voided and billed. **That push was created by the undo**: before M3e the check-in was never on
the server. It's visible, not silent (the driver sees the refusal), but the owner is billing a stop the driver took back.
Who: the owner and the client, on a truck that loses signal for a while.
Two ways to close it, both needing the lead's call:
- **(sr1, contract)** the check-in POST takes an optional `"undo": true`: if the id isn't stored yet, the Worker stores it **already voided** in the
  same statement (never billable, not even for a moment); if it is stored, it's a duplicate as now, and the DELETE follows. One request for the
  never-arrived case, so no window.
- **(sr2, app-side)** after a re-send answered **201** (the undo created the row), a DELETE answering 409 "too late" is retried and not rejected. That
  doesn't work, because my Worker's 15-minute rule would keep refusing, so this path really needs the Worker change or a looser undo rule for rows the
  same phone just created.
A 200 duplicate on the re-send (the original did arrive) followed by a 409 is the old, pre-existing case: the driver's undo came too late for a real
push, and "Not accepted" is the right place for it.

**M3e-2 [OTHER]. A second Undo tap on a stale row can overwrite a pending re-send void with a plain one.** `takeBack`'s "already sent" branch
(`app/public/d/driver.js:509-511`) adds `voidFor(known)` with `resend: false` through `queue.add` (a blind `put`, `queue.js:99-103`) under the same
`void:<id>` key. If the item had meanwhile been turned into a **re-send** void by the flush loop (`queue.js:253-256`), and the driver taps Undo again
on a row painted before that, the new put replaces it: no re-send, the DELETE goes straight out, and if the check-in never arrived it gets 404 and
lands in "Not accepted". That's visible, so not silent. Only if the original POST is still on its way in another tab without Web Locks does it then
store and bill. It needs a stale row and a second tap. Fix: add the void through `update()` and keep an existing void untouched.

**M3e-3 [OTHER, test honesty]. The keys-store spec passes with the keys store broken.** "an item an older build saved without truck_id…"
(`app/tests/queue.spec.mjs`, last test) opens **truck 2's** link and expects the old photo to be listed as another truck's. With a broken store,
`truckOf(key)` is `null`, and `null === page.truckId` is false in `rekey()` (`queue.js:128`), so the item is marked stuck anyway and the row
appears: the test is green. Its first assertion (the store maps the link) proves the store is written, not that it's used. The store only changes
the outcome when an old item is re-keyed to **its own truck's new link**. Suggest a second case: reset truck 1's link, open truck 1's **new** link,
and expect the old photo to be re-keyed and sent (no stuck row, the PUT under the new key, `photo: "stored"`).

**M3e-4 [OTHER]. Clarification 50 has no negative control.** No spec can close a page between two commits, and none of the controls puts
back a two-transaction version (for example `item: null` without `also`, followed by a separate `add`). The single transactions are right by
reading (below), but nothing would go red if one were split again. Known gap.

### Answers to the lead's questions
1. **Can the re-sent POST do harm?**
   - **An undo tapped before the check-in ever left:** no re-send. An `undone` item without `attempted` is removed with no void (`queue.js:255-256`).
   - **Wrong truck:** the re-send goes under the item's own key, and the answer's `checkin.truck_id` (the stored truck, `worker/src/index.js:524`) replaces
     the void's truck. A mismatch with the key's truck marks the void stuck, so it's never sent (`queue.js:177-179`). A 201 means the sending truck
     stored it, so it matches.
   - **Loops:** none. Every answer either changes the void (`resend: false`, rejected or dead key) or backs off.
   - **Answers to the re-send:**
     - 409 `already_plowed` (another check-in plowed the stop, so this one was never stored), 404 (the stop was removed, so never stored) and 400 →
       the void goes to "Not accepted" with the server's text (`queue.js:173-174`). Nothing is billed, and the row shows.
     - 401 → the key is marked dead and the void is re-keyed like any other same-truck item (`queue.js:168-171`).
     - 5xx, 429 or a timeout → kept with `resend: true` and backed off (`queue.js:164-167`). A late original arriving meanwhile only turns the next
       re-send into a 200 duplicate.
   - **The one real harm:** M3e-1.
2. **Is every undone-to-void conversion one transaction?** Yes:
   - after a 200/201, the item is deleted and its void put in one `update()` (`queue.js:229-234`, the `also` list written in the same transaction,
     `queue.js:73`);
   - in the flush loop, likewise (`queue.js:253-257`);
   - in the driver's Undo on a photo-waiting check-in, likewise (`driver.js:506`).
   The only separate write left is `takeBack`'s `add` when the item is already gone (`driver.js:509-511`), where there's nothing to delete, so a
   close between commits can't lose anything (M3e-2 is a different problem). I found no remaining place where closing a page between two commits
   loses an undo.
3. **`rekey()` through `update()`:** each item is re-read in the transaction that writes it (`queue.js:125-131`). An Undo tapped between the snapshot
   and the write is kept: the re-key copies the current item, `state: 'undone'` included, and a check-in that became `undone` is no longer treated as
   a `send` check-in. `reject()` is now an `update()` too (`queue.js:143-145`). A tap can't be overwritten.
4. **The new specs and control (k):**
   - **"an Undo tapped while the check-in is on its way, sent by another tab without Web Locks…":** tab A's POST is held with a page-level route,
     tab B has no route, so its re-send and DELETE really reach my Worker. The test requires tab B's DELETE to answer 200, one voided row, and still
     voided after tab A's late POST. Control (k) removes the re-send and brings back the quiet 404: tab B's DELETE then answers 404 and the row
     stays live, so the test goes red. Honest.
   - **The never-stored and moved-stop tests** now require a stored, voided row and nothing in "Not accepted", matching clarification 49.
   - **The two-tab no-locks run** now requires exactly 2 POSTs before release (closes M3d-7).
   - **The billing spec's** two $35.50 rows make the totals row sum (1066) differ from 15 % of the subtotal (1065) (closes M3c-10).
   - **The keys-store spec** is M3e-3.

## M8: DONE

Merged main first (`git merge --ff-only main` → a66cd01: API.md clarifications 52–53, DECISIONS 57). Code commit `e6ebeb2`. Additive: a check-in
without `undo` behaves exactly as before.

### Clarification 52: the check-in POST takes `undo`
- `checkinInput` (`worker/src/index.js:468-469`): `undo` must be a boolean when present, else **400 field `undo`** "The undo flag could not be
  read." It's validated with the other body fields, so a resend of a **stored** id still answers 200 duplicate whatever its body says.
- **A new id with `undo: true`:** the one `INSERT … ON CONFLICT(id) DO NOTHING` writes `voided_at = received_at` (`index.js:508-513`), so the row is
  voided **in the same statement** that creates it. There's no moment when it is a live push, and nothing to undo later. The answer is **201** with
  `checkin.voided: true`.
  - Because it's voided, every reader already leaves it out: billing (`isBillable`), the stop's status and deciding check-in (non-voided only),
    `last` on the status link, `last_plowed_at`, storm counts and the summary.
  - `removable` reads `false`, because a check-in row exists (M7).
  - The skip-after-plowed guard isn't added for an undo (a voided row can never decide a stop). The stop guard is always in the batch, so a client
    no longer on the route answers 404 and nothing is stored.
  - The partial index `checkins_one_plowed` only covers non-voided rows, so a voided plowed undo for a stop someone else plowed is stored too.
- **A stored id:** `ON CONFLICT(id)` inserts nothing, so it's **200 `duplicate`** with the stored row, unchanged, whatever `undo` says. The DELETE
  keeps its 15-minute rule.
- The two older controls that patch this code still find their anchors: ` ON CONFLICT(id) DO NOTHING` (idempotent) and
  `const at = inWindow ? iso(input.at) : iso(ctx.now)` (time).

### Tests
`npm test`: **26 unit tests pass, 68 API tests pass (64 + 4 new), 0 fail, 0 skipped.** New:
- **a new id is stored already voided:** 201, `voided: true`, stop `pending` with no deciding check-in; the raw row's `voided_at` equals its
  `received_at`; owner stop `pending` and `removable: false`; storm counts show nothing plowed; January billing has 0 pushes for the client and
  no month in `billing/months`; the status link has `last: null` and `tonight.state: waiting`; `last_plowed_at` is null; a resend of the same undo is
  a 200 duplicate, still voided, and a DELETE of it is 200.
- **a stored id:** a plain check-in 201, then the same id with `undo: true` → 200 duplicate, `voided: false`, stop still plowed, the raw row not
  voided, one push billed; the DELETE then voids it, the stop is pending and nothing bills.
- **a skip for a plowed stop:** a plain skip is 409 `already_plowed`; with `undo: true` it's 201 voided, the stop stays plowed with the plowed
  check-in deciding, one live row out of two, and one push billed. A second plowed with `undo: true` is also stored voided, and still one push.
- **refusals:** `undo` `"yes"`, `1` and `null` → 400 field `undo` with the exact text, nothing stored; `undo: false` is a normal 201 plowed check-in;
  `undo: true` for a client removed from the route → 404 and nothing stored.

### Negative control `negative:undoflag`: RED
Break: in the copy, `checkinInput` returns `undo: false` whatever the body says, so the re-send stores a live push. The unbroken copy passed first;
the broken copy failed at the first assertion that matters: `AssertionError: stored already voided`, `actual: false, expected: true`.

All **fifteen** controls (a–i, pinguard, statusroute, plowednote, routeversion, removable, undoflag) were re-run on `e6ebeb2`: all RED, each log
section starting with `=== e6ebeb2 …`, and no machine paths in the log.

### For sr2 (M3f)
Send `"undo": true` on the re-send made for an undo (clarification 49). A **201 with `checkin.voided: true`** means the office never had it and now
has it voided: remove the void, and send no DELETE. A **200 `duplicate`** means it was really there: send the DELETE as now (a 409 "too late" there
is a real late undo, for "Not accepted"). Any other answer to the re-send stays as clarification 49 says.
