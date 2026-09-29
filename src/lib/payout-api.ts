/**
 * The rules the payout routes apply, as plain functions.
 *
 * /api/payslips (an affiliate asking to be paid, or saying the money arrived),
 * /api/payouts (an admin recording what happened) and /api/payouts/receipt all
 * make the same kinds of decision: is this body readable, is this person
 * allowed, is the request in a state where this makes sense, and which status
 * code does a store error become. None of that needs a request or a database,
 * and nothing in this repo can run a route handler under test, so the
 * decisions live here and scripts/payout-api-checks.ts pins them. A route is
 * left holding the order things happen in, which is the part worth reading in
 * a route.
 *
 * Every sentence here can reach a person, and some reach an affiliate. So none
 * has a dash in it, none names another account, and none of the affiliate ones
 * says anything about how a figure was worked out.
 *
 * Pure. The store and viewer modules are imported for their types only, and
 * the error classes are plain classes, so the checks load this file without a
 * database, a session or Next.js.
 */

import { dayOf, isDay, shortDay } from './payout';
import type { Candidate } from './payout-request';
import type { PayoutRequestStatus } from './payout-request-store';
import {
  StoreConfigError,
  StoreConflictError,
  StoreNotFoundError,
  StoreValidationError,
} from './store/errors';
import type { Conversion } from './types';
import type { Viewer } from './viewer-core';

/** What a route sends instead of doing the thing: a status, a sentence, and sometimes what to do about it. */
export type Refusal = {
  status: number;
  error: string;
  hint?: string;
  /** One sentence per form field, keyed by the body field it is about. */
  fields?: Record<string, string>;
};

const DASHES = /[\u2013\u2014]/;

/**
 * A message if it can be shown, otherwise the fallback.
 *
 * Store errors are mostly this app's own sentences, but not all of them, and
 * a sentence that has picked up a dash from somewhere is not one the pages
 * show. An empty one is no sentence at all.
 */
function sayable(message: unknown, fallback: string): string {
  return typeof message === 'string' && message.trim() !== '' && !DASHES.test(message) ? message : fallback;
}

/* ------------------------------------------------------------------- body --- */

/**
 * A parsed JSON body as a plain object, or an empty one.
 *
 * request.json() happily returns an array, a string or null, and a route that
 * cast any of those to an object would read `action` off a string. An empty
 * object makes every field absent instead, which each reader below refuses.
 */
export function asBody(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A string field, or '' when it is missing or is anything other than a string. */
export function textField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

/**
 * A bigint row id as the app carries it, a string of digits, or '' when the
 * value is not one.
 *
 * A JSON number is read as well as a string: a client holding the id as a
 * number has done nothing wrong. Past Number.MAX_SAFE_INTEGER a number is no
 * longer the id it looks like, and no id this app issues is near that.
 */
export function readRowId(value: unknown): string {
  let text = '';
  if (typeof value === 'string') text = value.trim();
  else if (typeof value === 'number' && Number.isSafeInteger(value)) text = String(value);
  return /^[1-9]\d*$/.test(text) && Number.isSafeInteger(Number(text)) ? text : '';
}

/**
 * The one answer for a request this viewer cannot have: one that never was, an
 * id that could not be one, or, on the receipt route, somebody else's.
 */
export function noSuchRequest(): Refusal {
  return { status: 404, error: 'No such payment request.' };
}

/**
 * The request a body is about.
 *
 * Missing is a 400, since the page that sent it has a bug. Present but not an
 * id is a plain not found, the same answer a well formed id for a request that
 * does not exist gets, so guessing at the shape tells nobody anything.
 */
export function readRequestId(value: unknown): { ok: true; id: string } | { ok: false; refusal: Refusal } {
  const id = readRowId(value);
  if (id) return { ok: true, id };
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    return { ok: false, refusal: { status: 400, error: 'Which payment request?' } };
  }
  return { ok: false, refusal: noSuchRequest() };
}

/* -------------------------------------------------------- store failures --- */

/**
 * Which status a store error becomes, and what it says.
 *
 * The store's own error classes carry sentences written for a person, so those
 * are shown. Anything else is a failure nobody planned a sentence for, and by
 * default it says only the fallback: its raw text can be a Postgres message
 * with ids and constraint names in it, which an affiliate has no use for and
 * should not see. The admin route opts in to showing it, the way every other
 * admin route in this app does, because an admin looking at "permission
 * denied" knows what to go and fix. The route logs the raw error either way.
 *
 * A missing database is a 503 rather than the class's own 500: nothing is
 * wrong with the request, and it will work once the environment is set.
 */
export function storeFailure(
  error: unknown,
  fallback: string,
  options: { showUnknown?: boolean } = {},
): Refusal {
  if (error instanceof StoreConfigError) return { status: 503, error: sayable(error.message, fallback) };
  if (error instanceof StoreValidationError) return { status: 422, error: sayable(error.message, fallback) };
  if (error instanceof StoreConflictError) return { status: 409, error: sayable(error.message, fallback) };
  if (error instanceof StoreNotFoundError) return { status: 404, error: sayable(error.message, fallback) };
  const shown = options.showUnknown && error instanceof Error ? sayable(error.message, fallback) : fallback;
  return { status: 500, error: shown };
}

/* ------------------------------------------------------- an affiliate asks --- */

export type PayslipAction = 'request' | 'confirm';

export function readPayslipAction(value: unknown): PayslipAction | null {
  return value === 'request' || value === 'confirm' ? value : null;
}

/**
 * Whether this viewer may do this on /api/payslips, or why not.
 *
 * Asked of the session and nothing else. An admin in Client View arrives here
 * as the affiliate, role and all, and passes: they may file a request for
 * that affiliate, the same way they can already submit that affiliate's forms,
 * and the audit line records that they did (requestedByFor). A plain admin is
 * refused. Asking to be paid is the affiliate's own call, and an admin who
 * needs to make it for them does so through Client View, where it is on the
 * record as theirs.
 *
 * Confirming needs an account id but not a tracking key: a payment already
 * made against an account is still theirs to confirm if their key has since
 * been taken away.
 *
 * An LGF employee earns no affiliate share (lib/users listNoShareKeys), so
 * they have nothing to ask for and may not request. The caller looks that up,
 * since this function reads nothing but the session. Confirming is left open:
 * a payment recorded before they became an employee is still theirs to confirm.
 */
export function payslipGate(
  viewer: Pick<Viewer, 'role' | 'id' | 'usr'>,
  action: PayslipAction,
  lgfEmployee = false,
): Refusal | null {
  if (viewer.role !== 'affiliate') {
    return {
      status: 403,
      error:
        action === 'request'
          ? 'Only an affiliate can request a payment.'
          : 'Only the affiliate who was paid can confirm a payment.',
    };
  }
  // The environment admin has no database row, so it has no payslips either.
  // It is an admin and refused above; this is the same rule for any account
  // that somehow has no id.
  if (!viewer.id) return { status: 403, error: 'This account has no payslips of its own.' };
  if (action === 'request' && !viewer.usr) {
    return { status: 403, error: 'Your account has no tracking key, so nothing can be requested.' };
  }
  if (action === 'request' && lgfEmployee) {
    return { status: 403, error: 'LGF employees are not paid through payout requests.' };
  }
  return null;
}

/**
 * The one audit line a request or a confirmation carries.
 *
 * In Client View the viewer is the affiliate, so their name alone would record
 * an admin's click as the affiliate's own. lib/impersonation.ts says actingAs
 * and the audit line are the only record that it was not; this is that line.
 */
export function requestedByFor(viewer: Pick<Viewer, 'username' | 'actingAs'>): string {
  return viewer.actingAs ? `${viewer.username} (via ${viewer.actingAs.adminName})` : viewer.username;
}

/**
 * More than anybody has ever had ready at once, and few enough that a hand-made
 * body cannot make one request expensive to check.
 */
export const MAX_CARDS_PER_REQUEST = 200;

/** Longer than any id either store issues. */
const MAX_ID_LENGTH = 64;

/**
 * The card ids a request body names, read for shape and nothing else.
 *
 * Whether they are this person's, old enough and free is validateRequestedIds'
 * question, and then the database's. Two things are deliberately left to it:
 * an empty list, and the same id twice. Its answer is the one the database
 * would give, and merging duplicates here would turn a client bug into a
 * request that is quietly different from what was sent.
 *
 * The id format is left to the store too. Conversion ids are digits on
 * Supabase and "<row>:<hash>" on the Sheets store, and the request store
 * refuses anything that is not a row id with a sentence of its own.
 */
export function readConversionIds(
  value: unknown,
): { ok: true; ids: string[] } | { ok: false; refusal: Refusal } {
  const unreadable = {
    ok: false as const,
    refusal: { status: 400, error: 'Those cards could not be read.', hint: 'Reload the page and choose them again.' },
  };
  if (!Array.isArray(value)) return unreadable;
  if (value.length > MAX_CARDS_PER_REQUEST) {
    return {
      ok: false,
      refusal: {
        status: 422,
        error: 'That is more cards than one request can take.',
        hint: `Choose up to ${MAX_CARDS_PER_REQUEST} at a time.`,
      },
    };
  }
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.length > 0 && entry.length <= MAX_ID_LENGTH) ids.push(entry);
    else if (typeof entry === 'number' && Number.isSafeInteger(entry) && entry > 0) ids.push(String(entry));
    else return unreadable;
  }
  return { ok: true, ids };
}

/**
 * This viewer's approvals as request candidates, or null when they must not be
 * priced from.
 *
 * loadAll hands an affiliate their own share of each approval, already at the
 * rate in force the day it was approved, and that is the figure a request
 * snapshots. A gross load is the merchant's money. For an affiliate viewer it
 * cannot happen, since loadAll decides gross from the same role this route has
 * already gated on, but a request records its amounts forever, so it is
 * refused here rather than trusted never to happen.
 */
export function candidatesFrom(load: { conversions: Conversion[]; gross: boolean }): Candidate[] | null {
  if (load.gross) return null;
  return load.conversions.map((row) => ({
    id: row.id,
    usr: row.usr,
    approvedOn: row.approvedOn,
    amount: row.amount,
  }));
}

const UNPROCESSED = 'That could not be processed.';

/**
 * What a failed create_payout_request becomes.
 *
 * A conflict is always the same sentence, because there is only one thing it
 * can mean for somebody filing a request: a card they chose went onto another
 * request between the page loading and the click, most often their own
 * double submit. The rest go through storeFailure, with raw text hidden.
 */
export function requestFailure(error: unknown): Refusal {
  if (error instanceof StoreConflictError) {
    return {
      status: 409,
      error: 'One of those approvals is already on a request.',
      hint: 'Reload the page to see which cards are still ready.',
    };
  }
  const refusal = storeFailure(error, UNPROCESSED);
  return refusal.status === 500 ? { ...refusal, hint: 'Try again in a moment.' } : refusal;
}

/* ---------------------------------------------------- an admin records it --- */

export type PayoutAction = 'pay' | 'clear' | 'proof' | 'remove-proof' | 'cancel';

const PAYOUT_ACTIONS: readonly string[] = ['pay', 'clear', 'proof', 'remove-proof', 'cancel'];

export function readPayoutAction(value: unknown): PayoutAction | null {
  return typeof value === 'string' && PAYOUT_ACTIONS.includes(value) ? (value as PayoutAction) : null;
}

/**
 * The refusal for touching a request that has been cancelled.
 *
 * Used twice by the route, and it has to say the same thing both times: once
 * when the row it read was already cancelled, and once when the store write
 * matched nothing because a cancel landed between that read and the write.
 * From the admin's side those are the same event.
 */
export function cancelledRefusal(action: Exclude<PayoutAction, 'cancel'>): Refusal {
  const error = {
    pay: 'That request was cancelled and cannot be paid.',
    clear: 'That request was cancelled, so there is no payment on it to clear.',
    proof: 'That request was cancelled, so a receipt cannot be attached to it.',
    'remove-proof': 'That request was cancelled, so its receipt cannot be changed.',
  }[action];
  return { status: 409, error, hint: 'Reload the page to see where it stands.' };
}

/**
 * Whether a request in this state can take this action, or why not.
 *
 * Cancelled is terminal: nothing is recorded against it. Paid cannot be
 * cancelled directly, only cleared first, which is the same undo-then-decide
 * sequence the Clear button has always modelled; the database refuses it too
 * (LG006). Everything else is allowed in either live state, since recording a
 * payment again is how one gets corrected.
 */
export function stateRefusal(action: PayoutAction, status: PayoutRequestStatus): Refusal | null {
  if (action === 'cancel') {
    if (status === 'requested') return null;
    if (status === 'paid') {
      return {
        status: 409,
        error: 'Only an unpaid request can be cancelled.',
        hint: 'Clear the payment first, then cancel it.',
      };
    }
    return {
      status: 409,
      error: 'That request is already cancelled.',
      hint: 'Its cards are already free to be requested again.',
    };
  }
  return status === 'cancelled' ? cancelledRefusal(action) : null;
}

export type PaymentInput = { amount: number; paidOn: string; reference: string; note: string };

/** Larger than any payout this app has made, so a figure past it is a typo rather than a payment. */
export const MAX_PAYMENT = 1_000_000;

/**
 * An amount as a number, or NaN.
 *
 * Deliberately stricter than Number(). Number('') and Number(null) are both 0,
 * which would record a payment of nothing when the field was simply left
 * empty, and Number('0x10') is 16. Plain decimal digits or a finite number,
 * and nothing else.
 */
function readAmount(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value === 'string') {
    const text = value.trim();
    if (/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return Number(text);
  }
  return Number.NaN;
}

/**
 * Rounded to cents the way the numeric(12, 2) column will round it, half away
 * from zero, without the float error in amount * 100: 140.505 * 100 is
 * 14050.499999999998, which Math.round would take down to 140.50.
 */
function toCents(value: number): number {
  const shifted = Number(`${value}e2`);
  return (Number.isFinite(shifted) ? Math.round(shifted) : Math.round(value * 100)) / 100;
}

/**
 * A payment as the admin form sends it, or the fields to fix.
 *
 * Both fields are checked before answering, so a form with two mistakes shows
 * both rather than one at a time.
 *
 * A payment is something that happened. Recording one for next Tuesday would
 * put a date on somebody's payslip that no money matches. And it cannot be
 * for a request that had not been made yet, which is the only way a day
 * before the request can be typed: it is a payment for something else.
 */
export function readPayment(
  body: Record<string, unknown>,
  today: string,
  requestedAt: string,
): { ok: true; payment: PaymentInput } | { ok: false; refusal: Refusal } {
  const fields: Record<string, string> = {};

  const raw = readAmount(body.amount);
  const amount = Number.isFinite(raw) ? toCents(raw) : Number.NaN;
  if (!Number.isFinite(amount) || amount < 0) {
    fields.amount = 'What was sent.';
  } else if (amount > MAX_PAYMENT) {
    fields.amount = 'That is larger than any payout this app has made. Check the figure.';
  }

  const paidOn = textField(body, 'paidOn').trim() || today;
  const askedOn = dayOf(requestedAt);
  if (!isDay(paidOn) || paidOn > today) {
    fields.paidOn = 'The day it was sent. It cannot be in the future.';
  } else if (isDay(askedOn) && paidOn < askedOn) {
    fields.paidOn = `This request was not made until ${shortDay(askedOn)}.`;
  }

  if (Object.keys(fields).length > 0) {
    return { ok: false, refusal: { status: 422, error: 'Please check the highlighted fields.', fields } };
  }
  return {
    ok: true,
    payment: { amount, paidOn, reference: textField(body, 'reference'), note: textField(body, 'note') },
  };
}

/* --------------------------------------------------------------- receipts --- */

/**
 * Whether this viewer may open the receipt on a request owned by this user.
 *
 * An admin, or the person the payment was made to: the affiliate needs it as
 * much as anybody, since it is the evidence they were paid. An admin in Client
 * View is the affiliate here, and sees only what that affiliate would. A blank
 * id is never an owner, so an account without one cannot match a row that
 * somehow has none either.
 */
export function mayReadReceipt(viewer: Pick<Viewer, 'role' | 'id'>, ownerUserId: string): boolean {
  if (viewer.role === 'admin') return true;
  return viewer.id !== '' && viewer.id === ownerUserId;
}
