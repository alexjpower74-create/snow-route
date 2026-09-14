// Negative control (h): the copy's billing screen recomputes HST on the page instead of showing the API row. billing.spec.mjs must
// go red on the $35.50 client ($5.33 by the half-up rule).
// Why truncation and not Math.round(amount * 0.15), which clarification 34 names: a search over every amount from 1 to 1,000,000
// cents found no amount where Math.round(amount * 0.15) differs from Math.floor((amount * 15 + 50) / 100). In floating point,
// 3550 * 0.15 is exactly 532.5, and Math.round gives 533, the same as the rule. That break would show the right numbers and could
// never go red (it ran GREEN on 2026-09-14, recorded in negative-control.log). Truncating, Math.floor(amount * 0.15), is the
// recomputation a page gets wrong in practice: $5.32 on $35.50. Exit 0 only if red.
import path from 'node:path'
import { control, replaceOnce } from './negative-lib.mjs'

process.exit(control({
  name: 'hst',
  what: 'owner.js shows HST as Math.floor(amount * 0.15) computed on the page, not the API row',
  args: ['billing.spec.mjs', '--project', 'chromium-390'],
  breakIt: (copy) => replaceOnce(path.join(copy, 'app', 'public', 'owner', 'owner.js'),
    '<td class="cell-num" data-col="hst">${money(r.hst_cents)}</td>',
    '<td class="cell-num" data-col="hst">${money(Math.floor(r.amount_cents * 0.15))}</td>'),
}))
