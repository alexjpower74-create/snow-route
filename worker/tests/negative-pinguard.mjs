// npm run negative:pinguard — the copy's PIN change stops taking a sign-in guard slot. The PIN-change guard test must go red.
// Not redundant with the sign-in guard: PUT /api/owner/pin calls takeAttempt on its own, and this proves that call is measured.
import { runControl } from './negative-lib.mjs'
await runControl({
  title: 'negative:pinguard',
  testFile: 'tests/api.test.mjs',
  tests: ['PIN change: wrong current PINs count toward the sign-in guard'],
  api: true,
  breaks: [{
    file: 'src/index.js',
    find: "  const attempt = await takeAttempt(env.DB, 'pin', ctx.ip, ctx.now, SIGNIN_LIMIT)\n  if (!attempt) throw rateLimited('Too many tries. Wait 15 minutes and try again.')\n  if (!(await verifyPin(typeof body.current",
    replace: "  const attempt = 0\n  if (!(await verifyPin(typeof body.current"
  }],
  describe: 'a wrong current PIN on PUT /api/owner/pin is not counted'
})
