// npm run negative:skipbill — the copy's billing counts every check-in kind. The skipped-never-bills test must go red.
import { runControl } from './negative-lib.mjs'
await runControl({
  title: 'negative:skipbill',
  testFile: 'tests/api.test.mjs',
  tests: ['billing: a skipped stop never bills'],
  api: true,
  breaks: [{ file: 'src/billing.js', find: "  if (checkin.kind !== 'plowed') return false\n", replace: '' }],
  describe: 'billing counts skipped check-ins as pushes'
})
