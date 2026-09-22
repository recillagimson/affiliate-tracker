// The admin payouts page, as arithmetic: who a request belongs to, which
// section it sits in, what is awaiting payment, and what is still counting
// down.
//
// Two mistakes here would move real money the wrong way without anything
// looking broken. A request filed under the wrong section is a payment nobody
// makes, or one made twice; and a Pending row priced at the merchant's gross
// instead of the affiliate's own share is an admin sending double. So the
// grouping, the sorting and the pricing are pinned against fixtures, and the
// Pending pricing is checked through the very chain the page runs
// (asAffiliateShare, then describeConversions, then buildPending) rather than
// by feeding the builder a number already halved by hand.
//
//   npx tsx scripts/payout-admin-checks.ts

import {
  awaitingPayment,
  buildPending,
  buildRequestRows,
  canCancel,
  CANCEL_CONFIRM,
  cancelledMessage,
  countRequested,
  describeCancelled,
  describeCardCount,
  describePending,
  describeRequested,
  filterRequests,
  groupRequests,
  indexPeople,
  matchesPerson,
  mismatchNote,
  noRequestsText,
  paymentMessage,
  PENDING_SECTIONS,
  pendingEmptyText,
  receiptMessage,
  countRequestsByStatus,
  matchesRequestFilter,
  REQUEST_FILTERS,
  REQUEST_SECTIONS,
  requestFilterFrom,
  requestBody,
  requestToggleId,
  statusChip,
  tabFrom,
  UNKNOWN_ACCOUNT,
  type RequestRow,
} from '../src/lib/payout-admin';
import { describeConversions, formatMoney, type ConversionView } from '../src/lib/analytics';
import { PAYOUT_DAYS } from '../src/lib/payout';
import { asAffiliateShare } from '../src/lib/load';
import { defaultSettings } from '../src/lib/settings';
import { BLANK } from '../src/lib/report-table';
import type { PayoutRequestRecord } from '../src/lib/payout-request-store';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) pass++;
  else {
    fail++;
    console.error('FAIL:', name, extra === undefined ? '' : extra);
  }
}

// Every sentence this module hands to the page, gathered so the house rule
// about dashes can be checked once across all of them at the end.
const said: string[] = [];
function heard<T extends string>(text: T): T {
  said.push(text);
  return text;
}

const TODAY = '2026-10-10';

const PEOPLE = [
  { userId: 'u1', fullName: 'Ana Lima', username: 'ana', usr: 'ana' },
  // No full name on file: the username has to stand in, or the row is nameless.
  { userId: 'u2', fullName: '', username: 'dana', usr: 'dana' },
  // An affiliate with no tracking key yet. Nothing can be priced to them.
  { userId: 'u3', fullName: 'Kim Park', username: 'kim', usr: '' },
];

function view(id: string, over: Partial<ConversionView> = {}): ConversionView {
  return {
    id,
    createdAt: '2026-08-01T00:00:00.000Z',
    approvedOn: '2026-08-20',
    slug: 'slug',
    usr: 'ana',
    amount: 50,
    notes: '',
    person: 'Link Name',
    card: `Card ${id}`,
    affiliate: 50,
    client: `Customer ${id}`,
    note: '',
    ...over,
  };
}

function request(id: string, over: Partial<PayoutRequestRecord> = {}): PayoutRequestRecord {
  return {
    id,
    userId: 'u1',
    status: 'requested',
    requestedAt: '2026-10-05T09:00:00+00:00',
    requestedBy: 'ana',
    totalAmount: 100,
    amount: null,
    paidAt: null,
    paidBy: '',
    reference: '',
    note: '',
    proof: null,
    confirmedAt: null,
    confirmedBy: '',
    cancelledAt: null,
    cancelledBy: '',
    updatedAt: '2026-10-05T09:00:00+00:00',
    items: [],
    ...over,
  };
}

console.log('- who a request belongs to -');
const { byUserId, byUsr } = indexPeople(PEOPLE);
check('a person is found by their account id', byUserId.get('u1')?.name === 'Ana Lima');
check('with their tracking key', byUserId.get('u1')?.usr === 'ana');
check('a blank full name falls back to the username', byUserId.get('u2')?.name === 'dana');
check('an account with no key is still found by id', byUserId.get('u3')?.name === 'Kim Park');
check('and found by key', byUsr.get('dana')?.name === 'dana');
/*
 * An empty key is what every house approval carries. Indexing an account under
 * it would put somebody's name on the business's own cards.
 */
check('but never under an empty key', !byUsr.has(''));

console.log('\n- the requests, joined up -');
const VIEWS = [
  // The live amount on a view is deliberately not what was requested: the row
  // has to print the snapshot, never the approval as it reads today.
  view('10', { amount: 999, affiliate: 999, approvedOn: '2026-08-19' }),
  view('11', { card: '', approvedOn: '2026-08-21' }),
];
const RECORDS: PayoutRequestRecord[] = [
  request('1', {
    requestedAt: '2026-10-05T09:00:00+00:00',
    totalAmount: 70.35,
    items: [
      { conversionId: '10', amount: 35.2 },
      { conversionId: '11', amount: 35.15 },
      // Released, and its approval since deleted.
      { conversionId: null, amount: 0 },
    ],
  }),
  request('2', { userId: 'u2', requestedAt: '2026-10-04T09:00:00+00:00', requestedBy: 'dana (via Mark)', totalAmount: 40 }),
  request('3', {
    status: 'paid',
    requestedAt: '2026-10-01T09:00:00+00:00',
    paidAt: '2026-10-06T12:00:00+00:00',
    amount: 100,
    totalAmount: 100,
    proof: { name: 'transfer.png', type: 'image/png', at: '2026-10-06T12:30:00+00:00', by: 'mark' },
    confirmedAt: '2026-10-07T08:00:00+00:00',
  }),
  request('4', {
    userId: 'u2',
    status: 'paid',
    requestedAt: '2026-10-02T09:00:00+00:00',
    paidAt: '2026-10-08T12:00:00+00:00',
    amount: 120,
    totalAmount: 140,
  }),
  request('5', { status: 'cancelled', cancelledAt: '2026-10-07T10:00:00+00:00', cancelledBy: 'mark' }),
  request('6', { status: 'cancelled', cancelledAt: '2026-10-09T10:00:00+00:00', cancelledBy: 'mark' }),
  // Filed under an account the roster does not list.
  request('7', { userId: 'u9', requestedAt: '2026-10-06T09:00:00+00:00', totalAmount: 25 }),
  // A tie with request 1 on the minute, to pin what breaks it.
  request('12', { requestedAt: '2026-10-05T09:00:00+00:00', totalAmount: 5 }),
];
const before = JSON.stringify(RECORDS);
const rows = buildRequestRows(RECORDS, byUserId, VIEWS);
const byId = new Map(rows.map((row) => [row.id, row]));

check('one row per request', rows.length === RECORDS.length, rows.length);
check('named from the roster', byId.get('1')?.name === 'Ana Lima');
check('with the tracking key beside it', byId.get('1')?.usr === 'ana');
check('the username when there is no full name', byId.get('2')?.name === 'dana');
check('an account missing from the roster is said to be unknown', byId.get('7')?.name === UNKNOWN_ACCOUNT);
check('and has no key to show', byId.get('7')?.usr === '');
check('the unknown wording', heard(UNKNOWN_ACCOUNT) === 'Unknown account');

const first = byId.get('1')!;
check('every card on the request is listed', first.cards.length === 3, first.cards);
check('a card is named from its approval', first.cards[0]?.card === 'Card 10');
check('with its customer', first.cards[0]?.customer === 'Customer 10');
check('and the day it was approved', first.cards[0]?.approvedOn === '2026-08-19');
check('the amount is the snapshot, not the approval today', first.cards[0]?.amount === 35.2, first.cards[0]);
check('an approval with no card name reads as blank', first.cards[1]?.card === BLANK);
check('a released line whose approval is gone reads blank', first.cards[2]?.card === BLANK && first.cards[2]?.customer === BLANK);
check('and has no day to show', first.cards[2]?.approvedOn === '');
check('but keeps its line', first.cards[2]?.conversionId === null);
const orphan = buildRequestRows([request('8', { items: [{ conversionId: '404', amount: 9 }] })], byUserId, VIEWS)[0]!;
check('a card the page could not load reads blank too', orphan.cards[0]?.card === BLANK && orphan.cards[0]?.amount === 9);
check('the receipt is carried by name', byId.get('3')?.proof?.name === 'transfer.png');
check('with when it was attached', byId.get('3')?.proof?.at === '2026-10-06T12:30:00+00:00');
check('no receipt is null, not an empty one', byId.get('1')?.proof === null);
check('the payment carries over', byId.get('4')?.amount === 120 && byId.get('4')?.paidAt === '2026-10-08T12:00:00+00:00');
check('the records handed in are not changed', JSON.stringify(RECORDS) === before);

console.log('\n- the three sections -');
check('three of them, in this order', REQUEST_SECTIONS.map((s) => s.key).join() === 'requested,paid,cancelled');
check('needs payment first', heard(REQUEST_SECTIONS[0]!.label) === 'Needs payment');
check('then paid', heard(REQUEST_SECTIONS[1]!.label) === 'Paid');
check('then cancelled', heard(REQUEST_SECTIONS[2]!.label) === 'Cancelled');
check(
  'each says what it holds',
  heard(REQUEST_SECTIONS[0]!.blurb) === 'Submitted by the affiliate. Record the payment once it is sent.' &&
    heard(REQUEST_SECTIONS[1]!.blurb) === 'Recorded as paid. Each one wants a receipt against it.' &&
    heard(REQUEST_SECTIONS[2]!.blurb) === 'Withdrawn before payment. The cards are free to be requested again.',
  REQUEST_SECTIONS,
);

const inputOrder = rows.map((row) => row.id).join();
const grouped = groupRequests(rows);
const ids = (list: RequestRow[]) => list.map((row) => row.id).join();
check('only unpaid requests need payment', grouped.requested.every((row) => row.status === 'requested'));
/*
 * Oldest first: the request somebody has waited longest on is the one to pay
 * next. A tie on the minute goes to the lower id, which is the one filed first.
 */
check('the longest wait at the top', ids(grouped.requested) === '2,1,12,7', ids(grouped.requested));
check('paid, newest payment first', ids(grouped.paid) === '4,3', ids(grouped.paid));
check('cancelled, newest cancel first', ids(grouped.cancelled) === '6,5', ids(grouped.cancelled));
check(
  'every request lands in exactly one section',
  grouped.requested.length + grouped.paid.length + grouped.cancelled.length === rows.length,
);
check('the rows handed in keep their order', rows.map((row) => row.id).join() === inputOrder);

// A timestamp nobody can read cannot be placed, so it goes to the bottom of
// its section rather than jumping the queue.
const broken = groupRequests(
  buildRequestRows(
    [
      request('20', { requestedAt: 'not a time' }),
      request('21', { requestedAt: '2026-10-05T09:00:00+00:00' }),
      request('22', { requestedAt: '2026-10-03 09:00:00+00' }),
    ],
    byUserId,
    VIEWS,
  ),
);
check('an unreadable time sinks to the bottom', ids(broken.requested) === '22,21,20', ids(broken.requested));
check('and the Postgres way of writing a time still sorts', broken.requested[0]?.id === '22');

console.log('\n- what is owed -');
// 70.35 + 40 + 25 + 5, written as the cents it comes to rather than as a float
// sum that may land a hair off it.
check('awaiting payment is the unpaid requests only', awaitingPayment(rows) === 140.35, awaitingPayment(rows));
check('rounded once, at the end', awaitingPayment(buildRequestRows([request('30', { totalAmount: 0.1 }), request('31', { totalAmount: 0.2 })], byUserId, [])) === 0.3);
check('nothing requested is nothing owed', awaitingPayment([]) === 0);
check('the requests tab counts what needs paying', countRequested(rows) === 4);

console.log('\n- finding someone -');
const ana = { name: 'Ana Lima', usr: 'ana' };
check('a name matches', matchesPerson(ana, 'lima'));
check('whatever the case', matchesPerson(ana, 'ANA'));
check('a tracking key matches', matchesPerson({ name: 'dana', usr: 'd7x' }, 'd7x'));
check('an empty box matches everybody', matchesPerson(ana, '   '));
check('surrounding space is ignored', matchesPerson(ana, '  lima '));
check('and somebody else does not', !matchesPerson(ana, 'kim'));
check('the filter keeps the order it was given', ids(filterRequests(rows, 'dana')) === '2,4');
check('and an empty query keeps everybody', filterRequests(rows, '').length === rows.length);

console.log('\n- the row, in words -');
check('one card', heard(describeCardCount(1)) === '1 card');
check('several cards', heard(describeCardCount(3)) === '3 cards');
check('no cards', heard(describeCardCount(0)) === '0 cards');
check('an unpaid request is gold', statusChip('requested').className === 'chip chip-gold');
check('and says Requested', heard(statusChip('requested').label) === 'Requested');
// Green means paid, everywhere in this app.
check('a paid one is green', statusChip('paid').className === 'chip chip-live');
check('and says Paid', heard(statusChip('paid').label) === 'Paid');
check('a cancelled one is quiet', statusChip('cancelled').className === 'chip chip-quiet');
check('and says Cancelled', heard(statusChip('cancelled').label) === 'Cancelled');

const asked = describeRequested(byId.get('1')!);
check('when it was asked for', heard(asked.when) === 'Requested 5 Oct 2026', asked);
check('and by whom', heard(asked.by) === 'by ana', asked);
/*
 * Client View files a request under the affiliate's name with the admin's in
 * brackets. That line is the only record an admin was at the keyboard, so it
 * is printed exactly as it was stored.
 */
check('an admin acting as them is shown as such', heard(describeRequested(byId.get('2')!).by) === 'by dana (via Mark)');
check('nobody named, nothing said', describeRequested(buildRequestRows([request('40', { requestedBy: '' })], byUserId, [])[0]!).by === '');
/*
 * A cancelled request is read for when it was withdrawn and who withdrew it,
 * which is the question somebody looking at it is asking. When it was first
 * asked for is on the payslip.
 */
const withdrawn = describeCancelled(byId.get('6')!);
check('when it was cancelled', heard(withdrawn.when) === 'Cancelled 9 Oct 2026', withdrawn);
check('and by whom', heard(withdrawn.by) === 'by mark', withdrawn);
check('a request that is not cancelled says nothing about it', describeCancelled(byId.get('1')!).when === '');

console.log('\n- a payment that does not match what was asked -');
check('an unpaid request has nothing to compare', mismatchNote(byId.get('1')!) === '');
check('a payment that matches says nothing', mismatchNote(byId.get('3')!) === '');
check(
  'half a cent either way still matches',
  mismatchNote({ status: 'paid', totalAmount: 100, amount: 100.004 }) === '',
);
check(
  'a different figure is said out loud',
  heard(mismatchNote(byId.get('4')!)) ===
    `Paid ${formatMoney(120)} against ${formatMoney(140)} requested. An admin may have entered a different figure than what was asked for.`,
  mismatchNote(byId.get('4')!),
);
check('a cancelled request is not a mismatch', mismatchNote({ status: 'cancelled', totalAmount: 100, amount: 20 }) === '');

console.log('\n- cancelling -');
// Only an unpaid request can be cancelled. A paid one is cleared first, and a
// cancelled one is already over.
check('an unpaid request can be cancelled', canCancel('requested'));
check('a paid one cannot', !canCancel('paid'));
check('nor a cancelled one', !canCancel('cancelled'));
check(
  'the question asked before it happens',
  heard(CANCEL_CONFIRM) ===
    'Cancel this request? Its cards go back to Pending and the affiliate would need to request them again.',
);
check('and what is said once it has', heard(cancelledMessage('Ana Lima')) === 'Request cancelled for Ana Lima.');

console.log('\n- what the other actions say once they are done -');
/*
 * In the words of the button that was pressed. The payment button reads
 * "Save payment" on a request already paid, where pressing it corrects what is
 * there, and a message saying "recorded" would read as a second payment. The
 * receipt button reads "Replace receipt" once one is on file.
 */
check('a first payment is recorded', heard(paymentMessage('Ana Lima', false)) === 'Payment recorded for Ana Lima.');
check('a correction to one is an update, not a second payment', heard(paymentMessage('Ana Lima', true)) === 'Payment updated for Ana Lima.');
check('a first receipt is attached', heard(receiptMessage('Ana Lima', false)) === 'Receipt attached for Ana Lima.');
check('a later one replaces it', heard(receiptMessage('Ana Lima', true)) === 'Receipt replaced for Ana Lima.');
/*
 * The one control a request row has in every state, so it is where the
 * keyboard goes back to when an action takes away the control that held it.
 */
check('a row button has an id of its own', requestToggleId('12') === 'request-12-toggle');
/*
 * Every post names the request it is about, and nothing else in the body can
 * change which one. An action spread over the id would be a payment recorded
 * against somebody else's request.
 */
const body = requestBody('3', { action: 'pay', amount: 100, requestId: '999' });
check('the body names the request', body.requestId === '3', body);
check('and carries the action with it', body.action === 'pay' && body.amount === 100, body);

console.log('\n- empty -');
check(
  'no requests at all',
  heard(noRequestsText(0, '')) ===
    'No requests yet. Once a card is 45 days old, the affiliate can ask to be paid for it, and it will show up here.',
);
check('a search that finds nobody', heard(noRequestsText(5, 'zed')) === 'Nobody matches “zed”.');
check('a search on an empty page is still the empty page', noRequestsText(0, 'zed') === noRequestsText(0, ''));

console.log('\n- which tab -');
check('requests by default', tabFrom(undefined) === 'requests');
check('pending when asked', tabFrom('pending') === 'pending');
check('requests when asked', tabFrom('requests') === 'requests');
check('anything else is requests', tabFrom('paid') === 'requests' && tabFrom('') === 'requests');
check('the case has to match', tabFrom('PENDING') === 'requests');
check('a repeated parameter is not a tab', tabFrom(['pending', 'pending']) === 'requests');

console.log('\n- pending -');
const PENDING_VIEWS = [
  view('p1', { usr: 'ana', approvedOn: '2026-08-20', amount: 50, card: 'Alpha' }),
  // Exactly 45 days: requestable today.
  view('p2', { usr: 'ana', approvedOn: '2026-08-26', amount: 20, card: 'Beta' }),
  view('p3', { usr: 'dana', approvedOn: '2026-09-01', amount: 30, card: 'Gamma' }),
  view('p4', { usr: 'dana', approvedOn: '2026-09-09', amount: 40, card: 'Delta' }),
  view('p5', { usr: '', person: 'House', approvedOn: '2026-08-01', amount: 80, card: 'House Card' }),
  view('p6', { usr: 'ana', approvedOn: '2026-08-01', amount: 60, card: 'Spoken For' }),
  // A key with no account behind it: named from the link instead.
  view('p7', { usr: 'zed', person: 'Zed Link', approvedOn: '2026-08-15', amount: 10, card: 'Epsilon' }),
  view('p8', { usr: 'ana', approvedOn: '2026-09-25', amount: 15, card: 'Zeta' }),
  view('p10', { usr: 'dana', approvedOn: '2026-08-27', amount: 12.5, card: 'Eta' }),
];
const pendingBefore = JSON.stringify(PENDING_VIEWS);
const pending = buildPending(PENDING_VIEWS, byUsr, TODAY, new Set(['p6']));
const pids = (list: { id: string }[]) => list.map((row) => row.id).join();

check('ready, oldest approval first', pids(pending.ready) === 'p7,p1,p2', pids(pending.ready));
check('counting down, soonest first', pids(pending.countingDown) === 'p10,p3,p4,p8', pids(pending.countingDown));
check('a house card is in neither', ![...pending.ready, ...pending.countingDown].some((row) => row.id === 'p5'));
check('nor a card already on a request', ![...pending.ready, ...pending.countingDown].some((row) => row.id === 'p6'));
/*
 * "Approved" counts every card that belongs to somebody, requested or not, so
 * the page can tell "nothing has ever been approved" from "everything has been
 * asked for already". The house card belongs to nobody and is not counted.
 */
check('every card with an owner is counted as approved', pending.approved === 8, pending.approved);
check('the handed-in views are not changed', JSON.stringify(PENDING_VIEWS) === pendingBefore);

const p3 = pending.countingDown.find((row) => row.id === 'p3')!;
check('named from the roster by key', p3.name === 'dana');
check('with the key', p3.usr === 'dana');
check('the card', p3.card === 'Gamma');
check('the customer', p3.customer === 'Customer p3');
check('the day it was approved', p3.approvedOn === '2026-09-01');
check('the amount as given', p3.amount === 30);
check('how long is left', heard(p3.countdown) === '6 days left', p3);
check('and the day it will be ready', heard(p3.readyDay) === 'Ready 16 Oct 2026', p3);
check('in whole days', p3.daysLeft === 6);
check('one day left is singular', heard(pending.countingDown[0]!.countdown) === '1 day left');
check('a card with no account is named from its link', pending.ready[0]?.name === 'Zed Link');
const p2 = pending.ready.find((row) => row.id === 'p2')!;
check('a card ready today says so', heard(p2.countdown) === 'Ready to request', p2);
check('and says the day it became ready', heard(p2.readyDay) === 'Ready 10 Oct 2026', p2);
check('a ready card has nothing left to count', p2.daysLeft <= 0);
check('a card with no customer keeps the dash', buildPending([view('q1', { client: '-' })], byUsr, TODAY, new Set()).ready[0]?.customer === '-');
check('a card with no card name reads blank', buildPending([view('q2', { card: '' })], byUsr, TODAY, new Set()).ready[0]?.card === BLANK);

console.log('\n- pending, in words -');
check(
  'what is ready, and what is not',
  heard(describePending(pending)) ===
    `3 ready to request, worth ${formatMoney(50 + 20 + 10)}. 4 more still counting down.`,
  describePending(pending),
);
check(
  'nothing counting down, nothing said about it',
  heard(describePending({ ready: pending.ready.slice(0, 1), countingDown: [] })) ===
    `1 ready to request, worth ${formatMoney(10)}.`,
);
check(
  'nothing ready yet',
  heard(describePending({ ready: [], countingDown: pending.countingDown.slice(0, 2) })) ===
    'Nothing is ready to request yet. 2 still counting down.',
);
check('nothing at all, no line', describePending({ ready: [], countingDown: [] }) === '');
check('the sections, in order', PENDING_SECTIONS.map((s) => s.key).join() === 'ready,countingDown');
check('ready first', heard(PENDING_SECTIONS[0]!.label) === 'Ready to request');
check(
  'with what it means',
  heard(PENDING_SECTIONS[0]!.blurb) === '45 days have passed. Nothing happens until the affiliate asks to be paid.',
);
check('then the ones still inside their 45 days', heard(PENDING_SECTIONS[1]!.label) === `Not yet ${PAYOUT_DAYS} days`);
check('with what that means', heard(PENDING_SECTIONS[1]!.blurb) === 'Not old enough to request yet.');
check(
  'nothing ever approved',
  heard(pendingEmptyText(0)) === 'No approved cards yet. This tab fills up as approvals come in.',
);
check(
  'everything already asked for',
  heard(pendingEmptyText(8)) === 'Nothing waiting. Every eligible card has already been requested.',
);

console.log('\n- pending is priced as the affiliate share, through the page chain -');
{
  /*
   * The page reads approvals as an admin, which means gross. It converts them
   * with asAffiliateShare and then describes them with gross switched off, and
   * this is that chain run for real. 100 gross at a 50% share is 50; approved
   * after the rate went to 60% it is 60. Seeing 100 would be the merchant's
   * money on somebody's row; seeing 25 would be the share taken twice.
   */
  const settings = {
    ...defaultSettings(),
    shares: [
      { from: '', rate: 0.5 },
      { from: '2026-08-10', rate: 0.6 },
    ],
  };
  const gross = [
    { id: 'g1', createdAt: '', approvedOn: '2026-08-01', slug: 's', usr: 'ana', amount: 100, notes: '' },
    { id: 'g2', createdAt: '', approvedOn: '2026-08-12', slug: 's', usr: 'ana', amount: 100, notes: '' },
  ];
  const views = describeConversions([], asAffiliateShare(gross, settings), [], {
    shares: settings.shares,
    gross: false,
  });
  const priced = buildPending(views, byUsr, TODAY, new Set());
  const g1 = priced.ready.find((row) => row.id === 'g1');
  const g2 = priced.ready.find((row) => row.id === 'g2');
  check('half of 100 at the old rate', g1?.amount === 50, g1);
  check('60% of 100 at the rate in force that day', g2?.amount === 60, g2);
  check('never the gross', priced.ready.every((row) => row.amount !== 100));
}

console.log('\n- the wording rules -');
check('there was something to read', said.length > 30, said.length);
check('no em or en dash anywhere', said.every((text) => !/[\u2013\u2014]/.test(text)), said.filter((t) => /[\u2013\u2014]/.test(t)));

console.log('\n- filtering the requests by status -');
const FILTER_ROWS = [
  { status: 'requested' as const },
  { status: 'requested' as const },
  { status: 'paid' as const },
  { status: 'cancelled' as const },
];
check('the options are everything, then the sections in their order', REQUEST_FILTERS.map((f) => f.key).join() === 'all,requested,paid,cancelled');
check(
  'each is named the way its section is',
  REQUEST_FILTERS.slice(1).every((f, index) => f.label === REQUEST_SECTIONS[index]!.label),
);
check('the first option is named for what it shows', REQUEST_FILTERS[0]!.label === 'All');
check('a status in the URL is honoured', requestFilterFrom('paid') === 'paid');
check('a tidied one too', requestFilterFrom(' Paid ') === 'paid');
check('anything else falls back to everything', requestFilterFrom('nonsense') === 'all');
check('and so does nothing at all', requestFilterFrom(undefined) === 'all');
check('all keeps every request', FILTER_ROWS.filter((row) => matchesRequestFilter(row, 'all')).length === 4);
check('paid keeps only the paid ones', FILTER_ROWS.filter((row) => matchesRequestFilter(row, 'paid')).length === 1);
check('needs payment keeps only those', FILTER_ROWS.filter((row) => matchesRequestFilter(row, 'requested')).length === 2);
const filterCounts = countRequestsByStatus(FILTER_ROWS);
check('every option carries its own count', filterCounts.all === 4 && filterCounts.requested === 2 && filterCounts.paid === 1 && filterCounts.cancelled === 1);
check('a status nobody has counts zero rather than going missing', countRequestsByStatus([]).paid === 0);


console.log(`\npayout-admin: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
