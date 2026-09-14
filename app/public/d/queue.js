// The driver's offline queue. Every check-in is written to IndexedDB (database `snow-route`, store `queue`) before
// anything else happens, with its photo bytes. A sender posts the oldest item first and removes it ONLY after the
// server answered: 200/201 for a check-in (then its photo is PUT and removed only after a 200), 200 for an undo.
// A refusal (409 already_plowed, 400, 404, any other 4xx) moves the item to "rejected" with the server's message: it stays on the
// phone and on screen, never silently dropped. No signal, a 5xx or a 429 leaves the queue exactly as it was and backs off.
// A 401 kills only that item's key: the sender goes on with the rest, and once the page's own key works every item under a dead
// key is re-keyed to it (check-ins always; photos and undos only within the same truck), clarifications 17 and 24. A photo refused with 404/413/415 drops only the photo (the check-in is already on the server):
// the item is removed and onPhotoDropped reports the server's message for that stop (API.md clarification 11).
//
// Undo is explicit (clarification 26): the driver's Undo marks an unsent item 'undone' in one transaction. The sender deletes an undone
// item it has not sent, and sends a DELETE only for an item that was on its way when it was marked. A check-in the sender finds MISSING
// after a 200/201 was sent by another tab: nothing is undone. Every tab runs its sends inside one Web Lock, so two tabs never send at once.
//
// Item: { qid, seq, created_at, key (driver key), op: 'checkin' | 'void', state: 'send' | 'photo' | 'rejected' | 'undone',
//         truck_id (the truck whose link saved it), label (stop name), body (the POST body, or { id, storm_id, client_id } for a
//         void), photo: { bytes, type } | null, error: server message when rejected, rekeyed_from: the dead key it was saved under,
//         stuck: true for a photo or undo under another truck's dead key (listed with Remove, never sent) }
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

// Read one item and decide in the same readwrite transaction, so a decision never rests on a copy another tab has changed.
// change(item | undefined) → { item: <new item> | null (delete) | undefined (leave), result }. Resolves to result.
export async function update(qid, change) {
  const d = await db()
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, 'readwrite')
    const store = t.objectStore(STORE)
    let outcome
    const req = store.get(qid)
    req.onsuccess = () => {
      const { item, result } = change(req.result)
      outcome = result
      if (item === null) store.delete(qid)
      else if (item) store.put(item)
    }
    t.oncomplete = () => resolve(outcome)
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error)
  })
}

// One sender at a time across every tab of this origin. Browsers without Web Locks send without it.
const withSendLock = (fn) => (globalThis.navigator?.locks ? navigator.locks.request('snow-route-send', fn) : fn())

export async function add(item) {
  const items = await all()
  const saved = { ...item, seq: items.reduce((m, i) => Math.max(m, i.seq), 0) + 1, created_at: new Date().toISOString() }
  await put(saved)
  return saved
}

const pending = (items) => items.filter((i) => i.state !== 'rejected')

// onChange(): the queue or the sender's state changed. onSent(key, stop): the server answered with a stop to show.
// onDrained(): the queue went empty after sending something (a good moment to reload the route).
// truckOf(key): the truck id a key belonged to (from the route saved with it), for items saved before truck_id was kept.
export function createSender({ onChange = () => {}, onSent = () => {}, onDrained = () => {}, onPhotoDropped = () => {}, truckOf = () => null } = {}) {
  const st = { busy: false, again: false, failures: 0, problem: null, message: '', timer: null, started: false,
    dead: new Set(), page: { key: '', truckId: null, working: false } }
  const blocked = (item) => st.dead.has(item.key)

  // Items under a key the Worker refused move to the page's working key. A check-in may move to any truck (its id makes a resend
  // harmless and the Worker takes a check-in from whichever truck sends it); a photo or an undo only within the same truck, because
  // the Worker takes those only from the truck that made the check-in. The rest are marked stuck: listed, never sent, never dropped.
  async function rekey() {
    const page = st.page
    if (!page.working || !page.key) return
    for (const item of pending(await all())) {
      if (item.key === page.key || !st.dead.has(item.key)) continue
      const checkin = item.op === 'checkin' && item.state === 'send'
      if (checkin || (item.truck_id ?? truckOf(item.key)) === page.truckId) {
        await put({ ...item, key: page.key, truck_id: page.truckId, rekeyed_from: item.rekeyed_from || item.key, stuck: false })
      } else if (!item.stuck) {
        await put({ ...item, stuck: true })
      }
    }
  }

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
    if (status >= 500 || status === 429) return failed('server', data?.error || '')
    if (status === 401) {
      // Only this item's key is dead; the queue goes on. The strip shows the refusal only when it is the page's own key.
      st.dead.add(item.key)
      if (item.key === st.page.key) { st.page.working = false; st.problem = 'unauthorized'; st.message = data?.error || '' }
      return true
    }

    if (item.op === 'void') {
      if (status === 200) {
        await remove(item.qid)
        onSent(item.key, data?.stop)
      } else await reject(item, data?.error || `The undo was not accepted (error ${status}).`)
      return true
    }

    if (item.state === 'photo') {
      if (status === 200) {
        await remove(item.qid)
      } else if (status === 404 || status === 413 || status === 415) {
        await remove(item.qid)
        onPhotoDropped(item.key, item.body.id, data?.error || `error ${status}`)
      } else {
        return failed('server', data?.error || '')
      }
      return true
    }

    if (status === 200 || status === 201) {
      onSent(item.key, data?.stop)
      // Decide from the item as it is now, in one transaction (clarification 26).
      const outcome = await update(item.qid, (still) => {
        if (!still) return { result: 'gone' } // another tab sent it and removed it: nothing was undone
        if (still.state === 'undone') return { item: null, result: 'undone' } // the driver tapped Undo while it was on its way
        if (item.body.has_photo && still.photo) return { item: { ...still, state: 'photo' }, result: 'photo' }
        return { item: null, result: 'sent' }
      })
      if (outcome === 'undone') {
        await add({ qid: `void:${item.body.id}`, op: 'void', state: 'send', key: item.key, truck_id: item.truck_id ?? truckOf(item.key), label: item.label,
          body: { id: item.body.id, storm_id: item.body.storm_id, client_id: item.body.client_id }, photo: null, error: null })
      }
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
      await withSendLock(async () => {
      for (;;) {
        // Undone items this sender never sent leave the phone here, inside the lock, so no tab can be sending them.
        for (const i of await all()) if (i.state === 'undone') await remove(i.qid)
        await rekey()
        const items = pending(await all()).filter((i) => !blocked(i))
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
        if (st.failures === before) {
          st.failures = 0
          if (st.problem !== 'unauthorized') { st.problem = null; st.message = '' }
        }
        onChange()
      }
      })
    } catch (e) {
      failed('error', e.message)
    } finally {
      st.busy = false
      const left = pending(await all().catch(() => [])).filter((i) => !blocked(i))
      schedule(left.length > 0)
      onChange()
      if (sent && !left.length) onDrained()
      // A send asked for while this one ran goes now, unless this one just failed: then the backoff timer decides.
      if (st.again) { st.again = false; if (!st.failures) flush() }
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
    // Signal coming back is news: try at once, and start the backoff over (failures while offline must not delay this).
    window.addEventListener('online', () => { st.failures = 0; flush() })
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') flush() })
    flush()
  }

  // The driver page says which key it runs under and whether the Worker accepted it (its route loaded).
  // It sends at once only when that is news (the key just started working, or dead-key items wait to be re-keyed); a routine
  // route refresh must not skip the backoff.
  function setPage({ key, truckId, working }) {
    const news = working && (!st.page.working || st.page.key !== key || st.dead.size > 0)
    st.page = { key, truckId, working }
    if (!working) return
    st.dead.delete(key)
    if (st.problem === 'unauthorized') { st.problem = null; st.message = '' }
    if (news) flush()
  }

  return {
    flush,
    start,
    setPage,
    isDead: (key) => st.dead.has(key),
    get problem() { return st.problem },
    get message() { return st.message },
    get busy() { return st.busy },
  }
}
