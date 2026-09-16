// npm test: pure unit tests, then the API tests against a TEST_MODE Worker on PORT (default 7602).
// If nothing answers on PORT: wipe worker/.state-<PORT>, apply migrations there, start wrangler dev, and stop it at the end.
// If something already answers, it is used as is (every API test resets first).

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.PORT || 7602)
const BASE = `http://127.0.0.1:${PORT}`
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }

const step = (cmd, args, extraEnv = {}) => spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env: { ...env, ...extraEnv } }).status ?? 1

async function answers(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok
  } catch {
    return false
  }
}

async function waitFor(url, isGone) {
  for (let i = 0; i < 120 && !isGone(); i++) {
    if (await answers(url)) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

function stopper(child, state) {
  return async () => {
    if (state.exited) return
    const gone = new Promise((r) => child.once('exit', r))
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {}
    await Promise.race([gone, new Promise((r) => setTimeout(r, 5000))])
    if (!state.exited)
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {}
  }
}

/** Fresh state dir, migrations, wrangler dev --local with TEST_MODE=1 on port (inspector port + 10). */
export async function startWorker({ dir = root, port, log }) {
  const state = join(dir, `.state-${port}`)
  rmSync(state, { recursive: true, force: true })
  const migrate = spawnSync('wrangler', ['d1', 'migrations', 'apply', 'snow-route', '--local', '--persist-to', state], {
    cwd: dir,
    env,
    encoding: 'utf8',
  })
  if (migrate.status !== 0) throw new Error(`migrations failed:\n${migrate.stdout}\n${migrate.stderr}`)
  mkdirSync(dirname(log), { recursive: true })
  const out = openSync(log, 'w')
  // app/public belongs to the app slice and may not exist in this worktree yet; wrangler refuses a missing assets folder,
  // so the API tests then serve an empty one (they never ask for a page).
  const assets = []
  if (!existsSync(resolve(root, '..', 'app', 'public'))) {
    const empty = join(dir, `.state-${port}-assets`)
    mkdirSync(empty, { recursive: true })
    assets.push('--assets', empty)
  }
  const child = spawn(
    'wrangler',
    [
      'dev',
      '--local',
      '--port',
      String(port),
      '--inspector-port',
      String(port + 10),
      '--persist-to',
      state,
      '--var',
      'TEST_MODE:1',
      ...assets,
      '--show-interactive-dev-session=false',
    ],
    { cwd: dir, env, detached: true, stdio: ['ignore', out, out] },
  )
  const s = { exited: false }
  child.on('exit', () => {
    s.exited = true
  })
  const base = `http://127.0.0.1:${port}`
  if (!(await waitFor(`${base}/api/company`, () => s.exited))) {
    await stopper(child, s)()
    throw new Error(`wrangler dev did not come up on ${port}; see ${log}`)
  }
  return { base, stop: stopper(child, s) }
}

async function main() {
  console.log('\n== unit: tests/route.test.mjs tests/unit.test.mjs tests/billing.test.mjs ==')
  if (
    step(process.execPath, ['--test', '--test-concurrency=1', 'tests/route.test.mjs', 'tests/unit.test.mjs', 'tests/billing.test.mjs']) !==
    0
  )
    process.exit(1)

  let worker = null
  let status = 1
  try {
    if (await answers(`${BASE}/api/company`)) {
      console.log(`\n== using the Worker already answering on ${BASE} ==`)
    } else {
      console.log(`\n== starting wrangler dev on ${PORT} (TEST_MODE=1, state .state-${PORT}) ==`)
      worker = await startWorker({ port: PORT, log: join(root, '.logs', `wrangler-${PORT}.log`) })
    }
    console.log('\n== api: tests/api.test.mjs ==')
    status = step(process.execPath, ['--test', 'tests/api.test.mjs'], { BASE })
  } finally {
    if (worker) await worker.stop()
  }
  process.exit(status)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
