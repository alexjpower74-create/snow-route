// The app's only door to the Worker: same-origin fetch('/api/…') per docs/API.md. A failed call throws ApiError whose
// message is the API's own `error` text, shown to people as is. No signal throws ApiError with code "network".
// `?mock=1` swaps in api.mock.js for development (remembered for the tab; `?mock=0` turns it off). Playwright never uses it.

const MOCK_KEY = 'snow-route:mock'
export const TOKEN_KEY = 'snow-route:owner-token'

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

const q = encodeURIComponent
const driverHeaders = (key) => ({ 'X-Driver-Key': key })

export const api = {
  mocked,
  company: () => call('GET', '/api/company'),
  status: (key) => call('GET', `/api/status/${q(key)}`),
  driver: {
    route: (key) => call('GET', '/api/driver/route', { headers: driverHeaders(key) }),
    // The queue needs every status code (201, 200 duplicate, 409, 5xx), so these answer { status, data } instead of throwing.
    checkin: (key, body) => send('POST', '/api/driver/checkins', { json: body, headers: driverHeaders(key) }),
    photo: (key, id, bytes, type) => send('PUT', `/api/driver/checkins/${q(id)}/photo`, { bytes, type, headers: driverHeaders(key) }),
    undo: (key, id) => send('DELETE', `/api/driver/checkins/${q(id)}`, { headers: driverHeaders(key) }),
  },
}
