// Copy buttons put the exact API text on the clipboard. Nothing is ever sent from the app.
import { test, expect, tap, api, ownerToken, startStorm, ownerStorm, signIn } from './helpers.mjs'

const WEBKIT_REASON =
  "webkit: Playwright cannot grant clipboard-read in WebKit, so the page's 'Copied' is checked and reading the clipboard back is skipped"

async function clipboardIs(page, browserName, expected) {
  if (browserName === 'webkit') {
    test.info().annotations.push({ type: 'skipped step', description: WEBKIT_REASON })
    return
  }
  expect(await page.evaluate(() => navigator.clipboard.readText()), 'clipboard text').toBe(expected)
}

test('Copy text on a stop and on a client puts the exact API text on the clipboard', async ({ page, context, request, browserName }) => {
  if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const token = await ownerToken(request)
  const storm = await startStorm(request, token)
  const truck = storm.trucks[0]
  const s1 = (await ownerStorm(request, token, storm.id)).trucks.find((t) => t.id === truck.id).stops[0]
  const onRoute = s1.messages.find((m) => m.kind === 'on_route')
  expect(onRoute, 'a pending stop in an active storm has the "on the route" text').toBeTruthy()

  await signIn(page)
  const row = page.locator(`.owner-stops li[data-client-id="${s1.client_id}"]`)
  await tap(page, row.locator('summary'), 'Texts to copy')
  await expect(row.locator(`li[data-kind="on_route"] .text-preview`)).toHaveText(onRoute.text)
  const button = row.getByRole('button', { name: onRoute.label })
  await tap(page, button, onRoute.label)
  await expect(row.locator('li[data-kind="on_route"] button')).toHaveText('Copied')
  await clipboardIs(page, browserName, onRoute.text)

  const messages = (await api(request, 'GET', `/api/owner/clients/${s1.client_id}/messages`, { token })).body.messages
  const statusText = messages.find((m) => m.kind === 'status_link')
  await tap(page, page.getByRole('link', { name: 'Clients' }), 'Clients tab')
  await tap(page, page.getByRole('button', { name: `Edit ${s1.name}` }), `Edit ${s1.name}`)
  await expect(page.locator('#status-text')).toHaveText(statusText.text)
  await tap(page, page.locator('#copy-status'), 'Copy status text')
  await expect(page.locator('#copy-status')).toHaveText('Copied')
  await clipboardIs(page, browserName, statusText.text)
})
