# Snow Route — brief (Onyx, 2026-09-14)

**Prefix** `sr` · **Ports** app 7601, worker 7602, QA 7609 · **Repo** `snow-route` (private) · **Lead effort** xhigh

## What
A phone tool for a small snow-clearing contractor in Newfoundland: the client list, tonight's route in order,
a big "Plowed" button with a photo at each stop, a status link each client can check ("Plowed at 6:42 AM" + the
photo), and a month-end count of pushes per client for billing. Sellable to the one- and two-truck operators in
every NL town.

## Owner side (PIN)
Clients: name, address placed as a map pin (Leaflet + OpenStreetMap tiles; follow the OSM tile usage policy,
attribution shown), type (driveway / lot / walkway), priority (medical, early commuter, business opening time),
notes shown at the stop ("gate on left, don't pile by the hydrant"), billing (per push / seasonal contract), and
price. Crews/trucks. **Start a storm**: picks active clients, builds the route: priorities first, then
nearest-neighbour + 2-opt on straight-line distance from the yard — no paid routing API; the owner can drag to
reorder and the app says the order is "by distance, not road time". End storm → summary.

## Driver side (phone in a truck, gloves, bad signal)
Next stop huge: name, address, notes, "Navigate" (opens the phone's maps app with the address), **Plowed**
(camera photo + timestamp), **Skip** with reason (car in the way, gate locked, client cancelled). Works
**offline**: check-ins queue on the phone and sync when signal returns, keeping the original timestamps
(negative control: break the queue, prove a check-in is lost in the test, restore). Tap targets ≥ 56 px.

## Client side
Unguessable status link per client: last plowed time + photo, "on the route tonight, you're stop N" during a
storm (no live GPS). No accounts. Messages to clients are **"copy this text"** buttons only — nothing is sent.

## Billing
Month view: pushes per client, per-push total or seasonal flag, HST 15%, CSV export for the accountant.
The count comes only from check-ins (negative control: a skipped stop must not bill).

## Data
SAMPLE contractor "SAMPLE Snow Clearing — Grand Falls-Windsor (demo)" with ~25 SAMPLE clients on real
public streets but SAMPLE names, labelled SAMPLE everywhere. Photos in tests are generated placeholders.
