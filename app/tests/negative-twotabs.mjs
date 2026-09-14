// Negative control (f): the copy reads a check-in missing after a 200/201 as "undone" again and sends without the Web Lock.
// queue.spec.mjs's two-tab test must go red with a voided push. Exit 0 only if red.
import path from 'node:path'
import { control, replaceOnce } from './negative-lib.mjs'

process.exit(control({
  name: 'twotabs',
  what: 'queue.js infers "undone" from a missing item after a 200/201 and sends without navigator.locks',
  args: ['queue.spec.mjs', '--project', 'chromium-390', '-g', 'two open tabs'],
  breakIt: (copy) => {
    const file = path.join(copy, 'app', 'public', 'd', 'queue.js')
    replaceOnce(file, `        if (!still) return { result: 'gone' } // another tab sent it and removed it: nothing was undone`,
      `        if (!still) return { result: 'undone' } // NEGATIVE CONTROL (f): missing read as undone`)
    replaceOnce(file, `const withSendLock = (fn) => (globalThis.navigator?.locks ? navigator.locks.request('snow-route-send', fn) : fn())`,
      `const withSendLock = (fn) => fn() // NEGATIVE CONTROL (f): no lock`)
  },
}))
