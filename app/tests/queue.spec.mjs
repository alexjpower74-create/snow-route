// Queue edge cases against the real Worker (API.md clarifications 17, 19, 20, 24): a truck link reset while check-ins wait on the
// phone, a queued check-in whose stop moved to the other truck, and Undo on a check-in the server refused.
// The service worker is blocked here: these tests are about the queue, and page.route must see every /api request (in WebKit a
// controlled page's fetches are made by the worker, where page.route cannot answer them).
import { test, expect, tap, api, ownerToken, startStorm, ownerStorm, dbCheckins } from './helpers.mjs'

test.use({ serviceWorkers: 'block' })

const T = Date.parse('2026-09-14T09:00:00.000Z') // 6:30 AM NDT
const MIN = 60_000
const iso = (ms) => new Date(ms).toISOString()
const pathOf = (url) => new URL(url).pathname + new URL(url).search

async function driverAtT(page, context, request, seed) {
  const token = await ownerToken(request)
  const storm = await startStorm(request, token, { 'X-Test-Now': iso(T - 5 * MIN) })
  const truck = storm.trucks[0]
  const key = seed.trucks.find((t) => t.id === truck.id).driver_key
  await context.setExtraHTTPHeaders({ 'X-Test-Now': iso(T) })
  await page.clock.setFixedTime(T)
  await page.goto(`/d/?k=${key}`)
  await expect(page.locator('#stop-name')).toHaveText(truck.stops[0].name)
  await expect(page.locator('#sync-text')).toHaveText('All sent')
  return { token, storm, truck, key }
}

test('a truck link reset while check-ins wait: the new link sends them, with the time the driver tapped', async ({ page, context, request, seed }) => {
  const { token, storm, truck, key } = await driverAtT(page, context, request, seed)
  const [s1, s2, s3] = truck.stops

  await context.setOffline(true)
  await tap(page, page.locator('#plowed-nophoto'), 'Plowed, no photo (no signal)')
  await expect(page.locator('#stop-name')).toHaveText(s2.name)
  await expect(page.locator('#skip')).toBeEnabled()
  await tap(page, page.locator('#skip'), 'Skip this stop (no signal)')
  await tap(page, page.getByRole('button', { name: 'Gate locked', exact: true }), 'Gate locked')
  await expect(page.locator('#stop-name')).toHaveText(s3.name)
  await expect(page.locator('#sync-text')).toHaveText(/^No signal\. 2 check-ins saved on this phone\./)

  // The owner taps "New link" for this truck. The phone's two check-ins were saved under the old key.
  const reset = await api(request, 'POST', `/api/owner/trucks/${truck.id}/reset-link`, { token })
  expect(reset.status).toBe(200)
  const newKey = new URL(reset.body.driver_url).searchParams.get('k')
  expect(newKey).not.toBe(key)

  // Hold every check-in POST until released, so the screen can be read while the items wait.
  let release
  const gate = new Promise((r) => { release = r })
  const keysSent = []
  await page.route('**/api/driver/checkins', async (route) => {
    keysSent.push(route.request().headers()['x-driver-key'])
    await gate
    await route.continue().catch(() => {}) // a request from the page that navigated away is gone
  })

  // Forty minutes later, with signal, the driver opens the new link the owner sent.
  await page.clock.setFixedTime(T + 40 * MIN)
  await context.setExtraHTTPHeaders({ 'X-Test-Now': iso(T + 40 * MIN) })
  await context.setOffline(false)
  await page.goto(pathOf(reset.body.driver_url))
  await expect(page.locator('#stop-name'), 'the new link shows the route with the saved check-ins on it').toHaveText(s3.name)
  const oldLink = page.locator('#old-link')
  await expect(oldLink).toContainText('Saved under an old driver link')
  await expect(oldLink.locator('li')).toHaveCount(2)
  await expect(oldLink).toContainText(s1.name)
  await expect(oldLink).toContainText(s2.name)
  await expect(page.locator('#sync-text'), 'the page\'s own link works, so no dead-link text').not.toContainText("doesn't work any more")

  release()
  await expect(page.locator('#sync-text')).toHaveText('All sent', { timeout: 30_000 })
  await expect(oldLink).toHaveCount(0)
  expect(keysSent, 'sent with the new link').toContain(newKey)

  const rows = await dbCheckins(request, storm.id)
  expect(rows, 'both check-ins reached the database').toHaveLength(2)
  for (const [stop, kind] of [[s1, 'plowed'], [s2, 'skipped']]) {
    const row = rows.find((r) => r.client_id === stop.client_id)
    expect(row?.kind, `${stop.name} is ${kind}`).toBe(kind)
    expect(row.at, `${stop.name}: the time the driver tapped`).toBe(iso(T))
    expect(row.received_at).toBe(iso(T + 40 * MIN))
    expect(row.truck_id).toBe(truck.id)
  }
  const view = (await ownerStorm(request, token, storm.id)).trucks.find((t) => t.id === truck.id).stops
  expect(view.find((s) => s.client_id === s2.client_id).checkin.reason_text).toBe('Gate locked')
})

test('a queued check-in whose stop moved to the other truck stays visible, and Undo takes it back', async ({ page, context, request, seed }) => {
  const { token, storm, truck } = await driverAtT(page, context, request, seed)
  const [s1, s2] = truck.stops

  await context.setOffline(true)
  await tap(page, page.locator('#plowed-nophoto'), 'Plowed, no photo (no signal)')
  await expect(page.locator('#stop-name')).toHaveText(s2.name)

  // The owner moves that stop to the other truck.
  const view = await ownerStorm(request, token, storm.id)
  const other = view.trucks.find((t) => t.id !== truck.id)
  const moved = await api(request, 'PUT', `/api/owner/storms/${storm.id}/route`, {
    token,
    data: { route_version: view.route_version, trucks: [
      { truck_id: truck.id, client_ids: view.trucks.find((t) => t.id === truck.id).stops.map((s) => s.client_id).filter((id) => id !== s1.client_id) },
      { truck_id: other.id, client_ids: [...other.stops.map((s) => s.client_id), s1.client_id] },
    ] },
  })
  expect(moved.status, 'route PUT').toBe(200)

  // Signal comes back for the route, but check-ins still cannot get through, so the item stays queued.
  await page.route('**/api/driver/checkins', (route) => route.abort('internetdisconnected'))
  await context.setOffline(false)
  const row = page.locator('#other-route li', { hasText: s1.name })
  await expect(page.locator('#other-route')).toContainText('Saved for stops on another route')
  await expect(row).toContainText('Plowed at 6:30 AM')
  await expect(page.locator(`.stop-row[data-client="${s1.client_id}"]`), 'no longer on this route').toHaveCount(0)
  await expect(page.locator('#sync-text')).toHaveText(/1 check-in saved on this phone/)

  await tap(page, row.getByRole('button', { name: 'Undo' }), 'Undo (other route)')
  // It has not been sent, so Undo asks first (clarification 28).
  await expect(row).toContainText('This check-in has not reached the office yet. Delete it from this phone?')
  await tap(page, row.getByRole('button', { name: 'Delete it' }), 'Delete it')
  await expect(page.locator('#other-route')).toHaveCount(0)
  await page.unroute('**/api/driver/checkins')
  await expect(page.locator('#sync-text')).toHaveText('All sent')
  expect(await dbCheckins(request, storm.id), 'taken back before it was sent: nothing on the server').toHaveLength(0)
})

test('Undo on a check-in the server refused only removes it from the phone', async ({ page, context, request, seed }) => {
  const { storm, truck, key } = await driverAtT(page, context, request, seed)
  const s1 = truck.stops[0]
  const deletes = []
  page.on('request', (r) => { if (r.method() === 'DELETE') deletes.push(r.url()) })

  await context.setOffline(true)
  await tap(page, page.locator('#plowed-nophoto'), 'Plowed, no photo (no signal)')
  await expect(page.locator('#undo-btn')).toBeVisible()

  // Meanwhile the same stop is marked plowed by another check-in (another phone on this truck).
  const first = await api(request, 'POST', '/api/driver/checkins', {
    headers: { 'X-Driver-Key': key, 'X-Test-Now': iso(T) },
    data: { id: '11111111-1111-4111-8111-111111111111', storm_id: storm.id, client_id: s1.client_id, kind: 'plowed', note: '', at: iso(T), has_photo: false },
  })
  expect(first.status).toBe(201)

  await context.setOffline(false)
  const refused = page.locator('#not-accepted')
  await expect(refused).toContainText('This stop is already marked plowed.')
  await tap(page, page.locator('#undo-btn'), 'Undo (refused check-in)')
  await expect(refused).toHaveCount(0)
  await expect(page.locator('#sync-text')).toHaveText('All sent')
  await page.waitForTimeout(500)
  expect(deletes, 'no undo is sent for a check-in the server never stored').toEqual([])
  const rows = await dbCheckins(request, storm.id)
  expect(rows).toHaveLength(1)
  expect(rows[0].voided_at, 'the other check-in stands').toBeNull()
})

test('two open tabs of the same driver link: one check-in ends as one stored push, never voided, and no DELETE is sent', async ({ page, context, request, seed }) => {
  const { storm, truck, key } = await driverAtT(page, context, request, seed)
  const s1 = truck.stops[0]
  const deletes = []
  const posts = []
  context.on('request', (r) => {
    if (r.method() === 'DELETE') deletes.push(r.url())
    if (r.method() === 'POST' && r.url().endsWith('/api/driver/checkins')) posts.push(r.url())
  })
  // Hold every check-in POST, so the second tab's sender runs while the first tab's send is still on its way.
  let release
  const gate = new Promise((r) => { release = r })
  await context.route('**/api/driver/checkins', async (route) => {
    await gate
    await route.continue().catch(() => {})
  })

  const second = await context.newPage()
  await second.goto(`/d/?k=${key}`)
  await expect(second.locator('#stop-name')).toHaveText(s1.name)

  await tap(page, page.locator('#plowed-nophoto'), 'Plowed, no photo (tab 1)')
  await expect(page.locator('#stop-name')).toHaveText(truck.stops[1].name)
  await expect.poll(() => posts.length, { message: 'tab 1 is sending' }).toBeGreaterThanOrEqual(1)
  // Tab 2 opens the link again: its sender starts and finds the same check-in in the shared queue.
  await second.reload()
  await expect(second.locator('#stop-name')).toBeVisible()
  await second.waitForTimeout(1500)

  release()
  await expect(page.locator('#sync-text')).toHaveText('All sent', { timeout: 30_000 })
  await expect(second.locator('#sync-text')).toHaveText('All sent', { timeout: 30_000 })
  await page.waitForTimeout(1500) // time for any wrongly queued undo to be sent

  const rows = await dbCheckins(request, storm.id)
  expect(rows, 'one check-in stored').toHaveLength(1)
  expect(rows[0].voided_at, 'the push was not voided').toBeNull()
  expect(deletes, 'nobody tapped Undo, so no DELETE').toEqual([])
  expect(posts.length, 'the Web Lock let one tab send at a time').toBe(1)
})
