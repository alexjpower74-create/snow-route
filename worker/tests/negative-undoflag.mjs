// npm run negative:undoflag — the copy ignores the check-in's undo flag (clarification 52): a re-send made for an undo stores a live
// push. The new-id undo test must go red with a check-in that is not voided and a stop that reads plowed.
import { runControl } from './negative-lib.mjs'
await runControl({
  title: 'negative:undoflag',
  testFile: 'tests/api.test.mjs',
  tests: ['undo flag: a new id is stored already voided'],
  api: true,
  breaks: [
    {
      file: 'src/index.js',
      find: 'has_photo: body.has_photo, undo: body.undo === true }',
      replace: 'has_photo: body.has_photo, undo: false }',
    },
  ],
  describe: 'the undo flag is ignored and the re-send stores a live push',
})
