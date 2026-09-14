// Negative control (g): the copy re-keys photos and undos to whatever truck the page is (the truck comparison is gone).
// queue.spec.mjs's cross-truck test must go red: a PUT or DELETE is sent under truck 2's key. Exit 0 only if red.
import path from 'node:path'
import { control, replaceOnce } from './negative-lib.mjs'

process.exit(control({
  name: 'crosstruck',
  what: 'queue.js re-keys photos and undos across trucks (no truck comparison)',
  args: ['queue.spec.mjs', '--project', 'chromium-390', '-g', "truck 1's link"],
  breakIt: (copy) => replaceOnce(path.join(copy, 'app', 'public', 'd', 'queue.js'),
    `      if (checkin || (item.truck_id ?? truckOf(item.key)) === page.truckId) {`,
    `      if (checkin || true) { // NEGATIVE CONTROL (g): no truck comparison`),
}))
