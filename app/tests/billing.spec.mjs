// Billing from real check-ins, against the real Worker. Two per-push clients are plowed and a seasonal client is skipped through
// the driver page, the storm is ended through the owner page, and the billing screen must show exactly the API's rows, amounts
// that match the rule written out here, the seasonal note, and a CSV that says the same as the table.
import { readFile } from 'node:fs/promises'
import { test, expect, tap, api, ownerToken, signIn } from './helpers.mjs'

const hstOf = (amount) => Math.floor((amount * 15 + 50) / 100) // API.md: half up, integer maths
const money = (c) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const plain = (c) => (c / 100).toFixed(2)
const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const dayLabel = (d) => `${SHORT[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`

// RFC 4180 lines → cells.
function parseCsv(text) {
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      i++
    } else cell += ch
  }
  if (cell || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

test('billing: two pushes with amounts and HST, the skipped seasonal client with no push, the note, and the CSV matches the table', async ({
  page,
  context,
  request,
  seed,
}) => {
  const token = await ownerToken(request)
  const clients = (await api(request, 'GET', '/api/owner/clients', { token })).body.clients
  const byName = (n) => clients.find((c) => c.name === n)
  const pat = byName('Pat (SAMPLE)')
  const clinic = byName('SAMPLE Clinic walkway')
  const taylor = byName('Taylor (SAMPLE)')
  expect([pat.billing, clinic.billing, taylor.billing], 'two per-push clients and one seasonal').toEqual([
    'per_push',
    'per_push',
    'seasonal',
  ])
  // Two per-push clients at $35.50 (clarifications 34 and 46): each row's HST is 3550 × 15 / 100 = 532.5 → 533 (half up), so the rows
  // sum to 1066, while 15% of the $71.00 subtotal would be 1065: the totals can only pass as the sum of the rows. (In JavaScript
  // 3550 * 0.15 is exactly 532.5, so Math.round gives 533 too; control (h) truncates instead.)
  for (const c of [pat, clinic]) {
    const repriced = await api(request, 'PUT', `/api/owner/clients/${c.id}`, {
      token,
      data: {
        name: c.name,
        address: c.address,
        lat: c.lat,
        lng: c.lng,
        type: c.type,
        priority: c.priority,
        opens_at: c.opens_at,
        notes: c.notes,
        billing: c.billing,
        price_cents: 3550,
        truck_id: c.truck_id,
        active: true,
      },
    })
    expect(repriced.status).toBe(200)
    c.price_cents = 3550
  }
  expect(hstOf(3550), 'the rule written out').toBe(533)
  const truck = seed.trucks[0]
  const started = await api(request, 'POST', '/api/owner/storms', {
    token,
    data: { client_ids: [pat.id, clinic.id, taylor.id], truck_ids: [truck.id] },
  })
  expect(started.status).toBe(201)
  // Both medical stops first, the nearer to the yard leading (API.md ordering: nearest neighbour from the yard; with two stops 2-opt
  // cannot do better), and the seasonal client last. Worked out from the yard here, not hard-coded, so moving a SAMPLE point
  // cannot silently flip it.
  const { yard } = (await api(request, 'GET', '/api/owner/company', { token })).body
  const metres = (a, b) => {
    const rad = (d) => (d * Math.PI) / 180
    const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2
    return 2 * 6371000 * Math.asin(Math.sqrt(h))
  }
  const [first, second] = [pat, clinic].sort((a, b) => metres(yard, a) - metres(yard, b))
  expect(
    started.body.trucks[0].stops.map((s) => s.client_id),
    'medical stops first, nearer the yard leading, the seasonal client last',
  ).toEqual([first.id, second.id, taylor.id])

  // The driver works the route on the phone.
  await page.goto(`/d/?k=${truck.driver_key}`)
  await expect(page.locator('#stop-name')).toHaveText(first.name)
  await tap(page, page.locator('#plowed-nophoto'), `Plowed, no photo (${first.name})`)
  await expect(page.locator('#stop-name')).toHaveText(second.name)
  await expect(page.locator('#plowed-nophoto')).toBeEnabled()
  await tap(page, page.locator('#plowed-nophoto'), `Plowed, no photo (${second.name})`)
  await expect(page.locator('#stop-name')).toHaveText(taylor.name)
  await expect(page.locator('#skip')).toBeEnabled()
  await tap(page, page.locator('#skip'), 'Skip this stop (Taylor)')
  await tap(page, page.getByRole('button', { name: 'Car in the way', exact: true }), 'Car in the way')
  await expect(page.getByRole('heading', { name: 'Every stop is done' })).toBeVisible()
  await expect(page.locator('#sync-text')).toHaveText('All sent')

  // The owner ends the storm and opens Billing.
  const owner = await context.newPage()
  await signIn(owner)
  await tap(owner, owner.locator('#end-storm'), 'End storm')
  await tap(owner, owner.locator('#end-yes'), 'Yes, end the storm')
  await expect(owner.locator('#summary')).toBeVisible()
  await tap(owner, owner.getByRole('link', { name: 'Billing' }), 'Billing tab')
  await expect(owner.locator('#billing-table')).toBeVisible()

  const months = (await api(request, 'GET', '/api/owner/billing/months', { token })).body.months
  expect(months.length).toBeGreaterThan(0)
  await expect(owner.locator('#billing-month'), 'opens on the newest month with pushes').toHaveValue(months[0])
  const bill = (await api(request, 'GET', `/api/owner/billing?month=${months[0]}`, { token })).body

  // The rule, written out here, not read from the Worker.
  const expectRow = (client, pushes) => {
    const row = bill.rows.find((r) => r.client_id === client.id)
    expect(row, `${client.name} is a billing row`).toBeTruthy()
    const amount = client.billing === 'seasonal' ? 0 : pushes * client.price_cents
    const hst = client.billing === 'seasonal' ? 0 : hstOf(amount)
    expect([row.pushes, row.amount_cents, row.hst_cents, row.total_cents], `${client.name}: pushes, amount, HST, total`).toEqual([
      pushes,
      amount,
      hst,
      amount + hst,
    ])
    return row
  }
  expectRow(pat, 1)
  expectRow(clinic, 1)
  const taylorRow = expectRow(taylor, 0)
  expect(taylorRow.dates, 'a skipped stop never bills').toEqual([])
  expect(bill.totals.pushes).toBe(2)
  expect(bill.totals.subtotal_cents).toBe(pat.price_cents + clinic.price_cents)
  expect(bill.totals.hst_cents).toBe(hstOf(pat.price_cents) + hstOf(clinic.price_cents))
  expect(bill.totals.hst_cents, 'totals are the sum of the rows').toBe(1066)
  expect(hstOf(bill.totals.subtotal_cents), '15% of the subtotal would differ').toBe(1065)

  // The screen shows exactly the API rows.
  await expect(owner.locator('#billing-table tbody tr')).toHaveCount(bill.rows.length)
  for (const r of bill.rows) {
    const tr = owner.locator(`#billing-table tbody tr[data-client-id="${r.client_id}"]`)
    await expect(tr.locator('.row-name')).toHaveText(r.name)
    await expect(tr.locator('[data-col="billing"]')).toHaveText(r.billing_label)
    await expect(tr.locator('[data-col="pushes"]'), `${r.name}: pushes`).toHaveText(String(r.pushes))
    await expect(tr.locator('[data-col="dates"]')).toHaveText(r.dates.map(dayLabel).join(', ') || '—')
    await expect(tr.locator('[data-col="price"]')).toHaveText(money(r.price_cents))
    await expect(tr.locator('[data-col="amount"]')).toHaveText(money(r.amount_cents))
    await expect(tr.locator('[data-col="hst"]')).toHaveText(money(r.hst_cents))
    await expect(tr.locator('[data-col="total"]')).toHaveText(money(r.total_cents))
  }
  await expect(
    owner.locator(`#billing-table tbody tr[data-client-id="${taylor.id}"] [data-col="pushes"]`),
    'the skipped seasonal client: no push',
  ).toHaveText('0')
  for (const c of [pat, clinic])
    await expect(
      owner.locator(`#billing-table tbody tr[data-client-id="${c.id}"] [data-col="hst"]`),
      'HST on $35.50, rounded half up',
    ).toHaveText('$5.33')
  await expect(owner.locator('#billing-totals [data-col="hst"]')).toHaveText('$10.66')
  const totals = owner.locator('#billing-totals')
  await expect(totals.locator('[data-col="pushes"]')).toHaveText('2')
  await expect(totals.locator('[data-col="amount"]')).toHaveText(money(bill.totals.subtotal_cents))
  await expect(totals.locator('[data-col="hst"]')).toHaveText(money(bill.totals.hst_cents))
  await expect(totals.locator('[data-col="total"]')).toHaveText(money(bill.totals.total_cents))
  await expect(owner.locator('#seasonal-note')).toHaveText(bill.seasonal_note)

  // The accountant's CSV says what the table says.
  const downloading = owner.waitForEvent('download')
  await tap(owner, owner.locator('#download-csv'), 'Download CSV for the accountant')
  const download = await downloading
  expect(download.suggestedFilename()).toBe(`snow-route-SAMPLE-${months[0]}.csv`)
  const bytes = await readFile(await download.path())
  const fromWorker = await request.get(`/api/owner/billing.csv?month=${months[0]}`, { headers: { Authorization: `Bearer ${token}` } })
  expect(fromWorker.status()).toBe(200)
  expect(Buffer.compare(bytes, await fromWorker.body()), 'the download is byte for byte the CSV from the Worker (clarification 35)').toBe(0)
  const text = bytes.toString('utf8')
  expect(text.includes('\r\n'), 'CRLF lines').toBe(true)
  const csv = parseCsv(text)
  expect(csv[0]).toEqual(['Client', 'Address', 'Billing', 'Pushes', 'Push dates', 'Price', 'Amount', 'HST 15%', 'Total'])
  const body = csv.slice(1, -1)
  expect(body).toHaveLength(bill.rows.length)
  const cells = await owner.locator('#billing-table tbody tr').evaluateAll((trs) =>
    trs.map((tr) => ({
      name: tr.querySelector('.row-name').textContent,
      pushes: tr.querySelector('[data-col="pushes"]').textContent,
      amount: tr.querySelector('[data-col="amount"]').textContent,
      hst: tr.querySelector('[data-col="hst"]').textContent,
      total: tr.querySelector('[data-col="total"]').textContent,
      billing: tr.querySelector('[data-col="billing"]').textContent,
    })),
  )
  const dollars = (s) => s.replace(/[$,]/g, '')
  body.forEach((line, i) => {
    const c = cells[i]
    expect([line[0], line[2], line[3], line[6], line[7], line[8]], `CSV row ${i + 1} matches the table row`).toEqual([
      c.name,
      c.billing,
      c.pushes,
      dollars(c.amount),
      dollars(c.hst),
      dollars(c.total),
    ])
  })
  expect(csv.at(-1)).toEqual([
    'Total',
    '',
    '',
    '2',
    '',
    '',
    plain(bill.totals.subtotal_cents),
    plain(bill.totals.hst_cents),
    plain(bill.totals.total_cents),
  ])
})
