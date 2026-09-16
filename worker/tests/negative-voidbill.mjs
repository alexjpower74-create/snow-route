// npm run negative:voidbill — the copy's billing counts voided check-ins. The voided-never-bills test must go red.
import { runControl } from './negative-lib.mjs'
await runControl({
  title: 'negative:voidbill',
  testFile: 'tests/api.test.mjs',
  tests: ['billing: a voided check-in never bills'],
  api: true,
  breaks: [{ file: 'src/billing.js', find: '  if (checkin.voided_at) return false\n', replace: '' }],
  describe: 'billing counts an undone check-in',
})
