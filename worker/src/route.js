// Route building (docs/API.md "Route building"). Pure functions: no I/O, no clock, no randomness.
// A point is { lat, lng }; a stop is a point with a client_id (and priority when tiers matter).

export const EARTH_RADIUS_M = 6371008.8
export const TWO_OPT_MIN_GAIN_M = 0.5
export const TWO_OPT_MAX_PASSES = 200

const rad = deg => deg * Math.PI / 180

/** Haversine distance in metres. Straight line, never road time. */
export function haversine (a, b) {
  const dLat = rad(b.lat - a.lat)
  const dLng = rad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Tier 0 medical, tier 1 early commuter and business opening, tier 2 everyone else. */
export function tierOf (priority) {
  if (priority === 'medical') return 0
  if (priority === 'commuter' || priority === 'business') return 1
  return 2
}

/** Length of the open path start → path[0] → … → path[n-1]. */
export function pathLength (start, path) {
  let total = 0
  let at = start
  for (const p of path) { total += haversine(at, p); at = p }
  return total
}

/** Nearest neighbour from start; ties go to the lower client_id. */
export function nearestNeighbour (start, stops) {
  const left = [...stops].sort((a, b) => a.client_id - b.client_id)
  const path = []
  let at = start
  while (left.length) {
    let best = 0
    let bestD = haversine(at, left[0])
    for (let i = 1; i < left.length; i++) {
      const d = haversine(at, left[i])
      if (d < bestD) { best = i; bestD = d }
    }
    at = left.splice(best, 1)[0]
    path.push(at)
  }
  return path
}

/**
 * 2-opt on an open path with a fixed start and a free end. Reversing path[i..j] swaps the edges (i-1, i) and (j, j+1) for
 * (i-1, j) and (i, j+1); when j is the last stop there is no (j, j+1) edge. First improvement in a fixed scan order, repeated
 * until a whole pass finds no reversal that saves more than 0.5 m, at most 200 passes.
 */
export function twoOpt (start, path) {
  const p = [start, ...path]
  const n = p.length - 1
  for (let pass = 0; pass < TWO_OPT_MAX_PASSES; pass++) {
    let improved = false
    for (let i = 1; i < n; i++) {
      for (let j = i + 1; j <= n; j++) {
        let delta = haversine(p[i - 1], p[j]) - haversine(p[i - 1], p[i])
        if (j < n) delta += haversine(p[i], p[j + 1]) - haversine(p[j], p[j + 1])
        if (delta < -TWO_OPT_MIN_GAIN_M) {
          for (let a = i, b = j; a < b; a++, b--) [p[a], p[b]] = [p[b], p[a]]
          improved = true
        }
      }
    }
    if (!improved) break
  }
  return p.slice(1)
}

/** One tier: nearest neighbour, then 2-opt. */
export function orderTier (start, stops) {
  return twoOpt(start, nearestNeighbour(start, stops))
}

/** Every tier-0 stop, then tier 1, then tier 2; each tier starts where the previous non-empty tier ended. */
export function orderStops (yard, stops) {
  const tiers = [[], [], []]
  for (const s of stops) tiers[tierOf(s.priority)].push(s)
  const out = []
  let at = yard
  for (const tier of tiers) {
    if (!tier.length) continue
    const ordered = orderTier(at, tier)
    out.push(...ordered)
    at = ordered[ordered.length - 1]
  }
  return out
}

/**
 * Truck assignment at storm start. A client keeps its truck_id when that truck is out tonight. The others are placed one at a
 * time, nearest the yard first (ties: lower client_id), onto the truck whose nearest already-assigned stop (or the yard, when
 * it has none) is closest; ties go to the truck with fewer stops, then the lower truck id.
 * Returns [{ truck_id, stops }] in truck id order, stops unordered.
 */
export function assignTrucks (yard, clients, truckIds) {
  const ids = [...new Set(truckIds)].sort((a, b) => a - b)
  const byTruck = new Map(ids.map(id => [id, []]))
  const orphans = []
  for (const c of [...clients].sort((a, b) => a.client_id - b.client_id)) {
    if (c.truck_id != null && byTruck.has(c.truck_id)) byTruck.get(c.truck_id).push(c)
    else orphans.push(c)
  }
  orphans.sort((a, b) => haversine(yard, a) - haversine(yard, b) || a.client_id - b.client_id)
  for (const c of orphans) {
    let best = null
    for (const id of ids) {
      const stops = byTruck.get(id)
      const d = stops.length ? Math.min(...stops.map(s => haversine(s, c))) : haversine(yard, c)
      if (!best || d < best.d || (d === best.d && stops.length < best.count)) best = { id, d, count: stops.length }
    }
    byTruck.get(best.id).push(c)
  }
  return ids.map(id => ({ truck_id: id, stops: byTruck.get(id) }))
}

/** The whole route for a new storm: assignment, then each truck ordered from the yard. */
export function buildRoute (yard, clients, truckIds) {
  return assignTrucks(yard, clients, truckIds).map(t => ({ truck_id: t.truck_id, stops: orderStops(yard, t.stops) }))
}
