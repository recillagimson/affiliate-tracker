// The admin payouts page, rendered rather than reasoned about.
//
// payout-admin-checks pins the arithmetic. This pins the wiring, which is
// where a payout screen goes wrong without looking wrong: a paid request drawn
// with a Record payment button, a Cancel control on a request that is already
// paid, a mismatch that is computed and never shown, a house card priced onto
// the Pending list, a countdown with no day to plan around.
//
// PayoutRequests calls useRouter, which throws outside a Next request. Rather
// than leave it unrendered, as list-render-checks has to for UsersPanel, it is
// mounted inside the same AppRouterContext Next itself provides, holding a
// router that does nothing. Nothing here clicks, so nothing ever calls it.
//
// The payment panel opens on a click, which a static render cannot make. Its
// read-only half, the cards on the request, is its own component and is
// rendered directly below.
//
//   npx tsx --tsconfig scripts/render.tsconfig.json scripts/payout-admin-render-checks.tsx
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { PaymentFields, PayoutRequests, RequestCards } from '../src/components/PayoutRequests';
import { PayeeDetails } from '../src/components/PayeeDetails';
import { PendingApprovals } from '../src/components/PendingApprovals';
import { maskAccount } from '../src/lib/mask';
import {
  awaitingPayment,
  buildPayees,
  buildPending,
  buildRequestRows,
  describePending,
  indexPeople,
  mismatchNote,
  countRequestsByStatus,
  noRequestsText,
  REQUEST_FILTERS,
  pendingEmptyText,
  requestToggleId,
} from '../src/lib/payout-admin';
import { formatMoney, type ConversionView } from '../src/lib/analytics';
import { PAYOUT_DAYS, shortDay } from '../src/lib/payout';
import type { PayoutRequestRecord } from '../src/lib/payout-request-store';
import { BLANK } from '../src/lib/report-table';
import {
  cellsAt,
  classesOf,
  columnsAt,
  findAll,
  partsAt,
  rowsIn,
  runsAt,
  SCREENS,
  shownAt,
  tableIn,
  textAt,
  wrapAt,
  type MarkupNode,
  type Width,
} from './table-markup';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) pass++;
  else {
    fail++;
    console.error('FAIL:', name, extra === undefined ? '' : extra);
  }
}

const TODAY = '2026-10-10';

const idle = () => {};
const router = {
  back: idle,
  forward: idle,
  refresh: idle,
  hmrRefresh: idle,
  push: idle,
  replace: idle,
  prefetch: idle,
} as unknown as AppRouterInstance;

function render(element: ReactElement): string {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router}>{element}</AppRouterContext.Provider>,
  );
}

/** The markup of one section, from its heading to the end of its panel. */
function section(html: string, heading: string): string {
  const start = html.indexOf(`>${heading}</h2>`);
  if (start < 0) return '';
  const end = html.indexOf('</section>', start);
  return html.slice(start, end < 0 ? undefined : end);
}

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

const DASHES = /[\u2013\u2014]/;

const { byUserId, byUsr } = indexPeople([
  { userId: 'u1', fullName: 'Ana Lima', username: 'ana', usr: 'ana' },
  { userId: 'u2', fullName: '', username: 'dana', usr: 'dana' },
]);

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
    totalAmount: 50,
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
    items: [{ conversionId: '90', amount: 50 }],
    ...over,
  };
}

console.log('- the requests tab -');
const VIEWS = [
  view('10', { approvedOn: '2026-08-19' }),
  view('11', { approvedOn: '2026-08-21' }),
];
const rows = buildRequestRows(
  [
    request('1', {
      requestedAt: '2026-10-05T09:00:00+00:00',
      totalAmount: 70.35,
      items: [
        { conversionId: '10', amount: 35.2 },
        { conversionId: '11', amount: 35.15 },
        { conversionId: null, amount: 0 },
      ],
    }),
    request('2', {
      userId: 'u2',
      requestedAt: '2026-10-04T09:00:00+00:00',
      requestedBy: 'dana (via Mark)',
      totalAmount: 40,
    }),
    request('7', { userId: 'u9', requestedAt: '2026-10-06T09:00:00+00:00', totalAmount: 25 }),
    request('3', {
      status: 'paid',
      paidAt: '2026-10-06T12:00:00+00:00',
      amount: 100,
      totalAmount: 100,
      proof: { name: 'transfer.png', type: 'image/png', at: '2026-10-06T12:30:00+00:00', by: 'mark' },
      confirmedAt: '2026-10-07T08:00:00+00:00',
    }),
    request('4', {
      userId: 'u2',
      status: 'paid',
      paidAt: '2026-10-08T12:00:00+00:00',
      amount: 120,
      totalAmount: 140,
    }),
    request('5', { status: 'cancelled', cancelledAt: '2026-10-07T10:00:00+00:00', cancelledBy: 'mark' }),
    request('6', { status: 'cancelled', cancelledAt: '2026-10-09T10:00:00+00:00', cancelledBy: 'mark' }),
  ],
  byUserId,
  VIEWS,
);
const html = render(<PayoutRequests rows={rows} today={TODAY} />);
const needs = section(html, 'Needs payment');
const paid = section(html, 'Paid');
const cancelled = section(html, 'Cancelled');

check('the figure is named for what it is', html.includes('Awaiting payment'));
check(
  'and is what the unpaid requests come to',
  new RegExp(`class="mark[^"]*"[^>]*>\\${formatMoney(awaitingPayment(rows))}<`).test(html),
  formatMoney(awaitingPayment(rows)),
);
check('which is 135.35 here', formatMoney(awaitingPayment(rows)) === '$135.35');
check('the page has one highlighted figure', count(html, 'class="mark') === 1);
check('there is a way to find someone', html.includes('Find someone'));
check('by name or key', html.includes('placeholder="Name or tracking key"'));
check('and it is a search box', html.includes('type="search"'));

check('all three sections are drawn', Boolean(needs && paid && cancelled));
check(
  'in the order they are dealt with',
  html.indexOf('>Needs payment</h2>') < html.indexOf('>Paid</h2>') &&
    html.indexOf('>Paid</h2>') < html.indexOf('>Cancelled</h2>'),
);
check('each says what it holds', html.includes('Submitted by the affiliate. Record the payment once it is sent.'));
check('paid too', html.includes('Recorded as paid. Each one wants a receipt against it.'));
check('and cancelled', html.includes('Withdrawn before payment. The cards are free to be requested again.'));

check(
  'the longest wait is at the top',
  needs.indexOf('Requested 4 Oct 2026') < needs.indexOf('Requested 5 Oct 2026') &&
    needs.indexOf('Requested 5 Oct 2026') < needs.indexOf('Requested 6 Oct 2026'),
);
check('who asked is on the row', needs.includes('by ana'));
check('including an admin acting for them', needs.includes('by dana (via Mark)'));
check('the person is named', needs.includes('Ana Lima'));
check('with their key', needs.includes('usr=ana'));
check('an account the roster lacks is not left nameless', needs.includes('Unknown account'));
check('and has no key to show', needs.includes('No tracking key'));
check('how many cards', needs.includes('3 cards') && needs.includes('1 card'));
check('and what they come to', needs.includes(formatMoney(70.35)));

check('every unpaid request is gold', count(needs, 'chip chip-gold">Requested<') === 3);
check('every paid one is green', count(paid, 'chip chip-live">Paid<') === 2);
check('every cancelled one is quiet', count(cancelled, 'chip chip-quiet">Cancelled<') === 2);
check('no paid chip on a request nobody paid', !needs.includes('chip-live'));
check('a receipt on file can be opened', paid.includes('href="/api/payouts/receipt?request=3"'));
check('and opens away from the page', paid.includes('target="_blank"'));
check('a payment with no receipt says so, in gold', count(paid, 'chip chip-gold">No receipt<') === 1);
check('an unpaid request is not nagged for a receipt', !needs.includes('No receipt'));
check('a confirmed payment says so', paid.includes('>Confirmed<'));

check('every unpaid request can be approved', count(needs, '>Approve payment</button>') === 3);
check('and none of them offers to edit a payment', !needs.includes('Edit payment'));
check('a paid one is edited instead', count(paid, '>Edit payment</button>') === 2);
check('and never approved twice', !paid.includes('Approve payment'));
check('a cancelled request cannot be paid', !cancelled.includes('Approve payment') && !cancelled.includes('Edit payment'));
// The details and the fields live in a dialog now, so the button opens one
// rather than expanding the row in place.
check('the button says it opens a dialog', count(needs, 'aria-haspopup="dialog"') === 3);
// The row menu keeps its own aria-expanded; the approve button must not
// claim to expand anything, because what it opens is a dialog.
check(
  'and the approve button claims no expansion',
  !/<button[^>]*aria-haspopup="dialog"[^>]*aria-expanded/.test(html),
);
check('no dialog is in the page until one is opened', !html.includes('<dialog'));
check('but its cards can still be looked at', count(cancelled, '>Show cards</button>') === 2);
check('when it was cancelled, and by whom', cancelled.includes('Cancelled 9 Oct 2026') && cancelled.includes('by mark'));

/*
 * The menu's items are portalled in on a click, so what a static render can
 * see is the button that opens it. It is on every unpaid request and nowhere
 * else, which is the same rule canCancel pins in payout-admin-checks.
 */
check('every unpaid request has the menu that cancels it', count(needs, 'aria-haspopup="menu"') === 3);
check('named for whose request it is', needs.includes('aria-label="More actions for Ana Lima"'));
check('a paid request has no cancel', !paid.includes('aria-haspopup="menu"'));
check('nor does a cancelled one', !cancelled.includes('aria-haspopup="menu"'));

const mismatch = rows.find((row) => row.id === '4')!;
check(
  'a payment that differs from the request is said out loud',
  count(paid, mismatchNote(mismatch)) === 1,
  mismatchNote(mismatch),
);
check('with both figures in it', paid.includes(`Paid ${formatMoney(120)} against ${formatMoney(140)} requested.`));
check('and only on that one', count(html, 'An admin may have entered a different figure') === 1);

check('nothing is open before anybody opens it', !html.includes('Amount sent'));
check('the live region is there before there is anything to announce', html.includes('role="status"'));
check('no gold button anywhere', !html.includes('btn-gold') && !/<button[^>]*chip-gold/.test(html));
check('no em or en dash anywhere in it', !DASHES.test(html), html.match(DASHES));

console.log('\n- the requests tab with nothing in it -');
const empty = render(<PayoutRequests rows={[]} today={TODAY} />);
check('says there are no requests yet', empty.includes(noRequestsText(0, '')));
check('and draws no sections', !empty.includes('</h2>'));
check('nothing is awaiting payment', empty.includes('>$0<'));
check('no em or en dash in the empty page either', !DASHES.test(empty));

const unpaidOnly = render(<PayoutRequests rows={rows.filter((row) => row.status === 'requested')} today={TODAY} />);
check('a section with nothing in it is not drawn', !unpaidOnly.includes('>Paid</h2>') && !unpaidOnly.includes('>Cancelled</h2>'));
check('while the one with rows is', unpaidOnly.includes('>Needs payment</h2>'));

console.log('\n- the cards on a request -');
const first = rows.find((row) => row.id === '1')!;
const cards = renderToStaticMarkup(<RequestCards cards={first.cards} total={first.totalAmount} />);
for (const heading of ['Card', 'Customer', 'Approved', 'Amount']) {
  check(`the ${heading} column is drawn`, cards.includes(`>${heading}</th>`));
}
check('one line per card', count(cards, '<tr class="divider-row') === 3);
check('the card is named', cards.includes('Card 10'));
check('with its customer', cards.includes('Customer 10'));
check('and the day it was approved', cards.includes('19 Aug 2026'));
check('at the amount it was requested for', cards.includes(formatMoney(35.2)) && cards.includes(formatMoney(35.15)));
check('a line whose approval is gone reads blank', cards.includes('>-</td>'));
check('the total is the fixed one', cards.includes('Total requested') && cards.includes(formatMoney(70.35)));
check('no em or en dash in the cards', !DASHES.test(cards));

console.log('\n- the cards on a request, on a phone and on anything wider -');
/*
 * The admin opens this panel to see exactly what they are about to pay. With
 * four columns in a phone's 334px window, each card name was crushed to a word
 * a line and the amounts sat past the edge, where $4,110 read as "$4,11". A
 * phone gets two columns: the card with its customer and day under it, then
 * the amount. Anything wider keeps the four it had.
 *
 * One row per card either way. The customer, the day and the words in the
 * footer are in the markup twice, once for each width, and each copy is
 * display:none at the width it does not belong to, so a screen reader hears it
 * once. table-markup reads the markup back one width at a time to hold it to
 * that.
 */
const sameList = (a: unknown[], b: unknown[]) => JSON.stringify(a) === JSON.stringify(b);
const wideOnly = (node: MarkupNode | undefined) =>
  node !== undefined && classesOf(node).includes('hidden') && classesOf(node).includes('sm:table-cell');
const readAt = (row: MarkupNode | undefined, width: Width) =>
  row ? cellsAt(row, width).map((cell) => textAt(cell, width)) : [];

const cardsTable = tableIn(cards, 'Cards on this request');
/** The runs of text drawn inside `cell` at `width`, each with every element around it from the table in. */
const runsIn = (cell: MarkupNode | undefined, width: Width) =>
  cardsTable && cell ? runsAt(cardsTable, width).filter((run) => run.path.includes(cell)) : [];
check('the cards are one table', cardsTable !== null && count(cards, '<table') === 1);
check(
  'which asks a phone for no width of its own',
  cardsTable !== null && !classesOf(cardsTable).some((token) => token.startsWith('min-w-')),
  cardsTable && classesOf(cardsTable),
);
const cardsHead = cardsTable ? rowsIn(cardsTable, 'thead')[0] : undefined;
const cardsFoot = cardsTable ? rowsIn(cardsTable, 'tfoot')[0] : undefined;
const cardRows = cardsTable ? rowsIn(cardsTable, 'tbody') : [];

check(
  'a phone heads two columns: the card and the amount',
  sameList(readAt(cardsHead, 'phone'), ['Card', 'Amount']),
  readAt(cardsHead, 'phone'),
);
check(
  'anything wider heads the four it had',
  sameList(readAt(cardsHead, 'desktop'), ['Card', 'Customer', 'Approved', 'Amount']),
  readAt(cardsHead, 'desktop'),
);
{
  const hidden = cardsHead ? cardsHead.children.filter((cell) => !shownAt(cell, 'phone')) : [];
  check('the Customer and Approved headings are hidden below sm', hidden.length === 2 && hidden.every(wideOnly), hidden.map(classesOf));
}

check('one row per card, and no second list for the phone', cardRows.length === first.cards.length, cardRows.length);
cardRows.forEach((tr, index) => {
  const card = first.cards[index]!;
  const name = card.conversionId ? `card ${card.conversionId}` : 'the released line';
  const day = card.approvedOn ? shortDay(card.approvedOn) : '';
  for (const width of SCREENS) {
    check(
      `${name}: lines up under the headings on a ${width}`,
      cardsHead !== undefined && columnsAt(tr, width) === columnsAt(cardsHead, width),
      [columnsAt(tr, width), cardsHead && columnsAt(cardsHead, width)],
    );
  }

  const [stacked, amount] = cellsAt(tr, 'phone');
  const lines = stacked ? partsAt(stacked, 'phone') : [];
  if (day) {
    check(
      `${name}: on a phone the card comes first, then the customer, then the day`,
      lines.length === 3 && lines[0] === card.card && lines[1] === card.customer && lines[2]!.includes(day),
      lines,
    );
  } else {
    // Its approval is gone, so there is no day to put under it, and a line
    // saying only "Approved -" would be a line about nothing.
    check(`${name}: on a phone reads blank for the card and customer, with no day line`, sameList(lines, [card.card, card.customer]), lines);
  }
  check(
    `${name}: then the amount`,
    cellsAt(tr, 'phone').length === 2 && amount !== undefined && textAt(amount, 'phone') === formatMoney(card.amount),
    amount && textAt(amount, 'phone'),
  );
  check(
    `${name}: anything wider reads its four columns`,
    sameList(readAt(tr, 'desktop'), [card.card, card.customer, day || BLANK, formatMoney(card.amount)]),
    readAt(tr, 'desktop'),
  );
  check(
    `${name}: where the card cell holds only the card`,
    stacked !== undefined && sameList(partsAt(stacked, 'desktop'), [card.card]),
    stacked && partsAt(stacked, 'desktop'),
  );

  const columnsOnlyWide = tr.children.filter((cell) => !shownAt(cell, 'phone'));
  check(
    `${name}: its customer and day columns are hidden below sm`,
    columnsOnlyWide.length === 2 && columnsOnlyWide.every(wideOnly),
    columnsOnlyWide.map(classesOf),
  );
  const linesOnlyPhone = stacked ? findAll(stacked, (node) => !shownAt(node, 'desktop')) : [];
  check(
    `${name}: the lines under the card are sm:hidden`,
    linesOnlyPhone.length === (day ? 2 : 1) && linesOnlyPhone.every((node) => classesOf(node).includes('sm:hidden')),
    linesOnlyPhone.map(classesOf),
  );
  // Read one width at a time, since a class can cut a name short at one width
  // and not at the other.
  for (const width of SCREENS) {
    const [cardName] = runsIn(stacked, width);
    const wrap = cardName && wrapAt(cardName.path, width);
    check(
      `${name}: the card name wraps on a ${width}, and is never cut short`,
      cardName?.text === card.card && wrap?.whiteSpace === 'normal' && !wrap.clipped,
      [cardName?.text, wrap],
    );
    const figures = runsIn(amount, width);
    check(
      `${name}: the amount never wraps on a ${width}`,
      figures.length === 1 && wrapAt(figures[0]!.path, width).whiteSpace === 'nowrap',
      figures.map((run) => wrapAt(run.path, width)),
    );
  }
  {
    const [cardName] = runsIn(stacked, 'phone');
    const wrap = cardName && wrapAt(cardName.path, 'phone');
    check(`${name}: and a name with no spaces in it breaks where it has to on a phone`, wrap?.overflowWrap === 'anywhere', wrap);
  }
  check(`${name}: and the amount is set in figures`, amount !== undefined && classesOf(amount).includes('tnum'), amount && classesOf(amount));
});

/*
 * The footer's words span the three columns before the amount from sm up. On
 * a phone there is one column before it, and a cell still spanning three would
 * push the total two columns past the amounts it totals. So the words are a
 * cell for each width, each hidden at the other.
 */
for (const width of SCREENS) {
  check(
    `the total lines up under the amounts on a ${width}`,
    cardsFoot !== undefined && cardsHead !== undefined && columnsAt(cardsFoot, width) === columnsAt(cardsHead, width),
    [cardsFoot && columnsAt(cardsFoot, width), cardsHead && columnsAt(cardsHead, width)],
  );
  check(
    `and says Total requested once, then the figure, on a ${width}`,
    sameList(readAt(cardsFoot, width), ['Total requested', formatMoney(first.totalAmount)]),
    readAt(cardsFoot, width),
  );
}
{
  const total = cardsFoot ? cellsAt(cardsFoot, 'phone').at(-1) : undefined;
  for (const width of SCREENS) {
    const figures = runsIn(total, width);
    check(
      `the total never wraps on a ${width}`,
      figures.length === 1 && wrapAt(figures[0]!.path, width).whiteSpace === 'nowrap',
      figures.map((run) => wrapAt(run.path, width)),
    );
  }
}

console.log('\n- the pending tab -');
const PENDING_VIEWS = [
  view('p1', { usr: 'ana', approvedOn: '2026-08-20', amount: 50, card: 'Alpha' }),
  view('p2', { usr: 'ana', approvedOn: '2026-08-26', amount: 20, card: 'Beta' }),
  view('p3', { usr: 'dana', approvedOn: '2026-09-01', amount: 30, card: 'Gamma' }),
  view('p4', { usr: 'dana', approvedOn: '2026-09-09', amount: 40, card: 'Delta' }),
  view('p5', { usr: '', person: 'House', approvedOn: '2026-08-01', amount: 80, card: 'House Card' }),
  view('p6', { usr: 'ana', approvedOn: '2026-08-01', amount: 60, card: 'Spoken For' }),
  view('p7', { usr: 'zed', person: 'Zed Link', approvedOn: '2026-08-15', amount: 10, card: 'Epsilon' }),
  view('p8', { usr: 'ana', approvedOn: '2026-09-25', amount: 15, card: 'Zeta' }),
  view('p10', { usr: 'dana', approvedOn: '2026-08-27', amount: 12.5, card: 'Eta' }),
];
const pending = buildPending(PENDING_VIEWS, byUsr, TODAY, new Set(['p6']));
const pendingHtml = renderToStaticMarkup(<PendingApprovals {...pending} />);
const ready = section(pendingHtml, 'Ready to request');
const counting = section(pendingHtml, `Not yet ${PAYOUT_DAYS} days`);

check('the summary line is drawn', pendingHtml.includes(describePending(pending)));
check('and is not highlighted, being a count rather than a debt', !pendingHtml.includes('class="mark'));
check('both sections are drawn', Boolean(ready && counting));
check(
  'ready first',
  pendingHtml.indexOf('>Ready to request</h2>') < pendingHtml.indexOf(`>Not yet ${PAYOUT_DAYS} days</h2>`),
);
check('each says what it means', pendingHtml.includes('45 days have passed. Nothing happens until the affiliate asks to be paid.'));
check('the other too', pendingHtml.includes('Not old enough to request yet.'));

check('every ready card is marked ready, in gold', count(ready, 'chip chip-gold">Ready<') === 3);
check('and nothing counting down is', !counting.includes('chip-gold'));
check('a ready card says the day it became ready', ready.includes('Ready 10 Oct 2026'));
check(
  'ready, oldest approval first',
  ready.indexOf('>Epsilon<') < ready.indexOf('>Alpha<') && ready.indexOf('>Alpha<') < ready.indexOf('>Beta<'),
);
check('a countdown says how long', counting.includes('6 days left'));
check('and the day to put in a calendar', counting.includes('Ready 16 Oct 2026'));
check('one day is singular', counting.includes('1 day left'));
check(
  'soonest first',
  counting.indexOf('>Eta<') < counting.indexOf('>Gamma<') &&
    counting.indexOf('>Gamma<') < counting.indexOf('>Delta<') &&
    counting.indexOf('>Delta<') < counting.indexOf('>Zeta<'),
);
check('a house card is not on the list', !pendingHtml.includes('House Card'));
check('nor a card already on a request', !pendingHtml.includes('Spoken For'));
check('the person is named', counting.includes('dana') && ready.includes('Ana Lima'));
check('a key with no account is named from its link', ready.includes('Zed Link'));
check('with the customer', counting.includes('Customer p3'));
check('the day it was approved', counting.includes('1 Sep 2026'));
check('and what it is worth to them', counting.includes(formatMoney(12.5)));
check('nothing to press on a list nobody acts on yet', !pendingHtml.includes('<button'));
check('no em or en dash anywhere in it', !DASHES.test(pendingHtml), pendingHtml.match(DASHES));

console.log('\n- the pending tab with nothing in it -');
const never = renderToStaticMarkup(<PendingApprovals {...buildPending([], byUsr, TODAY, new Set())} />);
check('nothing ever approved says so', never.includes(pendingEmptyText(0)));
check('and draws no sections', !never.includes('</h2>'));
const allAsked = renderToStaticMarkup(
  <PendingApprovals
    {...buildPending(PENDING_VIEWS, byUsr, TODAY, new Set(PENDING_VIEWS.map((row) => row.id)))}
  />,
);
check('everything already asked for says that instead', allAsked.includes(pendingEmptyText(8)));
check('and draws no sections either', !allAsked.includes('</h2>'));
const notYet = renderToStaticMarkup(
  <PendingApprovals
    {...buildPending(PENDING_VIEWS.filter((row) => row.approvedOn >= '2026-08-27'), byUsr, TODAY, new Set())}
  />,
);
check('with nothing ready, the ready section is not drawn', !notYet.includes('>Ready to request</h2>'));
check('but the countdown is', notYet.includes(`>Not yet ${PAYOUT_DAYS} days</h2>`));
check('and the line says nothing is ready yet', notYet.includes('Nothing is ready to request yet.'));
check('no em or en dash in any empty state', ![never, allAsked, notYet].some((markup) => DASHES.test(markup)));

console.log('\n- where the keyboard goes back to -');
/*
 * Recording a payment moves its row to Paid, clearing one moves it back, and
 * cancelling takes the row's menu away, so the control that was pressed is
 * gone once the page refreshes. Focus goes to the row's own button, found by
 * this id, which every request has in every section.
 */
for (const row of rows) {
  check(`request ${row.id} has one button with its id`, count(html, `id="${requestToggleId(row.id)}"`) === 1);
}
check('a cancelled row keeps it, once its menu is gone', cancelled.includes(`id="${requestToggleId('5')}"`));
{
  const line = /<p([^>]*\brole="status"[^>]*)>/.exec(html)?.[1] ?? '';
  check('the saved line can take the keyboard when there is nothing else', line.includes('tabindex="-1"'), line);
}

console.log('\n- the payment panel -');
/*
 * The panel opens on a click, so it is drawn here directly, in every state it
 * can be in while an action runs.
 *
 * The button that was pressed is marked busy, never disabled: a focused
 * button that turns disabled throws the keyboard back to the top of the page.
 * The others are disabled, since nobody is on them, and that is what shows the
 * row is busy.
 */
type Row = (typeof rows)[number];
const unpaidRow = rows.find((row) => row.id === '1')!;
const paidRow = rows.find((row) => row.id === '3')!;
function panel(row: Row, working = false, doing = ''): string {
  return renderToStaticMarkup(
    <PaymentFields
      row={row}
      today={TODAY}
      draft={{ amount: '', paidOn: TODAY, reference: '', note: '' }}
      setDraft={idle}
      problems={{}}
      working={working}
      doing={doing}
      fileInput={{ current: null }}
      onPay={idle}
      onAttach={idle}
      onRemoveProof={idle}
      onClear={idle}
    />,
  );
}
/** The attributes of the button whose words include `text`, or null. */
function button(markup: string, text: string): string | null {
  for (const match of markup.matchAll(/<button([^>]*)>(.*?)<\/button>/g)) {
    if (match[2]!.replace(/<[^>]+>/g, '').includes(text)) return match[1]!;
  }
  return null;
}
/** The attributes of the file input, or ''. */
function fileInputOf(markup: string): string {
  return /<input([^>]*\btype="file"[^>]*)>/.exec(markup)?.[1] ?? '';
}
const pressedNotDisabled = (attrs: string | null) =>
  attrs !== null && attrs.includes('aria-disabled="true"') && !attrs.includes('disabled=""');
const disabled = (attrs: string | null) => attrs !== null && attrs.includes('disabled=""');

const unpaidPanel = panel(unpaidRow);
check('an unpaid request records a payment', button(unpaidPanel, 'Record payment') !== null);
check('and attaches a receipt', button(unpaidPanel, 'Attach receipt') !== null);
check('with nothing to clear or remove', button(unpaidPanel, 'Clear payment') === null && button(unpaidPanel, 'Remove receipt') === null);
check('nothing is held while nothing runs', !unpaidPanel.includes('disabled=""') && !unpaidPanel.includes('aria-disabled="true"'));

const paidPanel = panel(paidRow);
check('a paid request saves its payment', button(paidPanel, 'Save payment') !== null);
check('replaces its receipt', button(paidPanel, 'Replace receipt') !== null);
check('and can remove it, or clear the payment', button(paidPanel, 'Remove receipt') !== null && button(paidPanel, 'Clear payment') !== null);

/*
 * The file picker is opened by the button beside it, so it is out of the tab
 * order, where it would be a stop nobody can see. It is still named, for a
 * screen reader that walks the page rather than tabbing it.
 */
check('the file picker is not a stop of its own', fileInputOf(unpaidPanel).includes('tabindex="-1"'), fileInputOf(unpaidPanel));
check('and says what it is for', fileInputOf(unpaidPanel).includes('aria-label="Attach a receipt for Ana Lima"'), fileInputOf(unpaidPanel));
check('in the words of the button beside it', fileInputOf(paidPanel).includes('aria-label="Replace the receipt for Ana Lima"'), fileInputOf(paidPanel));

const paying = panel(paidRow, true, 'pay');
check('saving a payment keeps the keyboard on its button', pressedNotDisabled(button(paying, 'Saving')), button(paying, 'Saving'));
check('which says it is busy', (button(paying, 'Saving') ?? '').includes('aria-busy="true"'));
check(
  'while the rest are held',
  disabled(button(paying, 'Replace receipt')) && disabled(button(paying, 'Remove receipt')) && disabled(button(paying, 'Clear payment')),
);

const replacing = panel(paidRow, true, 'proof');
check('replacing a receipt keeps the keyboard on its button', pressedNotDisabled(button(replacing, 'Replacing')), button(replacing, 'Replacing'));
check('and only that one says it is working', button(replacing, 'Saving') === null && disabled(button(replacing, 'Save payment')));
const attaching = panel(unpaidRow, true, 'proof');
check('attaching one says so in its own words', pressedNotDisabled(button(attaching, 'Attaching')), button(attaching, 'Attaching'));
const removing = panel(paidRow, true, 'remove-proof');
check('removing a receipt keeps the keyboard on its button', pressedNotDisabled(button(removing, 'Removing')), button(removing, 'Removing'));
const clearing = panel(paidRow, true, 'clear');
check('clearing a payment keeps the keyboard on its button', pressedNotDisabled(button(clearing, 'Clearing')), button(clearing, 'Clearing'));
const cancelling = panel(unpaidRow, true, 'cancel');
check(
  'a cancel from the menu holds every button in the panel',
  disabled(button(cancelling, 'Record payment')) && disabled(button(cancelling, 'Attach receipt')) && !cancelling.includes('aria-disabled="true"'),
);

const panels = [unpaidPanel, paidPanel, paying, replacing, attaching, removing, clearing, cancelling].join('\n');
check('no em or en dash in the panel', !DASHES.test(panels), panels.match(DASHES));
check('no gold button in it', !/<button[^>]*gold/.test(panels));

console.log('\n- showing one status at a time -');
const filters = render(<PayoutRequests rows={rows} today={TODAY} />);
check('every option is offered', REQUEST_FILTERS.every((option) => filters.includes(`>${option.label}<`)));
check('all is the one in force before anybody picks', filters.includes('aria-pressed="true"'));
check('and only one is', count(filters, 'aria-pressed="true"') === 1);
const filterCounts = countRequestsByStatus(rows);
check(
  'each option carries how many it would show',
  REQUEST_FILTERS.every((option) =>
    filters.includes(`${option.label}<span class="tnum text-[11px]">${filterCounts[option.key]}</span>`),
  ),
  REQUEST_FILTERS.map((option) => `${option.label}=${filterCounts[option.key]}`).join(' '),
);
check('which is 7 requests over three sections', filterCounts.all === 7);

const onlyPaid = render(<PayoutRequests rows={rows} today={TODAY} status="paid" />);
check('paid draws its own section', Boolean(section(onlyPaid, 'Paid')));
check('and no other', !onlyPaid.includes('>Needs payment</h2>') && !onlyPaid.includes('>Cancelled</h2>'));
check('the option in force is the pressed one', onlyPaid.includes('aria-pressed="true">Paid'));
check('the figure above is still what is owed, not what is shown', onlyPaid.includes(formatMoney(awaitingPayment(rows))));

const noneCancelled = render(
  <PayoutRequests rows={rows.filter((row) => row.status !== 'cancelled')} today={TODAY} status="cancelled" />,
);
check('a status with nothing in it says so', noneCancelled.includes('Nothing under Cancelled.'));
check('and does not pretend nobody has requested anything', !noneCancelled.includes(noRequestsText(0, '')));
check('no em or en dash in any of it', ![filters, onlyPaid, noneCancelled].some((markup) => DASHES.test(markup)));


console.log('\n- who is being paid, in the approve dialog -');
const PAYEES = buildPayees(
  [
    {
      userId: 'u1',
      username: 'rusinque',
      fullName: 'Stefany Rusinque',
      email: 'stefany@example.com',
      position: 'Affiliate',
      mobile: '+1 555 0100',
      usr: 'd4wz7v',
    },
  ],
  [
    {
      userId: 'u1',
      savedAt: '2026-08-01T00:00:00Z',
      accountName: 'Stefany Rusinque',
      bankName: 'Chase',
      accountLast4: '4321',
    },
  ],
);
const payeeHtml = renderToStaticMarkup(<PayeeDetails payee={PAYEES.u1!} />);
check('the person is named', payeeHtml.includes('Stefany Rusinque'));
check('with the details a payment is checked against', ['rusinque', 'stefany@example.com', '+1 555 0100', 'd4wz7v'].every((value) => payeeHtml.includes(value)));
check('the bank is named', payeeHtml.includes('Chase'));
check('the account number is masked', payeeHtml.includes(maskAccount('4321')));
check('and is never in the markup whole', !payeeHtml.includes('>4321<'));
check('reading it whole is a deliberate press', payeeHtml.includes('>Reveal</span>') || payeeHtml.includes('Reveal'));
check('it is not listed twice, once stale', count(payeeHtml, maskAccount('4321')) === 1);
const noBank = renderToStaticMarkup(<PayeeDetails payee={{ ...PAYEES.u1!, bank: null }} />);
check('no bank details is said, not left blank', noBank.includes('No bank details on file'));
check('and nothing offers to reveal a number that is not there', !noBank.includes('Reveal'));
const noPayee = renderToStaticMarkup(<PayeeDetails payee={null} />);
check('a request under an unknown account says so', noPayee.includes('not on the affiliate roster'));
check('no em or en dash in any of it', ![payeeHtml, noBank, noPayee].some((markup) => DASHES.test(markup)));


console.log(`\npayout-admin-render: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
