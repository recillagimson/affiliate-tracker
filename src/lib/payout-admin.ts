/**
 * The admin payouts page, worked out before it is drawn.
 *
 * Two tabs read from the same four fetches. Requests is every payment an
 * affiliate has asked for, sorted into what needs paying, what has been paid
 * and what was withdrawn. Pending is every approved card that is not on a
 * request yet, split into what the affiliate could ask for today and what is
 * still counting down to its 45th day.
 *
 * Everything that decides which section a row sits in, which row comes first,
 * what a figure adds up to and what a sentence says lives here rather than in
 * the components, for the reason lib/payout-request gives for its own rules:
 * a payout screen that puts a request in the wrong section looks exactly as
 * tidy as one that puts it in the right one. Pure functions can be checked
 * against fixtures (scripts/payout-admin-checks.ts); a component can only be
 * looked at.
 *
 * Pure, and safe in a client component. The store is only ever imported for
 * its types, so the requests tab can filter and total on the client without
 * dragging a database client into the browser bundle.
 */

import { formatMoney, type ConversionView } from './analytics';
import { maskAccount } from './mask';
import { dayOf, PAYOUT_DAYS, settlesUp, shortDay, totalOf } from './payout';
import {
  daysUntilEligible,
  describeCountdown,
  describeReadyDay,
  splitByReadiness,
  type CommittedIds,
} from './payout-request';
import type { PayoutRequestRecord, PayoutRequestStatus } from './payout-request-store';
import { BLANK } from './report-table';

/* ----------------------------------------------------------------- people --- */

/** Who a row is about, as the page prints them. */
export type Person = { name: string; usr: string };

/** The part of an onboarding summary this page needs. */
export type PersonSource = { userId: string; fullName: string; username: string; usr: string };

/**
 * What a request filed under an account the roster does not list is called.
 *
 * Said rather than left blank. The foreign key means the account exists, so a
 * request with nobody's name on it is a roster that failed to list somebody,
 * and an admin paying it should be able to see that before they send money.
 */
export const UNKNOWN_ACCOUNT = 'Unknown account';

/**
 * The roster, indexed both ways the page needs it.
 *
 * A request carries only the account id it was filed under, so the Requests
 * tab looks people up by `userId`. An approval carries only the tracking key it
 * arrived with, so the Pending tab looks them up by `usr`. One read of
 * listOnboarding feeds both, so a person cannot have one name on one tab and
 * another on the other.
 *
 * An account with no key is never indexed under the empty key. That key is
 * what every house approval carries, and indexing somebody under it would put
 * their name on the business's own cards.
 */
export function indexPeople(people: PersonSource[]): {
  byUserId: Map<string, Person>;
  byUsr: Map<string, Person>;
} {
  const byUserId = new Map<string, Person>();
  const byUsr = new Map<string, Person>();
  for (const person of people) {
    const entry = { name: person.fullName.trim() || person.username, usr: person.usr };
    if (person.userId) byUserId.set(person.userId, entry);
    if (person.usr && !byUsr.has(person.usr)) byUsr.set(person.usr, entry);
  }
  return { byUserId, byUsr };
}

/** Whether a row belongs to whoever was typed into the search box: a person, by name or key. */
export function matchesPerson(person: { name: string; usr: string }, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return `${person.name} ${person.usr}`.toLowerCase().includes(needle);
}

/** The rows that match, in the order they were given. */
export function filterRequests<T extends { name: string; usr: string }>(rows: T[], query: string): T[] {
  return rows.filter((row) => matchesPerson(row, query));
}

/* --------------------------------------------------------------- requests --- */

/** One card on a request, labelled for an admin about to pay for it. */
export type RequestCard = {
  conversionId: string | null;
  card: string;
  customer: string;
  /** A day key, or '' when the approval behind the line is gone. */
  approvedOn: string;
  /** The snapshot recorded when the request was made. Never the approval as it reads today. */
  amount: number;
};

/**
 * A request as the Requests tab draws it: the record, a name to put on it,
 * and its cards labelled.
 *
 * The receipt is reduced to whether there is one and when it came. The row is
 * handed to a client component, and nothing on the row needs the file's type
 * or who uploaded it.
 */
export type RequestRow = {
  id: string;
  userId: string;
  name: string;
  usr: string;
  status: PayoutRequestStatus;
  requestedAt: string;
  requestedBy: string;
  totalAmount: number;
  amount: number | null;
  paidAt: string | null;
  paidBy: string;
  reference: string;
  note: string;
  proof: { name: string; at: string | null } | null;
  confirmedAt: string | null;
  cancelledAt: string | null;
  cancelledBy: string;
  cards: RequestCard[];
};

/**
 * Join each request to the person it was filed under and to the approvals it
 * covers.
 *
 * A card's name, customer and approval day are looked up from the approvals
 * the page loaded; its amount is not. The amount is the snapshot the request
 * recorded, because that is the figure the affiliate chose and the figure the
 * payment is made against. Reading today's amount off the approval instead
 * would let a corrected approval quietly reprice a request already paid.
 *
 * A line whose approval cannot be found reads as a blank rather than being
 * dropped. That is a released line whose approval was deleted after its
 * request was cancelled (conversion_id went null), or an approval the page
 * could not read. Either way the line and its amount are still part of what
 * the request came to, so they stay on the list.
 */
export function buildRequestRows(
  records: PayoutRequestRecord[],
  byUserId: Map<string, Person>,
  views: ConversionView[],
): RequestRow[] {
  const viewsById = new Map(views.map((row) => [row.id, row]));
  return records.map((record) => {
    const person = byUserId.get(record.userId);
    return {
      id: record.id,
      userId: record.userId,
      name: person?.name || UNKNOWN_ACCOUNT,
      usr: person?.usr ?? '',
      status: record.status,
      requestedAt: record.requestedAt,
      requestedBy: record.requestedBy,
      totalAmount: record.totalAmount,
      amount: record.amount,
      paidAt: record.paidAt,
      paidBy: record.paidBy,
      reference: record.reference,
      note: record.note,
      proof: record.proof ? { name: record.proof.name, at: record.proof.at } : null,
      confirmedAt: record.confirmedAt,
      cancelledAt: record.cancelledAt,
      cancelledBy: record.cancelledBy,
      cards: record.items.map((item) => {
        const found = item.conversionId === null ? undefined : viewsById.get(item.conversionId);
        return {
          conversionId: item.conversionId,
          card: found?.card || BLANK,
          customer: found?.client || BLANK,
          approvedOn: found ? dayOf(found.approvedOn) : '',
          amount: item.amount,
        };
      }),
    };
  });
}

/**
 * The Requests tab's sections, in the order they are dealt with.
 *
 * Sections rather than a status column to sort on, for the reason the old
 * schedule gave for its bands: a request waiting to be paid and one paid last
 * week are different kinds of thing, and one list ordered by date makes the
 * admin do the sorting.
 */
export const REQUEST_SECTIONS: { key: PayoutRequestStatus; label: string; blurb: string }[] = [
  {
    key: 'requested',
    label: 'Needs payment',
    blurb: 'Submitted by the affiliate. Record the payment once it is sent.',
  },
  { key: 'paid', label: 'Paid', blurb: 'Recorded as paid. Each one wants a receipt against it.' },
  {
    key: 'cancelled',
    label: 'Cancelled',
    blurb: 'Withdrawn before payment. The cards are free to be requested again.',
  },
];

/* ------------------------------------------------- filtering the requests -- */

/** Everything, or one of the three sections. */
export type RequestFilter = 'all' | PayoutRequestStatus;

/**
 * The filter's options: everything first, then the sections in the order the
 * page draws them, each named exactly as its section heading is. Two names for
 * one set of requests is two things for a reader to reconcile.
 */
export const REQUEST_FILTERS: { key: RequestFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  ...REQUEST_SECTIONS.map((section) => ({ key: section.key as RequestFilter, label: section.label })),
];

/** A filter read off the URL. Anything unrecognised is everything, never nothing. */
export function requestFilterFrom(raw: unknown): RequestFilter {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return REQUEST_FILTERS.some((option) => option.key === value) ? (value as RequestFilter) : 'all';
}

export function matchesRequestFilter(row: { status: PayoutRequestStatus }, filter: RequestFilter): boolean {
  return filter === 'all' || row.status === filter;
}

/**
 * How many requests each option would show, over the rows it is offered
 * against — so the counts follow the name search above them rather than
 * promising rows that search has already taken away.
 */
export function countRequestsByStatus(rows: { status: PayoutRequestStatus }[]): Record<RequestFilter, number> {
  const counts: Record<RequestFilter, number> = { all: rows.length, requested: 0, paid: 0, cancelled: 0 };
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

/**
 * A timestamp as milliseconds, or NaN.
 *
 * PostgREST writes ISO strings, but Postgres itself writes
 * "2026-10-03 09:00:00+00", which is not one; normalised the way lib/payout's
 * dayOf does rather than handed to the engine and hoped for. Compared as
 * instants rather than as strings, because "+00:00" and "Z" sort differently
 * as text and mean the same moment.
 */
function instant(value: string | null): number {
  if (!value) return Number.NaN;
  return Date.parse(value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
}

/** Request ids are bigint row ids carried as strings, so "12" comes after "7". */
function compareIds(a: string, b: string): number {
  const x = Number(a);
  const y = Number(b);
  if (Number.isFinite(x) && Number.isFinite(y) && x !== y) return x - y;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Order two rows by a timestamp, oldest first (`1`) or newest first (`-1`).
 *
 * A time nobody can read cannot be placed, so it goes to the bottom in either
 * direction rather than to whichever end NaN happens to land. A tie goes to
 * the id in the same direction: the lower id was filed first.
 */
function byTime(pick: (row: RequestRow) => string | null, direction: 1 | -1) {
  return (a: RequestRow, b: RequestRow): number => {
    const x = instant(pick(a));
    const y = instant(pick(b));
    const readX = Number.isFinite(x);
    const readY = Number.isFinite(y);
    if (readX !== readY) return readX ? -1 : 1;
    if (readX && x !== y) return (x - y) * direction;
    return compareIds(a.id, b.id) * direction;
  };
}

export type RequestGroups = Record<PayoutRequestStatus, RequestRow[]>;

/**
 * Every row in exactly one section, each section in its own order.
 *
 * Needs payment is oldest request first, because the request somebody has
 * waited longest on is the one to pay next. Paid and Cancelled are newest
 * first, because the last thing done is the thing somebody comes back to
 * check. New arrays; the rows handed in keep their order.
 */
export function groupRequests(rows: RequestRow[]): RequestGroups {
  const groups: RequestGroups = { requested: [], paid: [], cancelled: [] };
  for (const row of rows) groups[row.status].push(row);
  groups.requested.sort(byTime((row) => row.requestedAt, 1));
  groups.paid.sort(byTime((row) => row.paidAt, -1));
  groups.cancelled.sort(byTime((row) => row.cancelledAt, -1));
  return groups;
}

/**
 * What the unpaid requests come to: the page's one highlighted figure.
 *
 * Requested only. A paid request is money already sent, and a cancelled one is
 * money nobody is owed, so rolling either in would make the figure mean
 * nothing on any given day. Summed from the snapshots, rounded once.
 */
export function awaitingPayment(rows: RequestRow[]): number {
  return totalOf(rows.filter((row) => row.status === 'requested').map((row) => ({ amount: row.totalAmount })));
}

/** How many requests need paying, for the count on the Requests tab. */
export function countRequested(rows: RequestRow[]): number {
  return rows.filter((row) => row.status === 'requested').length;
}

/** "1 card", "3 cards". */
export function describeCardCount(count: number): string {
  return count === 1 ? '1 card' : `${count} cards`;
}

/**
 * The status badge.
 *
 * Gold for a request waiting on an admin, which is what gold means in this app:
 * deal with me. Green for paid, which is the only thing green means here.
 * Quiet for cancelled, which asks nothing of anybody.
 */
export function statusChip(status: PayoutRequestStatus): { label: string; className: string } {
  if (status === 'paid') return { label: 'Paid', className: 'chip chip-live' };
  if (status === 'cancelled') return { label: 'Cancelled', className: 'chip chip-quiet' };
  return { label: 'Requested', className: 'chip chip-gold' };
}

/**
 * "Requested 5 Oct 2026", "by dana (via Mark)".
 *
 * The second line is printed exactly as it was stored. When an admin files a
 * request through Client View the route writes their name in brackets, and
 * that line is the only record anywhere that an admin was at the keyboard.
 */
export function describeRequested(row: Pick<RequestRow, 'requestedAt' | 'requestedBy'>): {
  when: string;
  by: string;
} {
  const day = dayOf(row.requestedAt);
  const who = row.requestedBy.trim();
  return { when: day ? `Requested ${shortDay(day)}` : '', by: who ? `by ${who}` : '' };
}

/** "Cancelled 9 Oct 2026", "by mark". Nothing for a request that is not cancelled. */
export function describeCancelled(row: Pick<RequestRow, 'status' | 'cancelledAt' | 'cancelledBy'>): {
  when: string;
  by: string;
} {
  if (row.status !== 'cancelled') return { when: '', by: '' };
  const day = dayOf(row.cancelledAt);
  const who = row.cancelledBy.trim();
  return { when: day ? `Cancelled ${shortDay(day)}` : '', by: who ? `by ${who}` : '' };
}

/**
 * The banner under a paid request whose payment is not what was asked for.
 *
 * The two drift honestly: a transfer gets rounded, or settled against
 * something else, and the admin types what actually left the bank. Said out
 * loud rather than resolved quietly, since either figure could be the mistake
 * and only a person can tell which. Half a cent either way is the same money.
 */
export function mismatchNote(row: Pick<RequestRow, 'status' | 'totalAmount' | 'amount'>): string {
  if (row.status !== 'paid' || row.amount === null) return '';
  if (settlesUp(row.totalAmount, row.amount)) return '';
  return `Paid ${formatMoney(row.amount)} against ${formatMoney(row.totalAmount)} requested. An admin may have entered a different figure than what was asked for.`;
}

/**
 * Whether a request can be cancelled from the page.
 *
 * Only an unpaid one. A paid request is cleared first, which is the same "undo,
 * then decide" order the database enforces (cancel_payout_request raises LG006
 * otherwise); a cancelled one is already over. Offering the control anywhere
 * else would be offering a button that can only fail.
 */
export function canCancel(status: PayoutRequestStatus): boolean {
  return status === 'requested';
}

/** Asked before a request is cancelled. Cancelling cannot be undone from the page. */
export const CANCEL_CONFIRM =
  'Cancel this request? Its cards go back to Pending and the affiliate would need to request them again.';

export function cancelledMessage(name: string): string {
  return `Request cancelled for ${name}.`;
}

/**
 * What is said once a payment is saved, in the words of the button pressed.
 *
 * The same button reads "Record payment" on an unpaid request and "Save
 * payment" on a paid one, where pressing it corrects what is already there.
 * "Payment recorded" after a correction would read as a second payment.
 */
export function paymentMessage(name: string, alreadyPaid: boolean): string {
  return alreadyPaid ? `Payment updated for ${name}.` : `Payment recorded for ${name}.`;
}

/** The same for a receipt: "Attach receipt" where there was none, "Replace receipt" once one is on file. */
export function receiptMessage(name: string, replacing: boolean): string {
  return replacing ? `Receipt replaced for ${name}.` : `Receipt attached for ${name}.`;
}

/**
 * The id of a request row's own button, the one that opens its panel.
 *
 * It is the one control a request has in every state (Record payment, Edit
 * payment, Show cards), so it is where the keyboard goes back to when an action
 * takes away the control that had it. Recording or clearing a payment moves the
 * row to another section, and cancelling takes its menu away.
 */
export function requestToggleId(requestId: string): string {
  return `request-${requestId}-toggle`;
}

/**
 * The body of a post to /api/payouts about one request.
 *
 * The id goes on last, so nothing in the action's own fields can change which
 * request it is about. A stray requestId spread over it would record a real
 * payment against somebody else's request.
 */
export function requestBody(requestId: string, body: Record<string, unknown>): Record<string, unknown> {
  return { ...body, requestId };
}

/** What the Requests tab says when it has no rows to show. */
export function noRequestsText(total: number, query: string): string {
  if (total === 0) {
    return `No requests yet. Once a card is ${PAYOUT_DAYS} days old, the affiliate can ask to be paid for it, and it will show up here.`;
  }
  return `Nobody matches “${query.trim()}”.`;
}

/* -------------------------------------------------------------------- tab --- */

export type PayoutTab = 'requests' | 'pending';

/**
 * Which tab a ?tab= value opens.
 *
 * Exactly "pending" opens Pending, and anything else, including no value, a
 * misspelling or the parameter given twice, opens Requests. A link somebody
 * mistyped should land on the tab that needs doing, not on an error.
 */
export function tabFrom(value: string | string[] | undefined): PayoutTab {
  return value === 'pending' ? 'pending' : 'requests';
}

/* ---------------------------------------------------------------- pending --- */

/** One approval on the Pending tab. */
export type PendingRow = {
  id: string;
  name: string;
  usr: string;
  card: string;
  customer: string;
  approvedOn: string;
  /** The affiliate's own share. See buildPending. */
  amount: number;
  /** Whole days until it can be requested; 0 or less once it can. */
  daysLeft: number;
  /** "Ready to request", "1 day left", "12 days left". */
  countdown: string;
  /** "Ready 16 Oct 2026". */
  readyDay: string;
};

export type PendingSplit = {
  ready: PendingRow[];
  countingDown: PendingRow[];
  /**
   * Every card that belongs to somebody, on a request or not. Only used to
   * tell "nothing has ever been approved" from "everything has been asked for".
   */
  approved: number;
};

/**
 * The Pending tab: which cards an affiliate could ask for today, and which are
 * still counting down.
 *
 * `views` must already be priced as the affiliate's share. The page reads
 * approvals as an admin, which means gross, so it runs asAffiliateShare first
 * and describeConversions with gross switched off, and the amount here is read
 * straight off those rows. That is the Candidate contract in lib/payout-request
 * and it is not something a type can hold, so payout-admin-checks runs the
 * page's own chain and pins the result.
 *
 * The split itself is splitByReadiness, so this tab and the affiliate's own
 * page agree on what is ready, in what order, and that house cards and cards
 * already on a request are on neither list.
 */
export function buildPending(
  views: ConversionView[],
  byUsr: Map<string, Person>,
  today: string,
  committed: CommittedIds,
): PendingSplit {
  const toRow = (row: ConversionView, daysLeft: number): PendingRow => ({
    id: row.id,
    // A key with no account behind it still arrived on a link, and the link
    // has a name on it. Better than a bare key, and better than nothing.
    name: byUsr.get(row.usr)?.name || row.person || row.usr,
    usr: row.usr,
    card: row.card || BLANK,
    customer: row.client || BLANK,
    approvedOn: dayOf(row.approvedOn),
    amount: row.amount,
    daysLeft,
    countdown: describeCountdown(row.approvedOn, today),
    readyDay: describeReadyDay(row.approvedOn),
  });

  const { ready, countingDown } = splitByReadiness(views, today, committed);
  return {
    ready: ready.map((row) => toRow(row, daysUntilEligible(row.approvedOn, today))),
    countingDown: countingDown.map((row) => toRow(row, row.daysLeft)),
    approved: views.filter((row) => row.usr !== '').length,
  };
}

export const PENDING_SECTIONS: { key: 'ready' | 'countingDown'; label: string; blurb: string }[] = [
  {
    key: 'ready',
    label: 'Ready to request',
    blurb: `${PAYOUT_DAYS} days have passed. Nothing happens until the affiliate asks to be paid.`,
  },
  {
    key: 'countingDown',
    // Named for the rule rather than for the motion: "Counting down" says
    // something is happening, and the question an admin has on this tab is
    // which cards cannot be paid yet and why.
    label: `Not yet ${PAYOUT_DAYS} days`,
    blurb: 'Not old enough to request yet.',
  },
];

/**
 * The line above the Pending lists.
 *
 * A plain sentence, not the gold figure the Requests tab has. Nothing on this
 * tab is owed yet: a ready card is only money once somebody asks for it.
 */
export function describePending(split: { ready: { amount: number }[]; countingDown: unknown[] }): string {
  const ready = split.ready.length;
  const waiting = split.countingDown.length;
  if (ready === 0 && waiting === 0) return '';
  if (ready === 0) return `Nothing is ready to request yet. ${waiting} still counting down.`;
  const head = `${ready} ready to request, worth ${formatMoney(totalOf(split.ready))}.`;
  return waiting === 0 ? head : `${head} ${waiting} more still counting down.`;
}

/** What the Pending tab says when both lists are empty, which means one of two quite different things. */
export function pendingEmptyText(approved: number): string {
  return approved === 0
    ? 'No approved cards yet. This tab fills up as approvals come in.'
    : 'Nothing waiting. Every eligible card has already been requested.';
}

/* ------------------------------------------------------- who is being paid -- */

/**
 * The person behind a request, as the approve dialog needs them: who they are
 * and where the money goes.
 *
 * Assembled on the server from the roster the page already reads and the bank
 * rows beside it, so the dialog is drawing data rather than fetching it, and
 * one panel cannot describe somebody differently from another.
 *
 * The account number is NOT in here. `last4` is what a bank row carries
 * unsealed; the whole number is a separate, deliberate request against
 * /api/onboarding/[userId]/reveal, the same one the person's own page makes.
 */
export type Payee = {
  userId: string;
  name: string;
  username: string;
  email: string;
  mobile: string;
  position: string;
  usr: string;
  bank: { accountName: string; bankName: string; last4: string; savedAt: string } | null;
};

/** Keyed by account id, which is what a request carries. A plain object: it crosses to the browser. */
export function buildPayees(
  people: { userId: string; username: string; fullName: string; email: string; position: string; mobile: string; usr: string }[],
  banks: { userId: string; savedAt: string; accountName: string; bankName: string; accountLast4: string }[],
): Record<string, Payee> {
  const byUser = new Map(banks.map((bank) => [bank.userId, bank]));
  const payees: Record<string, Payee> = {};
  for (const person of people) {
    const bank = byUser.get(person.userId);
    payees[person.userId] = {
      userId: person.userId,
      // A roster row always has a username; a full name is filled in later, so
      // an account part-way through onboarding still has something to be called.
      name: person.fullName.trim() || person.username,
      username: person.username,
      email: person.email,
      mobile: person.mobile,
      position: person.position,
      usr: person.usr,
      bank: bank
        ? {
            accountName: bank.accountName,
            bankName: bank.bankName,
            last4: bank.accountLast4,
            savedAt: bank.savedAt,
          }
        : null,
    };
  }
  return payees;
}

/** Who they are, in the order somebody checks a payment against: blanks left out. */
export function payeeContactLines(payee: Payee): { label: string; value: string }[] {
  return [
    { label: 'Username', value: payee.username },
    { label: 'Email', value: payee.email },
    { label: 'Mobile', value: payee.mobile },
    { label: 'Position', value: payee.position },
    { label: 'Tracking key', value: payee.usr },
  ].filter((line) => line.value.trim() !== '');
}

/**
 * Where the money goes. Said plainly when there is nowhere: an admin may have
 * paid another way, and a blank panel would read as a page that failed to load.
 */
export function payeeBankLines(payee: Payee): { label: string; value: string }[] {
  if (!payee.bank) return [{ label: 'Bank details', value: 'No bank details on file' }];
  return [
    { label: 'Account name', value: payee.bank.accountName },
    { label: 'Bank', value: payee.bank.bankName },
    {
      label: 'Account number',
      value: payee.bank.last4 ? maskAccount(payee.bank.last4) : 'Not on file',
    },
  ];
}

/* ------------------------------------------------------- counting pending -- */

/** How many cards are ready to request, and how many are still inside their 45 days. */
export function pendingCounts(split: { ready: unknown[]; countingDown: unknown[] }): {
  ready: number;
  waiting: number;
} {
  return { ready: split.ready.length, waiting: split.countingDown.length };
}

/**
 * The Pending pill: both numbers, and the sentence that says which is which.
 *
 * Two numbers on a pill are two numbers nobody can tell apart, so the badge is
 * the pair and the accessible name spells them out. A zero is kept rather than
 * hidden: "0 ready" is the answer to the question the tab is opened with.
 */
export function pendingTabCounts(split: { ready: unknown[]; countingDown: unknown[] }): {
  badge: string;
  label: string;
} {
  const { ready, waiting } = pendingCounts(split);
  return {
    badge: `${ready} · ${waiting}`,
    label: `${ready} ready to request, ${waiting} not yet ${PAYOUT_DAYS} days old`,
  };
}
