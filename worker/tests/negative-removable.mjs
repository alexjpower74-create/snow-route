// npm run negative:removable — the copy works out removable from non-voided check-ins only, so a stop whose only check-in was undone
// reads as removable while the Worker still refuses to remove it (clarification 42). The removable test must go red on the undone case.
import { runControl } from './negative-lib.mjs'
await runControl({
  title: 'negative:removable',
  testFile: 'tests/api.test.mjs',
  tests: ['removable: a fresh stop is removable'],
  api: true,
  breaks: [{
    file: 'src/index.js',
    find: "db.prepare('SELECT DISTINCT client_id FROM checkins WHERE storm_id = ?1').bind(stormId)",
    replace: "db.prepare('SELECT DISTINCT client_id FROM checkins WHERE storm_id = ?1 AND voided_at IS NULL').bind(stormId)"
  }],
  describe: 'removable ignores voided check-ins'
})
