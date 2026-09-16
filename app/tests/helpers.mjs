// Shared fixture and helpers for the e2e suite.
// - Every test starts with POST /api/test/reset (auto fixture `seed`, which also hands the test the keys).
// - The map style (https://tiles.openfreemap.org/styles/*) is answered with a tiny local style (a background only, so MapLibre asks for no
//   tiles, glyphs or sprites), and any other request to a host that is not 127.0.0.1 is aborted and fails the test (auto fixture `guarded`).
// - REAL input only: tap() hit-tests the target's centre with elementFromPoint before a real touch or click, typing is
//   page.keyboard, map clicks are page.mouse / touchscreen at a point, photos go through the real file chooser with a generated
//   image. evaluate is only ever used to read (and scroll a target into view, as a person would).
import { test as base, expect } from '@playwright/test'
import { deflateSync, crc32 } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export { expect }
export const PIN = '2468'
export const COMPANY = 'SAMPLE Snow Clearing — Grand Falls-Windsor (demo)'
const SHOTS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots')

/* ---- generated images ------------------------------------------------------ */
export function png(width, height, paint) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1)
    for (let x = 0; x < width; x++) raw.set(paint(x, y), row + 1 + x * 3)
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
export const TEST_STYLE = {
  version: 8,
  name: 'Snow Route test style (local fixture)',
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#dde3e8' } }],
}
export const TILE = png(256, 256, (x, y) => (((x >> 5) + (y >> 5)) % 2 ? [58, 74, 104] : [48, 62, 90]))
export const PHOTO = {
  name: 'plowed-sample.png',
  mimeType: 'image/png',
  buffer: png(1200, 900, (x, y) => (y > 540 ? [225, 232, 245] : [40 + (x * 60) / 1200, 55 + (y * 60) / 900, 90])),
}

/* ---- the network guard ------------------------------------------------------ */
export async function guard(context) {
  const outside = []
  const styles = []
  await context.route('https://tiles.openfreemap.org/**', (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.startsWith('/styles/')) {
      styles.push(url.href)
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TEST_STYLE) })
    }
    outside.push(url.href) // a style that starts fetching real tiles fails the test
    return route.abort('blockedbyclient')
  })
  await context.route(
    // blob: and data: URLs are objects inside the page, not network requests (MapLibre starts its web worker from a blob: URL).
    (url) =>
      url.protocol !== 'blob:' && url.protocol !== 'data:' && url.hostname !== '127.0.0.1' && url.hostname !== 'tiles.openfreemap.org',
    (route) => {
      outside.push(route.request().url())
      return route.abort('blockedbyclient')
    },
  )
  return { outside, styles }
}

export const test = base.extend({
  guarded: [
    async ({ context }, use) => {
      const g = await guard(context)
      await use(g)
      expect(g.outside, 'every request stays on 127.0.0.1 (the map style goes to the local fixture)').toEqual([])
    },
    { auto: true },
  ],
  seed: [
    async ({ request }, use) => {
      const r = await request.post('/api/test/reset')
      expect(r.status(), 'POST /api/test/reset').toBe(200)
      await use(await r.json())
    },
    { auto: true },
  ],
})

/* ---- real input ------------------------------------------------------------ */
// '' when the centre of the element hit-tests to itself (or a child), else what is on top.
export async function hitTest(locator) {
  const box = await locator.boundingBox()
  if (!box) return { box, hit: 'no box' }
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  const hit = await locator.evaluate(
    (el, [px, py]) => {
      const t = document.elementFromPoint(px, py)
      return t === el || el.contains(t) ? '' : t ? t.outerHTML.slice(0, 160) : 'nothing'
    },
    [x, y],
  )
  return { box, x, y, hit }
}

async function intoView(page, locator) {
  await locator.scrollIntoViewIfNeeded()
  let box = await locator.boundingBox()
  // "In view" to Playwright includes under the sticky sync strip, where a person could not tap it; scroll it to the middle then.
  const stuck = await page.evaluate(() =>
    Math.max(0, ...[...document.querySelectorAll('.strip')].map((e) => e.getBoundingClientRect().bottom)),
  )
  const vh = page.viewportSize().height
  if (box && (box.y + box.height / 2 < stuck || box.y + box.height / 2 > vh)) {
    await locator.evaluate((el) => el.scrollIntoView({ block: 'center' }))
    box = await locator.boundingBox()
  }
  return box
}

const coarse = (page) => page.evaluate(() => matchMedia('(pointer: coarse)').matches)

export async function tap(page, locator, label = String(locator)) {
  await expect(locator, `tap(${label}): visible`).toBeVisible()
  await intoView(page, locator)
  const { x, y, hit } = await hitTest(locator)
  expect(hit, `tap(${label}) hit-test at ${Math.round(x)},${Math.round(y)}: something else is on top`).toBe('')
  if (await coarse(page)) await page.touchscreen.tap(x, y)
  else await page.mouse.click(x, y)
}

// A tap or click at a point inside an element (a map), hit-tested to that element first.
export async function tapAt(page, locator, fx, fy, label) {
  await expect(locator).toBeVisible()
  await intoView(page, locator)
  const box = await locator.boundingBox()
  const x = box.x + box.width * fx
  const y = box.y + box.height * fy
  const hit = await locator.evaluate(
    (el, [px, py]) => {
      const t = document.elementFromPoint(px, py)
      return t === el || el.contains(t) ? '' : t ? t.outerHTML.slice(0, 160) : 'nothing'
    },
    [x, y],
  )
  expect(hit, `tapAt(${label}) hit-test at ${Math.round(x)},${Math.round(y)}`).toBe('')
  if (await coarse(page)) await page.touchscreen.tap(x, y)
  else await page.mouse.click(x, y)
}

export async function typeText(page, locator, text, label) {
  await tap(page, locator, label || `field ${text}`)
  await page.keyboard.type(text)
}

export async function choosePhoto(page, locator, label = 'Plowed') {
  const chooser = page.waitForEvent('filechooser')
  await tap(page, locator, label)
  await (await chooser).setFiles(PHOTO)
}

/* ---- API setup and reading (arranging data is not UI state) ------------------ */
export async function api(request, method, url, { data, headers = {}, token } = {}) {
  const h = { ...headers }
  if (token) h.Authorization = `Bearer ${token}`
  const r = await request.fetch(url, { method, data, headers: h })
  let body = null
  try {
    body = await r.json()
  } catch {}
  return { status: r.status(), body, headers: r.headers() }
}

export async function ownerToken(request) {
  const r = await api(request, 'POST', '/api/owner/signin', { data: { pin: PIN } })
  expect(r.status, 'sign in with the SAMPLE PIN').toBe(200)
  return r.body.token
}

export async function startStorm(request, token, headers = {}) {
  const clients = (await api(request, 'GET', '/api/owner/clients', { token })).body.clients
  const trucks = (await api(request, 'GET', '/api/owner/trucks', { token })).body.trucks
  const r = await api(request, 'POST', '/api/owner/storms', {
    token,
    headers,
    data: { client_ids: clients.map((c) => c.id), truck_ids: trucks.map((t) => t.id) },
  })
  expect(r.status, 'start a storm with every client and both trucks').toBe(201)
  return r.body
}

export async function ownerStorm(request, token, id) {
  const r = await api(request, 'GET', `/api/owner/storms/${id}`, { token })
  expect(r.status).toBe(200)
  return r.body
}

export async function dbCheckins(request, stormId) {
  const r = await api(request, 'GET', `/api/test/checkins?storm_id=${stormId}`)
  expect(r.status).toBe(200)
  return r.body.checkins
}

export async function signIn(page, pin = PIN) {
  await page.goto('/owner/')
  await typeText(page, page.locator('#pin'), pin, 'PIN')
  await tap(page, page.locator('#signin-btn'), 'Sign in')
  await expect(page.locator('#signout')).toBeVisible()
}

export async function shot(page, testInfo, name, { fullPage = true } = {}) {
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: path.join(SHOTS, `${testInfo.project.name}-${name}.png`), fullPage, animations: 'disabled' })
}

/* ---- colour ------------------------------------------------------------------ */
const channel = (c) => {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
export const rgb = (css) =>
  css
    .match(/\d+(\.\d+)?/g)
    .slice(0, 3)
    .map(Number)
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
