# Snow Route: build report (lead)

Overnight build 2026-09-14. Lead `sr-lead` (Opus 5 xhigh), slices `sr1` Worker and `sr2` app (Opus 5 medium, auto mode), run with Rig.
Every number below was measured by the lead in a QA worktree pinned to the named sha on port 7609 (negative-control Workers on
7605/7606), never in a slice's own tree. The slices' own reports (`docs/build-report-sr1.md`, `docs/build-report-sr2.md`) hold their
reasoning and every attempt.

## QA history

| Merge | sha | Worker unit | Worker API (`wrangler dev --local`) | Negative controls run by the lead | Playwright |
|---|---|---|---|---|---|
| sr1 M1 | `8863e14` | 18 / 0 / 0 | 34 / 0 / 0 | twoopt, tiers, idempotent, time: all red | n/a |
| sr2 M1 | `110f190` | (unchanged) | (unchanged) | sr2's own queue control against its mock (not re-run by the lead: M2 moves it to the real Worker) | integration smoke, below |

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
