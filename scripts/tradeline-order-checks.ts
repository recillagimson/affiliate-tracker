// What a tradelines order has to be before it is taken.
//
// The checkout is a public form that collects an SSN and commits somebody to a
// price, so what is pinned is that nothing malformed gets as far as being
// saved, that the price is always the stock list's and never the request's,
// and that the commission is the fixed amount per line for somebody who earns
// and nought for anybody else. The table of good and bad details is shared
// with the storefront (scripts/fixtures/checkout-examples.json), which checks
// its own copy of these rules against the same table.
//
//   npx tsx scripts/tradeline-order-checks.ts

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  customerProblems,
  MAX_ORDER_LINES,
  priceOrder,
  readOrderRequest,
  tidyCustomer,
  totalsAgree,
  TRADELINE_COMMISSION,
  US_STATES,
  type OrderCustomer,
} from '../src/lib/tradeline-order';
import type { PublicTradeline } from '../src/lib/tradelines-public';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) pass++;
  else {
    fail++;
    console.error('FAIL:', name, extra === undefined ? '' : extra);
  }
}

type Example = { field: keyof OrderCustomer; value: string };
const FIXTURE = join(__dirname, 'fixtures', 'checkout-examples.json');
const examples = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
  today: string;
  good: OrderCustomer;
  alsoGood: Example[];
  bad: Example[];
};
const TODAY = examples.today;
const said: string[] = [];

console.log('- the customer -');
check('good details have nothing wrong', Object.keys(customerProblems(examples.good, TODAY)).length === 0, customerProblems(examples.good, TODAY));
for (const { field, value } of examples.alsoGood) {
  const problems = customerProblems({ ...examples.good, [field]: value }, TODAY);
  check(`${field} "${value}" is accepted`, Object.keys(problems).length === 0, problems);
}
for (const { field, value } of examples.bad) {
  const problems = customerProblems({ ...examples.good, [field]: value }, TODAY);
  check(`${field} "${value}" is refused, and only that field`, Object.keys(problems).join() === field, problems);
  if (problems[field]) said.push(problems[field]!);
}
check('there are fifty states and DC', US_STATES.length === 51 && US_STATES.includes('DC') && new Set(US_STATES).size === 51);

console.log('- tidied before it is stored -');
const tidy = tidyCustomer({
  ...examples.good,
  name: '  Jordan   Testcase ',
  email: 'Jordan@Example.COM',
  mobile: '1-518-555-0142',
  ssn: '123 45 6789',
  state: 'ny',
  line2: '  Apt 4 ',
});
check('the name loses its spare spaces', tidy.name === 'Jordan Testcase');
check('the email is lower case', tidy.email === 'jordan@example.com');
check('the mobile is ten digits', tidy.mobile === '5185550142');
check('the SSN is nine digits', tidy.ssn === '123456789');
check('the state is upper case', tidy.state === 'NY');
check('the second line is trimmed', tidy.line2 === 'Apt 4');

console.log('- reading a request -');
const body = (over: Record<string, unknown> = {}) => ({
  ref: 'TL-48213',
  items: [{ id: '64', quantity: 2 }],
  expectedTotal: 2200,
  customer: {
    name: examples.good.name,
    email: examples.good.email,
    mobile: examples.good.mobile,
    dob: examples.good.dob,
    ssn: examples.good.ssn,
    address: { line1: examples.good.line1, line2: '', city: examples.good.city, state: 'NY', zip: '12207' },
  },
  confirmed: true,
  company: '',
  ...over,
});
const read = readOrderRequest(body(), TODAY);
check('a good request is read', read.ok, read);
check('with the customer tidied', read.ok && read.request.customer.mobile === '5185550142' && read.request.customer.ssn === '123456789');
check('and the lines', read.ok && read.request.items.length === 1 && read.request.items[0]?.id === '64' && read.request.items[0]?.quantity === 2);
check('and the reference number', read.ok && read.request.ref === 'TL-48213' && !read.request.trap);
const loose = readOrderRequest(body({ ref: ' tl-48213 ' }), TODAY);
check('a loosely typed reference number is tidied', loose.ok && loose.request.ref === 'TL-48213');
const noRef = readOrderRequest(body({ ref: 'nonsense' }), TODAY);
check('one that is not a number is dropped, not refused', noRef.ok && noRef.request.ref === '');
const missingRef = readOrderRequest(body({ ref: undefined }), TODAY);
check('no reference number is fine', missingRef.ok && missingRef.request.ref === '');
const numericId = readOrderRequest(body({ items: [{ id: 64, quantity: 1 }] }), TODAY);
check('a numeric id is read as text', numericId.ok && numericId.request.items[0]?.id === '64');
const trapped = readOrderRequest(body({ company: 'Acme' }), TODAY);
check('the hidden field being filled is noticed', trapped.ok && trapped.request.trap);

const refused = (over: Record<string, unknown>, field: string, name: string) => {
  const result = readOrderRequest(body(over), TODAY);
  check(name, !result.ok && field in result.fields, result);
  if (!result.ok && result.fields[field]) said.push(result.fields[field]!);
};
refused({ confirmed: false }, 'confirmed', 'not confirmed is refused');
refused({ confirmed: 'yes' }, 'confirmed', 'confirmed must be true itself');
refused({ items: [] }, 'items', 'an empty cart is refused');
refused({ items: 'cart' }, 'items', 'a cart that is not a list is refused');
refused({ items: [{ id: '64', quantity: 0 }] }, 'items', 'a quantity of nought is refused');
refused({ items: [{ id: '64', quantity: 13 }] }, 'items', 'a quantity past twelve is refused');
refused({ items: [{ id: '64', quantity: 1.5 }] }, 'items', 'a quantity that is not whole is refused');
refused({ items: [{ id: '', quantity: 1 }] }, 'items', 'a line with no id is refused');
refused({ items: [{ id: '64', quantity: 1 }, { id: '64', quantity: 2 }] }, 'items', 'the same tradeline twice is refused');
refused({ items: Array.from({ length: MAX_ORDER_LINES + 1 }, (_, i) => ({ id: String(i + 1), quantity: 1 })) }, 'items', 'more than twenty lines is refused');
refused({ expectedTotal: 'lots' }, 'items', 'a total that is not a number is refused');
refused({ customer: null }, 'name', 'no customer at all is refused');
const several = readOrderRequest(body({ customer: { name: '', email: 'x', address: {} } }), TODAY);
check('every wrong field is named at once', !several.ok && ['name', 'email', 'mobile', 'dob', 'ssn', 'line1', 'city', 'state', 'zip'].every((field) => field in several.fields), several);
for (const junk of [null, undefined, 'order', 42, []]) {
  check(`a body of ${JSON.stringify(junk)} is refused without a crash`, !readOrderRequest(junk, TODAY).ok);
}

console.log('- pricing it -');
const stock: PublicTradeline[] = [
  { id: '64', issuer: 'capital-one', name: 'Capital One/Cabelas', creditLimit: 500, openDate: '2014-05-22', age: '11.27', price: 1100 },
  { id: '70', issuer: 'citi', name: 'Citi Plus', creditLimit: 20000, openDate: '2020-02-24', age: null, price: 1250.1 },
];
const priced = priceOrder([{ id: '64', quantity: 2 }, { id: '70', quantity: 3 }], stock, true);
check('each line is priced from the stock list', priced.ok && priced.items[0]?.unitPrice === 1100 && priced.items[0]?.lineTotal === 2200 && priced.items[1]?.lineTotal === 3750.3, priced);
check('the total is the sum, to the cent', priced.ok && priced.total === 5950.3, priced);
check('each line keeps a copy of the tradeline', priced.ok && priced.items[0]?.name === 'Capital One/Cabelas' && priced.items[0]?.issuer === 'capital-one' && priced.items[0]?.creditLimit === 500 && priced.items[0]?.openDate === '2014-05-22' && priced.items[0]?.age === '11.27' && priced.items[1]?.age === null);
check('commission is the fixed amount on every line', TRADELINE_COMMISSION === 200 && priced.ok && priced.items.every((item) => item.commission === 200));
check('and is not multiplied by quantity', priced.ok && priced.items[1]?.quantity === 3 && priced.items[1]?.commission === 200);
const house = priceOrder([{ id: '64', quantity: 2 }], stock, false);
check('a sale nobody earns on carries none', house.ok && house.items[0]?.commission === 0 && house.total === 2200);
const gone = priceOrder([{ id: '64', quantity: 1 }, { id: '999', quantity: 1 }, { id: 'x', quantity: 1 }], stock, true);
check('a tradeline no longer on offer stops the order, and is named', !gone.ok && gone.gone.join() === '999,x', gone);
check('the total a customer saw is compared to the cent', totalsAgree(5950.3, 5950.3) && totalsAgree(2200, 2200.0) && !totalsAgree(2200, 2200.01) && !totalsAgree(1100, 2200));
check('a total that is not a number never agrees', !totalsAgree(Number.NaN, 2200));

console.log('- the storefront has the same examples -');
const SITE_COPY = join(__dirname, '..', '..', '..', 'Tradeline-LGF', 'src', 'lib', 'checkout-examples.json');
if (existsSync(SITE_COPY)) {
  check('the storefront copy of the examples is this one', readFileSync(SITE_COPY, 'utf8').trim() === readFileSync(FIXTURE, 'utf8').trim());
} else {
  console.log('  (storefront not beside this repository; skipped)');
}

check('there was something to read', said.length >= 20, said.length);
check('no em or en dash anywhere', said.every((text) => !/[–—]/.test(text)));

console.log(`\ntradeline-order: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
