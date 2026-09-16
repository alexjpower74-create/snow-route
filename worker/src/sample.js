// Seeding the SAMPLE company, trucks and clients (POST /api/test/reset). Data comes from the generated sample-data.js.
import { SAMPLE } from './sample-data.js'
import { hashPin, randomKey } from './auth.js'
import { TIMEZONE, dateLabel, timeLabel } from './time.js'
import { buildRoute } from './route.js'

export const SAMPLE_PIN = '2468'

// Child tables first: storm_stops and clients reference trucks, storms and clients.
const TABLES = [
  'photos',
  'checkins',
  'storm_stops',
  'storm_trucks',
  'storms',
  'sessions',
  'signin_attempts',
  'clients',
  'trucks',
  'company',
]

export async function wipe(env) {
  await env.DB.batch([
    ...TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
    env.DB.prepare(`DELETE FROM sqlite_sequence WHERE name IN (${TABLES.map((t) => `'${t}'`).join(', ')})`),
  ])
  let cursor
  do {
    const listed = await env.PHOTOS.list({ cursor })
    if (listed.objects.length) await env.PHOTOS.delete(listed.objects.map((o) => o.key))
    cursor = listed.truncated ? listed.cursor : undefined
  } while (cursor)
}

/** Wipe, then seed. Returns the reset answer (keys included, for tests and the demo). */
export async function seedSample(env, origin) {
  await wipe(env)
  const db = env.DB
  const { company } = SAMPLE
  const pin = await hashPin(SAMPLE_PIN)
  const truckKeys = SAMPLE.trucks.map(() => randomKey())
  const results = await db.batch([
    db
      .prepare('INSERT INTO company (id, name, timezone, yard_label, yard_lat, yard_lng, pin) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6)')
      .bind(company.name, TIMEZONE, company.yard.label, company.yard.lat, company.yard.lng, pin),
    ...SAMPLE.trucks.map((t, i) =>
      db.prepare('INSERT INTO trucks (name, active, driver_key) VALUES (?1, 1, ?2) RETURNING id').bind(t.name, truckKeys[i]),
    ),
  ])
  const truckIds = results.slice(1).map((r) => r.results[0].id)
  const clientKeys = SAMPLE.clients.map(() => randomKey())
  const inserted = await db.batch(
    SAMPLE.clients.map((c, i) =>
      db
        .prepare(
          `INSERT INTO clients (ref, name, address, lat, lng, type, priority, opens_at, notes, billing, price_cents, truck_id, active, status_key)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1, ?13) RETURNING id`,
        )
        .bind(
          c.ref,
          c.name,
          c.address,
          c.lat,
          c.lng,
          c.type,
          c.priority,
          c.opens_at,
          c.notes,
          c.billing,
          c.price_cents,
          c.truck ? truckIds[c.truck - 1] : null,
          clientKeys[i],
        ),
    ),
  )
  return {
    pin: SAMPLE_PIN,
    trucks: SAMPLE.trucks.map((t, i) => ({
      id: truckIds[i],
      name: t.name,
      driver_key: truckKeys[i],
      driver_url: `${origin}/d/?k=${truckKeys[i]}`,
    })),
    clients: SAMPLE.clients.map((c, i) => ({
      id: inserted[i].results[0].id,
      ref: c.ref,
      name: c.name,
      status_key: clientKeys[i],
      status_url: `${origin}/s/?k=${clientKeys[i]}`,
    })),
  }
}

// ---- the demo scenario (POST /api/test/seed { scenario: "demo" }) ----

const MIN = 60000
const DAY = 86400000
const iso = (ms) => new Date(ms).toISOString()
const escapeXml = (s) => String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)

/**
 * A generated placeholder photo: no real picture of anyone's home. It is a neutral card that says what it is (a drawn camera, the NL
 * time the photo was taken, the stop, and a SAMPLE label), so a client never reads it as a broken image.
 */
export function placeholderSvg(title, at) {
  const taken = `Photo taken ${timeLabel(at)}`
  const font = 'font-family="Arial, Helvetica, sans-serif"'
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">` +
    `<rect width="800" height="600" rx="24" fill="#1a2540"/>` +
    `<rect x="18" y="18" width="764" height="564" rx="18" fill="none" stroke="#3b4a68" stroke-width="2" stroke-dasharray="12 10"/>` +
    `<rect x="40" y="40" width="380" height="54" rx="27" fill="none" stroke="#fbbf24" stroke-width="3"/>` +
    `<text x="230" y="76" text-anchor="middle" ${font} font-size="24" font-weight="700" fill="#fbbf24">SAMPLE placeholder photo</text>` +
    `<g id="camera" fill="none" stroke="#a3b3cc" stroke-width="10" stroke-linejoin="round" stroke-linecap="round">` +
    `<rect x="290" y="190" width="220" height="150" rx="24"/><path d="M345 190 l20 -32 h70 l20 32"/><circle cx="400" cy="265" r="46"/></g>` +
    `<text x="400" y="425" text-anchor="middle" ${font} font-size="46" font-weight="700" fill="#eef3fb">${escapeXml(taken)}</text>` +
    `<text x="400" y="480" text-anchor="middle" ${font} font-size="30" fill="#a3b3cc">${escapeXml(title)}</text></svg>`
  )
}

/**
 * Reset, then (relative to now) two ended storms 13 and 6 days ago with every stop plowed except one "Car in the way" skip
 * each, and an active storm started 2 hours ago where each truck's first 5 stops are plowed (placeholder photos; one still
 * waiting for its photo) and its 6th is skipped "Gate locked".
 */
export async function seedDemo(env, origin, nowMs) {
  const answer = await seedSample(env, origin)
  const db = env.DB
  const truckIds = answer.trucks.map((t) => t.id)
  const clients = SAMPLE.clients.map((c, i) => ({
    client_id: answer.clients[i].id,
    name: c.name,
    lat: c.lat,
    lng: c.lng,
    priority: c.priority,
    truck_id: c.truck ? truckIds[c.truck - 1] : null,
  }))
  const route = buildRoute(SAMPLE.company.yard, clients, truckIds)
  const plan = [
    { startsAgo: 13 * DAY, skip: [0, 2], active: false },
    { startsAgo: 6 * DAY, skip: [1, 3], active: false },
    { startsAgo: 120 * MIN, active: true },
  ]
  let activeId = null
  for (const p of plan) {
    const started = nowMs - p.startsAgo
    const checkins = []
    route.forEach((t, ti) =>
      t.stops.forEach((s, i) => {
        if (p.active) {
          if (i > 5) return
          const at = started + 15 * MIN + i * 12 * MIN
          if (i === 5) checkins.push({ t, s, at, kind: 'skipped', reason: 'gate', photo: null })
          else checkins.push({ t, s, at, kind: 'plowed', reason: null, photo: ti === 0 && i === 4 ? 'waiting' : 'stored' })
        } else {
          const at = started + 15 * MIN + i * 10 * MIN
          const skip = p.skip[0] === ti && p.skip[1] === i
          checkins.push({ t, s, at, kind: skip ? 'skipped' : 'plowed', reason: skip ? 'car' : null, photo: skip ? null : 'stored' })
        }
      }),
    )
    const last = Math.max(started, ...checkins.map((k) => k.at))
    const storm = await db
      .prepare('INSERT INTO storms (name, started_at, ended_at) VALUES (?1, ?2, ?3) RETURNING id')
      .bind(`Storm of ${dateLabel(started)}`, iso(started), p.active ? null : iso(last + 20 * MIN))
      .first()
    const stmts = []
    for (const t of route) {
      stmts.push(db.prepare('INSERT INTO storm_trucks (storm_id, truck_id) VALUES (?1, ?2)').bind(storm.id, t.truck_id))
      t.stops.forEach((s, i) =>
        stmts.push(
          db
            .prepare('INSERT INTO storm_stops (storm_id, client_id, truck_id, position) VALUES (?1, ?2, ?3, ?4)')
            .bind(storm.id, s.client_id, t.truck_id, i + 1),
        ),
      )
    }
    const puts = []
    for (const k of checkins) {
      const id = crypto.randomUUID()
      stmts.push(
        db
          .prepare(`INSERT INTO checkins (id, storm_id, client_id, truck_id, kind, reason, note, at, at_adjusted, received_at, has_photo)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, '', ?7, 0, ?8, ?9)`)
          .bind(id, storm.id, k.s.client_id, k.t.truck_id, k.kind, k.reason, iso(k.at), iso(k.at + MIN), k.photo ? 1 : 0),
      )
      if (k.photo === 'stored') {
        const svg = new TextEncoder().encode(placeholderSvg(k.s.name, k.at))
        puts.push(env.PHOTOS.put(`checkins/${id}`, svg, { httpMetadata: { contentType: 'image/svg+xml' } }))
        stmts.push(
          db
            .prepare("INSERT INTO photos (checkin_id, token, content_type, size, stored_at) VALUES (?1, ?2, 'image/svg+xml', ?3, ?4)")
            .bind(id, randomKey(16), svg.byteLength, iso(k.at + 2 * MIN)),
        )
      }
    }
    await Promise.all(puts)
    await db.batch(stmts)
    if (p.active) activeId = storm.id
  }
  return { ...answer, storm_id: activeId }
}
