// Seeding the SAMPLE company, trucks and clients (POST /api/test/reset). Data comes from the generated sample-data.js.
import { SAMPLE } from './sample-data.js'
import { hashPin, randomKey } from './auth.js'
import { TIMEZONE } from './time.js'

export const SAMPLE_PIN = '2468'

// Child tables first: storm_stops and clients reference trucks, storms and clients.
const TABLES = ['photos', 'checkins', 'storm_stops', 'storm_trucks', 'storms', 'sessions', 'signin_attempts', 'clients', 'trucks', 'company']

export async function wipe (env) {
  await env.DB.batch([
    ...TABLES.map(t => env.DB.prepare(`DELETE FROM ${t}`)),
    env.DB.prepare(`DELETE FROM sqlite_sequence WHERE name IN (${TABLES.map(t => `'${t}'`).join(', ')})`)
  ])
  let cursor
  do {
    const listed = await env.PHOTOS.list({ cursor })
    if (listed.objects.length) await env.PHOTOS.delete(listed.objects.map(o => o.key))
    cursor = listed.truncated ? listed.cursor : undefined
  } while (cursor)
}

/** Wipe, then seed. Returns the reset answer (keys included, for tests and the demo). */
export async function seedSample (env, origin) {
  await wipe(env)
  const db = env.DB
  const { company } = SAMPLE
  const pin = await hashPin(SAMPLE_PIN)
  const truckKeys = SAMPLE.trucks.map(() => randomKey())
  const results = await db.batch([
    db.prepare('INSERT INTO company (id, name, timezone, yard_label, yard_lat, yard_lng, pin) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6)')
      .bind(company.name, TIMEZONE, company.yard.label, company.yard.lat, company.yard.lng, pin),
    ...SAMPLE.trucks.map((t, i) => db.prepare('INSERT INTO trucks (name, active, driver_key) VALUES (?1, 1, ?2) RETURNING id').bind(t.name, truckKeys[i]))
  ])
  const truckIds = results.slice(1).map(r => r.results[0].id)
  const clientKeys = SAMPLE.clients.map(() => randomKey())
  const inserted = await db.batch(SAMPLE.clients.map((c, i) => db.prepare(
    `INSERT INTO clients (ref, name, address, lat, lng, type, priority, opens_at, notes, billing, price_cents, truck_id, active, status_key)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1, ?13) RETURNING id`
  ).bind(c.ref, c.name, c.address, c.lat, c.lng, c.type, c.priority, c.opens_at, c.notes, c.billing, c.price_cents,
    c.truck ? truckIds[c.truck - 1] : null, clientKeys[i])))
  return {
    pin: SAMPLE_PIN,
    trucks: SAMPLE.trucks.map((t, i) => ({ id: truckIds[i], name: t.name, driver_key: truckKeys[i], driver_url: `${origin}/d/?k=${truckKeys[i]}` })),
    clients: SAMPLE.clients.map((c, i) => ({
      id: inserted[i].results[0].id, ref: c.ref, name: c.name, status_key: clientKeys[i], status_url: `${origin}/s/?k=${clientKeys[i]}`
    }))
  }
}
