// Negative control (e): the copy's billing screen takes each row's pushes from the storms' stop lists (how many storms the client
// was a stop in) instead of the API row. billing.spec.mjs must go red: the skipped seasonal client shows a push. Exit 0 only if red.
import path from 'node:path'
import { control, replaceOnce } from './negative-lib.mjs'

process.exit(
  control({
    name: 'billing',
    what: 'owner.js shows pushes as the number of storm stops for the client, not the API row',
    args: ['billing.spec.mjs', '--project', 'chromium-390'],
    breakIt: (copy) => {
      const file = path.join(copy, 'app', 'public', 'owner', 'owner.js')
      replaceOnce(
        file,
        `function pushesOf(row) {
  return row.pushes
}`,
        `function pushesOf(row) {
  return window.__stopCounts?.[row.client_id] ?? row.pushes // NEGATIVE CONTROL (e)
}`,
      )
      replaceOnce(
        file,
        `  const data = await api.owner.billing(state.billingMonth)
`,
        `  const data = await api.owner.billing(state.billingMonth)
  window.__stopCounts = {} // NEGATIVE CONTROL (e): count stops, not pushes
  for (const s of (await api.owner.storms()).storms) {
    for (const t of (await api.owner.storm(s.id)).trucks) for (const st of t.stops) window.__stopCounts[st.client_id] = (window.__stopCounts[st.client_id] || 0) + 1
  }
`,
      )
    },
  }),
)
