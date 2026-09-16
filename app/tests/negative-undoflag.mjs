// Negative control (l): the copy's undo re-send leaves out undo: true (clarification 52). queue.spec.mjs's never-stored test must go
// red: the re-send stores a LIVE check-in, and a DELETE has to be sent after it. Exit 0 only if red.
import path from 'node:path'
import { control, replaceOnce } from './negative-lib.mjs'

process.exit(
  control({
    name: 'undoflag',
    what: 'queue.js re-sends a check-in for an undo without undo: true',
    args: ['queue.spec.mjs', '--project', 'chromium-390', '-g', 'tried but never stored'],
    breakIt: (copy) =>
      replaceOnce(
        path.join(copy, 'app', 'public', 'd', 'queue.js'),
        'again = await api.driver.checkin(item.key, { ...item.checkin, undo: true })',
        'again = await api.driver.checkin(item.key, item.checkin) // NEGATIVE CONTROL (l)',
      ),
  }),
)
