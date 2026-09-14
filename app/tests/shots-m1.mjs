// M1 smoke + screenshots for the landing page, the driver page (offline queue, service worker) and the client status page.
// Runs against the in-browser mock (?mock=1) on the dev server (serve.mjs, 7601), because sr1's Worker is not merged yet.
// Not the @playwright/test suite: that is M2 and runs against the real Worker.
// Real input only: every tap goes through tap(), which hit-tests the target's centre with elementFromPoint first; photos go
// through the real file chooser with a generated PNG; offline is context.setOffline. evaluate only ever reads.
// Usage (from app/): node tests/shots-m1.mjs [--engine chromium|webkit|all] [--no-shots] [--port 7601]
// Screenshots (chromium) go to tests/shots/<name>-<390|1280>.png. Exit 1 on any FAIL.
import { chromium, webkit, devices } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { deflateSync, crc32 } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const PORT = Number(opt('--port', 7601))
const BASE = `http://127.0.0.1:${PORT}`
const ENGINES = opt('--engine', 'all') === 'all' ? ['chromium', 'webkit'] : [opt('--engine')]
const SHOTS = !args.includes('--no-shots')
const COMPANY = 'SAMPLE Snow Clearing — Grand Falls-Windsor (demo)'
const T = 8000

let passes = 0
let failures = 0
const notes = []

/* ---- server ------------------------------------------------------------- */
const up = async () => { try { return (await fetch(BASE + '/d/')).status === 200 } catch { return false } }
let server = null
if (!(await up())) {
  server = spawn(process.execPath, ['serve.mjs', String(PORT)], { cwd: APP, stdio: 'ignore', env: process.env })
  for (let i = 0; i < 50 && !(await up()); i++) await new Promise((r) => setTimeout(r, 100))
  if (!(await up())) { console.error(`FAIL could not start serve.mjs on ${PORT}`); process.exit(1) }
}
const at = (p) => `${BASE}${p}${p.includes('?') ? '&' : '?'}mock=1`

/* ---- a generated placeholder photo (PNG, 1200 x 900) --------------------- */
function png(width, height) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1)
    for (let x = 0; x < width; x++) {
      const o = row + 1 + x * 3
      const snow = y > height * 0.6
      raw[o] = snow ? 225 : 40 + (x * 60) / width
      raw[o + 1] = snow ? 232 : 55 + (y * 60) / height
      raw[o + 2] = snow ? 245 : 90
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const PHOTO = { name: 'plowed-sample.png', mimeType: 'image/png', buffer: png(1200, 900) }

/* ---- helpers ------------------------------------------------------------ */
function check(name, ok, detail = '') {
  if (ok) passes++
  else failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== '' ? ` (${detail})` : ''}`)
  if (!ok) throw new Error(`check failed: ${name}`)
}

// Hit-test the centre with elementFromPoint, then a real touch (390) or click (1280).
async function tap(page, loc, label, touch) {
  await loc.waitFor({ state: 'visible', timeout: T })
  await loc.scrollIntoViewIfNeeded()
  const box = await loc.boundingBox()
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  const hit = await loc.evaluate((el, [px, py]) => {
    const t = document.elementFromPoint(px, py)
    return t === el || el.contains(t) ? '' : t ? t.outerHTML.slice(0, 140) : 'nothing'
  }, [x, y])
  if (hit) {
    failures++
    console.log(`  FAIL tap(${label}) hit-test: centre ${Math.round(x)},${Math.round(y)} lands on ${hit}`)
    throw new Error(`tap(${label}) is covered`)
  }
  if (touch) await page.touchscreen.tap(x, y)
  else await page.mouse.click(x, y)
}

async function big(loc, label) {
  const box = await loc.boundingBox()
  check(`${label} is at least 56 x 56 px`, box && box.height >= 56 && box.width >= 56, box ? `${Math.round(box.width)} x ${Math.round(box.height)}` : 'no box')
}

const text = (page, sel) => page.locator(sel).innerText()
const see = (page, t) => page.getByText(t, { exact: false }).first().waitFor({ state: 'visible', timeout: T })
async function waitText(page, sel, re) {
  try {
    await page.waitForFunction(([s, src]) => new RegExp(src).test(document.querySelector(s)?.innerText || ''), [sel, re.source], { timeout: T })
  } catch {
    const got = await page.locator(sel).first().innerText({ timeout: 1000 }).catch(() => '(missing)')
    check(`${sel} matches ${re}`, false, `after ${T} ms it says: ${got}`)
  }
}

async function badge(page) {
  await page.locator('[data-sample]').first().waitFor({ state: 'visible', timeout: T })
  check('SAMPLE badge visible', (await page.locator('[data-sample]').first().innerText()).trim() === 'SAMPLE')
  check('company name shown', (await page.locator('[data-company-name]').first().innerText()).trim() === COMPANY)
}

async function noSideScroll(page, size) {
  if (size !== 390) return
  const w = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth])
  check('no horizontal scroll at 390', w[0] <= w[1], `${w[0]} > ${w[1]}`)
}

/* ---- scenarios ------------------------------------------------------------ */
const scenarios = {
  async landing(page, { size, shot }) {
    await page.goto(at('/'))
    await badge(page)
    await see(page, 'Drivers and clients use the links the owner sends them.')
    check('Owner sign-in links to /owner/', (await page.locator('#owner-signin').getAttribute('href')) === '/owner/')
    await noSideScroll(page, size)
    await shot('landing')
  },

  async driver(page, { touch, size, shot, engine }) {
    await page.goto(at('/d/?k=demo-truck-1-sample&reset=1'))
    await page.locator('#stop-name').waitFor({ timeout: T })
    await badge(page)
    check('truck name in the bar', (await text(page, '.truck')) === 'Truck 1 (SAMPLE)')
    check('counter says Stop 3 of 13', (await text(page, '#counter')) === 'Stop 3 of 13', await text(page, '#counter'))
    const name = await text(page, '#stop-name')
    const size34 = await page.locator('#stop-name').evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
    check('next stop name is at least 34 px', size34 >= 34, `${size34}px`)
    const notesPx = await page.locator('#stop-notes').evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
    check('notes shown in their box at 20 px', (await page.locator('#stop-notes').isVisible()) && notesPx === 20, `${notesPx}px`)
    const href = await page.locator('#navigate').getAttribute('href')
    const address = await text(page, '#stop-address')
    const apple = engine === 'webkit' && size === 390
    const want = apple
      ? `https://maps.apple.com/?daddr=${encodeURIComponent(address)}&dirflg=d`
      : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`
    check(`Navigate goes to ${apple ? 'Apple' : 'Google'} Maps with the encoded address`, href === want, href)
    check('Navigate opens in a new tab', (await page.locator('#navigate').getAttribute('target')) === '_blank')
    for (const [sel, label] of [['#navigate', 'Navigate'], ['#plowed', 'Plowed'], ['#plowed-nophoto', 'Plowed, no photo'], ['#skip', 'Skip this stop']]) {
      await big(page.locator(sel), label)
    }
    check('Plowed wraps a camera file input', (await page.locator('#plowed input[type=file][accept="image/*"][capture=environment]').count()) === 1)
    await page.locator('#sync-text', { hasText: 'All sent' }).waitFor({ timeout: T })
    check('sync strip says All sent', true)
    await noSideScroll(page, size)
    await shot('driver-storm')

    // Plowed with a photo, through the real file chooser.
    const chooser = page.waitForEvent('filechooser', { timeout: T })
    await tap(page, page.locator('#plowed'), 'Plowed', touch)
    await (await chooser).setFiles(PHOTO)
    await waitText(page, '#counter', /^Stop 4 of 13$/)
    check('after Plowed the next stop shows', (await text(page, '#stop-name')) !== name)
    await page.locator('#undo-btn').waitFor({ timeout: T })
    check('Undo bar shows', (await text(page, '.undo-text')) === `Plowed: ${name}`)
    await big(page.locator('#undo-btn'), 'Undo')
    await page.locator('#sync-text', { hasText: 'All sent' }).waitFor({ timeout: T })
    const row3 = page.locator('.stop-row').nth(2)
    await row3.locator('.row-status', { hasText: /^Plowed \d{1,2}:\d{2} [AP]M$/ }).waitFor({ timeout: T })
    check('list row 3 says Plowed with a time, sent (photo too)', true)

    // Undo a sent check-in → the stop is back.
    await tap(page, page.locator('#undo-btn'), 'Undo', touch)
    await waitText(page, '#counter', /^Stop 3 of 13$/)
    check('Undo brings the stop back', (await text(page, '#stop-name')) === name)
    await page.locator('#sync-text', { hasText: 'All sent' }).waitFor({ timeout: T })
    await waitText(page, '.stop-row:nth-child(3) .row-status', /^Up next$/)
    check('the undo reached the server (row 3 is Up next)', true)
    await page.waitForTimeout(800) // the double-tap lock after a check-in

    // Skip → Gate locked.
    await tap(page, page.locator('#skip'), 'Skip this stop', touch)
    await page.getByRole('dialog', { name: 'Why are you skipping?' }).waitFor({ timeout: T })
    for (const label of ['Car in the way', 'Gate locked', 'Client cancelled', 'Other', 'Back']) {
      await big(page.getByRole('button', { name: label, exact: true }), label)
    }
    await tap(page, page.getByRole('button', { name: 'Other', exact: true }), 'Other', touch)
    await page.locator('#skip-note').waitFor({ timeout: T })
    check('Other opens an optional note', true)
    await shot('driver-skip-sheet')
    await tap(page, page.getByRole('button', { name: 'Gate locked', exact: true }), 'Gate locked', touch)
    await waitText(page, '#counter', /^Stop 4 of 13$/)
    check('after the skip the next stop shows', true)
    await page.locator('.stop-row').nth(2).locator('.row-status', { hasText: 'Skipped: Gate locked' }).waitFor({ timeout: T })
    const plowedNow = page.locator('.stop-row').nth(2).getByRole('button', { name: 'Plowed now' })
    await big(plowedNow, 'Plowed now')
    await page.waitForTimeout(800)

    // Plowed now on the skipped stop → it becomes the card, Plowed, no photo → back to stop 4.
    await tap(page, plowedNow, 'Plowed now', touch)
    await waitText(page, '#counter', /^Stop 3 of 13$/)
    // textContent: innerText applies the eyebrow's text-transform: uppercase.
    check('Plowed now shows the skipped stop', (await page.locator('.eyebrow').textContent()) === 'Back at a skipped stop')
    await tap(page, page.locator('#plowed-nophoto'), 'Plowed, no photo', touch)
    await waitText(page, '#counter', /^Stop 4 of 13$/)
    await page.locator('.stop-row').nth(2).locator('.row-status', { hasText: /^Plowed / }).waitFor({ timeout: T })
    check('a skipped stop can be plowed later', true)
  },

  async offline(page, { touch, size, shot, engine, context }) {
    await page.goto(at('/d/?k=demo-truck-2-sample&reset=1'))
    await page.locator('#stop-name').waitFor({ timeout: T })
    // Same link without reset=1, so the reloads below keep the mock store (the "server").
    await page.goto(at('/d/?k=demo-truck-2-sample'))
    await page.locator('#stop-name').waitFor({ timeout: T })
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true))
    await page.locator('#sync-text', { hasText: 'All sent' }).waitFor({ timeout: T })
    const first = await text(page, '#counter')
    await context.setOffline(true)

    const chooser = page.waitForEvent('filechooser', { timeout: T })
    await tap(page, page.locator('#plowed'), 'Plowed (offline)', touch)
    await (await chooser).setFiles(PHOTO)
    await page.waitForFunction((c) => document.querySelector('#counter')?.innerText !== c, first, { timeout: T })
      .catch(() => check('offline Plowed is kept on the phone and the next stop shows', false, `counter still says ${first}`))
    await page.waitForTimeout(800)
    await tap(page, page.locator('#skip'), 'Skip this stop (offline)', touch)
    await tap(page, page.getByRole('button', { name: 'Car in the way', exact: true }), 'Car in the way', touch)
    await waitText(page, '#sync-text', /^No signal\. 2 check-ins saved on this phone\./)
    check('strip says 2 check-ins saved, offline', true)
    check('saved rows are marked', (await page.locator('.row-status', { hasText: 'saved on this phone' }).count()) === 2)
    await shot('driver-offline')

    if (engine === 'chromium') {
      await page.reload()
      await page.locator('#stop-name').waitFor({ timeout: T })
      await waitText(page, '#sync-text', /^No signal\. 2 check-ins saved on this phone\./)
      check('reload offline: the service worker serves the page and it still shows the route and 2 saved', true)
      check('reload offline: says the route is the saved copy', (await page.locator('.strip-note').count()) === 1)
    } else {
      notes.push(`${engine}-${size}: offline reload not tried here (M2 decides with @playwright/test)`)
    }

    await context.setOffline(false)
    await page.locator('#sync-text', { hasText: 'All sent' }).waitFor({ timeout: 25000 })
    check('back online: strip says All sent', true)
    // Proof it reached the "server": a fresh load reads the route from the mock store, not the phone's queue.
    await page.reload()
    await page.locator('#stop-name').waitFor({ timeout: T })
    await page.locator('#sync-text', { hasText: 'All sent' }).waitFor({ timeout: T })
    // The saved copy paints first; wait until the route came from the server, or this check reads the phone, not the server.
    await page.locator('.strip-note').waitFor({ state: 'detached', timeout: T })
    const statuses = await page.locator('.row-status').allInnerTexts()
    check('both check-ins are on the server after sync', statuses.filter((s) => /^Plowed |^Skipped: Car in the way$/.test(s)).length === 4 && !statuses.some((s) => s.includes('saved on this phone')), statuses.slice(0, 4).join(' | '))
  },

  async nostorm(page, { size, shot }) {
    await page.goto(at('/d/?k=demo-truck-3-sample&reset=1'))
    await see(page, 'No storm on right now')
    await badge(page)
    await big(page.getByRole('button', { name: 'Check again' }), 'Check again')
    await noSideScroll(page, size)
    await shot('driver-no-storm')
  },

  async statusWaiting(page, { size, shot }) {
    await page.goto(at('/s/?k=demo-status-sample-04&reset=1'))
    await page.locator('#answer').waitFor({ timeout: T })
    await badge(page)
    check('address shown', (await text(page, '#address')) === 'Scott Avenue, Grand Falls-Windsor, NL')
    const a = await text(page, '#answer')
    check('waiting answer names the stop number', /^On the route tonight\. You're stop \d+\.$/.test(a), a)
    await see(page, 'done so far')
    await noSideScroll(page, size)
    await shot('status-waiting')
  },

  async statusPlowed(page, { size, shot }) {
    await page.goto(at('/s/?k=demo-status-sample-01&reset=1'))
    await page.locator('#answer').waitFor({ timeout: T })
    await badge(page)
    check('plowed answer', /^Plowed at \d{1,2}:\d{2} [AP]M$/.test(await text(page, '#answer')), await text(page, '#answer'))
    await page.waitForFunction(() => document.querySelector('#photo')?.complete && document.querySelector('#photo').naturalWidth > 0, null, { timeout: T })
    check('photo loads', true)
    await noSideScroll(page, size)
    await shot('status-plowed')
  },

  async statusBad(page, { shot }) {
    await page.goto(at('/s/?k=not-a-real-status-key'))
    await see(page, "This status link doesn't work. Ask your snow clearing company for a new one.")
    await badge(page)
    await shot('status-bad-link')
  },
}

/* ---- run ---------------------------------------------------------------- */
if (SHOTS) await mkdir(path.join(APP, 'tests', 'shots'), { recursive: true })
const only = opt('--only', '')

for (const engine of ENGINES) {
  const browser = await (engine === 'webkit' ? webkit : chromium).launch()
  for (const size of [390, 1280]) {
    const touch = size === 390
    const device = size === 390
      ? engine === 'webkit' ? { ...devices['iPhone 14'] } : { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
      : { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 }
    for (const [name, fn] of Object.entries(scenarios)) {
      if (only && !only.split(',').includes(name)) continue
      console.log(`mock ${engine}-${size} ${name}`)
      const context = await browser.newContext(device)
      // Nothing may leave 127.0.0.1.
      const outside = []
      await context.route((url) => url.hostname !== '127.0.0.1', (route) => { outside.push(route.request().url()); return route.abort() })
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', (e) => errors.push(e.message))
      const shot = async (file) => {
        if (!SHOTS || engine !== 'chromium') return
        await page.evaluate(() => window.scrollY === 0 || new Promise((r) => { window.scrollTo(0, 0); requestAnimationFrame(() => r(true)) }))
        await page.screenshot({ path: path.join(APP, 'tests', 'shots', `${file}-${size}.png`), fullPage: !file.includes('sheet'), animations: 'disabled' }) // a sheet is fixed: show the screen a person sees
      }
      try {
        await fn(page, { touch, size, shot, engine, context })
        check('no page errors', errors.length === 0, errors.join(' | '))
        check('no request left 127.0.0.1', outside.length === 0, outside.join(' '))
      } catch (e) {
        if (!/^check failed|is covered$/.test(e.message)) {
          failures++
          console.log(`  FAIL ${name}: ${e.message.split('\n')[0]}`)
          if (errors.length) console.log(`       page errors: ${errors.join(' | ')}`)
        }
      }
      await context.close()
    }
  }
  await browser.close()
}

server?.kill()
for (const n of notes) console.log(`NOTE ${n}`)
console.log(`\n${passes} passed, ${failures} failed`)
process.exit(failures ? 1 : 0)
