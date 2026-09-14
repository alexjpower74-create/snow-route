// Tap targets, the SAMPLE badge, no sideways scroll, action colour contrast, and a check that the network guard can fail.
import { test, expect, tap, hitTest, ownerToken, startStorm, signIn, guard, contrast, rgb } from './helpers.mjs'

async function bigAndOnTop(locator, label) {
  await locator.scrollIntoViewIfNeeded()
  const { box, hit } = await hitTest(locator)
  expect(box, `${label}: has a box`).not.toBeNull()
  expect(box.height, `${label}: at least 56 px tall`).toBeGreaterThanOrEqual(56)
  expect(box.width, `${label}: at least 56 px wide`).toBeGreaterThanOrEqual(56)
  expect(hit, `${label}: hit-tests to itself`).toBe('')
}

test('every driver button is at least 56 px and hit-tests to itself at 390 @phone', async ({ page, request, seed }) => {
  const token = await ownerToken(request)
  const storm = await startStorm(request, token)
  const truck = storm.trucks[0]
  await page.goto(`/d/?k=${seed.trucks.find((t) => t.id === truck.id).driver_key}`)
  await expect(page.locator('#stop-name')).toHaveText(truck.stops[0].name)
  for (const [sel, label] of [['#navigate', 'Navigate'], ['#plowed', 'Plowed'], ['#plowed-nophoto', 'Plowed, no photo'], ['#skip', 'Skip this stop']]) {
    await bigAndOnTop(page.locator(sel), label)
  }
  await tap(page, page.locator('#skip'), 'Skip this stop')
  for (const label of ['Car in the way', 'Gate locked', 'Client cancelled', 'Other', 'Back']) {
    await bigAndOnTop(page.getByRole('button', { name: label, exact: true }), label)
  }
  await tap(page, page.getByRole('button', { name: 'Other', exact: true }), 'Other')
  await bigAndOnTop(page.locator('#skip-note'), 'note field')
  await bigAndOnTop(page.locator('#skip-other'), 'Skip this stop (with a note)')
  await tap(page, page.locator('#skip-other'), 'Skip this stop (with a note)')
  await bigAndOnTop(page.locator('#undo-btn'), 'Undo')
  await bigAndOnTop(page.getByRole('button', { name: 'Plowed now' }), 'Plowed now')
  await expect(page.locator('#plowed-nophoto')).toBeEnabled()
  await tap(page, page.getByRole('button', { name: 'Plowed now' }), 'Plowed now')
  await bigAndOnTop(page.locator('#back-next'), 'Back to the next stop')
})

test('the SAMPLE badge and the company name are on every page', async ({ page, request, seed }) => {
  await ownerToken(request)
  const pages = [
    ['/', 'landing'],
    ['/owner/', 'owner sign-in'],
    [`/d/?k=${seed.trucks[0].driver_key}`, 'driver'],
    [new URL(seed.clients[0].status_url).pathname + new URL(seed.clients[0].status_url).search, 'client status'],
  ]
  for (const [url, label] of pages) {
    await page.goto(url)
    await expect(page.locator('[data-sample]').first(), `${label}: SAMPLE badge`).toBeVisible()
    await expect(page.locator('[data-sample]').first()).toHaveText('SAMPLE')
    await expect(page.locator('[data-company-name]').first(), `${label}: company`).toHaveText('SAMPLE Snow Clearing — Grand Falls-Windsor (demo)')
  }
})

test('no horizontal scroll at 390 on any screen @phone', async ({ page, request, seed }) => {
  const token = await ownerToken(request)
  await startStorm(request, token)
  const wide = async (label) => {
    const [scroll, inner] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth])
    expect(scroll, `${label}: page is ${scroll} px wide in a ${inner} px window`).toBeLessThanOrEqual(inner)
  }
  for (const [url, label] of [['/', 'landing'], [`/d/?k=${seed.trucks[0].driver_key}`, 'driver'], [new URL(seed.clients[3].status_url).pathname + new URL(seed.clients[3].status_url).search, 'status']]) {
    await page.goto(url)
    await expect(page.locator('[data-sample]').first()).toBeVisible()
    await wide(label)
  }
  await signIn(page)
  await expect(page.locator('#order-note')).toBeVisible()
  await wide('owner tonight')
  await tap(page, page.getByRole('link', { name: 'Clients' }), 'Clients')
  await expect(page.locator('#client-list > li')).toHaveCount(25)
  await wide('owner clients')
  await tap(page, page.locator('#add-client'), 'Add a client')
  await expect(page.locator('#f-name')).toBeVisible()
  await wide('owner client form')
  await tap(page, page.getByRole('link', { name: 'Trucks' }), 'Trucks')
  await expect(page.locator('.truck-row')).toHaveCount(2)
  await wide('owner trucks')
})

test('the action colours meet 4.5 : 1', async ({ page, request, seed }) => {
  const token = await ownerToken(request)
  const storm = await startStorm(request, token)
  await page.goto(`/d/?k=${seed.trucks.find((t) => t.id === storm.trucks[0].id).driver_key}`)
  await expect(page.locator('#stop-name')).toBeVisible()
  for (const [sel, label, bg, ink] of [['#navigate', 'Navigate', '#1d4ed8', '#ffffff'], ['#plowed', 'Plowed', '#15803d', '#ffffff'], ['#skip', 'Skip this stop', '#f59e0b', '#1a1200']]) {
    const [b, c] = await page.locator(sel).evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).color])
    const hex = (s) => '#' + rgb(s).map((n) => n.toString(16).padStart(2, '0')).join('')
    expect(hex(b), `${label} background is the Design token`).toBe(bg)
    expect(hex(c), `${label} text is the Design token`).toBe(ink)
    const ratio = contrast(rgb(b), rgb(c))
    expect(ratio, `${label}: ${ratio.toFixed(2)} : 1`).toBeGreaterThanOrEqual(4.5)
  }
  // The measure itself can fail: the Design's muted grey on the Skip amber is far below 4.5 : 1.
  expect(contrast(rgb('rgb(163, 179, 204)'), rgb('rgb(245, 158, 11)'))).toBeLessThan(4.5)
})

test('the network guard fails a request to another host and answers tiles locally', async ({ browser }) => {
  const context = await browser.newContext()
  const g = await guard(context)
  const page = await context.newPage()
  await page.goto('about:blank')
  const tile = await page.evaluate(() => fetch('https://tile.openstreetmap.org/13/2779/2870.png').then((r) => r.status + ' ' + r.headers.get('content-type')).catch((e) => String(e)))
  expect(tile, 'tile answered by the placeholder').toBe('200 image/png')
  expect(g.outside).toEqual([])
  await page.evaluate(() => fetch('https://example.com/').catch(() => null))
  expect(g.outside, 'a request to another host is caught').toEqual(['https://example.com/'])
  await context.close()
})
