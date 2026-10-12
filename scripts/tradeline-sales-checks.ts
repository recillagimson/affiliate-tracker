// What an affiliate has made from tradelines, worked out from their orders.
//
// This is money, and it is shown to the person it is owed to, so what is
// pinned is when a commission counts: only on an order that is paid, never on
// one still awaiting payment, and no longer on one that was paid and then
// cancelled. And what their page is handed about the customer: a name, and
// nothing else.
//
//   npx tsx scripts/tradeline-sales-checks.ts

import { affiliateRows, NO_TRADELINE_SALES, orderCommission, summarizeOrders } from '../src/lib/tradeline-sales';
import type { TradelineOrder } from '../src/lib/tradeline-order-store';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) pass++;
  else {
    fail++;
    console.error('FAIL:', name, extra === undefined ? '' : extra);
  }
}

const item = (id: string, name: string, quantity: number, commission = 200) => ({
  id,
  issuer: 'capital-one',
  name,
  creditLimit: 500,
  openDate: '2014-05-22',
  age: '11.27',
  unitPrice: 1100,
  quantity,
  lineTotal: 1100 * quantity,
  commission,
});

const order = (over: Partial<TradelineOrder>): TradelineOrder => ({
  orderNumber: 'LGF-100001',
  createdAt: '2026-10-12T10:00:00Z',
  status: 'awaiting_payment',
  paidAt: null,
  paidBy: '',
  cancelledAt: null,
  cancelledBy: '',
  customerName: 'Jordan Testcase',
  customerEmail: 'jordan@example.com',
  customerMobile: '5185550142',
  line1: '12 Sample Street',
  line2: '',
  city: 'Albany',
  state: 'NY',
  zip: '12207',
  ssnLast4: '6789',
  tradelineRef: 'TL-48213',
  affiliateUserId: 'u1',
  total: 2200,
  items: [item('1', 'Capital One/Cabelas', 2)],
  ...over,
});

const waiting = order({ orderNumber: 'LGF-100001' });
const paidTwoLines = order({
  orderNumber: 'LGF-100002',
  status: 'paid',
  paidAt: '2026-10-12T12:00:00Z',
  total: 3300,
  items: [item('2', 'Capital One/Cabelas', 2), item('3', 'Capital One Walmart', 1)],
});
const paidOne = order({ orderNumber: 'LGF-100003', status: 'paid', paidAt: '2026-10-11T12:00:00Z' });
const cancelledAfterPaying = order({ orderNumber: 'LGF-100004', status: 'cancelled', paidAt: '2026-10-10T12:00:00Z', cancelledAt: '2026-10-11T09:00:00Z' });
const cancelledUnpaid = order({ orderNumber: 'LGF-100005', status: 'cancelled', cancelledAt: '2026-10-11T09:00:00Z' });
const noCommission = order({ orderNumber: 'LGF-100006', status: 'paid', paidAt: '2026-10-12T12:00:00Z', items: [item('9', 'Citi Plus', 1, 0)] });

console.log('- what an order earns -');
check('the commission on each line, whatever the quantity', orderCommission(waiting) === 200 && orderCommission(paidTwoLines) === 400);
check('nought where the lines carry none', orderCommission(noCommission) === 0);

console.log('- the figures -');
check('nobody with no orders has earned anything', JSON.stringify(summarizeOrders([])) === JSON.stringify(NO_TRADELINE_SALES));
const all = [waiting, paidTwoLines, paidOne, cancelledAfterPaying, cancelledUnpaid, noCommission];
const summary = summarizeOrders(all);
check('income is the commission on paid orders', summary.income === 600, summary);
check('an order still awaiting payment has earned nothing yet', summarizeOrders([waiting]).income === 0);
check('an order paid and then cancelled no longer counts', summarizeOrders([cancelledAfterPaying]).income === 0);
check('pending payout is all of it, until payouts exist', summary.pendingPayout === summary.income);
check('checkouts are the orders that were not cancelled', summary.checkouts === 4, summary);

console.log('- what their page is handed -');
const rows = affiliateRows(all);
check('every order is listed, in the order handed over, which is newest first from the store', rows.map((candidate) => candidate.orderNumber).join() === all.map((candidate) => candidate.orderNumber).join(), rows.map((candidate) => candidate.orderNumber));
const row = rows.find((candidate) => candidate.orderNumber === 'LGF-100002');
check('a row says what was bought', row?.items.map((line) => `${line.name} x${line.quantity}`).join() === 'Capital One/Cabelas x2,Capital One Walmart x1', row);
check('and what it came to, where it stands, and what it earns', row?.total === 3300 && row?.status === 'paid' && row?.commission === 400);
check('a cancelled order earns nothing in the list', rows.find((candidate) => candidate.orderNumber === 'LGF-100004')?.commission === 0);
check('the customer is a name', row?.customerName === 'Jordan Testcase');
const allowed = 'commission,customerName,items,orderNumber,placedAt,status,total';
check('and nothing else about them is passed on', rows.every((candidate) => Object.keys(candidate).sort().join() === allowed), Object.keys(rows[0] ?? {}).sort().join());
check('a line is a name and a quantity, nothing more', rows.every((candidate) => candidate.items.every((line) => Object.keys(line).sort().join() === 'name,quantity')));
const handed = JSON.stringify(rows);
check('no SSN digits, email, mobile or address are in what is handed over', !['6789', 'jordan@example.com', '5185550142', '12 Sample Street', '12207', 'Albany'].some((secret) => handed.includes(secret)));

console.log(`\ntradeline-sales: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
