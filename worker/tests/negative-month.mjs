// npm run negative:month — the copy uses UTC month bounds instead of NL ones. The NL month boundary test must go red.
import { runControl } from './negative-lib.mjs'
await runControl({
  title: 'negative:month',
  testFile: 'tests/api.test.mjs',
  tests: ['billing: NL month boundary'],
  api: true,
  breaks: [{
    file: 'src/billing.js',
    find: '  const bounds = monthBounds(month)\n',
    replace: '  const bounds = { start: `${month}-01T00:00:00.000Z`, end: new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 1)).toISOString() }\n'
  }],
  describe: 'a month runs from UTC midnight to UTC midnight'
})
