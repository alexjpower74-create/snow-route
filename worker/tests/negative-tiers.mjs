// npm run negative:tiers — the copy puts every stop in one tier (priority ignored). The tier test must go red.
import { runControl } from './negative-lib.mjs'
await runControl({
  title: 'negative:tiers',
  testFile: 'tests/route.test.mjs',
  tests: ['tiers'],
  breaks: [{ file: 'src/route.js', find: 'for (const s of stops) tiers[tierOf(s.priority)].push(s)', replace: 'for (const s of stops) tiers[2].push(s)' }],
  describe: 'priority is ignored when ordering'
})
