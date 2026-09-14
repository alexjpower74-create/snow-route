// Dev server: app/public on 127.0.0.1:7601, with /api/* passed through to the Worker at API_ORIGIN
// (default http://127.0.0.1:7602, sr1's wrangler dev). Production does not use this: the Worker serves both.
// With ?mock=1 the pages never call /api at all (api.mock.js answers in the browser).
// Usage: node serve.mjs [port]   ROOT=<dir> serves another copy of public/ (negative controls).
import http from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(process.env.ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), 'public'))
const PORT = Number(process.argv[2] || process.env.PORT || 7601)
const API_ORIGIN = (process.env.API_ORIGIN || 'http://127.0.0.1:7602').replace(/\/$/, '')
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
}
const HOP = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'content-length', 'content-encoding', 'upgrade'])

async function proxy(req, res, url) {
  const headers = {}
  for (const [k, val] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = val
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  try {
    const up = await fetch(API_ORIGIN + url.pathname + url.search, {
      method: req.method, headers, body: hasBody ? req : undefined, duplex: hasBody ? 'half' : undefined, redirect: 'manual',
    })
    const out = {}
    up.headers.forEach((val, k) => { if (!HOP.has(k)) out[k] = val })
    const body = Buffer.from(await up.arrayBuffer())
    res.writeHead(up.status, out)
    res.end(body)
  } catch {
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: `The Snow Route service is not running at ${API_ORIGIN}.`, code: 'upstream' }))
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname.startsWith('/api/')) return proxy(req, res, url)
  let rel
  try { rel = decodeURIComponent(url.pathname) } catch { rel = '/' }
  let file = path.join(ROOT, rel)
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('Forbidden')
    return
  }
  try {
    if ((await stat(file)).isDirectory()) {
      if (!rel.endsWith('/')) {
        res.writeHead(301, { location: rel + '/' + url.search }).end()
        return
      }
      file = path.join(file, 'index.html')
    }
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found')
  }
})

server.listen(PORT, '127.0.0.1', () => console.log(`Snow Route app on http://127.0.0.1:${PORT} (API → ${API_ORIGIN})`))
