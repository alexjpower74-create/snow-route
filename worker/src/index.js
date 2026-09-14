// Snow Route Worker: the API in docs/API.md. Static files in ../app/public are served by [assets]; only /api/* reaches here.

import { now as clockNow, isTestMode } from './clock.js'
import { buildRoute } from './route.js'
import { timeLabel, dateLabel, fullLabel } from './time.js'
import { randomKey, sha256Hex, verifyPin, isUuidV4 } from './auth.js'
import { seedSample } from './sample.js'

const HST_RATE = 0.15
const SESSION_DAYS = 30
const PHOTO_MAX_BYTES = 5000000
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const TIME_WINDOW_MS = 10 * 60000 // a check-in's own time is kept inside [storm start - 10 min, server now + 10 min]
const ORDER_NOTE = 'Order is by distance, not road time.'

const TYPE_LABELS = { driveway: 'Driveway', lot: 'Parking lot', walkway: 'Walkway' }
const PRIORITY_LABELS = { medical: 'Medical', commuter: 'Early commuter', business: 'Business opening', none: 'None' }
const BILLING_LABELS = { per_push: 'Per push', seasonal: 'Seasonal contract' }
const REASON_LABELS = { car: 'Car in the way', gate: 'Gate locked', cancelled: 'Client cancelled', other: 'Other' }

// ---- responses ----

class HttpError extends Error {
  constructor (status, code, error, extra = {}) {
    super(error)
    this.status = status
    this.body = { error, code, ...extra }
  }
}

const BASE_HEADERS = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }

function json (status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...BASE_HEADERS } })
}

const badRequest = (field, error) => new HttpError(400, 'bad_request', error, field ? { field } : {})
const notFound = error => new HttpError(404, 'not_found', error)
const badState = error => new HttpError(409, 'bad_state', error)
const unauthorized = (error, field) => new HttpError(401, 'unauthorized', error, field ? { field } : {})

async function readJson (request) {
  const text = await request.text()
  if (!text.trim()) return {}
  try {
    const body = JSON.parse(text)
    if (body && typeof body === 'object' && !Array.isArray(body)) return body
  } catch {}
  throw badRequest(null, 'That request could not be read. Please try again.')
}

const iso = ms => new Date(ms).toISOString()
const errorText = e => String(e?.message || e) + String(e?.cause?.message || '')
const isUniqueViolation = e => /UNIQUE constraint failed/i.test(errorText(e))
// json() of a non-JSON string raises "malformed JSON" and rolls the whole batch back: in-transaction guards use it.
const isGuardRefusal = e => /malformed JSON/i.test(errorText(e))
const chars = s => [...s].length

// ---- company ----

async function loadCompany (db) {
  const row = await db.prepare('SELECT * FROM company WHERE id = 1').first()
  if (!row) throw new HttpError(500, 'server_error', 'The company is not set up yet.')
  return row
}

function companyView (row) {
  return {
    name: row.name,
    sample: row.name.includes('SAMPLE'),
    timezone: row.timezone,
    hst_rate: HST_RATE,
    yard: { label: row.yard_label, lat: row.yard_lat, lng: row.yard_lng }
  }
}

// ---- views ----

const statusUrl = (origin, key) => `${origin}/s/?k=${key}`
const driverUrl = (origin, key) => `${origin}/d/?k=${key}`
const photoUrl = (origin, token) => `${origin}/api/photos/${token}`

function clientView (row, origin) {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    lat: row.lat,
    lng: row.lng,
    type: row.type,
    type_label: TYPE_LABELS[row.type],
    priority: row.priority,
    priority_label: PRIORITY_LABELS[row.priority],
    opens_at: row.opens_at,
    notes: row.notes,
    billing: row.billing,
    price_cents: row.price_cents,
    truck_id: row.truck_id,
    active: !!row.active,
    status_url: statusUrl(origin, row.status_key),
    last_plowed_at: row.last_plowed_at || null,
    last_plowed_label: row.last_plowed_at ? fullLabel(row.last_plowed_at) : null
  }
}

const truckView = (row, origin) => ({ id: row.id, name: row.name, active: !!row.active, driver_url: driverUrl(origin, row.driver_key) })

function reasonText (row) {
  if (row.kind !== 'skipped' || !row.reason) return null
  const label = REASON_LABELS[row.reason]
  if (row.reason === 'other' && row.note) return `Other: ${row.note}`
  return label
}

const CHECKIN_SELECT = `SELECT ck.id, ck.storm_id, ck.client_id, ck.truck_id, ck.kind, ck.reason, ck.note, ck.at, ck.at_adjusted,
  ck.received_at, ck.has_photo, ck.voided_at, p.token AS photo_token FROM checkins ck LEFT JOIN photos p ON p.checkin_id = ck.id`

function checkinView (row, origin) {
  return {
    id: row.id,
    storm_id: row.storm_id,
    client_id: row.client_id,
    truck_id: row.truck_id,
    kind: row.kind,
    reason: row.kind === 'skipped' ? row.reason : null,
    reason_text: reasonText(row),
    note: row.note,
    at: row.at,
    at_label: timeLabel(row.at),
    at_adjusted: !!row.at_adjusted,
    received_at: row.received_at,
    photo: row.photo_token ? 'stored' : row.has_photo ? 'waiting' : 'none',
    photo_url: row.photo_token ? photoUrl(origin, row.photo_token) : null,
    voided: !!row.voided_at
  }
}

const lowerFirst = s => s.charAt(0).toLowerCase() + s.slice(1)

function stopMessages (stop, row, ctx) {
  const name = row.name
  const url = statusUrl(ctx.origin, row.status_key)
  const type = TYPE_LABELS[row.type].toLowerCase()
  const out = [{
    kind: 'status_link',
    label: 'Copy status link text',
    text: `Hi ${name}, this is ${ctx.company.name}. You can check when your ${type} was last cleared here: ${url}`
  }]
  if (stop.status === 'pending' && ctx.stormActive) {
    out.push({
      kind: 'on_route',
      label: 'Copy "on the route" text',
      text: `Hi ${name}, we're out clearing snow tonight. You're stop ${stop.position} on the route. This link shows the time and a photo once it's done: ${url}`
    })
  }
  if (stop.status === 'plowed') {
    out.push({ kind: 'plowed', label: 'Copy "done" text', text: `Hi ${name}, your ${type} was cleared at ${stop.checkin.at_label}. See it here: ${url}` })
  }
  if (stop.status === 'skipped') {
    out.push({
      kind: 'skipped',
      label: 'Copy "skipped" text',
      text: `Hi ${name}, we couldn't clear your ${type} tonight: ${lowerFirst(stop.checkin.reason_text)}. We'll be in touch about it.`
    })
  }
  return out
}

/** A stop from its storm_stops+clients row and the non-voided check-ins for it (oldest first). */
function stopView (row, checkins, ctx) {
  const plowed = checkins.find(k => k.kind === 'plowed')
  const skipped = checkins.filter(k => k.kind === 'skipped').at(-1)
  const decider = plowed || skipped || null
  const stop = {
    client_id: row.client_id,
    truck_id: row.truck_id,
    position: row.position,
    name: row.name,
    address: row.address,
    lat: row.lat,
    lng: row.lng,
    type: row.type,
    type_label: TYPE_LABELS[row.type],
    priority: row.priority,
    priority_label: PRIORITY_LABELS[row.priority],
    opens_at: row.opens_at,
    notes: row.notes,
    status: plowed ? 'plowed' : skipped ? 'skipped' : 'pending',
    checkin: decider ? checkinView(decider, ctx.origin) : null
  }
  if (ctx.owner) stop.messages = stopMessages(stop, row, ctx)
  return stop
}

/** Everything about one storm, read in one batch. */
async function loadStorm (db, stormId) {
  const [storms, trucks, stops, checkins] = await db.batch([
    db.prepare('SELECT * FROM storms WHERE id = ?1').bind(stormId),
    db.prepare('SELECT t.id, t.name FROM storm_trucks st JOIN trucks t ON t.id = st.truck_id WHERE st.storm_id = ?1 ORDER BY t.id').bind(stormId),
    db.prepare(`SELECT ss.client_id, ss.truck_id, ss.position, c.name, c.address, c.lat, c.lng, c.type, c.priority, c.opens_at, c.notes,
      c.status_key FROM storm_stops ss JOIN clients c ON c.id = ss.client_id WHERE ss.storm_id = ?1 ORDER BY ss.truck_id, ss.position`).bind(stormId),
    db.prepare(`${CHECKIN_SELECT} WHERE ck.storm_id = ?1 AND ck.voided_at IS NULL ORDER BY ck.at, ck.received_at, ck.id`).bind(stormId)
  ])
  const storm = storms.results[0]
  if (!storm) return null
  const byClient = new Map()
  for (const k of checkins.results) {
    if (!byClient.has(k.client_id)) byClient.set(k.client_id, [])
    byClient.get(k.client_id).push(k)
  }
  return { storm, trucks: trucks.results, stopRows: stops.results, checkinsFor: id => byClient.get(id) || [] }
}

function stormView (data, ctx) {
  const { storm } = data
  const stormCtx = { ...ctx, stormActive: !storm.ended_at }
  const stops = data.stopRows.map(r => stopView(r, data.checkinsFor(r.client_id), stormCtx))
  const counts = { stops: stops.length, plowed: 0, skipped: 0, pending: 0 }
  for (const s of stops) counts[s.status]++
  return {
    id: storm.id,
    name: storm.name,
    status: storm.ended_at ? 'ended' : 'active',
    started_at: storm.started_at,
    started_label: fullLabel(storm.started_at),
    ended_at: storm.ended_at,
    ended_label: storm.ended_at ? fullLabel(storm.ended_at) : null,
    order_note: ORDER_NOTE,
    counts,
    trucks: data.trucks.map(t => ({ id: t.id, name: t.name, stops: stops.filter(s => s.truck_id === t.id) }))
  }
}

// ---- auth ----

async function requireOwner (request, env, ctx) {
  const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get('Authorization') || '')
  if (m) {
    const session = await env.DB.prepare('SELECT token_hash FROM sessions WHERE token_hash = ?1 AND expires_at > ?2')
      .bind(await sha256Hex(m[1]), iso(ctx.now)).first()
    if (session) return session.token_hash
  }
  throw unauthorized('Please sign in again.')
}

async function requireDriver (request, env) {
  const key = request.headers.get('X-Driver-Key')
  const truck = key ? await env.DB.prepare('SELECT * FROM trucks WHERE driver_key = ?1').bind(key).first() : null
  if (!truck) throw unauthorized("This driver link doesn't work any more. Ask the owner for a new one.")
  return truck
}

// ---- owner: sign-in ----

async function signin (request, env, ctx) {
  const body = await readJson(request)
  const company = await loadCompany(env.DB)
  if (!(await verifyPin(typeof body.pin === 'string' ? body.pin : '', company.pin))) {
    throw unauthorized('That PIN is not right.', 'pin')
  }
  const token = randomKey(32)
  const expires = iso(ctx.now + SESSION_DAYS * 86400000)
  await env.DB.prepare('INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?1, ?2, ?3)')
    .bind(await sha256Hex(token), iso(ctx.now), expires).run()
  return json(200, { token, expires_at: expires })
}

async function signout (request, env, ctx) {
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(ctx.session).run()
  return new Response(null, { status: 204, headers: BASE_HEADERS })
}

// ---- owner: clients ----

const CLIENT_SELECT = `SELECT c.*, (SELECT MAX(k.at) FROM checkins k WHERE k.client_id = c.id AND k.kind = 'plowed' AND k.voided_at IS NULL)
  AS last_plowed_at FROM clients c`

async function clientInput (db, body, { post }) {
  const out = {}
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) throw badRequest('name', 'Give the client a name.')
  if (chars(name) > 80) throw badRequest('name', 'Keep the name under 80 characters.')
  out.name = name
  const address = typeof body.address === 'string' ? body.address.trim() : ''
  if (!address || chars(address) > 160) throw badRequest('address', 'Type the address the driver should look for.')
  out.address = address
  const inNl = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi
  if (!inNl(body.lat, 46.5, 60.5) || !inNl(body.lng, -67.9, -52.5)) throw badRequest('lat', 'Put a pin on the map for this client.')
  out.lat = body.lat
  out.lng = body.lng
  if (!TYPE_LABELS[body.type]) throw badRequest('type', 'Pick a type.')
  if (!PRIORITY_LABELS[body.priority]) throw badRequest('priority', 'Pick a priority.')
  if (!BILLING_LABELS[body.billing]) throw badRequest('billing', 'Pick how this client is billed.')
  Object.assign(out, { type: body.type, priority: body.priority, billing: body.billing })
  const opensAt = post && body.opens_at === undefined ? null : body.opens_at
  if (!(opensAt === null || (typeof opensAt === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(opensAt)))) {
    throw badRequest('opens_at', 'Opening time looks like 7:30 — use the time picker.')
  }
  out.opens_at = opensAt
  const notes = post && body.notes === undefined ? '' : body.notes
  if (typeof notes !== 'string' || chars(notes.trim()) > 300) throw badRequest('notes', 'Keep the notes under 300 characters.')
  out.notes = notes.trim()
  if (!Number.isInteger(body.price_cents) || body.price_cents < 0 || body.price_cents > 10000000) {
    throw badRequest('price_cents', 'Type a price in dollars and cents.')
  }
  out.price_cents = body.price_cents
  if (body.truck_id !== null) {
    const truck = Number.isInteger(body.truck_id) ? await db.prepare('SELECT id FROM trucks WHERE id = ?1').bind(body.truck_id).first() : null
    if (!truck) throw badRequest('truck_id', 'Pick one of your trucks.')
  }
  out.truck_id = body.truck_id
  const active = post && body.active === undefined ? true : body.active
  if (typeof active !== 'boolean') throw badRequest('active', 'Say whether this client is active.')
  out.active = active ? 1 : 0
  return out
}

async function listClients (request, env, ctx) {
  const all = ctx.url.searchParams.get('include_inactive') === '1'
  const { results } = await env.DB.prepare(`${CLIENT_SELECT} ${all ? '' : 'WHERE c.active = 1'} ORDER BY c.active DESC, c.name COLLATE NOCASE, c.id`).all()
  return json(200, { clients: results.map(r => clientView(r, ctx.origin)) })
}

const getClient = (db, id) => db.prepare(`${CLIENT_SELECT} WHERE c.id = ?1`).bind(id).first()

async function createClient (request, env, ctx) {
  const c = await clientInput(env.DB, await readJson(request), { post: true })
  const row = await env.DB.prepare(`INSERT INTO clients (name, address, lat, lng, type, priority, opens_at, notes, billing, price_cents, truck_id, active, status_key)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13) RETURNING id`)
    .bind(c.name, c.address, c.lat, c.lng, c.type, c.priority, c.opens_at, c.notes, c.billing, c.price_cents, c.truck_id, c.active, randomKey()).first()
  return json(201, clientView(await getClient(env.DB, row.id), ctx.origin))
}

async function updateClient (request, env, ctx) {
  const id = Number(ctx.params[0])
  if (!(await getClient(env.DB, id))) throw notFound("We couldn't find that client.")
  const c = await clientInput(env.DB, await readJson(request), { post: false })
  await env.DB.prepare(`UPDATE clients SET name = ?1, address = ?2, lat = ?3, lng = ?4, type = ?5, priority = ?6, opens_at = ?7, notes = ?8,
    billing = ?9, price_cents = ?10, truck_id = ?11, active = ?12 WHERE id = ?13`)
    .bind(c.name, c.address, c.lat, c.lng, c.type, c.priority, c.opens_at, c.notes, c.billing, c.price_cents, c.truck_id, c.active, id).run()
  return json(200, clientView(await getClient(env.DB, id), ctx.origin))
}

// ---- owner: trucks ----

async function listTrucks (request, env, ctx) {
  const { results } = await env.DB.prepare('SELECT * FROM trucks ORDER BY active DESC, name COLLATE NOCASE, id').all()
  return json(200, { trucks: results.map(r => truckView(r, ctx.origin)) })
}

// ---- owner: storms ----

async function ownerStormView (env, ctx, stormId) {
  const data = await loadStorm(env.DB, stormId)
  if (!data) return null
  return stormView(data, { origin: ctx.origin, owner: true, company: await loadCompany(env.DB) })
}

async function currentStorm (request, env, ctx) {
  const active = await env.DB.prepare('SELECT id FROM storms WHERE ended_at IS NULL').first()
  return json(200, { storm: active ? await ownerStormView(env, ctx, active.id) : null })
}

async function getStorm (request, env, ctx) {
  const view = await ownerStormView(env, ctx, Number(ctx.params[0]))
  if (!view) throw notFound("We couldn't find that storm.")
  return json(200, view)
}

const idList = v => Array.isArray(v) && v.length > 0 && v.every(x => Number.isInteger(x) && x > 0) && new Set(v).size === v.length
const ALREADY_ON = 'A storm is already on. End it before starting another.'

async function startStorm (request, env, ctx) {
  const db = env.DB
  const body = await readJson(request)
  if (await db.prepare('SELECT id FROM storms WHERE ended_at IS NULL').first()) throw badState(ALREADY_ON)
  if (!idList(body.client_ids)) throw badRequest('client_ids', 'Tick the clients to clear tonight.')
  if (!idList(body.truck_ids)) throw badRequest('truck_ids', 'Tick the trucks going out tonight.')
  const [clients, trucks] = await db.batch([
    db.prepare(`SELECT id, lat, lng, priority, truck_id FROM clients WHERE active = 1 AND id IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(body.client_ids)),
    db.prepare(`SELECT id FROM trucks WHERE active = 1 AND id IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(body.truck_ids))
  ])
  if (clients.results.length !== body.client_ids.length) throw badRequest('client_ids', 'One of those clients is not on your active list.')
  if (trucks.results.length !== body.truck_ids.length) throw badRequest('truck_ids', 'One of those trucks is not on your active list.')

  const company = await loadCompany(db)
  const yard = { lat: company.yard_lat, lng: company.yard_lng }
  const route = buildRoute(yard, clients.results.map(c => ({ client_id: c.id, lat: c.lat, lng: c.lng, priority: c.priority, truck_id: c.truck_id })), body.truck_ids)
  const startedAt = iso(ctx.now)
  const ACTIVE = '(SELECT id FROM storms WHERE ended_at IS NULL)'
  const stmts = [db.prepare('INSERT INTO storms (name, started_at) VALUES (?1, ?2)').bind(`Storm of ${dateLabel(startedAt)}`, startedAt)]
  for (const t of route) {
    stmts.push(db.prepare(`INSERT INTO storm_trucks (storm_id, truck_id) VALUES (${ACTIVE}, ?1)`).bind(t.truck_id))
    t.stops.forEach((s, i) => stmts.push(db.prepare(`INSERT INTO storm_stops (storm_id, client_id, truck_id, position) VALUES (${ACTIVE}, ?1, ?2, ?3)`)
      .bind(s.client_id, t.truck_id, i + 1)))
  }
  try {
    await db.batch(stmts)
  } catch (e) {
    if (isUniqueViolation(e)) throw badState(ALREADY_ON) // storms_one_active: another start won
    throw e
  }
  const active = await db.prepare('SELECT id FROM storms WHERE ended_at IS NULL').first()
  return json(201, await ownerStormView(env, ctx, active.id))
}

// ---- driver ----

async function driverRoute (request, env, ctx) {
  const truck = await requireDriver(request, env)
  const company = await loadCompany(env.DB)
  const active = await env.DB.prepare(`SELECT s.id FROM storms s JOIN storm_trucks st ON st.storm_id = s.id
    WHERE s.ended_at IS NULL AND st.truck_id = ?1`).bind(truck.id).first()
  const data = active ? await loadStorm(env.DB, active.id) : null
  const view = data ? stormView(data, { origin: ctx.origin, owner: false }) : null
  return json(200, {
    company: { name: company.name, sample: company.name.includes('SAMPLE'), timezone: company.timezone },
    truck: { id: truck.id, name: truck.name },
    storm: view ? { id: view.id, name: view.name, status: view.status, started_at: view.started_at } : null,
    stops: view ? view.trucks.find(t => t.id === truck.id).stops : [],
    server_now: iso(ctx.now)
  })
}

async function driverStop (env, ctx, stormId, clientId) {
  const data = await loadStorm(env.DB, stormId)
  const row = data.stopRows.find(r => r.client_id === clientId)
  return stopView(row, data.checkinsFor(clientId), { origin: ctx.origin, owner: false })
}

const getCheckin = (db, id) => db.prepare(`${CHECKIN_SELECT} WHERE ck.id = ?1`).bind(id).first()

// Refuses a skip inside the batch when the stop already has a plowed check-in (API.md: checked inside the same DB.batch()).
const SKIP_GUARD_SQL = `SELECT json(CASE WHEN EXISTS (SELECT 1 FROM checkins WHERE storm_id = ?1 AND client_id = ?2 AND kind = 'plowed'
  AND voided_at IS NULL AND id <> ?3) THEN 'already plowed' ELSE '0' END)`

function checkinInput (body) {
  if (body.kind !== 'plowed' && body.kind !== 'skipped') throw badRequest('kind', 'A check-in is either plowed or skipped.')
  if (body.kind === 'skipped' && !REASON_LABELS[body.reason]) throw badRequest('reason', "Pick why you're skipping.")
  const note = body.note === undefined || body.note === null ? '' : body.note
  if (typeof note !== 'string' || chars(note) > 120) throw badRequest('note', 'Keep the note under 120 characters.')
  const at = typeof body.at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(body.at) ? Date.parse(body.at) : NaN
  if (!Number.isFinite(at)) throw badRequest('at', 'The check-in time could not be read.')
  if (typeof body.has_photo !== 'boolean') throw badRequest('has_photo', 'The photo flag could not be read.')
  return { kind: body.kind, reason: body.kind === 'skipped' ? body.reason : null, note: note.trim(), at, has_photo: body.has_photo }
}

async function duplicateAnswer (env, ctx, stored) {
  return json(200, { checkin: checkinView(stored, ctx.origin), stop: await driverStop(env, ctx, stored.storm_id, stored.client_id), duplicate: true })
}

async function postCheckin (request, env, ctx) {
  const db = env.DB
  const truck = await requireDriver(request, env)
  const body = await readJson(request)
  if (!isUuidV4(body.id)) throw badRequest('id', 'This check-in has no proper id. Reload the driver page and try again.')
  const id = body.id.toLowerCase()

  let input, storm
  try {
    input = checkinInput(body)
    storm = Number.isInteger(body.storm_id) ? await db.prepare('SELECT * FROM storms WHERE id = ?1').bind(body.storm_id).first() : null
    if (!storm) throw notFound("We couldn't find that storm.")
    const stop = Number.isInteger(body.client_id)
      ? await db.prepare('SELECT 1 FROM storm_stops WHERE storm_id = ?1 AND client_id = ?2').bind(storm.id, body.client_id).first()
      : null
    if (!stop) throw notFound('That client is not a stop in this storm.')
  } catch (e) {
    // A resend is answered as a duplicate whatever its body says; this lookup runs only when the body would be refused.
    const stored = e instanceof HttpError && await getCheckin(db, id)
    if (stored) return duplicateAnswer(env, ctx, stored)
    throw e
  }

  // TIME-RULE: the driver's own time is kept inside the window; outside it the server's now is used and flagged.
  const inWindow = input.at >= Date.parse(storm.started_at) - TIME_WINDOW_MS && input.at <= ctx.now + TIME_WINDOW_MS
  const at = inWindow ? iso(input.at) : iso(ctx.now)
  const atAdjusted = inWindow ? 0 : 1

  const stmts = []
  if (input.kind === 'skipped') stmts.push(db.prepare(SKIP_GUARD_SQL).bind(storm.id, body.client_id, id))
  stmts.push(db.prepare('INSERT INTO checkins (id, storm_id, client_id, truck_id, kind, reason, note, at, at_adjusted, received_at, has_photo) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) ON CONFLICT(id) DO NOTHING')
    .bind(id, storm.id, body.client_id, truck.id, input.kind, input.reason, input.note, at, atAdjusted, iso(ctx.now), input.has_photo ? 1 : 0))
  let inserted
  try {
    const results = await db.batch(stmts)
    inserted = results[results.length - 1].meta.changes === 1
  } catch (e) {
    if (!isUniqueViolation(e) && !isGuardRefusal(e)) throw e
    const stored = await getCheckin(db, id)
    if (stored) return duplicateAnswer(env, ctx, stored)
    const plowed = await db.prepare(`${CHECKIN_SELECT} WHERE ck.storm_id = ?1 AND ck.client_id = ?2 AND ck.kind = 'plowed' AND ck.voided_at IS NULL`)
      .bind(storm.id, body.client_id).first()
    throw new HttpError(409, 'already_plowed', 'This stop is already marked plowed.', { checkin: plowed ? checkinView(plowed, ctx.origin) : null })
  }
  const stored = await getCheckin(db, id)
  if (!inserted) return duplicateAnswer(env, ctx, stored)
  return json(201, { checkin: checkinView(stored, ctx.origin), stop: await driverStop(env, ctx, stored.storm_id, stored.client_id) })
}

async function putPhoto (request, env, ctx) {
  const db = env.DB
  const truck = await requireDriver(request, env)
  const id = ctx.params[0].toLowerCase()
  const checkin = await db.prepare('SELECT id FROM checkins WHERE id = ?1 AND truck_id = ?2').bind(id, truck.id).first()
  if (!checkin) throw notFound("We couldn't find that check-in.")
  const type = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase()
  if (!PHOTO_TYPES.includes(type)) throw new HttpError(415, 'unsupported_photo', 'The photo has to be a JPEG, PNG or WebP picture.')
  const tooLarge = () => new HttpError(413, 'too_large', 'That photo is too big. It has to be under 5 MB.')
  if (Number(request.headers.get('Content-Length') || 0) > PHOTO_MAX_BYTES) throw tooLarge()
  const bytes = await request.arrayBuffer()
  if (bytes.byteLength > PHOTO_MAX_BYTES) throw tooLarge()
  await env.PHOTOS.put(`checkins/${id}`, bytes, { httpMetadata: { contentType: type } })
  const token = randomKey(16)
  await db.batch([
    db.prepare(`INSERT INTO photos (checkin_id, token, content_type, size, stored_at) VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(checkin_id) DO UPDATE SET token = excluded.token, content_type = excluded.content_type, size = excluded.size, stored_at = excluded.stored_at`)
      .bind(id, token, type, bytes.byteLength, iso(ctx.now)),
    db.prepare('UPDATE checkins SET has_photo = 1 WHERE id = ?1').bind(id)
  ])
  return json(200, { checkin: checkinView(await getCheckin(db, id), ctx.origin) })
}

// ---- photos and status ----

async function getPhoto (request, env, ctx) {
  const row = await env.DB.prepare(`SELECT p.checkin_id, p.content_type FROM photos p JOIN checkins ck ON ck.id = p.checkin_id
    WHERE p.token = ?1 AND ck.voided_at IS NULL`).bind(ctx.params[0]).first()
  const object = row ? await env.PHOTOS.get(`checkins/${row.checkin_id}`) : null
  if (!object) throw notFound("We couldn't find that photo.")
  const headers = {
    'content-type': row.content_type,
    'cache-control': 'private, max-age=86400',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff'
  }
  if (row.content_type === 'image/svg+xml') headers['content-security-policy'] = "default-src 'none'; style-src 'unsafe-inline'"
  return new Response(object.body, { status: 200, headers })
}

async function clientStatus (request, env, ctx) {
  const db = env.DB
  const client = await db.prepare('SELECT * FROM clients WHERE status_key = ?1').bind(ctx.params[0]).first()
  if (!client) throw notFound("This status link doesn't work. Ask your snow clearing company for a new one.")
  const company = await loadCompany(db)
  const last = await db.prepare(`${CHECKIN_SELECT} WHERE ck.client_id = ?1 AND ck.kind = 'plowed' AND ck.voided_at IS NULL ORDER BY ck.at DESC LIMIT 1`)
    .bind(client.id).first()
  let tonight = null
  const active = await db.prepare(`SELECT s.id FROM storms s JOIN storm_stops ss ON ss.storm_id = s.id WHERE s.ended_at IS NULL AND ss.client_id = ?1`)
    .bind(client.id).first()
  if (active) {
    const data = await loadStorm(db, active.id)
    const view = stormView(data, { origin: ctx.origin, owner: false })
    const mine = view.trucks.flatMap(t => t.stops).find(s => s.client_id === client.id)
    const truckStops = view.trucks.find(t => t.id === mine.truck_id).stops
    tonight = {
      storm_name: view.name,
      state: mine.status === 'pending' ? 'waiting' : mine.status,
      stop_number: mine.position,
      stops_on_route: truckStops.length,
      stops_done: truckStops.filter(s => s.status !== 'pending').length,
      reason_text: mine.status === 'skipped' ? mine.checkin.reason_text : null
    }
  }
  return json(200, {
    company: { name: company.name, sample: company.name.includes('SAMPLE') },
    client: { name: client.name, address: client.address, type: client.type, type_label: TYPE_LABELS[client.type] },
    last: last
      ? {
          at: last.at,
          at_label: fullLabel(last.at),
          time_label: timeLabel(last.at),
          photo_url: last.photo_token ? photoUrl(ctx.origin, last.photo_token) : null,
          photo_waiting: !last.photo_token && !!last.has_photo
        }
      : null,
    tonight,
    server_now: iso(ctx.now)
  })
}

// ---- test routes (TEST_MODE=1 only) ----

async function testReset (request, env, ctx) {
  return json(200, await seedSample(env, ctx.origin))
}

/** Ends a storm directly in D1 (the owner's End storm route is M2). Body { at? }; default now. */
async function testEndStorm (request, env, ctx) {
  const body = await readJson(request)
  const at = typeof body.at === 'string' && Number.isFinite(Date.parse(body.at)) ? iso(Date.parse(body.at)) : iso(ctx.now)
  const r = await env.DB.prepare('UPDATE storms SET ended_at = ?1 WHERE id = ?2 AND ended_at IS NULL').bind(at, Number(ctx.params[0])).run()
  if (!r.meta.changes) throw notFound('No active storm with that id.')
  return json(200, { ended_at: at })
}

/** Raw check-in rows (voided ones too), so tests can count what the database really holds. */
async function testCheckins (request, env, ctx) {
  const { results } = await env.DB.prepare('SELECT * FROM checkins WHERE storm_id = ?1 ORDER BY received_at, id')
    .bind(Number(ctx.url.searchParams.get('storm_id'))).all()
  return json(200, { checkins: results })
}

// ---- router ----

const ROUTES = [
  ['GET', /^\/api\/company$/, 'public', async (req, env) => json(200, companyView(await loadCompany(env.DB)))],
  ['POST', /^\/api\/owner\/signin$/, 'public', signin],
  ['POST', /^\/api\/owner\/signout$/, 'owner', signout],
  ['GET', /^\/api\/owner\/clients$/, 'owner', listClients],
  ['POST', /^\/api\/owner\/clients$/, 'owner', createClient],
  ['PUT', /^\/api\/owner\/clients\/(\d+)$/, 'owner', updateClient],
  ['GET', /^\/api\/owner\/trucks$/, 'owner', listTrucks],
  ['GET', /^\/api\/owner\/storms\/current$/, 'owner', currentStorm],
  ['POST', /^\/api\/owner\/storms$/, 'owner', startStorm],
  ['GET', /^\/api\/owner\/storms\/(\d+)$/, 'owner', getStorm],
  ['GET', /^\/api\/driver\/route$/, 'public', driverRoute],
  ['POST', /^\/api\/driver\/checkins$/, 'public', postCheckin],
  ['PUT', /^\/api\/driver\/checkins\/([0-9A-Fa-f-]{36})\/photo$/, 'public', putPhoto],
  ['GET', /^\/api\/photos\/([A-Za-z0-9_-]{16,64})$/, 'public', getPhoto],
  ['GET', /^\/api\/status\/([A-Za-z0-9_-]{1,128})$/, 'public', clientStatus],
  ['POST', /^\/api\/test\/reset$/, 'test', testReset],
  ['POST', /^\/api\/test\/storms\/(\d+)\/end$/, 'test', testEndStorm],
  ['GET', /^\/api\/test\/checkins$/, 'test', testCheckins]
]

async function handle (request, env) {
  const url = new URL(request.url)
  for (const [method, re, access, handler] of ROUTES) {
    const m = re.exec(url.pathname)
    if (!m || method !== request.method) continue
    if (access === 'test' && !isTestMode(env)) break
    const ctx = { url, origin: url.origin, params: m.slice(1), now: clockNow(request, env) }
    if (access === 'owner') ctx.session = await requireOwner(request, env, ctx)
    return await handler(request, env, ctx)
  }
  throw notFound("There's nothing here.")
}

export default {
  async fetch (request, env) {
    try {
      return await handle(request, env)
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, e.body)
      console.error(e)
      return json(500, { error: 'Something went wrong on our side. Please try again.', code: 'server_error' })
    }
  }
}
