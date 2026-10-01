/**
 * Monthly payouts: who is owed what on the Monthly tab, and which cards
 * payroll may pay.
 *
 *   npx tsx scripts/monthly-payout-checks.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConversionView } from '../src/lib/analytics';
import { buildMonthly, describeMonthly, tabFrom } from '../src/lib/payout-admin';
import { validateRequestedIds } from '../src/lib/payout-request';
import { payslipGate } from '../src/lib/payout-api';
import { approvalHistory, describeHistory } from '../src/lib/payslip-view';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) pass += 1;
  else fail += 1;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || extra === undefined ? '' : ` ${JSON.stringify(extra)}`}`);
}

const view = (id: string, usr: string, approvedOn: string, amount: number): ConversionView =>
  ({ id, usr, approvedOn, amount, card: `Card ${id}`, client: `Client ${id}`, person: '' }) as unknown as ConversionView;

console.log('— the tab —');
check('?tab=monthly opens Monthly', tabFrom('monthly') === 'monthly');
check('Pending and Requests still open', tabFrom('pending') === 'pending' && tabFrom(undefined) === 'requests');

console.log('\n— who is owed what —');
const TODAY = '2026-10-02';
const views = [
  view('1', 'ana', '2026-09-30', 70), // two days old: monthly pays it, no 15-day wait
  view('2', 'ana', '2026-08-01', 50),
  view('3', 'ben', '2026-09-10', 200),
  view('4', 'ana', '2026-07-01', 30), // already paid
  view('5', '', '2026-09-01', 99), // house card
  view('6', 'lgf', '2026-09-01', 0), // LGF employee: no share
  view('7', 'ghost', '2026-09-01', 40), // no account behind the key
];
const userIdByUsr = new Map([
  ['ana', 'u-ana'],
  ['ben', 'u-ben'],
  ['lgf', 'u-lgf'],
]);
const byUsr = new Map([
  ['ana', { name: 'Ana Reyes', usr: 'ana' }],
  ['ben', { name: 'Ben Cruz', usr: 'ben' }],
]);
const rows = buildMonthly(views, userIdByUsr, byUsr, new Set(['4']));
check('one row per affiliate with something unpaid', rows.map((r) => r.usr).join() === 'ben,ana', rows.map((r) => r.usr));
const ana = rows.find((r) => r.usr === 'ana')!;
check('a card approved two days ago is included', ana.cards.some((c) => c.id === '1'));
check('a paid card is left out', !ana.cards.some((c) => c.id === '4'));
check('the total is the unpaid cards', ana.total === 120, ana.total);
check('oldest approval first', ana.cards.map((c) => c.id).join() === '2,1');
check('it carries the account to pay', ana.userId === 'u-ana' && ana.name === 'Ana Reyes');
check('house cards, no-share cards and unknown keys are nobody to pay', !rows.some((r) => ['', 'lgf', 'ghost'].includes(r.usr)));
check('biggest total first', rows[0]!.usr === 'ben');
check('the summary line', describeMonthly(rows) === '2 affiliates to pay, 3 cards, $320 in total.', describeMonthly(rows));
check('nothing to pay is an empty list', buildMonthly(views, userIdByUsr, byUsr, new Set(['1', '2', '3', '4'])).length === 0);

console.log('\n— what payroll may pay —');
const candidates = views.map((v) => ({ id: v.id, usr: v.usr, approvedOn: v.approvedOn, amount: v.amount }));
const young = validateRequestedIds(['1'], candidates, 'ana', TODAY, new Set(), { anyAge: true });
check('a card of any age can be paid monthly', young.ok);
check('but an affiliate request would still wait 15 days', !validateRequestedIds(['1'], candidates, 'ana', TODAY, new Set()).ok);
check("somebody else's card cannot be paid", !validateRequestedIds(['3'], candidates, 'ana', TODAY, new Set(), { anyAge: true }).ok);
check('a paid card cannot be paid again', !validateRequestedIds(['4'], candidates, 'ana', TODAY, new Set(['4']), { anyAge: true }).ok);
check('the amounts come from the priced rows', young.ok && young.items[0]!.amount === 70);

console.log('\n— affiliates no longer request —');
const SAM = { role: 'affiliate' as const, id: 'u1', usr: 'sam' };
check('a request is refused', payslipGate(SAM, 'request')?.status === 403);
check('a received payment can still be confirmed', payslipGate(SAM, 'confirm') === null);

console.log('\n— the database function —');
const sql = readFileSync(join(process.cwd(), 'supabase', 'migrations', '20261003120000_monthly_payout.sql'), 'utf8')
  .split(/\r?\n/)
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n');
check('it defines create_monthly_payout', /create or replace function public\.create_monthly_payout\(/.test(sql));
check('it has no age cutoff', !/::date\s*-\s*\d+/.test(sql) && !/approved_on\s*<=/.test(sql));
check('it writes the payout as paid', /'paid'/.test(sql));
check('it refuses a card already committed', /released_at is null/.test(sql) && /LG004/.test(sql));
check('only the service role may call it', /revoke all on function public\.create_monthly_payout/.test(sql));

console.log('\n— payment history —');
const conv = (id: string, approvedOn: string, amount: number) =>
  ({ id, usr: 'ana', approvedOn, amount, slug: '', lead: '', notes: '' }) as never;
const load = { links: [], submissions: [], gross: false, conversions: [conv('1', '2026-09-01', 70), conv('2', '2026-09-10', 50), conv('3', '2026-09-20', 30), conv('4', '2026-09-25', 20)] };
const req = (id: string, status: 'paid' | 'requested' | 'cancelled', ids: string[]) => ({
  id, status, requestedAt: '2026-09-28T00:00:00Z', totalAmount: 0, paidAt: status === 'paid' ? '2026-10-01T12:00:00Z' : null,
  cancelledAt: status === 'cancelled' ? '2026-10-02T00:00:00Z' : null, items: ids.map((conversionId) => ({ conversionId, amount: conversionId === '1' ? 135 : 0 })),
});
const history = approvalHistory(load, 'ana', [req('10', 'paid', ['1']), req('11', 'requested', ['2']), req('12', 'cancelled', ['3'])]);
const statusOf = (id: string) => history.find((row) => row.id === id)?.status;
check('every approved card is listed', history.length === 4, history.length);
check('newest approval first', history.map((row) => row.id).join() === '4,3,2,1', history.map((row) => row.id));
check('a card on a paid payout is paid', statusOf('1') === 'paid');
check('with the day it was paid and its payslip', history.find((r) => r.id === '1')!.when === 'Paid 1 Oct 2026' && history.find((r) => r.id === '1')!.href === '/payslips/10');
check('a card on a waiting request is processing', statusOf('2') === 'processing');
check('a card on a cancelled request is unpaid again', statusOf('3') === 'unpaid');
check('a card on no payout is unpaid', statusOf('4') === 'unpaid' && history.find((r) => r.id === '4')!.href === '');
check('a paid card shows what was paid, not today\u2019s price', history.find((r) => r.id === '1')!.amount === 135);
check('an unpaid card shows today\u2019s price', history.find((r) => r.id === '4')!.amount === 20);
check('the summary', describeHistory(history) === '1 card paid, $135. 3 cards not paid yet, $50.', describeHistory(history));
check("somebody else's cards are not listed", approvalHistory(load, 'ben', []).length === 0);

console.log(`\nmonthly-payout: ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
