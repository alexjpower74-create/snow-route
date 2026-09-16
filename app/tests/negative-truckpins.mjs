// Negative control (m): the copy draws every truck's route pins with truck 1's look (ring colour and shape) while each pin keeps its
// data-truck. owner.spec.mjs "each route pin shows its truck" must go red: truck 2's pins no longer match truck 2's legend entry, so a
// "1" on one route could not be told from a "1" on the other. Exit 0 only if red.
import path from 'node:path'
import { control, replaceOnce } from './negative-lib.mjs'

process.exit(
  control({
    name: 'truckpins',
    what: "owner.js draws every truck's route pins with truck 1's ring colour and shape",
    args: ['owner.spec.mjs', '--project', 'chromium-1280', '-g', 'each route pin shows its truck'],
    breakIt: (copy) => {
      replaceOnce(
        path.join(copy, 'app', 'public', 'owner', 'owner.js'),
        '    const look = truckLook(i)\n',
        '    const look = truckLook(0) // NEGATIVE CONTROL (m)\n',
      )
    },
  }),
)
