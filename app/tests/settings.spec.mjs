// Settings against the real Worker: Change PIN (clarification 21: a wrong current PIN and a 429 stay on the form, and the owner
// stays signed in), the company name and the yard pin.
import { test, expect, tap, tapAt, typeText, api, ownerToken, signIn } from './helpers.mjs'

async function replaceText(page, locator, text, label) {
  await tap(page, locator, label)
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type(text)
}

async function tryPin(page, current, next) {
  await replaceText(page, page.locator('#pin-current'), current, 'Current PIN')
  await replaceText(page, page.locator('#pin-next'), next, 'New PIN')
  const answer = page.waitForResponse((r) => r.url().endsWith('/api/owner/pin') && r.request().method() === 'PUT')
  await tap(page, page.locator('#save-pin'), 'Change PIN')
  return (await answer).status()
}

async function stillSignedIn(page) {
  await expect(page.locator('#signout'), 'still signed in').toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('snow-route:owner-token')), 'the token is kept').toBeTruthy()
  await tap(page, page.getByRole('link', { name: 'Clients' }), 'Clients tab')
  await expect(page.locator('#client-list > li'), 'the session still works').toHaveCount(25)
  await tap(page, page.getByRole('link', { name: 'Settings' }), 'Settings tab')
  await expect(page.locator('#pin-form')).toBeVisible()
}

test('Change PIN: a wrong current PIN is a field error and the owner stays signed in; the right PIN then works', async ({ page }) => {
  await signIn(page)
  await tap(page, page.getByRole('link', { name: 'Settings' }), 'Settings tab')
  expect(await tryPin(page, '1111', '975310'), 'wrong current PIN').toBe(401)
  await expect(page.locator('#err-current')).toHaveText('That PIN is not right.')
  await expect(page.locator('#pin-form-error')).toBeHidden()
  await stillSignedIn(page)

  expect(await tryPin(page, '2468', '975310'), 'right current PIN').toBe(204)
  await expect(page.locator('#pin-saved')).toHaveText('PIN changed. Every other device is signed out.')
  await expect(page.locator('#signout')).toBeVisible()

  await tap(page, page.locator('#signout'), 'Sign out')
  await typeText(page, page.locator('#pin'), '2468', 'old PIN')
  await tap(page, page.locator('#signin-btn'), 'Sign in')
  await expect(page.locator('#pin-error')).toHaveText('That PIN is not right.')
  await typeText(page, page.locator('#pin'), '975310', 'new PIN')
  await tap(page, page.locator('#signin-btn'), 'Sign in')
  await expect(page.locator('#signout'), 'the new PIN signs in').toBeVisible()
})

test('Change PIN: too many wrong tries is a message on the form, and the owner stays signed in', async ({ page }) => {
  await signIn(page)
  await tap(page, page.getByRole('link', { name: 'Settings' }), 'Settings tab')
  for (let i = 1; i <= 5; i++) expect(await tryPin(page, '1111', '975310'), `wrong try ${i}`).toBe(401)
  expect(await tryPin(page, '1111', '975310'), 'the sixth try inside 15 minutes').toBe(429)
  await expect(page.locator('#pin-form-error')).toHaveText('Too many tries. Wait 15 minutes and try again.')
  await expect(page.locator('#err-current')).toBeHidden()
  await stillSignedIn(page)
})

test('company name and yard pin save through Settings', async ({ page, request }) => {
  await signIn(page)
  await tap(page, page.getByRole('link', { name: 'Settings' }), 'Settings tab')
  const before = (await api(request, 'GET', '/api/company')).body
  await expect(page.locator('#yard-state')).toHaveText(`Yard pin at ${before.yard.lat}, ${before.yard.lng}.`)
  const name = 'SAMPLE Snow Clearing — Grand Falls-Windsor (demo, renamed)'
  await replaceText(page, page.locator('#f-company'), name, 'Company name')
  await replaceText(page, page.locator('#f-yard-label'), 'SAMPLE yard, Mill Road (new gate)', 'Yard name')
  await tapAt(page, page.locator('#map'), 0.25, 0.3, 'the map')
  await expect(page.locator('#yard-state')).not.toHaveText(`Yard pin at ${before.yard.lat}, ${before.yard.lng}.`)
  await tap(page, page.locator('#save-company'), 'Save company')
  await expect(page.locator('#company-saved')).toHaveText('Saved.')
  await expect(page.locator('.bar [data-company-name]')).toHaveText(name)
  await expect(page.locator('.bar [data-sample]'), 'still SAMPLE').toBeVisible()

  const after = (await api(request, 'GET', '/api/owner/company', { token: await ownerToken(request) })).body
  expect(after.name).toBe(name)
  expect(after.yard.label).toBe('SAMPLE yard, Mill Road (new gate)')
  expect(after.yard.lat !== before.yard.lat || after.yard.lng !== before.yard.lng, 'the yard moved').toBe(true)
  expect(`Yard pin at ${after.yard.lat}, ${after.yard.lng}.`).toBe(await page.locator('#yard-state').textContent())
})
