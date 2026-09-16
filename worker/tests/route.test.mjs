// Pure route building (docs/API.md "Route building"). No Worker, no database.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { haversine, tierOf, pathLength, nearestNeighbour, orderStops, orderTier, assignTrucks, buildRoute } from '../src/route.js'

// The SAMPLE yard from migration 0002 (a Statistics Canada NRN point on Mill Road, DECISIONS 69).
const YARD = { lat: 48.92729, lng: -55.66127 }

// Park's Miller-Carta generator: the same 50 instances every run.
function rng(seed) {
  let s = seed
  return () => (s = (s * 16807) % 2147483647) / 2147483647
}
const PRIORITIES = ['medical', 'commuter', 'business', 'none', 'none']

function instance(seed) {
  const r = rng(seed)
  const n = 1 + Math.floor(r() * 30)
  return Array.from({ length: n }, (_, i) => ({
    client_id: i + 1,
    lat: +(48.92 + r() * 0.045).toFixed(5),
    lng: +(-55.68 + r() * 0.05).toFixed(5),
    priority: PRIORITIES[Math.floor(r() * PRIORITIES.length)],
  }))
}
const INSTANCES = Array.from({ length: 50 }, (_, i) => instance(1000 + i * 7919))

/** Tiers of an ordered route, as runs: [{ start, stops }]. */
function tierRuns(yard, ordered) {
  const runs = []
  let at = yard
  for (const s of ordered) {
    const t = tierOf(s.priority)
    if (!runs.length || runs[runs.length - 1].tier !== t) runs.push({ tier: t, start: at, stops: [] })
    runs[runs.length - 1].stops.push(s)
    at = s
  }
  return runs
}

test('haversine matches the formula written out for two SAMPLE street points', () => {
  // Harris Avenue and Hardy Avenue points from data/sample-clients.json (Statistics Canada NRN, DECISIONS 69).
  const a = { lat: 48.94155, lng: -55.6461 }
  const b = { lat: 48.95392, lng: -55.63153 }
  const R = 6371008.8
  const toRad = (d) => (d * Math.PI) / 180
  const phi1 = toRad(a.lat)
  const phi2 = toRad(b.lat)
  const dPhi = toRad(b.lat - a.lat)
  const dLambda = toRad(b.lng - a.lng)
  const h = Math.sin(dPhi / 2) * Math.sin(dPhi / 2) + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) * Math.sin(dLambda / 2)
  const expected = 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
  assert.ok(Math.abs(haversine(a, b) - expected) < 1e-6, `${haversine(a, b)} vs ${expected}`)
  // And a sanity bound: about 1.74 km apart (0.01237 deg of latitude is ~1375 m, 0.01457 deg of longitude here is ~1064 m).
  assert.ok(expected > 1700 && expected < 1780, String(expected))
  assert.equal(haversine(a, a), 0)
})

test('tiers: every medical stop before every commuter/business stop before every other stop (50 seeded instances)', () => {
  for (const [k, stops] of INSTANCES.entries()) {
    const tiers = orderStops(YARD, stops).map((s) => tierOf(s.priority))
    for (let i = 1; i < tiers.length; i++) assert.ok(tiers[i - 1] <= tiers[i], `instance ${k}: tiers ${tiers.join(',')}`)
    assert.equal(tiers.length, stops.length)
  }
})

test('2-opt local optimum: no single reversal of a returned tier path saves more than 0.5 m (50 seeded instances)', () => {
  let checked = 0
  for (const [k, stops] of INSTANCES.entries()) {
    for (const run of tierRuns(YARD, orderStops(YARD, stops))) {
      const base = pathLength(run.start, run.stops)
      for (let i = 0; i < run.stops.length; i++) {
        for (let j = i + 1; j < run.stops.length; j++) {
          const p = [...run.stops.slice(0, i), ...run.stops.slice(i, j + 1).reverse(), ...run.stops.slice(j + 1)]
          const saved = base - pathLength(run.start, p)
          assert.ok(saved <= 0.5, `instance ${k} tier ${run.tier}: reversing ${i}..${j} saves ${saved.toFixed(2)} m`)
          checked++
        }
      }
    }
  }
  assert.ok(checked > 1000, `only ${checked} reversals checked`)
})

// Local metres east (x) and north (y) of the yard, for the crossing check.
const M_LAT = 111195
const M_LNG = 111195 * Math.cos((YARD.lat * Math.PI) / 180)
const xy = (p) => ({ x: (p.lng - YARD.lng) * M_LNG, y: (p.lat - YARD.lat) * M_LAT })
function crossesItself(start, path) {
  const p = [start, ...path].map(xy)
  const side = (a, b, c) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x))
  for (let i = 0; i < p.length - 1; i++) {
    for (let j = i + 2; j < p.length - 1; j++) {
      const [a, b, c, d] = [p[i], p[i + 1], p[j], p[j + 1]]
      if (side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0) return true
    }
  }
  return false
}

// Five made-up stops north-east of the yard (about 0-900 m), placed by their offset from it in degrees. Nearest neighbour
// goes 2, 4, 1, then back down across its own 2 -> 4 leg to 3 and 5. 2-opt uncrosses it.
const near = (id, dLat, dLng) => ({
  client_id: id,
  lat: +(YARD.lat + dLat).toFixed(5),
  lng: +(YARD.lng + dLng).toFixed(5),
  priority: 'none',
})
const CROSSING = [
  near(1, 0.00828, 0),
  near(2, 0.0019, 0.00396),
  near(3, 0.00479, 0.01),
  near(4, 0.00676, 0.0045),
  near(5, 0.00488, 0.01034),
]

test('crossing: nearest neighbour crosses itself, the built route does not, and the order is exactly 2, 3, 5, 4, 1', () => {
  const nn = nearestNeighbour(YARD, CROSSING)
  assert.deepEqual(
    nn.map((s) => s.client_id),
    [2, 4, 1, 3, 5],
  )
  assert.ok(crossesItself(YARD, nn), 'the instance is meant to make nearest neighbour cross')
  const built = orderStops(YARD, CROSSING)
  assert.ok(!crossesItself(YARD, built), `built route crosses: ${built.map((s) => s.client_id)}`)
  assert.deepEqual(
    built.map((s) => s.client_id),
    [2, 3, 5, 4, 1],
  )
})

test('route length is never longer than plain nearest neighbour (per tier, 50 seeded instances)', () => {
  for (const [k, stops] of INSTANCES.entries()) {
    for (const t of [0, 1, 2]) {
      const tier = stops.filter((s) => tierOf(s.priority) === t)
      if (!tier.length) continue
      assert.ok(pathLength(YARD, orderTier(YARD, tier)) <= pathLength(YARD, nearestNeighbour(YARD, tier)) + 1e-9, `instance ${k} tier ${t}`)
    }
  }
})

test('deterministic: same input, same order, whatever order the input came in', () => {
  for (const stops of INSTANCES.slice(0, 10)) {
    const once = orderStops(YARD, stops).map((s) => s.client_id)
    assert.deepEqual(
      orderStops(YARD, stops).map((s) => s.client_id),
      once,
    )
    assert.deepEqual(
      orderStops(YARD, [...stops].reverse()).map((s) => s.client_id),
      once,
    )
  }
})

test('nearest neighbour ties go to the lower client_id', () => {
  const east = { client_id: 9, lat: YARD.lat, lng: YARD.lng + 0.001 }
  const west = { client_id: 4, lat: YARD.lat, lng: YARD.lng - 0.001 }
  assert.deepEqual(
    nearestNeighbour(YARD, [east, west]).map((s) => s.client_id),
    [4, 9],
  )
})

test('empty and one-stop inputs', () => {
  assert.deepEqual(orderStops(YARD, []), [])
  const one = { client_id: 3, lat: 48.94155, lng: -55.6461, priority: 'none' }
  assert.deepEqual(orderStops(YARD, [one]), [one])
  assert.deepEqual(buildRoute(YARD, [], [1, 2]), [
    { truck_id: 1, stops: [] },
    { truck_id: 2, stops: [] },
  ])
})

test('truck assignment: own truck kept, orphan to the truck with the nearest stop, tie to fewer stops then lower id', () => {
  const at = (id, dy, dx, truck) => ({ client_id: id, lat: YARD.lat + dy, lng: YARD.lng + dx, priority: 'none', truck_id: truck })
  // Client 1 belongs to truck 2 even though it sits beside truck 1's stop. Client 3 has no truck and sits by truck 2's
  // client 2. Client 4's usual truck (7) is not out tonight, and it sits by client 1 (truck 2).
  const clients = [at(1, 0.01, 0, 2), at(2, -0.01, 0, 2), at(3, -0.0101, 0, null), at(4, 0.0101, 0.0001, 7), at(5, 0.0099, 0, 1)]
  const byTruck = Object.fromEntries(assignTrucks(YARD, clients, [1, 2]).map((t) => [t.truck_id, t.stops.map((s) => s.client_id).sort()]))
  assert.deepEqual(byTruck, { 1: [5], 2: [1, 2, 3, 4] })

  // Tie on distance: both trucks have no stops, so both measure from the yard. Fewer stops wins, then the lower id.
  const tie = assignTrucks(YARD, [at(1, 0.001, 0, null)], [2, 1])
  assert.deepEqual(
    tie.map((t) => [t.truck_id, t.stops.map((s) => s.client_id)]),
    [
      [1, [1]],
      [2, []],
    ],
  )
  // Equal distance from two stops (one north of the yard on truck 1 with 2 stops, one south on truck 2 with 1 stop).
  const eq = assignTrucks(YARD, [at(1, 0.002, 0, 1), at(2, 0.002, 0, 1), at(3, -0.002, 0, 2), at(4, 0, 0, null)], [1, 2])
  assert.deepEqual(
    eq.map((t) => t.stops.map((s) => s.client_id).sort()),
    [
      [1, 2],
      [3, 4],
    ],
  )
})

test('buildRoute orders each truck from the yard with medical first', () => {
  const clients = INSTANCES[3].map((s, i) => ({ ...s, truck_id: (i % 2) + 1 }))
  for (const t of buildRoute(YARD, clients, [1, 2])) {
    assert.deepEqual(
      t.stops.map((s) => s.client_id),
      orderStops(
        YARD,
        clients.filter((c) => c.truck_id === t.truck_id),
      ).map((s) => s.client_id),
    )
  }
})
