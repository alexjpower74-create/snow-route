// npm run negative:stoprace — proves the stop-race test can fail (clarification 15), in the Book a Bay style.
// Both runs of the copy get `await scheduler.wait(25)` between the check-in's read of the stop and its write, so a removal fired
// 5 ms later lands inside the gap. With the STOP_GUARD_SQL statement still in the batch, no check-in may land on a removed stop.
// The break removes that statement (the check-in then relies on its earlier read): at least one check-in must land on a removed
// stop. Exits 0 only if the guarded copy shows 0 such check-ins and the broken copy shows at least 1 and the test goes red.
import { runControl } from './negative-lib.mjs'

const orphans = (out) => Number((/STOPRACE orphans=(\d+)/.exec(out) || [])[1] ?? NaN)

await runControl({
  title: 'negative:stoprace',
  testFile: 'tests/api.test.mjs',
  tests: ['stop race'],
  api: true,
  setup: [
    {
      file: 'src/index.js',
      find: '  // TIME-RULE:',
      replace:
        "  await scheduler.wait(25) // NEGATIVE CONTROL ONLY: widen the gap between the check-in's read and its write\n  // TIME-RULE:",
    },
  ],
  breaks: [{ file: 'src/index.js', find: '  stmts.push(db.prepare(STOP_GUARD_SQL).bind(storm.id, body.client_id))\n', replace: '' }],
  check: (before, after) => {
    const b = orphans(before)
    const a = orphans(after)
    return { ok: b === 0 && a >= 1, note: `check-ins on removed stops, same 25 ms gap: with the guard ${b}, without it ${a} (of 10 pairs)` }
  },
  describe: 'the check-in batch no longer re-checks that the stop is still on the route',
})
