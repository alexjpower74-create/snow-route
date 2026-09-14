// The driver's offline queue. Every check-in is written to IndexedDB (database `snow-route`, store `queue`) before
// anything else happens, with its photo bytes. A sender posts the oldest item first and removes it ONLY after the
// server answered: 200/201 for a check-in (then its photo is PUT and removed only after a 200), 200 for an undo.
// An undo of an attempted check-in re-sends the check-in first (clarification 49); a DELETE answering 404 after that is shown.
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
      const { item, result, also = [] } = change(req.result)
      outcome = result
      if (item === null) store.delete(qid)
      else if (item) store.put(item)
      for (const other of also) store.put(other) // written in the same transaction (clarification 50)
    }
    t.oncomplete = () => resolve(outcome)
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error)
  })
}

// One sender at a time across every tab of this origin. A tab that is not on screen takes the lock only if it is free, so a forgotten
// background tab never holds up the one the driver is looking at (clarification 39). Browsers without Web Locks send without it.
const withSendLock = (fn) => {
  if (!globalThis.navigator?.locks) return fn()
  if (document.visibilityState === 'visible') return navigator.locks.request('snow-route-send', fn)
  return navigator.locks.request('snow-route-send', { ifAvailable: true }, (lock) => (lock ? fn() : undefined))
}

// The undo item for a check-in item. resend: POST the check-in again under its own id before the DELETE (clarification 49), for a
// check-in that was attempted but whose arrival the phone never heard about. It takes the check-in's place in the queue (same seq).
export function voidFor(item, { resend = false, truckId, stuck = false } = {}) {
  return {
    qid: `void:${item.body.id}`, seq: item.seq, created_at: new Date().toISOString(), op: 'void', state: 'send', key: item.key,
    truck_id: truckId ?? item.truck_id ?? null, label: item.label, resend, stuck, checkin: resend ? item.body : null,
    body: { id: item.body.id, storm_id: item.body.storm_id, client_id: item.body.client_id }, photo: null, error: null,
  }
}

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
    for (const snapshot of pending(await all())) {
      if (snapshot.key === page.key || !st.dead.has(snapshot.key)) continue
      // Decided on the item as it is inside the writing transaction, never on this snapshot (clarification 50).
      await update(snapshot.qid, (item) => {
        if (!item || item.state === 'rejected' || item.key === page.key || !st.dead.has(item.key)) return { result: false }
        const checkin = item.op === 'checkin' && item.state === 'send'
        if (checkin || (item.truck_id ?? truckOf(item.key)) === page.truckId) {
          return { item: { ...item, key: page.key, truck_id: page.truckId, rekeyed_from: item.rekeyed_from || item.key, stuck: false }, result: true }
        }
        return item.stuck ? { result: false } : { item: { ...item, stuck: true }, result: true }
      })
    }
  }

  const failed = (problem, message = '') => {
    st.failures += 1
    st.problem = problem
    st.message = message
    return false
  }

  async function reject(item, message) {
    await update(item.qid, (it) => (it ? { item: { ...it, state: 'rejected', error: message }, result: true } : { result: false }))
  }

  // The truck a key sends as: the page's own truck for the page's key, else what the key store says.
  const truckOfKey = (key) => (key === st.page.key && st.page.truckId != null ? st.page.truckId : truckOf(key))

  // One item. true = go on to the next item; false = stop for now (no signal, server trouble).
  async function step(item) {
    if (item.op === 'checkin' && item.state === 'send' && !item.attempted && navigator.onLine !== false) {
      // Written before the POST leaves: from here on the Worker may have it, so an Undo must send a DELETE (clarification 38).
      const marked = await update(item.qid, (it) => (it && it.state === 'send' ? { item: { ...it, attempted: true }, result: true } : { result: false }))
      if (!marked) return true // undone or gone meanwhile: the next pass decides
      item = { ...item, attempted: true }
    }
    if (item.op === 'void' && item.resend) {
      // Clarification 49: make sure the office has the check-in (idempotent under its own id: 201 or 200 duplicate), take its truck
      // from that answer, and only then send the DELETE on the next step, so the DELETE always finds the row.
      let again
      try {
        again = await api.driver.checkin(item.key, { ...item.checkin, undo: true }) // clarification 52: never stored → stored already voided
      } catch (e) {
        return failed(e.code === 'network' ? 'network' : 'error', e.message)
      }
      if (again.status >= 500 || again.status === 429) return failed('server', again.data?.error || '')
      if (again.status === 401) {
        st.dead.add(item.key)
        if (item.key === st.page.key) { st.page.working = false; st.problem = 'unauthorized'; st.message = again.data?.error || '' }
        return true
      }
      if (again.status !== 200 && again.status !== 201) {
        await reject(item, again.data?.error || `The undo was not accepted (error ${again.status}).`)
        return true
      }
      if (again.status === 201 && again.data?.checkin?.voided === true) {
        // It had never reached the office: the re-send stored it already voided, so there is nothing left to DELETE (clarification 52).
        await update(item.qid, (it) => (it ? { item: null, result: true } : { result: false }))
        onSent(item.key, again.data?.stop)
        return true
      }
      const stored = again.data?.checkin?.truck_id ?? item.truck_id
      const mine = truckOfKey(item.key)
      await update(item.qid, (it) => (it ? { item: { ...it, resend: false, truck_id: stored, stuck: stored != null && mine != null && stored !== mine }, result: true } : { result: false }))
      return true
    }
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
      } else {
        // After the re-send, a 404 means the check-in belongs to another truck: shown, never dropped (clarification 49).
        await reject(item, data?.error || `The undo was not accepted (error ${status}).`)
      }
      return true
    }

    if (item.state === 'photo') {
      if (status === 200) {
        await remove(item.qid)
      } else if (status === 404 || status === 413 || status === 415) {
        await remove(item.qid)
        onPhotoDropped(item.key, item.body.id, data?.error || `error ${status}`, item)
      } else {
        return failed('server', data?.error || '')
      }
      return true
    }

    if (status === 200 || status === 201) {
      onSent(item.key, data?.stop)
      // The check-in's truck is the one the office stored (clarification 43): a photo or undo for another truck is stuck, never sent.
      const stored = data?.checkin?.truck_id ?? item.truck_id ?? null
      const mine = truckOfKey(item.key)
      const otherTruck = stored != null && mine != null && stored !== mine
      // Decide from the item as it is now; the undo replaces the item in the same transaction (clarifications 26 and 50).
      await update(item.qid, (still) => {
        if (!still) return { result: 'gone' } // another tab sent it and removed it: nothing was undone
        if (still.state === 'undone') return { item: null, also: [voidFor(still, { truckId: stored, stuck: otherTruck })], result: 'undone' }
        if (item.body.has_photo && still.photo) return { item: { ...still, state: 'photo', truck_id: stored, stuck: otherTruck }, result: 'photo' }
        return { item: null, result: 'sent' }
      })
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
        // Undone items (clarification 38): never attempted → leave the phone with no DELETE; attempted (the Worker may have it) → an undo,
        // whichever sender finds it. Inside the lock where there is one.
        for (const snapshot of await all()) {
          if (snapshot.state !== 'undone') continue
          await update(snapshot.qid, (i) => {
            if (!i || i.state !== 'undone') return { result: false }
            const needsUndo = !!i.attempted
            return { item: null, also: needsUndo ? [voidFor(i, { resend: true, truckId: i.truck_id ?? truckOf(i.key) })] : [], result: true }
          })
        }
        await rekey()
        const items = pending(await all()).filter((i) => !blocked(i) && !i.stuck && i.state !== 'undone')
        if (!items.length) {
          st.failures = 0
          st.problem = null
          st.message = ''
          break
        }
        const before = st.failures
        // Every pending check-in and undo goes before any photo (clarification 51).
        const go = await step(items.find((i) => i.state !== 'photo') || items[0])
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
      const left = pending(await all().catch(() => [])).filter((i) => !blocked(i) && !i.stuck)
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
