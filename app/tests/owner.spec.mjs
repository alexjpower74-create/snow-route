// The owner side on sr1's M1 routes, against the real Worker.
import { test, expect, tap, tapAt, typeText, api, ownerToken, startStorm, signIn, hitTest, shot } from './helpers.mjs'

test('a wrong PIN says so, and the sign-in answer is 401', async ({ page }) => {
  await page.goto('/owner/')
  await expect(page.locator('[data-sample]')).toBeVisible()
  await typeText(page, page.locator('#pin'), '1111', 'PIN')
  const answer = page.waitForResponse((r) => r.url().endsWith('/api/owner/signin') && r.request().method() === 'POST')
  await tap(page, page.locator('#signin-btn'), 'Sign in')
  expect((await answer).status(), 'POST /api/owner/signin with a wrong PIN').toBe(401)
  await expect(page.locator('#pin-error')).toHaveText('That PIN is not right.')
  await expect(page.locator('#signout')).toHaveCount(0)

  await typeText(page, page.locator('#pin'), '2468', 'PIN')
  await tap(page, page.locator('#signin-btn'), 'Sign in')
  await expect(page.getByRole('heading', { name: 'Tonight' })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('snow-route:owner-token')), 'token kept on this device').toBeTruthy()
  await tap(page, page.locator('#signout'), 'Sign out')
  await expect(page.locator('#pin')).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('snow-route:owner-token'))).toBeNull()
})

test('add a client by typing and tapping the map: it shows in the list and on the map', async ({ page, request }, testInfo) => {
  await signIn(page)
  await tap(page, page.getByRole('link', { name: 'Clients' }), 'Clients tab')
  await expect(page.locator('#client-list > li')).toHaveCount(25)
  await expect(page.locator('.leaflet-marker-icon.pin-client')).toHaveCount(25)
  await expect.poll(() => page.locator('.leaflet-tile-loaded').count(), { message: 'placeholder tiles load' }).toBeGreaterThan(0)
  await shot(page, testInfo, 'owner-clients')

  await tap(page, page.locator('#add-client'), 'Add a client')
  await typeText(page, page.locator('#f-name'), 'Morgan New (SAMPLE)', 'Name')
  await typeText(page, page.locator('#f-address'), 'Lincoln Road, Grand Falls-Windsor, NL', 'Address')
  await page.locator('#f-type').selectOption('walkway')
  await page.locator('#f-priority').selectOption('commuter')
  await typeText(page, page.locator('#f-price'), '42.50', 'Price')

  // No pin yet: the API's own message shows by the pin.
  const refused = page.waitForResponse((r) => r.url().endsWith('/api/owner/clients') && r.request().method() === 'POST')
  await tap(page, page.locator('#save-client'), 'Save client')
  expect((await refused).status()).toBe(400)
  await expect(page.locator('#err-lat')).toHaveText('Put a pin on the map for this client.')

  await tapAt(page, page.locator('#map'), 0.5, 0.5, 'the map')
  await expect(page.locator('#pin-state')).toHaveText(/^Pin placed at 4\d\.\d+, -5\d\.\d+\. Drag it to move it\.$/)
  await expect(page.locator('#err-lat')).toBeHidden()
  await shot(page, testInfo, 'owner-client-form')
  await tap(page, page.locator('#save-client'), 'Save client')

  await expect(page.locator('#client-list')).toContainText('Morgan New (SAMPLE)')
  await expect(page.locator('#client-list > li')).toHaveCount(26)
  await expect(page.locator('.leaflet-marker-icon[title="Morgan New (SAMPLE)"]')).toHaveCount(1)
  const row = page.locator('.client-row', { hasText: 'Morgan New (SAMPLE)' })
  await expect(row).toContainText('Walkway')
  await expect(row).toContainText('Early commuter')
  await expect(row).toContainText('$42.50 per push')

  const token = await ownerToken(request)
  const saved = (await api(request, 'GET', '/api/owner/clients', { token })).body.clients.find((c) => c.name === 'Morgan New (SAMPLE)')
  expect(saved, 'the client is stored').toBeTruthy()
  expect(saved.price_cents).toBe(4250)
  expect(saved.type).toBe('walkway')
  expect(saved.lat).toBeGreaterThan(48.8)
  expect(saved.lat).toBeLessThan(49.1)
  expect(saved.lng).toBeGreaterThan(-55.8)
  expect(saved.lng).toBeLessThan(-55.5)
})

test('start a storm: medical stops first on each truck, the order note, the route on the map with its attribution', async ({ page }, testInfo) => {
  await signIn(page)
  await expect(page.getByText('No storm on right now.')).toBeVisible()
  await tap(page, page.locator('#start-storm'), 'Start a storm')
  await expect(page.locator('#pick-clients input:checked')).toHaveCount(25)
  await tap(page, page.getByRole('button', { name: 'Untick all', exact: true }), 'Untick all')
  await expect(page.locator('#pick-clients input:checked')).toHaveCount(0)
  await expect(page.locator('#client-count')).toHaveText('0 of 25 ticked')
  await tap(page, page.getByRole('button', { name: 'Tick all', exact: true }), 'Tick all')
  await expect(page.locator('#pick-clients input:checked')).toHaveCount(25)
  await expect(page.locator('#pick-trucks input:checked')).toHaveCount(2)
  await tap(page, page.locator('#build-route'), "Build tonight's route")

  await expect(page.locator('#order-note')).toHaveText('Order is by distance, not road time.')
  const trucks = page.locator('.truck-stops')
  await expect(trucks).toHaveCount(2)
  for (let i = 0; i < 2; i++) {
    const priorities = await trucks.nth(i).locator('.stop-row').evaluateAll((rows) => rows.map((r) => r.dataset.priority))
    const lastMedical = priorities.lastIndexOf('medical')
    const firstOther = priorities.findIndex((p) => p !== 'medical')
    expect(priorities[0], `truck ${i + 1}: stop 1 is medical`).toBe('medical')
    expect(lastMedical, `truck ${i + 1}: every medical stop comes before the rest (${priorities.join(', ')})`).toBeLessThan(firstOther)
    await expect(trucks.nth(i).locator('.stop-row').first().locator('.chip-priority')).toHaveText('Medical')
  }
  await expect(page.locator('.route-pin')).toHaveCount(25)
  const attribution = page.locator('.leaflet-control-attribution')
  await expect(attribution).toBeVisible()
  await expect(attribution).toContainText('OpenStreetMap')
  await expect(attribution.getByRole('link', { name: 'OpenStreetMap' })).toHaveAttribute('href', 'https://www.openstreetmap.org/copyright')
  await attribution.scrollIntoViewIfNeeded()
  expect((await hitTest(attribution.getByRole('link', { name: 'OpenStreetMap' }))).hit, 'nothing covers the attribution').toBe('')
  await shot(page, testInfo, 'owner-tonight')
})

test('trucks: each driver link with Copy link', async ({ page, seed }, testInfo) => {
  await signIn(page)
  await tap(page, page.getByRole('link', { name: 'Trucks' }), 'Trucks tab')
  await expect(page.locator('.truck-row')).toHaveCount(2)
  for (const t of seed.trucks) await expect(page.locator(`#link-${t.id}`)).toHaveValue(t.driver_url)
  const copy = page.locator('.truck-row').first().getByRole('button', { name: 'Copy link' })
  await tap(page, copy, 'Copy link')
  // Chromium grants nothing here, so the page either says Copied or selects the link and says how to copy it. Both are real outcomes.
  await expect(page.locator('.truck-row').first()).toContainText(/Copied|copy it from there/)
  await shot(page, testInfo, 'owner-trucks')
})

test('a storm started on another screen: Build shows the running storm with the API message', async ({ page, request }) => {
  await signIn(page)
  await tap(page, page.locator('#start-storm'), 'Start a storm')
  await expect(page.locator('#pick-clients input:checked')).toHaveCount(25)
  await startStorm(request, await ownerToken(request)) // the owner's other device
  const answer = page.waitForResponse((r) => r.url().endsWith('/api/owner/storms') && r.request().method() === 'POST')
  await tap(page, page.locator('#build-route'), "Build tonight's route")
  const refused = await answer
  expect(refused.status()).toBe(409)
  const body = await refused.json()
  expect(body.code).toBe('bad_state')
  await expect(page.locator('#storm-notice')).toHaveText(body.error)
  await expect(page.locator('#storm-form'), 'the picker is closed').toHaveCount(0)
  await expect(page.locator('#order-note')).toHaveText('Order is by distance, not road time.')
  await expect(page.locator('.truck-stops')).toHaveCount(2)
})

test('price input: .50 and 45. are prices; 4.5.0 is refused on the form without sending', async ({ page, request }) => {
  const puts = []
  page.on('request', (r) => { if (r.method() === 'PUT' && r.url().includes('/api/owner/clients/')) puts.push(r.url()) })
  await signIn(page)
  await tap(page, page.getByRole('link', { name: 'Clients' }), 'Clients tab')
  const token = await ownerToken(request)
  const priceOf = async (name) => (await api(request, 'GET', '/api/owner/clients', { token })).body.clients.find((c) => c.name === name).price_cents
  const setPrice = async (text) => {
    await tap(page, page.getByRole('button', { name: 'Edit Alex (SAMPLE)' }), 'Edit Alex')
    await tap(page, page.locator('#f-price'), 'Price')
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type(text)
    await tap(page, page.locator('#save-client'), 'Save client')
  }

  await setPrice('4.5.0')
  await expect(page.locator('#err-price_cents')).toHaveText('Type a price in dollars and cents.')
  expect(puts, 'nothing sent for a price that is not one').toEqual([])
  await tap(page, page.getByRole('button', { name: 'Cancel' }), 'Cancel')

  await setPrice('.50')
  await expect(page.locator('.client-row', { hasText: 'Alex (SAMPLE)' })).toContainText('$0.50 per push')
  expect(await priceOf('Alex (SAMPLE)')).toBe(50)

  await setPrice('45.')
  await expect(page.locator('.client-row', { hasText: 'Alex (SAMPLE)' })).toContainText('$45.00 per push')
  expect(await priceOf('Alex (SAMPLE)')).toBe(4500)
  expect(puts).toHaveLength(2)
})

test('at 1280 the map stays on screen while the long route list scrolls, and the Clients map explains its pin colours @desktop', async ({ page, request }) => {
  await startStorm(request, await ownerToken(request))
  await signIn(page)
  await expect(page.locator('.route-pin')).toHaveCount(25)
  const map = page.locator('#map')
  const vh = page.viewportSize().height
  // Real wheel input, well past the top of the map's column.
  await page.mouse.move(300, 400)
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, 500)
    await page.waitForTimeout(80)
  }
  expect(await page.evaluate(() => window.scrollY), 'the page scrolled').toBeGreaterThan(1500)
  const box = await map.boundingBox()
  expect(box.y, 'map top is on screen').toBeGreaterThanOrEqual(0)
  expect(box.y + box.height, 'map bottom is on screen').toBeLessThanOrEqual(vh)
  expect((await hitTest(map)).hit, 'nothing covers the map').toBe('')
  const attribution = map.locator('.leaflet-control-attribution')
  await expect(attribution).toBeInViewport()

  await tap(page, page.getByRole('link', { name: 'Clients' }), 'Clients tab')
  await expect(page.locator('.leaflet-marker-icon.pin-client')).toHaveCount(25)
  const legend = page.locator('#clients-legend')
  await expect(legend).toContainText('Client')
  await expect(legend).toContainText('Medical client (goes first)')
  await expect(legend).toContainText('Yard')
  const medical = await page.locator('.leaflet-marker-icon.pin-client.is-medical').first().evaluate((el) => getComputedStyle(el).backgroundColor)
  const plainPin = await page.locator('.leaflet-marker-icon.pin-client:not(.is-medical)').first().evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(medical, 'medical pins use the text token').toBe('rgb(238, 243, 251)')
  expect(plainPin, 'client pins use the accent token').toBe('rgb(124, 196, 255)')
  const legendMedical = await legend.locator('.legend-dot.is-medical').evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(legendMedical, 'the legend dot matches the pin').toBe(medical)
})
