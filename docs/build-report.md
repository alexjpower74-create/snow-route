# Snow Route: build report (lead)

Overnight build 2026-09-14. Lead `sr-lead` (Opus 5 xhigh), slices `sr1` Worker and `sr2` app (Opus 5 medium, auto mode), run with Rig.
Every number below was measured by the lead in a QA worktree pinned to the named sha on port 7609 (negative-control Workers on
7605/7606), never in a slice's own tree. The slices' own reports (`docs/build-report-sr1.md`, `docs/build-report-sr2.md`) hold their
reasoning and every attempt.

## QA history

| Merge | sha | Worker unit | Worker API (`wrangler dev --local`) | Negative controls run by the lead | Playwright |
|---|---|---|---|---|---|
| sr1 M1 | `8863e14` | 18 / 0 / 0 | 34 / 0 / 0 | twoopt, tiers, idempotent, time: all red | n/a |

Counts are passed / failed / skipped.

## Negative controls (what each break proved)

| Check | Break (in a copy, never the shipped code) | Seen red |
|---|---|---|
| 2-opt reaches a local optimum and removes a crossing | a tier is ordered by nearest neighbour alone | "2-opt local optimum" and "crossing" fail |
| Medical, then commuter/business, then the rest | every stop put in the last tier | "tiers" fails |
| Resending a check-in is harmless | `checkins.id` not a primary key and a plain `INSERT` | the resent skip answers 201 and is stored twice |
| A check-in keeps the time the driver tapped | the insert stamps the sync time | stored `09:50Z` instead of the tapped `09:05Z` |
