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
