// Owner side /owner/: PIN sign-in, Tonight (start a storm, each truck's route in order and on the map), Clients (list with
// chips, a map of every client, add/edit with the pin placed by tapping the map or dragging the marker), Trucks (driver links).
// Talks only to the API through api.js; the API's own error text is shown next to the field it names.
// Leaflet is a classic script (global L). Tiles are OpenStreetMap's, at owner-screen volume, attribution always shown.
import { api, session, SIGNED_OUT } from '/api.js'
import { esc, brandBar, plural, clockLabel } from '/ui.js'

const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
const TYPES = [['driveway', 'Driveway'], ['lot', 'Parking lot'], ['walkway', 'Walkway']]
const PRIORITIES = [['none', 'None'], ['medical', 'Medical'], ['commuter', 'Early commuter'], ['business', 'Business opening']]
const BILLING = [['per_push', 'Per push'], ['seasonal', 'Seasonal contract']]
const VIEWS = [['tonight', 'Tonight'], ['clients', 'Clients'], ['trucks', 'Trucks']]
const TRUCK_COLOURS = ['#7cc4ff', '#f0abfc', '#fdba74', '#86efac']
const STORM_REFRESH_MS = 30_000

const app = document.getElementById('app')
const state = { company: null, clients: [], trucks: [], storm: null, editing: null, pin: null, picking: null, notice: '' }
let map = null
let pinMarker = null
let stormTimer = null

const $ = (id) => document.getElementById(id)
const money = (cents) => `$${(cents / 100).toFixed(2)}`
const round5 = (n) => Math.round(n * 1e5) / 1e5
const currentView = () => (VIEWS.some(([id]) => id === location.hash.slice(1)) ? location.hash.slice(1) : 'tonight')
const options = (list, value) => list.map(([v, l]) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(l)}</option>`).join('')

// "45", "45.5", "$1,200.00" → cents; anything else → null, so the API answers with its own message.
function dollarsToCents(text) {
  const t = String(text).trim().replace(/^\$/, '').replace(/,/g, '')
  return /^\d+(\.\d{1,2})?$/.test(t) ? Math.round(Number(t) * 100) : null
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

async function signin(form) {
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
async function showApp() {
  app.innerHTML = `
    <header class="bar">${brandBar(state.company, '<button class="btn-small" id="signout" type="button" data-action="signout">Sign out</button>')}</header>
    <nav class="tabs" aria-label="Owner sections">
      ${VIEWS.map(([id, label]) => `<a class="tab" href="#${id}" data-view="${id}">${label}</a>`).join('')}
    </nav>
    <main class="owner-main" id="view"><p class="loading">Loading…</p></main>`
  await render()
}

async function render() {
  const v = currentView()
  document.querySelectorAll('.tab').forEach((t) => {
    if (t.dataset.view === v) t.setAttribute('aria-current', 'page')
    else t.removeAttribute('aria-current')
  })
  clearInterval(stormTimer)
  try {
    if (v === 'clients') await renderClients()
    else if (v === 'trucks') await renderTrucks()
    else await renderTonight()
  } catch (e) {
    if (e.status === 401) return // SIGNED_OUT takes over
    stopMap()
    $('view').innerHTML = `<p class="notice" role="alert">${esc(e.message)}</p>`
  }
}

/* ---- Tonight ------------------------------------------------------------------ */
async function renderTonight() {
  state.storm = (await api.owner.currentStorm()).storm
  if (state.storm) return paintStorm()
  if (state.picking) return paintPicker()
  stopMap()
  $('view').innerHTML = `
    <section class="panel narrow">
      <h1 class="view-title">Tonight</h1>
      <p class="lead">No storm on right now.</p>
      <button class="btn btn-nav btn-inline" id="start-storm" type="button" data-action="start-picking">Start a storm</button>
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
    if (e.status === 401) return
    ;($(`err-${e.field}`) || $('form-error')).textContent = e.message
    btn.disabled = false
  }
}

function ownerStatus(s) {
  if (s.status === 'plowed') return `Plowed ${s.checkin.at_label}${s.checkin.photo === 'stored' ? ' · photo' : ''}`
  if (s.status === 'skipped') return `Skipped: ${s.checkin.reason_text}`
  return 'To do'
}

function paintStorm() {
  const s = state.storm
  $('view').innerHTML = `
    <div class="storm-head">
      <h1 class="view-title">${esc(s.name)}</h1>
      <p class="muted">Started ${esc(s.started_label)} · ${s.counts.plowed} plowed · ${s.counts.skipped} skipped · ${s.counts.pending} to go</p>
      <p class="order-note" id="order-note">${esc(s.order_note)}</p>
    </div>
    <div class="split">
      <section class="panel">
        ${s.trucks.map((t, i) => `
          <section class="truck-stops" data-truck-id="${t.id}">
            <h2 class="section-title"><span class="swatch" style="background:${TRUCK_COLOURS[i % TRUCK_COLOURS.length]}"></span>${esc(t.name)} · ${plural(t.stops.length, 'stop')}</h2>
            <ol class="owner-stops">
              ${t.stops.map((st) => `
                <li class="stop-row is-${st.status}" data-client-id="${st.client_id}" data-priority="${st.priority}">
                  <span class="num" aria-hidden="true">${st.position}</span>
                  <div class="row-main">
                    <span class="row-name">${esc(st.name)}</span>
                    <span class="row-addr">${esc(st.address)}</span>
                    <span class="row-meta">${st.priority !== 'none' ? `<span class="chip chip-priority">${esc(st.priority_label)}</span>` : ''}<span class="row-status">${esc(ownerStatus(st))}</span></span>
                  </div>
                </li>`).join('')}
            </ol>
          </section>`).join('')}
      </section>
      <section class="panel map-panel">
        <div class="map map-tall" id="map" role="region" aria-label="Tonight's route on the map"></div>
        <p class="map-hint">Numbered pins are the order; green is plowed, amber is skipped. Lines are straight, not roads.</p>
      </section>
    </div>`
  makeMap('map')
  yardMarker()
  const y = state.company?.yard
  const points = y ? [[y.lat, y.lng]] : []
  s.trucks.forEach((t, i) => {
    const colour = TRUCK_COLOURS[i % TRUCK_COLOURS.length]
    const line = t.stops.map((st) => [st.lat, st.lng])
    if (y) line.unshift([y.lat, y.lng])
    L.polyline(line, { color: colour, weight: 4, opacity: 0.85, interactive: false }).addTo(map)
    for (const st of t.stops) {
      points.push([st.lat, st.lng])
      L.marker([st.lat, st.lng], {
        icon: L.divIcon({ className: `route-pin is-${st.status}`, html: `<span style="border-color:${colour}">${st.position}</span>`, iconSize: [30, 30], iconAnchor: [15, 15] }),
        title: `${t.name}, stop ${st.position}: ${st.name}`,
        riseOnHover: true,
      }).addTo(map)
    }
  })
  fit(points)
  stormTimer = setInterval(refreshStorm, STORM_REFRESH_MS)
}

async function refreshStorm() {
  if (currentView() !== 'tonight' || document.visibilityState !== 'visible') return
  try {
    const next = (await api.owner.currentStorm()).storm
    if (JSON.stringify(next) === JSON.stringify(state.storm)) return
    clearInterval(stormTimer)
    state.storm = next
    if (next) paintStorm()
    else renderTonight()
  } catch {}
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

function clientForm(c) {
  const v = (k, d = '') => (c ? c[k] ?? d : d)
  const trucks = [['', 'No usual truck'], ...state.trucks.filter((t) => t.active || t.id === v('truck_id', null)).map((t) => [String(t.id), t.name])]
  return `
    <form id="client-form" class="client-form" novalidate>
      <h1 class="view-title">${c ? `Edit ${esc(c.name)}` : 'Add a client'}</h1>
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
      ${c ? `<label class="check"><input type="checkbox" id="f-active"${c.active ? ' checked' : ''}> <span>Active (goes on new storms)</span></label>` : ''}
      <p class="pin-state" id="pin-state"></p>
      <p class="field-error" id="err-lat" role="alert"></p>
      <p class="field-error" id="form-error" role="alert"></p>
      <div class="form-actions">
        <button class="btn-small btn-primary" id="save-client" type="submit">Save client</button>
        <button class="btn-small" type="button" data-action="cancel-edit">Cancel</button>
      </div>
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
    ${state.notice ? `<p class="notice" role="status">${esc(state.notice)}</p>` : ''}
    <p class="muted">${plural(active.length, 'active client')}${inactive.length ? `, ${inactive.length} inactive` : ''}</p>
    <ul class="client-list" id="client-list">${[...active, ...inactive].map(clientRow).join('')}</ul>`
  $('view').innerHTML = `
    <div class="split${editing ? ' is-editing' : ''}">
      <section class="panel">${editing ? clientForm(editing.client) : list}</section>
      <section class="panel map-panel">
        <p class="map-hint" id="map-hint">${editing ? 'Tap the map where the driver should go. Drag the pin to move it.' : 'Every active client. Tap a pin to edit that client.'}</p>
        <div class="map" id="map" role="region" aria-label="${editing ? 'Map: tap to place the pin' : 'Map of clients'}"></div>
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

function startEdit(id) {
  const c = id == null ? null : state.clients.find((x) => x.id === id)
  state.editing = { client: c }
  state.pin = c ? { lat: c.lat, lng: c.lng } : null
  state.notice = ''
  paintClients()
  window.scrollTo({ top: 0 })
}

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
    active: c ? g('f-active').checked : true,
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
    if (e.status === 401) return
    const target = $(`err-${e.field === 'lng' ? 'lat' : e.field}`) || $('form-error')
    target.textContent = e.message
    target.scrollIntoView({ block: 'center' })
    btn.disabled = false
  }
}

/* ---- Trucks ------------------------------------------------------------------ */
async function renderTrucks() {
  state.trucks = (await api.owner.trucks()).trucks
  stopMap()
  $('view').innerHTML = `
    <section class="panel narrow">
      <h1 class="view-title">Trucks</h1>
      <p class="muted">Send each driver their truck's link once. It opens tonight's route on their phone, and it keeps working with no signal.</p>
      <ul class="truck-list" id="truck-list">
        ${state.trucks.map((t) => `
          <li class="truck-row" data-truck-id="${t.id}">
            <div class="truck-head"><strong class="row-name">${esc(t.name)}</strong>${t.active ? '' : '<span class="chip">Inactive</span>'}</div>
            <label class="field-label" for="link-${t.id}">Driver link</label>
            <div class="copy-row">
              <input class="field" id="link-${t.id}" type="text" readonly value="${esc(t.driver_url)}">
              <button class="btn-small" type="button" data-action="copy-link" data-target="link-${t.id}">Copy link</button>
            </div>
            <p class="muted copy-note" id="note-link-${t.id}" role="status"></p>
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
    setTimeout(() => { btn.textContent = 'Copy link' }, 2000)
  } catch {
    input.select()
    note.textContent = 'This browser would not copy it. The link is selected: copy it from there.'
  }
}

/* ---- events ------------------------------------------------------------------ */
document.addEventListener('submit', (e) => {
  e.preventDefault()
  if (e.target.id === 'signin-form') signin(e.target)
  else if (e.target.id === 'client-form') saveClient(e.target)
  else if (e.target.id === 'storm-form') buildRoute()
})

document.addEventListener('change', (e) => {
  const input = e.target
  if (!state.picking || input.type !== 'checkbox') return
  const set = input.name === 'client' ? state.picking.clients : input.name === 'truck' ? state.picking.trucks : null
  if (!set) return
  if (input.checked) set.add(Number(input.value))
  else set.delete(Number(input.value))
  syncPickCount()
})

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-action]')
  if (!t) return
  try {
    switch (t.dataset.action) {
      case 'signout':
        try { await api.owner.signout() } catch {}
        session.clear()
        return showSignin()
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
      case 'add-client':
        return startEdit(null)
      case 'edit-client':
        return startEdit(Number(t.dataset.id))
      case 'cancel-edit':
        state.editing = null
        state.pin = null
        return paintClients()
      case 'copy-link':
        return await copyLink(t)
    }
  } catch (err) {
    if (err.status !== 401) $('view').insertAdjacentHTML('afterbegin', `<p class="notice" role="alert">${esc(err.message)}</p>`)
  }
})

window.addEventListener('hashchange', () => {
  if (!session.get()) return
  state.editing = null
  state.picking = null
  state.pin = null
  state.notice = ''
  render()
})
window.addEventListener(SIGNED_OUT, (e) => showSignin(e.detail || 'Please sign in again.'))

try { state.company = await api.company() } catch {}
if (session.get()) showApp()
else showSignin()
