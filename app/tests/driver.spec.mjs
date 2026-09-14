// The driver page against the real Worker: the route as built, Navigate, Plowed with a photo, Skip with a reason, what the
// owner then sees, and Undo of a check-in the server already has.
import { test, expect, tap, ownerToken, startStorm, ownerStorm, dbCheckins, choosePhoto, shot } from './helpers.mjs'

test('driver link: Stop 1 is medical, Navigate, Plowed with a photo, Skip → Gate locked, and the owner sees both', async ({ page, request, seed }, testInfo) => {
  const token = await ownerToken(request)
  const storm = await startStorm(request, token)
  const truck = storm.trucks[0]
  const key = seed.trucks.find((t) => t.id === truck.id).driver_key
  const [s1, s2, s3] = truck.stops
  const n = truck.stops.length

  await page.goto(`/d/?k=${key}`)
  await expect(page.locator('#counter')).toHaveText(`Stop 1 of ${n}`)
  await expect(page.locator('#stop-name')).toHaveText(s1.name)
  expect(s1.priority, 'the Worker put a medical stop first').toBe('medical')
  await expect(page.locator('#stop .chip-priority')).toHaveText('Medical')
  await expect(page.locator('#stop-address')).toHaveText(s1.address)
  const apple = testInfo.project.name === 'webkit-390'
  const enc = encodeURIComponent(s1.address)
  await expect(page.locator('#navigate')).toHaveAttribute('href', apple
    ? `https://maps.apple.com/?daddr=${enc}&dirflg=d`
    : `https://www.google.com/maps/dir/?api=1&destination=${enc}`)
  await expect(page.locator('#navigate')).toHaveAttribute('target', '_blank')
  await expect(page.locator('#sync-text')).toHaveText('All sent')
  await shot(page, testInfo, 'driver-stop-1')

  await choosePhoto(page, page.locator('#plowed'), 'Plowed')
  await expect(page.locator('#stop-name')).toHaveText(s2.name)
  await expect(page.locator('#counter')).toHaveText(`Stop 2 of ${n}`)
  await expect(page.locator('#sync-text')).toHaveText('All sent')

  await expect(page.locator('#skip')).toBeEnabled()
  await tap(page, page.locator('#skip'), 'Skip this stop')
  await expect(page.getByRole('dialog', { name: 'Why are you skipping?' })).toBeVisible()
  await tap(page, page.getByRole('button', { name: 'Gate locked', exact: true }), 'Gate locked')
  await expect(page.locator('#stop-name')).toHaveText(s3.name)
  await expect(page.locator('#sync-text')).toHaveText('All sent')
  await expect(page.locator(`.stop-row[data-client="${s2.client_id}"] .row-status`)).toHaveText('Skipped: Gate locked')

  const stops = (await ownerStorm(request, token, storm.id)).trucks.find((t) => t.id === truck.id).stops
  const plowed = stops.find((s) => s.client_id === s1.client_id)
  expect(plowed.status).toBe('plowed')
  expect(plowed.checkin.photo).toBe('stored')
  const photo = await request.get(plowed.checkin.photo_url)
  expect(photo.status(), 'the stored photo is served').toBe(200)
  expect(photo.headers()['content-type']).toBe('image/jpeg')
  const skipped = stops.find((s) => s.client_id === s2.client_id)
  expect(skipped.status).toBe('skipped')
  expect(skipped.checkin.reason_text).toBe('Gate locked')
  expect(await dbCheckins(request, storm.id), 'exactly two check-ins stored').toHaveLength(2)
})

test('Undo on a check-in the server already has puts the stop back to pending', async ({ page, request, seed }) => {
  const token = await ownerToken(request)
  const storm = await startStorm(request, token)
  const truck = storm.trucks[0]
  const key = seed.trucks.find((t) => t.id === truck.id).driver_key
  const s1 = truck.stops[0]
  await page.goto(`/d/?k=${key}`)
  await expect(page.locator('#stop-name')).toHaveText(s1.name)
  await tap(page, page.locator('#plowed-nophoto'), 'Plowed, no photo')
  await expect(page.locator('#counter')).toHaveText(`Stop 2 of ${truck.stops.length}`)
  await expect(page.locator('#sync-text')).toHaveText('All sent')
  expect(await dbCheckins(request, storm.id)).toHaveLength(1)

  await tap(page, page.locator('#undo-btn'), 'Undo')
  await expect(page.locator('#stop-name')).toHaveText(s1.name)
  await expect(page.locator('#sync-text')).toHaveText('All sent')
  const stop = (await ownerStorm(request, token, storm.id)).trucks.find((t) => t.id === truck.id).stops.find((s) => s.client_id === s1.client_id)
  expect(stop.status).toBe('pending')
  const rows = await dbCheckins(request, storm.id)
  expect(rows).toHaveLength(1)
  expect(rows[0].voided_at, 'the check-in is voided, not deleted').not.toBeNull()
})
