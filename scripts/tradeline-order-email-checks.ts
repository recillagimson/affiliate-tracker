// The email a customer gets when they place a tradelines order.
//
// It goes to an address a stranger typed into a public form, so what is
// pinned is what it must never carry as much as what it says: no SSN, no date
// of birth, no address, and nothing they typed let through as markup.
//
//   npx tsx scripts/tradeline-order-email-checks.ts

import { tradelineOrderEmail } from '../src/lib/emails/tradeline-order';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) pass++;
  else {
    fail++;
    console.error('FAIL:', name, extra === undefined ? '' : extra);
  }
}

const message = tradelineOrderEmail({
  to: 'jordan@example.com',
  name: 'Jordan <b>Testcase</b>',
  orderNumber: 'LGF-204871',
  items: [
    { name: 'Capital One/Cabelas', quantity: 2, lineTotal: 2200 },
    { name: 'Citi <script>', quantity: 1, lineTotal: 1250.5 },
  ],
  total: 3450.5,
});
const both = `${message.subject}\n${message.text}\n${message.html ?? ''}`;

check('it goes to the customer', message.to === 'jordan@example.com');
check('the subject carries the order number', message.subject.includes('LGF-204871'));
check('it greets them by first name', message.text.includes('Hi Jordan,'));
check('it lists what they ordered, in both parts', ['Capital One/Cabelas', '$2,200.00', '$1,250.50'].every((part) => message.text.includes(part) && (message.html ?? '').includes(part)));
check('with the months each is for', message.text.includes('6 months') && message.text.includes('3 months'));
check('and the total', message.text.includes('$3,450.50') && (message.html ?? '').includes('$3,450.50'));
check('it says the order is not paid for yet', /awaiting payment/i.test(message.text));
check('it says how to reach us', message.text.includes('+1 (518) 671-8758'));
check('nothing they typed is let through as markup', !(message.html ?? '').includes('<b>Testcase') && !(message.html ?? '').includes('<script>'));
check('it has a text part and an html part', message.text.length > 100 && (message.html ?? '').length > 100);
const greet = (name: string) => tradelineOrderEmail({ to: 'x@example.com', name, orderNumber: 'LGF-204871', items: [], total: 0 }).text.split('\n')[0];
check('a name that is really a web address is not greeted by it', greet('www.evil-site.com Smith') === 'Hi there,', greet('www.evil-site.com Smith'));
check('nor is a very long one', greet(`${'a'.repeat(40)} Smith`) === 'Hi there,');
check('an ordinary name with a hyphen or an apostrophe still is', greet("Mary-Jane O'Neil") === 'Hi Mary-Jane,' && greet("D'Arcy Example") === "Hi D'Arcy,");
check('no em or en dash anywhere', !/[–—]/.test(both));

console.log(`\ntradeline-order-email: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
