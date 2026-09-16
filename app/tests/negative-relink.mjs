// Negative control (d): the copy's sender stops the whole queue on a 401, as it did in M1. queue.spec.mjs's link-reset test must go
// red: the check-ins saved under the old link never send with the new one. Exit 0 only if red.
import path from 'node:path'
import { control, replaceOnce } from './negative-lib.mjs'

process.exit(
  control({
    name: 'relink',
    what: 'queue.js stops the whole queue on a 401 (no dead key, no re-keying), as in M1',
    args: ['queue.spec.mjs', '--project', 'chromium-390', '-g', 'a truck link reset'],
    breakIt: (copy) =>
      replaceOnce(
        path.join(copy, 'app', 'public', 'd', 'queue.js'),
        `    if (status === 401) {
      // Only this item's key is dead; the queue goes on. The strip shows the refusal only when it is the page's own key.
      st.dead.add(item.key)
      if (item.key === st.page.key) { st.page.working = false; st.problem = 'unauthorized'; st.message = data?.error || '' }
      return true
    }
`,
        `    if (status === 401) return failed('unauthorized', data?.error || '') // NEGATIVE CONTROL (d): M1 behaviour
`,
      ),
  }),
)
