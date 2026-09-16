// npm run negative:statusroute — the copy restores the old status route pattern, so a mangled key never reaches the status
// handler and gets the router's "There's nothing here." (and never counts toward the guard). The mangled-link test must go red.
import { runControl } from './negative-lib.mjs'
await runControl({
  title: 'negative:statusroute',
  testFile: 'tests/api.test.mjs',
  tests: ['status link: a mangled key'],
  api: true,
  breaks: [
    {
      file: 'src/index.js',
      find: "  ['GET', /^\\/api\\/status\\/(.*)$/, 'public', clientStatus],",
      replace: "  ['GET', /^\\/api\\/status\\/([A-Za-z0-9_-]{1,128})$/, 'public', clientStatus],",
    },
  ],
  describe: 'the router only sends key-shaped paths to the status handler',
})
