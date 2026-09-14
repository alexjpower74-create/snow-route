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
    assert.deepEqual(r.body.stops, truck.stops.map(({ messages, ...s }) => s))
    assert.ok(r.body.stops.every(s => s.truck_id === truck.id))
    for (const word of ['messages', 'price', 'billing', 'status_url', 'k=']) assert.ok(!r.text.includes(word), `driver route contains ${word}`)
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
    note: 'Done.', at: at(30), at_label: '5:05 AM', at_adjusted: false, received_at: at(33), photo: 'none', photo_url: null, voided: false
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
  expectError(await post(key, checkin(storm, stop, { note: 'x'.repeat(121) })), 400, 'bad_request', 'note')
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
