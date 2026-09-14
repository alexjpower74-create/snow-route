// Shared plumbing for the negative controls: copy worker/ to worker/.negative/<name> (git-ignored), apply one literal break
// that must match exactly once, run a test there, and append a scrubbed record to tests/negative-control.log.
// The shipped code never contains a switch for any of these breaks; they exist only in the copies.

import { spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startWorker } from './run.mjs'

export const root = resolve(fileURLToPath(import.meta.url), '..', '..')
const logFile = join(root, 'tests', 'negative-control.log')
export const NEGATIVE_PORT = 7605

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function patchFile (dir, file, find, replacement, what) {
  const path = join(dir, file)
  const text = readFileSync(path, 'utf8')
  const count = text.split(find).length - 1
  if (count !== 1) throw new Error(`${what}: expected exactly one match of ${JSON.stringify(find)} in ${file}, found ${count}`)
  writeFileSync(path, text.replace(find, () => replacement))
}

/** A fresh copy of worker/ with the assets directory made absolute so it still resolves. */
export function copyWorker (name) {
  const dir = join(root, '.negative', name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  // Node refuses to cpSync a directory into its own subdirectory, so copy the top-level entries one by one.
  for (const entry of readdirSync(root)) {
    if (/^(\.state-|\.logs|\.negative|\.wrangler|\.scratch|node_modules)/.test(entry)) continue
    cpSync(join(root, entry), join(dir, entry), { recursive: true })
  }
  patchFile(dir, 'wrangler.toml', 'directory = "../app/public"', `directory = ${JSON.stringify(resolve(root, '..', 'app', 'public'))}`, 'wrangler.toml assets directory')
  return dir
}

export function runNode (dir, args, env = {}) {
  const r = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } })
  return { status: r.status, output: `${r.stdout}${r.stderr}` }
}

export function createLog (title) {
  const lines = []
  const say = s => { console.log(s); lines.push(s) }
  const sha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()
  const dirty = spawnSync('git', ['status', '--porcelain', '--', '.', ':!tests/negative-control.log'], { cwd: root, encoding: 'utf8' }).stdout.trim() ? '+uncommitted worker changes' : ''
  say(`\n=== ${sha}${dirty ? ` ${dirty}` : ''} ${title} ${new Date().toISOString()} ===`)
  return {
    say,
    // The log is committed: never write this machine's folder names into it (plain or file:// URL form).
    flush: () => appendFileSync(logFile, lines.join('\n')
      .replaceAll(pathToFileURL(resolve(root, '..')).href, 'file://<repo>')
      .replaceAll(resolve(root, '..'), '<repo>') + '\n')
  }
}

const passed = (out, name) => out.includes(`✔ ${name}`)
const failed = (out, name) => out.includes(`✖ ${name}`)
const nameArgs = tests => tests.flatMap(t => ['--test-name-pattern', `^${escapeRe(t)}`])

/**
 * One control: copy, apply `setup` (patches both runs share), run the named tests on that copy (each must pass), apply the
 * breaks, run again (each named test must show ✖; a file that no longer loads is not accepted as red). For API tests the copy
 * is served on 7605. `check(beforeOutput, afterOutput)` may add a verdict of its own ({ ok, note }).
 * Exits the process 0 only when every named test went red and `check` (if any) agrees.
 */
export async function runControl ({ title, testFile, tests, breaks, setup = [], check, describe, api = false }) {
  const log = createLog(title)
  let ok = false
  let worker = null
  try {
    const dir = copyWorker(title.replace(/[^a-z0-9]+/gi, '-'))
    for (const b of setup) {
      patchFile(dir, b.file, b.find, b.replace, `${title} setup`)
      log.say(`setup (both runs): ${b.file}: ${JSON.stringify(b.find)}  ->  ${JSON.stringify(b.replace)}`)
    }
    const args = ['--test', ...nameArgs(tests), testFile]
    let env = {}
    if (api) {
      worker = await startWorker({ dir, port: NEGATIVE_PORT, log: join(dir, '.logs', `wrangler-${NEGATIVE_PORT}.log`) })
      env = { BASE: worker.base }
    }
    const before = runNode(dir, args, env)
    const cleanOk = before.status === 0 && tests.every(t => passed(before.output, t))
    log.say(`control (unbroken copy): ${tests.map(t => `"${t}"`).join(', ')} ${cleanOk ? 'pass' : `DID NOT PASS (exit ${before.status})\n${before.output}`}`)
    if (worker) { await worker.stop(); worker = null }

    for (const b of breaks) {
      patchFile(dir, b.file, b.find, b.replace, `${title} break`)
      log.say(`break: ${b.file}: ${JSON.stringify(b.find)}  ->  ${JSON.stringify(b.replace)}`)
    }
    if (api) {
      worker = await startWorker({ dir, port: NEGATIVE_PORT, log: join(dir, '.logs', `wrangler-${NEGATIVE_PORT}-broken.log`) })
      env = { BASE: worker.base }
    }
    const after = runNode(dir, args, env)
    log.say(after.output.trimEnd())
    const red = tests.every(t => failed(after.output, t))
    ok = cleanOk && after.status !== 0 && red
    if (check) {
      const c = check(before.output, after.output)
      log.say(`check: ${c.note}`)
      ok = ok && c.ok
    }
    log.say(ok ? `verdict: RED as expected. ${tests.map(t => `"${t}"`).join(' and ')} fail when ${describe}.`
      : `verdict: NOT RED as required (unbroken ${cleanOk ? 'passed' : 'did not pass'}, broken exit ${after.status}, every named test red: ${red}).`)
  } catch (e) {
    log.say(`verdict: ERROR ${e.stack || e.message}`)
  } finally {
    if (worker) await worker.stop()
    log.flush()
  }
  process.exit(ok ? 0 : 1)
}
