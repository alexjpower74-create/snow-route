// npm run negative:twoopt — the copy's orderTier skips 2-opt (plain nearest neighbour). The local-optimum and crossing tests must go red.
import { runControl } from './negative-lib.mjs'
await runControl({
  title: 'negative:twoopt',
  testFile: 'tests/route.test.mjs',
  tests: ['2-opt local optimum', 'crossing'],
  breaks: [
    {
      file: 'src/route.js',
      find: 'return twoOpt(start, nearestNeighbour(start, stops))',
      replace: 'return nearestNeighbour(start, stops)',
    },
  ],
  describe: 'a tier is ordered by nearest neighbour alone',
})
