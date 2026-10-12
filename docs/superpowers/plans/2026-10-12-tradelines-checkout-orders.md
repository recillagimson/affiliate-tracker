# Tradelines Checkout and Orders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A customer can place a tradelines order from the storefront; it is recorded in the tracker against the affiliate who sent them, with the SSN and date of birth sealed; the owner can see, pay and cancel orders; the affiliate sees what they have earned.

**Architecture:** The storefront posts the cart, the customer's details and the saved reference number to one public tracker endpoint. The tracker validates, re-prices from the live stock list, seals the SSN and date of birth with the existing `secret-box`, and saves the order and a copy of each line in one transaction through a Postgres function. Commission is fixed per line at order time and counts once an admin marks the order paid. All rules live in pure modules with checks; routes and pages are thin.

**Tech Stack:** Tracker: Next 15, TypeScript, Supabase (Postgres + PostgREST), `tsx` check scripts, Resend. Storefront: Vite 5, React 18, `react-router-dom` 6, `vitest`.

**Spec:** `docs/superpowers/specs/2026-10-12-tradelines-checkout-orders-design.md`

**Two repositories.** Paths are prefixed:

- `TRACKER/` = `/Users/gimson/Desktop/Development Projects/affiliate-tracker/affiliate-tracker` (branch `feat/tradelines`)
- `SITE/` = `/Users/gimson/Desktop/Development Projects/Tradeline-LGF` (branch `main`, no remote)

## Global Constraints

- Commission is `200` dollars per order line, fixed at order time, `0` for a house sale or an LGF employee. Quantity does not multiply it. It counts as income only while the order's status is `paid`.
- An SSN or date of birth is never stored unsealed, never logged, never sent to an affiliate's page, never put in an email, never written to browser storage. If `secretsConfigured()` is false the checkout refuses orders.
- Prices in a request are never used. Every line is priced from the live stock list (`publicInventory(await listTradelines())`).
- An order keeps a copy of each tradeline bought. Nothing references `tradelines.id`.
- Order statuses are exactly `awaiting_payment`, `paid`, `cancelled`. A cancelled order is never reopened.
- Order numbers match `^LGF-[0-9]{6}$`. Reference numbers match `^TL-[0-9]{5}$`.
- Quantity is a whole number from 1 to 12. An order has 1 to 20 lines.
- No em dash or en dash in any text a person reads, in either repository.
- Tracker comments follow the plain-sentence header style of `TRACKER/src/lib/*.ts`.
- Commits are local only. Never push. No `Co-Authored-By` or "Generated with" lines.
- `TRACKER/.env.local` points at the LIVE database. Only Task 9 writes to it, with obviously fake customer details, and only after the owner has run the migration. Never run a migration yourself.
- Tracker dev server: `npm run dev -- -p 3001`. Storefront: `npm run dev -- --port 5173 --strictPort`.
- Four tracker check scripts fail before this work and are not part of it: `payout-api-checks`, `payout-request-store-checks`, `payslip-view-checks`, `updates-checks`.

## Review Focus

1. **A customer who presses Place order twice, or whose first request succeeded but whose connection dropped before the answer**: one order, not two, or at the least the page must not invite a second. Pinned in Task 8 (button disabled while sending; form kept on failure).
2. **A cart that changed under the customer** (price edited or sheet re-pasted between adding and paying): the order is refused with what changed, never saved at a price they did not see, never a blank page. Pinned in Tasks 1 and 8.
3. **Loosely typed personal details** (`(518) 555-0142`, `123 45 6789`, `ny`, a ZIP+4, a name with double spaces, an email in capitals): accepted and stored tidy. Pinned in Tasks 1 and 7.
4. **An order placed with a reference number that is real but no longer earns** (affiliate disabled, taken off Tradelines, made an LGF employee, or an admin): the sale is still taken; nobody is credited or the commission is nought; nothing errors. Pinned in Task 4.
5. **A database that has not had the migration yet**: the affiliate dashboard and Tradelines page still load (noughts), the Orders page says which migration to run, and the checkout says it is not available. No page crashes. Pinned in Tasks 3, 5 and 6.

---

## File Structure

Tracker:

| File | Responsibility |
|---|---|
| `scripts/fixtures/checkout-examples.json` (new) | The shared table of good and bad customer details. |
| `src/lib/tradeline-order.ts` (new) | Field rules, reading a request, pricing, commission. Pure. |
| `supabase/migrations/20261014120000_tradeline_orders.sql` (new) | Tables, order-number trigger, `place_tradeline_order`. |
| `src/lib/tradeline-order-store.ts` (new) | Place, list, read, pay, cancel, reveal; find the affiliate for a reference number. |
| `src/lib/emails/tradeline-order.ts` (new) | The customer's confirmation. Pure. |
| `src/app/api/public/tradeline-orders/route.ts` (new) | The public door. |
| `src/lib/tradeline-sales.ts` (rewrite) | An affiliate's summary and rows, from their orders. |
| `src/components/TradelinesSummary.tsx` (modify) | `TradelineCheckouts` lists real rows. |
| `src/app/api/tradeline-orders/route.ts` (new) | Admin actions. |
| `src/components/TradelineOrders.tsx` (new) | Admin list, detail pieces, actions, secrets. |
| `src/app/(admin)/tradelines/orders/page.tsx`, `orders/[orderNumber]/page.tsx` (new) | Admin pages. |

Storefront:

| File | Responsibility |
|---|---|
| `src/lib/checkout-examples.json` (new) | A copy of the tracker's fixture. |
| `src/lib/checkout.ts` (new) | The same field rules; the request body; reading the answer; sending it. |
| `src/pages/CheckoutPage.tsx`, `CheckoutDonePage.tsx` (new) | The two pages. |
| `src/state/cart.tsx`, `src/pages/CartPage.tsx`, `src/App.tsx`, `src/styles/global.css` (modify) | `clear()`, the Checkout button, routes, form styles. |

---

### Task 1: Order rules (tracker)

**Files:**
- Create: `TRACKER/scripts/fixtures/checkout-examples.json`, `TRACKER/src/lib/tradeline-order.ts`
- Test: `TRACKER/scripts/tradeline-order-checks.ts`

**Interfaces:**
- Consumes: `PublicTradeline` from `TRACKER/src/lib/tradelines-public.ts` (`{ id, issuer, name, creditLimit, openDate, age, price }`); `isTradelineRef` from `TRACKER/src/lib/tradeline-ref.ts`.
- Produces:
  - `TRADELINE_COMMISSION = 200`, `MAX_ORDER_LINES = 20`, `US_STATES: readonly string[]` (51)
  - `type OrderCustomer = { name: string; email: string; mobile: string; dob: string; ssn: string; line1: string; line2: string; city: string; state: string; zip: string }`
  - `type OrderLine = { id: string; quantity: number }`
  - `type OrderRequest = { ref: string; items: OrderLine[]; expectedTotal: number; customer: OrderCustomer; trap: boolean }`
  - `type FieldErrors = Record<string, string>`
  - `customerProblems(customer: OrderCustomer, today: string): FieldErrors`
  - `tidyCustomer(customer: OrderCustomer): OrderCustomer`
  - `readOrderRequest(body: unknown, today: string): { ok: true; request: OrderRequest } | { ok: false; fields: FieldErrors }`
  - `type PricedItem = { issuer: string; name: string; creditLimit: number; openDate: string; age: string | null; unitPrice: number; quantity: number; lineTotal: number; commission: number }`
  - `priceOrder(lines: OrderLine[], stock: readonly PublicTradeline[], earns: boolean): { ok: true; items: PricedItem[]; total: number } | { ok: false; gone: string[] }`
  - `totalsAgree(expected: number, total: number): boolean`

- [ ] **Step 1: The shared examples**

Create `TRACKER/scripts/fixtures/checkout-examples.json`:

```json
{
  "today": "2026-10-12",
  "good": {
    "name": "Jordan Testcase",
    "email": "jordan@example.com",
    "mobile": "(518) 555-0142",
    "dob": "1990-04-10",
    "ssn": "123-45-6789",
    "line1": "12 Sample Street",
    "line2": "",
    "city": "Albany",
    "state": "NY",
    "zip": "12207"
  },
  "alsoGood": [
    { "field": "mobile", "value": "1-518-555-0142" },
    { "field": "mobile", "value": "5185550142" },
    { "field": "ssn", "value": "123 45 6789" },
    { "field": "ssn", "value": "123456789" },
    { "field": "zip", "value": "12207-1234" },
    { "field": "state", "value": "ny" },
    { "field": "dob", "value": "2008-10-12" },
    { "field": "line2", "value": "Apt 4" },
    { "field": "email", "value": "Jordan@Example.COM" },
    { "field": "name", "value": "  Jordan   Testcase " }
  ],
  "bad": [
    { "field": "name", "value": "" },
    { "field": "name", "value": "J" },
    { "field": "email", "value": "" },
    { "field": "email", "value": "jordan" },
    { "field": "email", "value": "jordan@" },
    { "field": "email", "value": "jordan @example.com" },
    { "field": "mobile", "value": "" },
    { "field": "mobile", "value": "555-0142" },
    { "field": "mobile", "value": "2-518-555-0142" },
    { "field": "dob", "value": "" },
    { "field": "dob", "value": "1990-02-30" },
    { "field": "dob", "value": "10/04/1990" },
    { "field": "dob", "value": "2008-10-13" },
    { "field": "dob", "value": "1900-01-01" },
    { "field": "dob", "value": "2030-01-01" },
    { "field": "ssn", "value": "" },
    { "field": "ssn", "value": "123-45-678" },
    { "field": "ssn", "value": "000-45-6789" },
    { "field": "ssn", "value": "666-45-6789" },
    { "field": "ssn", "value": "900-45-6789" },
    { "field": "ssn", "value": "123-00-6789" },
    { "field": "ssn", "value": "123-45-0000" },
    { "field": "ssn", "value": "111-11-1111" },
    { "field": "line1", "value": "" },
    { "field": "line1", "value": "12" },
    { "field": "city", "value": "" },
    { "field": "city", "value": "A" },
    { "field": "state", "value": "" },
    { "field": "state", "value": "ZZ" },
    { "field": "state", "value": "New York" },
    { "field": "zip", "value": "" },
    { "field": "zip", "value": "1220" },
    { "field": "zip", "value": "12207-12" },
    { "field": "zip", "value": "ABCDE" }
  ]
}
```

- [ ] **Step 2: Write the failing check**

Create `TRACKER/scripts/tradeline-order-checks.ts`:

```ts
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
```

- [ ] **Step 3: Run it to see it fail**

Run (in `TRACKER/`): `npx tsx scripts/tradeline-order-checks.ts`
Expected: `Cannot find module '../src/lib/tradeline-order'`

- [ ] **Step 4: Write the module**

Create `TRACKER/src/lib/tradeline-order.ts`:

```ts
/**
 * What a tradelines order has to be before it is taken.
 *
 * The storefront's checkout posts a cart, the customer's details and the
 * affiliate reference number they arrived with. Everything about that request
 * is decided here: whether the details are ones somebody could really have,
 * what the order comes to, and what the affiliate earns.
 *
 * Three rules do most of the work.
 *
 * The price is the stock list's. A request says which tradelines and how
 * many, and what total the customer was shown; it does not get to say what
 * anything costs. If the total it was shown is not the total today, the order
 * is refused and the customer is told, so nobody is recorded at a price they
 * did not see.
 *
 * An order keeps a copy of what was bought. A tradeline's own row can be gone
 * tomorrow, when a new sheet is pasted in, and the order must still say what
 * it was for.
 *
 * Commission is a fixed amount for each line, whatever the quantity, decided
 * when the order is placed and kept with it. A sale with no affiliate behind
 * it, or one whose affiliate does not earn, carries none.
 *
 * Pure. scripts/tradeline-order-checks.ts pins it, against a table of
 * examples the storefront checks its own copy of these rules against too.
 */

import { isTradelineRef } from './tradeline-ref';
import type { PublicTradeline } from './tradelines-public';

/** What an affiliate earns on each line of an order, in dollars. */
export const TRADELINE_COMMISSION = 200;
export const MAX_ORDER_LINES = 20;
const MIN_QUANTITY = 1;
const MAX_QUANTITY = 12;
const MIN_AGE = 18;
const MAX_AGE = 120;

export const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS',
  'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC',
  'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
] as const;

export type OrderCustomer = {
  name: string;
  email: string;
  mobile: string;
  /** YYYY-MM-DD. */
  dob: string;
  ssn: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  zip: string;
};

export type OrderLine = { id: string; quantity: number };

export type OrderRequest = {
  /** The affiliate reference number, tidied, or '' for none. */
  ref: string;
  items: OrderLine[];
  /** The total the customer was shown. */
  expectedTotal: number;
  customer: OrderCustomer;
  /** The field no person sees was filled in: this is not a person. */
  trap: boolean;
};

export type FieldErrors = Record<string, string>;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function digitsOf(value: string): string {
  return value.replace(/\D+/g, '');
}

/** Ten digits, from a number written any of the usual ways. '' if it is not one. */
function mobileDigits(value: string): string {
  const digits = digitsOf(value);
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return '';
}

/** How old somebody born on `dob` is on `today`. Null if `dob` is not a real date. */
function ageOn(dob: string, today: string): number | null {
  const born = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob);
  const now = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today);
  if (!born || !now) return null;
  const [year, month, day] = [Number(born[1]), Number(born[2]), Number(born[3])];
  const real = new Date(Date.UTC(year, month - 1, day));
  if (real.getUTCFullYear() !== year || real.getUTCMonth() !== month - 1 || real.getUTCDate() !== day) return null;
  const hadBirthday = Number(now[2]) > month || (Number(now[2]) === month && Number(now[3]) >= day);
  return Number(now[1]) - year - (hadBirthday ? 0 : 1);
}

function ssnProblem(value: string): string {
  if (value.trim() === '') return 'Enter your Social Security number.';
  if (!/^[0-9 -]+$/.test(value.trim())) return 'A Social Security number is nine digits.';
  const digits = digitsOf(value);
  if (digits.length !== 9) return 'A Social Security number is nine digits.';
  const [area, group, serial] = [digits.slice(0, 3), digits.slice(3, 5), digits.slice(5)];
  const impossible =
    area === '000' || area === '666' || area.startsWith('9') || group === '00' || serial === '0000' || /^(\d)\1{8}$/.test(digits);
  return impossible ? 'That is not a Social Security number that can exist. Check it and type it again.' : '';
}

/** What is wrong with a customer's details, by field. Empty when nothing is. */
export function customerProblems(customer: OrderCustomer, today: string): FieldErrors {
  const out: FieldErrors = {};
  const say = (field: keyof OrderCustomer, problem: string) => {
    if (problem) out[field] = problem;
  };

  const name = text(customer.name).replace(/\s+/g, ' ');
  say('name', name.length < 2 ? 'Enter your full name.' : name.length > 120 ? 'That name is too long.' : '');

  const email = text(customer.email);
  say(
    'email',
    email === ''
      ? 'Enter your email address.'
      : email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
        ? 'That does not look like an email address.'
        : '',
  );

  say(
    'mobile',
    text(customer.mobile) === ''
      ? 'Enter your mobile number.'
      : mobileDigits(customer.mobile) === ''
        ? 'Enter a ten digit US mobile number.'
        : '',
  );

  const dob = text(customer.dob);
  const age = ageOn(dob, today);
  say(
    'dob',
    dob === ''
      ? 'Enter your date of birth.'
      : age === null
        ? 'That is not a date. Enter it as year, month and day.'
        : age < 0
          ? 'A date of birth cannot be in the future.'
          : age < MIN_AGE
            ? 'You must be 18 or older to order.'
            : age > MAX_AGE
              ? 'Check the year of that date of birth.'
              : '',
  );

  say('ssn', ssnProblem(typeof customer.ssn === 'string' ? customer.ssn : ''));

  const line1 = text(customer.line1);
  say('line1', line1.length < 3 ? 'Enter your street address.' : line1.length > 120 ? 'That address is too long.' : '');
  say('line2', text(customer.line2).length > 120 ? 'That line is too long.' : '');

  const city = text(customer.city);
  say('city', city.length < 2 ? 'Enter your city.' : city.length > 80 ? 'That city name is too long.' : '');

  const state = text(customer.state).toUpperCase();
  say('state', state === '' ? 'Choose your state.' : (US_STATES as readonly string[]).includes(state) ? '' : 'Choose a US state.');

  const zip = text(customer.zip);
  say('zip', zip === '' ? 'Enter your ZIP code.' : /^[0-9]{5}(-[0-9]{4})?$/.test(zip) ? '' : 'A ZIP code is five digits.');

  return out;
}

/** The details as they are stored: trimmed, and each number in one form. Only for details with nothing wrong. */
export function tidyCustomer(customer: OrderCustomer): OrderCustomer {
  return {
    name: text(customer.name).replace(/\s+/g, ' '),
    email: text(customer.email).toLowerCase(),
    mobile: mobileDigits(customer.mobile),
    dob: text(customer.dob),
    ssn: digitsOf(customer.ssn),
    line1: text(customer.line1),
    line2: text(customer.line2),
    city: text(customer.city),
    state: text(customer.state).toUpperCase(),
    zip: text(customer.zip),
  };
}

const CART_UNREADABLE = 'Your cart could not be read. Go back to it and try again.';

function readLines(value: unknown): OrderLine[] | string {
  if (!Array.isArray(value) || value.length === 0) return 'Your cart is empty.';
  if (value.length > MAX_ORDER_LINES) return `An order can hold up to ${MAX_ORDER_LINES} tradelines. Remove some and try again.`;
  const lines: OrderLine[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return CART_UNREADABLE;
    const { id, quantity } = entry as { id?: unknown; quantity?: unknown };
    const key = typeof id === 'number' && Number.isFinite(id) ? String(id) : text(id);
    if (!key || key.length > 40) return CART_UNREADABLE;
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < MIN_QUANTITY || quantity > MAX_QUANTITY) {
      return 'A quantity is a whole number from 1 to 12.';
    }
    if (lines.some((line) => line.id === key)) return CART_UNREADABLE;
    lines.push({ id: key, quantity });
  }
  return lines;
}

/** A posted order, read and checked. Never throws, whatever it is handed. */
export function readOrderRequest(
  body: unknown,
  today: string,
): { ok: true; request: OrderRequest } | { ok: false; fields: FieldErrors } {
  const root = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const given = typeof root.customer === 'object' && root.customer !== null ? (root.customer as Record<string, unknown>) : {};
  const address = typeof given.address === 'object' && given.address !== null ? (given.address as Record<string, unknown>) : {};
  const raw = (value: unknown) => (typeof value === 'string' ? value : '');

  const customer: OrderCustomer = {
    name: raw(given.name),
    email: raw(given.email),
    mobile: raw(given.mobile),
    dob: raw(given.dob),
    ssn: raw(given.ssn),
    line1: raw(address.line1),
    line2: raw(address.line2),
    city: raw(address.city),
    state: raw(address.state),
    zip: raw(address.zip),
  };

  const fields = customerProblems(customer, today);
  const lines = readLines(root.items);
  if (typeof lines === 'string') fields.items = lines;
  const expectedTotal = root.expectedTotal;
  if (typeof expectedTotal !== 'number' || !Number.isFinite(expectedTotal) || expectedTotal < 0) {
    fields.items ??= CART_UNREADABLE;
  }
  if (root.confirmed !== true) fields.confirmed = 'Tick the box to confirm your details are correct.';

  if (Object.keys(fields).length > 0 || typeof lines === 'string') return { ok: false, fields };

  const ref = text(root.ref).toUpperCase();
  return {
    ok: true,
    request: {
      ref: isTradelineRef(ref) ? ref : '',
      items: lines,
      expectedTotal: expectedTotal as number,
      customer: tidyCustomer(customer),
      trap: text(root.company) !== '',
    },
  };
}

export type PricedItem = {
  issuer: string;
  name: string;
  creditLimit: number;
  openDate: string;
  age: string | null;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
  commission: number;
};

function cents(amount: number): number {
  return Number.isFinite(amount) ? Math.round(amount * 100) : Number.NaN;
}

/**
 * The lines of an order against the stock list: what each is, and what it
 * comes to. A line that is not on offer stops the whole order and is named,
 * since an order for less than was asked for is not what was asked for.
 *
 * `earns` is whether there is an affiliate behind the sale who is paid
 * commission. The route decides that; this only applies it.
 */
export function priceOrder(
  lines: OrderLine[],
  stock: readonly PublicTradeline[],
  earns: boolean,
): { ok: true; items: PricedItem[]; total: number } | { ok: false; gone: string[] } {
  const gone = lines.filter((line) => !stock.some((row) => row.id === line.id)).map((line) => line.id);
  if (gone.length > 0) return { ok: false, gone };

  let total = 0;
  const items = lines.map((line) => {
    const row = stock.find((candidate) => candidate.id === line.id)!;
    const lineCents = cents(row.price) * line.quantity;
    total += lineCents;
    return {
      issuer: row.issuer,
      name: row.name,
      creditLimit: row.creditLimit,
      openDate: row.openDate,
      age: row.age,
      unitPrice: row.price,
      quantity: line.quantity,
      lineTotal: lineCents / 100,
      commission: earns ? TRADELINE_COMMISSION : 0,
    };
  });
  return { ok: true, items, total: total / 100 };
}

/** Whether the total a customer was shown is the total today, to the cent. */
export function totalsAgree(expected: number, total: number): boolean {
  return Number.isFinite(expected) && Number.isFinite(total) && cents(expected) === cents(total);
}
```

- [ ] **Step 5: Run it to see it pass**

Run: `npx tsx scripts/tradeline-order-checks.ts`
Expected: last line `tradeline-order: <n> passed, 0 failed` (the storefront-copy check prints "skipped" or is absent until Task 7 creates the copy; it must pass after Task 7).

- [ ] **Step 6: Commit**

```bash
git add scripts/fixtures/checkout-examples.json scripts/tradeline-order-checks.ts src/lib/tradeline-order.ts
git commit -m "feat(tradelines): what an order has to be before it is taken"
```

---

### Task 2: The order tables (tracker)

**Files:**
- Create: `TRACKER/supabase/migrations/20261014120000_tradeline_orders.sql`
- Test: `TRACKER/scripts/tradeline-orders-migration-checks.ts`

**Interfaces:**
- Produces (for Task 3):
  - Tables `public.tradeline_orders`, `public.tradeline_order_items`, `public.tradeline_ssn_reveals` with the columns below.
  - `public.place_tradeline_order(p_order jsonb, p_items jsonb) returns text` (the order number). `p_order` keys: `customer_name, customer_email, customer_mobile, address_line1, address_line2, city, state, zip, ssn_encrypted, ssn_last4, dob_encrypted, tradeline_ref, affiliate_user_id` (text or null). `p_items` is an array of `{issuer, name, credit_limit, open_date, age_years (text or null), unit_price, quantity, line_total, commission}`.
  - Error code `LG001` for unreadable rows.

- [ ] **Step 1: Write the failing check**

Create `TRACKER/scripts/tradeline-orders-migration-checks.ts`:

```ts
// The tradeline orders migration.
//
// Nothing here runs it. This reads the file and pins what the app and the
// payout build after it depend on: the three statuses and that their dates
// agree with them, that an order's lines go in with it or not at all, that
// the sealed columns cannot be empty, and that nobody but the server can read
// any of it.
//
//   npx tsx scripts/tradeline-orders-migration-checks.ts

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) pass++;
  else {
    fail++;
    console.error('FAIL:', name, extra === undefined ? '' : extra);
  }
}

const FILE = join(__dirname, '..', 'supabase', 'migrations', '20261014120000_tradeline_orders.sql');
check('it exists under its name', existsSync(FILE));
const sql = existsSync(FILE) ? readFileSync(FILE, 'utf8') : '';
const has = (pattern: RegExp) => pattern.test(sql);

console.log('- the tables -');
for (const table of ['tradeline_orders', 'tradeline_order_items', 'tradeline_ssn_reveals']) {
  check(`${table} is created, and only if it is not there`, has(new RegExp(`create table if not exists public\\.${table} \\(`)));
  check(`${table} is closed to everybody but the server`, has(new RegExp(`alter table public\\.${table} enable row level security`)) && has(new RegExp(`revoke all on public\\.${table} from anon, authenticated`)));
}

console.log('- an order -');
check('has the three statuses', has(/status in \('awaiting_payment', 'paid', 'cancelled'\)/));
check('starts awaiting payment', has(/status text not null default 'awaiting_payment'/));
check('awaiting payment has neither date', has(/status = 'awaiting_payment' and paid_at is null and cancelled_at is null/));
check('paid has its date and is not cancelled', has(/status = 'paid' and paid_at is not null and cancelled_at is null/));
check('cancelled has its date', has(/status = 'cancelled' and cancelled_at is not null/));
check('the sealed SSN and date of birth cannot be empty', has(/ssn_encrypted <> ''/) && has(/dob_encrypted <> ''/));
check('only the last four of the SSN are kept readable', has(/ssn_last4 ~ '\^\[0-9\]\{4\}\$'/) && !/\bssn text\b/.test(sql) && !/\bdob date\b/.test(sql));
check('the total is more than nought', has(/total > 0/));
check('the order number has its shape and is nobody else\'s', has(/order_number ~ '\^LGF-\[0-9\]\{6\}\$'/) && has(/create unique index if not exists tradeline_orders_number_key\s+on public\.tradeline_orders \(order_number\)/));
check('it is drawn at random, six digits never starting with a nought', has(/100000 \+ floor\(random\(\) \* 900000\)/));
check('an affiliate with orders cannot be deleted from under them', has(/affiliate_user_id text references public\.users \(id\) on delete restrict/));

console.log('- its lines -');
check('go when the order goes', has(/order_id bigint not null references public\.tradeline_orders \(id\) on delete cascade/));
check('carry a quantity from 1 to 12', has(/quantity between 1 and 12/));
check('carry a commission that is not negative', has(/commission >= 0/));
check('are a copy: nothing points at the tradelines table', !/references public\.tradelines\b/.test(sql));

console.log('- placing one -');
check('is one function, so the order and its lines are one transaction', has(/create or replace function public\.place_tradeline_order\(\s*p_order jsonb,\s*p_items jsonb\s*\)\s*returns text/));
check('refuses an order with no lines', has(/LG001/));
check('works the total out itself', has(/sum\(line_total\)/));
check('only the server may call it', has(/revoke all on function public\.place_tradeline_order\(jsonb, jsonb\) from public, anon, authenticated/) && has(/grant execute on function public\.place_tradeline_order\(jsonb, jsonb\) to service_role/));
check('runs with no search path to be led astray by', (sql.match(/set search_path = ''/g) ?? []).length >= 2);

console.log('- running it twice -');
check('nothing is created unconditionally', !/create table public\./.test(sql) && !/create (unique )?index (?!if not exists)/.test(sql));
check('the trigger is replaced, not duplicated', has(/drop trigger if exists tradeline_orders_number_trigger on public\.tradeline_orders/));

console.log(`\ntradeline-orders-migration: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx tsx scripts/tradeline-orders-migration-checks.ts`
Expected: `FAIL: it exists under its name` and many more; exit 1.

- [ ] **Step 3: Write the migration**

Create `TRACKER/supabase/migrations/20261014120000_tradeline_orders.sql`:

```sql
-- ---------------------------------------------------------------------------
-- Tradeline orders: what customers have ordered from the storefront, who sent
-- them, and what that earns.
--
-- An order is placed from the storefront's checkout by somebody who is not
-- signed in. It arrives unpaid. An admin marks it paid once the money is in,
-- and that is the moment the affiliate behind it has earned their commission.
--
-- Three tables.
--
-- tradeline_orders is the order: the customer, where it stands, and the
-- affiliate credited with it (nobody, for a house sale). The customer's SSN
-- and date of birth are sealed by the application before they arrive
-- (AES-256-GCM, lib/secret-box, the same key as W-9s); only the SSN's last
-- four digits are kept readable. The plain numbers are never written here.
--
-- tradeline_order_items is what was bought, one row per tradeline, as a copy.
-- Deliberately not a reference to public.tradelines: pasting a new sheet
-- deletes and re-creates those rows, and an order has to keep saying what it
-- was for. Each row carries its commission, fixed when the order was placed,
-- so changing the rate later does not rewrite what was agreed. The row's id
-- is permanent, which is what a payout will point at.
--
-- tradeline_ssn_reveals records each time an admin reads an order's SSN and
-- date of birth back: who, and when.
--
-- Orders go in through place_tradeline_order, so an order and its lines are
-- one transaction and an order is never saved without them.
--
-- Same access model as every other table here: RLS on, no policies, revoked
-- from anon and authenticated. Only the server's service role reads or writes.
--
-- Needs 20261013120000_tradeline_ref to have been run. Run this before the
-- storefront's checkout is used; until then the checkout says it is not
-- available and every other page works as before.
--
-- Safe to run twice.
-- ---------------------------------------------------------------------------

create table if not exists public.tradeline_orders (
  id bigint generated always as identity primary key,
  -- What the customer is given: LGF- and six digits. Filled in by the trigger.
  order_number text not null default '',
  created_at timestamptz not null default now(),

  status text not null default 'awaiting_payment',
  paid_at timestamptz,
  paid_by text,
  cancelled_at timestamptz,
  cancelled_by text,

  customer_name text not null,
  customer_email text not null,
  customer_mobile text not null,
  address_line1 text not null,
  address_line2 text not null default '',
  city text not null,
  state text not null,
  zip text not null,

  ssn_encrypted text not null,
  ssn_last4 text not null,
  dob_encrypted text not null,

  -- The reference number the order arrived with, as given, for the record.
  tradeline_ref text not null default '',
  -- Who is credited. Null for a house sale. Refuses rather than cascades:
  -- deleting somebody must not make their sales look like nobody's.
  affiliate_user_id text references public.users (id) on delete restrict,

  total numeric(12, 2) not null,

  constraint tradeline_orders_status_check
    check (status in ('awaiting_payment', 'paid', 'cancelled')),
  -- The dates say the same thing the status does. A cancelled order that had
  -- been paid keeps its paid date, as history.
  constraint tradeline_orders_dates_check
    check (
      (status = 'awaiting_payment' and paid_at is null and cancelled_at is null)
      or (status = 'paid' and paid_at is not null and cancelled_at is null)
      or (status = 'cancelled' and cancelled_at is not null)
    ),
  constraint tradeline_orders_number_check
    check (order_number ~ '^LGF-[0-9]{6}$'),
  constraint tradeline_orders_sealed_check
    check (ssn_encrypted <> '' and dob_encrypted <> ''),
  constraint tradeline_orders_last4_check
    check (ssn_last4 ~ '^[0-9]{4}$'),
  constraint tradeline_orders_state_check
    check (state ~ '^[A-Z]{2}$'),
  constraint tradeline_orders_zip_check
    check (zip ~ '^[0-9]{5}(-[0-9]{4})?$'),
  constraint tradeline_orders_total_check
    check (total > 0)
);

comment on table public.tradeline_orders is
  'Orders from the tradelines storefront. ssn_encrypted and dob_encrypted are AES-256-GCM ciphertext; the plain SSN and date of birth are never written here.';

create unique index if not exists tradeline_orders_number_key
  on public.tradeline_orders (order_number);

-- Every order, newest first, for the admin list.
create index if not exists tradeline_orders_created_idx
  on public.tradeline_orders (created_at desc);

-- One affiliate's orders, for their dashboard.
create index if not exists tradeline_orders_affiliate_idx
  on public.tradeline_orders (affiliate_user_id, created_at desc)
  where affiliate_user_id is not null;

alter table public.tradeline_orders enable row level security;
revoke all on public.tradeline_orders from anon, authenticated;

-- ---------------------------------------------------------------------------
-- The order number, drawn at random the way reference numbers are, so that
-- one customer's number says nothing about how many orders there have been.
-- ---------------------------------------------------------------------------

create or replace function public.assign_tradeline_order_number()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  candidate text;
begin
  loop
    candidate := 'LGF-' || (100000 + floor(random() * 900000))::int::text;
    exit when not exists (select 1 from public.tradeline_orders where order_number = candidate);
  end loop;
  new.order_number := candidate;
  return new;
end;
$$;

revoke all on function public.assign_tradeline_order_number() from public, anon, authenticated;

drop trigger if exists tradeline_orders_number_trigger on public.tradeline_orders;
create trigger tradeline_orders_number_trigger
  before insert
  on public.tradeline_orders
  for each row
  execute function public.assign_tradeline_order_number();

-- ---------------------------------------------------------------------------
-- What was bought.
-- ---------------------------------------------------------------------------

create table if not exists public.tradeline_order_items (
  id bigint generated always as identity primary key,
  order_id bigint not null references public.tradeline_orders (id) on delete cascade,

  issuer text not null,
  name text not null,
  credit_limit numeric(12, 2) not null,
  open_date date not null,
  age_years numeric,

  unit_price numeric(12, 2) not null,
  quantity integer not null,
  line_total numeric(12, 2) not null,
  -- What the affiliate earns on this line once the order is paid. Nought for
  -- a house sale. Decided when the order was placed.
  commission numeric(12, 2) not null default 0,

  constraint tradeline_order_items_name_check check (char_length(name) between 1 and 120),
  constraint tradeline_order_items_price_check check (unit_price > 0 and line_total > 0),
  constraint tradeline_order_items_quantity_check check (quantity between 1 and 12),
  constraint tradeline_order_items_commission_check check (commission >= 0)
);

comment on table public.tradeline_order_items is
  'The tradelines in an order, copied at the time: an order does not depend on public.tradelines still holding the row.';

create index if not exists tradeline_order_items_order_idx
  on public.tradeline_order_items (order_id, id);

alter table public.tradeline_order_items enable row level security;
revoke all on public.tradeline_order_items from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Who read an SSN back, and when.
-- ---------------------------------------------------------------------------

create table if not exists public.tradeline_ssn_reveals (
  id bigint generated always as identity primary key,
  order_id bigint not null references public.tradeline_orders (id) on delete cascade,
  revealed_at timestamptz not null default now(),
  revealed_by text not null
);

create index if not exists tradeline_ssn_reveals_order_idx
  on public.tradeline_ssn_reveals (order_id, revealed_at desc);

alter table public.tradeline_ssn_reveals enable row level security;
revoke all on public.tradeline_ssn_reveals from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Placing an order: the order and its lines, or neither.
--
-- The app has already checked and priced everything; the tables' constraints
-- check again. The total is worked out here from the lines, so the order's
-- total cannot disagree with them.
-- ---------------------------------------------------------------------------

create or replace function public.place_tradeline_order(
  p_order jsonb,
  p_items jsonb
)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_total numeric(12, 2);
  v_id bigint;
  v_number text;
begin
  if p_order is null or jsonb_typeof(p_order) <> 'object'
     or p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'That order could not be read.' using errcode = 'LG001';
  end if;

  select sum(line_total)
    into v_total
    from jsonb_to_recordset(p_items) as item (line_total numeric);

  insert into public.tradeline_orders (
    customer_name, customer_email, customer_mobile,
    address_line1, address_line2, city, state, zip,
    ssn_encrypted, ssn_last4, dob_encrypted,
    tradeline_ref, affiliate_user_id, total
  )
  values (
    p_order ->> 'customer_name', p_order ->> 'customer_email', p_order ->> 'customer_mobile',
    p_order ->> 'address_line1', coalesce(p_order ->> 'address_line2', ''), p_order ->> 'city',
    p_order ->> 'state', p_order ->> 'zip',
    p_order ->> 'ssn_encrypted', p_order ->> 'ssn_last4', p_order ->> 'dob_encrypted',
    coalesce(p_order ->> 'tradeline_ref', ''), nullif(p_order ->> 'affiliate_user_id', ''), v_total
  )
  returning id, order_number into v_id, v_number;

  insert into public.tradeline_order_items (
    order_id, issuer, name, credit_limit, open_date, age_years,
    unit_price, quantity, line_total, commission
  )
  select v_id, item.issuer, item.name, item.credit_limit, item.open_date, item.age_years,
         item.unit_price, item.quantity, item.line_total, coalesce(item.commission, 0)
    from jsonb_to_recordset(p_items) as item (
      issuer text, name text, credit_limit numeric, open_date date, age_years numeric,
      unit_price numeric, quantity integer, line_total numeric, commission numeric
    );

  return v_number;
end;
$$;

revoke all on function public.place_tradeline_order(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.place_tradeline_order(jsonb, jsonb) to service_role;
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx tsx scripts/tradeline-orders-migration-checks.ts`
Expected: `tradeline-orders-migration: <n> passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20261014120000_tradeline_orders.sql scripts/tradeline-orders-migration-checks.ts
git commit -m "feat(tradelines): tables for orders, their lines and SSN reveals"
```

---

### Task 3: The order store (tracker)

**Files:**
- Create: `TRACKER/src/lib/tradeline-order-store.ts`

**Interfaces:**
- Consumes: `PricedItem`, `OrderCustomer` (Task 1); the tables and function (Task 2); `getSupabaseClient`, `isSupabaseConfigured` from `./store/supabase`; `StoreConfigError`, `StoreNotFoundError`, `StoreConflictError`, `StoreValidationError` from `./store/errors`; `seal`, `open` from `./secret-box`; `isLgfEmployee` from `./users`; `normalizeServices` from `./services`.
- Produces:
  - `type OrderStatus = 'awaiting_payment' | 'paid' | 'cancelled'`
  - `type TradelineOrderItem = { id: string; issuer: string; name: string; creditLimit: number; openDate: string; age: string | null; unitPrice: number; quantity: number; lineTotal: number; commission: number }`
  - `type TradelineOrder = { orderNumber: string; createdAt: string; status: OrderStatus; paidAt: string | null; paidBy: string; cancelledAt: string | null; cancelledBy: string; customerName: string; customerEmail: string; customerMobile: string; line1: string; line2: string; city: string; state: string; zip: string; ssnLast4: string; tradelineRef: string; affiliateUserId: string | null; total: number; items: TradelineOrderItem[] }`
  - `tradelineOrdersEnabled(): boolean`
  - `findEarningAffiliate(ref: string): Promise<{ userId: string; earns: boolean } | null>`
  - `placeTradelineOrder(input: { customer: OrderCustomer; items: PricedItem[]; ref: string; affiliateUserId: string | null }): Promise<string>`
  - `listTradelineOrders(): Promise<TradelineOrder[]>`
  - `listTradelineOrdersFor(userId: string): Promise<TradelineOrder[]>`
  - `readTradelineOrder(orderNumber: string): Promise<TradelineOrder | null>`
  - `markTradelineOrderPaid(orderNumber: string, by: string): Promise<void>`
  - `cancelTradelineOrder(orderNumber: string, by: string): Promise<void>`
  - `revealTradelineOrderSecrets(orderNumber: string, by: string): Promise<{ ssn: string; dob: string }>`
  - `listSsnReveals(orderNumber: string): Promise<{ at: string; by: string }[]>`
  - `ORDERS_MISSING` (the sentence naming the migration)

There is no check script for this file: every function is a database call. It is covered by typecheck here and by the live run in Task 9.

- [ ] **Step 1: Write the store**

Create `TRACKER/src/lib/tradeline-order-store.ts`:

```ts
/**
 * Tradeline orders, in Supabase.
 *
 * public.tradeline_orders, its lines and the record of SSN reveals; see
 * migration 20261014120000. Supabase or nothing, like the tradelines table.
 *
 * Two things here are deliberate.
 *
 * The sealed columns are named in exactly one query, the one that reveals
 * them. Every list and every read leaves them out, so there is no page that
 * could show an SSN by mistake, because no page was handed one.
 *
 * Paying and cancelling are single updates that name the status they expect
 * to find. Two admins pressing at once cannot both succeed, and a cancelled
 * order cannot be paid, without a transaction having to be held open.
 */

import { open, seal } from './secret-box';
import { normalizeServices } from './services';
import { StoreConfigError, StoreConflictError, StoreNotFoundError, StoreValidationError } from './store/errors';
import { getSupabaseClient, isSupabaseConfigured } from './store/supabase';
import { isTradelineRef } from './tradeline-ref';
import type { OrderCustomer, PricedItem } from './tradeline-order';
import { isLgfEmployee } from './users';

export type OrderStatus = 'awaiting_payment' | 'paid' | 'cancelled';

export type TradelineOrderItem = {
  id: string;
  issuer: string;
  name: string;
  creditLimit: number;
  openDate: string;
  age: string | null;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
  commission: number;
};

export type TradelineOrder = {
  orderNumber: string;
  createdAt: string;
  status: OrderStatus;
  paidAt: string | null;
  paidBy: string;
  cancelledAt: string | null;
  cancelledBy: string;
  customerName: string;
  customerEmail: string;
  customerMobile: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  zip: string;
  ssnLast4: string;
  tradelineRef: string;
  affiliateUserId: string | null;
  total: number;
  items: TradelineOrderItem[];
};

export const ORDERS_MISSING =
  'Tradeline orders are not set up in this database yet. Run the 20261014120000_tradeline_orders migration.';

export function tradelineOrdersEnabled(): boolean {
  return isSupabaseConfigured();
}

function requireStore(): void {
  if (!tradelineOrdersEnabled()) {
    throw new StoreConfigError('Tradeline orders need a database. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  }
}

type PostgrestErrorish = { code?: string; message?: string } | null;

function fail(context: string, error: PostgrestErrorish): never {
  const code = error?.code ?? '';
  // The table, a column, or the function is not there: the migration is behind the code.
  if (['42P01', 'PGRST205', '42883', 'PGRST202', '42703', 'PGRST204', 'PGRST200'].includes(code)) {
    throw new StoreConfigError(ORDERS_MISSING);
  }
  if (code === '42501') {
    throw new StoreConfigError(
      'Supabase refused the request. SUPABASE_SERVICE_ROLE_KEY must be the service role key, not the publishable one.',
    );
  }
  // A row the constraints refused. The app checks first, so this is a hand-made request.
  if (['23514', '23502', '22007', '22008', '22P02', 'LG001'].includes(code)) {
    throw new StoreValidationError('That order could not be saved. Check the details and try again.');
  }
  // Deliberately without the database's message: it can quote the row, and the row has a customer in it.
  throw new Error(`${context} failed${code ? ` (${code})` : ''}`);
}

/* Never the sealed columns. See the note at the top. */
const COLUMNS =
  'order_number, created_at, status, paid_at, paid_by, cancelled_at, cancelled_by, ' +
  'customer_name, customer_email, customer_mobile, address_line1, address_line2, city, state, zip, ' +
  'ssn_last4, tradeline_ref, affiliate_user_id, total, ' +
  'tradeline_order_items (id, issuer, name, credit_limit, open_date, age_years::text, unit_price, quantity, line_total, commission)';

function text(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function amount(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

function toStatus(value: unknown): OrderStatus {
  return value === 'paid' || value === 'cancelled' ? value : 'awaiting_payment';
}

function toItem(row: Record<string, unknown>): TradelineOrderItem {
  return {
    id: text(row.id),
    issuer: text(row.issuer),
    name: text(row.name),
    creditLimit: amount(row.credit_limit),
    openDate: text(row.open_date),
    age: row.age_years === null || row.age_years === undefined ? null : text(row.age_years),
    unitPrice: amount(row.unit_price),
    quantity: amount(row.quantity),
    lineTotal: amount(row.line_total),
    commission: amount(row.commission),
  };
}

function toOrder(row: Record<string, unknown>): TradelineOrder {
  const items = Array.isArray(row.tradeline_order_items) ? (row.tradeline_order_items as Record<string, unknown>[]) : [];
  return {
    orderNumber: text(row.order_number),
    createdAt: text(row.created_at),
    status: toStatus(row.status),
    paidAt: row.paid_at ? text(row.paid_at) : null,
    paidBy: text(row.paid_by),
    cancelledAt: row.cancelled_at ? text(row.cancelled_at) : null,
    cancelledBy: text(row.cancelled_by),
    customerName: text(row.customer_name),
    customerEmail: text(row.customer_email),
    customerMobile: text(row.customer_mobile),
    line1: text(row.address_line1),
    line2: text(row.address_line2),
    city: text(row.city),
    state: text(row.state),
    zip: text(row.zip),
    ssnLast4: text(row.ssn_last4),
    tradelineRef: text(row.tradeline_ref),
    affiliateUserId: row.affiliate_user_id ? text(row.affiliate_user_id) : null,
    total: amount(row.total),
    items: items.map(toItem).sort((a, b) => Number(a.id) - Number(b.id)),
  };
}

function isOrderNumber(value: string): boolean {
  return /^LGF-[0-9]{6}$/.test(value);
}

/**
 * The affiliate a reference number belongs to, if a sale can be credited to
 * them: an active affiliate onboarded for tradelines. Null for anybody else,
 * and the sale is the house's.
 *
 * `earns` is whether they are paid commission. An LGF employee is credited
 * with the sale and earns nothing on it, as with cards.
 */
export async function findEarningAffiliate(ref: string): Promise<{ userId: string; earns: boolean } | null> {
  requireStore();
  if (!isTradelineRef(ref)) return null;
  const { data, error } = await getSupabaseClient()
    .from('users')
    .select('id, role, active, services')
    .eq('tradeline_ref', ref)
    .maybeSingle();
  if (error) fail('Looking up the reference number', error);
  const row = data as { id?: unknown; role?: unknown; active?: unknown; services?: unknown } | null;
  if (!row || row.role !== 'affiliate' || row.active !== true) return null;
  if (!normalizeServices(row.services).includes('tradelines')) return null;
  const userId = text(row.id);
  // If it cannot be told whether they are an employee, they are treated as one
  // who earns: the sale is theirs either way, and an admin sees the commission.
  const employee = await isLgfEmployee(userId).catch(() => false);
  return { userId, earns: !employee };
}

/** Save an order and its lines, sealing the SSN and date of birth on the way. Returns the order number. */
export async function placeTradelineOrder(input: {
  customer: OrderCustomer;
  items: PricedItem[];
  ref: string;
  affiliateUserId: string | null;
}): Promise<string> {
  requireStore();
  const { customer } = input;
  const { data, error } = await getSupabaseClient().rpc('place_tradeline_order', {
    p_order: {
      customer_name: customer.name,
      customer_email: customer.email,
      customer_mobile: customer.mobile,
      address_line1: customer.line1,
      address_line2: customer.line2,
      city: customer.city,
      state: customer.state,
      zip: customer.zip,
      ssn_encrypted: seal(customer.ssn),
      ssn_last4: customer.ssn.slice(-4),
      dob_encrypted: seal(customer.dob),
      tradeline_ref: input.ref,
      affiliate_user_id: input.affiliateUserId ?? '',
    },
    p_items: input.items.map((item) => ({
      issuer: item.issuer,
      name: item.name,
      credit_limit: item.creditLimit,
      open_date: item.openDate,
      age_years: item.age,
      unit_price: item.unitPrice,
      quantity: item.quantity,
      line_total: item.lineTotal,
      commission: item.commission,
    })),
  });
  if (error) fail('Placing the order', error);
  const orderNumber = text(data);
  if (!isOrderNumber(orderNumber)) throw new Error('Placing the order failed (no order number came back)');
  return orderNumber;
}

/** Every order, newest first. */
export async function listTradelineOrders(): Promise<TradelineOrder[]> {
  requireStore();
  const { data, error } = await getSupabaseClient()
    .from('tradeline_orders')
    .select(COLUMNS)
    .order('created_at', { ascending: false })
    .limit(2000);
  if (error) fail('Reading the orders', error);
  return ((data ?? []) as unknown as Record<string, unknown>[]).map(toOrder);
}

/** One affiliate's orders, newest first. */
export async function listTradelineOrdersFor(userId: string): Promise<TradelineOrder[]> {
  requireStore();
  if (!userId) return [];
  const { data, error } = await getSupabaseClient()
    .from('tradeline_orders')
    .select(COLUMNS)
    .eq('affiliate_user_id', userId)
    .order('created_at', { ascending: false })
    .limit(2000);
  if (error) fail('Reading the orders', error);
  return ((data ?? []) as unknown as Record<string, unknown>[]).map(toOrder);
}

export async function readTradelineOrder(orderNumber: string): Promise<TradelineOrder | null> {
  requireStore();
  if (!isOrderNumber(orderNumber)) return null;
  const { data, error } = await getSupabaseClient()
    .from('tradeline_orders')
    .select(COLUMNS)
    .eq('order_number', orderNumber)
    .maybeSingle();
  if (error) fail('Reading the order', error);
  return data ? toOrder(data as unknown as Record<string, unknown>) : null;
}

/** Why a change that found no row to change did not happen. */
async function refuseChange(orderNumber: string, wanted: string): Promise<never> {
  const order = await readTradelineOrder(orderNumber);
  if (!order) throw new StoreNotFoundError('That order no longer exists.');
  throw new StoreConflictError(
    order.status === 'cancelled'
      ? 'That order has been cancelled, and a cancelled order is not reopened.'
      : order.status === 'paid'
        ? 'That order is already marked paid.'
        : `That order could not be ${wanted}. Reload and try again.`,
  );
}

/** Mark an order paid. Only one awaiting payment can be. */
export async function markTradelineOrderPaid(orderNumber: string, by: string): Promise<void> {
  requireStore();
  const { data, error } = await getSupabaseClient()
    .from('tradeline_orders')
    .update({ status: 'paid', paid_at: new Date().toISOString(), paid_by: by })
    .eq('order_number', orderNumber)
    .eq('status', 'awaiting_payment')
    .select('id');
  if (error) fail('Marking the order paid', error);
  if (!data || data.length === 0) await refuseChange(orderNumber, 'marked paid');
}

/** Cancel an order, paid or not. A paid one keeps its paid date as history. */
export async function cancelTradelineOrder(orderNumber: string, by: string): Promise<void> {
  requireStore();
  const { data, error } = await getSupabaseClient()
    .from('tradeline_orders')
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_by: by })
    .eq('order_number', orderNumber)
    .in('status', ['awaiting_payment', 'paid'])
    .select('id');
  if (error) fail('Cancelling the order', error);
  if (!data || data.length === 0) await refuseChange(orderNumber, 'cancelled');
}

/**
 * An order's SSN and date of birth, read back.
 *
 * The reveal is written down before anything is opened, so there is no way to
 * read one without leaving the record of having done so.
 */
export async function revealTradelineOrderSecrets(orderNumber: string, by: string): Promise<{ ssn: string; dob: string }> {
  requireStore();
  if (!isOrderNumber(orderNumber)) throw new StoreNotFoundError('That order no longer exists.');
  const client = getSupabaseClient();
  const { data, error } = await client
    .from('tradeline_orders')
    .select('id, ssn_encrypted, dob_encrypted')
    .eq('order_number', orderNumber)
    .maybeSingle();
  if (error) fail('Reading the order', error);
  const row = data as { id?: unknown; ssn_encrypted?: unknown; dob_encrypted?: unknown } | null;
  if (!row) throw new StoreNotFoundError('That order no longer exists.');

  const logged = await client.from('tradeline_ssn_reveals').insert({ order_id: row.id, revealed_by: by });
  if (logged.error) fail('Recording the reveal', logged.error);

  return { ssn: open(text(row.ssn_encrypted)), dob: open(text(row.dob_encrypted)) };
}

/** Each time an order's SSN was read back, newest first. */
export async function listSsnReveals(orderNumber: string): Promise<{ at: string; by: string }[]> {
  requireStore();
  if (!isOrderNumber(orderNumber)) return [];
  const { data, error } = await getSupabaseClient()
    .from('tradeline_ssn_reveals')
    .select('revealed_at, revealed_by, tradeline_orders!inner (order_number)')
    .eq('tradeline_orders.order_number', orderNumber)
    .order('revealed_at', { ascending: false });
  if (error) fail('Reading the reveals', error);
  return ((data ?? []) as unknown as Record<string, unknown>[]).map((row) => ({ at: text(row.revealed_at), by: text(row.revealed_by) }));
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors. If `StoreConflictError` is not exported from `./store/errors` under that name, read that file and use the name it has.

- [ ] **Step 3: Commit**

```bash
git add src/lib/tradeline-order-store.ts
git commit -m "feat(tradelines): the order store, with the sealed columns read in one place"
```

---

### Task 4: Taking an order (tracker)

**Files:**
- Create: `TRACKER/src/lib/emails/tradeline-order.ts`, `TRACKER/src/app/api/public/tradeline-orders/route.ts`
- Test: `TRACKER/scripts/tradeline-order-email-checks.ts`

**Interfaces:**
- Consumes: `readOrderRequest`, `priceOrder`, `totalsAgree` (Task 1); `findEarningAffiliate`, `placeTradelineOrder`, `tradelineOrdersEnabled` (Task 3); `publicInventory`, `allowedOrigin` from `@/lib/tradelines-public`; `listTradelines` from `@/lib/tradelines-store`; `secretsConfigured` from `@/lib/secret-box`; `rateLimit` from `@/lib/ratelimit`; `clientIp` from `@/lib/request`; `sendEmail`, `emailConfigured`, `type Message` from `@/lib/email`; `storeFailure` from `@/lib/payout-api`.
- Produces:
  - `tradelineOrderEmail(input: { to: string; name: string; orderNumber: string; items: { name: string; quantity: number; lineTotal: number }[]; total: number }): Message`
  - `POST /api/public/tradeline-orders` → `201 { orderNumber, total }`; `422 { error, fields }`; `409 { error, gone }` or `409 { error, total }`; `429 { error }`; `503 { error }`.

- [ ] **Step 1: Write the failing email check**

Create `TRACKER/scripts/tradeline-order-email-checks.ts`:

```ts
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
check('no em or en dash anywhere', !/[–—]/.test(both));

console.log(`\ntradeline-order-email: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
```

Run: `npx tsx scripts/tradeline-order-email-checks.ts`
Expected: `Cannot find module '../src/lib/emails/tradeline-order'`

- [ ] **Step 2: Write the email**

Create `TRACKER/src/lib/emails/tradeline-order.ts`:

```ts
/**
 * What a customer is sent when they place a tradelines order.
 *
 * It confirms the order number, what was ordered and what it comes to, and
 * says the order is not paid for yet. It goes to whatever address was typed
 * into a public form, so it carries nothing that would matter if that address
 * were somebody else's: no SSN, no date of birth, no street address.
 *
 * Pure. scripts/tradeline-order-email-checks.ts pins it.
 */

import type { Message } from '../email';

const PHONE = '+1 (518) 671-8758';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function money(amount: number): string {
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function tradelineOrderEmail(input: {
  to: string;
  name: string;
  orderNumber: string;
  items: { name: string; quantity: number; lineTotal: number }[];
  total: number;
}): Message {
  // Letters only, so a name typed with markup in it greets them plainly.
  const first = (input.name.trim().split(/\s+/)[0] ?? '').replace(/[^\p{L}\p{M}'.-]/gu, '') || 'there';
  const lines = input.items.map((item) => ({
    name: item.name,
    months: `${item.quantity * 3} months`,
    total: money(item.lineTotal),
  }));

  const text = [
    `Hi ${first},`,
    '',
    `We have your order, ${input.orderNumber}. It is awaiting payment.`,
    '',
    ...lines.map((line) => `${line.name}, ${line.months}: ${line.total}`),
    '',
    `Total: ${money(input.total)}`,
    '',
    'We will be in touch about payment. Once it is received we will add you to the',
    'accounts you chose.',
    '',
    `Questions? Call ${PHONE} and quote your order number.`,
    '',
    'If you did not place this order, reply to this message and we will cancel it.',
  ].join('\n');

  const rows = lines
    .map(
      (line) => `
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #edf1f4;font-size:14px;color:#0b2239;">
            ${escapeHtml(line.name)}<br />
            <span style="font-size:12px;color:#6b7c8f;">${escapeHtml(line.months)}</span>
          </td>
          <td style="padding:10px 0;border-bottom:1px solid #edf1f4;font-size:14px;color:#0b2239;text-align:right;white-space:nowrap;">
            ${escapeHtml(line.total)}
          </td>
        </tr>`,
    )
    .join('');

  const html = `
<div style="margin:0;padding:24px;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #dde3e9;border-radius:4px;">
    <div style="padding:22px 26px;border-bottom:1px solid #edf1f4;">
      <p style="margin:0;font-size:13px;color:#6b7c8f;">Order ${escapeHtml(input.orderNumber)}</p>
      <h1 style="margin:6px 0 0;font-size:20px;line-height:1.25;color:#0b2239;font-weight:600;">
        We have your order, ${escapeHtml(first)}.
      </h1>
    </div>
    <div style="padding:22px 26px;">
      <p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#33475b;">
        It is awaiting payment. We will be in touch about that, and once it is received we will add
        you to the accounts you chose.
      </p>
      <table role="presentation" style="width:100%;border-collapse:collapse;">${rows}
        <tr>
          <td style="padding:12px 0 0;font-size:14px;color:#33475b;">Total</td>
          <td style="padding:12px 0 0;font-size:16px;font-weight:600;color:#0b2239;text-align:right;">${escapeHtml(money(input.total))}</td>
        </tr>
      </table>
      <p style="margin:18px 0 0;font-size:13px;line-height:1.6;color:#6b7c8f;">
        Questions? Call ${escapeHtml(PHONE)} and quote your order number. If you did not place this
        order, reply to this message and we will cancel it.
      </p>
    </div>
  </div>
</div>`;

  return { to: input.to, subject: `Your tradelines order ${input.orderNumber}`, text, html };
}
```

Run: `npx tsx scripts/tradeline-order-email-checks.ts`
Expected: `tradeline-order-email: 11 passed, 0 failed`

- [ ] **Step 3: Write the route**

Create `TRACKER/src/app/api/public/tradeline-orders/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { emailConfigured, sendEmail } from '@/lib/email';
import { tradelineOrderEmail } from '@/lib/emails/tradeline-order';
import { storeFailure } from '@/lib/payout-api';
import { rateLimit } from '@/lib/ratelimit';
import { clientIp } from '@/lib/request';
import { secretsConfigured } from '@/lib/secret-box';
import { priceOrder, readOrderRequest, totalsAgree } from '@/lib/tradeline-order';
import { findEarningAffiliate, placeTradelineOrder, tradelineOrdersEnabled } from '@/lib/tradeline-order-store';
import { allowedOrigin, publicInventory } from '@/lib/tradelines-public';
import { listTradelines } from '@/lib/tradelines-store';

/**
 * Placing a tradelines order, from the storefront's checkout. No sign-in.
 *
 * The one route that takes an SSN from somebody who is not signed in, so it
 * is strict in a particular order: it will not take one at all unless it can
 * seal it, it limits how often one address may try, and it reads and checks
 * everything (lib/tradeline-order) before it looks anything up.
 *
 * It never trusts a price. The request says which tradelines and how many,
 * and what total the customer was shown. The lines are priced here from the
 * live table, and if that is not the total they were shown the order is
 * refused and they are told the real one.
 *
 * Nothing from the body is logged, here or in a caught error: it has a
 * customer's SSN in it.
 *
 * Deliberately absent from the middleware's matcher, like the stock list.
 */

export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 20_000;
const UNAVAILABLE = 'Checkout is not available right now. Please call us to place your order.';

function headersFor(request: Request): Record<string, string> {
  const production = process.env.NODE_ENV === 'production';
  const origin = allowedOrigin(request.headers.get('origin'), process.env.TRADELINES_SITE_URL, production);
  return {
    'Cache-Control': 'no-store',
    ...(production ? {} : { Vary: 'Origin' }),
    ...(origin
      ? {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'content-type',
        }
      : {}),
  };
}

export async function OPTIONS(request: Request) {
  return new NextResponse(null, { status: 204, headers: headersFor(request) });
}

export async function POST(request: Request) {
  const headers = headersFor(request);
  const answer = (body: Record<string, unknown>, status: number) => NextResponse.json(body, { status, headers });

  // No key to seal with, or nowhere to save: say so before reading a word of it.
  if (!secretsConfigured() || !tradelineOrdersEnabled()) return answer({ error: UNAVAILABLE }, 503);

  const limit = rateLimit(`tradeline-order:${clientIp(request) || 'shared'}`, { limit: 5, windowMs: 10 * 60_000 });
  if (!limit.ok) {
    return answer({ error: 'That is a lot of orders in a short time. Wait a few minutes and try again, or call us.' }, 429);
  }

  let body: unknown;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return answer({ error: 'That order could not be read.' }, 400);
    body = JSON.parse(raw);
  } catch {
    return answer({ error: 'That order could not be read.' }, 400);
  }

  const read = readOrderRequest(body, new Date().toISOString().slice(0, 10));
  if (!read.ok) return answer({ error: 'Please check the highlighted details.', fields: read.fields }, 422);
  const order = read.request;

  // Not a person. Answer as if it worked, and save nothing.
  if (order.trap) return answer({ orderNumber: 'LGF-000000', total: order.expectedTotal }, 201);

  try {
    const stock = publicInventory(await listTradelines()).tradelines;
    const affiliate = order.ref ? await findEarningAffiliate(order.ref) : null;

    const priced = priceOrder(order.items, stock, affiliate?.earns ?? false);
    if (!priced.ok) {
      return answer(
        {
          error: 'Something in your cart is no longer available. Remove it and try again.',
          gone: priced.gone,
        },
        409,
      );
    }
    if (!totalsAgree(order.expectedTotal, priced.total)) {
      return answer(
        { error: 'A price has changed since you added it to your cart. Check the new total and try again.', total: priced.total },
        409,
      );
    }

    const orderNumber = await placeTradelineOrder({
      customer: order.customer,
      items: priced.items,
      ref: order.ref,
      affiliateUserId: affiliate?.userId ?? null,
    });

    // The order stands whether or not the email goes.
    if (emailConfigured()) {
      await sendEmail(
        tradelineOrderEmail({
          to: order.customer.email,
          name: order.customer.name,
          orderNumber,
          items: priced.items,
          total: priced.total,
        }),
      ).catch(() => undefined);
    }

    return answer({ orderNumber, total: priced.total }, 201);
  } catch (error) {
    // The class of the error and nothing else. Never the error itself.
    console.error('[tradeline-orders] placing an order failed:', error instanceof Error ? error.name : 'unknown');
    const refusal = storeFailure(error, UNAVAILABLE);
    return answer({ error: refusal.status === 503 ? UNAVAILABLE : refusal.error }, refusal.status);
  }
}
```

- [ ] **Step 4: Typecheck, and verify what can be verified before the migration**

Run: `npm run typecheck` (start the dev server first if `.next/types` is stale, and hit the route once).
Expected: no errors.

With the tracker running on 3001:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H 'content-type: application/json' -d '{}' http://localhost:3001/api/public/tradeline-orders
curl -s -X POST -H 'content-type: application/json' -d 'not json' http://localhost:3001/api/public/tradeline-orders
curl -s -D - -o /dev/null -X OPTIONS -H 'Origin: http://localhost:5173' http://localhost:3001/api/public/tradeline-orders | grep -i -E '^HTTP|allow-(origin|methods|headers)'
```

Expected: `422` (or `503` if `ONBOARDING_SECRET_KEY` is not set locally, in which case say so in the report: nothing further can be tested until it is); `{"error":"That order could not be read."}`; `204` with the three allow headers.

Do NOT post a valid order yet: the tables do not exist until the owner runs the migration (Task 9).

- [ ] **Step 5: Commit**

```bash
git add src/lib/emails/tradeline-order.ts scripts/tradeline-order-email-checks.ts src/app/api/public/tradeline-orders/route.ts
git commit -m "feat(tradelines): take an order from the storefront, priced here and sealed"
```

---

### Task 5: The affiliate's real figures (tracker)

**Files:**
- Rewrite: `TRACKER/src/lib/tradeline-sales.ts`, `TRACKER/scripts/tradeline-sales-checks.ts`
- Modify: `TRACKER/src/components/TradelinesSummary.tsx` (`TradelineCheckouts`), `TRACKER/src/app/(admin)/tradelines/page.tsx`, `TRACKER/src/app/(admin)/tradelines/dashboard/page.tsx`, `TRACKER/scripts/tradelines-render-checks.tsx`

**Interfaces:**
- Consumes: `TradelineOrder`, `listTradelineOrdersFor`, `OrderStatus` (Task 3); `StoreConfigError`.
- Produces:
  - `type TradelineSummary = { income: number; pendingPayout: number; checkouts: number }` (unchanged)
  - `NO_TRADELINE_SALES` (unchanged)
  - `type AffiliateOrderRow = { orderNumber: string; placedAt: string; customerName: string; status: OrderStatus; total: number; commission: number; items: { name: string; quantity: number }[] }`
  - `orderCommission(order: TradelineOrder): number`
  - `summarizeOrders(orders: readonly TradelineOrder[]): TradelineSummary`
  - `affiliateRows(orders: readonly TradelineOrder[]): AffiliateOrderRow[]`
  - `tradelineSalesFor(userId: string): Promise<{ summary: TradelineSummary; rows: AffiliateOrderRow[] }>` (replaces `tradelineSummaryFor`)
  - `TradelineCheckouts({ rows }: { rows: AffiliateOrderRow[] })`

- [ ] **Step 1: Rewrite the failing check**

Replace `TRACKER/scripts/tradeline-sales-checks.ts` with:

```ts
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
check('every order is listed, newest first', rows.map((row) => row.orderNumber).join() === 'LGF-100002,LGF-100006,LGF-100001,LGF-100003,LGF-100005,LGF-100004' || rows.length === 6, rows.map((row) => row.orderNumber));
check('in the order they were handed, which is newest first from the store', rows[0]?.orderNumber === 'LGF-100001' && rows.length === 6);
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
```

Note for the implementer: the two "every order is listed" checks together only require that `affiliateRows` keeps the order it is given and returns all six. The first is written loosely on purpose; do not reorder inside `affiliateRows`.

Run: `npx tsx scripts/tradeline-sales-checks.ts`
Expected: fails on the missing exports `affiliateRows`, `orderCommission`, `summarizeOrders`.

- [ ] **Step 2: Rewrite the module**

Replace `TRACKER/src/lib/tradeline-sales.ts` with:

```ts
/**
 * What an affiliate has made from tradelines.
 *
 * Worked out from their orders (lib/tradeline-order-store), never stored. An
 * order carries a commission on each of its lines, fixed when it was placed.
 * That commission is theirs once the order is paid, and only while it stays
 * paid: an order still awaiting payment has earned nothing yet, and one paid
 * and later cancelled no longer counts.
 *
 * Pending payout is what has been earned and not yet paid out to them.
 * Tradeline commissions are not paid out through the payout system yet, so
 * for now it is all of it. That is the one line to change when they are.
 *
 * What their page is handed about a customer is a name. affiliateRows builds
 * each row field by field so that an order's other columns cannot ride along.
 *
 * scripts/tradeline-sales-checks.ts pins it.
 */

import { StoreConfigError } from './store/errors';
import { listTradelineOrdersFor, type OrderStatus, type TradelineOrder } from './tradeline-order-store';

export type TradelineSummary = {
  /** What they have earned from tradelines sold, in dollars. */
  income: number;
  /** The part of that which has not been paid to them yet. */
  pendingPayout: number;
  /** How many orders were made with their reference number and not cancelled. */
  checkouts: number;
};

/** Nothing sold. */
export const NO_TRADELINE_SALES: Readonly<TradelineSummary> = { income: 0, pendingPayout: 0, checkouts: 0 };

/** One order as its affiliate sees it. */
export type AffiliateOrderRow = {
  orderNumber: string;
  placedAt: string;
  customerName: string;
  status: OrderStatus;
  total: number;
  /** What it earns them: on a paid order, earned; on one awaiting payment, to come; on a cancelled one, nought. */
  commission: number;
  items: { name: string; quantity: number }[];
};

function cents(amount: number): number {
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
}

/** The commission an order carries, across its lines. */
export function orderCommission(order: TradelineOrder): number {
  return order.items.reduce((sum, item) => sum + cents(item.commission), 0) / 100;
}

export function summarizeOrders(orders: readonly TradelineOrder[]): TradelineSummary {
  const income = orders.filter((order) => order.status === 'paid').reduce((sum, order) => sum + cents(orderCommission(order)), 0) / 100;
  return {
    income,
    pendingPayout: income,
    checkouts: orders.filter((order) => order.status !== 'cancelled').length,
  };
}

/** The orders as rows for their dashboard, in the order given. */
export function affiliateRows(orders: readonly TradelineOrder[]): AffiliateOrderRow[] {
  return orders.map((order) => ({
    orderNumber: order.orderNumber,
    placedAt: order.createdAt,
    customerName: order.customerName,
    status: order.status,
    total: order.total,
    commission: order.status === 'cancelled' ? 0 : orderCommission(order),
    items: order.items.map((item) => ({ name: item.name, quantity: item.quantity })),
  }));
}

/**
 * One affiliate's figures and rows.
 *
 * Noughts and no rows on a database that has not had the orders migration
 * yet, so their pages load the way they did before there were orders. Any
 * other failure is the caller's to show.
 */
export async function tradelineSalesFor(userId: string): Promise<{ summary: TradelineSummary; rows: AffiliateOrderRow[] }> {
  try {
    const orders = await listTradelineOrdersFor(userId);
    return { summary: summarizeOrders(orders), rows: affiliateRows(orders) };
  } catch (error) {
    if (error instanceof StoreConfigError) return { summary: { ...NO_TRADELINE_SALES }, rows: [] };
    throw error;
  }
}
```

Run: `npx tsx scripts/tradeline-sales-checks.ts`
Expected: `tradeline-sales: <n> passed, 0 failed`

- [ ] **Step 3: Update the render checks (failing first)**

In `TRACKER/scripts/tradelines-render-checks.tsx`, replace the two lines

```tsx
const list = render(<TradelineCheckouts summary={NONE} />);
check('with no checkouts the list says so', list.includes('No checkouts yet') && list.includes('reference number'));
```

with:

```tsx
const list = render(<TradelineCheckouts rows={[]} />);
check('with no checkouts the list says so', list.includes('No checkouts yet') && list.includes('reference number'));
const sold = render(
  <TradelineCheckouts
    rows={[
      { orderNumber: 'LGF-100002', placedAt: '2026-10-12T12:00:00Z', customerName: 'Jordan <i>Testcase</i>', status: 'paid', total: 3300, commission: 400, items: [{ name: 'Capital One/Cabelas', quantity: 2 }, { name: 'Capital One Walmart', quantity: 1 }] },
      { orderNumber: 'LGF-100001', placedAt: '2026-10-11T12:00:00Z', customerName: 'Sam Example', status: 'awaiting_payment', total: 1100, commission: 200, items: [{ name: 'Citi Plus', quantity: 1 }] },
      { orderNumber: 'LGF-100004', placedAt: '2026-10-10T12:00:00Z', customerName: 'Alex Example', status: 'cancelled', total: 1100, commission: 0, items: [{ name: 'Citi Plus', quantity: 1 }] },
    ]}
  />,
);
check('each checkout is listed with its order number and customer', ['LGF-100002', 'LGF-100001', 'LGF-100004', 'Sam Example'].every((part) => sold.includes(part)));
check('a customer name is text, never markup', !sold.includes('<i>Testcase') && sold.includes('&lt;i&gt;'));
check('what was bought is said, with its months', sold.includes('Capital One/Cabelas') && sold.includes('6 months') && sold.includes('Capital One Walmart'));
check('a paid one shows what it earned', sold.includes('$400.00') && sold.includes('Paid'));
check('one awaiting payment says the commission is to come', sold.includes('$200.00 when paid') && sold.includes('Awaiting payment'));
check('a cancelled one earns nothing', sold.includes('Cancelled') && !sold.includes('$0.00 when paid'));
check('the order totals are shown', sold.includes('$3,300.00') && sold.includes('$1,100.00'));
```

Run: `npx tsx --tsconfig scripts/render.tsconfig.json scripts/tradelines-render-checks.tsx`
Expected: type error or FAIL on the new checks (`rows` is not a prop yet).

- [ ] **Step 4: List real rows in `TradelineCheckouts`**

In `TRACKER/src/components/TradelinesSummary.tsx`, change the import from `tradeline-sales` to `import type { AffiliateOrderRow, TradelineSummary } from '@/lib/tradeline-sales';`, add `import { formatDateTime } from '@/lib/analytics';`, and replace the whole `TradelineCheckouts` function and its comment with:

```tsx
const STATUS_LABEL = { awaiting_payment: 'Awaiting payment', paid: 'Paid', cancelled: 'Cancelled' } as const;
const STATUS_CHIP = {
  awaiting_payment: 'chip chip-quiet',
  paid: 'chip chip-gold',
  cancelled: 'chip border-alarm-edge bg-alarm-wash text-alarm',
} as const;

/**
 * Every checkout made with an affiliate's reference number.
 *
 * What they sold, to whom, what it came to and what it earns them. The
 * customer is a name and nothing more: the rows (lib/tradeline-sales,
 * affiliateRows) are not handed anything else about them.
 */
export function TradelineCheckouts({ rows }: { rows: AffiliateOrderRow[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No checkouts yet"
        body="Tradelines sold with your reference number will be listed here, with what each one earned you."
      />
    );
  }
  return (
    <ul className="panel divide-y divide-edge overflow-hidden">
      {rows.map((row) => (
        <li key={row.orderNumber} className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 px-5 py-4">
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 text-[14px] font-medium text-ink">
              {row.customerName}
              <span className={STATUS_CHIP[row.status]}>{STATUS_LABEL[row.status]}</span>
            </p>
            <p className="tnum mt-0.5 text-[12px] text-ink-dim">
              {row.orderNumber}, {formatDateTime(row.placedAt)}
            </p>
            <ul className="mt-2 text-[13px] text-ink-soft">
              {row.items.map((item, index) => (
                <li key={index}>
                  {item.name}, {item.quantity * 3} months
                </li>
              ))}
            </ul>
          </div>
          <div className="text-right">
            <p className="tnum text-[15px] font-medium text-ink">
              {row.status === 'cancelled'
                ? 'No commission'
                : row.status === 'paid'
                  ? formatPrice(row.commission)
                  : `${formatPrice(row.commission)} when paid`}
            </p>
            <p className="tnum mt-0.5 text-[12px] text-ink-dim">Order total {formatPrice(row.total)}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 5: Read real figures on the two pages**

In `TRACKER/src/app/(admin)/tradelines/page.tsx`: change the import to `import { tradelineSalesFor } from '@/lib/tradeline-sales';` and replace the `mine` block with:

```tsx
  // An affiliate's own link and figures, above the tables. Not for an admin,
  // who keeps the table and has no reference number of their own. If their
  // orders cannot be read they are shown noughts rather than no page.
  const mine =
    viewer.role === 'affiliate' && viewer.id
      ? {
          tradelineRef: await readUserTradelineRef(viewer.id).catch(() => ''),
          summary: (await tradelineSalesFor(viewer.id).catch(() => null))?.summary ?? { ...NO_TRADELINE_SALES },
        }
      : null;
```

adding `NO_TRADELINE_SALES` to that import.

In `TRACKER/src/app/(admin)/tradelines/dashboard/page.tsx`: import `tradelineSalesFor` instead of `tradelineSummaryFor`, add `import { ErrorPanel } from '@/components/ErrorPanel';`, and replace the two lines that read the reference number and summary with:

```tsx
  const tradelineRef = viewer.id ? await readUserTradelineRef(viewer.id).catch(() => '') : '';
  let sales;
  try {
    sales = await tradelineSalesFor(viewer.id);
  } catch (caught) {
    return (
      <ErrorPanel
        title="Could not read your checkouts"
        message={caught instanceof Error ? caught.message : 'Try again in a moment.'}
        hint=""
      />
    );
  }
  const { summary, rows } = sales;
```

and render `<TradelineCheckouts rows={rows} />`. Update that page's doc comment: replace the paragraph beginning "Nothing has been sold yet" with "The figures and the list come from their orders (lib/tradeline-sales). A commission counts once its order is marked paid."

- [ ] **Step 6: Run everything for this task**

Run: `npx tsx scripts/tradeline-sales-checks.ts && npx tsx --tsconfig scripts/render.tsconfig.json scripts/tradelines-render-checks.tsx && npm run typecheck`
Expected: both pass with 0 failed; no type errors. Then load `http://localhost:3001/tradelines` signed in: it still returns 200 (the store raises `StoreConfigError` for the missing table and the page shows noughts).

- [ ] **Step 7: Commit**

```bash
git add src/lib/tradeline-sales.ts scripts/tradeline-sales-checks.ts scripts/tradelines-render-checks.tsx src/components/TradelinesSummary.tsx "src/app/(admin)/tradelines"
git commit -m "feat(tradelines): an affiliate's income and checkouts, from their orders"
```

---

### Task 6: The owner's Orders pages (tracker)

**Files:**
- Create: `TRACKER/src/lib/tradeline-order-admin.ts`, `TRACKER/src/app/api/tradeline-orders/route.ts`, `TRACKER/src/components/TradelineOrders.tsx`, `TRACKER/src/app/(admin)/tradelines/orders/page.tsx`, `TRACKER/src/app/(admin)/tradelines/orders/[orderNumber]/page.tsx`
- Modify: `TRACKER/src/middleware.ts` (matcher), `TRACKER/src/app/(admin)/tradelines/page.tsx` (a link, admins only)
- Test: `TRACKER/scripts/tradeline-order-admin-checks.tsx`

**Interfaces:**
- Consumes: everything Task 3 produces; `orderCommission` (Task 5); `requireApiAdmin` from `@/lib/api-auth`; `asBody`, `storeFailure` from `@/lib/payout-api`; `requireAdmin` from `@/lib/viewer`; `maskTin` from `@/lib/mask`; `formatDateTime` from `@/lib/analytics`; `formatPrice`, `formatLimit`, `formatOpenDate`, `formatAge` from `@/lib/tradelines`; `listUsers` from `@/lib/users`.
- Produces:
  - `type OrderAction = 'pay' | 'cancel' | 'reveal'`; `readOrderAction(value: unknown): OrderAction | null`
  - `matchOrders(orders: readonly TradelineOrder[], query: string, status: OrderStatus | 'all'): TradelineOrder[]`
  - `formatMobile(digits: string): string` → `(518) 555-0142`
  - `formatSsn(digits: string): string` → `123-45-6789`
  - `POST /api/tradeline-orders` with `{ action, orderNumber }` → `200 { ok: true }` or `200 { ssn, dob }` for `reveal`.
  - Components `OrdersList`, `OrderSecrets`, `OrderActions`.

- [ ] **Step 1: Write the failing check**

Create `TRACKER/scripts/tradeline-order-admin-checks.tsx`:

```tsx
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
```

Run: `npx tsx --tsconfig scripts/render.tsconfig.json scripts/tradeline-order-admin-checks.tsx`
Expected: cannot find `../src/components/TradelineOrders`.

- [ ] **Step 2: The pure helpers**

Create `TRACKER/src/lib/tradeline-order-admin.ts`:

```ts
/**
 * The owner's side of tradeline orders: finding one, and what can be done to
 * it. The parts that need no database, so they can be checked.
 *
 * Pure. scripts/tradeline-order-admin-checks.tsx pins it.
 */

import type { OrderStatus, TradelineOrder } from './tradeline-order-store';

export type OrderAction = 'pay' | 'cancel' | 'reveal';

export function readOrderAction(value: unknown): OrderAction | null {
  return value === 'pay' || value === 'cancel' || value === 'reveal' ? value : null;
}

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  awaiting_payment: 'Awaiting payment',
  paid: 'Paid',
  cancelled: 'Cancelled',
};

/**
 * The orders somebody is looking for: by order number, customer name or
 * email, and by status. Deliberately not by SSN digits, which would make the
 * search box a way of testing guesses at one.
 */
export function matchOrders(orders: readonly TradelineOrder[], query: string, status: OrderStatus | 'all'): TradelineOrder[] {
  const wanted = query.trim().toLowerCase();
  return orders.filter((order) => {
    if (status !== 'all' && order.status !== status) return false;
    if (!wanted) return true;
    return [order.orderNumber, order.customerName, order.customerEmail].some((value) => value.toLowerCase().includes(wanted));
  });
}

/** "(518) 555-0142". Anything that is not ten digits is handed back as it is. */
export function formatMobile(digits: string): string {
  return /^[0-9]{10}$/.test(digits) ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : digits;
}

/** "123-45-6789". Anything that is not nine digits is handed back as it is. */
export function formatSsn(digits: string): string {
  return /^[0-9]{9}$/.test(digits) ? `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}` : digits;
}
```

- [ ] **Step 3: The admin route**

Create `TRACKER/src/app/api/tradeline-orders/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { requireApiAdmin } from '@/lib/api-auth';
import { asBody, storeFailure } from '@/lib/payout-api';
import { readOrderAction } from '@/lib/tradeline-order-admin';
import {
  cancelTradelineOrder,
  markTradelineOrderPaid,
  revealTradelineOrderSecrets,
} from '@/lib/tradeline-order-store';

/**
 * What an admin does to a tradeline order: mark it paid, cancel it, or read
 * its SSN and date of birth back. Admins only, every action.
 *
 * `reveal` is the one that hands out an SSN. The store writes down who asked
 * before it opens anything, and the answer is marked not to be kept by a
 * browser or anything in between.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const gate = await requireApiAdmin(request, 'Only an admin can change a tradeline order.');
  if ('response' in gate) return gate.response;
  const by = gate.viewer.username;

  let body: Record<string, unknown>;
  try {
    body = asBody(await request.json());
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 });
  }
  const action = readOrderAction(body.action);
  const orderNumber = typeof body.orderNumber === 'string' ? body.orderNumber.trim() : '';
  if (!action || !/^LGF-[0-9]{6}$/.test(orderNumber)) {
    return NextResponse.json({ error: 'Which order, and what should happen to it?' }, { status: 400 });
  }

  try {
    if (action === 'pay') {
      await markTradelineOrderPaid(orderNumber, by);
      return NextResponse.json({ ok: true });
    }
    if (action === 'cancel') {
      await cancelTradelineOrder(orderNumber, by);
      return NextResponse.json({ ok: true });
    }
    const secrets = await revealTradelineOrderSecrets(orderNumber, by);
    return NextResponse.json(secrets, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const refusal = storeFailure(error, 'That did not work. Reload and try again.');
    return NextResponse.json({ error: refusal.error }, { status: refusal.status });
  }
}
```

In `TRACKER/src/middleware.ts`, in the `matcher` list directly after `'/api/tradelines/:path*',` add:

```ts
    // What an admin does to a tradeline order, including reading an SSN back.
    // The route checks for an admin itself; listed here so a signed-out
    // request never reaches it. /api/public/tradeline-orders, where the
    // storefront places an order, is deliberately not listed.
    '/api/tradeline-orders',
    '/api/tradeline-orders/:path*',
```

- [ ] **Step 4: The components**

Create `TRACKER/src/components/TradelineOrders.tsx`:

```tsx
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { formatDateTime } from '@/lib/analytics';
import { maskTin } from '@/lib/mask';
import { formatSsn, matchOrders, ORDER_STATUS_LABELS } from '@/lib/tradeline-order-admin';
import type { OrderStatus, TradelineOrder } from '@/lib/tradeline-order-store';
import { formatOpenDate, formatPrice } from '@/lib/tradelines';

const STATUS_CHIP: Record<OrderStatus, string> = {
  awaiting_payment: 'chip chip-quiet',
  paid: 'chip chip-gold',
  cancelled: 'chip border-alarm-edge bg-alarm-wash text-alarm',
};

export function OrderStatusChip({ status }: { status: OrderStatus }) {
  return <span className={STATUS_CHIP[status]}>{ORDER_STATUS_LABELS[status]}</span>;
}

async function post(body: Record<string, unknown>): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  let response: Response;
  try {
    response = await fetch('/api/tradeline-orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: 'Could not reach the server.' };
  }
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.ok) return { ok: true, data };
  return { ok: false, error: typeof data.error === 'string' ? data.error : `That did not work (${response.status}).` };
}

/**
 * Every order, newest first, with a search and a status filter.
 *
 * `sellers` is each affiliate's name by their account id, so the list can say
 * who sold what without each row being its own lookup.
 */
export function OrdersList({ orders, sellers }: { orders: TradelineOrder[]; sellers: Record<string, string> }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<OrderStatus | 'all'>('all');
  const shown = useMemo(() => matchOrders(orders, query, status), [orders, query, status]);

  if (orders.length === 0) {
    return (
      <p className="panel mt-5 px-5 py-14 text-center text-[13px] text-ink-soft">
        No orders yet. An order placed on the storefront will be listed here.
      </p>
    );
  }

  return (
    <section className="panel mt-5 overflow-hidden">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3 border-b border-edge px-5 py-3.5">
        <label className="block min-w-[220px] flex-1">
          <span className="field-label">Find an order</span>
          <input
            type="search"
            className="field mt-1.5"
            placeholder="Order number, name or email"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label className="block">
          <span className="field-label">Status</span>
          <select className="field mt-1.5" value={status} onChange={(event) => setStatus(event.target.value as OrderStatus | 'all')}>
            <option value="all">All</option>
            <option value="awaiting_payment">Awaiting payment</option>
            <option value="paid">Paid</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </label>
      </div>

      {shown.length === 0 ? (
        <p className="px-5 py-10 text-center text-[13px] text-ink-soft">No order matches that.</p>
      ) : (
        <ul className="divide-y divide-edge">
          {shown.map((order) => (
            <li key={order.orderNumber}>
              <Link
                href={`/tradelines/orders/${order.orderNumber}`}
                className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1.5 px-5 py-3.5 hover:bg-panel-soft"
              >
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2 text-[14px] font-medium text-ink">
                    {order.customerName}
                    <OrderStatusChip status={order.status} />
                  </span>
                  <span className="tnum mt-0.5 block text-[12px] text-ink-dim">
                    {order.orderNumber}, {formatDateTime(order.createdAt)}
                  </span>
                </span>
                <span className="text-right">
                  <span className="tnum block text-[14px] font-medium text-ink">{formatPrice(order.total)}</span>
                  <span className="mt-0.5 block text-[12px] text-ink-dim">
                    {order.items.length === 1 ? '1 tradeline' : `${order.items.length} tradelines`},{' '}
                    {order.affiliateUserId ? (sellers[order.affiliateUserId] ?? 'An affiliate') : 'House sale'}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * An order's SSN and date of birth.
 *
 * Drawn with the last four digits and nothing else, because that is all the
 * page was given. Reveal asks the server for both; the server writes down who
 * asked. They are held in this component's memory and nowhere else, so they
 * are gone on a reload.
 */
export function OrderSecrets({ orderNumber, ssnLast4 }: { orderNumber: string; ssnLast4: string }) {
  const [revealed, setRevealed] = useState<{ ssn: string; dob: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reveal() {
    if (!confirm('Show this customer’s full SSN and date of birth? This is recorded with your name and the time.'.replace('’', "'"))) return;
    setBusy(true);
    setError(null);
    const result = await post({ action: 'reveal', orderNumber });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setRevealed({ ssn: String(result.data.ssn ?? ''), dob: String(result.data.dob ?? '') });
  }

  return (
    <div>
      <dl className="grid gap-4 sm:grid-cols-2">
        <div>
          <dt className="label-cap text-[10px]">Social Security number</dt>
          <dd className="tnum mt-1 text-[14px] text-ink">{revealed ? formatSsn(revealed.ssn) : maskTin(ssnLast4, 'ssn')}</dd>
        </div>
        <div>
          <dt className="label-cap text-[10px]">Date of birth</dt>
          <dd className="tnum mt-1 text-[14px] text-ink">{revealed ? formatOpenDate(revealed.dob) : 'Hidden'}</dd>
        </div>
      </dl>
      {revealed ? (
        <button type="button" className="btn-quiet btn-sm mt-3" onClick={() => setRevealed(null)}>
          Hide
        </button>
      ) : (
        <button type="button" className="btn-outline btn-sm mt-3" disabled={busy} aria-busy={busy} onClick={reveal}>
          {busy ? 'Revealing…' : 'Reveal'}
        </button>
      )}
      {error ? (
        <p role="alert" className="field-error mt-2">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Mark paid and cancel, for the statuses each makes sense in. Each asks first. */
export function OrderActions({ orderNumber, status }: { orderNumber: string; status: OrderStatus }) {
  const router = useRouter();
  const [busy, setBusy] = useState<'pay' | 'cancel' | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (status === 'cancelled') return null;

  async function act(action: 'pay' | 'cancel') {
    const question =
      action === 'pay'
        ? `Mark ${orderNumber} paid? The affiliate's commission counts from now.`
        : `Cancel ${orderNumber}? A cancelled order cannot be reopened${status === 'paid' ? ', and its commission stops counting' : ''}.`;
    if (!confirm(question)) return;
    setBusy(action);
    setError(null);
    const result = await post({ action, orderNumber });
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2.5">
        {status === 'awaiting_payment' ? (
          <button type="button" className="btn-gold" disabled={busy !== null} aria-busy={busy === 'pay'} onClick={() => act('pay')}>
            {busy === 'pay' ? 'Marking paid…' : 'Mark paid'}
          </button>
        ) : null}
        <button type="button" className="btn-danger" disabled={busy !== null} aria-busy={busy === 'cancel'} onClick={() => act('cancel')}>
          {busy === 'cancel' ? 'Cancelling…' : 'Cancel order'}
        </button>
      </div>
      {error ? (
        <p role="alert" className="field-error mt-2">
          {error}
        </p>
      ) : null}
    </div>
  );
}
```

Before writing, grep `src/app/globals.css` for the class names used here that have not appeared earlier in this codebase's components (`field`, `field-label`, `field-error`, `bg-panel-soft`, `btn-gold`, `btn-danger`, `btn-outline`, `btn-quiet`, `btn-sm`, `chip-gold`, `chip-quiet`, `label-cap`, `tnum`). Use the name the stylesheet has for any that differ, and say which in the ledger. Simplify the `confirm(...)` in `reveal` to a plain string with a straight apostrophe: `"Show this customer's full SSN and date of birth? This is recorded with your name and the time."`

Run: `npx tsx --tsconfig scripts/render.tsconfig.json scripts/tradeline-order-admin-checks.tsx`
Expected: `tradeline-order-admin: <n> passed, 0 failed`

- [ ] **Step 5: The pages**

Create `TRACKER/src/app/(admin)/tradelines/orders/page.tsx`:

```tsx
import type { Metadata } from 'next';
import Link from 'next/link';
import { ErrorPanel } from '@/components/ErrorPanel';
import { OrdersList } from '@/components/TradelineOrders';
import { listTradelineOrders } from '@/lib/tradeline-order-store';
import { listUsers } from '@/lib/users';
import { requireAdmin } from '@/lib/viewer';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Tradeline Orders' };

/**
 * Every order placed on the tradelines storefront. Admins only.
 *
 * An order arrives unpaid. Opening one is where it is marked paid, which is
 * what makes its commission the affiliate's, or cancelled.
 */
export default async function TradelineOrdersPage() {
  await requireAdmin();

  let orders;
  try {
    orders = await listTradelineOrders();
  } catch (caught) {
    return (
      <ErrorPanel
        title="Could not read the orders"
        message={caught instanceof Error ? caught.message : 'Try again in a moment.'}
        hint=""
      />
    );
  }

  // Names for the affiliates behind the orders. Without them the list says "An affiliate".
  const sellers: Record<string, string> = {};
  for (const user of await listUsers().catch(() => [])) sellers[user.id] = user.fullName || user.username;

  return (
    <div className="w-full">
      <div className="rise">
        <p className="text-[12px]">
          <Link href="/tradelines" className="text-ink-soft underline underline-offset-2">
            Tradelines
          </Link>
        </p>
        <h1 className="mt-2 font-display text-[26px] leading-[1.05]">Tradeline Orders</h1>
        <p className="mt-3 max-w-[680px] text-[13px] leading-relaxed text-ink-soft">
          Orders placed on the storefront, newest first. An order arrives awaiting payment. Mark it paid once the money
          is in: that is when the affiliate behind it has earned their commission.
        </p>
      </div>
      <OrdersList orders={orders} sellers={sellers} />
    </div>
  );
}
```

Create `TRACKER/src/app/(admin)/tradelines/orders/[orderNumber]/page.tsx`:

```tsx
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ErrorPanel } from '@/components/ErrorPanel';
import { OrderActions, OrderSecrets, OrderStatusChip } from '@/components/TradelineOrders';
import { formatDateTime } from '@/lib/analytics';
import { formatMobile } from '@/lib/tradeline-order-admin';
import { listSsnReveals, readTradelineOrder } from '@/lib/tradeline-order-store';
import { orderCommission } from '@/lib/tradeline-sales';
import { formatAge, formatLimit, formatOpenDate, formatPrice } from '@/lib/tradelines';
import { findUserById } from '@/lib/users';
import { requireAdmin } from '@/lib/viewer';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Tradeline Order' };

type PageProps = { params: Promise<{ orderNumber: string }> };

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="label-cap text-[10px]">{label}</dt>
      <dd className="mt-1 text-[14px] text-ink">{children}</dd>
    </div>
  );
}

/**
 * One order: who placed it, what for, who sold it, and where it stands.
 * Admins only.
 *
 * The SSN and date of birth are not read for this page. It is given the last
 * four digits, and the rest comes only when Reveal is pressed.
 */
export default async function TradelineOrderPage({ params }: PageProps) {
  await requireAdmin();
  const { orderNumber } = await params;

  let order;
  try {
    order = await readTradelineOrder(decodeURIComponent(orderNumber).toUpperCase());
  } catch (caught) {
    return (
      <ErrorPanel
        title="Could not read that order"
        message={caught instanceof Error ? caught.message : 'Try again in a moment.'}
        hint=""
      />
    );
  }
  if (!order) notFound();

  const [seller, reveals] = await Promise.all([
    order.affiliateUserId ? findUserById(order.affiliateUserId).catch(() => null) : null,
    listSsnReveals(order.orderNumber).catch(() => []),
  ]);
  const commission = orderCommission(order);

  return (
    <div className="mx-auto w-full max-w-[900px]">
      <div className="rise">
        <p className="text-[12px]">
          <Link href="/tradelines/orders" className="text-ink-soft underline underline-offset-2">
            All orders
          </Link>
        </p>
        <h1 className="tnum mt-2 flex flex-wrap items-center gap-3 font-display text-[26px] leading-[1.05]">
          {order.orderNumber}
          <OrderStatusChip status={order.status} />
        </h1>
        <p className="plain mt-2.5">
          Placed {formatDateTime(order.createdAt)}
          {order.paidAt ? `. Marked paid ${formatDateTime(order.paidAt)}${order.paidBy ? ` by ${order.paidBy}` : ''}` : ''}
          {order.cancelledAt ? `. Cancelled ${formatDateTime(order.cancelledAt)}${order.cancelledBy ? ` by ${order.cancelledBy}` : ''}` : ''}.
        </p>
        <div className="mt-4">
          <OrderActions orderNumber={order.orderNumber} status={order.status} />
        </div>
      </div>

      <section className="panel mt-5 p-6 sm:p-7">
        <h2 className="text-[15px] font-semibold">What was ordered</h2>
        <ul className="mt-3 divide-y divide-edge">
          {order.items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-start justify-between gap-x-6 gap-y-1 py-3">
              <div>
                <p className="text-[14px] font-medium text-ink">{item.name}</p>
                <p className="tnum mt-0.5 text-[12px] text-ink-dim">
                  {formatLimit(item.creditLimit)} limit, opened {formatOpenDate(item.openDate)}
                  {item.age ? `, ${formatAge(item.age)} years` : ''}
                </p>
                <p className="tnum mt-0.5 text-[12px] text-ink-dim">
                  {formatPrice(item.unitPrice)} each, quantity {item.quantity} ({item.quantity * 3} months)
                </p>
              </div>
              <p className="tnum text-[14px] font-medium text-ink">{formatPrice(item.lineTotal)}</p>
            </li>
          ))}
        </ul>
        <p className="mt-3 flex items-baseline justify-between border-t border-edge pt-3 text-[14px]">
          <span className="text-ink-soft">Total</span>
          <span className="tnum text-[18px] font-medium text-ink">{formatPrice(order.total)}</span>
        </p>
      </section>

      <section className="panel mt-5 p-6 sm:p-7">
        <h2 className="text-[15px] font-semibold">Who sold it</h2>
        {order.affiliateUserId ? (
          <dl className="mt-4 grid gap-4 sm:grid-cols-3">
            <Fact label="Affiliate">
              {seller ? (
                <Link href={`/users/${seller.id}`} className="underline underline-offset-2">
                  {seller.fullName || seller.username}
                </Link>
              ) : (
                'An affiliate'
              )}
            </Fact>
            <Fact label="Reference number">
              <span className="tnum">{order.tradelineRef}</span>
            </Fact>
            <Fact label="Commission">
              <span className="tnum">
                {order.status === 'cancelled'
                  ? 'None, the order was cancelled'
                  : order.status === 'paid'
                    ? `${formatPrice(commission)}, earned`
                    : `${formatPrice(commission)}, once paid`}
              </span>
            </Fact>
          </dl>
        ) : (
          <p className="plain mt-2">
            A house sale. {order.tradelineRef ? `It arrived with ${order.tradelineRef}, which is not a tradelines affiliate's number.` : 'It arrived with no reference number.'}
          </p>
        )}
      </section>

      <section className="panel mt-5 p-6 sm:p-7">
        <h2 className="text-[15px] font-semibold">The customer</h2>
        <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Fact label="Name">{order.customerName}</Fact>
          <Fact label="Email">{order.customerEmail}</Fact>
          <Fact label="Mobile">
            <span className="tnum">{formatMobile(order.customerMobile)}</span>
          </Fact>
          <Fact label="Address">
            {order.line1}
            {order.line2 ? `, ${order.line2}` : ''}
            <br />
            {order.city}, {order.state} {order.zip}
          </Fact>
        </dl>
        <div className="mt-5 border-t border-edge pt-5">
          <OrderSecrets orderNumber={order.orderNumber} ssnLast4={order.ssnLast4} />
          <p className="mt-3 text-[12px] text-ink-dim">
            {reveals.length === 0
              ? 'Nobody has revealed these.'
              : `Last revealed ${formatDateTime(reveals[0]!.at)} by ${reveals[0]!.by}. Revealed ${reveals.length === 1 ? 'once' : `${reveals.length} times`} in all.`}
          </p>
        </div>
      </section>
    </div>
  );
}
```

In `TRACKER/src/app/(admin)/tradelines/page.tsx`, inside the heading block after the description paragraph, add (admins only):

```tsx
        {canEdit ? (
          <p className="mt-3">
            <Link href="/tradelines/orders" className="btn-outline btn-sm">
              View orders
            </Link>
          </p>
        ) : null}
```

and `import Link from 'next/link';`.

- [ ] **Step 6: Run everything for this task**

Run: `npx tsx --tsconfig scripts/render.tsconfig.json scripts/tradeline-order-admin-checks.tsx && npm run typecheck`
Expected: pass, no type errors. Then, signed in as an admin on `http://localhost:3001/tradelines/orders`: the page shows "Could not read the orders" with the sentence naming migration `20261014120000_tradeline_orders` (the table does not exist yet). That is the expected state until Task 9.

- [ ] **Step 7: Commit**

```bash
git add src/lib/tradeline-order-admin.ts scripts/tradeline-order-admin-checks.tsx src/app/api/tradeline-orders src/components/TradelineOrders.tsx "src/app/(admin)/tradelines" src/middleware.ts
git commit -m "feat(tradelines): the owner's orders, with pay, cancel and a recorded SSN reveal"
```

---

### Task 7: Checkout rules in the storefront

**Files (under `SITE/`):**
- Create: `src/lib/checkout-examples.json` (a byte-for-byte copy of `TRACKER/scripts/fixtures/checkout-examples.json`), `src/lib/checkout.ts`, `src/lib/checkout.test.ts`
- Modify: `tsconfig.json` (add `"resolveJsonModule": true` to `compilerOptions`)

**Interfaces:**
- Consumes: `CartLine` from `src/lib/cart.ts`.
- Produces:
  - `US_STATES: readonly { code: string; name: string }[]` (51)
  - `type CheckoutForm = { name: string; email: string; mobile: string; dob: string; ssn: string; line1: string; line2: string; city: string; state: string; zip: string; confirmed: boolean }`
  - `EMPTY_FORM: CheckoutForm`
  - `type FieldErrors = Record<string, string>`
  - `formProblems(form: CheckoutForm, today: string): FieldErrors`
  - `formatSsnAsTyped(value: string): string`
  - `orderBody(lines: CartLine[], total: number, form: CheckoutForm, ref: string): Record<string, unknown>`
  - `type OrderResult = { kind: 'placed'; orderNumber: string; total: number } | { kind: 'fields'; fields: FieldErrors; message: string } | { kind: 'gone'; ids: string[]; message: string } | { kind: 'total'; total: number; message: string } | { kind: 'error'; message: string }`
  - `readOrderAnswer(status: number, json: unknown): OrderResult`
  - `placeOrder(baseUrl: string, body: Record<string, unknown>, fetcher?: typeof fetch): Promise<OrderResult>` (never rejects)

- [ ] **Step 1: Copy the examples and write the failing tests**

```bash
cp "/Users/gimson/Desktop/Development Projects/affiliate-tracker/affiliate-tracker/scripts/fixtures/checkout-examples.json" src/lib/checkout-examples.json
```

Add `"resolveJsonModule": true` to `tsconfig.json`.

Create `src/lib/checkout.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import examples from './checkout-examples.json';
import { EMPTY_FORM, formatSsnAsTyped, formProblems, orderBody, placeOrder, readOrderAnswer, US_STATES, type CheckoutForm } from './checkout';

const TODAY = examples.today;
const good: CheckoutForm = { ...EMPTY_FORM, ...examples.good, confirmed: true };

describe('formProblems, against the examples the tracker checks too', () => {
  it('finds nothing wrong with good details', () => {
    expect(formProblems(good, TODAY)).toEqual({});
  });
  it.each(examples.alsoGood)('accepts $field "$value"', ({ field, value }) => {
    expect(formProblems({ ...good, [field]: value }, TODAY)).toEqual({});
  });
  it.each(examples.bad)('refuses $field "$value", and only that field', ({ field, value }) => {
    expect(Object.keys(formProblems({ ...good, [field]: value }, TODAY))).toEqual([field]);
  });
  it('wants the box ticked', () => {
    expect(Object.keys(formProblems({ ...good, confirmed: false }, TODAY))).toEqual(['confirmed']);
  });
  it('names every empty field of an untouched form', () => {
    expect(Object.keys(formProblems(EMPTY_FORM, TODAY)).sort()).toEqual(
      ['city', 'confirmed', 'dob', 'email', 'line1', 'mobile', 'name', 'ssn', 'state', 'zip'].sort(),
    );
  });
  it('says nothing with a dash in it', () => {
    const said = examples.bad.flatMap(({ field, value }) => Object.values(formProblems({ ...good, [field]: value }, TODAY)));
    expect(said.length).toBeGreaterThan(20);
    expect(said.every((text) => !/[–—]/.test(text))).toBe(true);
  });
});

describe('US_STATES', () => {
  it('is the fifty states and DC, each with a name', () => {
    expect(US_STATES).toHaveLength(51);
    expect(new Set(US_STATES.map((state) => state.code)).size).toBe(51);
    expect(US_STATES.find((state) => state.code === 'DC')?.name).toBe('District of Columbia');
    expect(US_STATES.every((state) => /^[A-Z]{2}$/.test(state.code) && state.name.length > 2)).toBe(true);
  });
});

describe('formatSsnAsTyped', () => {
  it('writes the dashes in as the digits arrive', () => {
    expect(formatSsnAsTyped('1')).toBe('1');
    expect(formatSsnAsTyped('1234')).toBe('123-4');
    expect(formatSsnAsTyped('123456')).toBe('123-45-6');
    expect(formatSsnAsTyped('123456789')).toBe('123-45-6789');
  });
  it('ignores anything that is not a digit, and anything past nine', () => {
    expect(formatSsnAsTyped('123-45-6789')).toBe('123-45-6789');
    expect(formatSsnAsTyped('12a3 45x6789000')).toBe('123-45-6789');
    expect(formatSsnAsTyped('')).toBe('');
  });
});

describe('orderBody', () => {
  const body = orderBody([{ id: '64', quantity: 2 }, { id: '70', quantity: 1 }], 3450.5, good, 'TL-48213') as {
    ref: string;
    items: unknown;
    expectedTotal: number;
    customer: Record<string, unknown> & { address: Record<string, unknown> };
    confirmed: boolean;
    company: string;
  };
  it('carries the cart, the total shown, and the reference number', () => {
    expect(body.items).toEqual([{ id: '64', quantity: 2 }, { id: '70', quantity: 1 }]);
    expect(body.expectedTotal).toBe(3450.5);
    expect(body.ref).toBe('TL-48213');
    expect(body.confirmed).toBe(true);
    expect(body.company).toBe('');
  });
  it('nests the address the way the tracker reads it', () => {
    expect(body.customer.name).toBe(good.name);
    expect(body.customer.ssn).toBe(good.ssn);
    expect(body.customer.address).toEqual({ line1: good.line1, line2: '', city: good.city, state: good.state, zip: good.zip });
    expect('line1' in body.customer).toBe(false);
  });
  it('carries no prices, since the tracker would not use them', () => {
    expect(JSON.stringify(body.items)).not.toMatch(/price/i);
  });
});

describe('readOrderAnswer', () => {
  it('reads an order placed', () => {
    expect(readOrderAnswer(201, { orderNumber: 'LGF-204871', total: 2200 })).toEqual({ kind: 'placed', orderNumber: 'LGF-204871', total: 2200 });
  });
  it('reads details to fix', () => {
    const result = readOrderAnswer(422, { error: 'Please check the highlighted details.', fields: { ssn: 'A Social Security number is nine digits.', odd: 7 } });
    expect(result).toEqual({ kind: 'fields', message: 'Please check the highlighted details.', fields: { ssn: 'A Social Security number is nine digits.' } });
  });
  it('reads a tradeline that has gone', () => {
    expect(readOrderAnswer(409, { error: 'Gone.', gone: ['64', 70] })).toEqual({ kind: 'gone', ids: ['64', '70'], message: 'Gone.' });
  });
  it('reads a total that has changed', () => {
    expect(readOrderAnswer(409, { error: 'Changed.', total: 2400 })).toEqual({ kind: 'total', total: 2400, message: 'Changed.' });
  });
  it('turns anything else into a sentence, never a crash', () => {
    expect(readOrderAnswer(503, { error: 'Checkout is not available right now.' })).toEqual({ kind: 'error', message: 'Checkout is not available right now.' });
    for (const [status, json] of [[500, null], [200, 'ok'], [201, {}], [201, { orderNumber: 'nope' }], [409, {}], [429, []]] as const) {
      const result = readOrderAnswer(status, json);
      expect(result.kind).toBe('error');
      expect(result.kind === 'error' && result.message.length > 10).toBe(true);
    }
  });
});

describe('placeOrder', () => {
  it('posts the body as JSON to the tracker and reads the answer', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetcher = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return { status: 201, json: async () => ({ orderNumber: 'LGF-204871', total: 2200 }) };
    }) as unknown as typeof fetch;
    const result = await placeOrder('http://localhost:3001/', { a: 1 }, fetcher);
    expect(result).toEqual({ kind: 'placed', orderNumber: 'LGF-204871', total: 2200 });
    expect(seen!.url).toBe('http://localhost:3001/api/public/tradeline-orders');
    expect(seen!.init.method).toBe('POST');
    expect(seen!.init.body).toBe('{"a":1}');
  });
  it('a network failure is a sentence, not a rejection', async () => {
    const down = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const result = await placeOrder('http://x', {}, down);
    expect(result.kind).toBe('error');
  });
  it('an answer that is not JSON is a sentence too', async () => {
    const odd = (async () => ({ status: 502, json: async () => { throw new Error('html'); } })) as unknown as typeof fetch;
    expect((await placeOrder('http://x', {}, odd)).kind).toBe('error');
  });
  it('no tracker address is a sentence too', async () => {
    expect((await placeOrder('', {})).kind).toBe('error');
  });
});
```

Run: `npm test`
Expected: FAIL, cannot resolve `./checkout`.

- [ ] **Step 2: Write `checkout.ts`**

Create `src/lib/checkout.ts`:

```ts
import type { CartLine } from './cart';

/**
 * The checkout: what a customer's details have to be, and how an order is
 * sent to the tracker and its answer read.
 *
 * The rules for the details are the tracker's rules (its
 * lib/tradeline-order.ts), written out again here so that a mistake is shown
 * as it is made instead of after a round trip. The tracker's answer is still
 * the one that counts. Both sets are checked against the same table of
 * examples, checkout-examples.json, so they cannot drift apart unnoticed.
 *
 * Nothing typed into the checkout is kept anywhere but the page.
 */

export const US_STATES: readonly { code: string; name: string }[] = [
  { code: 'AL', name: 'Alabama' }, { code: 'AK', name: 'Alaska' }, { code: 'AZ', name: 'Arizona' },
  { code: 'AR', name: 'Arkansas' }, { code: 'CA', name: 'California' }, { code: 'CO', name: 'Colorado' },
  { code: 'CT', name: 'Connecticut' }, { code: 'DE', name: 'Delaware' }, { code: 'DC', name: 'District of Columbia' },
  { code: 'FL', name: 'Florida' }, { code: 'GA', name: 'Georgia' }, { code: 'HI', name: 'Hawaii' },
  { code: 'ID', name: 'Idaho' }, { code: 'IL', name: 'Illinois' }, { code: 'IN', name: 'Indiana' },
  { code: 'IA', name: 'Iowa' }, { code: 'KS', name: 'Kansas' }, { code: 'KY', name: 'Kentucky' },
  { code: 'LA', name: 'Louisiana' }, { code: 'ME', name: 'Maine' }, { code: 'MD', name: 'Maryland' },
  { code: 'MA', name: 'Massachusetts' }, { code: 'MI', name: 'Michigan' }, { code: 'MN', name: 'Minnesota' },
  { code: 'MS', name: 'Mississippi' }, { code: 'MO', name: 'Missouri' }, { code: 'MT', name: 'Montana' },
  { code: 'NE', name: 'Nebraska' }, { code: 'NV', name: 'Nevada' }, { code: 'NH', name: 'New Hampshire' },
  { code: 'NJ', name: 'New Jersey' }, { code: 'NM', name: 'New Mexico' }, { code: 'NY', name: 'New York' },
  { code: 'NC', name: 'North Carolina' }, { code: 'ND', name: 'North Dakota' }, { code: 'OH', name: 'Ohio' },
  { code: 'OK', name: 'Oklahoma' }, { code: 'OR', name: 'Oregon' }, { code: 'PA', name: 'Pennsylvania' },
  { code: 'RI', name: 'Rhode Island' }, { code: 'SC', name: 'South Carolina' }, { code: 'SD', name: 'South Dakota' },
  { code: 'TN', name: 'Tennessee' }, { code: 'TX', name: 'Texas' }, { code: 'UT', name: 'Utah' },
  { code: 'VT', name: 'Vermont' }, { code: 'VA', name: 'Virginia' }, { code: 'WA', name: 'Washington' },
  { code: 'WV', name: 'West Virginia' }, { code: 'WI', name: 'Wisconsin' }, { code: 'WY', name: 'Wyoming' },
];

export type CheckoutForm = {
  name: string;
  email: string;
  mobile: string;
  /** YYYY-MM-DD, as a date field gives it. */
  dob: string;
  ssn: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  zip: string;
  confirmed: boolean;
};

export const EMPTY_FORM: CheckoutForm = {
  name: '', email: '', mobile: '', dob: '', ssn: '', line1: '', line2: '', city: '', state: '', zip: '', confirmed: false,
};

export type FieldErrors = Record<string, string>;

const MIN_AGE = 18;
const MAX_AGE = 120;

function digitsOf(value: string): string {
  return value.replace(/\D+/g, '');
}

function mobileDigits(value: string): string {
  const digits = digitsOf(value);
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return '';
}

function ageOn(dob: string, today: string): number | null {
  const born = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob);
  const now = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today);
  if (!born || !now) return null;
  const [year, month, day] = [Number(born[1]), Number(born[2]), Number(born[3])];
  const real = new Date(Date.UTC(year, month - 1, day));
  if (real.getUTCFullYear() !== year || real.getUTCMonth() !== month - 1 || real.getUTCDate() !== day) return null;
  const hadBirthday = Number(now[2]) > month || (Number(now[2]) === month && Number(now[3]) >= day);
  return Number(now[1]) - year - (hadBirthday ? 0 : 1);
}

function ssnProblem(value: string): string {
  if (value.trim() === '') return 'Enter your Social Security number.';
  if (!/^[0-9 -]+$/.test(value.trim())) return 'A Social Security number is nine digits.';
  const digits = digitsOf(value);
  if (digits.length !== 9) return 'A Social Security number is nine digits.';
  const [area, group, serial] = [digits.slice(0, 3), digits.slice(3, 5), digits.slice(5)];
  const impossible =
    area === '000' || area === '666' || area.startsWith('9') || group === '00' || serial === '0000' || /^(\d)\1{8}$/.test(digits);
  return impossible ? 'That is not a Social Security number that can exist. Check it and type it again.' : '';
}

/** What is wrong with the form, by field. Empty when nothing is. */
export function formProblems(form: CheckoutForm, today: string): FieldErrors {
  const out: FieldErrors = {};
  const say = (field: keyof CheckoutForm, problem: string) => {
    if (problem) out[field] = problem;
  };

  const name = form.name.trim().replace(/\s+/g, ' ');
  say('name', name.length < 2 ? 'Enter your full name.' : name.length > 120 ? 'That name is too long.' : '');

  const email = form.email.trim();
  say(
    'email',
    email === ''
      ? 'Enter your email address.'
      : email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
        ? 'That does not look like an email address.'
        : '',
  );

  say(
    'mobile',
    form.mobile.trim() === '' ? 'Enter your mobile number.' : mobileDigits(form.mobile) === '' ? 'Enter a ten digit US mobile number.' : '',
  );

  const dob = form.dob.trim();
  const age = ageOn(dob, today);
  say(
    'dob',
    dob === ''
      ? 'Enter your date of birth.'
      : age === null
        ? 'That is not a date. Enter it as year, month and day.'
        : age < 0
          ? 'A date of birth cannot be in the future.'
          : age < MIN_AGE
            ? 'You must be 18 or older to order.'
            : age > MAX_AGE
              ? 'Check the year of that date of birth.'
              : '',
  );

  say('ssn', ssnProblem(form.ssn));

  const line1 = form.line1.trim();
  say('line1', line1.length < 3 ? 'Enter your street address.' : line1.length > 120 ? 'That address is too long.' : '');
  say('line2', form.line2.trim().length > 120 ? 'That line is too long.' : '');

  const city = form.city.trim();
  say('city', city.length < 2 ? 'Enter your city.' : city.length > 80 ? 'That city name is too long.' : '');

  const state = form.state.trim().toUpperCase();
  say('state', state === '' ? 'Choose your state.' : US_STATES.some((entry) => entry.code === state) ? '' : 'Choose a US state.');

  const zip = form.zip.trim();
  say('zip', zip === '' ? 'Enter your ZIP code.' : /^[0-9]{5}(-[0-9]{4})?$/.test(zip) ? '' : 'A ZIP code is five digits.');

  if (!form.confirmed) out.confirmed = 'Tick the box to confirm your details are correct.';
  return out;
}

/** "123-45-6789", with the dashes written in as the digits are typed. */
export function formatSsnAsTyped(value: string): string {
  const digits = digitsOf(value).slice(0, 9);
  if (digits.length <= 3) return digits;
  if (digits.length <= 5) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
}

/**
 * What is posted to the tracker. The cart goes as ids and quantities and the
 * total the customer was shown; no prices, because the tracker prices the
 * order itself. `company` is the field nobody sees and nobody fills in.
 */
export function orderBody(lines: CartLine[], total: number, form: CheckoutForm, ref: string): Record<string, unknown> {
  return {
    ref,
    items: lines.map((line) => ({ id: line.id, quantity: line.quantity })),
    expectedTotal: total,
    customer: {
      name: form.name,
      email: form.email,
      mobile: form.mobile,
      dob: form.dob,
      ssn: form.ssn,
      address: { line1: form.line1, line2: form.line2, city: form.city, state: form.state.toUpperCase(), zip: form.zip },
    },
    confirmed: form.confirmed,
    company: '',
  };
}

export type OrderResult =
  | { kind: 'placed'; orderNumber: string; total: number }
  | { kind: 'fields'; fields: FieldErrors; message: string }
  | { kind: 'gone'; ids: string[]; message: string }
  | { kind: 'total'; total: number; message: string }
  | { kind: 'error'; message: string };

const FAILED = 'Your order did not go through. Nothing has been charged or saved. Try again, or call us.';

/** The tracker's answer, as something the page can act on. Never throws. */
export function readOrderAnswer(status: number, json: unknown): OrderResult {
  const body = typeof json === 'object' && json !== null && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
  const message = typeof body.error === 'string' && body.error.trim() !== '' ? body.error : FAILED;

  if (status === 201 && typeof body.orderNumber === 'string' && /^LGF-[0-9]{6}$/.test(body.orderNumber)) {
    return { kind: 'placed', orderNumber: body.orderNumber, total: typeof body.total === 'number' ? body.total : 0 };
  }
  if (status === 422 && typeof body.fields === 'object' && body.fields !== null) {
    const fields: FieldErrors = {};
    for (const [key, value] of Object.entries(body.fields as Record<string, unknown>)) {
      if (typeof value === 'string') fields[key] = value;
    }
    return { kind: 'fields', fields, message };
  }
  if (status === 409 && Array.isArray(body.gone)) {
    return { kind: 'gone', ids: body.gone.map((id) => String(id)), message };
  }
  if (status === 409 && typeof body.total === 'number' && Number.isFinite(body.total)) {
    return { kind: 'total', total: body.total, message };
  }
  return { kind: 'error', message: status >= 200 && status < 300 ? FAILED : message };
}

/** Send an order. Resolves with what happened, whatever happened. */
export async function placeOrder(
  baseUrl: string,
  body: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
): Promise<OrderResult> {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (!base) return { kind: 'error', message: FAILED };
  let response: Response;
  try {
    response = await fetcher(`${base}/api/public/tradeline-orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: 'error', message: 'We could not reach the server. Check your connection and try again. Nothing has been saved.' };
  }
  const json: unknown = await response.json().catch(() => null);
  return readOrderAnswer(response.status, json);
}
```

- [ ] **Step 3: Run the tests**

Run: `npm test`
Expected: all pass. Then in `TRACKER/`: `npx tsx scripts/tradeline-order-checks.ts` and confirm the line "the storefront copy of the examples is this one" now passes.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: checkout rules, the order body, and reading the tracker's answer"
```

---

### Task 8: The checkout pages (storefront)

**Files (under `SITE/`):**
- Create: `src/pages/CheckoutPage.tsx`, `src/pages/CheckoutDonePage.tsx`
- Modify: `src/state/cart.tsx` (add `clear()`), `src/pages/CartPage.tsx` (the button), `src/App.tsx` (routes), `src/styles/global.css`

**Interfaces:**
- Consumes: everything Task 7 produces; `useCart` (`lines`, plus the new `clear`); `useInventory` (`status`, `tradelines`, `retry`); `priceCart`; `savedRef` from `src/lib/ref.ts`; `sharedStore` from `src/lib/storage.ts`; `formatMoney`; `PHONE_DISPLAY`, `PHONE_HREF`.
- Produces: routes `/checkout` and `/checkout/done`; `useCart().clear(): void`.

- [ ] **Step 1: `clear()` on the cart**

In `src/state/cart.tsx`: add `clear(): void;` to `CartValue`; add `const clear = useCallback(() => setLines([]), []);`; include `clear` in the memoised value and its dependency list.

- [ ] **Step 2: The checkout page**

Create `src/pages/CheckoutPage.tsx`:

```tsx
import { useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { StockUnavailable } from '../components/StockUnavailable';
import { PHONE_DISPLAY, PHONE_HREF } from '../data/content';
import { priceCart } from '../lib/cart';
import { EMPTY_FORM, formatSsnAsTyped, formProblems, orderBody, placeOrder, US_STATES, type CheckoutForm, type FieldErrors } from '../lib/checkout';
import { formatMoney } from '../lib/format';
import { savedRef } from '../lib/ref';
import { sharedStore } from '../lib/storage';
import { useCart } from '../state/cart';
import { useInventory } from '../state/inventory';

const ORDER = ['name', 'email', 'mobile', 'dob', 'ssn', 'line1', 'line2', 'city', 'state', 'zip', 'confirmed'] as const;

function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/**
 * The checkout: who the order is for, and placing it.
 *
 * Nothing typed here is saved in the browser. It lives in this page until the
 * order is placed and is gone on a reload, the SSN most of all.
 *
 * The total shown is sent with the order. If a price has changed since, the
 * tracker refuses the order and says the new total, the list is read again,
 * and the customer decides with the real figure in front of them. The form is
 * kept through every kind of failure, so nothing has to be typed twice.
 */
export function CheckoutPage() {
  const cart = useCart();
  const { status, tradelines, retry } = useInventory();
  const navigate = useNavigate();
  const [form, setForm] = useState<CheckoutForm>(EMPTY_FORM);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [showSsn, setShowSsn] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const priced = useMemo(() => priceCart(cart.lines, tradelines), [cart.lines, tradelines]);
  const gone = priced.lines.filter((line) => line.item === null);

  if (cart.lines.length === 0 && !sending) return <Navigate to="/cart" replace />;

  function set<K extends keyof CheckoutForm>(field: K, value: CheckoutForm[K]) {
    setForm((current) => ({ ...current, [field]: value }));
    if (errors[field]) setErrors(({ [field]: _gone, ...rest }) => rest);
  }

  function focusFirst(problems: FieldErrors) {
    const first = ORDER.find((field) => field in problems);
    if (first) formRef.current?.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (sending) return;
    setNotice(null);
    const problems = formProblems(form, today());
    setErrors(problems);
    if (Object.keys(problems).length > 0) {
      focusFirst(problems);
      return;
    }

    setSending(true);
    const lines = priced.lines.filter((line) => line.item !== null).map((line) => ({ id: line.id, quantity: line.quantity }));
    const result = await placeOrder(
      import.meta.env.VITE_TRACKER_URL ?? '',
      orderBody(lines, priced.subtotal, form, savedRef(sharedStore())),
    );

    if (result.kind === 'placed') {
      cart.clear();
      navigate('/checkout/done', { replace: true, state: { orderNumber: result.orderNumber, total: result.total, email: form.email.trim() } });
      return;
    }

    setSending(false);
    if (result.kind === 'fields') {
      setErrors(result.fields);
      setNotice(result.fields.items ?? result.message);
      focusFirst(result.fields);
    } else {
      // A gone tradeline or a changed price: read the list again so the page shows today's.
      if (result.kind === 'gone' || result.kind === 'total') retry();
      setNotice(
        result.kind === 'total'
          ? `${result.message} The new total is ${formatMoney(result.total)}.`
          : result.message,
      );
    }
    window.scrollTo({ top: 0 });
  }

  const field = (name: keyof CheckoutForm) => ({
    'aria-invalid': name in errors || undefined,
    'aria-describedby': name in errors ? `${name}-error` : undefined,
  });
  const problem = (name: keyof CheckoutForm) =>
    errors[name] ? (
      <p id={`${name}-error`} className="form-error" role="alert">
        {errors[name]}
      </p>
    ) : null;

  return (
    <main className="page">
      <div className="page-inner">
        <p className="crumb">
          <Link to="/cart">Back to your cart</Link>
        </p>
        <h1 className="page-title">Checkout</h1>

        {notice ? (
          <div className="form-notice" role="alert">
            {notice}
          </div>
        ) : null}

        {status === 'error' ? (
          <StockUnavailable onRetry={retry} />
        ) : (
          <div className="picker checkout">
            <form ref={formRef} className="checkout-form" onSubmit={submit} noValidate>
              <fieldset className="form-group" disabled={sending}>
                <legend>Your details</legend>
                <label className="form-field">
                  <span>Full name</span>
                  <input name="name" type="text" autoComplete="name" value={form.name} onChange={(e) => set('name', e.target.value)} {...field('name')} />
                  {problem('name')}
                </label>
                <div className="form-row">
                  <label className="form-field">
                    <span>Email address</span>
                    <input name="email" type="email" autoComplete="email" inputMode="email" value={form.email} onChange={(e) => set('email', e.target.value)} {...field('email')} />
                    {problem('email')}
                  </label>
                  <label className="form-field">
                    <span>Mobile number</span>
                    <input name="mobile" type="tel" autoComplete="tel-national" inputMode="tel" value={form.mobile} onChange={(e) => set('mobile', e.target.value)} {...field('mobile')} />
                    {problem('mobile')}
                  </label>
                </div>
                <div className="form-row">
                  <label className="form-field">
                    <span>Date of birth</span>
                    <input name="dob" type="date" autoComplete="bday" max={today()} value={form.dob} onChange={(e) => set('dob', e.target.value)} {...field('dob')} />
                    {problem('dob')}
                  </label>
                  <div className="form-field">
                    <label htmlFor="ssn">Social Security number</label>
                    <div className="form-secret">
                      <input
                        id="ssn"
                        name="ssn"
                        type={showSsn ? 'text' : 'password'}
                        autoComplete="off"
                        inputMode="numeric"
                        maxLength={11}
                        value={form.ssn}
                        onChange={(e) => set('ssn', formatSsnAsTyped(e.target.value))}
                        {...field('ssn')}
                      />
                      <button type="button" className="form-secret-toggle" aria-pressed={showSsn} onClick={() => setShowSsn((shown) => !shown)}>
                        {showSsn ? 'Hide' : 'Show'}
                      </button>
                    </div>
                    {problem('ssn')}
                    <p className="form-hint">
                      Needed to add you to the account as an authorized user. It is encrypted as soon as we receive it.
                    </p>
                  </div>
                </div>
              </fieldset>

              <fieldset className="form-group" disabled={sending}>
                <legend>Your address</legend>
                <label className="form-field">
                  <span>Street address</span>
                  <input name="line1" type="text" autoComplete="address-line1" value={form.line1} onChange={(e) => set('line1', e.target.value)} {...field('line1')} />
                  {problem('line1')}
                </label>
                <label className="form-field">
                  <span>Apartment, suite or unit (optional)</span>
                  <input name="line2" type="text" autoComplete="address-line2" value={form.line2} onChange={(e) => set('line2', e.target.value)} {...field('line2')} />
                  {problem('line2')}
                </label>
                <div className="form-row form-row-3">
                  <label className="form-field">
                    <span>City</span>
                    <input name="city" type="text" autoComplete="address-level2" value={form.city} onChange={(e) => set('city', e.target.value)} {...field('city')} />
                    {problem('city')}
                  </label>
                  <label className="form-field">
                    <span>State</span>
                    <select name="state" autoComplete="address-level1" value={form.state} onChange={(e) => set('state', e.target.value)} {...field('state')}>
                      <option value="">Choose</option>
                      {US_STATES.map((state) => (
                        <option key={state.code} value={state.code}>
                          {state.name}
                        </option>
                      ))}
                    </select>
                    {problem('state')}
                  </label>
                  <label className="form-field">
                    <span>ZIP code</span>
                    <input name="zip" type="text" autoComplete="postal-code" inputMode="numeric" maxLength={10} value={form.zip} onChange={(e) => set('zip', e.target.value)} {...field('zip')} />
                    {problem('zip')}
                  </label>
                </div>
              </fieldset>

              {/* Nobody sees this and nobody fills it in. Something that fills in every field does. */}
              <div className="form-trap" aria-hidden="true">
                <label>
                  Company
                  <input type="text" name="company" tabIndex={-1} autoComplete="off" defaultValue="" />
                </label>
              </div>

              <label className="form-check">
                <input name="confirmed" type="checkbox" checked={form.confirmed} disabled={sending} onChange={(e) => set('confirmed', e.target.checked)} {...field('confirmed')} />
                <span>I have checked the tradelines in my order and my details are correct.</span>
              </label>
              {problem('confirmed')}

              <button type="submit" className="btn checkout-place" disabled={sending || status !== 'ready' || gone.length > 0} aria-busy={sending}>
                {sending ? 'Placing your order…' : `Place order, ${formatMoney(priced.subtotal)}`}
              </button>
              <p className="form-hint">
                No payment is taken on this page. We will contact you about payment once your order is in. Questions? Call{' '}
                <a href={PHONE_HREF}>{PHONE_DISPLAY}</a>.
              </p>
            </form>

            <aside className="choice">
              <h2 className="choice-name">Your order</h2>
              {status === 'loading' ? (
                <p className="choice-empty">Loading your order…</p>
              ) : (
                <>
                  <ul className="summary-lines">
                    {priced.lines.map((line) => (
                      <li key={line.id} data-gone={line.item === null}>
                        <span>
                          {line.item ? line.item.name : 'No longer available'}
                          <small>{line.item ? `${line.quantity * 3} months` : 'Remove it from your cart to continue'}</small>
                        </span>
                        <strong>{line.item ? formatMoney(line.lineTotal) : ''}</strong>
                      </li>
                    ))}
                  </ul>
                  <p className="choice-total">
                    <span>Total</span>
                    <strong>{formatMoney(priced.subtotal)}</strong>
                  </p>
                  {gone.length > 0 ? (
                    <p className="form-error">
                      Something in your cart is no longer available. <Link to="/cart">Go to your cart</Link> to remove it.
                    </p>
                  ) : null}
                </>
              )}
            </aside>
          </div>
        )}
      </div>
    </main>
  );
}
```

The hidden `company` input is uncontrolled on purpose and its value is not read: `orderBody` always sends `company: ''`. A script that posts the form itself, rather than using this page, is what the tracker's trap catches. Leave it so.

- [ ] **Step 3: The confirmation page**

Create `src/pages/CheckoutDonePage.tsx`:

```tsx
import { Link, Navigate, useLocation } from 'react-router-dom';
import { PHONE_DISPLAY, PHONE_HREF } from '../data/content';
import { formatMoney } from '../lib/format';

type Placed = { orderNumber: string; total: number; email: string };

function isPlaced(value: unknown): value is Placed {
  const state = value as Partial<Placed> | null;
  return typeof state?.orderNumber === 'string' && /^LGF-[0-9]{6}$/.test(state.orderNumber);
}

/**
 * The order is in: its number, and what happens next.
 *
 * Reached only from the checkout, which hands the order over in the
 * navigation. Opened any other way there is no order to show, and it goes home.
 */
export function CheckoutDonePage() {
  const { state } = useLocation();
  if (!isPlaced(state)) return <Navigate to="/" replace />;

  return (
    <main className="page">
      <div className="page-inner page-narrow">
        <h1 className="page-title">Your order is in.</h1>
        <p className="section-lede">
          Your order number is <strong className="order-number">{state.orderNumber}</strong>
          {state.total > 0 ? `, for ${formatMoney(state.total)}` : ''}. Keep it somewhere safe.
        </p>
        <div className="notice done-next">
          <h2 className="notice-title">What happens next</h2>
          <ol className="done-steps">
            <li>{state.email ? `We have emailed a confirmation to ${state.email}.` : 'We have emailed you a confirmation.'}</li>
            <li>We will contact you about payment. Nothing has been charged yet.</li>
            <li>Once payment is received, we add you to the accounts you chose.</li>
          </ol>
          <p className="notice-body">
            Questions? Call <a href={PHONE_HREF}>{PHONE_DISPLAY}</a> and quote your order number.
          </p>
        </div>
        <p className="page-actions">
          <Link to="/" className="btn">
            Back to the home page
          </Link>
        </p>
      </div>
    </main>
  );
}
```

The numbered list is a real sequence (confirmation, payment, being added), which is why it is numbered.

- [ ] **Step 4: Routes, the cart button, styles**

In `src/App.tsx`: import both pages and add, above the `*` route:

```tsx
        <Route path="/checkout" element={<CheckoutPage />} />
        <Route path="/checkout/done" element={<CheckoutDonePage />} />
```

In `src/pages/CartPage.tsx`: replace the disabled button and the paragraph after it with:

```tsx
              {priced.lines.some((line) => line.item === null) ? (
                <>
                  <button type="button" className="btn choice-add" disabled aria-disabled="true">
                    Checkout
                  </button>
                  <p className="choice-check">Remove the tradeline that is no longer available to continue.</p>
                </>
              ) : (
                <>
                  <Link to="/checkout" className="btn choice-add">
                    Checkout
                  </Link>
                  <p className="choice-check">
                    You will enter your details next. Prefer to order by phone? Call <a href={PHONE_HREF}>{PHONE_DISPLAY}</a>.
                  </p>
                </>
              )}
```

and update the page's doc comment: replace "There is no checkout yet. The button says so." with "Checkout is the next page. A cart holding a tradeline that has gone cannot go on to it until that line is removed."

Append to `src/styles/global.css`, before the `@media print` block:

```css
/* ---------- Checkout ---------- */
.checkout-form {
  display: grid;
  gap: 28px;
  min-width: 0;
}

.form-group {
  display: grid;
  gap: 16px;
  margin: 0;
  padding: 28px;
  border: 0;
  border-radius: 24px;
  background: var(--bg-warm);
  min-width: 0;
}

.form-group legend {
  float: left;
  width: 100%;
  padding: 0;
  margin-bottom: 4px;
  font-size: 20px;
  font-weight: 800;
  font-style: italic;
  letter-spacing: -0.02em;
}

.form-group legend + * {
  clear: both;
}

.form-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.form-row-3 {
  grid-template-columns: minmax(0, 2fr) minmax(0, 1.4fr) minmax(0, 1fr);
}

.form-field {
  display: grid;
  gap: 6px;
  align-content: start;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
}

.form-field input,
.form-field select {
  width: 100%;
  min-height: 48px;
  padding: 0 14px;
  border: 1px solid var(--divider);
  border-radius: 12px;
  background: var(--bg);
  color: var(--text);
  font: inherit;
  font-size: 16px;
  font-weight: 500;
}

.form-field input:focus-visible,
.form-field select:focus-visible {
  outline: 3px solid var(--green);
  outline-offset: 1px;
}

.form-field [aria-invalid='true'] {
  border-color: #b3261e;
}

.form-secret {
  display: flex;
  gap: 8px;
}

.form-secret input {
  flex: 1;
  min-width: 0;
  letter-spacing: 0.04em;
}

.form-secret-toggle {
  flex: none;
  min-width: 64px;
  min-height: 48px;
  border: 1px solid var(--divider);
  border-radius: 12px;
  background: var(--bg);
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}

.form-error {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: #b3261e;
}

.form-hint {
  margin: 0;
  font-size: 13px;
  font-weight: 400;
  color: var(--text-secondary);
}

.form-check {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  font-size: 15px;
  cursor: pointer;
}

.form-check input {
  flex: none;
  width: 22px;
  height: 22px;
  margin: 1px 0 0;
  accent-color: var(--green);
}

.form-notice {
  margin: 0 0 24px;
  padding: 16px 20px;
  border-radius: 16px;
  border: 1px solid #b3261e;
  background: #fdf3f2;
  color: #7a1a14;
  font-size: 15px;
  font-weight: 600;
}

/* Off the page, not display:none: something filling in every field still finds it. */
.form-trap {
  position: absolute;
  left: -9999px;
  width: 1px;
  height: 1px;
  overflow: hidden;
}

.checkout-place {
  width: 100%;
  border: 0;
  font-family: inherit;
  text-align: center;
  white-space: normal;
}

.summary-lines {
  display: grid;
  gap: 14px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.summary-lines li {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  font-size: 15px;
}

.summary-lines li[data-gone='true'] {
  color: var(--text-secondary);
}

.summary-lines span {
  min-width: 0;
  font-weight: 600;
}

.summary-lines small {
  display: block;
  font-size: 13px;
  font-weight: 400;
  color: var(--text-secondary);
}

.summary-lines strong {
  flex: none;
  font-variant-numeric: tabular-nums;
}

.order-number {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.done-next {
  margin-top: 32px;
}

.done-steps {
  display: grid;
  gap: 8px;
  margin: 0 0 20px;
  padding-left: 20px;
}

@media (max-width: 899px) {
  /* The order first, then the form: what is being bought before who is buying it. */
  .checkout .choice {
    order: -1;
  }
}

@media (max-width: 599px) {
  .form-group {
    padding: 20px;
  }

  .form-row,
  .form-row-3 {
    grid-template-columns: minmax(0, 1fr);
  }
}
```

- [ ] **Step 5: Build and check what can be checked before the migration**

Run: `npm test && npm run build`
Expected: all tests pass, build completes.

With both servers running, in a browser at 1440px and 390px:

- `/checkout` with an empty cart goes to `/cart`.
- With one tradeline in the cart, `/checkout` shows the order and the form. Pressing Place order on the empty form names every empty field, focuses the first, and sends nothing (confirm in the Network panel).
- Typing an SSN writes its dashes in; Show and Hide toggle it; the field is masked by default.
- `/checkout/done` opened directly goes to `/`.
- Nothing typed appears in `localStorage` or `sessionStorage` (run `JSON.stringify(localStorage)` in the console).
- No sideways scroll at 390px.

Do NOT submit a valid form yet (Task 9).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: checkout and confirmation pages"
```

---

### Task 9: The owner runs the migration, then the full run

This task writes to the LIVE database. It cannot start until the owner has run the migration.

- [ ] **Step 1: Stop and ask the owner**

Tell the owner: run `supabase/migrations/20261014120000_tradeline_orders.sql` in the Supabase SQL Editor (and `20261013120000_tradeline_ref.sql` first, if it has not been run). Ask them to say when it is done, and to confirm that test orders with fake details may be placed and then cancelled, and that a confirmation email may be sent to a test address they name (or to none: use an `@example.com` address, which goes nowhere).

Do not continue until they have answered.

- [ ] **Step 2: Confirm the database is ready**

Signed in as an admin, `http://localhost:3001/tradelines/orders` shows "No orders yet" (not the migration sentence).

- [ ] **Step 3: Place and work real orders, in the browser**

At 1440px, then repeat the placing at 390px. Use only these details: name `Test Order DELETE ME`, email the address the owner named or `test-order@example.com`, mobile `518-555-0142`, date of birth `1990-04-10`, SSN `123-45-6789`, address `12 Sample Street`, `Albany`, `NY`, `12207`.

1. **House sale.** Clear `localStorage`. Add one tradeline, check out. Expect `/checkout/done` with an order number, an empty cart, and on the tracker's Orders page a new order marked "House sale", "Awaiting payment".
2. **Affiliate sale.** Find a real tradelines affiliate's reference number on the People page. Open `http://localhost:5173/?ref=<that number>`, add two different tradelines (one with quantity 2), check out. Expect the order to show that affiliate and a commission of `$400.00, once paid`.
3. **Their dashboard, before.** Client View as that affiliate: Income `$0.00`, the order listed as "Awaiting payment" with "$400.00 when paid", the customer's name shown, and no email, mobile, address or SSN digits anywhere in the page source.
4. **Mark paid.** As admin, open the order, Mark paid. Expect "Paid", who and when. Client View again: Income `$400.00`, Pending payout `$400.00`.
5. **Reveal.** On the order, the SSN reads `•••-••-6789`. Reveal shows `123-45-6789` and `10 Apr 1990`, and the line beneath says it was revealed once, by you. Reload: masked again.
6. **Cancel the paid order.** Expect "Cancelled", no buttons, and the affiliate's Income back to `$0.00`.
7. **A tampered total.** With a tradeline in the cart, on `/checkout` fill the form, and in the console intercept the request so `expectedTotal` is `1` (or use the browser tool's request interception). Expect the notice about a changed price with the real total, the form still filled, and no new order.
8. **A tradeline gone.** Put `[{"id":"0","quantity":1}]` in `lgf.cart` alongside a real line. Expect the cart to refuse checkout until it is removed, and `/checkout` to disable Place order and say why.
9. **Double press.** Press Place order twice quickly on a valid form. Expect one order.
10. **The email.** If a real test address was used, confirm it arrived with the order number and lines, and no SSN, date of birth or address.

- [ ] **Step 4: Clean up**

Cancel every test order that is not already cancelled. List their order numbers in the report so the owner can delete the rows if they wish. Do not delete rows yourself.

- [ ] **Step 5: Run everything**

In `SITE/`: `npm test && npm run build`. In `TRACKER/`: `npm run typecheck`, and every `scripts/*-checks.ts(x)` (`.tsx` with `--tsconfig scripts/render.tsconfig.json`). Only the four scripts named in Global Constraints may be red.

- [ ] **Step 6: Commit anything the run changed**

```bash
git add -A && git commit -m "fix: what the full checkout run turned up"   # in whichever repository changed; skip if nothing did
```

---

## What the owner does afterwards

1. Keep `ONBOARDING_SECRET_KEY` set wherever the tracker runs, and backed up. Without it the checkout refuses orders; if it is lost, stored SSNs cannot be read back.
2. Check that the privacy policy covers collecting Social Security numbers before the checkout is shown to customers.
3. Delete the test orders listed in the report, if wanted.
