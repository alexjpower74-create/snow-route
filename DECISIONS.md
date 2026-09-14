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
