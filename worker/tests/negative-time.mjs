// npm run negative:time — the copy stores the server's now instead of the driver's `at`. The original-time test must go red.
import { runControl } from './negative-lib.mjs'
await runControl({
  title: 'negative:time',
  testFile: 'tests/api.test.mjs',
  tests: ['check-ins: original time kept'],
  api: true,
  breaks: [{ file: 'src/index.js', find: 'const at = inWindow ? iso(input.at) : iso(ctx.now)', replace: 'const at = iso(ctx.now)' }],
  describe: 'a check-in is stamped with the time it synced',
})
