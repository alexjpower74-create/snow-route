// The offline queue against the real Worker. The phone's clock is page.clock; the server's clock is X-Test-Now on every
// request the page makes. Check-ins made with no signal at phone time T must reach the database with at = T, sent 40 minutes
// later (received_at = T + 40 min), with the photo stored.
//
// "No signal" is context.setOffline in Chromium. In Playwright's WebKit a file chosen through the file chooser cannot be read at
// all while the context is offline (createImageBitmap, <img> and file.arrayBuffer() all throw; probe in the build report), and a
// real phone's camera file is on the phone. So on WebKit only, no signal is every /api request failing at the network layer
// (page.route abort, exactly what the queue sees with no signal), the service worker is blocked so those requests stay routable,
// and the offline-reload step is skipped with that reason.
import { test, expect, tap, ownerToken, startStorm, ownerStorm, dbCheckins, choosePhoto } from './helpers.mjs'

const T = Date.parse('2026-09-14T09:00:00.000Z') // Mon Sep 14, 6:30 AM NDT
const MIN = 60_000
const iso = (ms) => new Date(ms).toISOString()
const WEBKIT_REASON = "webkit: Playwright's WebKit cannot read a chosen file while the context is offline, so no signal is simulated by failing every /api request with the service worker blocked; an offline reload would not exercise the service worker, so that step runs in Chromium only"

test.use({ serviceWorkers: async ({ browserName }, use) => use(browserName === 'webkit' ? 'block' : 'allow') })

// clock: 'fixed' pins the phone's Date at T while timers run (so a tap at T is stamped exactly T); 'install' fakes timers
// too, so a test can run the sender's next try with clock.runFor.
async function driverOnline(page, context, request, seed, clock, { worker = true } = {}) {
  const token = await ownerToken(request)
  const storm = await startStorm(request, token, { 'X-Test-Now': iso(T - 5 * MIN) })
  const truck = storm.trucks[0]
  const key = seed.trucks.find((t) => t.id === truck.id).driver_key
  await context.setExtraHTTPHeaders({ 'X-Test-Now': iso(T) })
  if (clock === 'fixed') await page.clock.setFixedTime(T)
  else await page.clock.install({ time: T })
  await page.goto(`/d/?k=${key}`)
  await expect(page.locator('#stop-name')).toHaveText(truck.stops[0].name)
  await expect(page.locator('#sync-text')).toHaveText('All sent')
  if (worker) await page.evaluate(() => navigator.serviceWorker.ready.then(() => true)) // read: the page is saved for offline use
  return { token, storm, truck }
}

async function noSignal(page, context, browserName) {
  if (browserName === 'webkit') await page.route('**/api/**', (route) => route.abort('internetdisconnected'))
  else await context.setOffline(true)
}
async function signalBack(page, context, browserName) {
  if (browserName === 'webkit') await page.unroute('**/api/**')
  else await context.setOffline(false)
}

async function twoCheckinsOffline(page, truck, { photo }) {
  const [s1, s2, s3] = truck.stops
  if (photo) await choosePhoto(page, page.locator('#plowed'), 'Plowed (no signal)')
  else await tap(page, page.locator('#plowed-nophoto'), 'Plowed, no photo (no signal)')
  await expect(page.locator('#stop-name')).toHaveText(s2.name)
  await expect(page.locator('#skip')).toBeEnabled()
  await tap(page, page.locator('#skip'), 'Skip this stop (no signal)')
  await tap(page, page.getByRole('button', { name: 'Car in the way', exact: true }), 'Car in the way')
  await expect(page.locator('#stop-name')).toHaveText(s3.name)
  return [s1, s2]
}

test('no signal: 2 check-ins saved, survive a reload, and send later with the time the driver tapped', async ({ page, context, request, seed, browserName }) => {
  const webkit = browserName === 'webkit'
  const { token, storm, truck } = await driverOnline(page, context, request, seed, 'fixed', { worker: !webkit })
  await noSignal(page, context, browserName)
  const [s1, s2] = await twoCheckinsOffline(page, truck, { photo: true })
  await expect(page.locator('#sync-text')).toHaveText(/^No signal\. 2 check-ins saved on this phone\. They send when signal comes back and keep the time you tapped\.$/)
  await expect(page.locator('.row-status', { hasText: 'saved on this phone' })).toHaveCount(2)
  expect(await dbCheckins(request, storm.id), 'nothing reached the server while offline').toHaveLength(0)

  if (webkit) {
    test.info().annotations.push({ type: 'skipped step', description: WEBKIT_REASON })
  } else {
    // Reload with no signal: the service worker serves the page; the route and the queue come from the phone.
    await page.reload()
    await expect(page.locator('#stop-name')).toHaveText(truck.stops[2].name)
    await expect(page.locator('#sync-text')).toHaveText(/^No signal\. 2 check-ins saved on this phone\./)
    await expect(page.locator('.strip-note')).toHaveText(/^Route saved on this phone at /)
  }

  // Forty minutes later the truck gets signal back.
  await page.clock.setFixedTime(T + 40 * MIN)
  await context.setExtraHTTPHeaders({ 'X-Test-Now': iso(T + 40 * MIN) })
  await signalBack(page, context, browserName)
  // Chromium fires `online` and sends at once; on WebKit nothing announces the signal, so the sender's own retry timer does it.
  await expect(page.locator('#sync-text')).toHaveText('All sent', { timeout: webkit ? 60_000 : 30_000 })

  const rows = await dbCheckins(request, storm.id)
  expect(rows, 'both check-ins reached the database').toHaveLength(2)
  for (const [stop, kind] of [[s1, 'plowed'], [s2, 'skipped']]) {
    const row = rows.find((r) => r.client_id === stop.client_id)
    expect(row?.kind, `${stop.name} is ${kind}`).toBe(kind)
    expect(row.at, `${stop.name}: at is the time the driver tapped, not the sync time`).toBe(iso(T))
    expect(row.at_adjusted).toBe(0)
    expect(row.received_at, 'received when signal came back').toBe(iso(T + 40 * MIN))
  }
  const stops = (await ownerStorm(request, token, storm.id)).trucks.find((t) => t.id === truck.id).stops
  expect(stops.find((s) => s.client_id === s1.client_id).checkin.photo, 'the photo followed').toBe('stored')
  expect(stops.find((s) => s.client_id === s2.client_id).checkin.reason_text).toBe('Car in the way')
})

test.describe(() => {
  // This test is about the queue, not the service worker. A controlled page's /api fetches can be made by the service worker,
  // where page.route cannot answer them (WebKit), so the 500 would never be served. Blocking the worker keeps it one path.
  test.use({ serviceWorkers: 'block' })

  test('a 500 when signal comes back leaves both queued; they send on the next try', async ({ page, context, request, seed }) => {
    const { storm, truck } = await driverOnline(page, context, request, seed, 'install', { worker: false })
    await context.setOffline(true)
    await twoCheckinsOffline(page, truck, { photo: false })
    await expect(page.locator('#sync-text')).toHaveText(/^No signal\. 2 check-ins saved on this phone\./)

    let posts = 0
    await page.route('**/api/driver/checkins', async (route) => {
      posts += 1
      if (posts === 1) {
        return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Something went wrong on our side. Try again in a minute.', code: 'server_error' }) })
      }
      return route.continue()
    })
    await context.setOffline(false)
    await expect(page.locator('#sync-text')).toHaveText(/^2 check-ins saved on this phone\. Could not send yet, trying again soon\./)
    expect(posts, 'one attempt, answered 500').toBe(1)
    expect(await dbCheckins(request, storm.id), 'still nothing on the server').toHaveLength(0)

    await page.clock.runFor(21_000) // the sender's next try
    await expect(page.locator('#sync-text')).toHaveText('All sent')
    expect(posts, 'the next try posted again').toBeGreaterThanOrEqual(2)
    expect(await dbCheckins(request, storm.id), 'both sent on the next try').toHaveLength(2)
  })
})
