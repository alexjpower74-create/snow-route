// Final screenshots of every screen for each project, into app/tests/shots/<project>-<screen>.png, on the Worker's demo data
// (POST /api/test/seed). Each screen is checked for its heading or key element before the picture, so a blank screen fails.
import { test, expect, tap, api, signIn, shot } from './helpers.mjs'

const pathOf = (url) => new URL(url).pathname + new URL(url).search

test('screenshots of every screen', async ({ page, context, request }, testInfo) => {
  test.setTimeout(180_000)
  const demo = await api(request, 'POST', '/api/test/seed', { data: { scenario: 'demo' } })
  expect(demo.status).toBe(200)
  const tiles = () => expect.poll(() => page.locator('.leaflet-tile-loaded').count()).toBeGreaterThan(0)

  await page.goto('/')
  await expect(page.locator('#owner-signin')).toBeVisible()
  await shot(page, testInfo, 'landing')

  await page.goto('/owner/')
  await expect(page.locator('#pin')).toBeVisible()
  await shot(page, testInfo, 'owner-signin')

  await signIn(page)
  await expect(page.locator('#order-note')).toBeVisible()
  await tiles()
  await shot(page, testInfo, 'owner-tonight')
  const firstRow = page.locator('.owner-stops > li').first()
  await tap(page, firstRow.locator('summary'), 'Texts to copy')
  await expect(firstRow.locator('.text-list')).toBeVisible()
  await tap(page, page.locator('#add-stop'), 'Add a stop')
  await expect(page.locator('#add-stop-form')).toBeVisible()
  await shot(page, testInfo, 'owner-tonight-add-stop', { fullPage: false })
  await tap(page, page.locator('#end-storm'), 'End storm')
  await expect(page.locator('#end-confirm')).toBeVisible()
  await shot(page, testInfo, 'owner-tonight-end-confirm', { fullPage: false })

  await tap(page, page.getByRole('link', { name: 'Clients' }), 'Clients')
  await expect(page.locator('#client-list > li')).toHaveCount(25)
  await tiles()
  await shot(page, testInfo, 'owner-clients')
  await tap(page, page.getByRole('button', { name: 'Edit Pat (SAMPLE)' }), 'Edit Pat')
  await expect(page.locator('#status-link-section')).toBeVisible()
  await shot(page, testInfo, 'owner-client-edit')

  await tap(page, page.getByRole('link', { name: 'Trucks' }), 'Trucks')
  await expect(page.locator('.truck-row')).toHaveCount(2)
  await tap(page, page.locator('.truck-row').first().getByRole('button', { name: 'New link' }), 'New link')
  await expect(page.locator('#truck-link-confirm')).toBeVisible()
  await shot(page, testInfo, 'owner-trucks')

  await tap(page, page.getByRole('link', { name: 'Billing' }), 'Billing')
  await expect(page.locator('#billing-table tbody tr').first()).toBeVisible()
  await shot(page, testInfo, 'owner-billing')

  await tap(page, page.getByRole('link', { name: 'Settings' }), 'Settings')
  await expect(page.locator('#pin-form')).toBeVisible()
  await tiles()
  await shot(page, testInfo, 'owner-settings')

  const token = await page.evaluate(() => localStorage.getItem('snow-route:owner-token'))
  const past = (await api(request, 'GET', '/api/owner/storms', { token })).body.storms.find((s) => s.status === 'ended')
  await page.goto(`/owner/#storm/${past.id}`)
  await expect(page.locator('#summary-skipped li').first()).toBeVisible()
  await shot(page, testInfo, 'owner-summary')

  await page.goto('/owner/#tonight')
  await tap(page, page.locator('#end-storm'), 'End storm')
  await tap(page, page.locator('#end-yes'), 'Yes, end the storm')
  await expect(page.locator('#summary')).toBeVisible()
  await tap(page, page.getByRole('link', { name: 'Back to Tonight' }), 'Back to Tonight')
  await expect(page.locator('#past-storms li').first()).toBeVisible()
  await shot(page, testInfo, 'owner-tonight-no-storm')
  await tap(page, page.locator('#start-storm'), 'Start a storm')
  await expect(page.locator('#pick-clients input:checked')).toHaveCount(25)
  await shot(page, testInfo, 'owner-start-storm')
  await tap(page, page.locator('#build-route'), "Build tonight's route")
  await expect(page.locator('#order-note')).toBeVisible()

  const driver = await context.newPage()
  await driver.goto(pathOf(demo.body.trucks[0].driver_url))
  await expect(driver.locator('#stop-name')).toBeVisible()
  await shot(driver, testInfo, 'driver')
  await tap(driver, driver.locator('#skip'), 'Skip this stop')
  await expect(driver.getByRole('dialog', { name: 'Why are you skipping?' })).toBeVisible()
  await shot(driver, testInfo, 'driver-skip-sheet', { fullPage: false })

  const status = await context.newPage()
  await status.goto(pathOf(demo.body.clients[0].status_url))
  await expect(status.locator('#answer')).toBeVisible()
  await shot(status, testInfo, 'status')
})
