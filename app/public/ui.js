// Small shared helpers for every page: escaping, NL time labels (docs/API.md formats), the company bar with its SAMPLE
// badge, and check-in ids. No DOM framework: pages build strings with esc() around every value.

export const NL_ZONE = 'America/St_Johns'

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c])

const formatters = new Map()
function parts(iso, zone, options) {
  const id = zone + JSON.stringify(options)
  if (!formatters.has(id)) formatters.set(id, new Intl.DateTimeFormat('en-US', { timeZone: zone, ...options }))
  const out = {}
  for (const p of formatters.get(id).formatToParts(new Date(iso))) out[p.type] = p.value
  return out
}

// "6:42 AM" — the check-in time a person reads, always in the company's zone, never the phone's.
export function timeLabel(iso, zone = NL_ZONE) {
  const p = parts(iso, zone, { hour: 'numeric', minute: '2-digit' })
  return `${p.hour}:${p.minute} ${p.dayPeriod}`
}
// "Mon Jan 12"
export function dateLabel(iso, zone = NL_ZONE) {
  const p = parts(iso, zone, { weekday: 'short', month: 'short', day: 'numeric' })
  return `${p.weekday} ${p.month} ${p.day}`
}
// "Mon Jan 12, 6:42 AM"
export const fullLabel = (iso, zone = NL_ZONE) => `${dateLabel(iso, zone)}, ${timeLabel(iso, zone)}`

// "08:00" (24 h, from the API) → "8:00 AM"
export function clockLabel(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm || '')
  if (!m) return ''
  const h = Number(m[1])
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`
}

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

// The company bar every screen carries: name, and the SAMPLE badge while the company is sample.
export function brandBar(company, extra = '') {
  const name = company?.name || 'Snow Route'
  const badge = company?.sample ? '<span class="sample-badge" data-sample>SAMPLE</span>' : ''
  return `<div class="brand"><span class="company" data-company-name>${esc(name)}</span>${badge}</div>${extra}`
}

// UUID v4 for check-in ids (the idempotency key). randomUUID needs a secure context; a phone on a LAN address may not have one.
export function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID()
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
