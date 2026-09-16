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

test('a truck link reset while check-ins wait: the new link sends them, with the time the driver tapped', async ({
  page,
  context,
  request,
  seed,
}) => {
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
  const gate = new Promise((r) => {
    release = r
  })
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
  await expect(page.locator('#sync-text'), "the page's own link works, so no dead-link text").not.toContainText("doesn't work any more")

  release()
  await expect(page.locator('#sync-text')).toHaveText('All sent', { timeout: 30_000 })
  await expect(oldLink).toHaveCount(0)
  expect(keysSent, 'sent with the new link').toContain(newKey)

  const rows = await dbCheckins(request, storm.id)
  expect(rows, 'both check-ins reached the database').toHaveLength(2)
  for (const [stop, kind] of [
    [s1, 'plowed'],
    [s2, 'skipped'],
  ]) {
    const row = rows.find((r) => r.client_id === stop.client_id)
    expect(row?.kind, `${stop.name} is ${kind}`).toBe(kind)
    expect(row.at, `${stop.name}: the time the driver tapped`).toBe(iso(T))
    expect(row.received_at).toBe(iso(T + 40 * MIN))
    expect(row.truck_id).toBe(truck.id)
  }
  const view = (await ownerStorm(request, token, storm.id)).trucks.find((t) => t.id === truck.id).stops
  expect(view.find((s) => s.client_id === s2.client_id).checkin.reason_text).toBe('Gate locked')
})

test('a queued check-in whose stop moved to the other truck stays visible, and Undo takes it back', async ({
  page,
  context,
  request,
  seed,
}) => {
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
    data: {
      route_version: view.route_version,
      trucks: [
        {
          truck_id: truck.id,
          client_ids: view.trucks
            .find((t) => t.id === truck.id)
            .stops.map((s) => s.client_id)
            .filter((id) => id !== s1.client_id),
        },
        { truck_id: other.id, client_ids: [...other.stops.map((s) => s.client_id), s1.client_id] },
      ],
    },
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
  // The sender already tried it (signal back, POST failed), so the Worker may have it: Undo it sends a DELETE, answered 404 and dropped quietly.
  await expect(row).toContainText('It may already be at the office. Undo it?')
  await tap(page, row.getByRole('button', { name: 'Undo it' }), 'Undo it')
  await expect(page.locator('#other-route')).toHaveCount(0)
  await page.unroute('**/api/driver/checkins')
  await context.setOffline(true)
  await context.setOffline(false) // signal back: the sender re-sends the check-in, then the DELETE
  await expect.poll(async () => (await dbCheckins(request, storm.id)).map((r) => !!r.voided_at), { timeout: 30_000 }).toEqual([true])
  await expect(page.locator('#sync-text')).toHaveText('All sent')
  // It was tried, so the undo re-sent it and voided it (clarification 49): stored, voided, never billed.
  const storedRows = await dbCheckins(request, storm.id)
  expect(
    storedRows.map((r) => !!r.voided_at),
    'taken back: stored and voided',
  ).toEqual([true])
})

test('Undo on a check-in the server refused only removes it from the phone', async ({ page, context, request, seed }) => {
  const { storm, truck, key } = await driverAtT(page, context, request, seed)
  const s1 = truck.stops[0]
  const deletes = []
  page.on('request', (r) => {
    if (r.method() === 'DELETE') deletes.push(r.url())
  })

  await context.setOffline(true)
  await tap(page, page.locator('#plowed-nophoto'), 'Plowed, no photo (no signal)')
  await expect(page.locator('#undo-btn')).toBeVisible()

  // Meanwhile the same stop is marked plowed by another check-in (another phone on this truck).
  const first = await api(request, 'POST', '/api/driver/checkins', {
    headers: { 'X-Driver-Key': key, 'X-Test-Now': iso(T) },
    data: {
      id: '11111111-1111-4111-8111-111111111111',
      storm_id: storm.id,
      client_id: s1.client_id,
      kind: 'plowed',
      note: '',
      at: iso(T),
      has_photo: false,
    },
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

for (const locks of [true, false]) {
  test(`two open tabs of the same driver link: one check-in ends as one stored push, never voided, and no DELETE is sent${locks ? '' : ' (without Web Locks)'}`, async ({
    page,
    context,
    request,
    seed,
  }) => {
    // Without Web Locks (older phones) both tabs may send the same check-in: the rule "missing after 200/201 is not undone" alone must hold (clarification 41).
    if (!locks) await context.addInitScript(() => Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true }))
    const { storm, truck, key } = await driverAtT(page, context, request, seed)
    if (!locks) expect(await page.evaluate(() => navigator.locks), 'Web Locks removed').toBeUndefined()
    const s1 = truck.stops[0]
    const deletes = []
    const posts = []
    context.on('request', (r) => {
      if (r.method() === 'DELETE') deletes.push(r.url())
      if (r.method() === 'POST' && r.url().endsWith('/api/driver/checkins')) posts.push(r.url())
    })
    // Hold every check-in POST, so the second tab's sender runs while the first tab's send is still on its way.
    let release
    const gate = new Promise((r) => {
      release = r
    })
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
    // Without Web Locks both tabs must be at the gate at once, or the run proves nothing (clarification 51).
    if (!locks) await expect.poll(() => posts.length, { message: 'both tabs are sending: the race is set up' }).toBe(2)

    release()
    await expect(page.locator('#sync-text')).toHaveText('All sent', { timeout: 30_000 })
    await expect(second.locator('#sync-text')).toHaveText('All sent', { timeout: 30_000 })
    await page.waitForTimeout(1500) // time for any wrongly queued undo to be sent

    const rows = await dbCheckins(request, storm.id)
    expect(rows, 'one check-in stored').toHaveLength(1)
    expect(rows[0].voided_at, 'the push was not voided').toBeNull()
    expect(deletes, 'nobody tapped Undo, so no DELETE').toEqual([])
    if (locks) expect(posts.length, 'the Web Lock let one tab send at a time').toBe(1)
    else expect(posts.length, 'without the lock both tabs sent it').toBe(2)
  })
}

test("a photo and an undo saved under truck 1's link, that link reset, truck 2's link opened: both are listed as another truck's and nothing is sent under truck 2's key", async ({
  page,
  context,
  request,
  seed,
}) => {
  const { token, storm, truck, key } = await driverAtT(page, context, request, seed)
  const other = storm.trucks.find((t) => t.id !== truck.id)
  const key2 = seed.trucks.find((t) => t.id === other.id).driver_key
  const [s1, s2, s3] = truck.stops
  const writes = []
  context.on('request', (r) => {
    if (['PUT', 'DELETE'].includes(r.method()) && r.url().includes('/api/driver/checkins/'))
      writes.push({ method: r.method(), key: r.headers()['x-driver-key'] })
  })
  // Photos and undos cannot get through for now; check-in POSTs can.
  // ** so the photo PUT (/checkins/<id>/photo) is held back as well as the undo DELETE (/checkins/<id>).
  await context.route('**/api/driver/checkins/**', (route) => route.abort('internetdisconnected'))

  // Stop 1: Plowed, no photo, sent.
  await tap(page, page.locator('#plowed-nophoto'), 'Plowed, no photo (stop 1)')
  await expect(page.locator('#stop-name')).toHaveText(s2.name)
  await expect(page.locator('#sync-text')).toHaveText('All sent')
  // A second tab on truck 1's link plows stop 2 with a photo: the check-in is sent, the photo waits.
  const tab2 = await context.newPage()
  await tab2.goto(`/d/?k=${key}`)
  await expect(tab2.locator('#stop-name')).toHaveText(s2.name)
  const chooser = tab2.waitForEvent('filechooser')
  await tap(tab2, tab2.locator('#plowed'), 'Plowed with a photo (stop 2, tab 2)')
  const { PHOTO } = await import('./helpers.mjs')
  await (await chooser).setFiles(PHOTO)
  await expect(tab2.locator('#stop-name')).toHaveText(s3.name)
  await expect(tab2.locator('#sync-text')).toHaveText(/1 photo saved on this phone/)
  await tab2.close()
  // Back in tab 1, Undo stop 1 (it reached the server, so no question): the undo waits too.
  await tap(page, page.locator('#undo-btn'), 'Undo (stop 1)')
  await expect(page.locator('#undo-delete')).toHaveCount(0)
  await expect(page.locator('#stop-name')).toHaveText(s1.name)

  // The owner resets truck 1's link; truck 2's link is opened on this phone. From now on nothing is held back: anything sent reaches the Worker.
  expect((await api(request, 'POST', `/api/owner/trucks/${truck.id}/reset-link`, { token })).status).toBe(200)
  await context.unroute('**/api/driver/checkins/**')
  await page.goto(`/d/?k=${key2}`)
  await expect(page.locator('#stop-name')).toHaveText(other.stops[0].name)
  const old = page.locator('#old-link')
  await expect(old.locator('li')).toHaveCount(2, { timeout: 30_000 })
  await expect(old.locator('li', { hasText: s2.name })).toContainText(
    "This photo belongs to another truck's link, so this link cannot send it.",
  )
  await expect(old.locator('li', { hasText: s1.name })).toContainText(
    "This undo belongs to another truck's link, so this link cannot send it.",
  )
  await page.waitForTimeout(1500)
  expect(
    writes.filter((w) => w.key === key2),
    "no PUT or DELETE under truck 2's key",
  ).toEqual([])

  const rows = await dbCheckins(request, storm.id)
  expect(rows.find((r) => r.client_id === s1.client_id).voided_at, 'the undo was never sent to a truck that cannot take it').toBeNull()
  const view = (await ownerStorm(request, token, storm.id)).trucks.find((t) => t.id === truck.id).stops
  expect(view.find((s) => s.client_id === s2.client_id).checkin.photo, 'the photo was never sent').toBe('waiting')
})

test('a check-in queued before the owner ended the storm reads as that storm, still sending, and Undo asks before deleting it', async ({
  page,
  context,
  request,
  seed,
}) => {
  const { token, storm, truck } = await driverAtT(page, context, request, seed)
  const s1 = truck.stops[0]
  await context.setOffline(true)
  await tap(page, page.locator('#plowed-nophoto'), 'Plowed, no photo (no signal)')
  await expect(page.locator('#stop-name')).toHaveText(truck.stops[1].name)

  expect((await api(request, 'POST', `/api/owner/storms/${storm.id}/end`, { token })).status).toBe(200)
  await page.route('**/api/driver/checkins', (route) => route.abort('internetdisconnected'))
  await context.setOffline(false)
  await expect(page.getByRole('heading', { name: 'No storm on right now' })).toBeVisible()
  const ended = page.locator('#ended-storm')
  await expect(ended).toContainText('Saved from the storm that ended, still sending')
  await expect(ended.locator('li', { hasText: s1.name })).toContainText('Plowed at 6:30 AM')
  await expect(page.locator('#other-route'), 'not "moved off this route"').toHaveCount(0)

  await tap(page, ended.getByRole('button', { name: 'Undo' }), 'Undo (ended storm)')
  await expect(ended).toContainText('It may already be at the office. Undo it?')
  await tap(page, ended.getByRole('button', { name: 'Keep it' }), 'Keep it')
  await expect(ended.getByRole('button', { name: 'Undo' })).toBeVisible()

  await page.unroute('**/api/driver/checkins')
  await tap(page, page.getByRole('button', { name: 'Check again' }), 'Check again')
  await expect(page.locator('#sync-text')).toHaveText('All sent', { timeout: 30_000 })
  await expect(ended).toHaveCount(0)
  const rows = await dbCheckins(request, storm.id)
  expect(rows, 'kept, and accepted after the storm ended').toHaveLength(1)
  expect(rows[0].voided_at).toBeNull()
})

test('a photo refused for a stop that then moved off this route keeps a Photo not sent row until it is dismissed', async ({
  page,
  context,
  request,
  seed,
}) => {
  const { token, storm, truck } = await driverAtT(page, context, request, seed)
  const [s1, s2] = truck.stops
  // The Worker's own 413 text. The page downscales photos, so a real one never gets that big: the answer is served locally.
  await context.route('**/api/driver/checkins/*/photo', (route) =>
    route.fulfill({
      status: 413,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'That photo is too big. It has to be under 5 MB.', code: 'too_large' }),
    }),
  )
  const { PHOTO } = await import('./helpers.mjs')
  const chooser = page.waitForEvent('filechooser')
  await tap(page, page.locator('#plowed'), 'Plowed with a photo (stop 1)')
  await (await chooser).setFiles(PHOTO)
  await expect(page.locator('#stop-name')).toHaveText(s2.name)
  await expect(page.locator('#sync-text')).toHaveText('All sent')
  await expect(page.locator(`.stop-row[data-client="${s1.client_id}"] .row-status`)).toContainText('Photo not sent: That photo is too big.')

  const view = await ownerStorm(request, token, storm.id)
  const otherTruck = view.trucks.find((t) => t.id !== truck.id)
  const moved = await api(request, 'PUT', `/api/owner/storms/${storm.id}/route`, {
    token,
    data: {
      route_version: view.route_version,
      trucks: [
        {
          truck_id: truck.id,
          client_ids: view.trucks
            .find((t) => t.id === truck.id)
            .stops.map((s) => s.client_id)
            .filter((id) => id !== s1.client_id),
        },
        { truck_id: otherTruck.id, client_ids: [...otherTruck.stops.map((s) => s.client_id), s1.client_id] },
      ],
    },
  })
  expect(moved.status).toBe(200)

  await page.reload()
  const note = page.locator('#photos-not-sent li', { hasText: s1.name })
  await expect(note).toContainText('Photo not sent: That photo is too big. It has to be under 5 MB.')
  await tap(page, note.getByRole('button', { name: 'Dismiss' }), 'Dismiss')
  await expect(page.locator('#photos-not-sent')).toHaveCount(0)
  await expect(page.locator('#other-route'), 'never under wording about moved stops').toHaveCount(0)
})

test('the Worker stored the check-in but the answer is lost: Undo (after its question) still voids it', async ({
  page,
  request,
  context,
  seed,
}) => {
  const { storm, truck } = await driverAtT(page, context, request, seed)
  // The POST reaches the Worker and is stored; the phone never hears back.
  let first = true
  await page.route('**/api/driver/checkins', async (route) => {
    if (!first) return route.continue()
    first = false
    await route.fetch()
    await route.abort('internetdisconnected')
  })
  await tap(page, page.locator('#plowed-nophoto'), 'Plowed, no photo')
  await expect(page.locator('#stop-name')).toHaveText(truck.stops[1].name)
  await expect.poll(async () => (await dbCheckins(request, storm.id)).length, { message: 'the Worker stored it' }).toBe(1)
  await expect(page.locator('#sync-text')).toHaveText(/^No signal\. 1 check-in saved on this phone\./)

  await tap(page, page.locator('#undo-btn'), 'Undo')
  await expect(page.locator('#undo-confirm-text')).toHaveText('It may already be at the office. Undo it?')
  await tap(page, page.locator('#undo-delete'), 'Undo it')
  await expect
    .poll(async () => (await dbCheckins(request, storm.id))[0]?.voided_at ?? null, {
      message: 'the tapped Undo reached the Worker: the push is voided',
      timeout: 30_000,
    })
    .not.toBeNull()
  await expect(page.locator('#sync-text')).toHaveText('All sent', { timeout: 30_000 })
  expect(await dbCheckins(request, storm.id)).toHaveLength(1)
})

test('a check-in tried but never stored: Undo stores it and voids it at once (the check-in is re-sent first), so it never bills', async ({
  page,
  request,
  context,
  seed,
}) => {
  const { storm, truck } = await driverAtT(page, context, request, seed)
  const deletes = []
  page.on('request', (r) => {
    if (r.method() === 'DELETE') deletes.push(r.url())
  })
  await page.route('**/api/driver/checkins', (route) => route.abort('internetdisconnected'))
  await tap(page, page.locator('#plowed-nophoto'), 'Plowed, no photo')
  await expect(page.locator('#sync-text')).toHaveText(/^No signal\. 1 check-in saved on this phone\./)
  await tap(page, page.locator('#undo-btn'), 'Undo')
  await expect(page.locator('#undo-confirm-text')).toHaveText('It may already be at the office. Undo it?')
  await tap(page, page.locator('#undo-delete'), 'Undo it')
  await page.unroute('**/api/driver/checkins')
  await page.context().setOffline(true)
  await page.context().setOffline(false) // signal back: the sender re-sends the check-in, then the DELETE (clarification 49)
  await expect.poll(async () => (await dbCheckins(request, storm.id)).map((r) => !!r.voided_at), { timeout: 30_000 }).toEqual([true])
  await expect(page.locator('#sync-text')).toHaveText('All sent')
  await expect(page.locator('#not-accepted')).toHaveCount(0)
  await expect(page.locator('#stop-name')).toHaveText(truck.stops[0].name)
  expect(deletes, 'the re-send with undo: true stored it voided, so no DELETE (clarification 52)').toEqual([])
})

test('a check-in POST that never answers gives up after 30 s as no signal, stays saved, and sends later @phone', async ({
  page,
  request,
  context,
  seed,
}) => {
  test.setTimeout(120_000)
  const { storm } = await driverAtT(page, context, request, seed)
  // No switch in the app: the request simply never gets an answer, and the page's own AbortSignal.timeout(30000) must end it.
  await page.route('**/api/driver/checkins', () => {})
  const started = Date.now()
  await tap(page, page.locator('#plowed-nophoto'), 'Plowed, no photo')
  await expect(page.locator('#sync-text')).toHaveText(/^Sending 1 check-in/)
  await expect(page.locator('#sync-text')).toHaveText(/^No signal\. 1 check-in saved on this phone\./, { timeout: 45_000 })
  const waited = Date.now() - started
  expect(waited, `gave up after ${waited} ms`).toBeGreaterThanOrEqual(29_000)
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  await context.setOffline(true)
  await context.setOffline(false) // signal "comes back": the sender tries at once
  await expect(page.locator('#sync-text')).toHaveText('All sent', { timeout: 30_000 })
  const rows = await dbCheckins(request, storm.id)
  expect(rows).toHaveLength(1)
  expect(rows[0].voided_at).toBeNull()
})

test('an Undo tapped while the check-in is on its way, sent by another tab without Web Locks, re-sends the check-in first and voids it', async ({
  page,
  context,
  request,
  seed,
}) => {
  await context.addInitScript(() => Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true }))
  const { storm, truck, key } = await driverAtT(page, context, request, seed)
  // Tab A's POST is held before it reaches the Worker.
  let release
  const gate = new Promise((r) => {
    release = r
  })
  let held = 0
  await page.route('**/api/driver/checkins', async (route) => {
    held += 1
    await gate
    await route.continue().catch(() => {})
  })
  await tap(page, page.locator('#plowed-nophoto'), 'Plowed, no photo (tab A)')
  await expect(page.locator('#stop-name')).toHaveText(truck.stops[1].name)
  await expect.poll(() => held, { message: "tab A's POST is on its way" }).toBe(1)
  await tap(page, page.locator('#undo-btn'), 'Undo (tab A)')
  await expect(page.locator('#undo-confirm-text')).toHaveText('It may already be at the office. Undo it?')
  await tap(page, page.locator('#undo-delete'), 'Undo it')

  // Tab B opens the link: its sender finds the undone item and sends the undo while tab A is still waiting.
  const tabB = await context.newPage()
  const deletes = []
  tabB.on('response', (r) => {
    if (r.request().method() === 'DELETE') deletes.push(r.status())
  })
  await tabB.goto(`/d/?k=${key}`)
  // Tab A's POST never reached the office, so tab B's re-send (undo: true) stores the check-in already voided and needs no DELETE.
  await expect
    .poll(async () => (await dbCheckins(request, storm.id)).map((r) => !!r.voided_at), {
      message: "tab B's re-send stored it voided before tab A's POST arrived",
      timeout: 30_000,
    })
    .toEqual([true])
  expect(deletes, 'no DELETE needed').toEqual([])
  release()
  await expect.poll(async () => (await dbCheckins(request, storm.id)).map((r) => !!r.voided_at), { timeout: 30_000 }).toEqual([true])
  await page.waitForTimeout(1500) // tab A's late POST answers duplicate and must change nothing
  expect(
    (await dbCheckins(request, storm.id)).map((r) => !!r.voided_at),
    'one check-in, voided: the tapped Undo was not lost',
  ).toEqual([true])
})

test("an item an older build saved without truck_id is matched to its truck through the keys store and listed as another truck's", async ({
  page,
  context,
  request,
  seed,
}) => {
  const { token, storm, truck, key } = await driverAtT(page, context, request, seed)
  const other = storm.trucks.find((t) => t.id !== truck.id)
  const key2 = seed.trucks.find((t) => t.id === other.id).driver_key
  const s2 = truck.stops[1]
  expect(
    await page.evaluate((k) => JSON.parse(localStorage.getItem('snow-route:keys'))[k], key),
    'the keys store maps the link to its truck',
  ).toBe(truck.id)
  // Off the driver page (no sender running), arrange the data an older build left: a photo waiting, with no truck_id.
  await page.goto('/')
  await page.evaluate(
    ({ key, stormId, clientId, label, at }) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('snow-route', 1)
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const t = open.result.transaction('queue', 'readwrite')
          t.objectStore('queue').put({
            qid: '66666666-6666-4666-8666-666666666666',
            seq: 1,
            created_at: at,
            key,
            op: 'checkin',
            state: 'photo',
            label,
            body: {
              id: '66666666-6666-4666-8666-666666666666',
              storm_id: stormId,
              client_id: clientId,
              kind: 'plowed',
              note: '',
              at,
              has_photo: true,
            },
            photo: { bytes: new Uint8Array([255, 216, 255, 217]).buffer, type: 'image/jpeg' },
            error: null,
          })
          t.oncomplete = () => resolve(true)
          t.onerror = () => reject(t.error)
        }
      }),
    { key, stormId: storm.id, clientId: s2.client_id, label: s2.name, at: new Date(T).toISOString() },
  )

  expect((await api(request, 'POST', `/api/owner/trucks/${truck.id}/reset-link`, { token })).status).toBe(200)
  const writes = []
  context.on('request', (r) => {
    if (r.method() === 'PUT' && r.headers()['x-driver-key'] === key2) writes.push(r.url())
  })
  await page.goto(`/d/?k=${key2}`)
  const row = page.locator('#old-link li', { hasText: s2.name })
  await expect(row).toContainText("This photo belongs to another truck's link, so this link cannot send it.", { timeout: 30_000 })
  expect(writes, "never sent under the other truck's key").toEqual([])
})

test("the keys store re-keys an older build's item on the same truck: truck 1's new link sends the waiting photo", async ({
  page,
  context,
  request,
  seed,
}) => {
  const { token, storm, truck, key } = await driverAtT(page, context, request, seed)
  const s2 = truck.stops[1]
  const id = '88888888-8888-4888-8888-888888888888'
  // A real check-in on the office for stop 2, its photo still to come (as an older build would have left it).
  expect(
    (
      await api(request, 'POST', '/api/driver/checkins', {
        headers: { 'X-Driver-Key': key },
        data: { id, storm_id: storm.id, client_id: s2.client_id, kind: 'plowed', note: '', at: new Date(T).toISOString(), has_photo: true },
      })
    ).status,
  ).toBe(201)
  await page.goto('/')
  await page.evaluate(
    ({ key, id, stormId, clientId, label, at }) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('snow-route', 1)
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const t = open.result.transaction('queue', 'readwrite')
          t.objectStore('queue').put({
            qid: id,
            seq: 1,
            created_at: at,
            key,
            op: 'checkin',
            state: 'photo',
            label,
            attempted: true,
            body: { id, storm_id: stormId, client_id: clientId, kind: 'plowed', note: '', at, has_photo: true },
            photo: { bytes: new Uint8Array([255, 216, 255, 217]).buffer, type: 'image/jpeg' },
            error: null,
          })
          t.oncomplete = () => resolve(true)
          t.onerror = () => reject(t.error)
        }
      }),
    { key, id, stormId: storm.id, clientId: s2.client_id, label: s2.name, at: new Date(T).toISOString() },
  )

  const reset = await api(request, 'POST', `/api/owner/trucks/${truck.id}/reset-link`, { token })
  expect(reset.status).toBe(200)
  const newKey = new URL(reset.body.driver_url).searchParams.get('k')
  const puts = []
  context.on('request', (r) => {
    if (r.method() === 'PUT') puts.push(r.headers()['x-driver-key'])
  })
  // Truck 1's NEW link: its route overwrites truck 1's saved route, so only the keys store still knows the old key was truck 1.
  await page.goto(`/d/?k=${newKey}`)
  await expect
    .poll(
      async () =>
        (await ownerStorm(request, token, storm.id)).trucks.find((t) => t.id === truck.id).stops.find((s) => s.client_id === s2.client_id)
          .checkin.photo,
      { message: 'the waiting photo was sent and stored', timeout: 30_000 },
    )
    .toBe('stored')
  expect(puts, 'sent under the new key').toContain(newKey)
  await expect(page.locator('#old-link li', { hasText: "belongs to another truck's link" })).toHaveCount(0)
  await expect(page.locator('#sync-text')).toHaveText('All sent')
})
