// Negative control (n): the copy draws the base map with an empty attribution (the ATTRIBUTION constant emptied). owner.spec.mjs
// "the map shows OpenFreeMap attribution" must go red: OpenFreeMap requires "OpenFreeMap © OpenMapTiles Data from OpenStreetMap" on the
// map (DECISIONS 62). Exit 0 only if red.
import path from 'node:path'
import { control, replaceOnce } from './negative-lib.mjs'

process.exit(control({
  name: 'attribution',
  what: 'owner.js draws the base map with an empty attribution',
  args: ['owner.spec.mjs', '--project', 'chromium-1280', '-g', 'the map shows OpenFreeMap attribution'],
  breakIt: (copy) => {
    replaceOnce(path.join(copy, 'app', 'public', 'owner', 'owner.js'),
      "const ATTRIBUTION = '<a href=\"https://openfreemap.org\"",
      "const ATTRIBUTION = '' // NEGATIVE CONTROL (n)\nconst ATTRIBUTION_UNUSED = '<a href=\"https://openfreemap.org\"")
  },
}))
