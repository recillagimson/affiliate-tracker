/**
 * Which approved cards somebody may ask to be paid for, and when.
 *
 * Every approval runs on its own clock. It becomes requestable 15 days after
 * the day it was approved and stays requestable until it is put on a request.
 * There is no shared payday and no cycle any more: an affiliate chooses which
 * ready cards to be paid for, and an admin pays what was asked for.
 *
 * The same 15 for everybody. Not counted from the day somebody signed, and not
 * varied by which version of the agreement they signed: two cards approved on
 * the same day are ready on the same day, whoever brought them in. The database
 * re-checks this with a literal 15 in create_payout_request's cutoff
 * (supabase/migrations/20261001120000_net_15.sql), because a SQL function
 * cannot import a TypeScript constant; scripts/payout-request-checks.ts reads
 * the newest migration that defines it and holds the literal to PAYOUT_DAYS, so the page can never
 * offer a card the database refuses.
 *
 * Pure, like lib/payout: day keys and plain rows in, answers out. No store and
 * no React, so a client component can draw the running total with it and the
 * route can run the very same rules before it ever calls the database.
 */

import { formatMoney } from './analytics';
import { addDays, dayOf, daysBetween, isDay, PAYOUT_DAYS, shortDay, totalOf } from './payout';

/** Every conversion id already committed to a live (requested or paid) request. */
export type CommittedIds = ReadonlySet<string>;

/**
 * A day key that means the day it says, or '' when there is none.
 *
 * An approval day can come back as a bare date or as a timestamp, and either
 * is counted from its own day. Anything else is refused here rather than handed
 * to the arithmetic, because daysBetween answers 0 for a day it cannot read,
 * and 0 days left is the one answer that lets money move.
 */
function readDay(value: string): string {
  const day = dayOf(value);
  return isDay(day) ? day : '';
}

/* ------------------------------------------------------------- the clock --- */

/** The day a card first becomes requestable: approved + 15. '' when the approval day is unreadable. */
export function eligibleOn(approvedOn: string): string {
  const day = readDay(approvedOn);
  return day ? addDays(day, PAYOUT_DAYS) : '';
}

/**
 * Whole days until a card can be requested. 0 or negative once it can be.
 *
 * NaN when either day is unreadable, rather than a number that would read as a
 * countdown. Every caller in this file tests for a finite count before
 * comparing it, so a broken day is never ready and never counting down.
 */
export function daysUntilEligible(approvedOn: string, today: string): number {
  const ready = eligibleOn(approvedOn);
  const now = readDay(today);
  if (!ready || !now) return Number.NaN;
  return daysBetween(now, ready);
}

/**
 * Approved on D is requestable on D+15 and every day after, never on D+14.
 *
 * The boundary is inclusive on purpose, and matches the database's own
 * `approved_on <= today - 15`: the 15th day is the day the agreement says
 * payment is due, so it is the first day somebody may ask for it.
 */
export function isEligible(approvedOn: string, today: string): boolean {
  const left = daysUntilEligible(approvedOn, today);
  return Number.isFinite(left) && left <= 0;
}

/* --------------------------------------------------------------- wording --- */

/** "Ready to request", "1 day left", "12 days left". '' when there is no day to count from. */
export function describeCountdown(approvedOn: string, today: string): string {
  const left = daysUntilEligible(approvedOn, today);
  if (!Number.isFinite(left)) return '';
  if (left <= 0) return 'Ready to request';
  return left === 1 ? '1 day left' : `${left} days left`;
}

/**
 * "Ready 3 Oct 2026", to sit beside the count.
 *
 * "12 days left" on its own makes somebody do date arithmetic to plan around
 * it; the day itself is what they put in a calendar. Said the same way whether
 * the day is still ahead or already past, since it is true either way.
 */
export function describeReadyDay(approvedOn: string): string {
  const ready = eligibleOn(approvedOn);
  return ready ? `Ready ${shortDay(ready)}` : '';
}

/**
 * "2 cards selected, $140.50", the running total under a selection.
 *
 * A comma between the two halves, not a middle dot or a dash: it reads aloud
 * the same way it reads on screen, which matters because this sits in a live
 * region a screen reader announces. The money is totalled once at the end and
 * printed by formatMoney, so it matches the payslip the request becomes.
 */
export function describeSelection(rows: { amount: number }[]): string {
  if (rows.length === 0) return 'No cards selected';
  const cards = rows.length === 1 ? '1 card' : `${rows.length} cards`;
  return `${cards} selected, ${formatMoney(totalOf(rows))}`;
}

/* ------------------------------------------------------------ candidates --- */

/**
 * `amount` must already be this viewer's own share, never a merchant gross
 * figure. Two call sites feed this type: the affiliate API route, where
 * loadAll(viewer) already returns share-adjusted amounts for an affiliate
 * viewer; and the admin Pending tab, which must explicitly run
 * asAffiliateShare(conversions, settings) first, because loadAll(adminViewer)
 * returns the merchant's gross amount instead (lib/load.ts: `gross =
 * seesEverything(viewer)`). Passing a gross figure here still type-checks, since
 * both are plain `number`, so this is a contract enforced by this comment and
 * by the call sites, not by the type system.
 */
export type Candidate = { id: string; usr: string; approvedOn: string; amount: number };

function byDay(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A viewer's own approvals, split into what can be requested now and what is
 * still counting down, each oldest approval first.
 *
 * Four kinds of row are in neither list. One worth nothing to its affiliate
 * (an LGF employee's, see shareFor) has nothing to ask for. A card already committed to a live
 * request is spoken for, however old it is. A house card (usr '') belongs to no
 * account, so nobody can ever ask for it and showing it as ready would promise
 * something the request check refuses. And a card with no readable approval day
 * has no clock to be on; the column is `date not null`, so that one is only a
 * guard.
 *
 * The order is decided here rather than on each page, so the admin's Pending
 * tab and the affiliate's own list cannot disagree about which card is next.
 * The input array is not reordered.
 */
export function splitByReadiness<T extends Candidate>(
  rows: T[],
  today: string,
  committed: CommittedIds,
): { ready: T[]; countingDown: (T & { daysLeft: number })[] } {
  const ready: T[] = [];
  const countingDown: (T & { daysLeft: number })[] = [];
  for (const row of rows) {
    if (!row.usr || committed.has(row.id)) continue;
    // Nothing to ask for: an LGF employee's approval, whose share is the
    // company's, or one the merchant paid nothing for.
    if (!(row.amount > 0)) continue;
    const left = daysUntilEligible(row.approvedOn, today);
    if (!Number.isFinite(left)) continue;
    if (left <= 0) ready.push(row);
    else countingDown.push({ ...row, daysLeft: left });
  }
  // Array sort is stable, so two cards approved the same day keep the order
  // they came in.
  ready.sort((a, b) => byDay(readDay(a.approvedOn), readDay(b.approvedOn)));
  countingDown.sort((a, b) => a.daysLeft - b.daysLeft);
  return { ready, countingDown };
}

/* --------------------------------------------------------------- request --- */

export type RequestValidation =
  | { ok: true; items: { conversionId: string; amount: number }[] }
  | { ok: false; reason: string };

function refuse(reason: string): RequestValidation {
  return { ok: false, reason };
}

/**
 * Everything the /api/payslips 'request' action checks before ever calling the
 * database: the chosen ids are this viewer's own, eligible, not duplicated, and
 * not already committed. The RPC re-checks all of this against
 * public.conversions itself and is the actual safety net (see the migration);
 * this exists so a mistaken or malicious id list gets a specific, friendly
 * answer instead of a raw database error.
 *
 * The checks run in the database's own order (duplicates, then ownership and
 * age, then committed), so the sentence somebody reads does not change with
 * whichever layer happened to catch it.
 *
 * Amounts are carried through exactly as given, unrounded and unrecomputed:
 * the snapshot a request records has to be the figure the page showed when
 * the card was chosen. The one thing refused about an amount is a figure that
 * is not a payable number at all, which the database would otherwise reject
 * with an error nobody could act on.
 */
export function validateRequestedIds(
  requestedIds: string[],
  candidates: Candidate[],
  usr: string,
  today: string,
  committed: CommittedIds,
): RequestValidation {
  if (requestedIds.length === 0) return refuse('Choose at least one approved card.');
  const unique = new Set(requestedIds);
  if (unique.size !== requestedIds.length) return refuse('The same card was selected twice.');

  const byId = new Map(candidates.map((row) => [row.id, row]));
  const items: { conversionId: string; amount: number }[] = [];
  for (const id of unique) {
    const row = byId.get(id);
    /*
     * Not yours, four ways: no such card; an account with no tracking key; a
     * house card; somebody else's. The middle two are the same hole from either
     * side, since an empty usr would otherwise match the house card's empty usr
     * and hand an account with no key the business's own money.
     */
    if (!row || !usr || !row.usr || row.usr !== usr) {
      return refuse('One of those approvals is not yours.');
    }
    if (!isEligible(row.approvedOn, today)) {
      return refuse(`One of those approvals is not ${PAYOUT_DAYS} days old yet.`);
    }
    if (committed.has(id)) {
      return refuse('One of those approvals is already on a request.');
    }
    if (typeof row.amount !== 'number' || !Number.isFinite(row.amount) || row.amount < 0) {
      return refuse('One of those approvals has no amount that can be paid.');
    }
    items.push({ conversionId: id, amount: row.amount });
  }
  return { ok: true, items };
}
