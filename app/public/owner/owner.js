// Owner side /owner/: PIN sign-in; Tonight (start a storm; each truck's route with drag to reorder, Move up / Move down /
// Move to another truck, Add a stop, copy texts; End storm with an inline confirm, then the summary; past storms); Clients (list,
// map, add/edit with a map pin, deactivate, New status link, copy the status text); Trucks (add, rename, deactivate, driver link,
// New link); Billing (month, table, totals, CSV for the accountant); Settings (company name, yard pin, Change PIN).
// Talks only to the API through api.js; the API's own error text is shown next to the field it names. Nothing is ever sent to a
// client: messages are copy buttons. Leaflet is a classic script (global L); tiles are OpenStreetMap's, attribution always shown.
import { api, session, SIGNED_OUT } from '/api.js'
import { esc, brandBar, plural, clockLabel, NL_ZONE } from '/ui.js'

const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
const TYPES = [['driveway', 'Driveway'], ['lot', 'Parking lot'], ['walkway', 'Walkway']]
const PRIORITIES = [['none', 'None'], ['medical', 'Medical'], ['commuter', 'Early commuter'], ['business', 'Business opening']]
const BILLING = [['per_push', 'Per push'], ['seasonal', 'Seasonal contract']]
const VIEWS = [['tonight', 'Tonight'], ['clients', 'Clients'], ['trucks', 'Trucks'], ['billing', 'Billing'], ['settings', 'Settings']]
// Truck lines and swatches use Design tokens only: ice blue, then white, then muted.
const TRUCK_COLOURS = ['#7cc4ff', '#eef3fb', '#a3b3cc']
const TRUCK_COLOUR_NAMES = ['blue', 'white', 'grey']
// A truck's pins carry its line colour as a ring AND a shape of its own, so the trucks tell apart without seeing colour.
const TRUCK_SHAPES = ['round', 'square', 'dashed']
const TRUCK_SHAPE_NAMES = ['round', 'square', 'dashed-ring']
const truckLook = (i) => ({
  colour: TRUCK_COLOURS[i % TRUCK_COLOURS.length], colourName: TRUCK_COLOUR_NAMES[i % TRUCK_COLOUR_NAMES.length],
  shape: TRUCK_SHAPES[i % TRUCK_SHAPES.length], shapeName: TRUCK_SHAPE_NAMES[i % TRUCK_SHAPE_NAMES.length],
})
const truckMark = (i) => { const l = truckLook(i); return `<span class="truck-mark shape-${l.shape}" data-truck="${i + 1}" style="border-color:${l.colour}" aria-hidden="true"></span>` }
const STORM_REFRESH_MS = 30_000
const PRICE_TEXT = 'Type a price in dollars and cents.'
const GRIP = '<svg aria-hidden="true" width="18" height="24" viewBox="0 0 18 24"><g fill="currentColor"><circle cx="5" cy="5" r="2"/><circle cx="13" cy="5" r="2"/><circle cx="5" cy="12" r="2"/><circle cx="13" cy="12" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="13" cy="19" r="2"/></g></svg>'

const app = document.getElementById('app')
const state = {
  company: null, clients: [], trucks: [], storm: null, editing: null, pin: null, picking: null, notice: '', stormNotice: '',
  confirm: null, adding: false, saving: false, renaming: null, addingTruck: false, billingMonth: null, yardPin: null, stopErrors: {},
}
let map = null
let pinMarker = null
let stormTimer = null
let drag = null
let edits = 0 // route changes started on this screen; a refresh that saw fewer is older than the screen (clarification 40)

const $ = (id) => document.getElementById(id)
const money = (cents) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const round5 = (n) => Math.round(n * 1e5) / 1e5
const options = (list, value) => list.map(([v, l]) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(l)}</option>`).join('')
const zone = () => state.company?.timezone || NL_ZONE
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const monthLabel = (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`
const dayLabel = (d) => `${SHORT[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`

// "45", "45.5", "45.50", ".50", "45." and "$1,200.00" → cents; anything else → null (clarification 23).
function dollarsToCents(text) {
  const t = String(text).trim().replace(/^\$/, '').replace(/,(?=\d{3}(\D|$))/g, '')
  return /^(\d+\.?\d{0,2}|\.\d{1,2})$/.test(t) ? Math.round(Number(t) * 100) : null
}

// The current month in the company's zone, "YYYY-MM".
function thisMonth() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone(), year: 'numeric', month: '2-digit' }).formatToParts(new Date()).map((x) => [x.type, x.value]))
  return `${p.year}-${p.month}`
}

// #tonight, #clients, … and #storm/<id> (a storm's summary, under Tonight).
function where() {
  const h = location.hash.slice(1)
  const m = /^storm\/(\d+)$/.exec(h)
  if (m) return { view: 'tonight', summary: Number(m[1]) }
  if (h === 'past') return { view: 'tonight', summary: null, past: true }
  return { view: VIEWS.some(([id]) => id === h) ? h : 'tonight', summary: null }
}

// The notice above Tonight, used once. A needsStorm notice ("a storm is already on") is dropped when no storm is found (clarification 31).
function takeNotice(hasStorm) {
  const n = state.stormNotice
  state.stormNotice = ''
  if (!n) return ''
  if (typeof n === 'string') return n
  return !n.needsStorm || hasStorm ? n.text : ''
}
const noticeHtml = (text) => (text ? `<p class="notice" id="storm-notice" role="alert">${esc(text)}</p>` : '')

/* ---- copy buttons ------------------------------------------------------------ */
function copyButton(text, label, extra = '') {
  return `<button class="btn-small copy-btn" type="button" data-action="copy" data-copy="${esc(text)}" data-label="${esc(label)}"${extra}>${esc(label)}</button>`
}
function messagesBlock(messages) {
  if (!messages?.length) return ''
  return `
    <details class="texts">
      <summary>Texts to copy</summary>
      <ul class="text-list">
        ${messages.map((m) => `<li data-kind="${esc(m.kind)}"><p class="text-preview">${esc(m.text)}</p>${copyButton(m.text, m.label, ` data-kind="${esc(m.kind)}"`)}</li>`).join('')}
      </ul>
    </details>`
}
async function copy(btn) {
  const text = btn.dataset.copy
  const label = btn.dataset.label
  try {
    await navigator.clipboard.writeText(text)
    btn.textContent = 'Copied'
    setTimeout(() => { if (btn.isConnected) btn.textContent = label }, 2500)
  } catch {
    let note = btn.parentElement.querySelector('.copy-fallback')
    if (!note) {
      note = document.createElement('p')
      note.className = 'copy-fallback muted'
      note.setAttribute('role', 'status')
      btn.after(note)
    }
    note.textContent = `This browser would not copy it. Select this text and copy it: ${text}`
  }
}

/* ---- map ------------------------------------------------------------------ */
function makeMap(id) {
  stopMap()
  map = L.map($(id), { zoomControl: true, attributionControl: true })
  L.tileLayer(TILE_URL, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(map)
  map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>')
  const y = state.company?.yard
  map.setView(y ? [y.lat, y.lng] : [48.94, -55.66], 13)
  return map
}
function stopMap() {
  if (map) map.remove()
  map = null
  pinMarker = null
}
const dot = (cls, html = '', size = 26) => L.divIcon({ className: `pin ${cls}`, html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] })
function yardMarker() {
  const y = state.company?.yard
  if (y) L.marker([y.lat, y.lng], { icon: dot('pin-yard', 'Y', 28), title: y.label, interactive: false, keyboard: false }).addTo(map)
}
function fit(points) {
  if (points.length) map.fitBounds(L.latLngBounds(points).pad(0.08), { maxZoom: 16 })
}

/* ---- sign-in ------------------------------------------------------------------ */
function showSignin(message = '') {
  stopMap()
  clearInterval(stormTimer)
  app.innerHTML = `
    <main class="landing-wrap">
      <article class="landing-card">
        <header class="status-head">${brandBar(state.company)}</header>
        <h1 class="landing-title">Owner sign-in</h1>
        <form id="signin-form" class="signin" novalidate>
          <label class="field-label" for="pin">PIN</label>
          <input class="field" id="pin" name="pin" type="password" inputmode="numeric" autocomplete="current-password" maxlength="8">
          <p class="field-error" id="pin-error" role="alert">${esc(message)}</p>
          <button class="btn btn-nav" id="signin-btn" type="submit">Sign in</button>
        </form>
        <p class="muted"><a href="/">Back to the start</a></p>
      </article>
    </main>`
}

async function signin() {
  const btn = $('signin-btn')
  const pin = $('pin')
  btn.disabled = true
  try {
    const r = await api.owner.signin(pin.value)
    session.set(r.token)
    await showApp()
  } catch (e) {
    $('pin-error').textContent = e.message
    pin.value = ''
    btn.disabled = false
  }
}

/* ---- shell ------------------------------------------------------------------ */
function paintBar() {
  const bar = document.querySelector('.bar')
  if (bar) bar.innerHTML = brandBar(state.company, '<button class="btn-small" id="signout" type="button" data-action="signout">Sign out</button>')
}

async function showApp() {
  app.innerHTML = `
    <header class="bar"></header>
    <nav class="tabs" aria-label="Owner sections">
      ${VIEWS.map(([id, label]) => `<a class="tab" href="#${id}" data-view="${id}">${label}</a>`).join('')}
    </nav>
    <main class="owner-main" id="view"><p class="loading">Loading…</p></main>`
  paintBar()
  await render()
}

async function render() {
  const w = where()
  document.querySelectorAll('.tab').forEach((t) => {
    if (t.dataset.view === w.view) t.setAttribute('aria-current', 'page')
    else t.removeAttribute('aria-current')
  })
  clearInterval(stormTimer)
  try {
    if (w.summary) await renderSummary(w.summary)
    else if (w.past) await renderPast()
    else if (w.view === 'clients') await renderClients()
    else if (w.view === 'trucks') await renderTrucks()
    else if (w.view === 'billing') await renderBilling()
    else if (w.view === 'settings') await renderSettings()
    else await renderTonight()
  } catch (e) {
    if (e.status === 401 && !e.field) return // SIGNED_OUT takes over
    stopMap()
    $('view').innerHTML = `<p class="notice" role="alert">${esc(e.message)}</p>`
  }
}

/* ---- Tonight: no storm, picker, past storms ---------------------------------------- */
async function renderTonight() {
  state.storm = (await api.owner.currentStorm()).storm
  if (state.storm) return paintStorm()
  if (state.picking) return paintPicker()
  stopMap()
  const { storms } = await api.owner.storms()
  const notice = takeNotice(false)
  $('view').innerHTML = `
    <section class="panel narrow">
      ${noticeHtml(notice)}
      <h1 class="view-title">Tonight</h1>
      <p class="lead">No storm on right now.</p>
      <button class="btn btn-nav btn-inline" id="start-storm" type="button" data-action="start-picking">Start a storm</button>
      <h2 class="section-title">Past storms</h2>
      ${pastList(storms)}
    </section>`
}

function pastList(storms) {
  const ended = storms.filter((s) => s.status === 'ended')
  if (!ended.length) return '<p class="muted" id="past-storms">No storms yet.</p>'
  return `
    <ul class="past-list" id="past-storms">
      ${ended.map((s) => `
        <li class="past-row" data-storm-id="${s.id}">
          <div class="row-main">
            <span class="row-name">${esc(s.name)}</span>
            <span class="row-addr">${esc(s.started_label)}${s.ended_label ? ` to ${esc(s.ended_label)}` : ''}</span>
            <span class="row-meta muted">${s.counts.plowed} of ${plural(s.counts.stops, 'stop')} plowed · ${s.counts.skipped} skipped</span>
          </div>
          <a class="btn-small" href="#storm/${s.id}" aria-label="Open the summary of ${esc(s.name)}">Open summary</a>
        </li>`).join('')}
    </ul>`
}

// Past storms while a storm is on (clarification 36).
async function renderPast() {
  stopMap()
  const { storms } = await api.owner.storms()
  $('view').innerHTML = `
    <section class="panel narrow">
      <a class="btn-small" href="#tonight">Back to Tonight</a>
      <h1 class="view-title">Past storms</h1>
      ${pastList(storms)}
    </section>`
}

async function openPicker() {
  const [c, t] = await Promise.all([api.owner.clients(), api.owner.trucks()])
  state.clients = c.clients
  state.trucks = t.trucks
  state.picking = {
    clients: new Set(state.clients.filter((x) => x.active).map((x) => x.id)),
    trucks: new Set(state.trucks.filter((x) => x.active).map((x) => x.id)),
  }
  paintPicker()
}

function paintPicker() {
  stopMap()
  const p = state.picking
  const clients = state.clients.filter((c) => c.active)
  const trucks = state.trucks.filter((t) => t.active)
  $('view').innerHTML = `
    <form id="storm-form" class="panel narrow" novalidate>
      <h1 class="view-title">Start a storm</h1>
      <div class="panel-head">
        <h2 class="section-title">Clients tonight</h2>
        <span class="muted" id="client-count">${p.clients.size} of ${clients.length} ticked</span>
      </div>
      <div class="pick-actions">
        <button class="btn-small" type="button" data-action="tick-all">Tick all</button>
        <button class="btn-small" type="button" data-action="untick-all">Untick all</button>
      </div>
      <ul class="pick-list" id="pick-clients">
        ${clients.map((c) => `
          <li><label class="check"><input type="checkbox" name="client" value="${c.id}"${p.clients.has(c.id) ? ' checked' : ''}>
            <span><strong>${esc(c.name)}</strong> <span class="muted">${esc(c.address)}</span>
            ${c.priority !== 'none' ? `<span class="chip chip-priority">${esc(c.priority_label)}</span>` : ''}</span></label></li>`).join('')}
      </ul>
      <p class="field-error" id="err-client_ids" role="alert"></p>
      <h2 class="section-title">Trucks going out</h2>
      <ul class="pick-list" id="pick-trucks">
        ${trucks.map((t) => `
          <li><label class="check"><input type="checkbox" name="truck" value="${t.id}"${p.trucks.has(t.id) ? ' checked' : ''}>
            <span><strong>${esc(t.name)}</strong></span></label></li>`).join('')}
      </ul>
      <p class="field-error" id="err-truck_ids" role="alert"></p>
      <p class="field-error" id="form-error" role="alert"></p>
      <div class="form-actions">
        <button class="btn btn-nav btn-inline" id="build-route" type="submit">Build tonight's route</button>
        <button class="btn-small" type="button" data-action="cancel-picking">Cancel</button>
      </div>
    </form>`
}

function syncPickCount() {
  const total = document.querySelectorAll('#pick-clients input').length
  $('client-count').textContent = `${state.picking.clients.size} of ${total} ticked`
}

async function buildRoute() {
  const p = state.picking
  const btn = $('build-route')
  for (const id of ['err-client_ids', 'err-truck_ids', 'form-error']) $(id).textContent = ''
  const inOrder = (name, set) => [...document.querySelectorAll(`input[name="${name}"]`)].map((i) => Number(i.value)).filter((id) => set.has(id))
  btn.disabled = true
  try {
    state.storm = await api.owner.startStorm({ client_ids: inOrder('client', p.clients), truck_ids: inOrder('truck', p.trucks) })
    state.picking = null
    paintStorm()
  } catch (e) {
    if (e.status === 401 && !e.field) return
    if (e.status === 409 && e.code === 'bad_state') {
      // A storm was started on another screen: close the picker and show it, with the API's message (clarification 22).
      state.picking = null
      state.stormNotice = { text: e.message, needsStorm: true }
      return renderTonight()
    }
    ;($(`err-${e.field}`) || $('form-error')).textContent = e.message
    btn.disabled = false
  }
}

/* ---- Tonight: the running storm ---------------------------------------------------- */
function ownerStatus(s) {
  if (s.status === 'plowed') return `Plowed ${s.checkin.at_label}${s.checkin.photo === 'stored' ? ' · photo' : ''}`
  if (s.status === 'skipped') return `Skipped: ${s.checkin.reason_text}`
  return 'To do'
}

function stopItem(st, truck, index, trucks) {
  const others = trucks.filter((t) => t.id !== truck.id)
  return `
    <li class="stop-row owner-stop is-${st.status}" data-client-id="${st.client_id}" data-priority="${st.priority}" data-truck-id="${truck.id}">
      <button class="drag-handle" type="button" data-drag="${st.client_id}" aria-label="Drag ${esc(st.name)} to a new place">${GRIP}</button>
      <span class="num" aria-hidden="true">${st.position}</span>
      <div class="row-main">
        <span class="row-name">${esc(st.name)}</span>
        <span class="row-addr">${esc(st.address)}</span>
        <span class="row-meta">${st.priority !== 'none' ? `<span class="chip chip-priority">${esc(st.priority_label)}</span>` : ''}<span class="row-status">${esc(ownerStatus(st))}</span></span>
        <div class="stop-tools">
          <button class="btn-small" type="button" data-action="move-up" data-client="${st.client_id}"${index === 0 ? ' disabled' : ''}>Move up</button>
          <button class="btn-small" type="button" data-action="move-down" data-client="${st.client_id}"${index === truck.stops.length - 1 ? ' disabled' : ''}>Move down</button>
          ${others.map((o) => `<button class="btn-small" type="button" data-action="move-truck" data-client="${st.client_id}" data-to="${o.id}">Move to ${esc(o.name)}</button>`).join('')}
          ${st.removable === true ? `<button class="btn-small" type="button" data-action="remove-stop" data-client="${st.client_id}">Remove from tonight</button>` : ''}
        </div>
        ${state.confirm === `remove-${st.client_id}` ? `
          <div class="confirm remove-confirm" role="group" aria-labelledby="remove-text-${st.client_id}">
            <p id="remove-text-${st.client_id}"><strong>Take ${esc(st.name)} off tonight's route?</strong> The driver stops seeing this stop, and nothing is billed for it.</p>
            <div class="form-actions">
              <button class="btn-small btn-warn" type="button" data-action="remove-yes" data-client="${st.client_id}">Yes, remove it</button>
              <button class="btn-small" type="button" data-action="remove-no">Keep it</button>
            </div>
          </div>` : ''}
        ${state.stopErrors[st.client_id] ? `<p class="field-error stop-error" role="alert">${esc(state.stopErrors[st.client_id])}</p>` : ''}
        ${messagesBlock(st.messages)}
      </div>
    </li>`
}

function addStopForm() {
  const s = state.storm
  const onRoute = new Set(s.trucks.flatMap((t) => t.stops.map((x) => x.client_id)))
  const free = state.clients.filter((c) => c.active && !onRoute.has(c.id))
  if (!free.length) {
    return `<div class="confirm" id="add-stop-form"><p>Every active client is already on tonight's route.</p>
      <button class="btn-small" type="button" data-action="cancel-add-stop">Close</button></div>`
  }
  return `
    <form class="confirm" id="add-stop-form" novalidate>
      <h2 class="section-title">Add a stop</h2>
      <div class="field-row">
        <div class="form-field"><label class="field-label" for="stop-client">Client</label>
          <select class="field" id="stop-client">${options(free.map((c) => [String(c.id), c.name]), '')}</select>
          <p class="field-error" id="err-client_id" role="alert"></p></div>
        <div class="form-field"><label class="field-label" for="stop-truck">Truck</label>
          <select class="field" id="stop-truck">${options(s.trucks.map((t) => [String(t.id), t.name]), '')}</select>
          <p class="field-error" id="err-truck_id" role="alert"></p></div>
      </div>
      <p class="field-error" id="add-stop-error" role="alert"></p>
      <div class="form-actions">
        <button class="btn-small btn-primary" id="add-stop-save" type="submit">Add to the end of that route</button>
        <button class="btn-small" type="button" data-action="cancel-add-stop">Cancel</button>
      </div>
    </form>`
}

function paintStorm() {
  const s = state.storm
  const notice = takeNotice(true)
  $('view').innerHTML = `
    ${noticeHtml(notice)}
    <div class="storm-head">
      <h1 class="view-title">${esc(s.name)}</h1>
      <p class="muted">Started ${esc(s.started_label)} · ${s.counts.plowed} plowed · ${s.counts.skipped} skipped · ${s.counts.pending} to go</p>
      <p class="order-note" id="order-note">${esc(s.order_note)}</p>
      <div class="storm-actions">
        <button class="btn-small" id="add-stop" type="button" data-action="add-stop">Add a stop</button>
        <button class="btn-small btn-warn" id="end-storm" type="button" data-action="end-storm">End storm</button>
        <a class="btn-small" id="past-storms-link" href="#past">Past storms</a>
      </div>
      ${state.confirm === 'end' ? `
        <div class="confirm" id="end-confirm" role="group" aria-labelledby="end-confirm-text">
          <p id="end-confirm-text"><strong>End this storm?</strong> Drivers stop seeing the route. Check-ins still saved on their phones keep sending and still count.</p>
          <p class="field-error" id="end-error" role="alert"></p>
          <div class="form-actions">
            <button class="btn-small btn-warn" id="end-yes" type="button" data-action="end-yes">Yes, end the storm</button>
            <button class="btn-small" type="button" data-action="end-no">Keep it going</button>
          </div>
        </div>` : ''}
      ${state.adding ? addStopForm() : ''}
    </div>
    <p class="field-error" id="route-error" role="alert"></p>
    <div class="split">
      <section class="panel" id="route-lists">
        ${s.trucks.map((t, i) => `
          <section class="truck-stops" data-truck-id="${t.id}">
            <h2 class="section-title">${truckMark(i)}${esc(t.name)} · ${plural(t.stops.length, 'stop')}</h2>
            <ol class="owner-stops" data-truck-id="${t.id}">
              ${t.stops.map((st, index) => stopItem(st, t, index, s.trucks)).join('')}
            </ol>
            ${t.stops.length ? '' : '<p class="muted empty-route">No stops on this truck. Drag one here or use Move to.</p>'}
          </section>`).join('')}
      </section>
      <section class="panel map-panel">
        <div class="map map-tall" id="map" role="region" aria-label="Tonight's route on the map"></div>
        <p class="map-legend">
          Numbered pins are the order: green is plowed, amber is skipped, dark is still to do. Each truck's pins have their own shape and ring colour.
          ${s.trucks.map((t, i) => `<span class="legend-item legend-truck" data-truck="${i + 1}">${truckMark(i)}${esc(t.name)}: ${truckLook(i).shapeName} pins, ${truckLook(i).colourName} line</span>`).join('')}
          Lines are straight, not roads.
        </p>
      </section>
    </div>`
  makeMap('map')
  yardMarker()
  const y = state.company?.yard
  const points = y ? [[y.lat, y.lng]] : []
  s.trucks.forEach((t, i) => {
    const look = truckLook(i)
    const colour = look.colour
    const line = t.stops.map((st) => [st.lat, st.lng])
    if (y) line.unshift([y.lat, y.lng])
    L.polyline(line, { color: colour, weight: 4, opacity: 0.85, interactive: false }).addTo(map)
    for (const st of t.stops) {
      points.push([st.lat, st.lng])
      L.marker([st.lat, st.lng], {
        icon: L.divIcon({ className: `route-pin is-${st.status} shape-${look.shape}`, html: `<span data-truck="${i + 1}" style="border-color:${colour}">${st.position}</span>`, iconSize: [30, 30], iconAnchor: [15, 15] }),
        title: `${t.name}, stop ${st.position}: ${st.name}`,
        riseOnHover: true,
      }).addTo(map)
    }
  })
  fit(points)
  clearInterval(stormTimer)
  stormTimer = setInterval(refreshStorm, STORM_REFRESH_MS)
}

async function refreshStorm() {
  const busy = state.saving || drag || state.confirm || state.adding || document.querySelector('.texts[open]')
  if (where().summary || where().view !== 'tonight' || document.visibilityState !== 'visible' || busy) return
  const editsBefore = edits
  try {
    const next = (await api.owner.currentStorm()).storm
    // Drop an answer that is older than the screen: a save, drag, add or remove started while it was on its way, or a lower version.
    if (edits !== editsBefore || state.saving || drag) return
    if (next && state.storm && next.id === state.storm.id && next.route_version < state.storm.route_version) return
    if (JSON.stringify(next) === JSON.stringify(state.storm)) return
    clearInterval(stormTimer)
    state.storm = next
    if (next) paintStorm()
    else renderTonight()
  } catch {}
}

const routeLists = () => state.storm.trucks.map((t) => ({ truck_id: t.id, client_ids: t.stops.map((s) => s.client_id) }))

// Every route change goes through the route PUT with the route_version of the Storm on screen. A 409 (the route changed on another
// screen) reloads and says so (clarification 32).
async function saveRoute(lists) {
  if (state.saving) return
  edits += 1
  state.saving = true
  document.querySelectorAll('.stop-tools button, .drag-handle').forEach((b) => { b.disabled = true })
  try {
    state.storm = await api.owner.saveRoute(state.storm.id, lists, state.storm.route_version)
    state.saving = false
    paintStorm()
  } catch (e) {
    state.saving = false
    if (e.status === 401 && !e.field) return
    if (e.status === 409) {
      state.stormNotice = { text: e.message, needsStorm: false } // the route changed, or the storm ended on another screen
      return renderTonight()
    }
    paintStorm()
    $('route-error').textContent = e.message
  }
}

function moveWithin(clientId, delta) {
  const lists = routeLists()
  const list = lists.find((l) => l.client_ids.includes(clientId))
  const i = list.client_ids.indexOf(clientId)
  const j = i + delta
  if (j < 0 || j >= list.client_ids.length) return
  ;[list.client_ids[i], list.client_ids[j]] = [list.client_ids[j], list.client_ids[i]]
  return saveRoute(lists)
}

function moveToTruck(clientId, truckId) {
  const lists = routeLists()
  for (const l of lists) l.client_ids = l.client_ids.filter((id) => id !== clientId)
  lists.find((l) => l.truck_id === truckId).client_ids.push(clientId)
  return saveRoute(lists)
}

/* ---- drag to reorder (pointer events on the handle) ------------------------------ */
function dropTarget(y) {
  for (const section of document.querySelectorAll('.truck-stops')) {
    const box = section.getBoundingClientRect()
    if (y < box.top || y > box.bottom) continue
    const ol = section.querySelector('.owner-stops')
    const items = [...ol.children].filter((li) => li !== drag.li)
    const before = items.find((li) => { const r = li.getBoundingClientRect(); return y < r.top + r.height / 2 }) || null
    return { truckId: Number(section.dataset.truckId), before, ol }
  }
  return null
}
function showDrop(target) {
  document.querySelectorAll('.drop-before, .drop-end').forEach((el) => el.classList.remove('drop-before', 'drop-end'))
  if (!target) return
  if (target.before) target.before.classList.add('drop-before')
  else target.ol.classList.add('drop-end')
}

document.addEventListener('pointerdown', (e) => {
  const handle = e.target.closest('.drag-handle')
  if (!handle || handle.disabled || state.saving || e.button > 0) return
  e.preventDefault()
  const li = handle.closest('li')
  handle.setPointerCapture(e.pointerId)
  edits += 1
  drag = { id: Number(handle.dataset.drag), li, pointerId: e.pointerId, startY: e.clientY, target: null }
  li.classList.add('is-dragging')
})
document.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return
  drag.li.style.transform = `translateY(${e.clientY - drag.startY}px)`
  drag.target = dropTarget(e.clientY)
  showDrop(drag.target)
})
function endDrag(e) {
  if (!drag || e.pointerId !== drag.pointerId) return
  const d = drag
  drag = null
  d.li.classList.remove('is-dragging')
  d.li.style.transform = ''
  showDrop(null)
  if (e.type === 'pointercancel' || !d.target) return
  const lists = routeLists()
  const before = JSON.stringify(lists)
  for (const l of lists) l.client_ids = l.client_ids.filter((id) => id !== d.id)
  const list = lists.find((l) => l.truck_id === d.target.truckId)
  const at = d.target.before ? list.client_ids.indexOf(Number(d.target.before.dataset.clientId)) : -1
  if (at < 0) list.client_ids.push(d.id)
  else list.client_ids.splice(at, 0, d.id)
  if (JSON.stringify(lists) !== before) saveRoute(lists)
}
document.addEventListener('pointerup', endDrag)
document.addEventListener('pointercancel', endDrag)

async function addStop() {
  for (const id of ['err-client_id', 'err-truck_id', 'add-stop-error']) $(id).textContent = ''
  const btn = $('add-stop-save')
  edits += 1
  btn.disabled = true
  try {
    state.storm = await api.owner.addStop(state.storm.id, { client_id: Number($('stop-client').value), truck_id: Number($('stop-truck').value) })
    state.adding = false
    paintStorm()
  } catch (e) {
    if (e.status === 401 && !e.field) return
    if (e.status === 409) {
      // The storm ended (or changed) on another screen: close the form and repaint Tonight with the message (clarification 36).
      state.adding = false
      state.stormNotice = { text: e.message, needsStorm: false }
      return renderTonight()
    }
    ;($(`err-${e.field}`) || $('add-stop-error')).textContent = e.message
    btn.disabled = false
  }
}

async function endStorm() {
  const btn = $('end-yes')
  btn.disabled = true
  try {
    const r = await api.owner.endStorm(state.storm.id)
    state.confirm = null
    location.hash = `#storm/${r.storm.id}`
  } catch (e) {
    if (e.status === 401 && !e.field) return
    if (e.status === 409) {
      // Ended on another screen: close the confirm and show that storm's summary with the message (clarification 36).
      state.confirm = null
      state.stormNotice = { text: e.message, needsStorm: false }
      location.hash = `#storm/${state.storm.id}`
      return
    }
    $('end-error').textContent = e.message
    btn.disabled = false
  }
}

// "Remove from tonight" (clarification 37). A 409 shows the API's message on that stop, or repaints Tonight if the storm ended.
async function removeStop(clientId) {
  const storm = state.storm
  edits += 1
  try {
    state.storm = await api.owner.removeStop(storm.id, clientId)
    state.confirm = null
    delete state.stopErrors[clientId]
    paintStorm()
  } catch (e) {
    if (e.status === 401 && !e.field) return
    state.confirm = null
    if (e.status === 409 || e.status === 404) {
      // Refused, or already removed on another screen (404, clarification 44): reload the Storm, then say why.
      const now = (await api.owner.currentStorm()).storm
      if (!now || now.id !== storm.id) {
        state.stormNotice = { text: e.message, needsStorm: false }
        return renderTonight()
      }
      state.storm = now
      if (!now.trucks.some((t) => t.stops.some((x) => x.client_id === clientId))) {
        state.stormNotice = { text: e.message, needsStorm: false }
        return paintStorm()
      }
    }
    state.stopErrors[clientId] = e.message
    paintStorm()
  }
}

/* ---- storm summary ------------------------------------------------------------ */
async function renderSummary(id) {
  stopMap()
  const [storm, summary] = await Promise.all([api.owner.storm(id), api.owner.summary(id)])
  const skippedText = (clientId) => storm.trucks.flatMap((t) => t.stops).find((s) => s.client_id === clientId)?.messages?.find((m) => m.kind === 'skipped')
  $('view').innerHTML = `
    <section class="panel narrow summary" id="summary" data-storm-id="${summary.storm_id}">
      <a class="btn-small" href="#tonight">Back to Tonight</a>
      ${noticeHtml(takeNotice(true))}
      <h1 class="view-title">${esc(summary.name)}</h1>
      <p class="muted">Started ${esc(summary.started_label)}${summary.ended_label ? ` · ended ${esc(summary.ended_label)} · ${esc(summary.duration_label)}` : ' · still on'}</p>
      <dl class="tiles">
        <div class="tile"><dt>Stops</dt><dd id="sum-stops">${summary.stops}</dd></div>
        <div class="tile"><dt>Plowed</dt><dd id="sum-plowed">${summary.plowed}</dd></div>
        <div class="tile"><dt>Skipped</dt><dd id="sum-skipped">${summary.skipped.length}</dd></div>
        <div class="tile"><dt>Not reached</dt><dd id="not-reached-count">${summary.not_reached.length}</dd></div>
        <div class="tile"><dt>Pushes to bill</dt><dd id="sum-pushes">${summary.billable_pushes}</dd></div>
      </dl>

      <h2 class="section-title">Per truck</h2>
      <div class="table-wrap">
        <table class="data-table" id="summary-trucks">
          <thead><tr><th scope="col">Truck</th><th scope="col" class="cell-num">Plowed</th><th scope="col" class="cell-num">Skipped</th><th scope="col" class="cell-num">Not reached</th><th scope="col">First check-in</th><th scope="col">Last check-in</th></tr></thead>
          <tbody>
            ${summary.trucks.map((t) => `<tr data-truck-id="${t.id}"><th scope="row">${esc(t.name)}</th><td class="cell-num">${t.plowed}</td><td class="cell-num">${t.skipped}</td><td class="cell-num">${t.pending}</td><td>${esc(t.first_label || '—')}</td><td>${esc(t.last_label || '—')}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>

      <h2 class="section-title">Skipped (${summary.skipped.length})</h2>
      ${summary.skipped.length ? `
        <ul class="summary-list" id="summary-skipped">
          ${summary.skipped.map((k) => {
            const m = skippedText(k.client_id)
            return `<li data-client-id="${k.client_id}"><span class="row-name">${esc(k.name)}</span>
              <span class="row-status is-skipped-text">${esc(k.reason_text)} at ${esc(k.at_label)}</span>
              ${m ? `<p class="text-preview">${esc(m.text)}</p>${copyButton(m.text, m.label)}` : ''}</li>`
          }).join('')}
        </ul>` : '<p class="muted" id="summary-skipped">No stops were skipped.</p>'}

      <h2 class="section-title">Not reached (${summary.not_reached.length})</h2>
      ${summary.not_reached.length ? `
        <ul class="summary-list" id="summary-not-reached">
          ${summary.not_reached.map((n) => `<li data-client-id="${n.client_id}"><span class="row-name">${esc(n.name)}</span></li>`).join('')}
        </ul>` : '<p class="muted" id="summary-not-reached">Every stop was reached.</p>'}
    </section>`
}

/* ---- Clients ------------------------------------------------------------------ */
async function renderClients() {
  const [c, t] = await Promise.all([api.owner.clients(), api.owner.trucks()])
  state.clients = c.clients
  state.trucks = t.trucks
  paintClients()
}

function clientRow(c) {
  const truck = state.trucks.find((t) => t.id === c.truck_id)
  const priority = c.priority !== 'none'
    ? `<span class="chip chip-priority">${esc(c.priority_label)}${c.opens_at ? `, opens ${esc(clockLabel(c.opens_at))}` : ''}</span>` : ''
  return `
    <li class="client-row${c.active ? '' : ' is-inactive'}" data-client-id="${c.id}">
      <div class="row-main">
        <span class="row-name">${esc(c.name)}</span>
        <span class="row-addr">${esc(c.address)}</span>
        <span class="chips">
          <span class="chip">${esc(c.type_label)}</span>${priority}
          <span class="chip chip-billing">${c.billing === 'seasonal' ? `Seasonal ${money(c.price_cents)}` : `${money(c.price_cents)} per push`}</span>
          ${truck ? `<span class="chip">${esc(truck.name)}</span>` : ''}
          ${c.active ? '' : '<span class="chip">Inactive</span>'}
        </span>
      </div>
      <button class="btn-small" type="button" data-action="edit-client" data-id="${c.id}" aria-label="Edit ${esc(c.name)}">Edit</button>
    </li>`
}

function field(name, id, label, control) {
  return `<div class="form-field"><label class="field-label" for="${id}">${label}</label>${control}<p class="field-error" id="err-${name}" role="alert"></p></div>`
}

function clientForm(c, messages) {
  const v = (k, d = '') => (c ? c[k] ?? d : d)
  const trucks = [['', 'No usual truck'], ...state.trucks.filter((t) => t.active || t.id === v('truck_id', null)).map((t) => [String(t.id), t.name])]
  const statusText = messages?.find((m) => m.kind === 'status_link')
  return `
    <form id="client-form" class="client-form" novalidate>
      <h1 class="view-title">${c ? `Edit ${esc(c.name)}` : 'Add a client'}</h1>
      ${c && !c.active ? '<p class="notice">This client is inactive: not on new storms. The status link still works.</p>' : ''}
      ${field('name', 'f-name', 'Name', `<input class="field" id="f-name" type="text" maxlength="80" autocomplete="off" value="${esc(v('name'))}">`)}
      ${field('address', 'f-address', 'Address the driver looks for', `<input class="field" id="f-address" type="text" maxlength="160" autocomplete="off" value="${esc(v('address'))}">`)}
      <div class="field-row">
        ${field('type', 'f-type', 'Type', `<select class="field" id="f-type">${options(TYPES, v('type', 'driveway'))}</select>`)}
        ${field('priority', 'f-priority', 'Priority', `<select class="field" id="f-priority">${options(PRIORITIES, v('priority', 'none'))}</select>`)}
      </div>
      ${field('opens_at', 'f-opens', 'Opens at (optional)', `<input class="field" id="f-opens" type="time" value="${esc(v('opens_at') || '')}">`)}
      ${field('notes', 'f-notes', 'Notes for the driver', `<textarea class="field" id="f-notes" maxlength="300" rows="3">${esc(v('notes'))}</textarea>`)}
      <div class="field-row">
        ${field('billing', 'f-billing', 'Billing', `<select class="field" id="f-billing">${options(BILLING, v('billing', 'per_push'))}</select>`)}
        ${field('price_cents', 'f-price', 'Price in dollars', `<input class="field" id="f-price" type="text" inputmode="decimal" autocomplete="off" placeholder="45.00" value="${c ? (c.price_cents / 100).toFixed(2) : ''}">`)}
      </div>
      ${field('truck_id', 'f-truck', 'Usual truck', `<select class="field" id="f-truck">${options(trucks, c?.truck_id == null ? '' : String(c.truck_id))}</select>`)}
      <p class="pin-state" id="pin-state"></p>
      <p class="field-error" id="err-lat" role="alert"></p>
      <p class="field-error" id="form-error" role="alert"></p>
      <div class="form-actions">
        <button class="btn-small btn-primary" id="save-client" type="submit">Save client</button>
        <button class="btn-small" type="button" data-action="cancel-edit">Cancel</button>
      </div>
      ${c ? `
        <section class="form-section" id="status-link-section">
          <h2 class="section-title">Status link</h2>
          <p class="muted">The client checks this link for the last plowed time and photo. Nothing is sent from here: copy the text and send it yourself.</p>
          <label class="field-label" for="status-url">Status link</label>
          <input class="field" id="status-url" type="text" readonly value="${esc(c.status_url)}">
          ${statusText ? `<p class="text-preview" id="status-text">${esc(statusText.text)}</p>
            <div class="form-actions">${copyButton(statusText.text, 'Copy status text', ' id="copy-status"')}</div>` : ''}
          <div class="form-actions">
            <button class="btn-small" id="new-status-link" type="button" data-action="confirm-status-link">New status link</button>
            <button class="btn-small" id="toggle-client" type="button" data-action="toggle-client">${c.active ? 'Deactivate client' : 'Make active again'}</button>
          </div>
          ${state.confirm === `status-${c.id}` ? `
            <div class="confirm" id="status-link-confirm" role="group" aria-labelledby="status-link-confirm-text">
              <p id="status-link-confirm-text"><strong>Make a new status link for ${esc(c.name)}?</strong> The old link stops working at once. Send the client the new one.</p>
              <div class="form-actions">
                <button class="btn-small btn-warn" id="status-link-yes" type="button" data-action="status-link-yes">Yes, make a new link</button>
                <button class="btn-small" type="button" data-action="confirm-cancel">Cancel</button>
              </div>
            </div>` : ''}
          <p class="field-error" id="client-tools-error" role="alert"></p>
        </section>` : ''}
    </form>`
}

function paintClients() {
  const editing = state.editing
  const active = state.clients.filter((c) => c.active)
  const inactive = state.clients.filter((c) => !c.active)
  const list = `
    <div class="panel-head">
      <h1 class="view-title">Clients</h1>
      <button class="btn-small btn-primary" id="add-client" type="button" data-action="add-client">Add a client</button>
    </div>
    ${state.notice ? `<p class="notice" role="status" id="clients-notice">${esc(state.notice)}</p>` : ''}
    <p class="muted">${plural(active.length, 'active client')}${inactive.length ? `, ${inactive.length} inactive` : ''}</p>
    <ul class="client-list" id="client-list">${[...active, ...inactive].map(clientRow).join('')}</ul>`
  $('view').innerHTML = `
    <div class="split${editing ? ' is-editing' : ''}">
      <section class="panel">${editing ? clientForm(editing.client, editing.messages) : list}</section>
      <section class="panel map-panel">
        <p class="map-hint" id="map-hint">${editing ? 'Tap the map where the driver should go. Drag the pin to move it.' : 'Every active client. Tap a pin to edit that client.'}</p>
        <div class="map" id="map" role="region" aria-label="${editing ? 'Map: tap to place the pin' : 'Map of clients'}"></div>
        <p class="map-legend" id="clients-legend">${editing
          ? '<span class="legend-item"><span class="legend-dot pin-edit"></span>This client\'s pin</span>'
          : '<span class="legend-item"><span class="legend-dot pin-client"></span>Client</span><span class="legend-item"><span class="legend-dot pin-client is-medical"></span>Medical client (goes first)</span><span class="legend-item"><span class="legend-dot pin-yard">Y</span>Yard</span>'}</p>
      </section>
    </div>`
  makeMap('map')
  if (editing) {
    map.on('click', (e) => placePin({ lat: round5(e.latlng.lat), lng: round5(e.latlng.lng) }))
    if (state.pin) {
      placePin(state.pin)
      map.setView([state.pin.lat, state.pin.lng], 16)
    } else {
      fit(state.clients.filter((c) => c.active).map((c) => [c.lat, c.lng]))
      updatePinState()
    }
    return
  }
  yardMarker()
  for (const c of active) {
    L.marker([c.lat, c.lng], { icon: dot(`pin-client${c.priority === 'medical' ? ' is-medical' : ''}`), title: c.name, riseOnHover: true })
      .addTo(map).on('click', () => startEdit(c.id))
  }
  fit(active.map((c) => [c.lat, c.lng]))
}

function placePin(p) {
  state.pin = p
  if (!pinMarker) {
    pinMarker = L.marker([p.lat, p.lng], { icon: dot('pin-edit', '', 30), title: 'Client pin', draggable: true }).addTo(map)
    pinMarker.on('dragend', () => {
      const ll = pinMarker.getLatLng()
      state.pin = { lat: round5(ll.lat), lng: round5(ll.lng) }
      updatePinState()
    })
  } else {
    pinMarker.setLatLng([p.lat, p.lng])
  }
  updatePinState()
}

function updatePinState() {
  const el = $('pin-state')
  if (!el) return
  el.textContent = state.pin ? `Pin placed at ${state.pin.lat}, ${state.pin.lng}. Drag it to move it.` : 'No pin yet. Tap the map where the driver should go.'
  if (state.pin) $('err-lat').textContent = ''
}

async function startEdit(id) {
  const c = id == null ? null : state.clients.find((x) => x.id === id)
  const messages = c ? (await api.owner.clientMessages(c.id)).messages : null
  state.editing = { client: c, messages }
  state.pin = c ? { lat: c.lat, lng: c.lng } : null
  state.notice = ''
  state.confirm = null
  paintClients()
  window.scrollTo({ top: 0 })
}

const clientBody = (c) => ({
  name: c.name, address: c.address, lat: c.lat, lng: c.lng, type: c.type, priority: c.priority, opens_at: c.opens_at, notes: c.notes,
  billing: c.billing, price_cents: c.price_cents, truck_id: c.truck_id, active: c.active,
})

async function saveClient(form) {
  const c = state.editing.client
  const g = (id) => form.querySelector(`#${id}`)
  for (const el of form.querySelectorAll('.field-error')) el.textContent = ''
  const truck = g('f-truck').value
  const body = {
    name: g('f-name').value, address: g('f-address').value,
    lat: state.pin ? state.pin.lat : null, lng: state.pin ? state.pin.lng : null,
    type: g('f-type').value, priority: g('f-priority').value, opens_at: g('f-opens').value || null, notes: g('f-notes').value,
    billing: g('f-billing').value, price_cents: dollarsToCents(g('f-price').value), truck_id: truck ? Number(truck) : null,
    active: c ? c.active : true,
  }
  if (body.price_cents === null) {
    const el = $('err-price_cents')
    el.textContent = PRICE_TEXT
    el.scrollIntoView({ block: 'center' })
    return
  }
  const btn = $('save-client')
  btn.disabled = true
  try {
    const saved = c ? await api.owner.updateClient(c.id, body) : await api.owner.createClient(body)
    state.editing = null
    state.pin = null
    state.notice = c ? `Saved ${saved.name}.` : `Added ${saved.name}.`
    await renderClients()
  } catch (e) {
    if (e.status === 401 && !e.field) return
    const target = $(`err-${e.field === 'lng' ? 'lat' : e.field}`) || $('form-error')
    target.textContent = e.message
    target.scrollIntoView({ block: 'center' })
    btn.disabled = false
  }
}

async function toggleClient() {
  const c = state.editing.client
  try {
    const saved = await api.owner.updateClient(c.id, { ...clientBody(c), active: !c.active })
    state.editing = null
    state.pin = null
    state.notice = saved.active ? `${saved.name} is active again.` : `${saved.name} is inactive: not on new storms. The status link still works.`
    await renderClients()
  } catch (e) {
    if (e.status === 401 && !e.field) return
    $('client-tools-error').textContent = e.message
  }
}

async function newStatusLink() {
  const c = state.editing.client
  try {
    const saved = await api.owner.resetClientLink(c.id)
    const messages = (await api.owner.clientMessages(c.id)).messages
    state.clients = state.clients.map((x) => (x.id === saved.id ? saved : x))
    state.editing = { client: saved, messages }
    state.confirm = null
    paintClients()
    $('status-link-section').insertAdjacentHTML('afterbegin', '<p class="notice" role="status" id="status-link-made">New status link made. The old one no longer works.</p>')
    $('status-link-section').scrollIntoView({ block: 'start' })
  } catch (e) {
    if (e.status === 401 && !e.field) return
    $('client-tools-error').textContent = e.message
  }
}

/* ---- Trucks ------------------------------------------------------------------ */
async function renderTrucks() {
  state.trucks = (await api.owner.trucks()).trucks
  paintTrucks()
}

function paintTrucks() {
  stopMap()
  const notice = state.notice
  state.notice = ''
  $('view').innerHTML = `
    <section class="panel narrow">
      <div class="panel-head">
        <h1 class="view-title">Trucks</h1>
        <button class="btn-small btn-primary" id="add-truck" type="button" data-action="add-truck">Add a truck</button>
      </div>
      <p class="muted">Send each driver their truck's link once. It opens tonight's route on their phone, and it keeps working with no signal.</p>
      ${notice ? `<p class="notice" role="status" id="trucks-notice">${esc(notice)}</p>` : ''}
      ${state.addingTruck ? `
        <form class="confirm" id="truck-form" novalidate>
          <label class="field-label" for="truck-name">Truck name</label>
          <input class="field" id="truck-name" type="text" maxlength="40" autocomplete="off">
          <p class="field-error" id="err-truck-name" role="alert"></p>
          <div class="form-actions">
            <button class="btn-small btn-primary" id="save-truck" type="submit">Save truck</button>
            <button class="btn-small" type="button" data-action="cancel-truck">Cancel</button>
          </div>
        </form>` : ''}
      <ul class="truck-list" id="truck-list">
        ${state.trucks.map((t) => `
          <li class="truck-row${t.active ? '' : ' is-inactive'}" data-truck-id="${t.id}">
            <div class="truck-head"><strong class="row-name">${esc(t.name)}</strong>${t.active ? '' : '<span class="chip">Inactive</span>'}</div>
            ${state.renaming === t.id ? `
              <form class="rename-form" data-truck-id="${t.id}" novalidate>
                <label class="field-label" for="rename-${t.id}">New name</label>
                <input class="field" id="rename-${t.id}" type="text" maxlength="40" autocomplete="off" value="${esc(t.name)}">
                <p class="field-error" id="err-rename-${t.id}" role="alert"></p>
                <div class="form-actions">
                  <button class="btn-small btn-primary" type="submit">Save name</button>
                  <button class="btn-small" type="button" data-action="cancel-rename">Cancel</button>
                </div>
              </form>` : ''}
            <label class="field-label" for="link-${t.id}">Driver link</label>
            <div class="copy-row">
              <input class="field" id="link-${t.id}" type="text" readonly value="${esc(t.driver_url)}">
              <button class="btn-small" type="button" data-action="copy-link" data-target="link-${t.id}">Copy link</button>
            </div>
            <p class="muted copy-note" id="note-link-${t.id}" role="status"></p>
            <div class="stop-tools">
              <button class="btn-small" type="button" data-action="rename-truck" data-id="${t.id}">Rename</button>
              <button class="btn-small" type="button" data-action="toggle-truck" data-id="${t.id}">${t.active ? 'Deactivate' : 'Make active again'}</button>
              <button class="btn-small" type="button" data-action="confirm-truck-link" data-id="${t.id}">New link</button>
            </div>
            ${state.confirm === `link-${t.id}` ? `
              <div class="confirm" id="truck-link-confirm" role="group" aria-labelledby="truck-link-confirm-text">
                <p id="truck-link-confirm-text"><strong>Make a new driver link for ${esc(t.name)}?</strong> The old link stops working at once. Check-ins still saved on a phone under it send when the driver opens the new link.</p>
                <div class="form-actions">
                  <button class="btn-small btn-warn" id="truck-link-yes" type="button" data-action="truck-link-yes" data-id="${t.id}">Yes, make a new link</button>
                  <button class="btn-small" type="button" data-action="confirm-cancel">Cancel</button>
                </div>
              </div>` : ''}
            <p class="field-error" id="err-truck-${t.id}" role="alert"></p>
          </li>`).join('')}
      </ul>
    </section>`
}

async function copyLink(btn) {
  const input = $(btn.dataset.target)
  const note = $(`note-${btn.dataset.target}`)
  try {
    await navigator.clipboard.writeText(input.value)
    btn.textContent = 'Copied'
    note.textContent = ''
    setTimeout(() => { if (btn.isConnected) btn.textContent = 'Copy link' }, 2000)
  } catch {
    input.select()
    note.textContent = 'This browser would not copy it. The link is selected: copy it from there.'
  }
}

async function truckAction(fn, errId, notice) {
  try {
    await fn()
    state.confirm = null
    state.renaming = null
    state.addingTruck = false
    state.notice = notice || ''
    await renderTrucks()
  } catch (e) {
    if (e.status === 401 && !e.field) return
    const el = $(errId)
    if (el) el.textContent = e.message
  }
}

/* ---- Billing ------------------------------------------------------------------ */
// What the table shows for pushes. It is the API row's count and nothing else: billing comes only from check-ins.
function pushesOf(row) {
  return row.pushes
}

async function renderBilling() {
  stopMap()
  const { months } = await api.owner.billingMonths()
  const choices = [...new Set([thisMonth(), ...months])].sort().reverse()
  if (!state.billingMonth || !choices.includes(state.billingMonth)) state.billingMonth = months[0] || thisMonth()
  const data = await api.owner.billing(state.billingMonth)
  const t = data.totals
  $('view').innerHTML = `
    <section class="panel">
      <div class="panel-head">
        <h1 class="view-title">Billing</h1>
        <div class="month-pick">
          <label class="field-label" for="billing-month">Month</label>
          <select class="field" id="billing-month">${choices.map((m) => `<option value="${m}"${m === state.billingMonth ? ' selected' : ''}>${esc(monthLabel(m))}${months.includes(m) ? '' : ' (no pushes)'}</option>`).join('')}</select>
        </div>
      </div>
      <p class="lead" id="billing-lead">${esc(data.label)}: ${plural(t.pushes, 'push', 'pushes')}, ${money(t.total_cents)} with HST.</p>
      <p class="muted table-hint">On a phone, slide the table sideways to see every column.</p>
      <div class="table-wrap">
        <table class="data-table billing-table" id="billing-table">
          <thead><tr>
            <th scope="col">Client</th><th scope="col">Billing</th><th scope="col" class="cell-num">Pushes</th><th scope="col">Push dates</th>
            <th scope="col" class="cell-num">Price</th><th scope="col" class="cell-num">Amount</th><th scope="col" class="cell-num">HST ${Math.round(data.hst_rate * 100)}%</th><th scope="col" class="cell-num">Total</th>
          </tr></thead>
          <tbody>
            ${data.rows.map((r) => `
              <tr data-client-id="${r.client_id}">
                <th scope="row"><span class="row-name">${esc(r.name)}</span><span class="row-addr">${esc(r.address)}</span></th>
                <td data-col="billing">${esc(r.billing_label)}</td>
                <td class="cell-num" data-col="pushes">${pushesOf(r)}</td>
                <td data-col="dates">${esc(r.dates.map(dayLabel).join(', ') || '—')}</td>
                <td class="cell-num" data-col="price">${money(r.price_cents)}</td>
                <td class="cell-num" data-col="amount">${money(r.amount_cents)}</td>
                <td class="cell-num" data-col="hst">${money(r.hst_cents)}</td>
                <td class="cell-num" data-col="total">${money(r.total_cents)}</td>
              </tr>`).join('')}
          </tbody>
          <tfoot><tr id="billing-totals">
            <th scope="row">Total</th><td></td><td class="cell-num" data-col="pushes">${t.pushes}</td><td></td><td></td>
            <td class="cell-num" data-col="amount">${money(t.subtotal_cents)}</td><td class="cell-num" data-col="hst">${money(t.hst_cents)}</td><td class="cell-num" data-col="total">${money(t.total_cents)}</td>
          </tr></tfoot>
        </table>
      </div>
      ${data.rows.length ? '' : '<p class="muted">Nobody to bill this month.</p>'}
      <p class="seasonal-note" id="seasonal-note">${esc(data.seasonal_note)}</p>
      <div class="form-actions">
        <button class="btn btn-nav btn-inline" id="download-csv" type="button" data-action="download-csv">Download CSV for the accountant</button>
      </div>
      <p class="field-error" id="csv-error" role="alert"></p>
    </section>`
}

async function downloadCsv(btn) {
  $('csv-error').textContent = ''
  btn.disabled = true
  try {
    const { blob, filename } = await api.owner.billingCsv(state.billingMonth)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.append(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
  } catch (e) {
    if (e.status === 401 && !e.field) return
    $('csv-error').textContent = e.message
  } finally {
    btn.disabled = false
  }
}

/* ---- Settings ------------------------------------------------------------------ */
async function renderSettings() {
  state.company = await api.owner.company()
  const c = state.company
  state.yardPin = { lat: c.yard.lat, lng: c.yard.lng }
  $('view').innerHTML = `
    <div class="split">
      <section class="panel">
        <h1 class="view-title">Settings</h1>
        <form id="company-form" class="settings-form" novalidate>
          <h2 class="section-title">Company</h2>
          ${field('name', 'f-company', 'Company name', `<input class="field" id="f-company" type="text" maxlength="80" autocomplete="organization" value="${esc(c.name)}">`)}
          ${field('yard.label', 'f-yard-label', 'Yard name', `<input class="field" id="f-yard-label" type="text" maxlength="80" autocomplete="off" value="${esc(c.yard.label)}">`)}
          <p class="pin-state" id="yard-state"></p>
          <p class="field-error" id="company-error" role="alert"></p>
          <p class="ok-text" id="company-saved" role="status"></p>
          <div class="form-actions"><button class="btn-small btn-primary" id="save-company" type="submit">Save company</button></div>
        </form>
        <form id="pin-form" class="settings-form" novalidate>
          <h2 class="section-title">Change PIN</h2>
          <p class="muted">Changing the PIN signs out every other device.</p>
          ${field('current', 'pin-current', 'Current PIN', '<input class="field" id="pin-current" type="password" inputmode="numeric" autocomplete="current-password" maxlength="8">')}
          ${field('next', 'pin-next', 'New PIN (4 to 8 digits)', '<input class="field" id="pin-next" type="password" inputmode="numeric" autocomplete="new-password" maxlength="8">')}
          <p class="field-error" id="pin-form-error" role="alert"></p>
          <p class="ok-text" id="pin-saved" role="status"></p>
          <div class="form-actions"><button class="btn-small btn-primary" id="save-pin" type="submit">Change PIN</button></div>
        </form>
      </section>
      <section class="panel map-panel">
        <p class="map-hint">Every route starts at the yard. Tap the map or drag the pin to move it, then save.</p>
        <div class="map" id="map" role="region" aria-label="Map: the yard pin"></div>
        <p class="field-error" id="err-yard.pin" role="alert"></p>
        <p class="map-legend"><span class="legend-item"><span class="legend-dot pin-yard">Y</span>Yard</span></p>
      </section>
    </div>`
  makeMap('map')
  map.setView([c.yard.lat, c.yard.lng], 15)
  pinMarker = L.marker([c.yard.lat, c.yard.lng], { icon: dot('pin-yard', 'Y', 30), title: 'Yard pin', draggable: true }).addTo(map)
  const moved = (p) => { state.yardPin = p; pinMarker.setLatLng([p.lat, p.lng]); yardState(); $('err-yard.pin').textContent = '' }
  pinMarker.on('dragend', () => { const ll = pinMarker.getLatLng(); moved({ lat: round5(ll.lat), lng: round5(ll.lng) }) })
  map.on('click', (e) => moved({ lat: round5(e.latlng.lat), lng: round5(e.latlng.lng) }))
  yardState()
}

function yardState() {
  const el = $('yard-state')
  if (el) el.textContent = `Yard pin at ${state.yardPin.lat}, ${state.yardPin.lng}.`
}

async function saveCompany() {
  // yard.label shows by the yard name, yard.pin by the map (clarification 33).
  for (const id of ['err-name', 'err-yard.label', 'err-yard.pin', 'company-error']) $(id).textContent = ''
  $('company-saved').textContent = ''
  const btn = $('save-company')
  btn.disabled = true
  try {
    state.company = await api.owner.saveCompany({ name: $('f-company').value, yard: { label: $('f-yard-label').value, lat: state.yardPin.lat, lng: state.yardPin.lng } })
    paintBar()
    $('company-saved').textContent = 'Saved.'
  } catch (e) {
    if (e.status === 401 && !e.field) return
    ;($(`err-${e.field}`) || $('company-error')).textContent = e.message
  } finally {
    btn.disabled = false
  }
}

// A wrong current PIN (401 with field "current") or a 429 stays on this form, and the owner stays signed in (clarification 21).
async function changePin() {
  for (const id of ['err-current', 'err-next', 'pin-form-error']) $(id).textContent = ''
  $('pin-saved').textContent = ''
  const btn = $('save-pin')
  btn.disabled = true
  try {
    await api.owner.changePin({ current: $('pin-current').value, next: $('pin-next').value })
    $('pin-current').value = ''
    $('pin-next').value = ''
    $('pin-saved').textContent = 'PIN changed. Every other device is signed out.'
  } catch (e) {
    if (e.status === 401 && !e.field) return
    ;($(`err-${e.field}`) || $('pin-form-error')).textContent = e.message
  } finally {
    btn.disabled = false
  }
}

/* ---- events ------------------------------------------------------------------ */
document.addEventListener('submit', (e) => {
  e.preventDefault()
  const f = e.target
  if (f.id === 'signin-form') signin()
  else if (f.id === 'client-form') saveClient(f)
  else if (f.id === 'storm-form') buildRoute()
  else if (f.id === 'add-stop-form') addStop()
  else if (f.id === 'company-form') saveCompany()
  else if (f.id === 'pin-form') changePin()
  else if (f.id === 'truck-form') {
    truckAction(() => api.owner.createTruck({ name: $('truck-name').value }), 'err-truck-name', `Added ${$('truck-name').value.trim()}.`)
  } else if (f.classList.contains('rename-form')) {
    const id = Number(f.dataset.truckId)
    const t = state.trucks.find((x) => x.id === id)
    truckAction(() => api.owner.updateTruck(id, { name: $(`rename-${id}`).value, active: t.active }), `err-rename-${id}`, 'Name saved.')
  }
})

document.addEventListener('change', (e) => {
  const input = e.target
  if (input.id === 'billing-month') {
    state.billingMonth = input.value
    renderBilling().catch((err) => { if (err.status !== 401) $('view').insertAdjacentHTML('afterbegin', `<p class="notice" role="alert">${esc(err.message)}</p>`) })
    return
  }
  if (!state.picking || input.type !== 'checkbox') return
  const set = input.name === 'client' ? state.picking.clients : input.name === 'truck' ? state.picking.trucks : null
  if (!set) return
  if (input.checked) set.add(Number(input.value))
  else set.delete(Number(input.value))
  syncPickCount()
})

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-action]')
  if (!t || t.disabled) return
  const id = Number(t.dataset.id)
  const clientId = Number(t.dataset.client)
  try {
    switch (t.dataset.action) {
      case 'signout':
        try { await api.owner.signout() } catch {}
        session.clear()
        return showSignin()
      case 'copy':
        return await copy(t)
      case 'start-picking':
        return await openPicker()
      case 'cancel-picking':
        state.picking = null
        return await renderTonight()
      case 'tick-all':
      case 'untick-all': {
        const on = t.dataset.action === 'tick-all'
        for (const input of document.querySelectorAll('#pick-clients input')) {
          input.checked = on
          if (on) state.picking.clients.add(Number(input.value))
          else state.picking.clients.delete(Number(input.value))
        }
        return syncPickCount()
      }
      case 'move-up':
        return await moveWithin(clientId, -1)
      case 'move-down':
        return await moveWithin(clientId, 1)
      case 'move-truck':
        return await moveToTruck(clientId, Number(t.dataset.to))
      case 'add-stop':
        state.clients = (await api.owner.clients()).clients
        state.adding = true
        state.confirm = null
        return paintStorm()
      case 'cancel-add-stop':
        state.adding = false
        return paintStorm()
      case 'end-storm':
        state.confirm = 'end'
        state.adding = false
        return paintStorm()
      case 'end-no':
        state.confirm = null
        return paintStorm()
      case 'end-yes':
        return await endStorm()
      case 'remove-stop':
        state.confirm = `remove-${clientId}`
        state.adding = false
        return paintStorm()
      case 'remove-no':
        state.confirm = null
        return paintStorm()
      case 'remove-yes':
        return await removeStop(clientId)
      case 'add-client':
        return await startEdit(null)
      case 'edit-client':
        return await startEdit(Number(t.dataset.id))
      case 'cancel-edit':
        state.editing = null
        state.pin = null
        state.confirm = null
        return paintClients()
      case 'confirm-status-link':
        state.confirm = `status-${state.editing.client.id}`
        paintClients()
        return $('status-link-confirm')?.scrollIntoView({ block: 'center' })
      case 'status-link-yes':
        return await newStatusLink()
      case 'toggle-client':
        return await toggleClient()
      case 'confirm-cancel':
        state.confirm = null
        return where().view === 'trucks' ? paintTrucks() : paintClients()
      case 'copy-link':
        return await copyLink(t)
      case 'add-truck':
        state.addingTruck = true
        return paintTrucks()
      case 'cancel-truck':
        state.addingTruck = false
        return paintTrucks()
      case 'rename-truck':
        state.renaming = id
        return paintTrucks()
      case 'cancel-rename':
        state.renaming = null
        return paintTrucks()
      case 'toggle-truck': {
        const truck = state.trucks.find((x) => x.id === id)
        return await truckAction(() => api.owner.updateTruck(id, { name: truck.name, active: !truck.active }), `err-truck-${id}`,
          truck.active ? `${truck.name} is inactive: not offered for new storms. Its link still works.` : `${truck.name} is active again.`)
      }
      case 'confirm-truck-link':
        state.confirm = `link-${id}`
        return paintTrucks()
      case 'truck-link-yes': {
        const truck = state.trucks.find((x) => x.id === id)
        return await truckAction(() => api.owner.resetTruckLink(id), `err-truck-${id}`, `New link made for ${truck.name}. The old link no longer works: send the driver this one.`)
      }
      case 'download-csv':
        return await downloadCsv(t)
    }
  } catch (err) {
    if (err.status === 401 && !err.field) return
    $('view').insertAdjacentHTML('afterbegin', `<p class="notice" role="alert">${esc(err.message)}</p>`)
  }
})

window.addEventListener('hashchange', () => {
  if (!session.get()) return
  Object.assign(state, { editing: null, picking: null, pin: null, notice: '', confirm: null, adding: false, renaming: null, addingTruck: false, stopErrors: {} })
  render()
})
window.addEventListener(SIGNED_OUT, (e) => showSignin(e.detail || 'Please sign in again.'))

try { state.company = await api.company() } catch {}
if (session.get()) showApp()
else showSignin()
