// npm run negative:idempotent — the copy's check-ins table has no PRIMARY KEY on id (migration in the copy) and the insert is a
// plain INSERT. Resending a check-in then stores it twice: the same-id test must go red.
import { runControl } from './negative-lib.mjs'
await runControl({
  title: 'negative:idempotent',
  testFile: 'tests/api.test.mjs',
  tests: ['check-ins: the same id again'],
  api: true,
  breaks: [
    {
      file: 'migrations/0001_init.sql',
      find: '  id TEXT PRIMARY KEY,\n  storm_id INTEGER NOT NULL,',
      replace: '  id TEXT NOT NULL,\n  storm_id INTEGER NOT NULL,',
    },
    { file: 'src/index.js', find: ' ON CONFLICT(id) DO NOTHING', replace: '' },
  ],
  describe: 'check-ins.id is not a primary key and the insert is a plain INSERT',
})
