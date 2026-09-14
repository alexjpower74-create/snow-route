// NL time (America/St_Johns): labels people read, NL dates and months, and the UTC bounds of an NL month.
// Labels follow docs/API.md. ICU writes a narrow no-break space before AM/PM; the API text uses a plain space.

export const TIMEZONE = 'America/St_Johns'

const clean = s => s.replace(/[\u202f\u2009\u00a0]/g, ' ')
const toMs = t => (typeof t === 'number' ? t : Date.parse(t))

const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, hour: 'numeric', minute: '2-digit' })
const dateFmt = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, weekday: 'short', month: 'short', day: 'numeric' })
const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TIMEZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
})
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** "6:42 AM" */
export const timeLabel = t => clean(timeFmt.format(toMs(t)))

/** "Mon Jan 12" */
export function dateLabel (t) {
  const p = Object.fromEntries(dateFmt.formatToParts(toMs(t)).map(x => [x.type, x.value]))
  return `${p.weekday} ${p.month} ${p.day}`
}

/** "Mon Jan 12, 6:42 AM" */
export const fullLabel = t => `${dateLabel(t)}, ${timeLabel(t)}`

function localParts (ms) {
  const p = Object.fromEntries(partsFmt.formatToParts(ms).map(x => [x.type, x.value]))
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second }
}

/** NL date "YYYY-MM-DD" of an instant. */
export function nlDate (t) {
  const { y, m, d } = localParts(toMs(t))
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** NL month "YYYY-MM" of an instant. */
export const nlMonth = t => nlDate(t).slice(0, 7)

/** Offset of NL time from UTC at an instant, in ms (negative: NST is -3:30). */
function offsetAt (ms) {
  const l = localParts(ms)
  return Date.UTC(l.y, l.m - 1, l.d, l.h, l.mi, l.s) - Math.floor(ms / 1000) * 1000
}

/** The UTC instant (ms) of an NL wall-clock time. */
export function nlToUtc (y, m, d, h = 0, mi = 0) {
  const wall = Date.UTC(y, m - 1, d, h, mi)
  const first = wall - offsetAt(wall)
  return wall - offsetAt(first)
}

export const isMonth = s => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s)

/** [start, end) of an NL month as ISO instants: NL midnight on the 1st to NL midnight on the 1st of the next month. */
export function monthBounds (month) {
  const [y, m] = month.split('-').map(Number)
  const next = m === 12 ? [y + 1, 1] : [y, m + 1]
  return { start: new Date(nlToUtc(y, m, 1)).toISOString(), end: new Date(nlToUtc(next[0], next[1], 1)).toISOString() }
}

/** "January 2026" */
export function monthLabel (month) {
  const [y, m] = month.split('-').map(Number)
  return `${MONTHS[m - 1]} ${y}`
}

/** "3 h 40 min", "25 min" */
export function durationLabel (ms) {
  const total = Math.max(0, Math.round(ms / 60000))
  const h = Math.floor(total / 60)
  const mi = total % 60
  return h ? `${h} h ${mi} min` : `${mi} min`
}
