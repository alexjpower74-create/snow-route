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
  const req = new Request('http://x/', {
    headers: { 'X-Test-Now': '2026-01-12T08:00:00.000Z', 'X-Test-IP': '10.9.9.9', 'CF-Connecting-IP': '1.2.3.4' },
  })
  assert.equal(now(req, { TEST_MODE: '1' }), Date.parse('2026-01-12T08:00:00.000Z'))
  assert.equal(clientIp(req, { TEST_MODE: '1' }), '10.9.9.9')
  assert.ok(Math.abs(now(req, {}) - Date.now()) < 5000)
  assert.equal(clientIp(req, {}), '1.2.3.4')
  assert.equal(isTestMode({ TEST_MODE: '0' }), false)
})

test('without TEST_MODE, /api/test/* answers 404 before touching the database', async () => {
  const touched = []
  const db = new Proxy(
    {},
    {
      get: (_, k) => {
        touched.push(k)
        throw new Error('database touched')
      },
    },
  )
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
  assert.equal(
    readFileSync(new URL('../src/sample-data.js', import.meta.url), 'utf8'),
    render(sampleData()),
    'stale: run npm run build:sample',
  )
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

test('an unexpected failure answers 500 server_error with the contract text (clarification 6)', async () => {
  const failing = {
    prepare() {
      throw new Error('database unavailable (test)')
    },
  }
  const quiet = console.error
  console.error = () => {}
  try {
    const res = await worker.fetch(new Request('http://127.0.0.1/api/company'), { DB: failing })
    assert.equal(res.status, 500)
    assert.deepEqual(await res.json(), { error: 'Something went wrong on our side. Try again in a minute.', code: 'server_error' })
    assert.equal(res.headers.get('cache-control'), 'no-store')
  } finally {
    console.error = quiet
  }
})

test('an unreadable request body answers 400 before the database is touched', async () => {
  const db = new Proxy(
    {},
    {
      get: () => {
        throw new Error('database touched')
      },
    },
  )
  const res = await worker.fetch(new Request('http://127.0.0.1/api/owner/signin', { method: 'POST', body: '{not json' }), { DB: db })
  assert.equal(res.status, 400)
  assert.deepEqual(await res.json(), { error: 'That request could not be read.', code: 'bad_request' })
})

test('no Worker text says "Please try again" (the scan is shown to catch a known-bad line)', async () => {
  const { readdirSync } = await import('node:fs')
  const scan = (text) => text.split('\n').filter((line) => /Please try again/.test(line))
  assert.equal(scan("  throw badRequest(null, 'That request could not be read. Please try again.')").length, 1, 'the scan can fail')
  const dir = new URL('../src/', import.meta.url)
  const hits = readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .flatMap((f) => scan(readFileSync(new URL(f, dir), 'utf8')).map((l) => `${f}: ${l.trim()}`))
  assert.deepEqual(hits, [])
})

// The demo placeholder photo is an intentional card, not a dark block over a flat white one (Onyx's polish review, DECISIONS 59).
import { test as placeholderTest } from 'node:test'
import placeholderAssert from 'node:assert/strict'
import { placeholderSvg } from '../src/sample.js'
placeholderTest(
  'the demo placeholder photo is a card: SAMPLE label, a drawn camera, the NL time taken, the stop, no flat white block',
  () => {
    const svg = placeholderSvg('Pat <SAMPLE> & co', '2026-01-12T11:12:00.000Z')
    placeholderAssert.match(svg, /^<svg [^>]*viewBox="0 0 800 600"/)
    placeholderAssert.ok(svg.includes('SAMPLE placeholder photo'), 'the SAMPLE label')
    placeholderAssert.ok(svg.includes('id="camera"'), 'a drawn camera')
    placeholderAssert.ok(svg.includes('Photo taken 7:42 AM'), 'the NL time the photo was taken (11:12Z is 7:42 AM NST)')
    placeholderAssert.ok(svg.includes('Pat &#60;SAMPLE&#62; &#38; co'), 'the stop name, XML-escaped')
    placeholderAssert.ok(!/<rect[^>]*fill="#eef3fb"/.test(svg), 'no flat white block that reads as a broken image')
  },
)

// The owner map's style URL is one config value (API.md 54, DECISIONS 62): MAP_STYLE_URL when set, OpenFreeMap by default.
import { test as mapTest } from 'node:test'
import mapAssert from 'node:assert/strict'
import { DEFAULT_MAP_STYLE_URL, mapStyleUrl } from '../src/map.js'
mapTest('the map style URL is one config value: MAP_STYLE_URL when set, OpenFreeMap by default', () => {
  mapAssert.match(DEFAULT_MAP_STYLE_URL, /^https:\/\/tiles\.openfreemap\.org\/styles\/[a-z0-9-]+$/)
  mapAssert.equal(mapStyleUrl({}), DEFAULT_MAP_STYLE_URL)
  mapAssert.equal(mapStyleUrl(undefined), DEFAULT_MAP_STYLE_URL)
  mapAssert.equal(mapStyleUrl({ MAP_STYLE_URL: '   ' }), DEFAULT_MAP_STYLE_URL)
  mapAssert.equal(
    mapStyleUrl({ MAP_STYLE_URL: 'https://maps.example.test/styles/snow.json' }),
    'https://maps.example.test/styles/snow.json',
  )
})
