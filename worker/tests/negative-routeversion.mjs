// npm run negative:routeversion — the copy drops the route-version guard from the route PUT's write batch (clarification 32). A stale
// version with the same stop set is then written over the newer route, and two PUTs racing with one version both answer 200: the stale
// test and the race test must both go red.
import { runControl } from './negative-lib.mjs'
await runControl({
  title: 'negative:routeversion',
  testFile: 'tests/api.test.mjs',
  tests: ['route version: a stale version with the same stop set', 'route version: two PUTs racing with the same version'],
  api: true,
  breaks: [{ file: 'src/index.js', find: '    db.prepare(ROUTE_VERSION_GUARD_SQL).bind(stormId, body.route_version),\n', replace: '' }],
  describe: 'the route PUT no longer checks the version inside its write batch'
})
