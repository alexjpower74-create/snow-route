// Driver page /d/?k=<driver key>. The screen is the route (from the server, or the copy saved on this phone) with the
// offline queue laid over it, so a check-in shows at once whether or not it has been sent. See queue.js for sending.
import { api } from '/api.js'
import { esc, timeLabel, clockLabel, brandBar, plural, uuid } from '/ui.js'
import * as queue from '/d/queue.js'

const REASONS = [['car', 'Car in the way'], ['gate', 'Gate locked'], ['cancelled', 'Client cancelled'], ['other', 'Other']]
const REASON_LABEL = Object.fromEntries(REASONS)
const UNDO_MS = 15_000
const LOCK_MS = 700 // a second glove tap on the same spot must not land on the next stop's button
const REFRESH_MS = 120_000
const ROUTE_PREFIX = 'snow-route:route:'
const KEYS = 'snow-route:keys' // { driver key: truck id }, never overwritten by a newer route for the same truck (clarification 27)
const PHOTO_NOTES = 'snow-route:photo-not-sent' // { checkin id: server message } for photos the server refused

function photoNotes() {
  try { return JSON.parse(localStorage.getItem(PHOTO_NOTES)) || {} } catch { return {} }
}
const noteText = (n) => (typeof n === 'string' ? n : n?.message || '')
// A refused photo keeps a note: the message, and (clarification 30) enough to list it when its stop is not on this route.
function notePhotoDropped(id, message, item) {
  const notes = photoNotes()
  notes[id] = { message, label: item?.label || '', at: item?.body?.at || null, client_id: item?.body?.client_id ?? null, storm_id: item?.body?.storm_id ?? null, dismissed: false }
  try { localStorage.setItem(PHOTO_NOTES, JSON.stringify(notes)) } catch {}
}

const key = new URLSearchParams(location.search).get('k') || ''
const state = {
  route: null, savedAt: null, fromCache: false, error: '', loading: true,
  items: [], last: null, focus: null, locked: false, notice: '', sheet: null, routeVersion: 0, confirmUndo: null, confirmAttempted: false,
}
const app = document.getElementById('app')

/* ---- the route saved on this phone ------------------------------------ */
function readCache() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k.startsWith(ROUTE_PREFIX)) continue
      const v = JSON.parse(localStorage.getItem(k))
      if (v?.key === key && v.route) return v
    }
  } catch {}
  return null
}
function writeCache() {
  if (!state.route?.truck) return
  try {
    localStorage.setItem(ROUTE_PREFIX + state.route.truck.id, JSON.stringify({ key, saved_at: state.savedAt, route: state.route }))
  } catch {}
}
function knownKeys() {
  try { return JSON.parse(localStorage.getItem(KEYS)) || {} } catch { return {} }
}
function rememberKey(k, truckId) {
  const keys = knownKeys()
  if (keys[k] === truckId) return
  keys[k] = truckId
  try { localStorage.setItem(KEYS, JSON.stringify(keys)) } catch {}
}
// The truck a driver key belongs to: the key store first, then (for phones from before it) a route saved with that key.
function truckOfKey(k) {
  if (k === key && state.route?.truck) return state.route.truck.id
  const known = knownKeys()[k]
  if (known != null) return known
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const name = localStorage.key(i)
      if (!name.startsWith(ROUTE_PREFIX)) continue
      const v = JSON.parse(localStorage.getItem(name))
      if (v?.key === k && v.route?.truck) return v.route.truck.id
    }
  } catch {}
  return null
}
function clearCache() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      if (k.startsWith(ROUTE_PREFIX) && JSON.parse(localStorage.getItem(k))?.key === key) localStorage.removeItem(k)
    }
  } catch {}
}

/* ---- the screen's view of the route: server stops + the queue --------- */
const zone = () => state.route?.company?.timezone || 'America/St_Johns'
const reasonText = (reason, note) => (reason === 'other' && note ? `Other: ${note}` : REASON_LABEL[reason] || '')
const pageTruck = () => state.route?.truck?.id ?? null

// Items this page answers for: saved under its own key, saved under another link of the same truck (an old link), or saved under a
// key the Worker refused (the sender re-keys those to this page, clarifications 17 and 24).
function ours(item) {
  if (item.key === key) return true
  const truck = item.truck_id ?? truckOfKey(item.key)
  return (truck != null && truck === pageTruck()) || sender.isDead(item.key)
}
const itemWhat = (i) => (i.op === 'void' ? 'Undo' : i.body.kind === 'plowed' ? 'Plowed' : `Skipped: ${reasonText(i.body.reason, i.body.note)}`)
const itemAt = (i) => (i.body.at ? ` at ${timeLabel(i.body.at, zone())}` : '')

// Queued check-ins not on this route: from a storm that has ended (or an earlier one), or for a stop moved to another truck in this
// storm. Both still send and keep their time; each is listed once (clarifications 20, 28, 31).
function offRoute() {
  const route = state.route
  if (!route) return { ended: [], moved: [] }
  const here = new Set(route.storm ? route.stops.map((s) => s.client_id) : [])
  const rows = state.items.filter((i) => ours(i) && i.op === 'checkin' && i.state !== 'rejected' && i.state !== 'undone' && !i.stuck)
  return {
    ended: rows.filter((i) => !route.storm || i.body.storm_id !== route.storm.id),
    moved: rows.filter((i) => route.storm && i.body.storm_id === route.storm.id && !here.has(i.body.client_id)),
  }
}
const elsewhere = () => { const o = offRoute(); return [...o.ended, ...o.moved] }

function stops() {
  const route = state.route
  if (!route?.storm) return []
  const list = route.stops.map((s) => ({ ...s, queued: false }))
  const byClient = new Map(list.map((s) => [s.client_id, s]))
  for (const item of state.items) {
    if (!ours(item) || item.stuck || item.state === 'rejected' || item.state === 'undone' || item.body.storm_id !== route.storm.id) continue
    const s = byClient.get(item.body.client_id)
    if (!s) continue
    const b = item.body
    if (item.op === 'void') {
      if (s.checkin?.id === b.id) { s.status = 'pending'; s.checkin = null; s.queued = true }
      continue
    }
    const checkin = {
      id: b.id, kind: b.kind, reason: b.reason || null, reason_text: b.kind === 'skipped' ? reasonText(b.reason, b.note) : null,
      at: b.at, at_label: timeLabel(b.at, zone()), photo: b.has_photo ? 'waiting' : 'none',
    }
    if (b.kind === 'plowed') { s.status = 'plowed'; s.checkin = checkin; s.queued = item.state === 'send' }
    else if (s.status !== 'plowed') { s.status = 'skipped'; s.checkin = checkin; s.queued = true }
  }
  return list
}

function current(list) {
  if (state.focus != null) {
    const f = list.find((s) => s.client_id === state.focus && s.status !== 'plowed')
    if (f) return f
    state.focus = null
  }
  return list.find((s) => s.status === 'pending') || null
}

const isApple = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
function navigateUrl(address) {
  const a = encodeURIComponent(address)
  return isApple() ? `https://maps.apple.com/?daddr=${a}&dirflg=d` : `https://www.google.com/maps/dir/?api=1&destination=${a}`
}

/* ---- rendering --------------------------------------------------------- */
app.innerHTML = `
  <header class="bar" id="bar"></header>
  <div class="strip" id="strip" role="status" aria-live="polite"></div>
  <main class="wrap driver-main">
    <div id="undo"></div>
    <section id="stop" aria-live="polite"></section>
    <section id="oldlink"></section>
    <section id="elsewhere"></section>
    <section id="rejected"></section>
    <section id="list"></section>
  </main>
  <div id="sheet"></div>`
const $ = (id) => document.getElementById(id)
// Write a section only when its markup changed: the sender re-renders often, and replacing an identical button would drop
// focus and swap the element out from under a tap.
const painted = new Map()
function paint(id, markup) {
  if (painted.get(id) === markup) return
  painted.set(id, markup)
  $(id).innerHTML = markup
}
const painter = (id) => ({ set innerHTML(markup) { paint(id, markup) } })

function render() {
  renderBar()
  renderStrip()
  renderStop()
  renderOldLink()
  renderElsewhere()
  renderRejected()
  renderList()
  renderUndo()
}

function renderBar() {
  const truck = state.route?.truck ? `<span class="truck">${esc(state.route.truck.name)}</span>` : ''
  paint('bar', brandBar(state.route?.company, truck))
}

function renderStrip() {
  const strip = $('strip')
  // An undone item that was tried still has a DELETE to send (clarification 38), so it counts until that is done.
  const live = state.items.filter((i) => ours(i) && i.state !== 'rejected' && (i.state !== 'undone' || i.attempted) && !i.stuck)
  const toSend = live.filter((i) => i.state === 'send').length
  const photos = live.filter((i) => i.state === 'photo').length
  const offline = !navigator.onLine || sender.problem === 'network'
  let text
  let tone = 'waiting'
  if (!toSend && !photos) {
    text = 'All sent'
    tone = 'ok'
  } else if (offline) {
    text = toSend
      ? `No signal. ${plural(toSend, 'check-in')} saved on this phone. They send when signal comes back and keep the time you tapped.`
      : `No signal. ${plural(photos, 'photo')} saved on this phone. They send when signal comes back.`
  } else if (sender.problem === 'unauthorized') {
    text = `${sender.message} ${plural(toSend + photos, 'item')} still saved on this phone.`
    tone = 'bad'
  } else if (sender.problem) {
    text = toSend
      ? `${plural(toSend, 'check-in')} saved on this phone. Could not send yet, trying again soon. They keep the time you tapped.`
      : `${plural(photos, 'photo')} saved on this phone. Could not send yet, trying again soon.`
  } else {
    text = toSend ? `Sending ${plural(toSend, 'check-in')}…` : `Sending ${plural(photos, 'photo')}…`
  }
  strip.className = `strip strip-${tone}`
  strip.dataset.toSend = String(toSend)
  strip.dataset.photos = String(photos)
  const saved = state.fromCache && state.savedAt
    ? `<span class="strip-note">Route saved on this phone at ${esc(timeLabel(state.savedAt, zone()))}.</span>` : ''
  paint('strip', `<span class="strip-text" id="sync-text">${esc(text)}</span>${saved}`)
}

function renderStop() {
  const box = painter('stop')
  const route = state.route
  if (!route) {
    box.innerHTML = state.loading
      ? '<p class="loading">Loading your route…</p>'
      : `<div class="message"><h1 class="big-msg">Can't show the route</h1><p class="lead">${esc(state.error)}</p>
         <button class="btn btn-quiet" type="button" data-action="reload">Try again</button></div>`
    return
  }
  if (!route.storm) {
    box.innerHTML = `<div class="message"><h1 class="big-msg">No storm on right now</h1>
      <p class="lead">When the owner starts a storm, your stops show up here.</p>
      <button class="btn btn-quiet" type="button" data-action="reload">Check again</button></div>`
    return
  }
  const list = stops()
  const stop = current(list)
  if (!list.length) {
    box.innerHTML = '<div class="message"><h1 class="big-msg">No stops on your route tonight</h1><p class="lead">Ask the owner if that looks wrong.</p></div>'
    return
  }
  if (!stop) {
    const plowed = list.filter((s) => s.status === 'plowed').length
    const skipped = list.filter((s) => s.status === 'skipped').length
    box.innerHTML = `<p class="counter">All ${list.length} stops done</p><div class="message"><h1 class="big-msg">Every stop is done</h1>
      <p class="lead">${plural(plowed, 'plowed stop')}, ${plural(skipped, 'skipped stop')}. Skipped stops are in the list below if you can go back.</p></div>`
    return
  }
  const back = state.focus === stop.client_id
  const lock = state.locked ? ' disabled' : ''
  const chips = [
    stop.priority !== 'none' ? `<span class="chip chip-priority">${esc(stop.priority_label)}</span>` : '',
    stop.opens_at ? `<span class="chip chip-opens">Opens ${esc(clockLabel(stop.opens_at))}</span>` : '',
    `<span class="chip">${esc(stop.type_label)}</span>`,
  ].join('')
  box.innerHTML = `
    <p class="counter" id="counter">Stop ${stop.position} of ${list.length}</p>
    <p class="eyebrow">${back ? 'Back at a skipped stop' : 'Next stop'}</p>
    <h1 class="stop-name" id="stop-name">${esc(stop.name)}</h1>
    <p class="stop-address" id="stop-address">${esc(stop.address)}</p>
    <p class="chips">${chips}</p>
    ${stop.notes ? `<div class="notes" id="stop-notes"><span class="visually-hidden">Notes: </span>${esc(stop.notes)}</div>` : ''}
    ${back && stop.checkin?.reason_text ? `<p class="lead">Skipped earlier: ${esc(stop.checkin.reason_text)}</p>` : ''}
    ${state.notice ? `<p class="notice" role="alert">${esc(state.notice)}</p>` : ''}
    <div class="actions${state.locked ? ' is-locked' : ''}">
      <a class="btn btn-nav" id="navigate" href="${esc(navigateUrl(stop.address))}" target="_blank" rel="noopener">Navigate</a>
      <label class="btn btn-plowed" id="plowed">
        <input class="visually-hidden" id="photo-input" type="file" accept="image/*" capture="environment" data-client="${stop.client_id}"${lock}>
        <span class="btn-main">Plowed</span><span class="btn-sub">takes a photo</span>
      </label>
      <button class="btn btn-plain" id="plowed-nophoto" type="button" data-action="plowed" data-client="${stop.client_id}"${lock}>Plowed, no photo</button>
      ${back
        ? '<button class="btn btn-quiet" id="back-next" type="button" data-action="back">Back to the next stop</button>'
        : `<button class="btn btn-skip" id="skip" type="button" data-action="skip" data-client="${stop.client_id}"${lock}>Skip this stop</button>`}
    </div>`
}

function statusLine(s, next) {
  const saved = s.queued ? ' · saved on this phone' : ''
  const dropped = s.checkin && noteText(photoNotes()[s.checkin.id])
  if (s.status === 'plowed') {
    const photo = dropped ? ` · Photo not sent: ${dropped}` : s.checkin?.photo === 'waiting' ? ' · photo to send' : ''
    return `Plowed ${s.checkin?.at_label || ''}${photo}${saved}`
  }
  if (s.status === 'skipped') return `Skipped: ${s.checkin?.reason_text || ''}${saved}`
  return s === next ? 'Up next' : 'To do'
}

function renderList() {
  const box = painter('list')
  const list = stops()
  if (!list.length) { box.innerHTML = ''; return }
  const next = current(list)
  const count = (st) => list.filter((s) => s.status === st).length
  box.innerHTML = `
    <h2 class="section-title">All stops tonight</h2>
    <p class="muted">${count('plowed')} plowed · ${count('skipped')} skipped · ${count('pending')} to go</p>
    <ol class="stops" id="stops">
      ${list.map((s) => `
        <li class="stop-row is-${s.status}${s === next ? ' is-next' : ''}" data-client="${s.client_id}">
          <span class="num" aria-hidden="true">${s.position}</span>
          <div class="row-main">
            <span class="row-name">${esc(s.name)}</span>
            <span class="row-addr">${esc(s.address)}</span>
            <span class="row-status">${esc(statusLine(s, next))}</span>
          </div>
          ${s.status === 'skipped' ? `<button class="btn-row" type="button" data-action="plowed-now" data-client="${s.client_id}">Plowed now</button>` : ''}
        </li>`).join('')}
    </ol>`
}

function renderOldLink() {
  const box = painter('oldlink')
  const off = new Set(elsewhere().map((i) => i.qid))
  const rows = state.items.filter((i) => ours(i) && i.state !== 'rejected' && i.state !== 'undone' && !off.has(i.qid) && (i.key !== key || i.rekeyed_from))
  if (!rows.length) { box.innerHTML = ''; return }
  box.innerHTML = `
    <div class="queue-note" id="old-link">
      <h2 class="section-title">Saved under an old driver link</h2>
      <ul class="rejected-list">
        ${rows.map((i) => `
          <li data-qid="${esc(i.qid)}">
            <strong>${esc(i.label)}</strong>
            <span class="muted">${esc(itemWhat(i))}${esc(itemAt(i))}</span>
            ${i.stuck
              ? `<span class="error-text">This ${i.op === 'void' ? 'undo' : 'photo'} belongs to another truck's link, so this link cannot send it.</span>
                 <button class="btn-row" type="button" data-action="dismiss" data-qid="${esc(i.qid)}">Remove from this phone</button>`
              : '<span class="queue-note-status">Saved under an old driver link, sending with this one.</span>'}
          </li>`).join('')}
      </ul>
    </div>`
}

function offRouteRow(i) {
  return `
    <li data-qid="${esc(i.qid)}">
      <strong>${esc(i.label)}</strong>
      <span class="muted">${esc(itemWhat(i))}${esc(itemAt(i))}${i.state === 'photo' ? ' · photo to send' : ''}</span>
      ${i.rekeyed_from || i.key !== key ? '<span class="muted">Moved from an old driver link.</span>' : ''}
      ${state.confirmUndo === i.qid ? confirmUndoMarkup(i.qid) : `<button class="btn-row" type="button" data-action="undo-item" data-qid="${esc(i.qid)}">Undo</button>`}
    </li>`
}

function renderElsewhere() {
  const box = painter('elsewhere')
  const { ended, moved } = offRoute()
  const onRoute = new Set((state.route?.stops || []).map((s) => s.checkin?.id).filter(Boolean))
  const notes = Object.entries(photoNotes()).filter(([id, n]) => typeof n === 'object' && !n.dismissed && !onRoute.has(id))
    .sort(([, a], [, b]) => (a.storm_id ?? 0) - (b.storm_id ?? 0))
  const endedBlock = ended.length ? `
    <div class="queue-note" id="ended-storm">
      <h2 class="section-title">Saved from the storm that ended, still sending</h2>
      <p class="muted">The owner ended that storm. These still count, with the time you tapped.</p>
      <ul class="rejected-list">${ended.map(offRouteRow).join('')}</ul>
    </div>` : ''
  const movedBlock = moved.length ? `
    <div class="queue-note" id="other-route">
      <h2 class="section-title">Saved for stops on another route</h2>
      <p class="muted">The owner moved these stops off this route. They still send, with the time you tapped.</p>
      <ul class="rejected-list">
        ${moved.map(offRouteRow).join('')}
      </ul>
    </div>` : ''
  // Refused photos have their own neutral heading, keyed by storm, never under wording about moved stops (clarification 45).
  const photosBlock = notes.length ? `
    <div class="queue-note" id="photos-not-sent">
      <h2 class="section-title">Photos not sent</h2>
      <p class="muted">The office has these stops as plowed, without the photo.</p>
      <ul class="rejected-list">
        ${notes.map(([id, n]) => `
          <li data-note="${esc(id)}">
            <strong>${esc(n.label)}</strong>
            <span class="error-text">Photo not sent: ${esc(n.message)}</span>
            <button class="btn-row" type="button" data-action="dismiss-note" data-id="${esc(id)}">Dismiss</button>
          </li>`).join('')}
      </ul>
    </div>` : ''
  box.innerHTML = endedBlock + movedBlock + photosBlock
}

function renderRejected() {
  const box = painter('rejected')
  const bad = state.items.filter((i) => ours(i) && i.state === 'rejected')
  if (!bad.length) { box.innerHTML = ''; return }
  box.innerHTML = `
    <div class="rejected" id="not-accepted">
      <h2 class="section-title">Not accepted</h2>
      <p class="muted">These were saved on this phone, but the server did not take them. Tell the owner.</p>
      <ul class="rejected-list">
        ${bad.map((i) => `
          <li>
            <strong>${esc(i.label)}</strong>
            <span class="muted">${esc(itemWhat(i))}${esc(itemAt(i))}</span>
            <span class="error-text">${esc(i.error)}</span>
            <button class="btn-row" type="button" data-action="dismiss" data-qid="${esc(i.qid)}">Remove from this phone</button>
          </li>`).join('')}
      </ul>
    </div>`
}

// Inline above the stop, never over a button, and the same height whether Undo is still offered or not, so nothing
// moves under a glove when the 15 s run out.
// Asked before an Undo would delete a check-in that has not been sent (clarification 28).
function confirmUndoMarkup(qid) {
  return `<div class="undo-confirm" role="group" aria-labelledby="undo-confirm-text">
      <span class="undo-confirm-text" id="undo-confirm-text">${state.confirmAttempted
        ? 'It may already be at the office. Undo it?'
        : 'This check-in has not reached the office yet. Delete it from this phone?'}</span>
      <span class="undo-confirm-buttons">
        <button class="btn-undo" id="undo-delete" type="button" data-action="undo-confirm" data-qid="${esc(qid)}">${state.confirmAttempted ? 'Undo it' : 'Delete it'}</button>
        <button class="btn-undo btn-undo-keep" id="undo-keep" type="button" data-action="undo-keep">Keep it</button>
      </span></div>`
}

function renderUndo() {
  const box = painter('undo')
  const u = state.last
  if (u && state.confirmUndo === u.id) {
    box.innerHTML = `<div class="undo-bar is-confirm">${confirmUndoMarkup(u.id)}</div>`
    return
  }
  box.innerHTML = u
    ? `<div class="undo-bar${u.canUndo ? '' : ' is-past'}" role="status"><span class="undo-text">${esc(u.canUndo ? u.text : u.past)}</span>
         ${u.canUndo ? '<button class="btn-undo" id="undo-btn" type="button" data-action="undo">Undo</button>' : ''}</div>`
    : ''
}

function renderSheet() {
  const box = $('sheet')
  const sh = state.sheet
  document.body.classList.toggle('has-sheet', !!sh)
  if (!sh) { box.innerHTML = ''; return }
  box.innerHTML = `
    <div class="sheet-backdrop" data-action="sheet-backdrop">
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
        <h2 id="sheet-title" class="sheet-title">Why are you skipping?</h2>
        <p class="muted">${esc(sh.name)}</p>
        <div class="choices">
          ${REASONS.map(([code, label]) => `<button class="btn btn-choice${sh.other && code === 'other' ? ' is-chosen' : ''}" type="button" data-action="reason" data-reason="${code}"${code === 'other' ? ` aria-expanded="${sh.other}"` : ''}>${label}</button>`).join('')}
        </div>
        ${sh.other ? `
          <label class="field-label" for="skip-note">Add a note (optional)</label>
          <input class="field" id="skip-note" type="text" maxlength="120" autocomplete="off" enterkeyhint="done">
          <button class="btn btn-skip" id="skip-other" type="button" data-action="skip-other">Skip this stop</button>` : ''}
        <button class="btn btn-quiet" id="sheet-back" type="button" data-action="close-sheet">Back</button>
      </div>
    </div>`
}

/* ---- actions ------------------------------------------------------------ */
async function refreshItems() {
  try { state.items = await queue.all() } catch { /* IndexedDB unavailable: nothing queued to show */ }
}

function lockButtons() {
  state.locked = true
  setTimeout(() => { state.locked = false; renderStop() }, LOCK_MS)
}

let undoTimer = null
async function record(clientId, { kind, reason = null, note = '', at, photo = null }) {
  const stop = stops().find((s) => s.client_id === clientId)
  if (!stop) return
  const id = uuid()
  const body = { id, storm_id: state.route.storm.id, client_id: clientId, kind, note, at, has_photo: !!photo }
  if (kind === 'skipped') body.reason = reason
  try {
    await queue.add({ qid: id, op: 'checkin', state: 'send', key, truck_id: pageTruck(), label: stop.name, body, photo, error: null })
    state.lastItem = { key, truck_id: pageTruck(), label: stop.name, body: { id, storm_id: body.storm_id, client_id: clientId } }
  } catch {
    state.notice = 'This phone could not save the check-in. Try again, or tell the owner.'
    render()
    return
  }
  state.focus = null
  const word = kind === 'plowed' ? 'Plowed' : 'Skipped'
  state.last = { id, canUndo: true, text: `${word}: ${stop.name}`, past: `Last stop: ${stop.name}, ${word.toLowerCase()} at ${timeLabel(at, zone())}`, item: state.lastItem }
  state.confirmUndo = null
  clearTimeout(undoTimer)
  undoTimer = setTimeout(() => { if (state.last?.id === id) { state.last.canUndo = false; renderUndo() } }, UNDO_MS)
  lockButtons()
  await refreshItems()
  render()
  window.scrollTo({ top: 0 })
  sender.flush()
}

// Take back one queued item, decided in one transaction (clarifications 19 and 26):
// - not sent yet ('send'): mark it 'undone'; the sender deletes it, or sends the undo if it was already on its way;
// - refused by the server ('rejected'): remove it from the phone only;
// - on the server with its photo still waiting ('photo'), or gone because it was sent: queue the undo (a DELETE).
// `known` is the item as the screen last saw it ({ key, truck_id, label, body }), for when it has already left the queue.
async function takeBack(qid, known) {
  const outcome = await queue.update(qid, (it) => {
    if (!it) return { result: 'gone' }
    if (it.state === 'send') return { item: { ...it, state: 'undone' }, result: 'marked' }
    if (it.state === 'rejected') return { item: null, result: 'removed' }
    // Its check-in is on the server and only its photo waits: the undo replaces it in this same transaction (clarification 50).
    if (it.state === 'photo') return { item: null, also: [queue.voidFor(it, { stuck: !!it.stuck })], result: 'on-server' }
    return { result: 'kept' }
  })
  if (outcome === 'gone' && known) {
    // Sent and answered (the row exists): nothing left to replace, so the undo is simply added.
    await queue.add(queue.voidFor(known, { truckId: known.truck_id ?? truckOfKey(known.key) }))
  }
  return outcome
}

// The queued item if it has not been answered yet (so Undo asks first), else null. `attempted` picks the words (clarification 38).
async function unanswered(qid) {
  const it = await queue.get(qid)
  return it?.state === 'send' ? it : null
}

async function undo(confirmed = false) {
  const u = state.last
  if (!u || (!u.canUndo && state.confirmUndo !== u.id)) return
  const waiting = !confirmed && await unanswered(u.id)
  if (waiting) {
    state.confirmUndo = u.id
    state.confirmAttempted = !!waiting.attempted
    return renderUndo()
  }
  clearTimeout(undoTimer)
  state.confirmUndo = null
  state.last = { id: u.id, canUndo: false, past: `Undone: ${u.text}` }
  await takeBack(u.id, u.item)
  await refreshItems()
  render()
  sender.flush()
}

// Decode the photo without loading a URL where the browser can (a blob: URL load can be refused with no signal), then
// downscale to at most 1600 px on the long side, JPEG quality 0.7.
async function decode(file) {
  if (globalThis.createImageBitmap) {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
      return { source: bitmap, width: bitmap.width, height: bitmap.height, done: () => bitmap.close() }
    } catch { /* fall back to an <img> */ }
  }
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = () => reject(new Error('unreadable'))
      i.src = url
    })
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, done: () => URL.revokeObjectURL(url) }
  } catch (e) {
    URL.revokeObjectURL(url)
    throw e
  }
}

async function downscale(file) {
  const img = await decode(file)
  try {
    const scale = Math.min(1, 1600 / Math.max(img.width, img.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(img.width * scale))
    canvas.height = Math.max(1, Math.round(img.height * scale))
    canvas.getContext('2d').drawImage(img.source, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.7))
    if (!blob) throw new Error('no jpeg')
    return { bytes: await blob.arrayBuffer(), type: 'image/jpeg' }
  } finally {
    img.done()
  }
}

document.addEventListener('change', async (e) => {
  if (e.target.id !== 'photo-input') return
  const at = new Date().toISOString() // the moment the photo was chosen, before any work
  const input = e.target
  const clientId = Number(input.dataset.client)
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  let photo = null
  state.notice = ''
  try {
    photo = await downscale(file)
  } catch {
    state.notice = 'Could not read that photo, so this stop is saved as plowed with no photo.'
  }
  await record(clientId, { kind: 'plowed', at, photo })
})

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-action]')
  if (!t) return
  const action = t.dataset.action
  if (action === 'sheet-backdrop') {
    if (e.target === t) { state.sheet = null; renderSheet() }
    return
  }
  if (t.disabled) return
  const clientId = Number(t.dataset.client)
  switch (action) {
    case 'plowed':
      state.notice = ''
      return record(clientId, { kind: 'plowed', at: new Date().toISOString() })
    case 'skip': {
      const s = stops().find((x) => x.client_id === clientId)
      state.sheet = { client_id: clientId, name: s?.name || '', other: false }
      return renderSheet()
    }
    case 'reason': {
      const sh = state.sheet
      if (!sh) return
      if (t.dataset.reason === 'other') { sh.other = true; return renderSheet() }
      const at = new Date().toISOString()
      state.sheet = null
      renderSheet()
      return record(sh.client_id, { kind: 'skipped', reason: t.dataset.reason, at })
    }
    case 'skip-other': {
      const sh = state.sheet
      if (!sh) return
      const at = new Date().toISOString()
      const note = (document.getElementById('skip-note')?.value || '').trim().slice(0, 120)
      state.sheet = null
      renderSheet()
      return record(sh.client_id, { kind: 'skipped', reason: 'other', note, at })
    }
    case 'close-sheet':
      state.sheet = null
      return renderSheet()
    case 'undo':
      return undo()
    case 'undo-confirm': {
      const qid = t.dataset.qid
      if (state.last?.id === qid) return undo(true)
      const known = state.items.find((i) => i.qid === qid)
      state.confirmUndo = null
      await takeBack(qid, known)
      await refreshItems()
      render()
      return sender.flush()
    }
    case 'undo-keep':
      if (state.last && state.confirmUndo === state.last.id) state.last.canUndo = false
      state.confirmUndo = null
      return render()
    case 'plowed-now':
      state.focus = clientId
      state.notice = ''
      render()
      return window.scrollTo({ top: 0 })
    case 'back':
      state.focus = null
      return render()
    case 'undo-item': {
      const qid = t.dataset.qid
      const waiting = await unanswered(qid)
      if (waiting) {
        state.confirmUndo = qid
        state.confirmAttempted = !!waiting.attempted
        return render()
      }
      await takeBack(qid, state.items.find((i) => i.qid === qid))
      await refreshItems()
      render()
      return sender.flush()
    }
    case 'dismiss-note': {
      const notes = photoNotes()
      if (typeof notes[t.dataset.id] === 'object') notes[t.dataset.id].dismissed = true
      try { localStorage.setItem(PHOTO_NOTES, JSON.stringify(notes)) } catch {}
      return render()
    }
    case 'dismiss':
      await queue.remove(t.dataset.qid)
      await refreshItems()
      return render()
    case 'reload':
      return loadRoute()
  }
})

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.sheet) { state.sheet = null; renderSheet() }
})

/* ---- loading and sending ------------------------------------------------ */
const sender = queue.createSender({
  onChange: async () => { await refreshItems(); render() },
  onSent: (itemKey, stop) => {
    if (itemKey !== key || !stop || !state.route?.stops) return
    const i = state.route.stops.findIndex((s) => s.client_id === stop.client_id)
    if (i < 0) return
    state.route.stops[i] = stop
    state.routeVersion += 1
    writeCache()
  },
  onDrained: () => loadRoute(),
  onPhotoDropped: (itemKey, id, message, item) => { notePhotoDropped(id, message, item); render() },
  truckOf: (k) => truckOfKey(k),
})

async function loadRoute() {
  if (!key) {
    state.loading = false
    state.error = "This driver link is missing its key. Open the link the owner sent you."
    return render()
  }
  const version = state.routeVersion
  try {
    const route = await api.driver.route(key)
    if (state.routeVersion !== version) return loadRoute() // a check-in answered meanwhile; this copy is older
    state.route = route
    state.savedAt = new Date().toISOString()
    state.fromCache = false
    state.error = ''
    writeCache()
    rememberKey(key, route.truck.id)
    sender.setPage({ key, truckId: route.truck.id, working: true })
  } catch (e) {
    if (e.code === 'network') {
      if (!state.route) state.error = 'No signal, and this phone has not saved the route yet. It loads when signal comes back.'
    } else if (e.status === 401) {
      sender.setPage({ key, truckId: null, working: false })
      clearCache()
      state.route = null
      state.error = e.message
    } else if (!state.route) {
      state.error = e.message
    }
  } finally {
    state.loading = false
    render()
  }
}

async function start() {
  const cached = key && readCache()
  if (cached) {
    state.route = cached.route
    state.savedAt = cached.saved_at
    state.fromCache = true
    state.loading = false
  }
  await refreshItems()
  render()
  await loadRoute()
  sender.start()
  window.addEventListener('online', () => loadRoute())
  window.addEventListener('offline', () => renderStrip())
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') loadRoute() })
  setInterval(() => { if (navigator.onLine && !state.sheet) loadRoute() }, REFRESH_MS)
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/d/sw.js', { scope: '/d/' }).catch(() => {})
start()
