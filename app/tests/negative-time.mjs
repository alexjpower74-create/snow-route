// Negative control (b): the copy stamps `at` when the item is sent instead of when the driver tapped. The original-time
// assertion in offline.spec.mjs must go red (the check-ins arrive with the sync time). Exit 0 only if red.
import path from 'node:path'
import { control, replaceOnce } from './negative-lib.mjs'

process.exit(
  control({
    name: 'time',
    what: 'queue.js sets body.at to the phone clock at send time',
    args: ['offline.spec.mjs', '--project', 'chromium-390', '-g', 'no signal: 2 check-ins saved'],
    breakIt: (copy) =>
      replaceOnce(
        path.join(copy, 'app', 'public', 'd', 'queue.js'),
        '      else r = await api.driver.checkin(item.key, item.body)\n',
        '      else r = await api.driver.checkin(item.key, { ...item.body, at: new Date().toISOString() }) // NEGATIVE CONTROL (b)\n',
      ),
  }),
)
