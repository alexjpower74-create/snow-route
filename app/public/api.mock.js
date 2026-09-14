// In-browser stand-in for the Worker, for development only (open a page with ?mock=1). Same shapes, codes and error
// texts as docs/API.md for the routes the M1 pages use: company, driver route / check-ins / photo / undo, client status.
// State lives in localStorage so a reload (online or offline) keeps it; ?reset=1 starts over. The clock is the browser's.
// Playwright specs never use this: they run against the real Worker.
//
// Demo links (keys are 16+ characters, like real ones):
//   driver  /d/?mock=1&k=demo-truck-1-sample   /d/?mock=1&k=demo-truck-2-sample   /d/?mock=1&k=demo-truck-3-sample (not in the storm)
//   status  /s/?mock=1&k=demo-status-sample-01 (plowed, photo)   /s/?mock=1&k=demo-status-sample-04 (waiting)
// Route order here is simpler than sr1's (tiers, then nearest neighbour, no 2-opt): it only has to look like a route.

import { COMPANY, TRUCKS, CLIENTS } from '/mock-data.js'
import { timeLabel, fullLabel, dateLabel, NL_ZONE } from '/ui.js'

const STORE_KEY = 'snow-route:mock-store'
const MIN = 60000
const DRIVER_KEYS = { 'demo-truck-1-sample': 1, 'demo-truck-2-sample': 2, 'demo-truck-3-sample': 3 }
const ALL_TRUCKS = [...TRUCKS, { id: 3, name: 'Truck 3 (SAMPLE)' }]
const TYPE = { driveway: 'Driveway', lot: 'Parking lot', walkway: 'Walkway' }
const PRIORITY = { medical: 'Medical', commuter: 'Early commuter', business: 'Business opening', none: 'None' }
const REASON = { car: 'Car in the way', gate: 'Gate locked', cancelled: 'Client cancelled', other: 'Other' }
const TIER = { medical: 0, commuter: 1, business: 1, none: 2 }
const ORIGIN = location.origin
const iso = (ms) => new Date(ms).toISOString()

if (new URLSearchParams(location.search).get('reset') === '1') {
  try { localStorage.removeItem(STORE_KEY) } catch {}
}

/* ---- seed ------------------------------------------------------------ */
function metres(a, b) {
  const R = 6371008.8
  const rad = (d) => (d * Math.PI) / 180
  const dLat = rad(b.lat - a.lat)
  const dLng = rad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

function order(clients) {
  const out = []
  let at = COMPANY.yard
  for (const tier of [0, 1, 2]) {
    const left = clients.filter((c) => TIER[c.priority] === tier)
    while (left.length) {
      left.sort((a, b) => metres(at, a) - metres(at, b) || a.id - b.id)
      at = left.shift()
      out.push(at)
    }
  }
  return out
}

function placeholderPhoto(label) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600"><rect width="800" height="600" fill="#26344f"/><rect y="420" width="800" height="180" fill="#dfe8f5"/><rect x="250" y="250" width="300" height="190" fill="#3b4c6b"/><text x="400" y="120" fill="#fbbf24" font-family="Arial" font-size="44" font-weight="700" text-anchor="middle">SAMPLE photo</text><text x="400" y="180" fill="#eef3fb" font-family="Arial" font-size="30" text-anchor="middle">${label}</text></svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

function seed() {
  const now = Date.now()
  const started = now - 120 * MIN
  const stops = []
  for (const truck of TRUCKS) {
    order(CLIENTS.filter((c) => c.truck_id === truck.id)).forEach((c, i) => stops.push({ client_id: c.id, truck_id: truck.id, position: i + 1 }))
  }
  const s = { v: 1, storms: [{ id: 1, started_at: iso(started), ended_at: null, stops }], checkins: [], photos: {} }
  const on = (truck, pos) => stops.find((x) => x.truck_id === truck && x.position === pos).client_id
  const add = (truck, pos, kind, minutes, reason = null) => {
    const id = `00000000-0000-4000-8000-${String(s.checkins.length + 1).padStart(12, '0')}`
    s.checkins.push({ id, storm_id: 1, client_id: on(truck, pos), truck_id: truck, kind, reason, note: '', at: iso(started + minutes * MIN),
      at_adjusted: false, received_at: iso(started + minutes * MIN), photo: kind === 'plowed' ? 'stored' : 'none', voided_at: null })
    if (kind === 'plowed') s.photos[id] = placeholderPhoto(CLIENTS.find((c) => c.id === on(truck, pos)).name)
  }
  add(1, 1, 'plowed', 25)
  add(1, 2, 'plowed', 50)
  add(2, 1, 'plowed', 30)
  add(2, 2, 'skipped', 45, 'car')
  return s
}

let memory = null
function load() {
  if (memory) return memory
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY))
    if (s?.v === 1) return (memory = s)
  } catch {}
  memory = seed()
  save()
  return memory
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(memory)) } catch { /* over quota: keep it for this page only */ }
}

/* ---- views ----------------------------------------------------------- */
const client = (id) => CLIENTS.find((c) => c.id === id)
const activeStorm = (s) => s.storms.find((x) => !x.ended_at) || null

function checkinView(s, c) {
  const reasonText = c.kind === 'skipped' ? (c.note && c.reason === 'other' ? `Other: ${c.note}` : REASON[c.reason]) : null
  return {
    id: c.id, storm_id: c.storm_id, client_id: c.client_id, truck_id: c.truck_id, kind: c.kind, reason: c.reason, reason_text: reasonText,
    note: c.note, at: c.at, at_label: timeLabel(c.at), at_adjusted: c.at_adjusted, received_at: c.received_at, photo: c.photo,
    photo_url: c.photo === 'stored' ? s.photos[c.id] || null : null, voided: !!c.voided_at,
  }
}

function stopView(s, storm, stop) {
  const c = client(stop.client_id)
  const live = s.checkins.filter((k) => k.storm_id === storm.id && k.client_id === c.id && !k.voided_at)
  const plowed = live.find((k) => k.kind === 'plowed')
  const skipped = live.filter((k) => k.kind === 'skipped').pop()
  const decided = plowed || skipped || null
  return {
    client_id: c.id, truck_id: stop.truck_id, position: stop.position, name: c.name, address: c.address, lat: c.lat, lng: c.lng,
    type: c.type, type_label: TYPE[c.type], priority: c.priority, priority_label: PRIORITY[c.priority], opens_at: c.opens_at,
    notes: c.notes, status: plowed ? 'plowed' : skipped ? 'skipped' : 'pending', checkin: decided ? checkinView(s, decided) : null,
  }
}

const ok = (status, data) => ({ status, data })
const err = (status, code, error, extra = {}) => ({ status, data: { error, code, ...extra } })
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DRIVER_401 = () => err(401, 'unauthorized', "This driver link doesn't work any more. Ask the owner for a new one.")

function toDataUrl(bytes, type) {
  const view = new Uint8Array(bytes)
  let bin = ''
  for (let i = 0; i < view.length; i += 0x8000) bin += String.fromCharCode(...view.subarray(i, i + 0x8000))
  return `data:${type};base64,${btoa(bin)}`
}

/* ---- routes ---------------------------------------------------------- */
export async function handle(method, path, { json, bytes, type, headers }) {
  await new Promise((r) => setTimeout(r, 40))
  const s = load()
  const now = Date.now()
  const url = new URL(path, ORIGIN)
  const p = url.pathname
  const truckId = DRIVER_KEYS[headers['X-Driver-Key']]
  const truck = ALL_TRUCKS.find((t) => t.id === truckId)
  const storm = activeStorm(s)
  let m

  if (method === 'GET' && p === '/api/company') {
    return ok(200, { name: COMPANY.name, sample: COMPANY.name.includes('SAMPLE'), timezone: NL_ZONE, hst_rate: 0.15, yard: COMPANY.yard })
  }

  if (method === 'GET' && p === '/api/driver/route') {
    if (!truck) return DRIVER_401()
    const mine = storm && storm.stops.filter((x) => x.truck_id === truck.id).sort((a, b) => a.position - b.position)
    const inStorm = mine && mine.length > 0
    return ok(200, {
      company: { name: COMPANY.name, sample: true, timezone: NL_ZONE },
      truck: { id: truck.id, name: truck.name },
      storm: inStorm ? { id: storm.id, name: `Storm of ${dateLabel(storm.started_at)}`, status: 'active', started_at: storm.started_at } : null,
      stops: inStorm ? mine.map((x) => stopView(s, storm, x)) : [],
      server_now: iso(now),
    })
  }

  if (method === 'POST' && p === '/api/driver/checkins') {
    if (!truck) return DRIVER_401()
    const b = json || {}
    if (typeof b.id !== 'string' || !UUID.test(b.id)) return err(400, 'bad_request', 'The check-in id is not valid.', { field: 'id' })
    const existing = s.checkins.find((k) => k.id === b.id)
    if (existing) {
      const st = s.storms.find((x) => x.id === existing.storm_id)
      return ok(200, { checkin: checkinView(s, existing), stop: stopView(s, st, st.stops.find((x) => x.client_id === existing.client_id)), duplicate: true })
    }
    if (b.kind !== 'plowed' && b.kind !== 'skipped') return err(400, 'bad_request', 'Pick plowed or skipped.', { field: 'kind' })
    if (b.kind === 'skipped' && !REASON[b.reason]) return err(400, 'bad_request', 'Pick a reason for skipping.', { field: 'reason' })
    if (b.note != null && (typeof b.note !== 'string' || b.note.length > 120)) return err(400, 'bad_request', 'Keep the note under 120 characters.', { field: 'note' })
    if (typeof b.at !== 'string' || Number.isNaN(Date.parse(b.at))) return err(400, 'bad_request', 'The check-in time is not valid.', { field: 'at' })
    if (typeof b.has_photo !== 'boolean') return err(400, 'bad_request', 'has_photo must be true or false.', { field: 'has_photo' })
    const st = s.storms.find((x) => x.id === b.storm_id)
    const stop = st?.stops.find((x) => x.client_id === b.client_id)
    if (!stop) return err(404, 'not_found', 'That stop is not on this storm.')
    const plowed = s.checkins.find((k) => k.storm_id === st.id && k.client_id === stop.client_id && k.kind === 'plowed' && !k.voided_at)
    if (plowed) return err(409, 'already_plowed', 'This stop is already marked plowed.', { checkin: checkinView(s, plowed) })
    const at = Date.parse(b.at)
    const fair = at >= Date.parse(st.started_at) - 10 * MIN && at <= now + 10 * MIN
    const row = { id: b.id, storm_id: st.id, client_id: stop.client_id, truck_id: truck.id, kind: b.kind, reason: b.kind === 'skipped' ? b.reason : null,
      note: b.note || '', at: fair ? new Date(at).toISOString() : iso(now), at_adjusted: !fair, received_at: iso(now),
      photo: b.has_photo ? 'waiting' : 'none', voided_at: null }
    s.checkins.push(row)
    save()
    return ok(201, { checkin: checkinView(s, row), stop: stopView(s, st, stop) })
  }

  if ((m = /^\/api\/driver\/checkins\/([^/]+)\/photo$/.exec(p)) && method === 'PUT') {
    if (!truck) return DRIVER_401()
    const row = s.checkins.find((k) => k.id === decodeURIComponent(m[1]) && k.truck_id === truck.id)
    if (!row) return err(404, 'not_found', 'That check-in is not on this truck.')
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) return err(415, 'unsupported_photo', 'Send the photo as a JPEG, PNG or WebP picture.')
    const size = bytes?.byteLength ?? bytes?.size ?? 0
    if (size > 5_000_000) return err(413, 'too_large', 'That photo is too big. The limit is 5 MB.')
    s.photos[row.id] = toDataUrl(bytes instanceof Blob ? await bytes.arrayBuffer() : bytes, type)
    row.photo = 'stored'
    save()
    return ok(200, { checkin: checkinView(s, row) })
  }

  if ((m = /^\/api\/driver\/checkins\/([^/]+)$/.exec(p)) && method === 'DELETE') {
    if (!truck) return DRIVER_401()
    const row = s.checkins.find((k) => k.id === decodeURIComponent(m[1]) && k.truck_id === truck.id)
    if (!row) return err(404, 'not_found', 'That check-in is not on this truck.')
    if (!row.voided_at) {
      if (now - Date.parse(row.received_at) > 15 * MIN) return err(409, 'bad_state', 'Too late to undo. Ask the owner to fix it.')
      row.voided_at = iso(now)
      save()
    }
    const st = s.storms.find((x) => x.id === row.storm_id)
    return ok(200, { checkin: checkinView(s, row), stop: stopView(s, st, st.stops.find((x) => x.client_id === row.client_id)) })
  }

  if ((m = /^\/api\/status\/([^/]+)$/.exec(p)) && method === 'GET') {
    const ref = /^demo-status-(sample-\d\d)$/.exec(decodeURIComponent(m[1]))?.[1]
    const c = CLIENTS.find((x) => x.ref === ref)
    if (!c) return err(404, 'not_found', "This status link doesn't work. Ask your snow clearing company for a new one.")
    const lastRow = s.checkins.filter((k) => k.client_id === c.id && k.kind === 'plowed' && !k.voided_at).sort((a, b) => a.at.localeCompare(b.at)).pop()
    let tonight = null
    const stop = storm?.stops.find((x) => x.client_id === c.id)
    if (stop) {
      const onTruck = storm.stops.filter((x) => x.truck_id === stop.truck_id).map((x) => stopView(s, storm, x))
      const mine = onTruck.find((x) => x.client_id === c.id)
      tonight = { storm_name: `Storm of ${dateLabel(storm.started_at)}`, state: mine.status === 'pending' ? 'waiting' : mine.status,
        stop_number: mine.position, stops_on_route: onTruck.length, stops_done: onTruck.filter((x) => x.status !== 'pending').length,
        reason_text: mine.status === 'skipped' ? mine.checkin.reason_text : null }
    }
    return ok(200, {
      company: { name: COMPANY.name, sample: true },
      client: { name: c.name, address: c.address, type: c.type, type_label: TYPE[c.type] },
      last: lastRow ? { at: lastRow.at, at_label: fullLabel(lastRow.at), time_label: timeLabel(lastRow.at),
        photo_url: lastRow.photo === 'stored' ? s.photos[lastRow.id] : null, photo_waiting: lastRow.photo === 'waiting' } : null,
      tonight,
      server_now: iso(now),
    })
  }

  return err(404, 'not_found', `The mock does not answer ${method} ${p}.`)
}
