// The affiliate's payslips page, rendered rather than reasoned about.
//
// payslip-view-checks pins what the page is handed; this pins what it draws
// from it, which is where a wiring mistake hides: a button that is never
// disabled, a total that counts a card that left the list, a countdown with no
// day beside it, a select-all box that claims everything when half is ticked.
//
// RequestPayment and PayslipActions call useRouter, which throws outside a
// Next request. Rather than leave them unrendered, the router's own context is
// provided with a stand-in, so the real components mount. The table itself is
// also exported without its state, so every state it can be in (nothing
// chosen, some, all, sending, sent, refused) is rendered directly instead of
// clicked towards.
//
// The last section reads every piece of markup rendered here for the house
// rules an affiliate page lives under: no em or en dash, no percentage, and
// none of the words that describe how their money was cut.
//
//   npx tsx --tsconfig scripts/render.tsconfig.json scripts/payslip-render-checks.tsx
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime';
import {
  CountingDown,
  RequestPayment,
  RequestPaymentTable,
  YourRequests,
} from '../src/components/RequestPayment';
import { PayslipActions, PayslipActionsView } from '../src/components/PayslipActions';
import {
  cardsFor,
  nothingReadyText,
  requestRows,
  SUCCESS_MESSAGE,
  type CardRow,
  type Loaded,
} from '../src/lib/payslip-view';
import type { PayoutRequestRecord } from '../src/lib/payout-request-store';
import type { AffiliateLink, Conversion, Submission } from '../src/lib/types';
import { formatMoney } from '../src/lib/analytics';
import {
  attr,
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

/* Every page of markup rendered below, for the house rules at the end. */
const rendered: string[] = [];
function render(node: ReactNode): string {
  const html = renderToStaticMarkup(node);
  rendered.push(html);
  return html;
}

const router = {
  back() {},
  forward() {},
  refresh() {},
  hmrRefresh() {},
  push() {},
  replace() {},
  prefetch() {},
} as unknown as AppRouterInstance;

function inRouter(node: ReactNode): ReactNode {
  return <AppRouterContext.Provider value={router}>{node}</AppRouterContext.Provider>;
}

/** The inner text of the element with role="status", and whether it is polite. */
function status(html: string): { text: string; polite: boolean } | null {
  const match = /<([a-z]+)([^>]*\brole="status"[^>]*)>(.*?)<\/\1>/.exec(html);
  if (!match) return null;
  return { text: match[3]!.replace(/<[^>]+>/g, ''), polite: match[2]!.includes('aria-live="polite"') };
}

/** The attributes of the submit button, or null when there is none. */
function submitButton(html: string): string | null {
  for (const match of html.matchAll(/<button([^>]*)>(.*?)<\/button>/g)) {
    if (match[2]!.includes('Request payment') || match[2]!.includes('Requesting')) return match[1]!;
  }
  return null;
}

/** The attributes of the input whose aria-label is exactly `label`. */
function checkbox(html: string, label: string): string | null {
  for (const match of html.matchAll(/<input([^>]*)\/?>/g)) {
    if (match[1]!.includes(`aria-label="${label.replace(/&/g, '&amp;')}"`)) return match[1]!;
  }
  return null;
}

const SELECT_ALL = 'Select every card ready to request';

/* ---------------------------------------------------------------- fixtures --- */

function link(slug: string, campaign: string): AffiliateLink {
  return {
    id: `link-${slug}`,
    slug,
    usr: 'ana',
    assignee: 'Ana',
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

function conversion(id: string, slug: string, approvedOn: string, amount: number, notes = ''): Conversion {
  return { id, createdAt: `${approvedOn}T10:00:00.000Z`, approvedOn, slug, usr: 'ana', amount, notes };
}

const TODAY = '2026-10-10';
const LOAD: Loaded = {
  links: [link('platinum', 'Platinum Card'), link('cashback', 'Cash Back Card')],
  submissions: [{ id: 'abc1', fullName: 'Dana Okafor', email: 'dana@example.test' } as Submission],
  conversions: [
    conversion('101', 'platinum', '2026-08-01', 70, 'lead:abc1'),
    conversion('102', 'cashback', '2026-09-25', 70.5),
    conversion('103', 'platinum', '2026-09-26', 40, 'lead:abc1'),
    conversion('104', 'cashback', '2026-10-08', 25),
    conversion('105', 'platinum', '2026-08-02', 60),
    conversion('108', '', '2026-08-03', 12.25),
  ],
  gross: false,
};
const { ready, countingDown } = cardsFor(LOAD, 'ana', TODAY, new Set(['105']));

const noop = () => {};
function table(over: Partial<Parameters<typeof RequestPaymentTable>[0]> = {}): string {
  return render(
    <RequestPaymentTable
      rows={ready}
      selected={new Set<string>()}
      busy={false}
      message=""
      error={null}
      onToggle={noop}
      onToggleAll={noop}
      onSubmit={noop}
      {...over}
    />,
  );
}

console.log('- ready to request, nothing chosen -');
const none = table();
check('the section is named', none.includes('>Ready to request</h2>'));
for (const heading of ['Card', 'Customer', 'Approved', 'Amount']) {
  check(`the ${heading} column is drawn`, none.includes(`>${heading}</th>`));
}
check('the table scrolls in its own window', none.includes('role="region"') && none.includes('aria-label="Cards ready to request"'));
check('a select-all box heads the checkbox column', checkbox(none, SELECT_ALL) !== null);
check('one checkbox per card plus the select-all', (none.match(/type="checkbox"/g) || []).length === ready.length + 1);
for (const row of ready) {
  check(`the ${row.id} checkbox names its card, customer, day and money`, checkbox(none, row.label) !== null, row.label);
}
check(
  'which reads in full',
  checkbox(none, 'Platinum Card, customer Dana Okafor, approved 1 Aug 2026, $70') !== null,
);
check('no card is ticked', !/<input[^>]*checked=""/.test(none));
check('every card is on the page', ready.every((row) => none.includes(row.card)));
check('with its day', none.includes('1 Aug 2026') && none.includes('25 Sep 2026'));
check('and its money', none.includes('$70.50') && none.includes('$12.25'));
const idle = submitButton(none);
check('there is a Request payment button', idle !== null);
check('it cannot be pressed with nothing chosen', idle !== null && idle.includes('disabled=""'), idle);
check('it is the primary button', idle !== null && idle.includes('btn-primary'), idle);
const quiet = status(none);
check('the running total is a status', quiet !== null);
check('announced politely', quiet?.polite === true, quiet);
check('and says nothing is chosen', quiet?.text === 'No cards selected', quiet);
check('no error before anything is sent', !none.includes('role="alert"'));

console.log('\n- ready to request, on a phone and on anything wider -');
/*
 * Five columns do not fit a phone. At 400px the table's window is about 334px
 * wide, and asking for 640px there showed the box and half a card name, with
 * the money each card pays off past the right edge: an affiliate could tick
 * cards without seeing what they were worth. Below sm the table is three
 * columns instead: the box, the card with its customer and day under it, and
 * the amount. From sm up it keeps the five it always had.
 *
 * Still one table, with one row and one box per card. The customer and the day
 * are in the markup twice, as a column and as a line under the card, and each
 * copy is display:none at the width it does not belong to, so a screen reader
 * never hears either twice. table-markup reads the markup back one width at a
 * time to hold it to that.
 */
const same = (a: unknown[], b: unknown[]) => JSON.stringify(a) === JSON.stringify(b);
const wideOnly = (node: MarkupNode | undefined) =>
  node !== undefined && classesOf(node).includes('hidden') && classesOf(node).includes('sm:table-cell');
const readAt = (row: MarkupNode | undefined, width: Width) =>
  row ? cellsAt(row, width).map((cell) => textAt(cell, width)) : [];
const isBox = (node: MarkupNode) => node.tag === 'input' && attr(node, 'type') === 'checkbox';

const readyTable = tableIn(none, 'Cards ready to request');
/** The runs of text drawn inside `cell` at `width`, each with every element around it from the table in. */
const runsIn = (cell: MarkupNode | undefined, width: Width) =>
  readyTable && cell ? runsAt(readyTable, width).filter((run) => run.path.includes(cell)) : [];
check('the ready list is one table', readyTable !== null && (none.match(/<table/g) || []).length === 1);
const readyClasses = readyTable ? classesOf(readyTable) : [];
check(
  'it does not ask a phone for a width the phone does not have',
  !readyClasses.some((token) => token.startsWith('min-w-')),
  readyClasses,
);
check('and is wide enough not to crush five columns once there are five', readyClasses.includes('sm:min-w-[640px]'), readyClasses);

const readyHead = readyTable ? rowsIn(readyTable, 'thead')[0] : undefined;
check(
  'a phone heads three columns: the box, the card and the amount',
  same(readAt(readyHead, 'phone'), ['', 'Card', 'Amount']),
  readAt(readyHead, 'phone'),
);
check(
  'anything wider heads the five it always had',
  same(readAt(readyHead, 'desktop'), ['', 'Card', 'Customer', 'Approved', 'Amount']),
  readAt(readyHead, 'desktop'),
);
for (const width of SCREENS) {
  const first = readyHead ? cellsAt(readyHead, width)[0] : undefined;
  check(`the select-all box heads the first column on a ${width}`, first !== undefined && findAll(first, isBox).length === 1);
}
{
  const hidden = readyHead ? readyHead.children.filter((cell) => !shownAt(cell, 'phone')) : [];
  check('the Customer and Approved headings are hidden below sm', hidden.length === 2 && hidden.every(wideOnly), hidden.map(classesOf));
}

const readyRows = readyTable ? rowsIn(readyTable, 'tbody') : [];
check('one row per card, and no second list for the phone', readyRows.length === ready.length, readyRows.length);
readyRows.forEach((tr, index) => {
  const row = ready[index]!;
  const name = `card ${row.id}`;
  const boxes = findAll(tr, isBox);
  check(
    `${name}: exactly one checkbox in its row, and it is this card's`,
    boxes.length === 1 && attr(boxes[0]!, 'aria-label') === row.label,
    boxes.length,
  );
  for (const width of SCREENS) {
    check(
      `${name}: lines up under the headings on a ${width}`,
      readyHead !== undefined && columnsAt(tr, width) === columnsAt(readyHead, width),
      [columnsAt(tr, width), readyHead && columnsAt(readyHead, width)],
    );
    const first = cellsAt(tr, width)[0];
    check(`${name}: its box is in the first column on a ${width}`, first !== undefined && findAll(first, isBox).length === 1);
  }

  const [, stacked, amount] = cellsAt(tr, 'phone');
  const lines = stacked ? partsAt(stacked, 'phone') : [];
  check(
    `${name}: on a phone the card comes first, then the customer, then the day`,
    lines.length === 3 && lines[0] === row.card && lines[1] === row.customer && lines[2]!.includes(row.approved),
    lines,
  );
  check(
    `${name}: then the amount`,
    cellsAt(tr, 'phone').length === 3 && amount !== undefined && textAt(amount, 'phone') === formatMoney(row.amount),
    amount && textAt(amount, 'phone'),
  );
  check(
    `${name}: anything wider reads card, customer, day and amount in their own columns`,
    same(readAt(tr, 'desktop'), ['', row.card, row.customer, row.approved, formatMoney(row.amount)]),
    readAt(tr, 'desktop'),
  );
  check(
    `${name}: where the card's cell holds only the card`,
    stacked !== undefined && same(partsAt(stacked, 'desktop'), [row.card]),
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
    linesOnlyPhone.length === 2 && linesOnlyPhone.every((node) => classesOf(node).includes('sm:hidden')),
    linesOnlyPhone.map(classesOf),
  );
  // From sm up the name is cut to one line, with the rest in its title. A phone
  // has the height to spare and none of the width, so there it wraps, and a
  // name with no spaces in it breaks where it has to. Each is read at its own
  // width, since a class can cut a name short at one width and not the other.
  const [phoneName] = runsIn(stacked, 'phone');
  const onPhone = phoneName && wrapAt(phoneName.path, 'phone');
  check(
    `${name}: the card name wraps on a phone rather than being cut short`,
    phoneName?.text === row.card && onPhone?.whiteSpace === 'normal' && !onPhone.clipped,
    onPhone,
  );
  check(
    `${name}: and a name with no spaces in it breaks where it has to on a phone`,
    onPhone?.overflowWrap === 'anywhere',
    onPhone,
  );
  const [wideName] = runsIn(stacked, 'desktop');
  const onDesktop = wideName && wrapAt(wideName.path, 'desktop');
  check(
    `${name}: from sm up it is cut to one line, with the whole name in its title`,
    wideName?.text === row.card &&
      onDesktop?.whiteSpace === 'nowrap' &&
      onDesktop.clipped &&
      wideName.path.some((node) => attr(node, 'title') === row.card),
    onDesktop,
  );
  for (const width of SCREENS) {
    const figures = runsIn(amount, width);
    check(
      `${name}: the amount never wraps on a ${width}`,
      figures.length === 1 && wrapAt(figures[0]!.path, width).whiteSpace === 'nowrap',
      figures.map((run) => wrapAt(run.path, width)),
    );
  }
  check(`${name}: and the amount is set in figures`, amount !== undefined && classesOf(amount).includes('tnum'), amount && classesOf(amount));
});

console.log('\n- some chosen -');
const some = table({ selected: new Set(['101', '102']) });
const someStatus = status(some);
check('the running total counts and adds them', someStatus?.text === '2 cards selected, $140.50', someStatus);
check('the button can be pressed', !(submitButton(some) ?? 'disabled=""').includes('disabled'));
const someAll = checkbox(some, SELECT_ALL) ?? '';
check('the select-all box is not ticked', !someAll.includes('checked=""'), someAll);
check('it says it is part way', someAll.includes('data-selection="some"'), someAll);
check('the chosen card is ticked', (checkbox(some, ready[0]!.label) ?? '').includes('checked=""'));
check('and one not chosen is not', !(checkbox(some, ready[1]!.label) ?? 'checked=""').includes('checked=""'));

console.log('\n- all chosen -');
const all = table({ selected: new Set(ready.map((row) => row.id)) });
check('the total is every card', status(all)?.text === '3 cards selected, $152.75', status(all));
const allBox = checkbox(all, SELECT_ALL) ?? '';
check('the select-all box is ticked', allBox.includes('checked=""'), allBox);
check('and says so', allBox.includes('data-selection="all"'), allBox);
check('nothing chosen says none', (checkbox(none, SELECT_ALL) ?? '').includes('data-selection="none"'));

console.log('\n- a card that left the list -');
// 105 went onto a request in another tab. Still in the set, never counted.
const stale = table({ selected: new Set(['101', '105']) });
check('only the listed card is counted', status(stale)?.text === '1 card selected, $70', status(stale));
check('the select-all box is part way, not full', (checkbox(stale, SELECT_ALL) ?? '').includes('data-selection="some"'));
const onlyStale = table({ selected: new Set(['105']) });
check('a selection of only a stale card is nothing', status(onlyStale)?.text === 'No cards selected');
check('and cannot be sent', (submitButton(onlyStale) ?? '').includes('disabled=""'));

console.log('\n- sending -');
const sending = table({ selected: new Set(['101']), busy: true });
const busyButton = submitButton(sending) ?? '';
/*
 * Marked busy rather than disabled. It has the keyboard (Enter was just pressed
 * on it), and a focused button that turns disabled throws focus back to the top
 * of the page. RequestPayment's `sending` ref is what stops a second request.
 */
check('the button keeps the keyboard while it sends', busyButton.includes('aria-disabled="true"') && !busyButton.includes('disabled=""'), busyButton);
check('it says it is busy', busyButton.includes('aria-busy="true"'), busyButton);
check('in words', sending.includes('Requesting…'));
check('the checkboxes hold still while it sends', (checkbox(sending, ready[0]!.label) ?? '').includes('disabled=""'));

console.log('\n- sent -');
const sent = table({ message: SUCCESS_MESSAGE });
check('the live region says it went through', status(sent)?.text === SUCCESS_MESSAGE, status(sent));
// Once somebody starts choosing again, the old news gives way to the total.
const again = table({ message: SUCCESS_MESSAGE, selected: new Set(['101']) });
check('and gives way to the total once cards are chosen again', status(again)?.text === '1 card selected, $70', status(again));

console.log('\n- refused -');
const refusal = 'One of those approvals is already on a request.';
const refused = table({ selected: new Set(['101']), error: refusal });
check('the server says why, word for word', refused.includes(`role="alert"`) && refused.includes(refusal));
check('the selection survives a refusal', status(refused)?.text === '1 card selected, $70');

console.log('\n- nothing ready -');
const empty = table({ rows: [] as CardRow[] });
check('the section is still named', empty.includes('>Ready to request</h2>'));
check('it says when cards turn ready', empty.includes(nothingReadyText()));
check('with no table', !empty.includes('<table'));
check('and no button', submitButton(empty) === null);
const emptied = table({ rows: [] as CardRow[], message: SUCCESS_MESSAGE });
// Requesting every ready card empties the list on refresh. The news that it
// worked has to outlive the table it was sent from.
check('a request that emptied the list still says it went through', status(emptied)?.text === SUCCESS_MESSAGE, status(emptied));

console.log('\n- the real component, mounted -');
const live = render(inRouter(<RequestPayment rows={ready} />));
check('it renders the table', live.includes('>Card</th>'));
check('with nothing chosen', status(live)?.text === 'No cards selected');
check('and the button waiting', (submitButton(live) ?? '').includes('disabled=""'));
check('a checkbox per card', (live.match(/type="checkbox"/g) || []).length === ready.length + 1);
const liveEmpty = render(inRouter(<RequestPayment rows={[]} />));
check('an empty list mounts to the empty line', liveEmpty.includes(nothingReadyText()));

console.log('\n- counting down -');
const counting = render(<CountingDown rows={countingDown} />);
check('the section is named', counting.includes('>Counting down</h2>'));
check('one day left', counting.includes('1 day left'));
check('with the day it turns ready', counting.includes('Ready 11 Oct 2026'));
check('thirteen days left', counting.includes('13 days left'));
check('with its day too', counting.includes('Ready 23 Oct 2026'));
check('soonest first', counting.indexOf('1 day left') < counting.indexOf('13 days left'));
check('the card and customer are named', counting.includes('Platinum Card') && counting.includes('Dana Okafor'));
check('and the day it was approved', counting.includes('26 Sep 2026') && counting.includes('8 Oct 2026'));
check('and the money', counting.includes('$40') && counting.includes('$25'));
check('there is nothing to tick while a card is counting down', !counting.includes('type="checkbox"'));
check('nothing counting down draws nothing at all', renderToStaticMarkup(<CountingDown rows={[]} />) === '');

console.log('\n- your requests -');
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
const rows = requestRows([
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
    totalAmount: 25,
    items: [
      { conversionId: '104', amount: 10 },
      { conversionId: null, amount: 5 },
      { conversionId: '103', amount: 10 },
    ],
  }),
]);
const yours = render(<YourRequests rows={rows} />);
check('the section is named', yours.includes('>Your payments</h2>'));
check('each request links to its payslip', ['7', '12', '9'].every((id) => yours.includes(`href="/payslips/${id}"`)));
check('newest first', yours.indexOf('/payslips/12') < yours.indexOf('/payslips/9') && yours.indexOf('/payslips/9') < yours.indexOf('/payslips/7'));
check('every link says what it opens', (yours.match(/View payslip/g) || []).length === 3);
check('the link is a button-shaped link, never gold', !/class="[^"]*btn-[^"]*gold/.test(yours) && !/<a[^>]*chip-gold/.test(yours));
check('a waiting request is gold', yours.includes('chip chip-gold">Requested<'));
check('a paid one is green', yours.includes('chip chip-live">Paid<'));
check('a cancelled one is quiet', yours.includes('chip chip-quiet">Cancelled<'));
check('the card count is said', yours.includes('2 cards') && yours.includes('1 card') && yours.includes('3 cards'));
check('the total is printed', yours.includes('$140.50') && yours.includes('$70') && yours.includes('$25'));
check('the day it was requested', yours.includes('Requested 3 Oct 2026'));
check('and the day it was paid', yours.includes('Paid 8 Oct 2026'));
check('or cancelled', yours.includes('Cancelled 4 Oct 2026'));
const noRequests = render(<YourRequests rows={[]} />);
check('no payments says so', noRequests.includes('No payments yet.'));
check('and links nowhere', !noRequests.includes('href='));

console.log('\n- the payslip buttons -');
const unpaid = render(inRouter(<PayslipActions requestId="7" paid={false} confirmed={false} />));
check('a payslip can always be saved', unpaid.includes('Save as PDF'));
check('nothing to confirm before a payment is recorded', !unpaid.includes('Confirm it arrived'));
const paid = render(inRouter(<PayslipActions requestId="12" paid confirmed={false} />));
check('a recorded payment can be confirmed', paid.includes('Confirm it arrived'));
const confirmed = render(inRouter(<PayslipActions requestId="12" paid confirmed />));
check('and once confirmed it says so', confirmed.includes('You confirmed this payment arrived.'));
check('without offering it again', !confirmed.includes('Confirm it arrived'));

console.log('\n- where the keyboard goes -');
/*
 * A request that goes through clears the selection, so its button can no
 * longer be pressed, or empties the list, so the button is gone. Either way
 * the keyboard would be dropped, so it goes to the sentence saying it worked,
 * which is always in the page.
 */
{
  const line = /<p([^>]*\brole="status"[^>]*)>/.exec(sent)?.[1] ?? '';
  check('the running total can take the keyboard', line.includes('tabindex="-1"'), line);
  const emptiedLine = /<p([^>]*\brole="status"[^>]*)>/.exec(emptied)?.[1] ?? '';
  check('and still can once the list it was sent from is gone', emptiedLine.includes('tabindex="-1"'), emptiedLine);
}

console.log('\n- the payslip buttons, while they work -');
/** The attributes of the button whose words include `text`, or null. */
function buttonWith(html: string, text: string): string | null {
  for (const match of html.matchAll(/<button([^>]*)>(.*?)<\/button>/g)) {
    if (match[2]!.replace(/<[^>]+>/g, '').includes(text)) return match[1]!;
  }
  return null;
}
function actionsView(over: Partial<Parameters<typeof PayslipActionsView>[0]> = {}): string {
  return render(
    <PayslipActionsView paid confirmed={false} done={false} busy={false} error={null} onConfirm={noop} {...over} />,
  );
}
const awaiting = actionsView();
const awaitingButton = buttonWith(awaiting, 'Confirm it arrived');
check('a recorded payment offers to confirm it', awaitingButton !== null);
check('which is not held before it is pressed', awaitingButton !== null && !awaitingButton.includes('disabled'), awaitingButton);
const confirming = actionsView({ busy: true });
const confirmingButton = buttonWith(confirming, 'Saving');
check('confirming keeps the keyboard on the button', confirmingButton !== null && confirmingButton.includes('aria-disabled="true"') && !confirmingButton.includes('disabled=""'), confirmingButton);
check('and says it is busy', (confirmingButton ?? '').includes('aria-busy="true"'));
const confirmedNow = actionsView({ done: true });
check('once confirmed the button is gone', buttonWith(confirmedNow, 'Confirm it arrived') === null);
{
  const line = /<span([^>]*\brole="status"[^>]*)>/.exec(confirmedNow)?.[1] ?? '';
  check('and the sentence that replaces it can take the keyboard', line.includes('tabindex="-1"'), line);
}
check('it says the payment arrived', confirmedNow.includes('You confirmed this payment arrived.'));
const refusedConfirm = actionsView({ error: 'There is no payment recorded for that request yet.' });
check('a refusal is said out loud', refusedConfirm.includes('role="alert"') && refusedConfirm.includes('There is no payment recorded for that request yet.'));
check('and the button is still there to try again', buttonWith(refusedConfirm, 'Confirm it arrived') !== null);

console.log('\n- the house rules, across everything rendered -');
const everything = rendered.join('\n');
check('markup was rendered', rendered.length > 15 && everything.length > 5000, rendered.length);
check('no em dash or en dash', !/[\u2013\u2014]/.test(everything));
check('no middle dot', !everything.includes('\u00b7'));
check('no percentage', !everything.includes('%'));
check('none of the words that describe the cut', !/share|commission|gross|split/i.test(everything), /share|commission|gross|split/i.exec(everything)?.[0]);
check('no button is gold', !/<button[^>]*gold/.test(everything));

console.log(`\npayslip-render: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
