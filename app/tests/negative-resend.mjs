// Negative control (k): the copy sends an undo's DELETE without re-sending the check-in first, and treats a DELETE answering 404 as
// nothing to undo (clarification 38 as it was). queue.spec.mjs's "re-sends the check-in first" test must go red: tab B's DELETE finds
// no row and is dropped, tab A's late POST then stores the check-in, and the tapped Undo is lost. Exit 0 only if red.
import path from 'node:path'
import { control, replaceOnce } from './negative-lib.mjs'

process.exit(control({
  name: 'resend',
  what: 'queue.js sends the DELETE without re-sending the check-in, and drops a 404 undo quietly',
  args: ['queue.spec.mjs', '--project', 'chromium-390', '-g', 're-sends the check-in first and voids it'],
  breakIt: (copy) => {
    const file = path.join(copy, 'app', 'public', 'd', 'queue.js')
    replaceOnce(file, `    if (item.op === 'void' && item.resend) {`, `    if (false) { // NEGATIVE CONTROL (k): no re-send`)
    replaceOnce(file, `      } else {
        // After the re-send, a 404 means the check-in belongs to another truck: shown, never dropped (clarification 49).`,
    `      } else if (status === 404) {
        await remove(item.qid) // NEGATIVE CONTROL (k): 404 is nothing to undo
      } else {
        // After the re-send, a 404 means the check-in belongs to another truck: shown, never dropped (clarification 49).`)
  },
}))
