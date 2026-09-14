// Negative control (c): the copy lays a transparent overlay over the Plowed button (the button still measures 76 px, so a
// rectangle check would call it fine). The tap target test's hit-test must go red. Exit 0 only if red.
import path from 'node:path'
import { control, replaceOnce } from './negative-lib.mjs'

process.exit(control({
  name: 'overlay',
  what: 'a transparent, full-size element sits on top of the Plowed button',
  args: ['targets.spec.mjs', '--project', 'chromium-390', '-g', 'every driver button'],
  breakIt: (copy) => {
    replaceOnce(path.join(copy, 'app', 'public', 'd', 'driver.js'),
      `        <span class="btn-main">Plowed</span><span class="btn-sub">takes a photo</span>
      </label>`,
      `        <span class="btn-main">Plowed</span><span class="btn-sub">takes a photo</span>
      </label>
      <div class="negative-overlay" aria-hidden="true"></div>`)
    replaceOnce(path.join(copy, 'app', 'public', 'style.css'),
      '.actions { display: grid; gap: var(--gap); margin-top: 22px; }',
      `.actions { display: grid; gap: var(--gap); margin-top: 22px; position: relative; }
/* NEGATIVE CONTROL (c): transparent, over the Plowed button (the second row of .actions) */
.negative-overlay { position: absolute; left: 0; right: 0; top: calc(var(--action) + var(--gap)); height: var(--action); background: transparent; z-index: 5; }`)
  },
}))
