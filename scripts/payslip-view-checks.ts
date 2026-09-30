// What the affiliate's payslip pages are handed, worked out before any of it
// is drawn.
//
// Three things decide whether these pages tell the truth, so they are pinned
// here rather than trusted to the markup. Which cards are offered: only the
// reader's own, only ones that are not already on a live request, and nothing
// at all when the figures loaded are the merchant's rather than theirs. What a
// selection is: a stale id left over from before a refresh must never be
// counted or sent. And what a request document reads: the snapshot amounts
// the request recorded, in the order it recorded them, with a blank rather
// than a guess for a line whose approval has since gone.
//
// The props handed to the client components are checked for shape as well as
// content. A field that is not there cannot leak.
//
//   npx tsx scripts/payslip-view-checks.ts

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cardCount,
  cardsFor,
  chosenRows,
  isRequestId,
  keepListed,
  nothingReadyText,
  payslipHref,
  payslipLines,
  receiptHref,
  requestRows,
  selectAllState,
  statusChip,
  SUCCESS_MESSAGE,
  toggleAll,
  toggleOne,
  type Loaded,
} from '../src/lib/payslip-view';
import { PAYOUT_DAYS } from '../src/lib/payout';
import { BLANK } from '../src/lib/report-table';
import type { PayoutRequestRecord } from '../src/lib/payout-request-store';
import type { AffiliateLink, Conversion, Submission } from '../src/lib/types';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) pass++;
  else {
    fail++;
    console.error('FAIL:', name, extra === undefined ? '' : extra);
  }
}

// Every sentence the module hands a page, gathered so the wording rules can be
// checked once across all of them at the end.
const said: string[] = [];
function heard<T extends string>(text: T): T {
  said.push(text);
  return text;
}

/* ---------------------------------------------------------------- fixtures --- */

function link(slug: string, usr: string, campaign: string): AffiliateLink {
  return {
    id: `link-${slug}`,
    slug,
    usr,
    assignee: usr.toUpperCase(),
    assigneeEmail: '',
    destination: 'https://example.test/offer',
    campaign,
    headline: '',
    subheadline: '',
    ctaLabel: '',
    requirePhone: false,
    passUsrParam: '',
    active: true,
    notes: '',
    createdAt: '2026-07-01T00:00:00.000Z',
  } as AffiliateLink;
}

function conversion(id: string, usr: string, slug: string, approvedOn: string, amount: number, notes = ''): Conversion {
  return { id, createdAt: `${approvedOn}T10:00:00.000Z`, approvedOn, slug, usr, amount, notes };
}

const TODAY = '2026-10-10';

const LOAD: Loaded = {
  links: [link('platinum', 'ana', 'Platinum Card'), link('cashback', 'ana', 'Cash Back Card')],
  submissions: [
    { id: 'abc1', fullName: 'Dana Okafor', email: 'dana@example.test' } as Submission,
  ],
  conversions: [
    conversion('101', 'ana', 'platinum', '2026-08-01', 70, 'lead:abc1'),
    conversion('102', 'ana', 'cashback', '2026-09-25', 70.5),
    conversion('103', 'ana', 'platinum', '2026-09-26', 40, 'lead:abc1'),
    conversion('104', 'ana', 'cashback', '2026-10-08', 25),
    // Old enough, but already on a live request.
    conversion('105', 'ana', 'platinum', '2026-08-02', 60),
    // Somebody else's, which a scoped load never carries, and a house card.
    conversion('106', 'ben', 'platinum', '2026-08-01', 80),
    conversion('107', '', 'platinum', '2026-08-01', 90),
    // No slug, so no card name to find.
    conversion('108', 'ana', '', '2026-08-03', 12.25),
  ],
  gross: false,
};
const COMMITTED = new Set(['105']);

console.log('- the cards on offer -');
const { ready, countingDown } = cardsFor(LOAD, 'ana', TODAY, COMMITTED);
const readyIds = ready.map((row) => row.id).join();
const countingIds = countingDown.map((row) => row.id).join();
check('ready cards, oldest approval first', readyIds === '101,108,102', readyIds);
check('counting down, soonest first', countingIds === '103,104', countingIds);
check('a card already on a request is in neither', !readyIds.includes('105') && !countingIds.includes('105'));
check("somebody else's card is in neither", !readyIds.includes('106') && !countingIds.includes('106'));
check('a house card is in neither', !readyIds.includes('107') && !countingIds.includes('107'));

const platinum = ready[0]!;
check('the card is named from its link', platinum.card === 'Platinum Card', platinum);
check('the customer from the lead behind it', platinum.customer === 'Dana Okafor', platinum);
check('the approval day as people read it', platinum.approved === '1 Aug 2026', platinum);
check('the day key rides along for ordering', platinum.approvedOn === '2026-08-01', platinum);
check("the reader's own figure", platinum.amount === 70, platinum);
check(
  'the checkbox names the card, the customer, the day and the money',
  heard(platinum.label) === 'Platinum Card, customer Dana Okafor, approved 1 Aug 2026, $70',
  platinum.label,
);

const cashback = ready.find((row) => row.id === '102')!;
check('no lead behind it is a blank customer', cashback.customer === BLANK, cashback);
check('cents survive into the amount', cashback.amount === 70.5, cashback);
// A screen reader reads a lone hyphen as "dash", which says nothing.
check(
  'and the label says so in words',
  heard(cashback.label) === 'Cash Back Card, customer not on file, approved 25 Sep 2026, $70.50',
  cashback.label,
);

const nameless = ready.find((row) => row.id === '108')!;
check('no card name is a blank card', nameless.card === BLANK, nameless);
check('and the label says that in words too', heard(nameless.label).startsWith('Card not on file, customer not on file'), nameless.label);

const soon = countingDown[0]!;
check('one day left', soon.daysLeft === 1 && heard(soon.countdown) === '1 day left', soon);
check('and the day it turns ready', heard(soon.readyDay) === 'Ready 11 Oct 2026', soon);
const later = countingDown[1]!;
check('thirteen days left', heard(later.countdown) === '13 days left', later);
check('ready later in October', heard(later.readyDay) === 'Ready 23 Oct 2026', later);

/*
 * Only these fields reach the client component. No notes, no slug, no usr and
 * nothing that could carry a merchant figure beside the reader's own.
 */
check(
  'a ready row carries only what the table draws',
  ready.every((row) => Object.keys(row).sort().join() === 'amount,approved,approvedOn,card,customer,id,label'),
  Object.keys(platinum),
);
check(
  'a countdown row adds only the countdown',
  countingDown.every(
    (row) =>
      Object.keys(row).sort().join() ===
      'amount,approved,approvedOn,card,countdown,customer,daysLeft,id,label,readyDay',
  ),
  Object.keys(soon),
);

// An account with no tracking key owns no card, whatever the load holds.
const keyless = cardsFor(LOAD, '', TODAY, COMMITTED);
check('no tracking key, nothing offered', keyless.ready.length === 0 && keyless.countingDown.length === 0);
/*
 * A load that carries the merchant's figures is an admin's load. This page is
 * never meant to be reached with one, and if it ever is, the answer is an empty
 * list rather than somebody's gross payouts under a "your money" heading.
 */
const merchant = cardsFor({ ...LOAD, gross: true }, 'ana', TODAY, COMMITTED);
check('merchant figures shape to nothing', merchant.ready.length === 0 && merchant.countingDown.length === 0);
check('the input is not reordered', LOAD.conversions.map((row) => row.id).join() === '101,102,103,104,105,106,107,108');

console.log('\n- choosing cards -');
const IDS = ['101', '108', '102'];
check('nothing chosen', selectAllState(new Set(), IDS) === 'none');
check('some chosen', selectAllState(new Set(['108']), IDS) === 'some');
check('all chosen', selectAllState(new Set(IDS), IDS) === 'all');
check('an empty list has nothing chosen', selectAllState(new Set(['101']), []) === 'none');
// A stale id is not a choice anybody can see, so it is not counted as one.
check('a stale id alone is nothing chosen', selectAllState(new Set(['999']), IDS) === 'none');
check('and does not make a full list partial', selectAllState(new Set([...IDS, '999']), IDS) === 'all');

const before = new Set(['101']);
const added = toggleOne(before, '102');
check('ticking a card adds it', added.has('101') && added.has('102') && added.size === 2);
check('without touching the set it came from', before.size === 1 && !before.has('102'));
const removed = toggleOne(added, '101');
check('ticking it again takes it off', !removed.has('101') && removed.has('102'));

check('select all from nothing takes every card', [...toggleAll(new Set(), IDS)].sort().join() === '101,102,108');
check('select all from some takes every card', toggleAll(new Set(['108']), IDS).size === 3);
check('select all from all clears it', toggleAll(new Set(IDS), IDS).size === 0);
check('select all never keeps a stale id', !toggleAll(new Set(['999']), IDS).has('999'));

const tidy = new Set(['101', '102']);
check('keeping what is listed changes nothing when nothing went', keepListed(tidy, IDS) === tidy);
const pruned = keepListed(new Set(['101', '105']), IDS);
check('a card that left the list is dropped from the selection', pruned.has('101') && !pruned.has('105') && pruned.size === 1);

const picked = chosenRows(ready, new Set(['102', '101', '999']));
check('the chosen rows come back in list order', picked.map((row) => row.id).join() === '101,102', picked.map((row) => row.id));
check('and a stale id brings no row with it', picked.length === 2);

console.log('\n- the requests list -');
function record(over: Partial<PayoutRequestRecord> & { id: string }): PayoutRequestRecord {
  return {
    userId: 'u-ana',
    status: 'requested',
    requestedAt: '2026-10-01T09:00:00.000Z',
    requestedBy: 'ana',
    totalAmount: 0,
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
    updatedAt: '2026-10-01T09:00:00.000Z',
    items: [],
    ...over,
  };
}
const RECORDS: PayoutRequestRecord[] = [
  record({
    id: '7',
    requestedAt: '2026-10-03T09:00:00.000Z',
    totalAmount: 140.5,
    items: [
      { conversionId: '101', amount: 70 },
      { conversionId: '102', amount: 70.5 },
    ],
  }),
  record({
    id: '12',
    status: 'paid',
    requestedAt: '2026-10-05T10:00:00.000Z',
    paidAt: '2026-10-08T12:00:00.000Z',
    amount: 70,
    totalAmount: 70,
    items: [{ conversionId: '101', amount: 70 }],
  }),
  record({
    id: '9',
    status: 'cancelled',
    requestedAt: '2026-10-04T09:00:00.000Z',
    cancelledAt: '2026-10-04T15:00:00.000Z',
    requestedBy: 'ana (via Mark)',
    totalAmount: 25,
    items: [
      { conversionId: '104', amount: 10 },
      { conversionId: null, amount: 5 },
      { conversionId: '103', amount: 10 },
    ],
  }),
  // The same moment as 12, so the id decides.
  record({
    id: '13',
    requestedAt: '2026-10-05T10:00:00.000Z',
    totalAmount: 12.25,
    items: [{ conversionId: '108', amount: 12.25 }],
  }),
];
const listed = requestRows(RECORDS);
check('newest first, and the higher id first on a tie', listed.map((row) => row.id).join() === '13,12,9,7', listed.map((row) => row.id));
check('the records are not reordered', RECORDS.map((row) => row.id).join() === '7,12,9,13');
const seven = listed.find((row) => row.id === '7')!;
check('each links to its own payslip', seven.href === '/payslips/7', seven);
check('two cards', heard(seven.cards) === '2 cards', seven);
check('the total it was requested for', seven.total === 140.5, seven);
check('the day it was requested', heard(seven.requested) === 'Requested 3 Oct 2026', seven);
check('a request still waiting has nothing more to say', seven.outcome === '', seven);
check('and wears a gold chip', seven.chip.label === 'Requested' && seven.chip.className === 'chip-gold', seven.chip);
const twelve = listed.find((row) => row.id === '12')!;
check('one card', heard(twelve.cards) === '1 card', twelve);
check('a paid one says when', heard(twelve.outcome) === 'Paid 8 Oct 2026', twelve);
check('in green', twelve.chip.label === 'Paid' && twelve.chip.className === 'chip-live', twelve.chip);
const nine = listed.find((row) => row.id === '9')!;
check('a released line still counts as a card on it', heard(nine.cards) === '3 cards', nine);
check('a cancelled one says when', heard(nine.outcome) === 'Cancelled 4 Oct 2026', nine);
check('quietly', nine.chip.label === 'Cancelled' && nine.chip.className === 'chip-quiet', nine.chip);
// Who pressed the button, and whether an admin was behind them, is the audit
// line. It is not part of what the list draws, so it is not handed over.
check(
  'a list row carries only what the list draws',
  listed.every((row) => Object.keys(row).sort().join() === 'cards,chip,href,id,outcome,requested,status,total'),
  Object.keys(seven),
);
check('nothing to list is nothing', requestRows([]).length === 0);

console.log('\n- small words -');
check('no cards', heard(cardCount(0)) === '0 cards');
check('a card', heard(cardCount(1)) === '1 card');
check('cards', heard(cardCount(4)) === '4 cards');
check('every status has a chip', (['requested', 'paid', 'cancelled'] as const).every((status) => heard(statusChip(status).label) !== ''));
check('the payslip address', payslipHref('12') === '/payslips/12');
check('the receipt address, by request', receiptHref('12') === '/api/payouts/receipt?request=12');
check(
  'the empty ready list says when cards turn ready',
  heard(nothingReadyText()) === `Nothing is ready yet. Cards become requestable ${PAYOUT_DAYS} days after they are approved.`,
);
check('and it is 15', nothingReadyText().includes('15 days'));
check('the success line', heard(SUCCESS_MESSAGE) === 'Payment requested. You can track it below.');

console.log('\n- which addresses are a request -');
check('1 is', isRequestId('1'));
check('12 is', isRequestId('12'));
check('0 is not', !isRequestId('0'));
check('a negative is not', !isRequestId('-1'));
check('a leading zero is not', !isRequestId('012'));
check('a fraction is not', !isRequestId('1.5'));
check('a word is not', !isRequestId('abc'));
check('nothing is not', !isRequestId(''));
check('an old pay period is not', !isRequestId('2026-08-15'));
check('padding is not', !isRequestId(' 12') && !isRequestId('12 '));
check('past the safe integers is not', !isRequestId('9007199254740993'));

console.log('\n- the payslip document -');
const lines = payslipLines(
  [
    { conversionId: '101', amount: 70 },
    { conversionId: null, amount: 35.5 },
    { conversionId: '999', amount: 10 },
    { conversionId: '102', amount: 71 },
  ],
  LOAD,
);
check('one line per item, in the order recorded', lines.length === 4);
check('the card from the approval', lines[0]!.card === 'Platinum Card', lines[0]);
check('and the customer', lines[0]!.customer === 'Dana Okafor', lines[0]);
check('a line whose approval was deleted keeps its money', lines[1]!.amount === 35.5, lines[1]);
check('with blanks where the names were', lines[1]!.card === BLANK && lines[1]!.customer === BLANK, lines[1]);
check('an approval this reader cannot see is blank too', lines[2]!.card === BLANK && lines[2]!.customer === BLANK, lines[2]);
// 70.5 is what the approval is worth now. 71 is what the request recorded,
// and the request is the document.
check('the amount is the snapshot, not the live figure', lines[3]!.amount === 71, lines[3]);
check('every line has its own key', new Set(lines.map((line) => line.key)).size === 4, lines.map((line) => line.key));
check(
  'a line carries only what the table draws',
  lines.every((line) => Object.keys(line).sort().join() === 'amount,card,customer,key'),
  Object.keys(lines[0]!),
);

console.log('\n- the files -');
const ROOT = process.cwd();
const PAYSLIPS = join(ROOT, 'src', 'app', '(admin)', 'payslips');
function source(...parts: string[]): string {
  try {
    return readFileSync(join(ROOT, ...parts), 'utf8');
  } catch {
    return '';
  }
}
/*
 * Next refuses two different slug names at one path, so the old period page has
 * to be gone in the same change that adds the request page.
 */
check('the period payslip is gone', !existsSync(join(PAYSLIPS, '[period]', 'page.tsx')));
check('the request payslip is there', existsSync(join(PAYSLIPS, '[requestId]', 'page.tsx')));
let slugs: string[] = [];
try {
  slugs = readdirSync(PAYSLIPS).filter((name) => name.startsWith('['));
} catch {
  slugs = [];
}
check('and it is the only dynamic segment under /payslips', slugs.join() === '[requestId]', slugs);

const document = source('src', 'app', '(admin)', 'payslips', '[requestId]', 'page.tsx');
// The fix for a guessable id: the reader's own id goes into the query itself.
check(
  'the document is read on behalf of the viewer, in the query',
  /readPayoutRequest\(\s*requestId\s*,\s*viewer\.id\s*\)/.test(document),
);
check('an address that is not a request is a 404 before any read', /isRequestId\(\s*requestId\s*\)/.test(document) && document.includes('notFound()'));
check('the receipt link is by request', document.includes('receiptHref('));
/*
 * The cards table is PayslipCards, drawn by the page, so the render checks can
 * draw it too (see payslip-cards-render-checks). It sits in the same window
 * every other wide table in this feature uses, which a keyboard can reach and
 * which draws its own scroll buttons if the table ever overflows, and those
 * buttons stay off the printout.
 */
const cardsTable = source('src', 'components', 'PayslipCards.tsx');
check('the document draws its cards with PayslipCards', /<PayslipCards\b/.test(document));
check('the document table scrolls in a TableScroller', /<TableScroller[^>]*label="Cards on this request"/.test(cardsTable));
check('with its scroll buttons kept off paper', /<TableScroller[^>]*controlsClassName="no-print"/.test(cardsTable));
check(
  'and not in a bare window a keyboard cannot reach',
  document !== '' && cardsTable !== '' && !document.includes('overflow-x-auto') && !cardsTable.includes('overflow-x-auto'),
);

const actions = source('src', 'components', 'PayslipActions.tsx');
check('confirming names the request', /action:\s*'confirm',\s*requestId/.test(actions));
check('and not a pay period', actions !== '' && !actions.includes('periodStart'));

const MINE = [
  ['src', 'app', '(admin)', 'payslips', 'page.tsx'],
  ['src', 'app', '(admin)', 'payslips', '[requestId]', 'page.tsx'],
  ['src', 'components', 'RequestPayment.tsx'],
  ['src', 'components', 'PayslipCards.tsx'],
  ['src', 'components', 'PayslipActions.tsx'],
  ['src', 'lib', 'payslip-view.ts'],
];
for (const parts of MINE) {
  const text = source(...parts);
  const name = parts.join('/');
  check(`${name} is on disk`, text !== '');
  check(`${name} has no em or en dash anywhere`, text !== '' && !/[\u2013\u2014]/.test(text));
  // Everything this slice replaces is deleted in the cleanup, so nothing here
  // may lean on it.
  check(
    `${name} leans on nothing the cleanup deletes`,
    text !== '' &&
      !/payout-store'|PayoutSchedule|\b(anchorFor|hasAnchor|periodAt|periodsThrough|periodLabel|linesIn|statusOf|readPayout|listPayoutsFor)\b/.test(text),
  );
  check(`${name} ends its lines with CRLF`, text !== '' && !/(^|[^\r])\n/.test(text));
}

console.log('\n- the wording rules -');
check('there was something to read', said.length > 20, said.length);
check('no dash or middle dot anywhere', said.every((text) => !/[\u2013\u2014\u00b7]/.test(text)), said);
check('and nothing about how the money is cut', said.every((text) => !/%|share|commission|gross|split/i.test(text)), said);
const props = JSON.stringify({ ready, countingDown, listed, lines });
check('the props hold no dash', !/[\u2013\u2014]/.test(props));
check('no percentage', !props.includes('%'));
check('and none of the words', !/share|commission|gross|split/i.test(props));

console.log(`\npayslip-view: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
