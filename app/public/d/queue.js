// The driver's offline queue. Every check-in is written to IndexedDB (database `snow-route`, store `queue`) before
// anything else happens, with its photo bytes. A sender posts the oldest item first and removes it ONLY after the
// server answered: 200/201 for a check-in (then its photo is PUT and removed only after a 200), 200 for an undo.
// A refusal (409 already_plowed, any other 4xx) moves the item to "rejected" with the server's message: it stays on the
// phone and on screen, never silently dropped. No signal or a 5xx leaves the queue exactly as it was and backs off.
//
// Item: { qid, seq, created_at, key (driver key), op: 'checkin' | 'void', state: 'send' | 'photo' | 'rejected',
//         label (stop name), body (the POST body, or { id, storm_id, client_id } for a void), photo: { bytes, type } | null,
//         error: server message when rejected }
// `body.at` is set when the driver tapped (or chose the photo). The sender never touches it.

import { api } from '/api.js'

const DB_NAME = 'snow-route'
const STORE = 'queue'
const EVERY_MS = 20_000
const MAX_BACKOFF_MS = 5 * 60_000

let opening = null
function db() {
  opening ||= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1)
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: 'qid' })
    }
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => { opening = null; reject(r.error) }
  })
  return opening
}

async function tx(mode, work) {
  const d = await db()
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode)
    let result
    const req = work(t.objectStore(STORE))
    if (req) req.onsuccess = () => { result = req.result }
    t.oncomplete = () => resolve(result)
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error)
  })
}

export const all = async () => ((await tx('readonly', (s) => s.getAll())) || []).sort((a, b) => a.seq - b.seq)
export const get = (qid) => tx('readonly', (s) => s.get(qid))
export const put = (item) => tx('readwrite', (s) => s.put(item))
export const remove = (qid) => tx('readwrite', (s) => s.delete(qid))

export async function add(item) {
  const items = await all()
  const saved = { ...item, seq: items.reduce((m, i) => Math.max(m, i.seq), 0) + 1, created_at: new Date().toISOString() }
  await put(saved)
  return saved
}

const pending = (items) => items.filter((i) => i.state !== 'rejected')

// onChange(): the queue or the sender's state changed. onSent(key, stop): the server answered with a stop to show.
// onDrained(): the queue went empty after sending something (a good moment to reload the route).
export function createSender({ onChange = () => {}, onSent = () => {}, onDrained = () => {} } = {}) {
  const st = { busy: false, again: false, failures: 0, problem: null, message: '', timer: null, started: false }

  const failed = (problem, message = '') => {
    st.failures += 1
    st.problem = problem
    st.message = message
    return false
  }

  async function reject(item, message) {
    await put({ ...item, state: 'rejected', error: message })
  }

  // One item. true = go on to the next item; false = stop for now (no signal, server trouble).
  async function step(item) {
    let r
    try {
      if (item.op === 'void') r = await api.driver.undo(item.key, item.body.id)
      else if (item.state === 'photo') r = await api.driver.photo(item.key, item.body.id, item.photo.bytes, item.photo.type)
      else r = await api.driver.checkin(item.key, item.body)
    } catch (e) {
      return failed(e.code === 'network' ? 'network' : 'error', e.message)
    }
    const { status, data } = r
    if (status >= 500) return failed('server', data?.error || '')
    if (status === 401) return failed('unauthorized', data?.error || '')

    if (item.op === 'void') {
      if (status === 200) {
        await remove(item.qid)
        onSent(item.key, data?.stop)
      } else await reject(item, data?.error || `The undo was not accepted (error ${status}).`)
      return true
    }

    if (item.state === 'photo') {
      if (status === 200) await remove(item.qid)
      else await reject(item, data?.error || `The photo was not accepted (error ${status}).`)
      return true
    }

    if (status === 200 || status === 201) {
      onSent(item.key, data?.stop)
      const still = await get(item.qid)
      if (!still) {
        // Undone on the phone while this check-in was on its way: the server has it now, so send the undo too.
        await add({ qid: `void:${item.body.id}`, op: 'void', state: 'send', key: item.key, label: item.label,
          body: { id: item.body.id, storm_id: item.body.storm_id, client_id: item.body.client_id }, photo: null, error: null })
      } else if (item.body.has_photo && item.photo) await put({ ...still, state: 'photo' })
      else await remove(item.qid)
      return true
    }
    await reject(item, data?.error || `The check-in was not accepted (error ${status}).`)
    return true
  }

  async function flush() {
    if (st.busy) { st.again = true; return }
    st.busy = true
    clearTimeout(st.timer)
    let sent = false
    try {
      for (;;) {
        const items = pending(await all())
        if (!items.length) {
          st.failures = 0
          st.problem = null
          st.message = ''
          break
        }
        const before = st.failures
        const go = await step(items[0])
        if (!go) break
        sent = true
        if (st.failures === before) { st.failures = 0; st.problem = null; st.message = '' }
        onChange()
      }
    } catch (e) {
      failed('error', e.message)
    } finally {
      st.busy = false
      const left = pending(await all().catch(() => []))
      schedule(left.length > 0)
      onChange()
      if (sent && !left.length) onDrained()
      if (st.again) { st.again = false; flush() }
    }
  }

  function schedule(anything) {
    clearTimeout(st.timer)
    st.timer = null
    if (!anything) return
    const delay = st.failures ? Math.min(EVERY_MS * 2 ** (st.failures - 1), MAX_BACKOFF_MS) : EVERY_MS
    st.timer = setTimeout(flush, delay)
  }

  function start() {
    if (st.started) return
    st.started = true
    window.addEventListener('online', () => flush())
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') flush() })
    flush()
  }

  return {
    flush,
    start,
    get problem() { return st.problem },
    get message() { return st.message },
    get busy() { return st.busy },
  }
}
