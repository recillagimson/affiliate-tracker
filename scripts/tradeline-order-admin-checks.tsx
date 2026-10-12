// The owner's view of tradeline orders.
//
// These pages are where a customer's SSN is one press away, so what is pinned
// is that it is never there until that press: the page is drawn with the last
// four digits and nothing else. And that the list finds an order by what
// somebody on the phone would give: a number, a name, an email.
//
//   npx tsx --tsconfig scripts/render.tsconfig.json scripts/tradeline-order-admin-checks.tsx

import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppRouterContext, type AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { OrderActions, OrderSecrets, OrdersList } from '../src/components/TradelineOrders';
import { formatMobile, formatSsn, matchOrders, readOrderAction } from '../src/lib/tradeline-order-admin';
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

const rendered: string[] = [];
const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} } as unknown as AppRouterInstance;
function render(node: ReactNode): string {
  const html = renderToStaticMarkup(<AppRouterContext.Provider value={router}>{node}</AppRouterContext.Provider>);
  rendered.push(html);
  return html;
}

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
  items: [{ id: '1', issuer: 'capital-one', name: 'Capital One/Cabelas', creditLimit: 500, openDate: '2014-05-22', age: '11.27', unitPrice: 1100, quantity: 2, lineTotal: 2200, commission: 200 }],
  ...over,
});
const orders = [
  order({}),
  order({ orderNumber: 'LGF-100002', customerName: 'Sam <b>Example</b>', customerEmail: 'sam@example.org', status: 'paid', paidAt: '2026-10-12T12:00:00Z', affiliateUserId: null, tradelineRef: '' }),
  order({ orderNumber: 'LGF-100003', customerName: 'Alex Other', customerEmail: 'alex@example.net', status: 'cancelled', cancelledAt: '2026-10-12T13:00:00Z' }),
];
const numbers = (list: TradelineOrder[]) => list.map((item) => item.orderNumber).join();

console.log('- finding an order -');
check('everything, with nothing asked for', matchOrders(orders, '', 'all').length === 3);
check('by order number, however it is typed', numbers(matchOrders(orders, ' lgf-100002 ', 'all')) === 'LGF-100002' && numbers(matchOrders(orders, '100003', 'all')) === 'LGF-100003');
check('by part of a name, whatever its case', numbers(matchOrders(orders, 'jordan', 'all')) === 'LGF-100001');
check('by email', numbers(matchOrders(orders, 'example.org', 'all')) === 'LGF-100002');
check('by status', numbers(matchOrders(orders, '', 'paid')) === 'LGF-100002' && numbers(matchOrders(orders, '', 'cancelled')) === 'LGF-100003');
check('by both at once', matchOrders(orders, 'jordan', 'paid').length === 0);
check('never by the last four of an SSN', matchOrders(orders, '6789', 'all').length === 0);

console.log('- the actions -');
check('the three are read', readOrderAction('pay') === 'pay' && readOrderAction('cancel') === 'cancel' && readOrderAction('reveal') === 'reveal');
check('nothing else is', readOrderAction('delete') === null && readOrderAction(undefined) === null && readOrderAction(1) === null);

console.log('- how numbers are written -');
check('a mobile', formatMobile('5185550142') === '(518) 555-0142' && formatMobile('555') === '555');
check('an SSN', formatSsn('123456789') === '123-45-6789' && formatSsn('12345') === '12345');

console.log('- the list -');
const list = render(<OrdersList orders={orders} sellers={{ u1: 'Arthur Smith' }} />);
check('every order is there', ['LGF-100001', 'LGF-100002', 'LGF-100003'].every((number) => list.includes(number)));
check('each opens its own page', list.includes('href="/tradelines/orders/LGF-100001"'));
check('with who sold it, or that nobody did', list.includes('Arthur Smith') && list.includes('House sale'));
check('and where it stands', list.includes('Awaiting payment') && list.includes('Paid') && list.includes('Cancelled'));
check('a customer name is text, never markup', !list.includes('<b>Example') && list.includes('&lt;b&gt;'));
check('no SSN digits are on the list at all', !list.includes('6789'));
const empty = render(<OrdersList orders={[]} sellers={{}} />);
check('no orders says so', empty.includes('No orders yet'));

console.log('- an SSN on the page -');
const secrets = render(<OrderSecrets orderNumber="LGF-100001" ssnLast4="6789" />);
check('is the last four behind a mask', secrets.includes('•••-••-6789'));
check('the date of birth is hidden', secrets.includes('Hidden'));
check('and there is a way to reveal both', secrets.includes('Reveal'));
check('nothing more of either is on the page', !/[0-9]{3}-[0-9]{2}-[0-9]{4}/.test(secrets) && !/[0-9]{4}-[0-9]{2}-[0-9]{2}/.test(secrets));

console.log('- what can be done to an order -');
const waiting = render(<OrderActions orderNumber="LGF-100001" status="awaiting_payment" />);
check('one awaiting payment can be marked paid or cancelled', waiting.includes('Mark paid') && waiting.includes('Cancel order'));
const paid = render(<OrderActions orderNumber="LGF-100002" status="paid" />);
check('a paid one can only be cancelled', !paid.includes('Mark paid') && paid.includes('Cancel order'));
const cancelled = render(<OrderActions orderNumber="LGF-100003" status="cancelled" />);
check('a cancelled one offers nothing', !cancelled.includes('Mark paid') && !cancelled.includes('Cancel order'));

check('no em or en dash anywhere', rendered.every((html) => !/[–—]/.test(html)));

console.log(`\ntradeline-order-admin: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
