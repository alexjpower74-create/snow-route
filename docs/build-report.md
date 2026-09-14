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
| A mangled status link reads as a bad status link | the old router pattern `[A-Za-z0-9_-]{1,128}` restored | a trailing dot got "There's nothing here." instead of "Ask your snow clearing company for a new one." |

## Cross-review

**sr1 read sr2's M1 app code** (read only, on `6df5a27`) against docs/API.md and its own Worker. Everything the pages send and read
matched by name and type. It found five defects that no test on either side would have caught, because each sits on the boundary:

| # | Defect | Who it hurts | Adopted as |
|---|---|---|---|
| R1 | After "New link", a 401 on the oldest queued item stopped the whole queue, so nothing from that phone ever synced again | driver, owner, clients | API.md 17: skip the dead key, re-key to the page's working link |
| R2 | A status link with punctuation glued on hit the router's "There's nothing here." | client | API.md 18: Worker routes every status path to its handler; app shows its own bad-link text |
| R3 | A status page on a 404 kept re-checking on every tab switch, feeding the per-IP guard | everyone behind that IP | API.md 18: stop checking after a 404; DEPLOY.md note |
| R4 | Undo on a refused check-in threw away the refusal and queued a DELETE that could only fail | driver, owner | API.md 19: remove locally only |
| R5 | A queued check-in for a stop moved to another truck vanished from the screen | driver | API.md 20: "Saved for stops on another route" row |

QA procedure note: every negative control appends to the tracked `worker/tests/negative-control.log`, which leaves the QA worktree dirty
and makes the next `rig qa --ref` fail its `git checkout --detach` (it happened once, at `690c417`; that run was discarded, not reported).
The lead copies the log out to the session scratchpad and restores the file after each run, before re-pinning.
