# Decisions

Alexander was asleep for this build; every real call is written here with its reason. Newest at the bottom.

## 2026-09-14, lead (contract)

1. **One deployment per contractor.** The buyers are one- and two-truck operators; one Worker + one D1 + one R2 bucket each keeps
   the data apart without a tenant column. Multi-company hosting is a later change, not a hidden assumption.
2. **One Worker serves the API and the app** (`/api/*` Worker first, the rest static from `app/public`). Same origin means no CORS
   and one thing to deploy. Plain JS, no build step, the Book a Bay / Next Up pattern. Photos go in R2 (not D1 rows).
3. **SAMPLE clients sit on real streets with no house numbers.** The brief asks for real public streets. A made-up house number on
   a real street can be somebody's real home, so the addresses are "Harris Avenue, Grand Falls-Windsor, NL" and each pin is the
   centre point OpenStreetMap gives for that street (Overpass query and raw answer saved in `data/sources/`, fetched
   2026-09-14T08:00:49Z). The yard is "SAMPLE yard, Mill Road". Trucks are split north/south at the median latitude so each truck
   has its own area.
4. **Drivers get a secret link per truck, not a PIN.** A PIN typed with gloves in a dark cab is the wrong tool; the owner texts
   the driver link once and the driver saves it. Client status links work the same way. Both keys are ≥ 128 random bits and are
   stored as is, because the owner must be able to copy the same link again; both can be replaced ("New link"), which kills the
   old one. Owner session tokens (which grant everything) are hashed.
5. **Navigate uses the address text**, as the brief says: Apple Maps on iPhone/iPad, the Google Maps directions URL everywhere
   else (it opens the Google Maps app on Android). No paid routing or geocoding API anywhere.
6. **Route order.** Tiers: medical, then early commuter and business opening together, then everyone else. Inside a tier: nearest
   neighbour from where the truck is (the yard, or the last stop of the tier before), then 2-opt on straight-line distance until no
   reversal saves more than half a metre. Clients with a usual truck stay on it; the rest go to the truck working nearest them.
   Business opening times are shown at the stop, not used to reorder: the owner drags if a 6 AM diner must come first. The screen
   says "Order is by distance, not road time."
7. **One plowed check-in per client per storm, enforced by the database** (a partial unique index), and resending the same check-in
   is harmless (its client-made UUID is the primary key). A skip after plowed is refused; plowed after a skip is allowed (the car
   moved). A second pass in one storm is a new storm. This keeps a double tap, a flaky network or two trucks from double billing.
8. **A check-in keeps the time the driver tapped.** The phone's time is stored when it falls between 10 minutes before the storm
   started and 10 minutes after the server's now; outside that the server's time is used and the check-in is flagged
   `at_adjusted`, so a phone with a wrong clock cannot put a push in the wrong month silently.
9. **Check-ins are accepted after the storm ends.** A truck with no signal may sync after the owner taps End storm; refusing would
   lose real work.
10. **The photo uploads separately from the check-in.** The check-in (what billing needs) is tiny and goes first; the photo follows
    when signal allows. "Plowed, no photo" exists because a dead camera or frozen fingers must not stop the route.
11. **Seasonal clients: pushes are counted, not charged by the month.** HST is 15% per row, rounded half up in whole cents, and the
    totals are the sums of the rows, so the CSV adds up exactly in a spreadsheet. The CSV guards formula-looking cells.
12. **Undo is the driver's for 15 minutes.** After that the owner fixes it (owner-side editing of check-ins is a known gap for v1).
13. **Map tiles are OpenStreetMap's standard tiles at owner-screen volume only**, with the attribution always visible and no
    prefetching. The driver and client pages have no map (bad signal, and the client page should not show neighbours). Tests never
    fetch real tiles. A contractor fleet at scale would need a tile provider (DEPLOY.md).
14. **No address search.** Geocoding needs a service with its own usage rules; tonight the owner places the pin by tapping the map.
    Known gap, easy to add later behind the Worker.
15. **The client status page shows a skip reason in plain words** ("We couldn't clear it: gate locked"). The client can fix a locked
    gate; hiding it helps nobody.
16. **Demo data is dated relative to the real date**, not a fake January. A September storm looks odd in a demo, but faked dates
    would be a lie on screen.
17. **Crew shape.** Two slices (the rules allow at most two): sr1 Worker + D1 + R2 + routing + check-ins + billing, sr2 the four page
    groups + Playwright, in three milestones because the owner's storm editing and billing screens need sr1's second milestone.

## 2026-09-14, lead (after sr1 M1, QA at `8863e14`)

18. **Deactivating a truck or a client does not kill its link; "New link" does** (API.md clarification 4). A truck taken off the
    list may still have check-ins waiting on its phone, and locking it out would lose real work. The kill switch is explicit.
19. **The phone's queue treats a refusal differently from a failure** (API.md clarification 5). A 400/404/409 will never succeed on
    retry, so the item moves to a visible "Not accepted" list with the server's words; a 401, 5xx, 429 or no network keeps it queued.
    Nothing is dropped without the driver seeing it.
20. **sr1's extra test-only routes are adopted** (end a storm directly, list raw check-in rows). Tests count rows in the database
    instead of trusting a view that could hide a duplicate. Both answer 404 without `TEST_MODE`, checked before the database is touched.
21. **At most one active storm is enforced by a unique partial index** (sr1's addition), for the same reason as the check-ins: two
    Start taps at once must give one storm and one refusal, not two storms.

## 2026-09-14, lead (after sr2 M1)

22. **The in-browser mock (`api.mock.js`, `mock-data.js`) stays in `app/public`.** It only switches on with `?mock=1`, holds SAMPLE
    data only, never talks to the Worker, and lets the pages be shown with no Worker running. Every Playwright test runs against the
    real Worker, so nothing is graded on the mock. Removing it from a production build is a one-line deploy choice (DEPLOY.md).
23. **A 429 is a failure, not a refusal, and a refused photo drops only the photo** (API.md clarification 11). sr2's M1 queue put
    a 429 in "Not accepted", where the driver would have to clear a check-in that would have gone through a minute later.

## 2026-09-14, lead (after sr1 M2, QA at `9de4176`)

24. **A blocked IP gets 429 for every status link, known ones included** (API.md 12). Answering known keys normally would tell a
    guesser exactly when a guess hit. A client on the same Wi-Fi as a guesser waits ten minutes; that is the cheaper failure.
25. **The rare races get closed, not documented** (API.md 15-16). A check-in landing on a stop the owner is removing at that instant
    would bill a client who is not on the route; wrong current PINs on the PIN-change form would let a stolen session try every PIN
    and lock the owner out. Both are one guarded statement each, so sr1 closes them in M3 rather than leaving a known gap.
26. **Billing rules live in one pure file** (`worker/src/billing.js`, sr1's design): the SQL only fetches a padded window and the pure
    code decides what is a push. Every billing negative control breaks one line there, so the tests prove the one place that decides.

## 2026-09-14, lead (after sr1 M3, QA at `6df5a27`)

27. **Only the check-in side of the stop race gets a negative control.** sr1 offered a second control for the other ordering (the
    removal reads "no check-ins", a check-in commits, the removal writes). The removal's guard and its DELETE run in one `DB.batch()`,
    which D1 runs as one transaction, so that ordering is covered by the database's own guarantee; a stand-in wait inside a single
    transaction would test SQLite, not this code. The check-in side needed proof because its guard was once a separate read.
28. **Stop numbers are rebuilt from a snapshot when stops are removed.** The race test showed that renumbering from the position read
    earlier left gaps when several stops went at once, which would have shown a client "stop 7" on a six-stop route.

## 2026-09-14, lead (after sr1's read-only review of sr2's M1 app code)

29. **Check-ins saved under a dead driver link are resent with the page's working link** (API.md 17). The alternative, keeping them
    until the owner does something, would leave a whole night of pushes on a phone after an ordinary "New link". The check-in id makes
    the resend safe, and the phone really did the work. If the driver opened a different truck's link, the check-ins record that truck,
    which is what happened on the ground.
30. **A mangled status link is fixed in both places** (API.md 18): the Worker routes every status path to the status handler, and the
    app shows its own bad-link text. Messaging apps glue punctuation onto links; the client must always see "ask for a new one".
31. **The per-IP status guard stays** (DECISIONS 24) with a DEPLOY.md note about carrier-shared IPs, because the app no longer retries a
    bad link and one contractor's clients are a small crowd. Loosening it is a known dial, not a hidden risk.

## 2026-09-14, lead (after sr1's early review of sr2's M2 in progress, `4a8c8ba`)

32. **The early review was worth its time**: six findings on a commit that was still being written, including a sign-out on a typo in the
    PIN form and a test that would have reported "skipped" instead of red for a lost route. All six are app-side and go to sr2 in M3
    (API.md 21-25) together with R1-R5 (API.md 17-20).
33. **A skip can pass for green, so the final QA gates on skips too.** The only skips allowed in the pinned run are named WebKit limits with a
    written reason; any other skip counts as a failure (API.md 25), the same call Book a Bay made (its DECISIONS 19).
34. **Photos and undos stay with the truck that made the check-in** (API.md 24). The Worker accepts them only from that truck, which keeps a
    borrowed phone from editing another truck's work; the phone keeps such items visible instead of sending them to a certain 404.

## 2026-09-14, lead (after sr2 M2)

35. **On WebKit, "no signal" in the offline test is every `/api` request failing at the network layer, and the offline reload step is
    skipped there.** sr2's probe showed Playwright's WebKit cannot read a chosen file at all once the context is set offline
    (`createImageBitmap`, a blob `<img>` and `arrayBuffer()` all fail), which a real iPhone does not do with a photo already on the phone.
    The queue sees the same thing either way (a failed fetch). The time, photo and database checks are identical in both engines;
    Chromium keeps the true `setOffline` path, the service-worker reload included. This is a test-harness limit, written as a test
    annotation, not a product gap.
36. **The "Worker answers 500 once" test fakes the 500 with Playwright's routing**, not with a switch in the Worker. A fail-on-demand lever in
    shipped code is exactly the kind of switch the rules forbid.
37. **The mock covers only driver and status routes.** No test uses the mock; it exists to show pages without a Worker. Extending it to the
    owner side is not worth the upkeep.

## 2026-09-14, lead (after looking at the owner screenshots, sent to sr2 with M3b)

38. **At 1280 the maps stay in view.** The owner's Tonight and Clients screens put a 25-row list beside the map; with the map vertically
    centred in its column, the owner scrolls the list and loses the map. The map column is sticky at the top instead.
39. **Map pins use the Design tokens, with a one-line legend.** The first Clients map showed red pins that no token and no legend explained.
    A colour the owner cannot read is noise on a storm night.
40. **M3 was split into M3a (review fixes) and M3b (the rest of the owner side)** so the high-risk queue fix (a dead driver link blocking a
    whole night of check-ins) was QA'd and merged on its own before another large change landed on the same files.

## 2026-09-14, lead (after sr1's review of sr2 M3a)

41. **An undo must be something the driver did, never something the phone inferred** (API.md 26). sr1 traced a path where two open tabs of
    the driver link turn a harmless duplicate send into a DELETE that voids a real push: the stop goes back to pending and never bills.
    Two fixes together: an explicit undo mark (the inference is gone), and one sender at a time across tabs with a Web Lock (Chromium and
    Safari 15.4+ both have it). Either alone would close this path; both keep the next one from opening. It gets a two-tab test and a
    negative control.
42. **The M3a review findings go to sr2 as M3c after M3b**, not by interrupting M3b. The bug needs two tabs of the same driver link, which is
    rare tonight (nothing is deployed) and common in the field; it must be fixed and QA'd before this build is called done, not before M3b.

## 2026-09-14, lead (after sr1's early review of sr2 M3b, `7a9876c`)

43. **The route gets a version number** (API.md 32), sr1's proposal. Without one, an edit from a stale screen got a message about a
    malformed request, and two screens editing the route silently undid each other (the last save won). One integer bumped inside the same
    batch as every route change gives both a precise "the route changed" and a real guard. It is a contract change on both sides: sr1 builds
    it as M6 now, sr2 sends it in M3c.
44. **"Remove from tonight" is added** (API.md 37). The Worker route existed and a client calling to cancel is an ordinary storm-night
    event; without it the owner could only skip the stop from a driver's phone.
45. **Test honesty over test count.** Two of sr1's findings (M3b-2, M3b-3) were specs that passed for the right code but would also pass for
    a page that recomputes money or rebuilds the CSV. Both get a data change that forces the difference to show, and the HST one gets a
    negative control.
