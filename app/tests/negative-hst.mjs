// Negative control (h): the copy's billing screen recomputes HST with Math.round(amount * 0.15) instead of showing the API row.
// billing.spec.mjs must go red on the $35.50 client: $5.32 on the page, $5.33 by the rule. Exit 0 only if red.
import path from 'node:path'
import { control, replaceOnce } from './negative-lib.mjs'

process.exit(control({
  name: 'hst',
  what: 'owner.js shows HST as Math.round(amount * 0.15), not the API row',
  args: ['billing.spec.mjs', '--project', 'chromium-390'],
  breakIt: (copy) => replaceOnce(path.join(copy, 'app', 'public', 'owner', 'owner.js'),
    '<td class="cell-num" data-col="hst">${money(r.hst_cents)}</td>',
    '<td class="cell-num" data-col="hst">${money(Math.round(r.amount_cents * 0.15))}</td>'),
}))
