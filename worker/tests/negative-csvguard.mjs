// npm run negative:csvguard — the copy drops the CSV formula guard. The CSV test must go red.
import { runControl } from './negative-lib.mjs'
await runControl({
  title: 'negative:csvguard',
  testFile: 'tests/api.test.mjs',
  tests: ['billing CSV'],
  api: true,
  breaks: [{ file: 'src/billing.js', find: "  if (/^[=+\\-@\\t\\r]/.test(s)) s = `'${s}`\n", replace: '' }],
  describe: 'a cell starting with = is written as is',
})
