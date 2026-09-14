# Decisions

Alexander was asleep for this build; every real call is written here with its reason. Newest at the bottom.

## 2026-09-14, lead (contract)

1. **One deployment per contractor.** The buyers are one- and two-truck operators; one Worker + one D1 + one R2 bucket each keeps
   the data apart without a tenant column. Multi-company hosting is a later change, not a hidden assumption.
2. **One Worker serves the API and the app** (`/api/*` Worker first, the rest static from `app/public`). Same origin means no CORS
   and one thing to deploy. Plain JS, no build step, the Book a Bay / Next Up pattern. Photos go in R2 (not D1 rows).
3. *(Superseded by 68-70: that source broke robots.txt; the points now come from Statistics Canada's National Road Network.)* **SAMPLE clients sit on real streets with no house numbers.** The brief asks for real public streets. A made-up house number on
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
13. *(Superseded by 62: the owner map now uses OpenFreeMap.)* **Map tiles are OpenStreetMap's standard tiles at owner-screen volume only**, with the attribution always visible and no
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
46. **sr1's M6 (the required `route_version`) is QA'd on its own branch but merged into main only when sr2 starts M3c.** Merging it earlier
    would make main's route-editing specs red, because sr2's M3b page does not send the version yet. Main stays green at every merge; the
    two halves of one contract change land back to back.

## 2026-09-14, lead (after sr1's review of sr2 M3c steps 1-2, `0994459`)

47. **An Undo is judged by whether the check-in may have left the phone, written down before it leaves** (API.md 38). The first fix stopped
    phantom undos but could drop a real one when the POST reached the office and the answer was lost, the most ordinary failure in a truck
    with one bar. A DELETE for a check-in the office never got is harmless (404, removed quietly), so "may have left" always sends the undo.
48. **30 seconds is the driver request timeout** (API.md 39). A request on a dead cellular link can hang for minutes and would hold the
    send lock; 30 s is long enough for a slow upload of a 1600 px photo on a weak signal and short enough that the driver's screen moves on.
49. **These go to sr2 as M3d after M3c**, as before: sr2 is mid-turn and the fixes touch the same queue code, so a clean hand-off beats an
    interruption.

## 2026-09-14, lead (after sr2 M3c)

50. **The lead's own negative control was one that could not fail, and a slice caught it.** API.md 34 named `Math.round(amount * 0.15)` as
    the break for the billing screen's HST; sr2 ran it first, saw it stay green, and showed why (`3550 * 0.15 === 532.5` in JavaScript, and
    no amount up to $10,000 disagrees with the half-up rule). The control now truncates instead, which shows $5.32 and goes red. The spec
    and its $35.50 price stay: they still catch a page that computes money itself in any way that differs from the API. Recorded because
    this is exactly the failure the rules warn about, and it came from the contract, not from a slice.

## 2026-09-14, lead (after sr1's review of sr2 M3c steps 3-11)

51. **A stop keeps its place on the route once any truck checked in there, even if the check-in was undone** (API.md 42, sr1's option (a)).
    The owner Stop view says `removable` so the page never offers a removal the office will refuse. Letting voided-only stops go would
    also work, but an undone check-in is still evidence a truck was there, and the summary should not lose that.
52. **M3e is the last app round.** The reviews have gone from a night of lost check-ins (R1) and voided pushes (M3a-1) to wording and test
    honesty (M3c-9 to M3c-11). After M3d and M3e land and pass pinned QA, the build moves to its finish: final QA, screenshots, README,
    private repo, status file. Anything a further review finds that is not a data-loss or billing defect goes into the README's known gaps.

## 2026-09-14, lead (sr2 M3d)

53. **M3d's Playwright suite is QA'd at `aa04bba` right away; its app negative controls are run by the lead in the final QA instead.** sr2's
    own control run was using port 7606 when M3d's code landed, and two control runs on one port measure each other. The final pinned QA
    after M3e runs every app control (a–j and M3e's) on the merged code, so no control goes unverified by the lead.
54. **sr1's last review tags each finding DATA LOSS, BILLING, SECURITY or OTHER** (the M3e scope rule, DECISIONS 52), so the finish line is set by
    severity, not by how many rounds a reviewer can keep finding wording to improve.

## 2026-09-14, lead (after sr1's last review, of sr2 M3d `aa04bba`)

55. **"Re-send the check-in, then undo it" beats "a 404 means nothing to undo"** (API.md 49). The 404 shortcut was only true if no earlier
    copy of the POST could still arrive, and on a phone without Web Locks or after a timeout that cannot be ruled out; a dropped undo bills a
    push the driver took back. Re-sending is free because the check-in id makes it idempotent. The price is a voided row for a check-in that
    never reached the office, which never bills and keeps the stop from being removed. That is honest: the driver did tap Plowed there.
56. **Two OTHER findings are fixed anyway, two go to known gaps.** Check-ins before photos (M3d-5) protects the core promise that check-ins
    reach the office when signal comes back, and costs one ordering rule. Requiring exactly 2 POSTs (M3d-7) keeps a billing test from passing
    without its race. `navigator.onLine` as a hint (M3d-6) and the version rule's missing standalone control (M3d-8) are written into the README's
    known gaps; neither can lose a check-in or bill wrongly on its own.

## 2026-09-14, lead (after sr1's review of sr2 M3e steps 1-2, `0590380`)

57. **The undo re-send says it is an undo** (API.md 52, sr1's contract option). M3e's re-send-then-DELETE closed the lost-undo paths but opened a
    narrow one of its own: when the check-in never reached the office, the re-send created a live push, and a signal drop of more than 15
    minutes before the DELETE left it billed ("too late to undo"). An app-side retry cannot fix that because the Worker's 15-minute rule is
    right for real pushes. One optional flag lets the office store a never-arrived check-in already voided in the same statement: no window,
    no looser rule, and a real push that arrived earlier is still undone the normal way. It is BILLING, so it is fixed (DECISIONS 52): sr1 M8
    (additive, merged when QA'd) and sr2 M3f (the app sends it), with two cheap OTHER fixes in the same app files.
58. **M3f gets no separate review round.** It sends one flag whose Worker side sr1 designed and QA'd (M8), changes one `add` to `update()`,
    and adds a spec and negative control (l). The lead's final pinned QA runs every Worker control and every app control (a-l) on the merged
    code, so (l) is verified by the lead, not just by its author. sr1 stays open until that QA passes, in case the Worker needs a fix.

## 2026-09-14, lead (polish after Onyx's review of the real demo)

59. **Each truck's route pins carry its ring colour AND a shape of its own** (round, square, dashed ring), and the list headers and legend
    show the same mark ("Truck 2 (SAMPLE): square pins, white line"). With two trucks both numbered from 1, the old identical pins showed two
    "1"s and two "7"s that could only be told apart by following faint lines, and blue against white is not a difference everyone can see.
    Shape is the cue that never depends on colour; a dark outline keeps the white ring readable on light map tiles. A spec checks each
    truck's pins match its legend and that the trucks differ in colour and shape; control (m) draws every pin with truck 1's look and goes red.
60. **The demo placeholder photo is a card that says what it is**: a drawn camera, "Photo taken 7:51 AM", the stop name and the SAMPLE label,
    instead of a dark block over a flat white one that read as a broken image. It stays a generated SVG (no real picture of any home). A unit
    test checks the card; the old placeholder was run against that test and fails it.
61. **Onyx's running demo was restarted, not duplicated.** The placeholder photos are made when the demo seeds, so new screenshots needed a
    fresh seed: the running copy was stopped by its exact pids, port 7601 checked free, and one copy started again and left running.

## 2026-09-14, lead (map tiles: OpenFreeMap, Alexander's ask via Onyx)

62. **The owner map uses OpenFreeMap** (<https://openfreemap.org>), chosen by Onyx for Alexander as the free provider fit for selling Snow
    Route widely. Onyx's check of the alternatives: OpenStreetMap's standard tiles (its policy says commercial access may be withdrawn),
    MapTiler Free and Stadia Free (non-commercial only) and self-hosted Protomaps (more setup, a paid Worker, protomaps-leaflet in
    maintenance mode) were rejected. The lead read OpenFreeMap's own pages on 2026-09-14 (saved in `data/sources/`):
    - Home page, fetched 2026-09-14T16:26:17Z: "Is commercial usage allowed? Yes." · "Using our public instance is completely free: there are
      no limits on the number of map views or requests. There’s no registration, no user database, no API keys, and no cookies." ·
      "At the moment, I don’t offer SLA guarantees or personalized support."
    - Home page, on attribution: "Attribution is required. If you are using MapLibre, they are automatically added, you have nothing to do.
      If you are using alternative clients, or if you are using this in printed media or video, you must add the following attribution:
      OpenFreeMap © OpenMapTiles Data from OpenStreetMap"
    - Quick start (<https://openfreemap.org/quick_start/>, fetched 2026-09-14T16:24:56Z), the attribution markup used verbatim in
      `owner.js`: `<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> <a href="https://www.openmaptiles.org/" target="_blank">© OpenMapTiles</a>
      Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>`.
    Through the Leaflet binding, MapLibre's own attribution control is switched off, so Snow Route counts as an "alternative client" and adds
    the attribution itself (the binding's `attributionControl.customAttribution`), visible on every owner map. A test checks the three links
    are there and uncovered; control (n) empties it and goes red.
63. **MapLibre GL 5.24.0 with @maplibre/maplibre-gl-leaflet 0.1.4, vendored and pinned, not 6.x.** OpenFreeMap's quick start documents the
    Leaflet path with `maplibre-gl@5` and the binding, which reads the classic global `maplibregl`; 6.9.0 ships ES modules only, with no
    classic build. 5.24.0 is the newest 5.x. Leaflet, pins, the truck shapes and drag-to-reorder are unchanged: the vector map is one
    Leaflet layer. If WebGL is missing, the map falls back to a plain background with the pins and the attribution.
64. **The style URL is one config value, `MAP_STYLE_URL`, read by the Worker and answered as `map_style_url`** (API.md 54), defaulting to
    OpenFreeMap `positron` in `worker/src/map.js`. It is a Worker variable set at deploy, not a `[vars]` block in `wrangler.toml`, because a
    unit test forbids any `[vars]` there to keep `TEST_MODE` out. Moving to self-hosted tiles is then a config change.
65. **`positron`, not `liberty`.** Both were screenshotted on the real tiles with tonight's route at 1280: on positron's neutral greys the
    round blue-ring pins, square white-ring pins and route lines all stand out; on liberty the blue water sits close to truck 1's blue
    rings and line, and orange roads and green parks compete with the pins.
66. **Tests never touch the internet.** The shared fixture answers `https://tiles.openfreemap.org/styles/*` with a tiny local style (a
    background layer, so MapLibre requests no tiles, glyphs or sprites); any other request to that host or any other host still fails the
    test. `blob:` and `data:` URLs are let through: they are objects inside the page (MapLibre starts its web worker from one), and WebKit
    routes them where Chromium does not.
67. **Desktop screenshots are taken by growing the viewport, not with Playwright's full-page capture.** The first Chromium 1280 full-page
    shots of the owner map showed the vector map on only its left strip. A probe on the running demo found the MapLibre canvas covering the
    whole map in every state (635 px map inside a 760 px canvas, the binding's 10% padding, before and after a resize to page height), and
    plain element screenshots at rest, right after the resize and after it settled all showed the full map. So it was Chromium's full-page
    capture grabbing the WebGL canvas mid-resize, not something an owner would see. The docs screenshot script now sets the viewport to
    the page height, waits for the map to redraw, then takes a normal screenshot.

## 2026-09-14, lead (SAMPLE street points: a robots.txt fix, found by Home Care's lead via Onyx)

68. **The original street points broke our robots.txt rule, and are replaced.** Decision 3's points came from one query to
    `https://overpass-api.de/api/interpreter` (2026-09-14T08:00:49Z). That host's robots.txt, read by the lead at 2026-09-14T20:00:53Z
    (saved in `data/sources/robots/overpass-api.de.txt`), says:
    ```
    User-agent: *
    Disallow: /api/
    Disallow: /munin/
    Sitemap: https://z.overpass-api.de/api/sitemap
    ```
    so the query path was disallowed and should never have been fetched (LEAD-RULES §4: robots.txt obeyed). The Overpass answer and query
    are removed from `data/sources/`; they remain in this private repo's git history, which is not rewritten. Replacements were checked
    before any download, each robots.txt saved in `data/sources/robots/`:
    - download.geofabrik.de (20:00:57Z): `Disallow: *.osm.pbf` and `Disallow: *.shp.zip`, so its Newfoundland extracts are out. Only the
      500 MB+ GeoPackage format is not listed, and using that gap would dodge the rule's intent.
    - ftp.maps.canada.ca (20:01:48Z): `Disallow: /pub`, which covers the NRCan copy of the National Road Network.
    - open.canada.ca (20:01:55Z): the dataset catalogue page is allowed, with `Crawl-delay: 20`. The lead fetched that page 2 s after its
      robots.txt, 18 s short of the delay, and waited properly before the one later request (the licence page).
    - geo.statcan.gc.ca (20:02:41Z): no robots.txt (HTTP 404), which under RFC 9309 means no restrictions. The catalogue's Newfoundland and
      Labrador GeoPackage link points here; it was downloaded once.
69. **The points now come from Statistics Canada's National Road Network (NRN), Newfoundland and Labrador edition 7.0**, under the Open
    Government Licence – Canada, whose page (fetched 20:02:49Z) requires, when the provider gives no specific statement: "Contains
    information licensed under the Open Government Licence – Canada." That statement is in `data/sample-clients.json`, `data/sources/README.md`
    and the README. Method, run locally on the GeoPackage (sha256 `5250ddf9…`): for each street, take the road segments whose left or right
    place name is Grand Falls-Windsor and that fall inside the town's box, then pin the segment vertex nearest the middle of all that street's
    vertices, so every pin lies on its street. The used segments are saved as `data/sources/nrn-gfw-sample-streets.geojson` (72 KB); the
    24 MB archive is not kept. Against the old pins the median move is 226 m. Two moved about 2 km: the yard, because NRN's Mill Road is a
    144 m stretch in the old Grand Falls part of town, and Scott Avenue, a 5.5 km road whose middle vertex is further east. Birch Drive is not
    in NRN 7.0, so Frankie (SAMPLE) moved to Sapling Street, the nearest unused NRN street to the old pin (122 m). Every client, name, price,
    note and truck is otherwise unchanged. NRN 7.0 is 2018 data, which is enough for SAMPLE pins on long-standing streets.
70. **Migration `0002_company.sql` is edited in place to the new yard** rather than superseded by a new migration. Nothing is deployed,
    every local database (tests, demo) is rebuilt from the migrations on each run, and a unit test ties 0002 to the sample data. Once there is a
    real deploy, applied migrations are never edited.
