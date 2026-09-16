// Billing (docs/API.md "Billing"). Pure: rows, money, CSV. A push is a plowed, non-voided check-in whose `at` falls inside
// the month in NL time. Skipped and voided check-ins never count.

import { monthBounds, monthLabel, nlDate, nlMonth } from './time.js'

export const HST_RATE = 0.15
export const SEASONAL_NOTE =
  'Seasonal contracts are billed on the contract, not by the push. Their pushes are counted here for your records.'
export const BILLING_LABELS = { per_push: 'Per push', seasonal: 'Seasonal contract' }
export const CSV_HEADER = 'Client,Address,Billing,Pushes,Push dates,Price,Amount,HST 15%,Total'

/** Plowed and not voided: the only check-ins that can ever bill. */
export function isBillable(checkin) {
  if (checkin.kind !== 'plowed') return false
  if (checkin.voided_at) return false
  return true
}

/** A billable check-in inside the NL month. */
export function isPush(checkin, month) {
  const bounds = monthBounds(month)
  return isBillable(checkin) && checkin.at >= bounds.start && checkin.at < bounds.end
}

/** HST in cents, half up, integer maths. */
export const hstCents = (amount) => Math.floor((amount * 15 + 50) / 100)

const byName = (a, b) => {
  const x = a.name.toLowerCase()
  const y = b.name.toLowerCase()
  return x < y ? -1 : x > y ? 1 : a.client_id - b.client_id
}

/**
 * The month's report. `clients`: rows with id, name, address, billing, price_cents, active. `checkins`: rows with client_id,
 * kind, at, voided_at (any superset of the month; this filters).
 */
export function billingReport(month, clients, checkins) {
  const pushesByClient = new Map()
  for (const k of checkins) {
    if (!isPush(k, month)) continue
    if (!pushesByClient.has(k.client_id)) pushesByClient.set(k.client_id, [])
    pushesByClient.get(k.client_id).push(k.at)
  }
  const rows = []
  for (const c of clients) {
    const pushes = (pushesByClient.get(c.id) || []).sort()
    if (!pushes.length && !(c.billing === 'seasonal' && c.active)) continue
    const amount = c.billing === 'per_push' ? pushes.length * c.price_cents : 0
    const hst = c.billing === 'per_push' ? hstCents(amount) : 0
    rows.push({
      client_id: c.id,
      name: c.name,
      address: c.address,
      billing: c.billing,
      billing_label: BILLING_LABELS[c.billing],
      price_cents: c.price_cents,
      pushes: pushes.length,
      dates: pushes.map(nlDate),
      amount_cents: amount,
      hst_cents: hst,
      total_cents: amount + hst,
    })
  }
  rows.sort(byName)
  const sum = (key) => rows.reduce((t, r) => t + r[key], 0)
  return {
    month,
    label: monthLabel(month),
    hst_rate: HST_RATE,
    rows,
    totals: { pushes: sum('pushes'), subtotal_cents: sum('amount_cents'), hst_cents: sum('hst_cents'), total_cents: sum('total_cents') },
    seasonal_note: SEASONAL_NOTE,
  }
}

/** NL months with at least one push, newest first. */
export function billingMonths(checkins) {
  return [...new Set(checkins.filter(isBillable).map((k) => nlMonth(k.at)))].sort().reverse()
}

export const money = (cents) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`

/** A text cell: formula guard, then RFC 4180 quoting. */
export function textCell(value) {
  let s = String(value)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(report) {
  const lines = [CSV_HEADER]
  for (const r of report.rows) {
    lines.push(
      [
        textCell(r.name),
        textCell(r.address),
        textCell(r.billing_label),
        r.pushes,
        textCell(r.dates.join('; ')),
        money(r.price_cents),
        money(r.amount_cents),
        money(r.hst_cents),
        money(r.total_cents),
      ].join(','),
    )
  }
  const t = report.totals
  lines.push(`Total,,,${t.pushes},,,${money(t.subtotal_cents)},${money(t.hst_cents)},${money(t.total_cents)}`)
  return lines.join('\r\n') + '\r\n'
}

export const csvFilename = (month, sample) => `snow-route-${sample ? 'SAMPLE-' : ''}${month}.csv`
