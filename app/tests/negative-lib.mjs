// Copy-and-break negative controls for the e2e suite. A control copies app/public and worker into app/.negative/<name>/,
// runs the named spec against the UNBROKEN copy first (it must pass, or the control is VOID), then applies one break to the
// copy and runs the spec again on port 7606: the control exits 0 only if that second run goes red. Output is appended to
// app/tests/negative-control.log. The shipped code has no switch for any of these breaks.
import { spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOG = path.join(APP, 'tests', 'negative-control.log')
const PORT = '7606'
const SKIP = /[\\/](\.state-[^\\/]*|\.wrangler|node_modules|results)([\\/]|$)/

export function replaceOnce(file, anchor, replacement) {
  const text = readFileSync(file, 'utf8')
  const count = text.split(anchor).length - 1
  if (count !== 1) throw new Error(`break anchor found ${count} times in ${file}: ${anchor.slice(0, 80)}`)
  writeFileSync(file, text.replace(anchor, replacement))
}

function runSpec(copy, args) {
  const r = spawnSync(process.execPath, [path.join(APP, 'node_modules', '@playwright', 'test', 'cli.js'), 'test', ...args], {
    cwd: APP, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60_000,
    env: { ...process.env, E2E_PORT: PORT, E2E_WORKER_DIR: path.join(copy, 'worker'), FORCE_COLOR: '0' },
  })
  return { code: r.status ?? 1, out: `${r.stdout || ''}${r.stderr || ''}` }
}

const summary = (out) => out.split('\n').filter((l) => /^\s*(\d+ (passed|failed|skipped|flaky)|✘|✓)/.test(l)).join('\n')
const redLines = (out) => {
  const lines = out.split('\n')
  const at = lines.findIndex((l) => /^\s+\d+\) /.test(l))
  return (at < 0 ? lines.slice(-40) : lines.slice(at, at + 45)).join('\n')
}

export function control({ name, what, args, breakIt }) {
  const copy = path.join(APP, '.negative', name)
  rmSync(copy, { recursive: true, force: true })
  cpSync(path.join(APP, 'public'), path.join(copy, 'app', 'public'), { recursive: true, filter: (s) => !SKIP.test(s) })
  cpSync(path.join(APP, '..', 'worker'), path.join(copy, 'worker'), { recursive: true, filter: (s) => !SKIP.test(s) })

  const stamp = new Date().toISOString()
  console.log(`[${name}] unbroken copy: playwright test ${args.join(' ')}`)
  const clean = runSpec(copy, args)
  if (clean.code !== 0) {
    appendFileSync(LOG, `== ${stamp} ${name}: VOID. The unbroken copy did not pass, so a red run would prove nothing.\n${summary(clean.out)}\n${redLines(clean.out)}\n\n`)
    console.log(summary(clean.out))
    console.log(`[${name}] VOID: the unbroken copy failed`)
    return 2
  }

  breakIt(copy)
  console.log(`[${name}] broken copy (${what})`)
  const broken = runSpec(copy, args)
  const red = broken.code !== 0
  appendFileSync(LOG, [
    `== ${stamp} ${name}: ${what}`,
    `   spec: playwright test ${args.join(' ')} on ${PORT}, copy in app/.negative/${name}`,
    `   unbroken copy: ${summary(clean.out).replace(/\n/g, ' | ')}`,
    `   broken copy: exit ${broken.code} -> ${red ? 'RED as expected: the check is wired' : 'GREEN: the check measured nothing'}`,
    redLines(broken.out),
    '',
  ].join('\n') + '\n')
  console.log(summary(broken.out))
  console.log(`[${name}] ${red ? 'RED as expected' : 'GREEN: the check measured nothing'}`)
  return red ? 0 : 1
}
