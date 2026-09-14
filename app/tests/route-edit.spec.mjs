// Editing tonight's route from the owner side, against the real Worker. Every change goes through the route PUT and the
// drivers see it.
import { test, expect, tap, api, hitTest, ownerToken, startStorm, ownerStorm, signIn } from './helpers.mjs'

const rowsOf = (page, truckId) => page.locator(`.owner-stops[data-truck-id="${truckId}"] > li`)
const namesOf = (page, truckId) => rowsOf(page, truckId).locator('.row-name').allTextContents()
const orderOf = async (request, token, stormId, truckId) =>
  (await ownerStorm(request, token, stormId)).trucks.find((t) => t.id === truckId).stops.map((s) => s.name)

async function stormWithout(request, token, leaveOut) {
  const clients = (await api(request, 'GET', '/api/owner/clients', { token })).body.clients
  const trucks = (await api(request, 'GET', '/api/owner/trucks', { token })).body.trucks
  const r = await api(request, 'POST', '/api/owner/storms', {
    token, data: { client_ids: clients.filter((c) => c.name !== leaveOut).map((c) => c.id), truck_ids: trucks.map((t) => t.id) },
  })
  expect(r.status).toBe(201)
  return { storm: r.body, left: clients.find((c) => c.name === leaveOut) }
}

test('a real mouse drag of stop 3 above stop 1 saves the order; it stays after a reload and the driver sees it @desktop', async ({ page, context, request, seed }) => {
  const token = await ownerToken(request)
  const storm = await startStorm(request, token)
  const truck = storm.trucks[0]
  const names = truck.stops.map((s) => s.name)
  await signIn(page)
  await expect(rowsOf(page, truck.id)).toHaveCount(names.length)

  const handle = rowsOf(page, truck.id).nth(2).locator('.drag-handle')
  await handle.scrollIntoViewIfNeeded()
  const { x, y, hit } = await hitTest(handle)
  expect(hit, 'the drag handle of stop 3 is on top').toBe('')
  const first = await rowsOf(page, truck.id).nth(0).boundingBox()
  const saved = page.waitForResponse((r) => r.url().endsWith(`/api/owner/storms/${storm.id}/route`) && r.request().method() === 'PUT')
  await page.mouse.move(x, y)
  await page.mouse.down()
  const toY = first.y + 6
  for (let i = 1; i <= 15; i++) await page.mouse.move(x, y + ((toY - y) * i) / 15)
  await page.mouse.up()
  expect((await saved).status(), 'route PUT').toBe(200)

  const expected = [names[2], names[0], names[1], ...names.slice(3)]
  await expect.poll(() => namesOf(page, truck.id)).toEqual(expected)
  expect(await orderOf(request, token, storm.id, truck.id), 'the Worker has the new order').toEqual(expected)
  await page.reload()
  await expect.poll(() => namesOf(page, truck.id), { message: 'the order stays after a reload' }).toEqual(expected)

  const driver = await context.newPage()
  await driver.goto(`/d/?k=${seed.trucks.find((t) => t.id === truck.id).driver_key}`)
  await expect(driver.locator('#counter')).toHaveText(`Stop 1 of ${names.length}`)
  await expect(driver.locator('#stop-name'), 'the driver sees the dragged stop first').toHaveText(names[2])
})

test('Move up, Move down, and Move to the other truck; the other driver sees the moved stop @phone', async ({ page, context, request, seed }) => {
  const token = await ownerToken(request)
  const storm = await startStorm(request, token)
  const [t1, t2] = storm.trucks
  const names = t1.stops.map((s) => s.name)
  await signIn(page)
  await expect(rowsOf(page, t1.id)).toHaveCount(names.length)
  await expect(rowsOf(page, t1.id).first().getByRole('button', { name: 'Move up' })).toBeDisabled()

  await tap(page, rowsOf(page, t1.id).nth(1).getByRole('button', { name: 'Move up' }), 'Move up (stop 2)')
  await expect.poll(() => namesOf(page, t1.id)).toEqual([names[1], names[0], ...names.slice(2)])
  expect(await orderOf(request, token, storm.id, t1.id)).toEqual([names[1], names[0], ...names.slice(2)])

  await tap(page, rowsOf(page, t1.id).nth(0).getByRole('button', { name: 'Move down' }), 'Move down (stop 1)')
  await expect.poll(() => namesOf(page, t1.id)).toEqual(names)
  expect(await orderOf(request, token, storm.id, t1.id)).toEqual(names)

  const moving = names[3]
  await tap(page, rowsOf(page, t1.id).nth(3).getByRole('button', { name: `Move to ${t2.name}` }), `Move to ${t2.name}`)
  await expect(rowsOf(page, t1.id)).toHaveCount(names.length - 1)
  await expect(rowsOf(page, t2.id).last().locator('.row-name')).toHaveText(moving)
  expect((await orderOf(request, token, storm.id, t2.id)).at(-1)).toBe(moving)

  const other = await context.newPage()
  await other.goto(`/d/?k=${seed.trucks.find((t) => t.id === t2.id).driver_key}`)
  await expect(other.locator('.stop-row .row-name').last(), 'the other truck\'s driver has the stop last').toHaveText(moving)
  const first = await context.newPage()
  await first.goto(`/d/?k=${seed.trucks.find((t) => t.id === t1.id).driver_key}`)
  await expect(first.locator('.stop-row')).toHaveCount(names.length - 1)
  await expect(first.locator('.stop-row', { hasText: moving })).toHaveCount(0)
})

test('a route changed on another screen: the move is refused, the page reloads the route and says so', async ({ page, request }) => {
  const token = await ownerToken(request)
  const { storm, left } = await stormWithout(request, token, 'Drew (SAMPLE)')
  const truck = storm.trucks[0]
  await signIn(page)
  await expect(rowsOf(page, truck.id)).toHaveCount(truck.stops.length)

  const added = await api(request, 'POST', `/api/owner/storms/${storm.id}/stops`, { token, data: { client_id: left.id, truck_id: truck.id } })
  expect(added.status, 'a stop added from another screen').toBe(200)

  const answer = page.waitForResponse((r) => r.url().endsWith(`/api/owner/storms/${storm.id}/route`) && r.request().method() === 'PUT')
  await tap(page, rowsOf(page, truck.id).nth(1).getByRole('button', { name: 'Move up' }), 'Move up (stale route)')
  const refused = await answer
  expect(refused.status(), 'a route edited from a stale screen is 409, not a malformed request').toBe(409)
  const body = await refused.json()
  expect(body.code).toBe('bad_state')
  expect(body.error).toBe('The route changed while you were editing it. Reload and try again.')
  await expect(page.locator('#storm-notice')).toHaveText('The route changed while you were editing it. Reload and try again.')
  await expect(rowsOf(page, truck.id), 'reloaded: the added stop is there').toHaveCount(truck.stops.length + 1)
  await expect(rowsOf(page, truck.id).last().locator('.row-name')).toHaveText(left.name)
})

test('Add a stop puts the client at the end of the chosen truck', async ({ page, request }) => {
  const token = await ownerToken(request)
  const { storm, left } = await stormWithout(request, token, 'Drew (SAMPLE)')
  const t2 = storm.trucks[1]
  await signIn(page)
  await tap(page, page.locator('#add-stop'), 'Add a stop')
  await page.locator('#stop-client').selectOption(String(left.id))
  await page.locator('#stop-truck').selectOption(String(t2.id))
  await tap(page, page.locator('#add-stop-save'), 'Add to the end of that route')
  await expect(rowsOf(page, t2.id)).toHaveCount(t2.stops.length + 1)
  await expect(rowsOf(page, t2.id).last().locator('.row-name')).toHaveText(left.name)
  expect((await orderOf(request, token, storm.id, t2.id)).at(-1)).toBe(left.name)
})

test('Remove from tonight: only on stops with no check-ins, behind a confirm; a check-in that lands first keeps the stop, with the message on it', async ({ page, context, request, seed }) => {
  const token = await ownerToken(request)
  const storm = await startStorm(request, token)
  const truck = storm.trucks[0]
  const key = seed.trucks.find((t) => t.id === truck.id).driver_key
  const [s1, s2, s3] = truck.stops
  const checkin = (id, client, kind, extra = {}) => api(request, 'POST', '/api/driver/checkins', { headers: { 'X-Driver-Key': key },
    data: { id, storm_id: storm.id, client_id: client, kind, note: '', at: new Date().toISOString(), has_photo: false, ...extra } })
  expect((await checkin('44444444-4444-4444-8444-444444444444', s1.client_id, 'plowed')).status).toBe(201)

  await signIn(page)
  const row = (c) => page.locator(`.owner-stops li[data-client-id="${c}"]`)
  await expect(row(s1.client_id).getByRole('button', { name: 'Remove from tonight' }), 'a stop with a check-in has no Remove').toHaveCount(0)

  await tap(page, row(s2.client_id).getByRole('button', { name: 'Remove from tonight' }), 'Remove from tonight (stop 2)')
  await expect(row(s2.client_id)).toContainText(`Take ${s2.name} off tonight's route?`)
  await tap(page, row(s2.client_id).getByRole('button', { name: 'Keep it' }), 'Keep it')
  await expect(row(s2.client_id)).toHaveCount(1)
  await tap(page, row(s2.client_id).getByRole('button', { name: 'Remove from tonight' }), 'Remove from tonight (stop 2)')
  const removed = page.waitForResponse((r) => r.url().endsWith(`/stops/${s2.client_id}`) && r.request().method() === 'DELETE')
  await tap(page, row(s2.client_id).getByRole('button', { name: 'Yes, remove it' }), 'Yes, remove it')
  expect((await removed).status()).toBe(200)
  await expect(row(s2.client_id)).toHaveCount(0)
  expect(await orderOf(request, token, storm.id, truck.id)).not.toContain(s2.name)
  const driver = await context.newPage()
  await driver.goto(`/d/?k=${key}`)
  await expect(driver.locator('.stop-row', { hasText: s2.name })).toHaveCount(0)

  // Stop 3 gets a check-in after the page showed its Remove button.
  await tap(page, row(s3.client_id).getByRole('button', { name: 'Remove from tonight' }), 'Remove from tonight (stop 3)')
  expect((await checkin('55555555-5555-4555-8555-555555555555', s3.client_id, 'skipped', { reason: 'gate' })).status).toBe(201)
  const refusedAnswer = page.waitForResponse((r) => r.url().endsWith(`/stops/${s3.client_id}`) && r.request().method() === 'DELETE')
  await tap(page, row(s3.client_id).getByRole('button', { name: 'Yes, remove it' }), 'Yes, remove it (stop 3)')
  const refused = await refusedAnswer
  expect(refused.status()).toBe(409)
  await expect(row(s3.client_id).locator('.stop-error')).toHaveText((await refused.json()).error)
  await expect(row(s3.client_id).getByRole('button', { name: 'Remove from tonight' }), 'reloaded: it has a check-in now').toHaveCount(0)
})
