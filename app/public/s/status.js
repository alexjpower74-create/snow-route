// Client status page /s/?k=<status key>: one card with the big answer. Checks again every 60 s and whenever the page
// comes back into view. No map, no neighbours, no live GPS. Any 404 shows this page's own bad-link text and stops checking
// until a reload (clarification 18): each unknown-key lookup counts toward the per-IP guard.
import { api } from '/api.js'
import { esc, brandBar, timeLabel, plural } from '/ui.js'

const POLL_MS = 60_000
const BAD_LINK = "This status link doesn't work. Ask your snow clearing company for a new one."
const key = new URLSearchParams(location.search).get('k') || ''
const app = document.getElementById('app')
let last = null
let timer = null
let stopped = false

const lowerFirst = (s) => (s ? s[0].toLowerCase() + s.slice(1) : '')

function doneText(n) {
  if (n === 0) return 'No stops are done yet.'
  return `${plural(n, 'stop')} ${n === 1 ? 'is' : 'are'} done so far.`
}

function answer(r) {
  const t = r.tonight
  const l = r.last
  const earlier = l ? `<p class="answer-note">Last plowed ${esc(l.at_label)}.</p>` : ''
  if (t?.state === 'waiting') {
    return `<p class="answer-big" id="answer">On the route tonight. You're stop ${t.stop_number}.</p>
      <p class="answer-sub">${esc(doneText(t.stops_done))}</p>${earlier}`
  }
  if (t?.state === 'skipped') {
    return `<p class="answer-big answer-skipped" id="answer">We couldn't clear it tonight: ${esc(lowerFirst(t.reason_text))}.</p>
      <p class="answer-sub">We'll be in touch about it.</p>${earlier}`
  }
  if (l) {
    const day = l.at_label.split(',')[0]
    const type = lowerFirst(r.client.type_label)
    const photo = l.photo_url
      ? `<img class="photo" id="photo" src="${esc(l.photo_url)}" alt="Photo of the cleared ${esc(type)}" referrerpolicy="no-referrer">`
      : l.photo_waiting
        ? '<p class="answer-note">The photo is still on its way from the truck.</p>'
        : ''
    return `<p class="answer-big answer-plowed" id="answer">Plowed at ${esc(l.time_label)}</p>
      <p class="answer-sub">${esc(day)}</p>${photo}`
  }
  return '<p class="answer-big" id="answer">Not plowed yet this storm.</p>'
}

function render(r, note = '') {
  app.innerHTML = `
    <article class="status-card">
      <header class="status-head">${brandBar(r.company)}</header>
      <p class="muted">Snow clearing for</p>
      <h1 class="status-address" id="address">${esc(r.client.address)}</h1>
      <section class="answer">${answer(r)}</section>
      <p class="checked muted" id="checked">${note ? esc(note) : `Checked at ${esc(timeLabel(r.server_now))}. This page checks again every minute.`}</p>
    </article>`
}

async function renderBadLink(message) {
  let company = null
  try {
    company = await api.company()
  } catch {}
  app.innerHTML = `
    <article class="status-card">
      <header class="status-head">${brandBar(company)}</header>
      <h1 class="status-address">Status link</h1>
      <p class="answer-sub" id="answer" role="alert">${esc(message)}</p>
    </article>`
}

async function check() {
  if (stopped) return
  if (!key) {
    stopped = true
    clearInterval(timer)
    return renderBadLink(BAD_LINK)
  }
  try {
    last = await api.status(key)
    render(last)
  } catch (e) {
    if (e.status === 404) {
      stopped = true
      clearInterval(timer)
      return renderBadLink(BAD_LINK)
    }
    if (last) return render(last, e.code === 'network' ? 'Could not check just now (no signal). Showing the last answer.' : e.message)
    app.innerHTML = `<article class="status-card"><header class="status-head">${brandBar(null)}</header><p class="answer-sub" role="alert">${esc(e.message)}</p></article>`
  }
}

timer = setInterval(check, POLL_MS)
check()
document.addEventListener('visibilitychange', () => {
  if (!stopped && document.visibilityState === 'visible') check()
})
