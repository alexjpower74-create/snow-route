// Negative control (j): the copy restores only "a check-in missing after 200/201 was undone" (the Web Lock stays). queue.spec.mjs's
// two-tab test without Web Locks must go red with a voided push. Exit 0 only if red.
import path from 'node:path'
import { control, replaceOnce } from './negative-lib.mjs'

process.exit(
  control({
    name: 'missingundo',
    what: 'queue.js reads a check-in missing after 200/201 as undone (only that rule; the lock code is untouched)',
    args: ['queue.spec.mjs', '--project', 'chromium-390', '-g', 'without Web Locks'],
    breakIt: (copy) =>
      replaceOnce(
        path.join(copy, 'app', 'public', 'd', 'queue.js'),
        `        if (!still) return { result: 'gone' } // another tab sent it and removed it: nothing was undone`,
        `        if (!still) return { also: [voidFor({ ...item, truck_id: stored })], result: 'undone' } // NEGATIVE CONTROL (j): missing read as undone`,
      ),
  }),
)
