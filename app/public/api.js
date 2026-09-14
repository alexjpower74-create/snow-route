// The app's only door to the Worker: same-origin fetch('/api/…') per docs/API.md. A failed call throws ApiError whose
// message is the API's own `error` text, shown to people as is. No signal throws ApiError with code "network".
// `?mock=1` swaps in api.mock.js for development (remembered for the tab; `?mock=0` turns it off). Playwright never uses it.

const MOCK_KEY = 'snow-route:mock'
export const TOKEN_KEY = 'snow-route:owner-token'
export const SIGNED_OUT = 'snow-route:signed-out'

export const session = {
  get() { try { return localStorage.getItem(TOKEN_KEY) || '' } catch { return '' } },
  set(token) { try { localStorage.setItem(TOKEN_KEY, token) } catch {} },
  clear() { try { localStorage.removeItem(TOKEN_KEY) } catch {} },
}

const mode = new URLSearchParams(location.search).get('mock')
let mocked = false
try {
  if (mode === '1') sessionStorage.setItem(MOCK_KEY, '1')
  if (mode === '0') sessionStorage.removeItem(MOCK_KEY)
  mocked = sessionStorage.getItem(MOCK_KEY) === '1'
} catch { mocked = mode === '1' }
const mock = mocked ? await import('/api.mock.js') : null

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `Something went wrong (error ${status}). Please try again.`)
    this.status = status
    this.code = body?.code || 'error'
    this.field = body?.field || null
    this.body = body || {}
  }
}

const NO_SIGNAL = { error: 'No signal. Check your connection and try again.', code: 'network' }

// One request. Answers { status, data } for every HTTP status; throws ApiError(0, network) only when nothing came back.
export async function send(method, path, { json, bytes, type, headers = {} } = {}) {
  const h = { ...headers }
  let body
  if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json) }
  if (bytes !== undefined) { h['content-type'] = type; body = bytes }
  if (mock) {
    if (!navigator.onLine) throw new ApiError(0, NO_SIGNAL)
    return mock.handle(method, path, { json, bytes, type, headers: h })
  }
  let res
  try {
    res = await fetch(path, { method, headers: h, body, cache: 'no-store' })
  } catch {
    throw new ApiError(0, NO_SIGNAL)
  }
  const text = await res.text()
  let data = null
  try { data = JSON.parse(text) } catch {}
  return { status: res.status, data }
}

async function call(method, path, options) {
  const r = await send(method, path, options)
  if (r.status >= 200 && r.status < 300) return r.data
  throw new ApiError(r.status, r.data)
}

// Owner routes carry the session token. A 401 without a `field` means the session ended: clear it and sign out. A 401 with a
// `field` (a wrong current PIN) is a form error and keeps the session (clarification 21).
async function owner(method, path, json) {
  const token = session.get()
  const r = await send(method, path, { json, headers: token ? { Authorization: `Bearer ${token}` } : {} })
  if (r.status >= 200 && r.status < 300) return r.data
  if (r.status === 401 && !r.data?.field) {
    session.clear()
    window.dispatchEvent(new CustomEvent(SIGNED_OUT, { detail: r.data?.error || '' }))
  }
  throw new ApiError(r.status, r.data)
}

const q = encodeURIComponent

// The accountant's CSV: a real fetch with the token (not JSON), answered as { blob, filename } for a download link.
async function ownerCsv(path) {
  const token = session.get()
  let res
  try {
    res = await fetch(path, { headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: 'no-store' })
  } catch {
    throw new ApiError(0, NO_SIGNAL)
  }
  if (!res.ok) {
    let data = null
    try { data = await res.json() } catch {}
    if (res.status === 401 && !data?.field) {
      session.clear()
      window.dispatchEvent(new CustomEvent(SIGNED_OUT, { detail: data?.error || '' }))
    }
    throw new ApiError(res.status, data)
  }
  const disposition = res.headers.get('content-disposition') || ''
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] || 'snow-route.csv'
  return { blob: await res.blob(), filename }
}
const driverHeaders = (key) => ({ 'X-Driver-Key': key })

export const api = {
  mocked,
  company: () => call('GET', '/api/company'),
  status: (key) => call('GET', `/api/status/${q(key)}`),
  owner: {
    signin: (pin) => call('POST', '/api/owner/signin', { json: { pin } }),
    signout: () => owner('POST', '/api/owner/signout'),
    clients: () => owner('GET', '/api/owner/clients?include_inactive=1'),
    createClient: (body) => owner('POST', '/api/owner/clients', body),
    updateClient: (id, body) => owner('PUT', `/api/owner/clients/${q(id)}`, body),
    trucks: () => owner('GET', '/api/owner/trucks'),
    currentStorm: () => owner('GET', '/api/owner/storms/current'),
    startStorm: (body) => owner('POST', '/api/owner/storms', body),
    storm: (id) => owner('GET', `/api/owner/storms/${q(id)}`),
    storms: () => owner('GET', '/api/owner/storms'),
    saveRoute: (id, trucks) => owner('PUT', `/api/owner/storms/${q(id)}/route`, { trucks }),
    addStop: (id, body) => owner('POST', `/api/owner/storms/${q(id)}/stops`, body),
    endStorm: (id) => owner('POST', `/api/owner/storms/${q(id)}/end`),
    summary: (id) => owner('GET', `/api/owner/storms/${q(id)}/summary`),
    clientMessages: (id) => owner('GET', `/api/owner/clients/${q(id)}/messages`),
    resetClientLink: (id) => owner('POST', `/api/owner/clients/${q(id)}/reset-link`),
    createTruck: (body) => owner('POST', '/api/owner/trucks', body),
    updateTruck: (id, body) => owner('PUT', `/api/owner/trucks/${q(id)}`, body),
    resetTruckLink: (id) => owner('POST', `/api/owner/trucks/${q(id)}/reset-link`),
    billingMonths: () => owner('GET', '/api/owner/billing/months'),
    billing: (month) => owner('GET', `/api/owner/billing?month=${q(month)}`),
    billingCsv: (month) => ownerCsv(`/api/owner/billing.csv?month=${q(month)}`),
    company: () => owner('GET', '/api/owner/company'),
    saveCompany: (body) => owner('PUT', '/api/owner/company', body),
    changePin: (body) => owner('PUT', '/api/owner/pin', body),
  },
  driver: {
    route: (key) => call('GET', '/api/driver/route', { headers: driverHeaders(key) }),
    // The queue needs every status code (201, 200 duplicate, 409, 5xx), so these answer { status, data } instead of throwing.
    checkin: (key, body) => send('POST', '/api/driver/checkins', { json: body, headers: driverHeaders(key) }),
    photo: (key, id, bytes, type) => send('PUT', `/api/driver/checkins/${q(id)}/photo`, { bytes, type, headers: driverHeaders(key) }),
    undo: (key, id) => send('DELETE', `/api/driver/checkins/${q(id)}`, { headers: driverHeaders(key) }),
  },
}
