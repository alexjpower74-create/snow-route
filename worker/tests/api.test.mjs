// API tests (M1) against a running Worker started with --var TEST_MODE:1 (tests/run.mjs does that).
// BASE defaults to http://127.0.0.1:7602. Every test resets first. The clock is pinned with X-Test-Now.
// Ending a storm uses the test-only helper POST /api/test/storms/:id/end (the owner route is M2); counting stored
// check-ins uses GET /api/test/checkins?storm_id= (raw rows).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { buildRoute, tierOf } from '../src/route.js'
import { SAMPLE } from '../src/sample-data.js'

const BASE = process.env.BASE || `http://127.0.0.1:${process.env.PORT || 7602}`
const START = '2026-01-12T08:05:00.000Z' // Mon Jan 12, 4:35 AM NST
const at = minutes => new Date(Date.parse(START) + minutes * 60000).toISOString()
const COMPANY = 'SAMPLE Snow Clearing — Grand Falls-Windsor (demo)'
const YARD = { label: 'SAMPLE yard, Mill Road', lat: 48.94346, lng: -55.67465 }

async function api (method, path, { body, token, key, now = START, ip = '10.0.0.1', headers = {}, raw } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'X-Test-Now': now,
      'X-Test-IP': ip,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(key ? { 'X-Driver-Key': key } : {}),
      ...headers
    },
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined
  })
  const buf = Buffer.from(await res.arrayBuffer())
  const text = buf.toString('utf8')
  let json
  try { json = JSON.parse(text) } catch {}
  return { status: res.status, body: json, text, buf, headers: res.headers }
}

function expectError (r, status, code, field) {
  assert.equal(r.status, status, r.text)
  assert.equal(r.body.code, code, r.text)
  assert.equal(typeof r.body.error, 'string')
  if (field !== undefined) assert.equal(r.body.field, field, r.text)
}

async function reset () {
  const r = await api('POST', '/api/test/reset')
  assert.equal(r.status, 200, r.text)
  return r.body
}

async function signin () {
  const r = await api('POST', '/api/owner/signin', { body: { pin: '2468' } })
  assert.equal(r.status, 200, r.text)
  return r.body.token
}

/** Reset, sign in, start a storm with every client and both trucks. */
async function stormSetup () {
  const seed = await reset()
  const token = await signin()
  const r = await api('POST', '/api/owner/storms', { token, body: { client_ids: seed.clients.map(c => c.id), truck_ids: seed.trucks.map(t => t.id) } })
  assert.equal(r.status, 201, r.text)
  const storm = r.body
  const keyOf = truckId => seed.trucks.find(t => t.id === truckId).driver_key
  return { seed, token, storm, keyOf }
}

const checkin = (storm, stop, over = {}) => ({
  id: randomUUID(), storm_id: storm.id, client_id: stop.client_id, kind: 'plowed', reason: null, note: '', at: at(30), has_photo: false, ...over
})
const post = (key, body, now = at(31)) => api('POST', '/api/driver/checkins', { key, body, now })
const stopsOf = storm => storm.trucks.flatMap(t => t.stops)
const ownerStop = async (token, stormId, clientId) =>
  stopsOf((await api('GET', `/api/owner/storms/${stormId}`, { token })).body).find(s => s.client_id === clientId)
const storedRows = async (stormId, clientId) =>
  (await api('GET', `/api/test/checkins?storm_id=${stormId}`)).body.checkins.filter(k => k.client_id === clientId)

// ---------------------------------------------------------------- company and sign-in

test('company shape', async () => {
  await reset()
  const r = await api('GET', '/api/company')
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { name: COMPANY, sample: true, timezone: 'America/St_Johns', hst_rate: 0.15, yard: YARD })
})

test('sign-in: wrong PIN 401 with field pin, right PIN gives a token, no token 401, sign-out ends it', async () => {
  await reset()
  expectError(await api('POST', '/api/owner/signin', { body: { pin: '1111' } }), 401, 'unauthorized', 'pin')
  assert.equal((await api('POST', '/api/owner/signin', { body: { pin: '1111' } })).body.error, 'That PIN is not right.')
  expectError(await api('POST', '/api/owner/signin', { body: {} }), 401, 'unauthorized', 'pin')
  const r = await api('POST', '/api/owner/signin', { body: { pin: '2468' } })
  assert.equal(r.status, 200)
  assert.match(r.body.token, /^[A-Za-z0-9_-]{40,}$/)
  assert.equal(r.body.expires_at, at(30 * 24 * 60))
  expectError(await api('GET', '/api/owner/clients'), 401, 'unauthorized')
  expectError(await api('GET', '/api/owner/clients', { token: 'nope' }), 401, 'unauthorized')
  assert.equal((await api('GET', '/api/owner/clients', { token: r.body.token })).status, 200)
  // Expired after 30 days.
  expectError(await api('GET', '/api/owner/clients', { token: r.body.token, now: at(30 * 24 * 60 + 1) }), 401, 'unauthorized')
  assert.equal((await api('POST', '/api/owner/signout', { token: r.body.token })).status, 204)
  expectError(await api('GET', '/api/owner/clients', { token: r.body.token }), 401, 'unauthorized')
})

// ---------------------------------------------------------------- clients

test('clients: 25 SAMPLE clients, sorted by name, full shape', async () => {
  const seed = await reset()
  const token = await signin()
  const r = await api('GET', '/api/owner/clients', { token })
  assert.equal(r.status, 200)
  const { clients } = r.body
  assert.equal(clients.length, 25)
  for (const c of clients) assert.match(c.name, /SAMPLE/)
  const names = clients.map(c => c.name)
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })))
  const sam = clients.find(c => c.name === 'Sam (SAMPLE)')
  const samSeed = seed.clients.find(c => c.ref === 'sample-03')
  assert.deepEqual(sam, {
    id: samSeed.id,
    name: 'Sam (SAMPLE)',
    address: 'Harris Avenue, Grand Falls-Windsor, NL',
    lat: 48.94434,
    lng: -55.64701,
    type: 'driveway',
    type_label: 'Driveway',
    priority: 'none',
    priority_label: 'None',
    opens_at: null,
    notes: "Gate on left, don't pile by the hydrant.",
    billing: 'seasonal',
    price_cents: 55000,
    truck_id: seed.trucks[1].id,
    active: true,
    status_url: `${BASE}/s/?k=${samSeed.status_key}`,
    last_plowed_at: null,
    last_plowed_label: null
  })
  assert.equal(samSeed.status_url, sam.status_url)
  assert.ok(samSeed.status_key.length >= 22)
  const trucks = (await api('GET', '/api/owner/trucks', { token })).body.trucks
  assert.deepEqual(trucks, seed.trucks.map(t => ({ id: t.id, name: t.name, active: true, driver_url: `${BASE}/d/?k=${t.driver_key}` })))
})

const GOOD_CLIENT = {
  name: '  Kim (SAMPLE)  ', address: 'Lincoln Road, Grand Falls-Windsor, NL', lat: 48.9401, lng: -55.6602,
  type: 'lot', priority: 'business', opens_at: '07:30', notes: 'Back door.', billing: 'per_push', price_cents: 6000, truck_id: null
}

const VALIDATION = [
  ['name', { name: '   ' }, 'Give the client a name.'],
  ['name', { name: 'x'.repeat(81) }, 'Keep the name under 80 characters.'],
  ['address', { address: '' }, 'Type the address the driver should look for.'],
  ['address', { address: 'x'.repeat(161) }, 'Type the address the driver should look for.'],
  ['lat', { lat: 45.0 }, 'Put a pin on the map for this client.'],
  ['lat', { lng: -70.1 }, 'Put a pin on the map for this client.'],
  ['lat', { lat: '48.9' }, 'Put a pin on the map for this client.'],
  ['type', { type: 'roof' }, 'Pick a type.'],
  ['priority', { priority: 'urgent' }, 'Pick a priority.'],
  ['billing', { billing: 'hourly' }, 'Pick how this client is billed.'],
  ['opens_at', { opens_at: '7:30' }, 'Opening time looks like 7:30 — use the time picker.'],
  ['opens_at', { opens_at: '24:00' }, 'Opening time looks like 7:30 — use the time picker.'],
  ['notes', { notes: 'x'.repeat(301) }, 'Keep the notes under 300 characters.'],
  ['price_cents', { price_cents: 12.5 }, 'Type a price in dollars and cents.'],
  ['price_cents', { price_cents: 10000001 }, 'Type a price in dollars and cents.'],
  ['truck_id', { truck_id: 999 }, 'Pick one of your trucks.']
]

for (const [field, over, message] of VALIDATION) {
  test(`clients POST validation: ${field} ${JSON.stringify(over).slice(0, 40)}`, async () => {
    await reset()
    const token = await signin()
    const r = await api('POST', '/api/owner/clients', { token, body: { ...GOOD_CLIENT, ...over } })
    expectError(r, 400, 'bad_request', field)
    assert.equal(r.body.error, message)
  })
}

test('clients: a good POST and PUT', async () => {
  const seed = await reset()
  const token = await signin()
  const { notes, opens_at: _o, ...minimal } = GOOD_CLIENT
  const created = await api('POST', '/api/owner/clients', { token, body: { ...minimal, notes } })
  assert.equal(created.status, 201, created.text)
  assert.equal(created.body.name, 'Kim (SAMPLE)')
  assert.equal(created.body.opens_at, null)
  assert.equal(created.body.active, true)
  assert.equal(created.body.type_label, 'Parking lot')
  assert.match(created.body.status_url, /^http:\/\/127\.0\.0\.1:\d+\/s\/\?k=[A-Za-z0-9_-]{22,}$/)
  const list = (await api('GET', '/api/owner/clients', { token })).body.clients
  assert.equal(list.length, 26)

  const put = { ...GOOD_CLIENT, name: 'Kim B (SAMPLE)', truck_id: seed.trucks[0].id, active: false, price_cents: 6500 }
  const updated = await api('PUT', `/api/owner/clients/${created.body.id}`, { token, body: put })
  assert.equal(updated.status, 200, updated.text)
  assert.equal(updated.body.name, 'Kim B (SAMPLE)')
  assert.equal(updated.body.truck_id, seed.trucks[0].id)
  assert.equal(updated.body.opens_at, '07:30')
  assert.equal(updated.body.active, false)
  assert.equal(updated.body.status_url, created.body.status_url)
  assert.equal((await api('GET', '/api/owner/clients', { token })).body.clients.length, 25)
  const all = (await api('GET', '/api/owner/clients?include_inactive=1', { token })).body.clients
  assert.equal(all.length, 26)
  assert.equal(all.at(-1).name, 'Kim B (SAMPLE)')

  // PUT needs every field.
  const { active: _a, ...noActive } = put
  expectError(await api('PUT', `/api/owner/clients/${created.body.id}`, { token, body: noActive }), 400, 'bad_request', 'active')
  const { notes: _n, ...noNotes } = put
  expectError(await api('PUT', `/api/owner/clients/${created.body.id}`, { token, body: noNotes }), 400, 'bad_request', 'notes')
  expectError(await api('PUT', '/api/owner/clients/9999', { token, body: put }), 404, 'not_found')
})

// ---------------------------------------------------------------- storms

test('storm start: 201, every client once, medical first per truck, the route rules, second start 409', async () => {
  const { seed, token, storm } = await stormSetup()
  assert.equal(storm.status, 'active')
  assert.equal(storm.name, 'Storm of Mon Jan 12')
  assert.equal(storm.started_at, START)
  assert.equal(storm.started_label, 'Mon Jan 12, 4:35 AM')
  assert.equal(storm.ended_at, null)
  assert.equal(storm.order_note, 'Order is by distance, not road time.')
  assert.equal(storm.route_version, 1)
  assert.deepEqual(storm.counts, { stops: 25, plowed: 0, skipped: 0, pending: 25 })
  assert.deepEqual(storm.trucks.map(t => [t.id, t.name]), seed.trucks.map(t => [t.id, t.name]))
  assert.deepEqual(stopsOf(storm).map(s => s.client_id).sort((a, b) => a - b), seed.clients.map(c => c.id).sort((a, b) => a - b))

  // The order is exactly what route.js builds from the same data (every SAMPLE client has a truck, so each keeps it).
  const byRef = Object.fromEntries(seed.clients.map(c => [c.ref, c.id]))
  const input = SAMPLE.clients.map(c => ({ client_id: byRef[c.ref], lat: c.lat, lng: c.lng, priority: c.priority, truck_id: seed.trucks[c.truck - 1].id }))
  const expected = buildRoute(YARD, input, seed.trucks.map(t => t.id))
  for (const t of storm.trucks) {
    const priorities = t.stops.map(s => tierOf(s.priority))
    assert.equal(t.stops[0].priority, 'medical', `${t.name} starts with a medical stop`)
    for (let i = 1; i < priorities.length; i++) assert.ok(priorities[i - 1] <= priorities[i], `${t.name}: ${priorities}`)
    assert.deepEqual(t.stops.map(s => s.position), t.stops.map((_, i) => i + 1))
    assert.deepEqual(t.stops.map(s => s.client_id), expected.find(e => e.truck_id === t.id).stops.map(s => s.client_id))
    for (const s of t.stops) {
      assert.equal(s.status, 'pending')
      assert.equal(s.checkin, null)
      assert.deepEqual(s.messages.map(m => m.kind), ['status_link', 'on_route'])
    }
  }
  const sam = stopsOf(storm).find(s => s.name === 'Sam (SAMPLE)')
  const samKey = seed.clients.find(c => c.ref === 'sample-03').status_url
  assert.equal(sam.messages[1].text, `Hi Sam (SAMPLE), we're out clearing snow tonight. You're stop ${sam.position} on the route. This link shows the time and a photo once it's done: ${samKey}`)
  assert.equal(sam.messages[0].text, `Hi Sam (SAMPLE), this is ${COMPANY}. You can check when your driveway was last cleared here: ${samKey}`)

  const again = await api('POST', '/api/owner/storms', { token, body: { client_ids: [seed.clients[0].id], truck_ids: [seed.trucks[0].id] } })
  expectError(again, 409, 'bad_state')
  assert.equal(again.body.error, 'A storm is already on. End it before starting another.')

  const current = await api('GET', '/api/owner/storms/current', { token })
  assert.deepEqual(current.body.storm, storm)
  assert.deepEqual((await api('GET', `/api/owner/storms/${storm.id}`, { token })).body, storm)
  expectError(await api('GET', '/api/owner/storms/999', { token }), 404, 'not_found')
})

test('storm start: refusals', async () => {
  const seed = await reset()
  const token = await signin()
  const t = seed.trucks.map(x => x.id)
  const c = seed.clients.map(x => x.id)
  assert.deepEqual((await api('GET', '/api/owner/storms/current', { token })).body, { storm: null })
  expectError(await api('POST', '/api/owner/storms', { token, body: { client_ids: [], truck_ids: t } }), 400, 'bad_request', 'client_ids')
  expectError(await api('POST', '/api/owner/storms', { token, body: { client_ids: [c[0], 9999], truck_ids: t } }), 400, 'bad_request', 'client_ids')
  expectError(await api('POST', '/api/owner/storms', { token, body: { client_ids: c, truck_ids: [] } }), 400, 'bad_request', 'truck_ids')
  expectError(await api('POST', '/api/owner/storms', { token, body: { client_ids: c, truck_ids: [77] } }), 400, 'bad_request', 'truck_ids')
  // One truck out: the other truck's clients are placed on it.
  const one = await api('POST', '/api/owner/storms', { token, body: { client_ids: c, truck_ids: [t[1]] } })
  assert.equal(one.status, 201, one.text)
  assert.equal(one.body.trucks.length, 1)
  assert.equal(one.body.trucks[0].stops.length, 25)
})

// ---------------------------------------------------------------- driver

test('driver route: bad key 401, good key shows only its truck in order, no messages or prices', async () => {
  const { seed, storm, keyOf } = await stormSetup()
  const bad = await api('GET', '/api/driver/route', { key: 'not-a-key' })
  expectError(bad, 401, 'unauthorized')
  assert.equal(bad.body.error, "This driver link doesn't work any more. Ask the owner for a new one.")
  expectError(await api('GET', '/api/driver/route'), 401, 'unauthorized')

  for (const truck of storm.trucks) {
    const r = await api('GET', '/api/driver/route', { key: keyOf(truck.id), now: at(10) })
    assert.equal(r.status, 200)
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(r.headers.get('cache-control'), 'no-store')
    assert.deepEqual(r.body.company, { name: COMPANY, sample: true, timezone: 'America/St_Johns' })
    assert.deepEqual(r.body.truck, { id: truck.id, name: truck.name })
    assert.deepEqual(r.body.storm, { id: storm.id, name: storm.name, status: 'active', started_at: START })
    assert.equal(r.body.server_now, at(10))
    assert.deepEqual(r.body.stops, truck.stops.map(({ messages, removable, ...s }) => s))
    assert.ok(r.body.stops.every(s => s.truck_id === truck.id))
    for (const word of ['messages', 'removable', 'price', 'billing', 'status_url', 'k=']) assert.ok(!r.text.includes(word), `driver route contains ${word}`)
  }
  void seed
})

test('driver route: no storm on answers storm null and no stops', async () => {
  const seed = await reset()
  const r = await api('GET', '/api/driver/route', { key: seed.trucks[0].driver_key })
  assert.equal(r.status, 200)
  assert.equal(r.body.storm, null)
  assert.deepEqual(r.body.stops, [])
})

// ---------------------------------------------------------------- check-ins

test('check-ins: plowed 201 and the stop is plowed', async () => {
  const { token, storm, keyOf } = await stormSetup()
  const truck = storm.trucks[0]
  const stop = truck.stops[0]
  const body = checkin(storm, stop, { note: 'Done.' })
  const r = await post(keyOf(truck.id), body, at(33))
  assert.equal(r.status, 201, r.text)
  assert.deepEqual(r.body.checkin, {
    id: body.id, storm_id: storm.id, client_id: stop.client_id, truck_id: truck.id, kind: 'plowed', reason: null, reason_text: null,
    note: '', at: at(30), at_label: '5:05 AM', at_adjusted: false, received_at: at(33), photo: 'none', photo_url: null, voided: false
  })
  assert.equal(r.body.duplicate, undefined)
  assert.equal(r.body.stop.status, 'plowed')
  assert.equal(r.body.stop.messages, undefined)
  const owner = await ownerStop(token, storm.id, stop.client_id)
  assert.equal(owner.status, 'plowed')
  assert.equal(owner.checkin.id, body.id)
  assert.deepEqual(owner.messages.map(m => m.kind), ['status_link', 'plowed'])
  assert.match(owner.messages[1].text, /^Hi .+, your (driveway|parking lot|walkway) was cleared at 5:05 AM\. See it here: http/)
  const counts = (await api('GET', `/api/owner/storms/${storm.id}`, { token })).body.counts
  assert.deepEqual(counts, { stops: 25, plowed: 1, skipped: 0, pending: 24 })
})

test('check-ins: the same id again answers 200 duplicate and still exactly one check-in', async () => {
  const { token, storm, keyOf } = await stormSetup()
  const truck = storm.trucks[0]
  for (const [stop, over] of [[truck.stops[0], {}], [truck.stops[1], { kind: 'skipped', reason: 'car' }]]) {
    const body = checkin(storm, stop, over)
    const first = await post(keyOf(truck.id), body)
    assert.equal(first.status, 201, first.text)
    const again = await post(keyOf(truck.id), body, at(50))
    assert.equal(again.status, 200, `${over.kind || 'plowed'} resend: ${again.text}`)
    assert.equal(again.body.duplicate, true)
    assert.deepEqual(again.body.checkin, first.body.checkin)
    // Whatever the resent body says.
    const odd = await post(keyOf(truck.id), { ...body, kind: 'nonsense', client_id: 99999 }, at(51))
    assert.equal(odd.status, 200, odd.text)
    assert.equal(odd.body.duplicate, true)
    const rows = await storedRows(storm.id, stop.client_id)
    assert.equal(rows.length, 1, `${over.kind || 'plowed'}: ${rows.length} stored check-ins`)
    const owner = await ownerStop(token, storm.id, stop.client_id)
    assert.equal(owner.checkin.id, body.id)
    assert.equal(owner.checkin.received_at, at(31))
  }
})

test('check-ins: a different id plowed for a plowed stop is 409 already_plowed', async () => {
  const { storm, keyOf } = await stormSetup()
  const truck = storm.trucks[0]
  const stop = truck.stops[0]
  const first = await post(keyOf(truck.id), checkin(storm, stop))
  assert.equal(first.status, 201)
  // From the other truck too.
  for (const key of [keyOf(truck.id), keyOf(storm.trucks[1].id)]) {
    const r = await post(key, checkin(storm, stop))
    expectError(r, 409, 'already_plowed')
    assert.equal(r.body.error, 'This stop is already marked plowed.')
    assert.equal(r.body.checkin.id, first.body.checkin.id)
  }
  assert.equal((await storedRows(storm.id, stop.client_id)).length, 1)
})

test('check-ins: skip without a reason is 400, and the other refusals', async () => {
  const { storm, keyOf } = await stormSetup()
  const truck = storm.trucks[0]
  const key = keyOf(truck.id)
  const stop = truck.stops[0]
  expectError(await post(key, checkin(storm, stop, { kind: 'skipped', reason: null })), 400, 'bad_request', 'reason')
  expectError(await post(key, checkin(storm, stop, { kind: 'skipped', reason: 'weather' })), 400, 'bad_request', 'reason')
  expectError(await post(key, checkin(storm, stop, { id: 'abc' })), 400, 'bad_request', 'id')
  expectError(await post(key, checkin(storm, stop, { kind: 'maybe' })), 400, 'bad_request', 'kind')
  expectError(await post(key, checkin(storm, stop, { at: 'yesterday' })), 400, 'bad_request', 'at')
  expectError(await post(key, checkin(storm, stop, { kind: 'skipped', reason: 'car', note: 'x'.repeat(121) })), 400, 'bad_request', 'note')
  expectError(await post(key, checkin(storm, stop, { has_photo: 'yes' })), 400, 'bad_request', 'has_photo')
  expectError(await post(key, checkin(storm, stop, { storm_id: 999 })), 404, 'not_found')
  expectError(await post(key, checkin(storm, { client_id: 99999 })), 404, 'not_found')
  expectError(await post('bad-key', checkin(storm, stop)), 401, 'unauthorized')
  assert.equal((await storedRows(storm.id, stop.client_id)).length, 0)
})

test('check-ins: skip then plowed ends plowed; plowed then skip is 409', async () => {
  const { token, storm, keyOf } = await stormSetup()
  const truck = storm.trucks[0]
  const key = keyOf(truck.id)
  const [a, b] = truck.stops

  const skip = await post(key, checkin(storm, a, { kind: 'skipped', reason: 'other', note: 'Truck blocking', at: at(20) }))
  assert.equal(skip.status, 201, skip.text)
  assert.equal(skip.body.stop.status, 'skipped')
  assert.equal(skip.body.checkin.reason_text, 'Other: Truck blocking')
  const skipOwner = await ownerStop(token, storm.id, a.client_id)
  assert.equal(skipOwner.messages[1].text, `Hi ${a.name}, we couldn't clear your ${a.type_label.toLowerCase()} tonight: other: Truck blocking. We'll be in touch about it.`)
  const plowed = await post(key, checkin(storm, a, { at: at(40) }), at(41))
  assert.equal(plowed.status, 201, plowed.text)
  assert.equal(plowed.body.stop.status, 'plowed')
  assert.equal(plowed.body.stop.checkin.kind, 'plowed')

  assert.equal((await post(key, checkin(storm, b))).status, 201)
  const late = await post(key, checkin(storm, b, { kind: 'skipped', reason: 'gate' }), at(45))
  expectError(late, 409, 'already_plowed')
  assert.equal(late.body.checkin.kind, 'plowed')
  assert.equal((await ownerStop(token, storm.id, b.client_id)).status, 'plowed')
  assert.equal((await storedRows(storm.id, b.client_id)).length, 1)
})

test('check-ins: original time kept (T synced 45 min later), outside the window adjusted', async () => {
  const { token, storm, keyOf } = await stormSetup()
  const truck = storm.trucks[0]
  const key = keyOf(truck.id)
  const [a, b, c] = truck.stops

  const kept = await post(key, checkin(storm, a, { at: at(60) }), at(105))
  assert.equal(kept.status, 201, kept.text)
  assert.equal(kept.body.checkin.at, at(60))
  assert.equal(kept.body.checkin.at_adjusted, false)
  assert.equal(kept.body.checkin.received_at, at(105))
  assert.equal((await ownerStop(token, storm.id, a.client_id)).checkin.at, at(60))

  const future = await post(key, checkin(storm, b, { at: at(105 + 120) }), at(105))
  assert.equal(future.status, 201, future.text)
  assert.equal(future.body.checkin.at, at(105))
  assert.equal(future.body.checkin.at_adjusted, true)

  // Edges: 10 min before the storm started is kept, 11 min before is not.
  const edge = await post(key, checkin(storm, c, { kind: 'skipped', reason: 'car', at: at(-10) }), at(105))
  assert.equal(edge.body.checkin.at, at(-10))
  assert.equal(edge.body.checkin.at_adjusted, false)
  const before = await post(key, checkin(storm, truck.stops[3], { at: at(-11) }), at(105))
  assert.equal(before.body.checkin.at, at(105))
  assert.equal(before.body.checkin.at_adjusted, true)
})

test('check-ins: accepted after the storm ended (ended through the test-only helper route)', async () => {
  const { token, storm, keyOf } = await stormSetup()
  const ended = await api('POST', `/api/test/storms/${storm.id}/end`, { body: { at: at(90) } })
  assert.equal(ended.status, 200, ended.text)
  assert.equal((await api('GET', `/api/owner/storms/${storm.id}`, { token })).body.status, 'ended')
  assert.deepEqual((await api('GET', '/api/owner/storms/current', { token })).body, { storm: null })
  const truck = storm.trucks[1]
  const r = await post(keyOf(truck.id), checkin(storm, truck.stops[2], { at: at(80) }), at(140))
  assert.equal(r.status, 201, r.text)
  assert.equal(r.body.checkin.at, at(80))
  assert.equal(r.body.stop.status, 'plowed')
})

// ---------------------------------------------------------------- photos

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('SAMPLE placeholder photo bytes'), Buffer.from([0xff, 0xd9])])

test('photos: jpeg stored and served back byte for byte; 415, 413 and another truck 404', async () => {
  const { storm, keyOf } = await stormSetup()
  const truck = storm.trucks[0]
  const key = keyOf(truck.id)
  const body = checkin(storm, truck.stops[0], { has_photo: true })
  const created = await post(key, body)
  assert.equal(created.body.checkin.photo, 'waiting')
  assert.equal(created.body.checkin.photo_url, null)

  const put = (bytes, type, k = key, id = body.id) => api('PUT', `/api/driver/checkins/${id}/photo`, { key: k, raw: bytes, headers: { 'content-type': type } })
  const stored = await put(JPEG, 'image/jpeg')
  assert.equal(stored.status, 200, stored.text)
  assert.equal(stored.body.checkin.photo, 'stored')
  assert.match(stored.body.checkin.photo_url, /^http:\/\/127\.0\.0\.1:\d+\/api\/photos\/[A-Za-z0-9_-]{22}$/)

  const got = await fetch(stored.body.checkin.photo_url)
  assert.equal(got.status, 200)
  assert.equal(got.headers.get('content-type'), 'image/jpeg')
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(got.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(got.headers.get('cache-control'), 'private, max-age=86400')
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), JPEG)

  expectError(await put(Buffer.from('hello'), 'text/plain'), 415, 'unsupported_photo')
  expectError(await put(Buffer.from('<svg/>'), 'image/svg+xml'), 415, 'unsupported_photo')
  expectError(await put(Buffer.alloc(5000001, 1), 'image/jpeg'), 413, 'too_large')
  assert.equal((await put(Buffer.alloc(5000000, 1), 'image/png', key)).status, 200)
  expectError(await put(JPEG, 'image/jpeg', keyOf(storm.trucks[1].id)), 404, 'not_found')
  expectError(await put(JPEG, 'image/jpeg', key, randomUUID()), 404, 'not_found')
  expectError(await api('GET', '/api/photos/AAAAAAAAAAAAAAAAAAAAAA'), 404, 'not_found')
})

// ---------------------------------------------------------------- client status

test('status link: waiting with the right stop number, then plowed with time and photo; 404; never notes or price', async () => {
  const { seed, storm, keyOf } = await stormSetup()
  const truck = storm.trucks[1]
  const stop = truck.stops[3]
  const client = seed.clients.find(c => c.id === stop.client_id)
  const key = keyOf(truck.id)
  const notes = SAMPLE.clients.find(c => c.ref === client.ref).notes

  // Two stops done ahead of it (one skipped).
  await post(key, checkin(storm, truck.stops[0]))
  await post(key, checkin(storm, truck.stops[1], { kind: 'skipped', reason: 'gate' }))

  const waiting = await api('GET', `/api/status/${client.status_key}`, { now: at(35) })
  assert.equal(waiting.status, 200, waiting.text)
  assert.equal(waiting.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(waiting.headers.get('cache-control'), 'no-store')
  assert.deepEqual(waiting.body, {
    company: { name: COMPANY, sample: true },
    client: { name: stop.name, address: stop.address, type: stop.type, type_label: stop.type_label },
    last: null,
    tonight: { storm_name: 'Storm of Mon Jan 12', state: 'waiting', stop_number: 4, stops_on_route: truck.stops.length, stops_done: 2, reason_text: null },
    server_now: at(35)
  })

  const body = checkin(storm, stop, { has_photo: true, at: at(62) })
  await post(key, body, at(63))
  const photo = await api('PUT', `/api/driver/checkins/${body.id}/photo`, { key, raw: JPEG, headers: { 'content-type': 'image/jpeg' } })
  const plowed = await api('GET', `/api/status/${client.status_key}`, { now: at(70) })
  assert.equal(plowed.body.tonight.state, 'plowed')
  assert.equal(plowed.body.tonight.stops_done, 3)
  assert.deepEqual(plowed.body.last, {
    at: at(62), at_label: 'Mon Jan 12, 5:37 AM', time_label: '5:37 AM', photo_url: photo.body.checkin.photo_url, photo_waiting: false
  })

  for (const r of [waiting, plowed]) {
    if (notes) assert.ok(!r.text.includes(notes), 'status JSON contains the notes')
    for (const word of ['notes', 'price', 'billing', 'truck', 'driver', 'messages']) assert.ok(!r.text.includes(word), `status JSON contains ${word}`)
  }

  const skipped = seed.clients.find(c => c.id === truck.stops[1].client_id)
  const s = await api('GET', `/api/status/${skipped.status_key}`)
  assert.equal(s.body.tonight.state, 'skipped')
  assert.equal(s.body.tonight.reason_text, 'Gate locked')

  const unknown = await api('GET', '/api/status/nope-not-a-key')
  expectError(unknown, 404, 'not_found')
  assert.equal(unknown.body.error, "This status link doesn't work. Ask your snow clearing company for a new one.")

  // After the storm ends: no tonight, last stays.
  await api('POST', `/api/test/storms/${storm.id}/end`, { body: {} })
  const after = await api('GET', `/api/status/${client.status_key}`)
  assert.equal(after.body.tonight, null)
  assert.equal(after.body.last.at, at(62))
})

test('unknown API route answers 404 JSON', async () => {
  const r = await api('GET', '/api/nothing-here')
  expectError(r, 404, 'not_found')
})

// ================================================================ M2

const JAN = '2026-01'
const plus = (iso, minutes) => new Date(Date.parse(iso) + minutes * 60000).toISOString()
const seedClient = (seed, ref) => seed.clients.find(c => c.ref === ref)

async function ownerClient (token, id) {
  return (await api('GET', '/api/owner/clients?include_inactive=1', { token })).body.clients.find(c => c.id === id)
}
async function editClient (token, id, over) {
  const r = await api('PUT', `/api/owner/clients/${id}`, { token, body: { ...(await ownerClient(token, id)), ...over } })
  assert.equal(r.status, 200, r.text)
  return r.body
}
/** Start a storm at `start` with these clients and both trucks. */
async function startAt (token, seed, start, clientIds) {
  const r = await api('POST', '/api/owner/storms', { token, now: start, body: { client_ids: clientIds, truck_ids: seed.trucks.map(t => t.id) } })
  assert.equal(r.status, 201, r.text)
  return r.body
}
/** A check-in for a client on whatever truck its stop is on, sent one minute after `at`. */
async function checkinAt (seed, storm, clientId, atIso, over = {}) {
  const stop = stopsOf(storm).find(s => s.client_id === clientId)
  const key = seed.trucks.find(t => t.id === stop.truck_id).driver_key
  const body = checkin(storm, stop, { at: atIso, ...over })
  const r = await post(key, body, plus(atIso, 1))
  assert.equal(r.status, 201, r.text)
  return { ...r.body, key }
}
async function endAt (token, stormId, now) {
  const r = await api('POST', `/api/owner/storms/${stormId}/end`, { token, now })
  assert.equal(r.status, 200, r.text)
  return r.body
}
const billing = async (token, month, now) => (await api('GET', `/api/owner/billing${month ? `?month=${month}` : ''}`, { token, now })).body
const rowOf = (report, clientId) => report.rows.find(r => r.client_id === clientId)

// ---------------------------------------------------------------- PIN and company

test('PIN change: wrong current 401, bad next 400, a change ends every other session and the new PIN works', async () => {
  await reset()
  const a = await signin()
  const b = await signin()
  expectError(await api('PUT', '/api/owner/pin', { token: a, body: { current: '0000', next: '1357' } }), 401, 'unauthorized', 'current')
  for (const next of ['12', '123456789', 'abcd', 1357]) {
    expectError(await api('PUT', '/api/owner/pin', { token: a, body: { current: '2468', next } }), 400, 'bad_request', 'next')
  }
  const r = await api('PUT', '/api/owner/pin', { token: a, body: { current: '2468', next: '1357' } })
  assert.equal(r.status, 204, r.text)
  assert.equal((await api('GET', '/api/owner/trucks', { token: a })).status, 200)
  expectError(await api('GET', '/api/owner/trucks', { token: b }), 401, 'unauthorized')
  expectError(await api('POST', '/api/owner/signin', { body: { pin: '2468' } }), 401, 'unauthorized', 'pin')
  assert.equal((await api('POST', '/api/owner/signin', { body: { pin: '1357' } })).status, 200)
  expectError(await api('PUT', '/api/owner/pin', { body: { current: '1357', next: '2468' } }), 401, 'unauthorized')
})

test('company: owner GET and PUT, validation, sample follows the name', async () => {
  await reset()
  const token = await signin()
  assert.deepEqual((await api('GET', '/api/owner/company', { token })).body, (await api('GET', '/api/company')).body)
  const yard = { label: 'Demo yard, Lincoln Road', lat: 48.95, lng: -55.66 }
  expectError(await api('PUT', '/api/owner/company', { token, body: { name: ' ', yard } }), 400, 'bad_request', 'name')
  expectError(await api('PUT', '/api/owner/company', { token, body: { name: 'Demo Snow Clearing', yard: { ...yard, label: '' } } }), 400, 'bad_request', 'yard.label')
  expectError(await api('PUT', '/api/owner/company', { token, body: { name: 'Demo Snow Clearing', yard: { ...yard, lat: 30 } } }), 400, 'bad_request', 'yard.pin')
  expectError(await api('PUT', '/api/owner/company', { token, body: { name: 'Demo Snow Clearing', yard: { label: 'Demo yard' } } }), 400, 'bad_request', 'yard.pin')
  expectError(await api('PUT', '/api/owner/company', { token, body: { name: 'Demo Snow Clearing' } }), 400, 'bad_request', 'yard.label')
  const r = await api('PUT', '/api/owner/company', { token, body: { name: ' Demo Snow Clearing ', yard } })
  assert.equal(r.status, 200, r.text)
  assert.deepEqual(r.body, { name: 'Demo Snow Clearing', sample: false, timezone: 'America/St_Johns', hst_rate: 0.15, yard })
  assert.deepEqual((await api('GET', '/api/company')).body, r.body)
  expectError(await api('PUT', '/api/owner/company', { body: { name: 'x', yard } }), 401, 'unauthorized')
})

// ---------------------------------------------------------------- messages and links

test('messages: exact text for each kind, on stops and on the client', async () => {
  const { seed, token, storm, keyOf } = await stormSetup()
  const sam = seedClient(seed, 'sample-03') // driveway, truck 2
  const diner = seedClient(seed, 'sample-11') // parking lot, truck 2
  const intro = c => `Hi ${c.name}, this is ${COMPANY}. You can check when your`
  let r = await api('GET', `/api/owner/clients/${sam.id}/messages`, { token })
  assert.deepEqual(r.body, { messages: [{ kind: 'status_link', label: 'Copy status link text', text: `${intro(sam)} driveway was last cleared here: ${sam.status_url}` }] })

  const samStop = stopsOf(storm).find(s => s.client_id === sam.id)
  assert.deepEqual(samStop.messages[1], {
    kind: 'on_route', label: 'Copy "on the route" text',
    text: `Hi Sam (SAMPLE), we're out clearing snow tonight. You're stop ${samStop.position} on the route. This link shows the time and a photo once it's done: ${sam.status_url}`
  })
  await post(keyOf(samStop.truck_id), checkin(storm, samStop, { at: '2026-01-12T10:12:00.000Z' }), '2026-01-12T10:13:00.000Z')
  const plowedText = `Hi Sam (SAMPLE), your driveway was cleared at 6:42 AM. See it here: ${sam.status_url}`
  r = await api('GET', `/api/owner/clients/${sam.id}/messages`, { token })
  assert.deepEqual(r.body.messages.map(m => m.kind), ['status_link', 'plowed'])
  assert.deepEqual(r.body.messages[1], { kind: 'plowed', label: 'Copy "done" text', text: plowedText })
  assert.deepEqual((await ownerStop(token, storm.id, sam.id)).messages[1].text, plowedText)

  const dinerStop = stopsOf(storm).find(s => s.client_id === diner.id)
  await post(keyOf(dinerStop.truck_id), checkin(storm, dinerStop, { kind: 'skipped', reason: 'cancelled' }))
  const dinerMessages = (await ownerStop(token, storm.id, diner.id)).messages
  assert.equal(dinerMessages[0].text, `${intro(diner)} parking lot was last cleared here: ${diner.status_url}`)
  assert.deepEqual(dinerMessages[1], {
    kind: 'skipped', label: 'Copy "skipped" text',
    text: "Hi SAMPLE Diner lot, we couldn't clear your parking lot tonight: client cancelled. We'll be in touch about it."
  })
  assert.deepEqual((await api('GET', `/api/owner/clients/${diner.id}/messages`, { token })).body.messages.map(m => m.kind), ['status_link'])
  expectError(await api('GET', '/api/owner/clients/9999/messages', { token }), 404, 'not_found')
})

test('client reset-link: new status_url, the old key answers 404, the new one works', async () => {
  const seed = await reset()
  const token = await signin()
  const sam = seedClient(seed, 'sample-03')
  const r = await api('POST', `/api/owner/clients/${sam.id}/reset-link`, { token })
  assert.equal(r.status, 200, r.text)
  assert.notEqual(r.body.status_url, sam.status_url)
  expectError(await api('GET', `/api/status/${sam.status_key}`), 404, 'not_found')
  const newKey = new URL(r.body.status_url).searchParams.get('k')
  assert.equal((await api('GET', `/api/status/${newKey}`)).status, 200)
  expectError(await api('POST', '/api/owner/clients/9999/reset-link', { token }), 404, 'not_found')
  // Deactivating does not kill the link (clarification 4).
  await editClient(token, sam.id, { active: false })
  assert.equal((await api('GET', `/api/status/${newKey}`)).status, 200)
})

test('trucks: POST, PUT, validation, order, reset-link makes the old driver key 401', async () => {
  const seed = await reset()
  const token = await signin()
  expectError(await api('POST', '/api/owner/trucks', { token, body: { name: ' ' } }), 400, 'bad_request', 'name')
  expectError(await api('POST', '/api/owner/trucks', { token, body: { name: 'x'.repeat(41) } }), 400, 'bad_request', 'name')
  const created = await api('POST', '/api/owner/trucks', { token, body: { name: 'Truck 3 (SAMPLE)' } })
  assert.equal(created.status, 201, created.text)
  assert.equal(created.body.name, 'Truck 3 (SAMPLE)')
  assert.equal(created.body.active, true)
  assert.match(created.body.driver_url, /\/d\/\?k=[A-Za-z0-9_-]{22,}$/)

  const [t1, t2] = seed.trucks
  expectError(await api('PUT', `/api/owner/trucks/${t1.id}`, { token, body: { name: 'Plow A (SAMPLE)' } }), 400, 'bad_request', 'active')
  expectError(await api('PUT', '/api/owner/trucks/999', { token, body: { name: 'x', active: true } }), 404, 'not_found')
  const put = await api('PUT', `/api/owner/trucks/${t1.id}`, { token, body: { name: 'Plow A (SAMPLE)', active: false } })
  assert.equal(put.status, 200, put.text)
  assert.deepEqual(put.body, { id: t1.id, name: 'Plow A (SAMPLE)', active: false, driver_url: t1.driver_url })
  const list = (await api('GET', '/api/owner/trucks', { token })).body.trucks
  assert.deepEqual(list.map(t => t.name), ['Truck 2 (SAMPLE)', 'Truck 3 (SAMPLE)', 'Plow A (SAMPLE)'])
  // An inactive truck can't go out, but its link still works (clarification 4).
  expectError(await api('POST', '/api/owner/storms', { token, body: { client_ids: [seed.clients[0].id], truck_ids: [t1.id] } }), 400, 'bad_request', 'truck_ids')
  assert.equal((await api('GET', '/api/driver/route', { key: t1.driver_key })).status, 200)

  const reset2 = await api('POST', `/api/owner/trucks/${t2.id}/reset-link`, { token })
  assert.equal(reset2.status, 200)
  assert.notEqual(reset2.body.driver_url, t2.driver_url)
  expectError(await api('GET', '/api/driver/route', { key: t2.driver_key }), 401, 'unauthorized')
  assert.equal((await api('GET', '/api/driver/route', { key: new URL(reset2.body.driver_url).searchParams.get('k') })).status, 200)
  expectError(await api('POST', '/api/owner/trucks/999/reset-link', { token }), 404, 'not_found')
})

// ---------------------------------------------------------------- storm editing

test('storms list: newest first, counts match the storm view', async () => {
  const seed = await reset()
  const token = await signin()
  const ids = seed.clients.map(c => c.id)
  const a = await startAt(token, seed, START, ids)
  await checkinAt(seed, a, ids[0], at(20))
  await checkinAt(seed, a, ids[1], at(25), { kind: 'skipped', reason: 'car' })
  await endAt(token, a.id, at(200))
  const b = await startAt(token, seed, at(24 * 60), ids.slice(0, 5))
  const r = await api('GET', '/api/owner/storms', { token })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.storms.map(s => [s.id, s.status]), [[b.id, 'active'], [a.id, 'ended']])
  for (const s of r.body.storms) {
    const view = (await api('GET', `/api/owner/storms/${s.id}`, { token })).body
    const { trucks, order_note: _n, route_version: _v, ...rest } = view
    assert.deepEqual(s, rest)
  }
  assert.deepEqual(r.body.storms[1].counts, { stops: 25, plowed: 1, skipped: 1, pending: 23 })
  assert.equal(r.body.storms[1].ended_label, 'Mon Jan 12, 7:55 AM')
})

test('route PUT: refuses a missing stop, a duplicate stop and a foreign truck; a moved stop shows on the other driver\'s route', async () => {
  const { token, storm, keyOf } = await stormSetup()
  const [t1, t2] = storm.trucks
  const lists = () => [{ truck_id: t1.id, client_ids: t1.stops.map(s => s.client_id) }, { truck_id: t2.id, client_ids: t2.stops.map(s => s.client_id) }]
  const versionNow = async () => (await api('GET', `/api/owner/storms/${storm.id}`, { token })).body.route_version
  const putRoute = async (trucks, now) => api('PUT', `/api/owner/storms/${storm.id}/route`, { token, body: { trucks, route_version: await versionNow() }, now })

  const missing = lists(); missing[0].client_ids.pop()
  expectError(await putRoute(missing), 400, 'bad_request', 'trucks')
  const duplicate = lists(); duplicate[1].client_ids.push(duplicate[0].client_ids[0])
  expectError(await putRoute(duplicate), 400, 'bad_request', 'trucks')
  expectError(await putRoute([...lists(), { truck_id: 999, client_ids: [] }]), 400, 'bad_request', 'trucks')
  const foreign = lists(); foreign[1].truck_id = 999
  expectError(await putRoute(foreign), 400, 'bad_request', 'trucks')
  expectError(await putRoute([lists()[0]]), 400, 'bad_request', 'trucks')
  const twice = lists(); twice[1].truck_id = t1.id
  expectError(await putRoute(twice), 400, 'bad_request', 'trucks')
  expectError(await putRoute('nope'), 400, 'bad_request', 'trucks')

  // Plow t1's third stop, then move it to the end of truck 2 and reverse the rest of truck 1.
  const moved = t1.stops[2]
  await post(keyOf(t1.id), checkin(storm, moved))
  const good = lists()
  good[0].client_ids = good[0].client_ids.filter(c => c !== moved.client_id).reverse()
  good[1].client_ids.push(moved.client_id)
  const r = await putRoute(good, at(40))
  assert.equal(r.status, 200, r.text)
  assert.deepEqual(r.body.trucks.map(t => t.stops.map(s => s.client_id)), good.map(g => g.client_ids))
  for (const t of r.body.trucks) assert.deepEqual(t.stops.map(s => s.position), t.stops.map((_, i) => i + 1))
  const d2 = (await api('GET', '/api/driver/route', { key: keyOf(t2.id) })).body.stops
  assert.equal(d2.at(-1).client_id, moved.client_id)
  assert.equal(d2.at(-1).position, t2.stops.length + 1)
  assert.equal(d2.at(-1).status, 'plowed')
  assert.equal(d2.at(-1).checkin.truck_id, t1.id)
  const d1 = (await api('GET', '/api/driver/route', { key: keyOf(t1.id) })).body.stops
  assert.ok(!d1.some(s => s.client_id === moved.client_id))
  assert.deepEqual(d1.map(s => s.client_id), good[0].client_ids)

  // An empty list for a truck is allowed.
  const empty = [{ truck_id: t1.id, client_ids: [] }, { truck_id: t2.id, client_ids: [...good[0].client_ids, ...good[1].client_ids] }]
  assert.equal((await putRoute(empty)).status, 200)

  await endAt(token, storm.id, at(100))
  expectError(await putRoute(empty), 409, 'bad_state')
  expectError(await api('PUT', '/api/owner/storms/999/route', { token, body: { trucks: [], route_version: 1 } }), 404, 'not_found')
})

test('stops: POST appends and refuses, DELETE only a stop with no check-ins and renumbers, ended storm 409', async () => {
  const seed = await reset()
  const token = await signin()
  const [c1, c2, c3, c4, c5] = seed.clients.map(c => c.id)
  const t1 = seed.trucks[0].id
  const t2 = seed.trucks[1].id
  const r0 = await api('POST', '/api/owner/storms', { token, body: { client_ids: [c1, c2, c3], truck_ids: [t1] } })
  const storm = r0.body
  const addStop = body => api('POST', `/api/owner/storms/${storm.id}/stops`, { token, body })

  expectError(await addStop({ client_id: c4, truck_id: t2 }), 400, 'bad_request', 'truck_id')
  expectError(await addStop({ client_id: c1, truck_id: t1 }), 400, 'bad_request', 'client_id')
  expectError(await addStop({ client_id: 9999, truck_id: t1 }), 400, 'bad_request', 'client_id')
  await editClient(token, c5, { active: false })
  expectError(await addStop({ client_id: c5, truck_id: t1 }), 400, 'bad_request', 'client_id')
  const added = await addStop({ client_id: c4, truck_id: t1 })
  assert.equal(added.status, 200, added.text)
  assert.deepEqual(added.body.trucks[0].stops.at(-1).client_id, c4)
  assert.deepEqual(added.body.trucks[0].stops.map(s => s.position), [1, 2, 3, 4])
  assert.equal(added.body.counts.stops, 4)

  const [first, second] = added.body.trucks[0].stops
  await post(seed.trucks[0].driver_key, checkin(storm, first))
  const del = id => api('DELETE', `/api/owner/storms/${storm.id}/stops/${id}`, { token })
  expectError(await del(first.client_id), 409, 'bad_state')
  expectError(await del(c5), 404, 'not_found')
  const removed = await del(second.client_id)
  assert.equal(removed.status, 200, removed.text)
  assert.ok(!stopsOf(removed.body).some(s => s.client_id === second.client_id))
  assert.deepEqual(removed.body.trucks[0].stops.map(s => s.position), [1, 2, 3])

  // Even a voided check-in keeps the stop.
  const third = removed.body.trucks[0].stops[1]
  const k = checkin(storm, third)
  await post(seed.trucks[0].driver_key, k)
  assert.equal((await api('DELETE', `/api/driver/checkins/${k.id}`, { key: seed.trucks[0].driver_key, now: at(35) })).status, 200)
  expectError(await del(third.client_id), 409, 'bad_state')

  await endAt(token, storm.id, at(60))
  expectError(await addStop({ client_id: second.client_id, truck_id: t1 }), 409, 'bad_state')
  expectError(await del(removed.body.trucks[0].stops[2].client_id), 409, 'bad_state')
})

test('end and summary: counts, skipped with reason, not_reached, per-truck first and last, second end 409', async () => {
  const { token, storm, keyOf } = await stormSetup()
  const [t1, t2] = storm.trucks
  const key = keyOf(t1.id)
  await post(key, checkin(storm, t1.stops[0], { at: at(20) }), at(21))
  await post(key, checkin(storm, t1.stops[1], { kind: 'skipped', reason: 'gate', at: at(30) }), at(31))
  await post(key, checkin(storm, t1.stops[2], { at: at(50) }), at(51))

  const active = await api('GET', `/api/owner/storms/${storm.id}/summary`, { token, now: at(60) })
  assert.equal(active.status, 200, active.text)
  assert.equal(active.body.status, 'active')
  assert.equal(active.body.ended_label, null)
  assert.equal(active.body.duration_label, null)

  const ended = await api('POST', `/api/owner/storms/${storm.id}/end`, { token, now: at(220) })
  assert.equal(ended.status, 200, ended.text)
  assert.equal(ended.body.storm.status, 'ended')
  assert.equal(ended.body.storm.ended_at, at(220))
  assert.ok(ended.body.storm.trucks[0].stops[0].messages, 'owner view has messages')
  const pending = [...t1.stops.slice(3), ...t2.stops]
  assert.deepEqual(ended.body.summary, {
    storm_id: storm.id,
    name: 'Storm of Mon Jan 12',
    status: 'ended',
    started_label: 'Mon Jan 12, 4:35 AM',
    ended_label: 'Mon Jan 12, 8:15 AM',
    duration_label: '3 h 40 min',
    stops: 25,
    plowed: 2,
    billable_pushes: 2,
    skipped: [{ client_id: t1.stops[1].client_id, name: t1.stops[1].name, reason_text: 'Gate locked', at_label: '5:05 AM' }],
    not_reached: pending.map(s => ({ client_id: s.client_id, name: s.name })),
    trucks: [
      { id: t1.id, name: t1.name, plowed: 2, skipped: 1, pending: t1.stops.length - 3, first_label: '4:55 AM', last_label: '5:25 AM' },
      { id: t2.id, name: t2.name, plowed: 0, skipped: 0, pending: t2.stops.length, first_label: null, last_label: null }
    ]
  })
  assert.deepEqual((await api('GET', `/api/owner/storms/${storm.id}/summary`, { token })).body, ended.body.summary)
  expectError(await api('POST', `/api/owner/storms/${storm.id}/end`, { token }), 409, 'bad_state')
  expectError(await api('POST', '/api/owner/storms/999/end', { token }), 404, 'not_found')
  expectError(await api('GET', '/api/owner/storms/999/summary', { token }), 404, 'not_found')
  assert.equal((await api('GET', '/api/driver/route', { key })).body.storm, null)
  // A new storm can start now.
  assert.equal((await api('POST', '/api/owner/storms', { token, body: { client_ids: [t2.stops[0].client_id], truck_ids: [t2.id] } })).status, 201)
})

// ---------------------------------------------------------------- undo

test('undo: within 15 min voided, stop pending again and no billing; after 16 min 409; other truck 404; again 200', async () => {
  const { seed, token, storm, keyOf } = await stormSetup()
  const truck = storm.trucks[0]
  const key = keyOf(truck.id)
  const stop = truck.stops[0]
  const body = checkin(storm, stop, { has_photo: true })
  await post(key, body, at(31))
  const photo = await api('PUT', `/api/driver/checkins/${body.id}/photo`, { key, raw: JPEG, headers: { 'content-type': 'image/jpeg' } })
  const del = (id, now, k = key) => api('DELETE', `/api/driver/checkins/${id}`, { key: k, now })

  expectError(await del(body.id, at(40), keyOf(storm.trucks[1].id)), 404, 'not_found')
  expectError(await del(randomUUID(), at(40)), 404, 'not_found')
  expectError(await del(body.id, at(40), 'bad-key'), 401, 'unauthorized')
  const undone = await del(body.id, at(31 + 15))
  assert.equal(undone.status, 200, undone.text)
  assert.equal(undone.body.checkin.voided, true)
  assert.equal(undone.body.stop.status, 'pending')
  assert.equal(undone.body.stop.checkin, null)
  const again = await del(body.id, at(120))
  assert.equal(again.status, 200)
  assert.equal(again.body.checkin.voided, true)

  assert.equal((await ownerStop(token, storm.id, stop.client_id)).status, 'pending')
  assert.equal(rowOf(await billing(token, JAN), stop.client_id)?.pushes ?? 0, 0)
  assert.equal((await api('GET', `/api/status/${seed.clients.find(c => c.id === stop.client_id).status_key}`, { now: at(50) })).body.last, null)
  expectError(await api('GET', new URL(photo.body.checkin.photo_url).pathname), 404, 'not_found')
  assert.equal((await ownerClient(token, stop.client_id)).last_plowed_at, null)

  // Plowed again after the undo is allowed; undo 16 minutes after it arrived is too late.
  const second = checkin(storm, stop, { at: at(50) })
  assert.equal((await post(key, second, at(51))).status, 201)
  const late = await del(second.id, at(51 + 16))
  expectError(late, 409, 'bad_state')
  assert.equal(late.body.error, 'Too late to undo. Ask the owner to fix it.')
  assert.equal((await ownerStop(token, storm.id, stop.client_id)).status, 'plowed')
})

// ---------------------------------------------------------------- billing

test('billing: per-push amounts, HST half up, totals are row sums, seasonal rows', async () => {
  const seed = await reset()
  const token = await signin()
  const chris = seedClient(seed, 'sample-04').id // per push, truck 1
  const robin = seedClient(seed, 'sample-07').id // per push, truck 2
  const sam = seedClient(seed, 'sample-03').id // seasonal 55000
  const kerry = seedClient(seed, 'sample-15').id // seasonal, made inactive
  const taylor = seedClient(seed, 'sample-10').id // seasonal, no pushes
  await editClient(token, chris, { price_cents: 3550 })
  await editClient(token, robin, { price_cents: 3550 })
  await editClient(token, kerry, { active: false })

  const days = ['2026-01-05T08:00:00.000Z', '2026-01-12T08:00:00.000Z', '2026-01-19T08:00:00.000Z']
  for (const [i, start] of days.entries()) {
    const storm = await startAt(token, seed, start, [chris, robin, sam])
    await checkinAt(seed, storm, chris, plus(start, 30))
    if (i < 2) await checkinAt(seed, storm, sam, plus(start, 40))
    if (i === 0) await checkinAt(seed, storm, robin, plus(start, 50))
    await endAt(token, storm.id, plus(start, 120))
  }

  const r = await billing(token, JAN)
  assert.equal(r.month, JAN)
  assert.equal(r.label, 'January 2026')
  assert.equal(r.hst_rate, 0.15)
  assert.equal(r.seasonal_note, 'Seasonal contracts are billed on the contract, not by the push. Their pushes are counted here for your records.')
  const chrisClient = await ownerClient(token, chris)
  assert.deepEqual(rowOf(r, chris), {
    client_id: chris, name: 'Chris (SAMPLE)', address: chrisClient.address, billing: 'per_push', billing_label: 'Per push', price_cents: 3550,
    pushes: 3, dates: ['2026-01-05', '2026-01-12', '2026-01-19'], amount_cents: 10650, hst_cents: 1598, total_cents: 12248
  })
  assert.deepEqual([rowOf(r, robin).amount_cents, rowOf(r, robin).hst_cents, rowOf(r, robin).total_cents], [3550, 533, 4083])
  const samRow = rowOf(r, sam)
  assert.deepEqual([samRow.billing_label, samRow.pushes, samRow.dates, samRow.amount_cents, samRow.hst_cents, samRow.total_cents, samRow.price_cents],
    ['Seasonal contract', 2, ['2026-01-05', '2026-01-12'], 0, 0, 0, 55000])
  assert.deepEqual([rowOf(r, taylor).pushes, rowOf(r, taylor).total_cents], [0, 0])
  assert.equal(rowOf(r, kerry), undefined, 'inactive seasonal client with no pushes is not listed')
  const activeSeasonal = SAMPLE.clients.filter(c => c.billing === 'seasonal' && c.ref !== 'sample-15').length
  assert.equal(r.rows.length, activeSeasonal + 2)
  const names = r.rows.map(x => x.name.toLowerCase())
  assert.deepEqual(names, [...names].sort())
  const sum = key => r.rows.reduce((t, x) => t + x[key], 0)
  assert.deepEqual(r.totals, { pushes: sum('pushes'), subtotal_cents: sum('amount_cents'), hst_cents: sum('hst_cents'), total_cents: sum('total_cents') })
  assert.deepEqual(r.totals, { pushes: 6, subtotal_cents: 14200, hst_cents: 2131, total_cents: 16331 })

  const csv = await api('GET', `/api/owner/billing.csv?month=${JAN}`, { token })
  assert.ok(csv.text.split('\r\n').includes(`Chris (SAMPLE),"${chrisClient.address}",Per push,3,2026-01-05; 2026-01-12; 2026-01-19,35.50,106.50,15.98,122.48`))
  assert.equal(csv.text.split('\r\n').at(-2), 'Total,,,6,,,142.00,21.31,163.31')
  assert.deepEqual((await api('GET', '/api/owner/billing/months', { token })).body, { months: [JAN] })
})

test('billing: a skipped stop never bills', async () => {
  const seed = await reset()
  const token = await signin()
  const chris = seedClient(seed, 'sample-04').id
  const jordan = seedClient(seed, 'sample-05').id // per push
  const storm = await startAt(token, seed, '2026-01-05T08:00:00.000Z', [chris, jordan])
  await checkinAt(seed, storm, chris, '2026-01-05T08:30:00.000Z')
  await checkinAt(seed, storm, jordan, '2026-01-05T08:40:00.000Z', { kind: 'skipped', reason: 'car' })
  await endAt(token, storm.id, '2026-01-05T10:00:00.000Z')
  const r = await billing(token, JAN)
  assert.equal(rowOf(r, jordan), undefined, `the skipped client billed: ${JSON.stringify(rowOf(r, jordan))}`)
  assert.equal(rowOf(r, chris).pushes, 1)
  assert.equal(r.totals.pushes, 1)
  const summary = (await api('GET', `/api/owner/storms/${storm.id}/summary`, { token })).body
  assert.equal(summary.billable_pushes, 1)
})

test('billing: a voided check-in never bills', async () => {
  const seed = await reset()
  const token = await signin()
  const chris = seedClient(seed, 'sample-04').id
  const storm = await startAt(token, seed, '2026-01-05T08:00:00.000Z', [chris])
  const made = await checkinAt(seed, storm, chris, '2026-01-05T08:30:00.000Z')
  const undo = await api('DELETE', `/api/driver/checkins/${made.checkin.id}`, { key: made.key, now: '2026-01-05T08:36:00.000Z' })
  assert.equal(undo.status, 200, undo.text)
  const r = await billing(token, JAN)
  assert.equal(rowOf(r, chris), undefined, `the voided check-in billed: ${JSON.stringify(rowOf(r, chris))}`)
  assert.equal(r.totals.pushes, 0)
  assert.deepEqual((await api('GET', '/api/owner/billing/months', { token })).body, { months: [] })
})

test('billing: NL month boundary (2026-02-01T03:00:00Z is Jan 31 11:30 PM NST and bills in January)', async () => {
  const seed = await reset()
  const token = await signin()
  const chris = seedClient(seed, 'sample-04').id
  const storm = await startAt(token, seed, '2026-02-01T02:30:00.000Z', [chris])
  const made = await checkinAt(seed, storm, chris, '2026-02-01T03:00:00.000Z')
  assert.equal(made.checkin.at, '2026-02-01T03:00:00.000Z')
  const jan = await billing(token, JAN)
  assert.deepEqual([rowOf(jan, chris)?.pushes, rowOf(jan, chris)?.dates], [1, ['2026-01-31']])
  const feb = await billing(token, '2026-02')
  assert.equal(rowOf(feb, chris), undefined)
  assert.equal(feb.totals.pushes, 0)
  assert.deepEqual((await api('GET', '/api/owner/billing/months', { token })).body, { months: [JAN] })
  // No month: the current NL month (Jan 31 at 11:45 PM NST).
  assert.equal((await billing(token, null, '2026-02-01T03:15:00.000Z')).month, JAN)
})

test('billing CSV: header, CRLF, quoting, formula guard, filename', async () => {
  const seed = await reset()
  const token = await signin()
  const chris = seedClient(seed, 'sample-04').id
  await editClient(token, seedClient(seed, 'sample-03').id, { name: 'Doe, "Jo" (SAMPLE)' })
  await editClient(token, seedClient(seed, 'sample-10').id, { name: '=SUM(A1)' })
  const storm = await startAt(token, seed, '2026-01-05T08:00:00.000Z', [chris])
  await checkinAt(seed, storm, chris, '2026-01-05T08:30:00.000Z')

  const r = await api('GET', `/api/owner/billing.csv?month=${JAN}`, { token })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.headers.get('content-type'), 'text/csv; charset=utf-8')
  assert.equal(r.headers.get('content-disposition'), 'attachment; filename="snow-route-SAMPLE-2026-01.csv"')
  assert.ok(r.text.endsWith('\r\n'))
  assert.ok(!r.text.replace(/\r\n/g, '').includes('\n'), 'bare LF')
  const lines = r.text.slice(0, -2).split('\r\n')
  assert.equal(lines[0], 'Client,Address,Billing,Pushes,Push dates,Price,Amount,HST 15%,Total')
  assert.equal(lines[1], "'=SUM(A1),\"Memorial Avenue, Grand Falls-Windsor, NL\",Seasonal contract,0,,600.00,0.00,0.00,0.00")
  assert.ok(lines.includes('Chris (SAMPLE),"Scott Avenue, Grand Falls-Windsor, NL",Per push,1,2026-01-05,35.00,35.00,5.25,40.25'))
  assert.ok(lines.includes('"Doe, ""Jo"" (SAMPLE)","Harris Avenue, Grand Falls-Windsor, NL",Seasonal contract,0,,550.00,0.00,0.00,0.00'))
  assert.equal(lines.at(-1), 'Total,,,1,,,35.00,5.25,40.25')
  for (const line of lines.slice(1)) assert.ok(!/^[=+\-@]/.test(line), `unguarded: ${line}`)
  const json = await billing(token, JAN)
  assert.equal(lines.length, json.rows.length + 2)

  await api('PUT', '/api/owner/company', { token, body: { name: 'Demo Snow Clearing', yard: YARD } })
  const plain = await api('GET', `/api/owner/billing.csv?month=${JAN}`, { token })
  assert.equal(plain.headers.get('content-disposition'), 'attachment; filename="snow-route-2026-01.csv"')
})

test('billing: bad month 400 on JSON and CSV, owner only', async () => {
  await reset()
  const token = await signin()
  for (const month of ['2026-13', '2026-1', 'January', '2026-01-05']) {
    expectError(await api('GET', `/api/owner/billing?month=${month}`, { token }), 400, 'bad_request', 'month')
    expectError(await api('GET', `/api/owner/billing.csv?month=${month}`, { token }), 400, 'bad_request', 'month')
  }
  expectError(await api('GET', '/api/owner/billing'), 401, 'unauthorized')
  expectError(await api('GET', '/api/owner/billing.csv'), 401, 'unauthorized')
  expectError(await api('GET', '/api/owner/billing/months'), 401, 'unauthorized')
})

// ---------------------------------------------------------------- rate guards

test('rate guard: 5 wrong PINs from one IP, then 429 even for the right PIN; other IPs fine; clears after 15 min', async () => {
  await reset()
  const signinFrom = (ip, pin, now = at(1)) => api('POST', '/api/owner/signin', { body: { pin }, ip, now })
  for (let i = 0; i < 5; i++) expectError(await signinFrom('10.1.1.1', '0000'), 401, 'unauthorized', 'pin')
  const limited = await signinFrom('10.1.1.1', '0000')
  expectError(limited, 429, 'rate_limited')
  assert.equal(limited.body.error, 'Too many tries. Wait 15 minutes and try again.')
  expectError(await signinFrom('10.1.1.1', '2468'), 429, 'rate_limited')
  assert.equal((await signinFrom('10.9.9.9', '2468')).status, 200)
  assert.equal((await signinFrom('10.1.1.1', '2468', at(15))).status, 429, 'still inside 15 minutes')
  assert.equal((await signinFrom('10.1.1.1', '2468', at(16) + '')).status, 200)
  // A right PIN doesn't use up a try.
  for (let i = 0; i < 4; i++) expectError(await signinFrom('10.2.2.2', '0000'), 401, 'unauthorized')
  for (let i = 0; i < 3; i++) assert.equal((await signinFrom('10.2.2.2', '2468')).status, 200)
  expectError(await signinFrom('10.2.2.2', '0000'), 401, 'unauthorized')
  expectError(await signinFrom('10.2.2.2', '2468'), 429, 'rate_limited')
})

test('rate guard: 30 unknown status keys from one IP, then 429 for any key from it; other IPs fine; clears after 10 min', async () => {
  const seed = await reset()
  const good = seed.clients[0].status_key
  const lookup = (ip, key, now = at(1)) => api('GET', `/api/status/${key}`, { ip, now })
  for (let i = 0; i < 30; i++) expectError(await lookup('10.3.3.3', `unknown-${i}`), 404, 'not_found')
  expectError(await lookup('10.3.3.3', 'unknown-30'), 429, 'rate_limited')
  expectError(await lookup('10.3.3.3', good), 429, 'rate_limited')
  assert.equal((await lookup('10.4.4.4', good)).status, 200)
  expectError(await lookup('10.4.4.4', 'unknown-x'), 404, 'not_found')
  expectError(await lookup('10.3.3.3', good, at(10)), 429, 'rate_limited')
  assert.equal((await lookup('10.3.3.3', good, at(11) + '')).status, 200)
  // Good keys never count.
  for (let i = 0; i < 40; i++) assert.equal((await lookup('10.5.5.5', good)).status, 200)
})

// ---------------------------------------------------------------- demo seed

test('demo seed: two ended storms, an active one with 10 plowed and 2 skipped, placeholder photos, billing this month', async () => {
  const NOW = '2026-01-20T15:00:00.000Z'
  expectError(await api('POST', '/api/test/seed', { body: { scenario: 'other' }, now: NOW }), 400, 'bad_request', 'scenario')
  const r = await api('POST', '/api/test/seed', { body: { scenario: 'demo' }, now: NOW })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.body.pin, '2468')
  assert.equal(r.body.trucks.length, 2)
  assert.equal(r.body.clients.length, 25)
  const token = await signin()
  const current = (await api('GET', '/api/owner/storms/current', { token, now: NOW })).body.storm
  assert.equal(current.id, r.body.storm_id)
  assert.equal(current.started_at, plus(NOW, -120))
  assert.deepEqual(current.counts, { stops: 25, plowed: 10, skipped: 2, pending: 13 })
  let waiting = 0
  for (const t of current.trucks) {
    assert.deepEqual(t.stops.slice(0, 5).map(s => s.status), ['plowed', 'plowed', 'plowed', 'plowed', 'plowed'])
    assert.equal(t.stops[5].status, 'skipped')
    assert.equal(t.stops[5].checkin.reason_text, 'Gate locked')
    assert.ok(t.stops.slice(6).every(s => s.status === 'pending'))
    for (const s of t.stops.slice(0, 5)) {
      assert.ok(s.checkin.at < NOW)
      if (s.checkin.photo === 'waiting') waiting++
      else assert.equal(s.checkin.photo, 'stored')
    }
  }
  assert.equal(waiting, 1)
  const photoUrl = current.trucks[1].stops[0].checkin.photo_url
  const photo = await api('GET', new URL(photoUrl).pathname)
  assert.equal(photo.status, 200)
  assert.equal(photo.headers.get('content-type'), 'image/svg+xml')
  assert.equal(photo.headers.get('content-security-policy'), "default-src 'none'; style-src 'unsafe-inline'")
  assert.match(photo.text, /^<svg[\s\S]*SAMPLE placeholder photo/)

  const storms = (await api('GET', '/api/owner/storms', { token })).body.storms
  assert.deepEqual(storms.map(s => s.status), ['active', 'ended', 'ended'])
  assert.deepEqual(storms.slice(1).map(s => s.started_at), [plus(NOW, -6 * 24 * 60), plus(NOW, -13 * 24 * 60)])
  for (const s of storms.slice(1)) {
    const summary = (await api('GET', `/api/owner/storms/${s.id}/summary`, { token })).body
    assert.equal(summary.plowed, 24)
    assert.deepEqual(summary.skipped.map(x => x.reason_text), ['Car in the way'])
    assert.deepEqual(summary.not_reached, [])
  }
  const bill = await billing(token, null, NOW)
  assert.equal(bill.month, JAN)
  assert.ok(bill.rows.some(x => x.pushes > 0))
  assert.equal(bill.totals.pushes, 58)
  assert.ok(bill.totals.total_cents > 0)
  assert.deepEqual((await api('GET', '/api/owner/billing/months', { token })).body, { months: [JAN] })
})

// ================================================================ M3

test('stops: a check-in after the removal answers 404; a removal after the check-in answers 409', async () => {
  const { token, storm, keyOf } = await stormSetup()
  const truck = storm.trucks[0]
  const key = keyOf(truck.id)
  const [gone, kept] = truck.stops
  const removed = await api('DELETE', `/api/owner/storms/${storm.id}/stops/${gone.client_id}`, { token })
  assert.equal(removed.status, 200, removed.text)
  const late = await post(key, checkin(storm, gone))
  expectError(late, 404, 'not_found')
  assert.equal(late.body.error, 'That client is not a stop in this storm.')
  assert.equal((await storedRows(storm.id, gone.client_id)).length, 0)

  assert.equal((await post(key, checkin(storm, kept))).status, 201)
  const refused = await api('DELETE', `/api/owner/storms/${storm.id}/stops/${kept.client_id}`, { token })
  expectError(refused, 409, 'bad_state')
  assert.equal(refused.body.error, 'This stop has check-ins, so it stays on the route.')
  assert.ok(stopsOf((await api('GET', `/api/owner/storms/${storm.id}`, { token })).body).some(s => s.client_id === kept.client_id))
})

test('stop race: 10 check-ins racing removals of the same stops, one of each pair wins and no check-in lands on a removed stop', async () => {
  const seed = await reset()
  const token = await signin()
  const truck = seed.trucks[0]
  const started = await api('POST', '/api/owner/storms', { token, body: { client_ids: seed.clients.map(c => c.id), truck_ids: [truck.id] } })
  assert.equal(started.status, 201, started.text)
  const storm = started.body
  const targets = storm.trucks[0].stops.slice(0, 10)
  const pairs = await Promise.all(targets.map(async stop => {
    const sent = post(truck.driver_key, checkin(storm, stop))
    await new Promise(resolve => setTimeout(resolve, 5))
    const removal = api('DELETE', `/api/owner/storms/${storm.id}/stops/${stop.client_id}`, { token })
    return { client_id: stop.client_id, checkin: (await sent).status, removal: (await removal).status }
  }))
  const view = (await api('GET', `/api/owner/storms/${storm.id}`, { token })).body
  const onRoute = new Set(stopsOf(view).map(s => s.client_id))
  const rows = (await api('GET', `/api/test/checkins?storm_id=${storm.id}`)).body.checkins
  const orphans = rows.filter(k => !onRoute.has(k.client_id)).length
  console.log(`STOPRACE orphans=${orphans} outcomes=${pairs.map(p => `${p.checkin}/${p.removal}`).join(',')}`)
  assert.equal(orphans, 0, `${orphans} check-ins landed on removed stops`)
  for (const p of pairs) {
    const oneWinner = (p.checkin === 201 && p.removal === 409) || (p.checkin === 404 && p.removal === 200)
    assert.ok(oneWinner, `client ${p.client_id}: check-in ${p.checkin}, removal ${p.removal}`)
  }
  for (const t of view.trucks) assert.deepEqual(t.stops.map(s => s.position), t.stops.map((_, i) => i + 1))
})

test('PIN change: wrong current PINs count toward the sign-in guard, then 429 even for the right PIN, per IP', async () => {
  await reset()
  const token = await signin()
  const change = (current, ip) => api('PUT', '/api/owner/pin', { token, ip, now: at(1), body: { current, next: '1357' } })
  const signinFrom = (pin, ip) => api('POST', '/api/owner/signin', { body: { pin }, ip, now: at(1) })

  for (let i = 0; i < 5; i++) expectError(await change('0000', '10.6.6.6'), 401, 'unauthorized', 'current')
  const limited = await change('2468', '10.6.6.6')
  expectError(limited, 429, 'rate_limited')
  assert.equal(limited.body.error, 'Too many tries. Wait 15 minutes and try again.')
  expectError(await signinFrom('2468', '10.6.6.6'), 429, 'rate_limited')

  // Wrong sign-ins and wrong PIN changes share the same 5 tries.
  for (let i = 0; i < 3; i++) expectError(await signinFrom('0000', '10.7.7.7'), 401, 'unauthorized')
  for (let i = 0; i < 2; i++) expectError(await change('0000', '10.7.7.7'), 401, 'unauthorized')
  expectError(await change('2468', '10.7.7.7'), 429, 'rate_limited')

  // A right current PIN doesn't use up a try, and another IP is unaffected.
  assert.equal((await change('2468', '10.8.8.8')).status, 204)
  assert.equal((await signinFrom('1357', '10.8.8.8')).status, 200)
})

// ================================================================ M4

test('status link: a mangled key answers the status 404 text and counts toward the unknown-key guard', async () => {
  const seed = await reset()
  const good = seed.clients[0].status_key
  const TEXT = "This status link doesn't work. Ask your snow clearing company for a new one."
  const ip = '10.9.1.1'
  const lookup = (key, from = ip) => api('GET', `/api/status/${key}`, { ip: from, now: at(1) })
  const mangled = [`${good}.`, `${good})`, `${good}%20`, '', 'a'.repeat(129), `${good}${'x'.repeat(200)}`]
  for (const key of mangled) {
    const r = await lookup(key)
    expectError(r, 404, 'not_found')
    assert.equal(r.body.error, TEXT, `key ${JSON.stringify(key.slice(0, 40))}`)
    assert.equal(r.headers.get('cache-control'), 'no-store')
  }
  // Six mangled lookups so far; 24 more reach the limit of 30, and the 31st answers 429, known keys included.
  for (let i = mangled.length; i < 30; i++) expectError(await lookup(`${good}.`), 404, 'not_found')
  expectError(await lookup(`${good}%20`), 429, 'rate_limited')
  expectError(await lookup(good), 429, 'rate_limited')
  assert.equal((await lookup(good, '10.9.2.2')).status, 200)
})

// ================================================================ M5

test('check-ins: a plowed check-in stores no note and no reason, whatever the body sends', async () => {
  const { token, storm, keyOf } = await stormSetup()
  const truck = storm.trucks[0]
  const key = keyOf(truck.id)
  const [a, b, c] = truck.stops

  const r = await post(key, checkin(storm, a, { note: '  Left a note  ', reason: 'gate' }))
  assert.equal(r.status, 201, r.text)
  assert.equal(r.body.checkin.note, '')
  assert.equal(r.body.checkin.reason, null)
  assert.equal(r.body.checkin.reason_text, null)
  const rows = await storedRows(storm.id, a.client_id)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].note, '', 'stored note on a plowed check-in')
  assert.equal(rows[0].reason, null, 'stored reason on a plowed check-in')
  assert.equal((await ownerStop(token, storm.id, a.client_id)).checkin.note, '')

  // A note over 120 characters on a plowed check-in is ignored, not refused.
  const long = await post(key, checkin(storm, b, { note: 'x'.repeat(500) }))
  assert.equal(long.status, 201, long.text)
  assert.equal(long.body.checkin.note, '')

  // A skip keeps its note (trimmed).
  const skip = await post(key, checkin(storm, c, { kind: 'skipped', reason: 'other', note: '  Truck blocking  ' }))
  assert.equal(skip.status, 201, skip.text)
  assert.equal(skip.body.checkin.note, 'Truck blocking')
  assert.equal(skip.body.checkin.reason_text, 'Other: Truck blocking')
})

// ================================================================ M6

const ROUTE_CHANGED = 'The route changed while you were editing it. Reload and try again.'
const listsOf = storm => storm.trucks.map(t => ({ truck_id: t.id, client_ids: t.stops.map(s => s.client_id) }))
const putRouteAs = (token, stormId, trucks, routeVersion) =>
  api('PUT', `/api/owner/storms/${stormId}/route`, { token, body: routeVersion === undefined ? { trucks } : { trucks, route_version: routeVersion } })
const reversedFirst = lists => lists.map((l, i) => (i === 0 ? { ...l, client_ids: [...l.client_ids].reverse() } : l))

/** A storm with every client except the last one, so a stop can be added. */
async function partialStorm () {
  const seed = await reset()
  const token = await signin()
  const spare = seed.clients.at(-1)
  const r = await api('POST', '/api/owner/storms', { token, body: { client_ids: seed.clients.slice(0, -1).map(c => c.id), truck_ids: seed.trucks.map(t => t.id) } })
  assert.equal(r.status, 201, r.text)
  return { seed, token, storm: r.body, spare }
}

test('route version: every owner Storm carries it; route PUT, stop add and stop remove each bump it, refusals do not', async () => {
  const { seed, token, storm, spare } = await partialStorm()
  const version = async () => (await api('GET', `/api/owner/storms/${storm.id}`, { token })).body.route_version
  assert.equal(storm.route_version, 1)
  assert.equal((await api('GET', '/api/owner/storms/current', { token })).body.storm.route_version, 1)

  const put = await putRouteAs(token, storm.id, reversedFirst(listsOf(storm)), 1)
  assert.equal(put.status, 200, put.text)
  assert.equal(put.body.route_version, 2)

  const added = await api('POST', `/api/owner/storms/${storm.id}/stops`, { token, body: { client_id: spare.id, truck_id: seed.trucks[0].id } })
  assert.equal(added.status, 200, added.text)
  assert.equal(added.body.route_version, 3)

  const removed = await api('DELETE', `/api/owner/storms/${storm.id}/stops/${spare.id}`, { token })
  assert.equal(removed.status, 200, removed.text)
  assert.equal(removed.body.route_version, 4)

  // Refused edits leave the version alone.
  const current = (await api('GET', `/api/owner/storms/${storm.id}`, { token })).body
  const dup = listsOf(current)
  dup[1].client_ids.push(dup[0].client_ids[0])
  expectError(await putRouteAs(token, storm.id, dup, 4), 400, 'bad_request', 'trucks')
  expectError(await api('POST', `/api/owner/storms/${storm.id}/stops`, { token, body: { client_id: dup[0].client_ids[0], truck_id: seed.trucks[0].id } }), 400, 'bad_request', 'client_id')
  assert.equal(await version(), 4)
  // The driver route and the storms list are not part of the change.
  assert.equal((await api('GET', '/api/driver/route', { key: seed.trucks[0].driver_key })).body.storm.route_version, undefined)
})

test('route version: a stale version with the same stop set answers 409 route changed, and the first edit stands', async () => {
  const { token, storm } = await partialStorm()
  const first = reversedFirst(listsOf(storm))
  assert.equal((await putRouteAs(token, storm.id, first, 1)).status, 200)
  // A second screen still holding version 1 moves a stop with the same stops.
  const second = listsOf(storm)
  second[1].client_ids.push(second[0].client_ids.shift())
  const stale = await putRouteAs(token, storm.id, second, 1)
  expectError(stale, 409, 'bad_state')
  assert.equal(stale.body.error, ROUTE_CHANGED)
  const now = (await api('GET', `/api/owner/storms/${storm.id}`, { token })).body
  assert.deepEqual(listsOf(now), first, 'the first edit is not undone')
  assert.equal(now.route_version, 2)
})

test('route version: a stale version after a stop was added answers 409, not 400; the same lists with the current version answer 400 trucks', async () => {
  const { seed, token, storm, spare } = await partialStorm()
  const old = listsOf(storm)
  const added = await api('POST', `/api/owner/storms/${storm.id}/stops`, { token, body: { client_id: spare.id, truck_id: seed.trucks[1].id } })
  assert.equal(added.status, 200)
  const stale = await putRouteAs(token, storm.id, reversedFirst(old), 1)
  expectError(stale, 409, 'bad_state')
  assert.equal(stale.body.error, ROUTE_CHANGED)
  expectError(await putRouteAs(token, storm.id, reversedFirst(old), 2), 400, 'bad_request', 'trucks')
  // Also a stale body naming a stop that was removed since.
  const removed = await api('DELETE', `/api/owner/storms/${storm.id}/stops/${spare.id}`, { token })
  assert.equal(removed.status, 200)
  const withSpare = listsOf(added.body)
  expectError(await putRouteAs(token, storm.id, withSpare, 2), 409, 'bad_state')
})

test('route version: the current version with a duplicate stop answers 400 trucks; a missing or non-integer version answers 400 route_version', async () => {
  const { token, storm } = await partialStorm()
  const dup = listsOf(storm)
  dup[1].client_ids.push(dup[0].client_ids[0])
  expectError(await putRouteAs(token, storm.id, dup, 1), 400, 'bad_request', 'trucks')
  const twiceTruck = listsOf(storm)
  twiceTruck[1] = { ...twiceTruck[1], truck_id: twiceTruck[0].truck_id }
  expectError(await putRouteAs(token, storm.id, twiceTruck, 1), 400, 'bad_request', 'trucks')
  expectError(await putRouteAs(token, storm.id, [...listsOf(storm), { truck_id: 999, client_ids: [] }], 1), 400, 'bad_request', 'trucks')
  // Malformed with a stale version is still malformed.
  expectError(await putRouteAs(token, storm.id, 'nope', 7), 400, 'bad_request', 'trucks')
  for (const v of [undefined, null, '1', 1.5]) {
    expectError(await putRouteAs(token, storm.id, listsOf(storm), v), 400, 'bad_request', 'route_version')
  }
  assert.equal((await api('GET', `/api/owner/storms/${storm.id}`, { token })).body.route_version, 1)
})

test('route version: two PUTs racing with the same version give exactly one 200 and one 409', async () => {
  const { token, storm } = await partialStorm()
  let version = 1
  let lists = listsOf(storm)
  for (let round = 0; round < 5; round++) {
    const a = reversedFirst(lists)
    const b = lists.map((l, i) => (i === 1 ? { ...l, client_ids: [...l.client_ids].reverse() } : l))
    const [ra, rb] = await Promise.all([putRouteAs(token, storm.id, a, version), putRouteAs(token, storm.id, b, version)])
    const statuses = [ra.status, rb.status].sort()
    console.log(`ROUTERACE round=${round} statuses=${statuses.join('/')}`)
    assert.deepEqual(statuses, [200, 409], `round ${round}: ${ra.text} | ${rb.text}`)
    const loser = ra.status === 409 ? ra : rb
    assert.equal(loser.body.error, ROUTE_CHANGED)
    const winnerLists = ra.status === 200 ? a : b
    const now = (await api('GET', `/api/owner/storms/${storm.id}`, { token })).body
    assert.deepEqual(listsOf(now), winnerLists, `round ${round}: the stored route is the winner's`)
    assert.equal(now.route_version, version + 1)
    version = now.route_version
    lists = listsOf(now)
  }
})

// ================================================================ M7

test('removable: a fresh stop is removable; after a plowed check-in it is not; after that check-in is undone it still is not, and the DELETE answers 409', async () => {
  const { seed, token, storm, spare } = await partialStorm()
  const truck = storm.trucks[0]
  const key = seed.trucks.find(t => t.id === truck.id).driver_key
  const [a, b] = truck.stops
  const ownerStopOf = async clientId => ownerStop(token, storm.id, clientId)

  // Every owner Storm answer carries removable on every stop; a fresh storm has no check-ins.
  for (const s of stopsOf(storm)) assert.equal(s.removable, true, `${s.name} on the storm start answer`)
  for (const s of stopsOf((await api('GET', '/api/owner/storms/current', { token })).body.storm)) assert.equal(s.removable, true)

  const body = checkin(storm, a, { at: at(30) })
  const plowed = await post(key, body, at(31))
  assert.equal(plowed.status, 201, plowed.text)
  assert.equal(plowed.body.stop.removable, undefined, 'the driver view has no removable')
  assert.equal((await ownerStopOf(a.client_id)).removable, false, 'plowed: not removable')
  assert.equal((await ownerStopOf(b.client_id)).removable, true, 'the stop next to it still is')

  const undone = await api('DELETE', `/api/driver/checkins/${body.id}`, { key, now: at(35) })
  assert.equal(undone.status, 200, undone.text)
  assert.equal(undone.body.stop.removable, undefined)
  const afterUndo = await ownerStopOf(a.client_id)
  assert.equal(afterUndo.status, 'pending')
  assert.equal(afterUndo.checkin, null)
  assert.equal(afterUndo.removable, false, 'undone: an undone check-in is still a record, so not removable')
  const refused = await api('DELETE', `/api/owner/storms/${storm.id}/stops/${a.client_id}`, { token })
  expectError(refused, 409, 'bad_state')
  assert.equal(refused.body.error, 'This stop has check-ins, so it stays on the route.')

  // A skip makes it false too.
  const skip = await post(key, checkin(storm, b, { kind: 'skipped', reason: 'gate', at: at(40) }), at(41))
  assert.equal(skip.status, 201)
  assert.equal((await ownerStopOf(b.client_id)).removable, false)

  // Carried on the route PUT, stop add, stop remove and end answers.
  let current = (await api('GET', `/api/owner/storms/${storm.id}`, { token })).body
  const put = await putRouteAs(token, storm.id, reversedFirst(listsOf(current)), current.route_version)
  assert.equal(put.status, 200, put.text)
  const flags = view => Object.fromEntries(stopsOf(view).map(s => [s.client_id, s.removable]))
  assert.equal(flags(put.body)[a.client_id], false)
  const added = await api('POST', `/api/owner/storms/${storm.id}/stops`, { token, body: { client_id: spare.id, truck_id: truck.id } })
  assert.equal(added.status, 200, added.text)
  assert.equal(flags(added.body)[spare.id], true)
  assert.equal(flags(added.body)[a.client_id], false)
  const removed = await api('DELETE', `/api/owner/storms/${storm.id}/stops/${spare.id}`, { token })
  assert.equal(removed.status, 200, removed.text)
  assert.ok(stopsOf(removed.body).every(s => typeof s.removable === 'boolean'))
  const ended = await api('POST', `/api/owner/storms/${storm.id}/end`, { token })
  assert.equal(ended.status, 200, ended.text)
  assert.equal(flags(ended.body.storm)[a.client_id], false)
  assert.ok(stopsOf(ended.body.storm).every(s => typeof s.removable === 'boolean'))
  // Summaries and the status page are not stop views for the owner's edit screen.
  const summary = await api('GET', `/api/owner/storms/${storm.id}/summary`, { token })
  assert.ok(!summary.text.includes('removable'))
})

// ================================================================ M8

test('undo flag: a new id is stored already voided: 201 voided, the stop stays pending, no push billed, no status last, removable false', async () => {
  const { seed, token, storm, keyOf } = await stormSetup()
  const truck = storm.trucks[0]
  const stop = truck.stops[0]
  const client = seed.clients.find(c => c.id === stop.client_id)
  const body = { ...checkin(storm, stop, { at: at(30) }), undo: true }
  const r = await post(keyOf(truck.id), body, at(31))
  assert.equal(r.status, 201, r.text)
  assert.equal(r.body.duplicate, undefined)
  assert.equal(r.body.checkin.id, body.id)
  assert.equal(r.body.checkin.voided, true, 'stored already voided')
  assert.equal(r.body.stop.status, 'pending', 'a voided row never decides the stop')
  assert.equal(r.body.stop.checkin, null)

  const rows = await storedRows(storm.id, stop.client_id)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].voided_at, at(31), 'voided in the same statement')
  assert.equal(rows[0].voided_at, rows[0].received_at)

  const owner = await ownerStop(token, storm.id, stop.client_id)
  assert.equal(owner.status, 'pending')
  assert.equal(owner.removable, false, 'a check-in row exists')
  assert.deepEqual((await api('GET', `/api/owner/storms/${storm.id}`, { token })).body.counts, { stops: 25, plowed: 0, skipped: 0, pending: 25 })
  const bill = await billing(token, JAN)
  assert.equal(rowOf(bill, stop.client_id)?.pushes ?? 0, 0, 'never bills')
  assert.equal(bill.totals.pushes, 0)
  assert.deepEqual((await api('GET', '/api/owner/billing/months', { token })).body, { months: [] })
  const status = await api('GET', `/api/status/${client.status_key}`, { now: at(40) })
  assert.equal(status.body.last, null, 'the status link has no last for it')
  assert.equal(status.body.tonight.state, 'waiting')
  assert.equal((await ownerClient(token, stop.client_id)).last_plowed_at, null)
  // Resending the same undo is a duplicate, and a DELETE of the voided row is 200 as is.
  const again = await post(keyOf(truck.id), body, at(33))
  assert.equal(again.status, 200)
  assert.equal(again.body.duplicate, true)
  assert.equal(again.body.checkin.voided, true)
  assert.equal((await api('DELETE', `/api/driver/checkins/${body.id}`, { key: keyOf(truck.id), now: at(34) })).status, 200)
})

test('undo flag: an id already stored answers 200 duplicate, not voided; a DELETE then voids it', async () => {
  const { token, storm, keyOf } = await stormSetup()
  const truck = storm.trucks[0]
  const key = keyOf(truck.id)
  const stop = truck.stops[0]
  const body = checkin(storm, stop, { at: at(30) })
  assert.equal((await post(key, body, at(31))).status, 201)
  const resent = await post(key, { ...body, undo: true }, at(35))
  assert.equal(resent.status, 200, resent.text)
  assert.equal(resent.body.duplicate, true)
  assert.equal(resent.body.checkin.voided, false, 'nothing changes for a stored id')
  assert.equal(resent.body.stop.status, 'plowed')
  assert.equal((await storedRows(storm.id, stop.client_id))[0].voided_at, null)
  assert.equal(rowOf(await billing(token, JAN), stop.client_id)?.pushes ?? 0, 1, 'still a push until the DELETE')
  const undone = await api('DELETE', `/api/driver/checkins/${body.id}`, { key, now: at(36) })
  assert.equal(undone.status, 200, undone.text)
  assert.equal(undone.body.checkin.voided, true)
  assert.equal((await ownerStop(token, storm.id, stop.client_id)).status, 'pending')
  assert.equal(rowOf(await billing(token, JAN), stop.client_id)?.pushes ?? 0, 0)
})

test('undo flag: undo true on a skip for a plowed stop answers 201 voided and the stop stays plowed', async () => {
  const { token, storm, keyOf } = await stormSetup()
  const truck = storm.trucks[0]
  const key = keyOf(truck.id)
  const stop = truck.stops[0]
  const plowed = checkin(storm, stop, { at: at(30) })
  assert.equal((await post(key, plowed, at(31))).status, 201)
  // Without undo that skip is refused (the skip-after-plowed guard) ...
  expectError(await post(key, checkin(storm, stop, { kind: 'skipped', reason: 'gate', at: at(32) }), at(33)), 409, 'already_plowed')
  // ... with undo it is stored voided, and the plowed check-in still decides the stop.
  const skip = await post(key, { ...checkin(storm, stop, { kind: 'skipped', reason: 'gate', at: at(32) }), undo: true }, at(33))
  assert.equal(skip.status, 201, skip.text)
  assert.equal(skip.body.checkin.voided, true)
  assert.equal(skip.body.checkin.kind, 'skipped')
  assert.equal(skip.body.stop.status, 'plowed')
  assert.equal(skip.body.stop.checkin.id, plowed.id)
  const rows = await storedRows(storm.id, stop.client_id)
  assert.equal(rows.length, 2)
  assert.equal(rows.filter(k => k.voided_at === null).length, 1, 'only the plowed row is live')
  assert.equal(rowOf(await billing(token, JAN), stop.client_id).pushes, 1)
  // A plowed undo for a stop another check-in already plowed is also stored voided (never a second live plowed row).
  const second = await post(key, { ...checkin(storm, stop, { at: at(34) }), undo: true }, at(35))
  assert.equal(second.status, 201, second.text)
  assert.equal(second.body.checkin.voided, true)
  assert.equal(rowOf(await billing(token, JAN), stop.client_id).pushes, 1)
})

test('undo flag: undo "yes" answers 400 field undo; undo false is a normal check-in; undo true for a client removed from the route answers 404', async () => {
  const { token, storm, keyOf } = await stormSetup()
  const truck = storm.trucks[0]
  const key = keyOf(truck.id)
  const [a, b, c] = truck.stops
  for (const undo of ['yes', 1, null]) {
    const r = await post(key, { ...checkin(storm, a), undo })
    expectError(r, 400, 'bad_request', 'undo')
    assert.equal(r.body.error, 'The undo flag could not be read.')
  }
  assert.equal((await storedRows(storm.id, a.client_id)).length, 0)

  const normal = await post(key, { ...checkin(storm, b), undo: false })
  assert.equal(normal.status, 201, normal.text)
  assert.equal(normal.body.checkin.voided, false)
  assert.equal(normal.body.stop.status, 'plowed')

  const removed = await api('DELETE', `/api/owner/storms/${storm.id}/stops/${c.client_id}`, { token })
  assert.equal(removed.status, 200, removed.text)
  expectError(await post(key, { ...checkin(storm, c), undo: true }), 404, 'not_found')
  assert.equal((await storedRows(storm.id, c.client_id)).length, 0, 'the stop guard still applies to an undo')
})
