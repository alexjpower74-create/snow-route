// Driver service worker, scope /d/. Caches the driver page and everything it loads on install and serves those
// cache-first, refreshing the copy in the background when there is signal. It never touches /api/*: check-ins,
// routes and photos always go to the network (the page's own queue handles no signal).
const CACHE = 'snow-route-driver-v1'
const SHELL = ['/d/', '/d/driver.js', '/d/queue.js', '/theme.css', '/style.css', '/api.js', '/ui.js']
// Loaded only in development (?mock=1); cached when first fetched so the mock also works offline.
const EXTRA = new Set(['/api.mock.js', '/mock-data.js'])

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      await cache.addAll(SHELL)
      // The page that installed this worker was not controlled by it, so fetch the development files here too.
      await Promise.all([...EXTRA].map((p) => cache.add(p).catch(() => {})))
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) if (name !== CACHE) await caches.delete(name)
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return
  const page = req.mode === 'navigate' && (url.pathname === '/d/' || url.pathname === '/d/index.html')
  const path = page ? '/d/' : url.pathname
  if (!page && !SHELL.includes(path) && !EXTRA.has(path)) return

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE)
      const cached = await cache.match(path)
      const fresh = fetch(path, { cache: 'no-store' })
        .then((res) => {
          if (res.ok) cache.put(path, res.clone())
          return res
        })
        .catch(() => null)
      if (cached) {
        event.waitUntil(fresh)
        return cached
      }
      return (
        (await fresh) ||
        new Response('No signal, and this page is not saved on the phone yet.', {
          status: 503,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        })
      )
    })(),
  )
})
