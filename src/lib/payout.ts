/**
 * The day arithmetic every payout screen counts with.
 *
 * Nobody is paid on a schedule. Each approved card waits PAYOUT_DAYS from the
 * day it was approved; after that the affiliate chooses which ready cards to
 * ask for, and an admin pays the request. The rules for that live in
 * lib/payout-request and the records in lib/payout-request-store. What is left
 * here is what those rules count with: a day key read out of whatever a
 * database hands back, days added and counted across month ends and leap
 * years, a day printed the way people read it, and money added up once rather
 * than per row.
 *
 * Everything in this file is arithmetic on day keys and plain numbers. No rows,
 * no store, no React, so a client component can use it as freely as a route,
 * and all of it can be checked without a database (scripts/payout-checks.ts).
 */

import { PAYMENT_DAYS } from './agreement';

/**
 * How long an approval waits before it can be requested, in days. Net 15 in
 * the agreement and the same 15 here, for every affiliate whichever version
 * they signed. The database repeats it as a literal in create_payout_request,
 * and scripts/payout-request-checks.ts holds that literal to this number.
 */
export const PAYOUT_DAYS = PAYMENT_DAYS;

const DAY_MS = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ days --- */

/** The UTC day a timestamp falls on, as a key. '' for anything unreadable. */
export function dayOf(value: string | null | undefined): string {
  if (!value) return '';
  const text = String(value);
  /*
   * A day key, or a timestamp that opens with one, is taken as it stands.
   * Parsing "2026-08-15" and re-formatting it can move it a day in either
   * direction depending on where the server is, and a ready date that moves
   * with the server's timezone is a date nobody can check.
   */
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  // Postgres writes "2026-08-24 20:12:01.308994+00", which is not an ISO
  // string. Normalised rather than handed to the engine and hoped for.
  const parsed = Date.parse(text.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
  if (!Number.isFinite(parsed)) return '';
  return new Date(parsed).toISOString().slice(0, 10);
}

function stamp(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

/** `day` moved on by `days`, as a day key. An unreadable day comes back as it was. */
export function addDays(day: string, days: number): string {
  const at = stamp(day);
  if (!Number.isFinite(at)) return day;
  return new Date(at + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Whole days from `from` to `to`. Negative when `to` is the earlier one.
 *
 * 0 when either end is unreadable, which is the same answer as "today". A
 * caller that must not mistake a broken date for a ready one checks isDay
 * first, as lib/payout-request does.
 */
export function daysBetween(from: string, to: string): number {
  const a = stamp(from);
  const b = stamp(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / DAY_MS);
}

/**
 * A key that means the day it says.
 *
 * The shape is not enough. V8 reads "2026-02-30" as 2 March rather than
 * refusing it, so a typed date that does not exist would quietly become a
 * different one, and a card would count down to a day nobody chose. Printing
 * it back and comparing is the only way to catch that.
 */
export function isDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const at = stamp(value);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value;
}

/* --------------------------------------------------------------- wording --- */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "15 Aug 2026". The same shape as formatDay in lib/analytics, built here so
 *  the countdown and the payslip can print a day without a module of
 *  aggregation behind it. Anything unreadable is handed back unchanged. */
export function shortDay(day: string): string {
  const key = dayOf(day);
  if (!isDay(key)) return day;
  const [year, month, date] = key.split('-');
  return `${Number(date)} ${MONTHS[Number(month) - 1]} ${year}`;
}

/* ----------------------------------------------------------- what is owed --- */

/**
 * What a request, or a set of chosen cards, comes to. Rounded once at the end
 * rather than per row: half a cent rounded per line is a total that does not
 * match the lines somebody is reading. Takes anything with an amount, since
 * summing needs no approval day and a payout request's items carry none.
 */
export function totalOf<T extends { amount: number }>(rows: T[]): number {
  return Math.round(rows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0) * 100) / 100;
}

/**
 * Whether what was paid matches what the request came to.
 *
 * Worth asking, because the paid figure is typed by hand when the transfer is
 * recorded and can honestly differ from what was asked for. The page says so
 * rather than quietly showing one number as though it were both, since the
 * paid one is what left the bank.
 */
export function settlesUp(computed: number, paid: number | null): boolean {
  if (paid === null) return true;
  return Math.abs(computed - paid) < 0.005;
}
