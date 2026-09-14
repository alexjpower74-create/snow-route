// Negative control (i): the copy forgets the attempted rule: every undone item leaves the phone with no DELETE. queue.spec.mjs's
// response-lost test must go red: the tapped Undo never reaches the Worker and the push stays. Exit 0 only if red.
import path from 'node:path'
import { control, replaceOnce } from './negative-lib.mjs'

process.exit(control({
  name: 'attempted',
  what: 'queue.js deletes an undone item without a DELETE even when its POST was attempted',
  args: ['queue.spec.mjs', '--project', 'chromium-390', '-g', 'answer is lost'],
  breakIt: (copy) => replaceOnce(path.join(copy, 'app', 'public', 'd', 'queue.js'),
    '          const needsUndo = !!i.attempted', '          const needsUndo = false // NEGATIVE CONTROL (i)'),
}))
