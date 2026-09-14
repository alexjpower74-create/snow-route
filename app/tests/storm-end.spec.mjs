// Ending a storm from the owner side, against the real Worker: the inline confirm, the summary, the driver page afterwards,
// and the past-storms list.
import { test, expect, tap, api, ownerToken, startStorm, signIn } from './helpers.mjs'

test('End storm with the confirm → the summary lists the skip with its reason and the not-reached count; the driver sees no storm', async ({ page, context, request, seed }) => {
  const token = await ownerToken(request)
  const storm = await startStorm(request, token)
  const truck = storm.trucks[0]
  const key = seed.trucks.find((t) => t.id === truck.id).driver_key
  const [s1, s2] = truck.stops
  const total = storm.trucks.reduce((n, t) => n + t.stops.length, 0)

  // Arrange two check-ins through the driver API: one plowed, one skipped "Gate locked".
  const now = new Date().toISOString()
  const send = (body) => api(request, 'POST', '/api/driver/checkins', { headers: { 'X-Driver-Key': key }, data: { storm_id: storm.id, note: '', at: now, has_photo: false, ...body } })
  expect((await send({ id: '22222222-2222-4222-8222-222222222222', client_id: s1.client_id, kind: 'plowed' })).status).toBe(201)
  const skip = await send({ id: '33333333-3333-4333-8333-333333333333', client_id: s2.client_id, kind: 'skipped', reason: 'gate' })
  expect(skip.status).toBe(201)

  await signIn(page)
  await tap(page, page.locator('#end-storm'), 'End storm')
  await expect(page.locator('#end-confirm')).toContainText('End this storm?')
  await tap(page, page.getByRole('button', { name: 'Keep it going' }), 'Keep it going')
  await expect(page.locator('#end-confirm')).toHaveCount(0)
  expect((await api(request, 'GET', '/api/owner/storms/current', { token })).body.storm, 'still on after Keep it going').not.toBeNull()

  await tap(page, page.locator('#end-storm'), 'End storm')
  const ended = page.waitForResponse((r) => r.url().endsWith(`/api/owner/storms/${storm.id}/end`) && r.request().method() === 'POST')
  await tap(page, page.locator('#end-yes'), 'Yes, end the storm')
  expect((await ended).status()).toBe(200)

  const summary = page.locator('#summary')
  await expect(summary).toBeVisible()
  const skipped = page.locator('#summary-skipped li')
  await expect(skipped).toHaveCount(1)
  await expect(skipped).toContainText(s2.name)
  await expect(skipped.locator('.row-status')).toHaveText(`Gate locked at ${skip.body.checkin.at_label}`)
  await expect(skipped.getByRole('button', { name: 'Copy "skipped" text' })).toBeVisible()
  await expect(page.locator('#not-reached-count')).toHaveText(String(total - 2))
  await expect(page.locator('#summary-not-reached li')).toHaveCount(total - 2)
  await expect(page.locator('#sum-plowed')).toHaveText('1')
  const row = page.locator(`#summary-trucks tr[data-truck-id="${truck.id}"]`)
  await expect(row.locator('td').nth(0)).toHaveText('1')
  await expect(row.locator('td').nth(1)).toHaveText('1')
  await expect(row.locator('td').nth(2)).toHaveText(String(truck.stops.length - 2))

  const driver = await context.newPage()
  await driver.goto(`/d/?k=${key}`)
  await expect(driver.getByRole('heading', { name: 'No storm on right now' })).toBeVisible()

  await tap(page, page.getByRole('link', { name: 'Back to Tonight' }), 'Back to Tonight')
  await expect(page.getByText('No storm on right now.')).toBeVisible()
  const past = page.locator('#past-storms li')
  await expect(past).toHaveCount(1)
  await tap(page, past.getByRole('link', { name: /^Open the summary of / }), 'Open summary')
  await expect(page.locator('#summary-skipped li')).toContainText('Gate locked')
})

test('End storm refused because it ended on another screen: the confirm closes and that storm\'s summary shows the message', async ({ page, request }) => {
  const token = await ownerToken(request)
  const storm = await startStorm(request, token)
  await signIn(page)
  await tap(page, page.locator('#end-storm'), 'End storm')
  await expect(page.locator('#end-confirm')).toBeVisible()
  expect((await api(request, 'POST', `/api/owner/storms/${storm.id}/end`, { token })).status, 'ended on another screen').toBe(200)
  const answer = page.waitForResponse((r) => r.url().endsWith(`/api/owner/storms/${storm.id}/end`) && r.request().method() === 'POST')
  await tap(page, page.locator('#end-yes'), 'Yes, end the storm')
  const refused = await answer
  expect(refused.status()).toBe(409)
  await expect(page.locator('#summary')).toHaveAttribute('data-storm-id', String(storm.id))
  await expect(page.locator('#storm-notice')).toHaveText((await refused.json()).error)
  await expect(page.locator('#end-confirm')).toHaveCount(0)
})

test('Add a stop refused because the storm ended elsewhere: the form closes and Tonight repaints with the message', async ({ page, request }) => {
  const token = await ownerToken(request)
  const clients = (await api(request, 'GET', '/api/owner/clients', { token })).body.clients
  const trucks = (await api(request, 'GET', '/api/owner/trucks', { token })).body.trucks
  const left = clients.find((c) => c.name === 'Drew (SAMPLE)')
  const started = await api(request, 'POST', '/api/owner/storms', { token, data: { client_ids: clients.filter((c) => c !== left).map((c) => c.id), truck_ids: trucks.map((t) => t.id) } })
  expect(started.status).toBe(201)
  await signIn(page)
  await tap(page, page.locator('#add-stop'), 'Add a stop')
  await page.locator('#stop-client').selectOption(String(left.id))
  expect((await api(request, 'POST', `/api/owner/storms/${started.body.id}/end`, { token })).status).toBe(200)
  const answer = page.waitForResponse((r) => r.url().endsWith(`/api/owner/storms/${started.body.id}/stops`) && r.request().method() === 'POST')
  await tap(page, page.locator('#add-stop-save'), 'Add to the end of that route')
  const refused = await answer
  expect(refused.status()).toBe(409)
  await expect(page.locator('#storm-notice')).toHaveText((await refused.json()).error)
  await expect(page.getByText('No storm on right now.')).toBeVisible()
  await expect(page.locator('#add-stop-form')).toHaveCount(0)
})

test('while a storm is on, Past storms opens the list and each summary', async ({ page, request }) => {
  const token = await ownerToken(request)
  const first = await startStorm(request, token)
  expect((await api(request, 'POST', `/api/owner/storms/${first.id}/end`, { token })).status).toBe(200)
  await startStorm(request, token)
  await signIn(page)
  await expect(page.locator('#order-note')).toBeVisible()
  await tap(page, page.locator('#past-storms-link'), 'Past storms')
  const past = page.locator('#past-storms li')
  await expect(past).toHaveCount(1)
  await expect(past).toHaveAttribute('data-storm-id', String(first.id))
  await tap(page, past.getByRole('link', { name: /^Open the summary of / }), 'Open summary')
  await expect(page.locator('#summary')).toHaveAttribute('data-storm-id', String(first.id))
})
