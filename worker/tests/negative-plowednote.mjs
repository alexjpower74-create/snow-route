// npm run negative:plowednote — the copy keeps the body's note on a plowed check-in (clarification 10 undone). The plowed-note test
// must go red. Not redundant: no other test looks at the note stored on a plowed check-in.
import { runControl } from './negative-lib.mjs'
await runControl({
  title: 'negative:plowednote',
  testFile: 'tests/api.test.mjs',
  tests: ['check-ins: a plowed check-in stores no note and no reason'],
  api: true,
  breaks: [
    { file: 'src/index.js', find: 'const note = plowed || body.note === undefined', replace: 'const note = body.note === undefined' },
  ],
  describe: "a plowed check-in keeps the body's note",
})
