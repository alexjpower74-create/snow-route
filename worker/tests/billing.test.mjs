// Pure billing: HST, money, CSV cells, what counts as a push, the report and the CSV text.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hstCents, money, textCell, isPush, billingReport, billingMonths, toCsv, csvFilename, CSV_HEADER } from '../src/billing.js'

test('HST is 15% rounded half up in whole cents', () => {
  assert.equal(hstCents(10650), 1598) // 1597.5
  assert.equal(hstCents(3550), 533) // 532.5
  assert.equal(hstCents(3500), 525)
  assert.equal(hstCents(10), 2) // 1.5
  assert.equal(hstCents(3), 0) // 0.45
  assert.equal(hstCents(0), 0)
})

test('money is dollars and cents', () => {
  assert.equal(money(0), '0.00')
  assert.equal(money(5), '0.05')
  assert.equal(money(123456), '1234.56')
})

test('text cells: formula guard for = + - @ tab CR, then RFC 4180 quoting', () => {
  assert.equal(textCell('=SUM(A1)'), "'=SUM(A1)")
  assert.equal(textCell('+1'), "'+1")
  assert.equal(textCell('-1'), "'-1")
  assert.equal(textCell('@x'), "'@x")
  assert.equal(textCell('\tx'), "'\tx")
  assert.equal(textCell('\rx'), '"\'\rx"')
  assert.equal(textCell('Doe, "Jo"'), '"Doe, ""Jo"""')
  assert.equal(textCell('a\nb'), '"a\nb"')
  assert.equal(textCell('Plain (SAMPLE)'), 'Plain (SAMPLE)')
})

test('isPush: plowed, not voided, inside the NL month', () => {
  const k = (over) => ({ client_id: 1, kind: 'plowed', at: '2026-01-15T12:00:00.000Z', voided_at: null, ...over })
  assert.equal(isPush(k(), '2026-01'), true)
  assert.equal(isPush(k({ kind: 'skipped' }), '2026-01'), false)
  assert.equal(isPush(k({ voided_at: '2026-01-15T12:05:00.000Z' }), '2026-01'), false)
  assert.equal(isPush(k({ at: '2026-02-01T03:00:00.000Z' }), '2026-01'), true) // Jan 31 11:30 PM NST
  assert.equal(isPush(k({ at: '2026-02-01T03:00:00.000Z' }), '2026-02'), false)
  assert.equal(isPush(k({ at: '2026-02-01T03:30:00.000Z' }), '2026-02'), true) // midnight NST
  assert.deepEqual(billingMonths([k(), k({ at: '2025-12-02T12:00:00.000Z' }), k({ kind: 'skipped', at: '2026-03-02T12:00:00.000Z' })]), [
    '2026-01',
    '2025-12',
  ])
})

test('report rows, totals as row sums, and the CSV text', () => {
  const clients = [
    { id: 1, name: 'Zed (SAMPLE)', address: 'A Street', billing: 'per_push', price_cents: 3550, active: 1 },
    { id: 2, name: 'amy (SAMPLE)', address: 'B Street', billing: 'per_push', price_cents: 3550, active: 1 },
    { id: 3, name: 'Season (SAMPLE)', address: 'C Street', billing: 'seasonal', price_cents: 50000, active: 1 },
    { id: 4, name: 'Gone (SAMPLE)', address: 'D Street', billing: 'seasonal', price_cents: 50000, active: 0 },
    { id: 5, name: 'Idle (SAMPLE)', address: 'E Street', billing: 'per_push', price_cents: 4000, active: 1 },
  ]
  const p = (client_id, at, over = {}) => ({ client_id, kind: 'plowed', at, voided_at: null, ...over })
  const checkins = [
    p(1, '2026-01-19T09:00:00.000Z'),
    p(1, '2026-01-05T09:00:00.000Z'),
    p(1, '2026-01-12T09:00:00.000Z'),
    p(2, '2026-01-05T09:00:00.000Z'),
    p(3, '2026-01-05T09:00:00.000Z'),
    p(5, '2026-01-05T09:00:00.000Z', { kind: 'skipped' }),
  ]
  const r = billingReport('2026-01', clients, checkins)
  assert.deepEqual(
    r.rows.map((x) => x.name),
    ['amy (SAMPLE)', 'Season (SAMPLE)', 'Zed (SAMPLE)'],
  )
  const zed = r.rows[2]
  assert.deepEqual(
    [zed.pushes, zed.dates, zed.amount_cents, zed.hst_cents, zed.total_cents],
    [3, ['2026-01-05', '2026-01-12', '2026-01-19'], 10650, 1598, 12248],
  )
  assert.deepEqual(r.totals, { pushes: 5, subtotal_cents: 14200, hst_cents: 2131, total_cents: 16331 }) // not 15% of 14200 (2130)
  assert.equal(r.label, 'January 2026')
  assert.equal(
    toCsv(r),
    [
      CSV_HEADER,
      'amy (SAMPLE),B Street,Per push,1,2026-01-05,35.50,35.50,5.33,40.83',
      'Season (SAMPLE),C Street,Seasonal contract,1,2026-01-05,500.00,0.00,0.00,0.00',
      'Zed (SAMPLE),A Street,Per push,3,2026-01-05; 2026-01-12; 2026-01-19,35.50,106.50,15.98,122.48',
      'Total,,,5,,,142.00,21.31,163.31',
    ].join('\r\n') + '\r\n',
  )
  assert.equal(csvFilename('2026-01', true), 'snow-route-SAMPLE-2026-01.csv')
  assert.equal(csvFilename('2026-01', false), 'snow-route-2026-01.csv')
})
