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
const PHOTO_NOTES = 'snow-route:photo-not-sent' // { checkin id: server message } for photos the server refused

function photoNotes() {
  try { return JSON.parse(localStorage.getItem(PHOTO_NOTES)) || {} } catch { return {} }
}
function notePhotoDropped(id, message) {
  const notes = photoNotes()
  notes[id] = message
  try { localStorage.setItem(PHOTO_NOTES, JSON.stringify(notes)) } catch {}
}

const key = new URLSearchParams(location.search).get('k') || ''
const state = {
  route: null, savedAt: null, fromCache: false, error: '', loading: true,
  items: [], last: null, focus: null, locked: false, notice: '', sheet: null, routeVersion: 0,
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

function stops() {
  const route = state.route
  if (!route?.storm) return []
  const list = route.stops.map((s) => ({ ...s, queued: false }))
  const byClient = new Map(list.map((s) => [s.client_id, s]))
  for (const item of state.items) {
    if (item.key !== key || item.state === 'rejected' || item.body.storm_id !== route.storm.id) continue
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
  const live = state.items.filter((i) => i.key === key && i.state !== 'rejected')
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
  const dropped = s.checkin && photoNotes()[s.checkin.id]
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

function renderRejected() {
  const box = painter('rejected')
  const bad = state.items.filter((i) => i.key === key && i.state === 'rejected')
  if (!bad.length) { box.innerHTML = ''; return }
  box.innerHTML = `
    <div class="rejected" id="not-accepted">
      <h2 class="section-title">Not accepted</h2>
      <p class="muted">These were saved on this phone, but the server did not take them. Tell the owner.</p>
      <ul class="rejected-list">
        ${bad.map((i) => `
          <li>
            <strong>${esc(i.label)}</strong>
            <span class="muted">${esc(i.op === 'void' ? 'Undo' : i.body.kind === 'plowed' ? 'Plowed' : `Skipped: ${reasonText(i.body.reason, i.body.note)}`)}${i.body.at ? ` at ${esc(timeLabel(i.body.at, zone()))}` : ''}</span>
            <span class="error-text">${esc(i.error)}</span>
            <button class="btn-row" type="button" data-action="dismiss" data-qid="${esc(i.qid)}">Remove from this phone</button>
          </li>`).join('')}
      </ul>
    </div>`
}

// Inline above the stop, never over a button, and the same height whether Undo is still offered or not, so nothing
// moves under a glove when the 15 s run out.
function renderUndo() {
  const box = painter('undo')
  const u = state.last
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
    await queue.add({ qid: id, op: 'checkin', state: 'send', key, label: stop.name, body, photo, error: null })
  } catch {
    state.notice = 'This phone could not save the check-in. Try again, or tell the owner.'
    render()
    return
  }
  state.focus = null
  const word = kind === 'plowed' ? 'Plowed' : 'Skipped'
  state.last = { id, canUndo: true, text: `${word}: ${stop.name}`, past: `Last stop: ${stop.name}, ${word.toLowerCase()} at ${timeLabel(at, zone())}` }
  clearTimeout(undoTimer)
  undoTimer = setTimeout(() => { if (state.last?.id === id) { state.last.canUndo = false; renderUndo() } }, UNDO_MS)
  lockButtons()
  await refreshItems()
  render()
  window.scrollTo({ top: 0 })
  sender.flush()
}

async function undo() {
  const u = state.last
  if (!u?.canUndo) return
  clearTimeout(undoTimer)
  state.last = { id: u.id, canUndo: false, past: `Undone: ${u.text}` }
  const item = await queue.get(u.id)
  if (item?.state === 'send') {
    await queue.remove(u.id) // never left the phone: just take it back
  } else {
    if (item) await queue.remove(u.id) // its photo was still waiting; the check-in itself is on the server
    const s = state.route.stops.find((x) => x.checkin?.id === u.id)
    await queue.add({ qid: `void:${u.id}`, op: 'void', state: 'send', key, label: s?.name || u.text,
      body: { id: u.id, storm_id: state.route.storm.id, client_id: s?.client_id ?? item?.body.client_id }, photo: null, error: null })
  }
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
    case 'plowed-now':
      state.focus = clientId
      state.notice = ''
      render()
      return window.scrollTo({ top: 0 })
    case 'back':
      state.focus = null
      return render()
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
  onPhotoDropped: (itemKey, id, message) => { notePhotoDropped(id, message); renderList() },
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
  } catch (e) {
    if (e.code === 'network') {
      if (!state.route) state.error = 'No signal, and this phone has not saved the route yet. It loads when signal comes back.'
    } else if (e.status === 401) {
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
