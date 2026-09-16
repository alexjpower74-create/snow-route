// The client status page against the real Worker.
import { test, expect, tap, api, ownerToken, startStorm, ownerStorm, choosePhoto, shot } from './helpers.mjs'

test('waiting says the same stop number as the driver list; after the plow: Plowed at h:mm AM and the photo', async ({
  page,
  context,
  request,
  seed,
}, testInfo) => {
  const token = await ownerToken(request)
  const storm = await startStorm(request, token)
  const truck = storm.trucks[0]
  const key = seed.trucks.find((t) => t.id === truck.id).driver_key
  const [s1, s2] = truck.stops
  const client = seed.clients.find((c) => c.id === s2.client_id)

  await page.clock.install()
  const driver = await context.newPage()
  await driver.goto(`/d/?k=${key}`)
  const row = driver.locator(`.stop-row[data-client="${s2.client_id}"]`)
  await expect(row.locator('.row-name')).toHaveText(s2.name)
  const driverNumber = (await row.locator('.num').textContent()).trim()

  await page.goto(new URL(client.status_url).pathname + new URL(client.status_url).search)
  await expect(page.locator('[data-sample]')).toBeVisible()
  await expect(page.locator('#answer')).toHaveText(`On the route tonight. You're stop ${driverNumber}.`)
  expect(driverNumber).toBe('2')
  await expect(page.getByText('No stops are done yet.')).toBeVisible()
  await shot(page, testInfo, 'status-waiting')

  // The driver plows stop 1 (no photo) and stop 2 (with a photo).
  await driver.bringToFront()
  await tap(driver, driver.locator('#plowed-nophoto'), 'Plowed, no photo')
  await expect(driver.locator('#stop-name')).toHaveText(s2.name)
  await expect(driver.locator('#plowed-nophoto')).toBeEnabled()
  await choosePhoto(driver, driver.locator('#plowed'), 'Plowed')
  await expect(driver.locator('#stop-name')).toHaveText(truck.stops[2].name) // the photo check-in is recorded
  await expect(driver.locator('#sync-text')).toHaveText('All sent')
  await page.bringToFront()

  // The open status page checks again on its own within a minute.
  await page.clock.runFor(61_000)
  const stop = (await ownerStorm(request, token, storm.id)).trucks
    .find((t) => t.id === truck.id)
    .stops.find((s) => s.client_id === s2.client_id)
  await expect(page.locator('#answer')).toHaveText(`Plowed at ${stop.checkin.at_label}`)
  await expect(page.locator('#answer')).toHaveText(/^Plowed at \d{1,2}:\d{2} [AP]M$/)
  await expect
    .poll(() => page.locator('#photo').evaluate((img) => img.complete && img.naturalWidth), { message: 'the photo loads' })
    .toBeGreaterThan(0)
  await shot(page, testInfo, 'status-plowed')
})

test('a bad status link shows the plain message', async ({ page }) => {
  await page.goto('/s/?k=not-a-real-status-key-000')
  await expect(page.locator('#answer')).toHaveText("This status link doesn't work. Ask your snow clearing company for a new one.")
  await expect(page.locator('[data-sample]')).toBeVisible()
})

test('a mangled link (trailing dot) shows the bad-link text, and after that 404 the page stops checking', async ({
  page,
  request,
  seed,
}) => {
  const good = new URL(seed.clients[0].status_url)
  const lookups = []
  page.on('request', (r) => {
    if (r.url().includes('/api/status/')) lookups.push(r.url())
  })
  // Headless Playwright never changes visibilityState on a tab switch (probed in chromium and webkit), so the test dispatches the
  // event itself. First it proves the page listens: on a good link one dispatch makes one more lookup.
  const returnToTab = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await page.goto(good.pathname + good.search)
  await expect(page.locator('#answer')).toBeVisible()
  const before = lookups.length
  await returnToTab()
  await expect.poll(() => lookups.length, { message: 'a good link checks again when the tab comes back' }).toBe(before + 1)

  // A messaging app glued a dot onto the link.
  const answer = await api(request, 'GET', `/api/status/${good.searchParams.get('k')}.`)
  expect(answer.status, 'the Worker answers the mangled key 404').toBe(404)
  await page.goto(good.pathname + good.search + '.')
  await expect(page.locator('#answer')).toHaveText("This status link doesn't work. Ask your snow clearing company for a new one.")
  await expect(page.locator('[data-sample]')).toBeVisible()
  const after = lookups.length
  await returnToTab()
  await returnToTab()
  await page.waitForTimeout(1500)
  expect(lookups.length, 'no lookup after the 404').toBe(after)
})
