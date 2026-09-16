// Negative control (a): the copy's queue deletes a check-in BEFORE the server answers. offline.spec.mjs must go red,
// because a check-in made with no signal never reaches the server. Exit 0 only if red.
import path from 'node:path'
import { control, replaceOnce } from './negative-lib.mjs'

process.exit(
  control({
    name: 'queue',
    what: 'queue.js removes the item from IndexedDB before sending it, so it is gone whatever the server says',
    args: ['offline.spec.mjs', '--project', 'chromium-390', '-g', 'no signal: 2 check-ins saved'],
    breakIt: (copy) =>
      replaceOnce(
        path.join(copy, 'app', 'public', 'd', 'queue.js'),
        '    let r\n    try {\n',
        '    let r\n    await remove(item.qid) // NEGATIVE CONTROL (a): removed before the server answers\n    try {\n',
      ),
  }),
)
