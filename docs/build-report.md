# Snow Route: build report (lead)

Overnight build 2026-09-14. Lead `sr-lead` (Opus 5 xhigh), slices `sr1` Worker and `sr2` app (Opus 5 medium, auto mode), run with Rig.
Every number below was measured by the lead in a QA worktree pinned to the named sha on port 7609 (negative-control Workers on
7605/7606), never in a slice's own tree. The slices' own reports (`docs/build-report-sr1.md`, `docs/build-report-sr2.md`) hold their
reasoning and every attempt.

## QA history

| Merge | sha | Worker unit | Worker API (`wrangler dev --local`) | Negative controls run by the lead | Playwright |
|---|---|---|---|---|---|
| sr1 M1 | `8863e14` | 18 / 0 / 0 | 34 / 0 / 0 | twoopt, tiers, idempotent, time: all red | n/a |
| sr2 M1 | `110f190` | 18 / 0 / 0 | 34 / 0 / 0 | a-d re-run after the merge: all red. sr2's queue control ran against its mock (M2 moves it to the real Worker) | integration smoke, below |
| sr1 M2 | `9de4176` | 23 / 0 / 0 | 53 / 0 / 0 | a-h: all eight red | n/a |
| sr1 M3 | `6df5a27` | 23 / 0 / 0 | 56 / 0 / 0 | a-h, stoprace, pinguard: all ten red | n/a |
| sr1 M4 | `7ca9f24` | 23 / 0 / 0 | 57 / 0 / 0 | the ten above plus statusroute: all eleven red | n/a |
| sr1 M5 | `a3c0a1b` | 26 / 0 / 0 | 58 / 0 / 0 | the eleven above plus plowednote: all twelve red | n/a |
| sr1 M6 | `c63bbc5` (branch; merged with sr2 M3c, DECISIONS 46) | 26 / 0 / 0 | 63 / 0 / 0 | the twelve above plus routeversion: all thirteen red, each after its unbroken pass | n/a |
| sr1 M7 | `caadcad` | 26 / 0 / 0 | 64 / 0 / 0 | the thirteen above plus removable: all fourteen red, each after its unbroken pass | n/a |
| sr2 M2 | `69076b5` | (Worker as `7ca9f24`) | (as `7ca9f24`) | app: queue, time, overlay: all red | 56 / 0 / 4 (the 4 skips: two phone-width checks on each 1280 project, replaced by project filters in sr2 M3a) |
| sr2 M3a | `5f162b2` | (Worker as `a3c0a1b`) | (as `a3c0a1b`) | app: queue, time, overlay, relink: all red, each after its unbroken pass | **80 / 0 / 0** |
| sr2 M3b | `318e64e` | (Worker as `a3c0a1b`) | (as `a3c0a1b`) | app: the four above plus billing: all five red, each after its unbroken pass | **122 / 0 / 0** |
| sr2 M3c (+ sr1 M6) | `2213dc3` | 26 / 0 / 0 | 63 / 0 / 0 | app: the five above plus twotabs, crosstruck, hst: all eight red, each after its unbroken pass | **158 / 0 / 0** |
| sr2 M3d | `aa04bba` | (Worker as `caadcad`) | (as `caadcad`) | app controls (a–j) run in the final QA: port 7606 was in use by sr2's own control run (DECISIONS 53) | **176 / 0 / 0** |

Counts are passed / failed / skipped.

## Integration smoke (lead, `110f190`, before any cross-slice test suite existed)

sr2's M1 pages were checked only against its in-browser mock, so the lead ran them against sr1's real Worker in the QA worktree on 7609
(`TEST_MODE=1`, fresh state) with Playwright chromium at 390: reset → owner sign-in → start a storm with all 25 clients and both trucks →
the driver page shows "Stop 1 of 13", Pat (SAMPLE), Medical, the notes, Navigate / Plowed / Plowed, no photo / Skip → the second stop's
status link says "On the route tonight. You're stop 2." → a plowed check-in through the API answers 201 → the first client's status link
says "Plowed at 6:05 AM" → the driver page moves on to "Stop 2 of 13". Zero console errors, zero API answers ≥ 400.

## Negative controls (what each break proved)

| Check | Break (in a copy, never the shipped code) | Seen red |
|---|---|---|
| 2-opt reaches a local optimum and removes a crossing | a tier is ordered by nearest neighbour alone | "2-opt local optimum" and "crossing" fail |
| Medical, then commuter/business, then the rest | every stop put in the last tier | "tiers" fails |
| Resending a check-in is harmless | `checkins.id` not a primary key and a plain `INSERT` | the resent skip answers 201 and is stored twice |
| A check-in keeps the time the driver tapped | the insert stamps the sync time | stored `09:50Z` instead of the tapped `09:05Z` |
| A skipped stop never bills | billing stops checking `kind` | Jordan (SAMPLE), skipped only, billed 1 push, $46.00 |
| Pushes fall in the NL month | month bounds from UTC midnight | a Jan 31 11:30 PM NST push vanishes from January |
| The CSV never hands a spreadsheet a formula | the formula guard line removed | `=SUM(A1)` written as is |
| An undone check-in never bills | billing stops checking `voided_at` | Chris (SAMPLE), undone, billed 1 push |
| A check-in never lands on a stop being removed | the stop guard dropped from the check-in batch (both runs get the same 25 ms stand-in gap) | guarded: 0 of 10 check-ins on removed stops; broken: 10 of 10, each answering 500 |
| Wrong current PINs on PIN change count toward the lockout | the PIN change's attempt slot removed | the 6th try answers 204 instead of 429 |
| App: a check-in made with no signal survives until the server has it | the copy's queue removes the item before sending | the photo check-in was gone from the phone; the driver screen went back to Pat (SAMPLE) |
| App: the queue sends the time the driver tapped | the copy's queue stamps `at` when it sends | `at` 09:40Z instead of the tapped 09:00Z |
| App: taps land on the button they aim at | a transparent full-size element over Plowed | the hit-test found the overlay `div`, not the button |
| App: the billing screen shows the API's push count | the copy's billing screen counts the client's storm stops instead | the skipped seasonal client showed 1 push where the API says 0 |
| App: two open tabs of the driver link never void a push | the copy reads a missing item after 200/201 as "undone" and sends without the Web Lock | a stored push was voided by a DELETE nobody tapped |
| App: photos and undos never go to another truck's link | the copy re-keys photos and undos across trucks | a photo PUT and an undo DELETE went out under truck 2's key |
| App: the billing screen's HST is the API's, not the page's | the copy computes HST on the page with `Math.floor(amount * 0.15)` | $5.32 shown where the API row says $5.33 |
| App: a reset driver link never blocks check-ins saved under it | the copy's queue stops everything on a 401, as in M1 | both check-ins stayed on the phone; nothing reached the server |
| A plowed check-in keeps no note | the copy stores the body's note for plowed | the stored note was "Left a note" |
| A route edit from a stale screen never lands | the copy drops the in-batch `route_version` guard | the stale edit answered 200 instead of 409, and both racing edits got 200 |
| The owner is offered Remove only where the office allows it | the copy computes `removable` from non-voided check-ins only | a stop whose check-in was undone said `removable: true` while its DELETE still answered 409 |
| A mangled status link reads as a bad status link | the old router pattern `[A-Za-z0-9_-]{1,128}` restored | a trailing dot got "There's nothing here." instead of "Ask your snow clearing company for a new one." |

## Cross-review

**sr2 read sr1's M1 Worker** (read only, at `110f190`) before building M2. Every shape, status code, label and header the pages use matched.
Two wording mismatches went to sr1 as M5: a plowed check-in still stored its `note` (API.md 10 says ignored), and the 500 text. The other
notes were routes not yet built at that sha (all built in sr1 M2) and a test-only route accepting an early `at` (no action).

**sr1 read sr2's M1 app code** (read only, on `6df5a27`) against docs/API.md and its own Worker. Everything the pages send and read
matched by name and type. It found five defects that no test on either side would have caught, because each sits on the boundary:

| # | Defect | Who it hurts | Adopted as |
|---|---|---|---|
| R1 | After "New link", a 401 on the oldest queued item stopped the whole queue, so nothing from that phone ever synced again | driver, owner, clients | API.md 17: skip the dead key, re-key to the page's working link |
| R2 | A status link with punctuation glued on hit the router's "There's nothing here." | client | API.md 18: Worker routes every status path to its handler; app shows its own bad-link text |
| R3 | A status page on a 404 kept re-checking on every tab switch, feeding the per-IP guard | everyone behind that IP | API.md 18: stop checking after a 404; DEPLOY.md note |
| R4 | Undo on a refused check-in threw away the refusal and queued a DELETE that could only fail | driver, owner | API.md 19: remove locally only |
| R5 | A queued check-in for a stop moved to another truck vanished from the screen | driver | API.md 20: "Saved for stops on another route" row |

**sr1 read sr2's M2 while it was still in progress** (`4a8c8ba`, through git only). Bodies, field names and error placement matched; six more:

| # | Defect | Who it hurts | Adopted as |
|---|---|---|---|
| M2-1 | Every owner 401 signed the owner out, so a typo in "current PIN" would end a working session | owner | API.md 21 |
| M2-2 | The Undo spec skipped itself when the undo route looked missing: a lost route would read as skipped, not red | the lead's QA | API.md 25 |
| M2-3 | A storm started on another screen left the owner on a dead picker after the 409 | owner | API.md 22 |
| M2-4 | `.50` and `45.` refused as prices | owner | API.md 23 |
| M2-5 | Re-keying photos and undos to a different truck's link would get 404 | driver sharing a phone | API.md 24 |
| M2-6 | The offline spec's faked 500 still carried the old error text | test fidelity | fix in sr2 M3 |

**sr1 read sr2's M3a** (the review fixes, `38cc37e`, through git). The owner 401 rule, the storm 409, price parsing and the status page's stop
all checked out, and `queue.spec`'s link-reset test measures what it claims. Seven findings, the first a real billing bug:

| # | Defect | Who it hurts | Adopted as |
|---|---|---|---|
| M3a-1 | Two open tabs of the driver link: the second tab's duplicate send finds the item gone, reads it as "undone" and voids a real push | owner (lost billing), client, driver | API.md 26: explicit undo mark + one sender across tabs (Web Lock) |
| M3a-2 | An undo the sender creates in flight has no `truck_id`, so after a link reset it is wrongly "stuck" and never sent | driver, owner | API.md 27 |
| M3a-3 | After End storm, still-sending check-ins read as "moved off this route" with an Undo that deletes unsent work | driver, owner | API.md 28 |
| M3a-4 | The cross-truck rule for photos and undos had no test and no negative control | the lead's QA | API.md 29 |
| M3a-5 | A dropped photo for a stop on another route left no trace | driver, owner | API.md 30 |
| M3a-6 | A storm-start notice could surface on the next storm | owner | API.md 31 |
| M3a-7 | A re-keyed check-in for another route's stop was listed twice | driver | API.md 31 |

**sr1 read sr2's M3b while it was in progress** (`7a9876c`). Route PUT bodies, Add a stop, End storm and the summary, billing cells from the
API rows, the CSV passed through as a blob, trucks, clients, settings and exact copy texts all checked out. Eight findings:

| # | Defect | Who it hurts | Adopted as |
|---|---|---|---|
| M3b-1 | An edit from a stale route got 400 "List every truck… once" instead of "the route changed", and the spec accepted either | owner on two screens | API.md 32 (`route_version`, sr1 M6) |
| M3b-2 | The billing spec's prices needed no HST rounding, so a page recomputing money would pass | the lead's QA, the accountant | API.md 34 + a negative control |
| M3b-3 | The CSV check compared cells, not the Worker's bytes | the accountant | API.md 35 |
| M3b-4 | Two screens editing the route: the last save silently won | owner and helper | API.md 32 |
| M3b-5 | End storm / Add a stop refused because the storm ended elsewhere left the owner on a dead storm | owner | API.md 36 |
| M3b-6 | No way to past storms while a storm is on | owner | API.md 36 |
| M3b-7 | No way to take a stop off tonight's route | owner | API.md 37 |
| M3b-8 | The yard's map error showed under the yard name box | owner | API.md 33 (sr1 M6) |

**sr1 read sr2's M3c steps 1-2** (`0994459`: the two-tab fix and `route_version`). No path left that sends a DELETE the driver did not tap,
the lock wraps the whole send loop, and consecutive edits on one screen always carry the right version. Five findings:

| # | Defect | Who it hurts | Adopted as |
|---|---|---|---|
| M3c-1 | An Undo tapped after the POST reached the office but its answer was lost is deleted locally, and the push stays billed | owner, client, driver | API.md 38 |
| M3c-2 | A tab whose request stalls on a dead link holds the send lock and blocks the tab on screen | driver | API.md 39 |
| M3c-3 | The owner's 30 s refresh can paint an older route over a just-saved one, then the next edit is refused as stale | owner | API.md 40 |
| M3c-4 | The two-tab control broke two defences at once, so the missing-means-undone rule alone was never proven; the response-lost path had no test | the lead's QA | API.md 41 |
| M3c-5 | The Undo confirm said "has not reached the office" for check-ins usually in flight | driver | API.md 38 |

**sr1 read sr2's M3c steps 3-11** (`f1d486d`) and corrected its own earlier arithmetic (M3b-2): `Math.round(a * 0.15)` never differs from the
half-up rule. The cross-truck control (g), the truncating HST control (h), the CSV byte check, ended-storm wording, the 409 flows, Past storms
and yard errors all checked out. Six findings:

| # | Defect | Who it hurts | Adopted as |
|---|---|---|---|
| M3c-6 | "Remove from tonight" shown on a stop whose only check-in was undone; the office refuses it every time | owner | API.md 42 (`removable`, sr1 M7) |
| M3c-7 | A check-in re-keyed across trucks whose first POST was stored under the old truck could send its photo to a truck that answers 404 | driver sharing a phone, owner | API.md 43 |
| M3c-8 | A removal refused with 404 (removed on another screen) left the stale row | owner | API.md 44 |
| M3c-9 | After a storm ends, "Photo not sent" notes read as stops moved off the route | driver | API.md 45 |
| M3c-10 | The billing totals would pass a page computing total HST from the subtotal | the lead's QA | API.md 46 |
| M3c-11 | The keys store was never exercised by any spec | the lead's QA | API.md 47 |

**sr1's last review, of sr2's M3d** (`aa04bba`), tagged by severity (DECISIONS 52, 54). Nothing was DATA LOSS or SECURITY. The `attempted` flag is
written before the POST can leave, the timeout never removes an item, a lone hidden tab still sends, and the new specs are honest. Eight findings:

| # | Tag | Defect | Adopted as |
|---|---|---|---|
| M3d-1 | BILLING | Without Web Locks or after a timeout, an undo's DELETE could beat its POST, get 404 and be dropped, and the push billed | API.md 49 |
| M3d-2 | BILLING | A wrong-truck undo also answers 404 and was dropped silently | API.md 49 |
| M3d-3 | BILLING | Undone item removed and its void added in two transactions: a page closed between them lost the undo | API.md 50 |
| M3d-4 | BILLING | `rekey()` wrote back a stale snapshot over an Undo tapped a moment before | API.md 50 |
| M3d-5 | OTHER | A slow photo upload timing out held every later check-in back | API.md 51 (fixed anyway) |
| M3d-6 | OTHER | `attempted` skipped when `navigator.onLine` is false | README known gaps |
| M3d-7 | OTHER | The no-locks two-tab run could pass without its race | API.md 51 (fixed anyway) |
| M3d-8 | OTHER | Clarification 40's lower-version rule has no standalone control | README known gaps |

**sr1 read sr2's M3e billing fixes** (`0590380`, clarifications 49-50). No DATA LOSS or SECURITY; every undone-to-void conversion is one transaction,
`rekey()` can no longer overwrite a tap, the re-send cannot loop or go to the wrong truck, and control (k) is honest. Four findings:

| # | Tag | Defect | Adopted as |
|---|---|---|---|
| M3e-1 | BILLING | The undo's re-send could itself create a live push that a >15-minute signal drop then made impossible to undo | API.md 52 (`undo: true`, sr1 M8 + sr2 M3f) |
| M3e-2 | OTHER | A second Undo tap on a stale row could replace a re-send void with a plain one | API.md 53 (fixed anyway) |
| M3e-3 | OTHER | The keys-store spec passed with the store broken | API.md 53 (fixed anyway) |
| M3e-4 | OTHER | Clarification 50's single transactions have no negative control | README known gaps |

QA procedure note: every negative control appends to the tracked `worker/tests/negative-control.log`, which leaves the QA worktree dirty
and makes the next `rig qa --ref` fail its `git checkout --detach` (it happened once, at `690c417`; that run was discarded, not reported).
The lead copies the log out to the session scratchpad and restores the file after each run, before re-pinning.
