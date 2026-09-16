// "Now" and the client IP. X-Test-Now and X-Test-IP are honoured only when the Worker runs with var TEST_MODE=1
// (tests pass --var TEST_MODE:1; wrangler.toml never sets it). Without it both headers are ignored, so nobody can move
// the server's clock or dodge a rate limit from outside.

export function isTestMode(env) {
  return String(env?.TEST_MODE ?? '') === '1'
}

export function now(request, env) {
  if (isTestMode(env)) {
    const header = request.headers.get('X-Test-Now')
    if (header) {
      const ms = Date.parse(header)
      if (Number.isFinite(ms)) return ms
    }
  }
  return Date.now()
}

export function clientIp(request, env) {
  if (isTestMode(env)) {
    const header = request.headers.get('X-Test-IP')
    if (header) return header
  }
  return request.headers.get('CF-Connecting-IP') || 'unknown'
}
