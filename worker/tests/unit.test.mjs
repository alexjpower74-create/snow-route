// Pure checks outside routing: NL time labels and month bounds, the TEST_MODE rule, the sample data and the seeded PIN.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import { timeLabel, dateLabel, fullLabel, nlDate, nlMonth, monthBounds, monthLabel, durationLabel } from '../src/time.js'
import { now, clientIp, isTestMode } from '../src/clock.js'
import { verifyPin, isUuidV4 } from '../src/auth.js'
import { SAMPLE } from '../src/sample-data.js'
import { sampleData, render } from '../tools/build-sample-data.mjs'
import worker from '../src/index.js'

test('NL labels: plain spaces, NST in January', () => {
  assert.equal(timeLabel('2026-01-12T10:42:00.000Z'), '7:12 AM')
  assert.equal(dateLabel('2026-01-12T10:42:00.000Z'), 'Mon Jan 12')
  assert.equal(fullLabel('2026-01-12T10:42:00.000Z'), 'Mon Jan 12, 7:12 AM')
  assert.equal(timeLabel('2026-07-01T09:12:00.000Z'), '6:42 AM') // NDT, -2:30
  assert.equal(durationLabel(220 * 60000), '3 h 40 min')
  assert.equal(durationLabel(25 * 60000), '25 min')
})

test('NL month boundary: 2026-02-01T03:00:00Z is Jan 31 11:30 PM NST', () => {
  assert.equal(nlDate('2026-02-01T03:00:00Z'), '2026-01-31')
  assert.equal(nlMonth('2026-02-01T03:00:00Z'), '2026-01')
  assert.equal(fullLabel('2026-02-01T03:00:00Z'), 'Sat Jan 31, 11:30 PM')
  assert.deepEqual(monthBounds('2026-01'), { start: '2026-01-01T03:30:00.000Z', end: '2026-02-01T03:30:00.000Z' })
  // Daylight time starts Mar 8 2026 and ends Nov 1 2026.
  assert.deepEqual(monthBounds('2026-03'), { start: '2026-03-01T03:30:00.000Z', end: '2026-04-01T02:30:00.000Z' })
  assert.deepEqual(monthBounds('2026-12'), { start: '2026-12-01T03:30:00.000Z', end: '2027-01-01T03:30:00.000Z' })
  assert.equal(monthLabel('2026-01'), 'January 2026')
})

test('clock.js honours X-Test-Now and X-Test-IP only when TEST_MODE=1', () => {
  const req = new Request('http://x/', { headers: { 'X-Test-Now': '2026-01-12T08:00:00.000Z', 'X-Test-IP': '10.9.9.9', 'CF-Connecting-IP': '1.2.3.4' } })
  assert.equal(now(req, { TEST_MODE: '1' }), Date.parse('2026-01-12T08:00:00.000Z'))
  assert.equal(clientIp(req, { TEST_MODE: '1' }), '10.9.9.9')
  assert.ok(Math.abs(now(req, {}) - Date.now()) < 5000)
  assert.equal(clientIp(req, {}), '1.2.3.4')
  assert.equal(isTestMode({ TEST_MODE: '0' }), false)
})

test('without TEST_MODE, /api/test/* answers 404 before touching the database', async () => {
  const touched = []
  const db = new Proxy({}, { get: (_, k) => { touched.push(k); throw new Error('database touched') } })
  const res = await worker.fetch(new Request('http://127.0.0.1/api/test/reset', { method: 'POST' }), { DB: db, PHOTOS: db })
  assert.equal(res.status, 404)
  assert.equal((await res.json()).code, 'not_found')
  assert.deepEqual(touched, [])
})

test('wrangler.toml never sets TEST_MODE', () => {
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8')
  assert.ok(!/^\s*TEST_MODE\s*=/m.test(toml))
  assert.ok(!/^\s*\[vars\]/m.test(toml))
})

test('src/sample-data.js is up to date with data/sample-clients.json and every name says SAMPLE', () => {
  assert.equal(readFileSync(new URL('../src/sample-data.js', import.meta.url), 'utf8'), render(sampleData()),
    'stale: run npm run build:sample')
  assert.equal(SAMPLE.clients.length, 25)
  assert.equal(SAMPLE.trucks.length, 2)
  for (const c of SAMPLE.clients) {
    assert.match(c.name, /SAMPLE/)
    assert.doesNotMatch(c.address, /\d/, `house number in ${c.address}`)
  }
})

test('migration 0002 is the SAMPLE company and its PIN hash really is 2468', async () => {
  if (!globalThis.crypto) globalThis.crypto = webcrypto
  const sql = readFileSync(new URL('../migrations/0002_company.sql', import.meta.url), 'utf8')
  assert.ok(sql.includes(`'${SAMPLE.company.name}'`))
  assert.ok(sql.includes(`'${SAMPLE.company.yard.label}'`))
  assert.ok(sql.includes(String(SAMPLE.company.yard.lat)) && sql.includes(String(SAMPLE.company.yard.lng)))
  const pin = /'(\{"alg":"PBKDF2-SHA256".*?\})'/.exec(sql)[1]
  assert.equal(await verifyPin('2468', pin), true)
  assert.equal(await verifyPin('2469', pin), false)
})

test('UUID v4 check', () => {
  assert.ok(isUuidV4('6f1c2a3e-1b2c-4d3e-8f40-123456789abc'))
  assert.ok(!isUuidV4('6f1c2a3e-1b2c-1d3e-8f40-123456789abc'))
  assert.ok(!isUuidV4('not-a-uuid'))
})
