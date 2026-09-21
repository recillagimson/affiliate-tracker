// Paging and filtering a list, rendered rather than reasoned about.
//
// The arithmetic is pinned in paging-checks; this pins the wiring, which is
// where the mistakes actually are: a slice taken but the whole list still
// mapped, a filter that lists nobody, a page counter reading the wrong total.
// Rendering the real component and reading the markup back catches all three,
// and none of them are visible in a type check.
//
// UsersPanel is not rendered: it calls useRouter at the top, which cannot be
// mounted outside a Next request. Its filtering is exported as a plain
// function instead and checked directly at the bottom of this file; the rest
// is covered by the Pager checks below and by pageSlice in paging-checks.
//
// The extra tsconfig switches on the automatic JSX runtime. The app's own is
// "preserve", because Next does that step itself.
//
//   npx tsx --tsconfig scripts/render.tsconfig.json scripts/list-render-checks.tsx
import { renderToStaticMarkup } from 'react-dom/server';
import { RowMenu, RowMenuItem } from '../src/components/RowMenu';
import { ApprovalsList } from '../src/components/ApprovalsList';
import { CpaBrowser } from '../src/components/CpaBrowser';
// The grouping, the columns and the sort moved out of the component once the
// downloads started reading them too. The checks follow them rather than go
// through a re-export, so there is one place they are defined.
import {
  columnsFor,
  defaultSort,
  groupRates,
  tierCount,
  tiersOf,
} from '../src/lib/cpa-groups';
import { listShowing, problemsIn } from '../src/components/CampaignSettings';
import { US_STATES } from '../src/lib/address';
import { ratesForViewer } from '../src/lib/cpa';
import { BLANK, sortRows } from '../src/lib/report-table';
import { EarnersTable } from '../src/components/EarnersTable';
import { LinksBrowser, type LinkRow } from '../src/components/LinksBrowser';
import { Pager } from '../src/components/Pager';
import { matchAccounts, type AccountRow } from '../src/components/UsersPanel';
import { W9Form, type W9Prefill } from '../src/components/onboarding/W9Form';
import { AgreementForm } from '../src/components/onboarding/AgreementForm';
import { ProfileForm } from '../src/components/onboarding/ProfileForm';
import { OnboardingRail } from '../src/components/OnboardingRail';
import { LockedDocument } from '../src/components/onboarding/LockedDocument';
import { peopleInListOrder, personLabel, type KnownPerson } from '../src/components/LinkForm';
import { AGREEMENT_VERSION, COMPANY } from '../src/lib/agreement';
import { NO_BYPASS, UNREVIEWED, type Approval, type Bypass } from '../src/lib/approval';
import { ApprovalPill } from '../src/components/ApprovalPill';
import { visibleItems } from '../src/components/Nav';
import { appliedSummary, applyLabel, leadPlanNote } from '../src/components/ReportRunner';
import {
  CardName,
  LEAD_FILTERS,
  StatusNote,
  StatusPill,
  StatusToggle,
  filterLabel,
  leadCounts,
  matchesFilter,
  noLeadsText,
  withShownStatus,
  type LeadRow,
} from '../src/components/LeadsPanel';
import { statusLabel } from '../src/lib/status';
import { NOTHING_DONE, STEPS } from '../src/lib/onboarding';
import { affiliateRevenueOf, formatMoney, type ConversionView, type EarningsRow } from '../src/lib/analytics';
import type { CpaRate, LeadStatus } from '../src/lib/types';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) pass++;
  else {
    fail++;
    console.error('FAIL:', name);
  }
}

const PEOPLE = ['mark', 'dana', 'ali'];

/** Every seventh link is a house link: no key, no assignee. */
function row(i: number): LinkRow {
  const usr = i % 7 === 0 ? '' : PEOPLE[i % PEOPLE.length]!;
  return {
    id: `id${i}`,
    slug: `slug-${i}`,
    usr,
    assignee: usr ? usr.toUpperCase() : '',
    assigneeEmail: '',
    destination: 'https://example.test/offer',
    campaign: `Campaign ${i}`,
    headline: '',
    subheadline: '',
    ctaLabel: '',
    requirePhone: false,
    passUsrParam: 'subid',
    active: i % 3 !== 0,
    notes: '',
    createdAt: `2026-08-${String((i % 27) + 1).padStart(2, '0')}T00:00:00.000Z`,
    visits: i * 3,
    submissions: i,
    url: `https://example.test/slug-${i}?usr=${usr}`,
  };
}

const rows = Array.from({ length: 23 }, (_, i) => row(i + 1));

console.log('— links —');
const html = renderToStaticMarkup(<LinksBrowser rows={rows} capture canEdit={false} />);
const linkRows = (html.match(/<tr class="divider-row/g) || []).length;
check('the first page holds ten rows, not all twenty-three', linkRows === 10);
check('the count is of the whole matched list', html.includes('Showing 1 to 10 of 23'));
check('and the page count follows from it', html.includes('Page 1 of 3'));
check('the size picker is offered', html.includes('>250</option>'));
check('the person filter is drawn', html.includes('id="link-person"'));
check('with everyone as the way out of it', html.includes('>Everyone</option>'));
check('one entry per person', PEOPLE.every((p) => html.includes(`>${p.toUpperCase()}</option>`)));
check('house links get an entry of their own', html.includes('>House links</option>'));
check('the status counts count within the person scope', html.includes('All 23'));

/*
 * The redesign turned each card into a row. These pin the columns rather than
 * the styling: a column quietly dropped in a refactor is invisible in a type
 * check, and invisible in a screenshot of a table that still looks like a
 * table.
 */
for (const heading of ['Campaign', 'Owner', 'Short link', 'Status', 'Visits', 'Leads', 'Conversion']) {
  check(`the ${heading} column is drawn`, html.includes(`>${heading}</th>`));
}
check('a live link says so', html.includes('>Live</span>'));
check('and a paused one says that', html.includes('>Paused</span>'));
check('every row can be copied', (html.match(/>Copy</g) || []).length === 10);
// An affiliate may copy their links but not change them.
check('but not paused by someone who cannot edit', !html.includes('aria-label="Pause the link'));
check('nor deleted', !html.includes('aria-label="Delete the link'));
check('where the link forwards to is still on the row', html.includes('example.test/offer'));
// The admin side of that is not rendered here: LinkActions calls useRouter, so
// canEdit={true} cannot be mounted outside a Next request.

// With the capture form off there are no leads, so the two columns that count
// them go rather than standing at zero forever.
const noCapture = renderToStaticMarkup(<LinksBrowser rows={rows} capture={false} canEdit={false} />);
check('no capture form, no Leads column', !noCapture.includes('>Leads</th>'));
check('and no conversion column either', !noCapture.includes('>Conversion</th>'));
check('visits stay, because they are counted either way', noCapture.includes('>Visits</th>'));
check('and the leads sort goes with them', !noCapture.includes('>Most leads first</option>'));

// Under the smallest page size there is no page to turn and no size worth
// choosing, so the controls go away and the count stays.
const short = renderToStaticMarkup(<LinksBrowser rows={rows.slice(0, 6)} capture canEdit={false} />);
check('a short list says so plainly', short.includes('Showing all 6'));
check('and offers no page buttons', !short.includes('Previous'));
check('nor a size picker', !short.includes('>250</option>'));

// One person, one entry: the affiliate's own view, where the filter would be a
// control with a single possible answer.
const mine = rows.filter((r) => r.usr === 'mark');
const own = renderToStaticMarkup(<LinksBrowser rows={mine} capture canEdit={false} />);
check('a single person gets no person filter', !own.includes('id="link-person"'));

console.log('\n— the pager on its own —');
const noop = () => {};
const accounts = renderToStaticMarkup(
  <Pager total={23} page={3} perPage={10} onPage={noop} onPerPage={noop} label="Accounts" />,
);
check('the last page stops at the last row', accounts.includes('Showing 21 to 23 of 23'));
check('it is named for what it holds', accounts.includes('Accounts'));
const empty = renderToStaticMarkup(
  <Pager total={0} page={1} perPage={10} onPage={noop} onPerPage={noop} />,
);
check('an empty list says nothing to show', empty.includes('Nothing to show'));
check('and offers no controls', !empty.includes('Previous'));
const noted = renderToStaticMarkup(
  <Pager total={23} page={1} perPage={10} onPage={noop} onPerPage={noop} note=", sorted" />,
);
check('a note rides along with the count', noted.includes('of 23, sorted'));

console.log('\n— who is earning —');
const earners: EarningsRow[] = Array.from({ length: 23 }, (_, i) => ({
  key: 'k' + i,
  usr: 'usr' + i,
  person: 'Person ' + i,
  card: '',
  cardCount: 2,
  visits: 100 + i,
  approved: i,
  earnings: 12.35 + i,
  /*
   * The affiliate's cut, worked out on the server one approval at a time and
   * handed over. Not derived from `earnings` here, and not derivable: a row can
   * hold approvals earned under two different commission rates.
   */
  affiliate: affiliateRevenueOf(12.35 + i),
  approvalRate: 0.1,
}));
const earnerTotals = {
  visits: 1,
  approved: 1,
  earnings: earners.reduce((s, r) => s + r.earnings, 0),
  affiliate: earners.reduce((s, r) => s + r.affiliate, 0),
  approvalRate: 0.1,
};
const table = renderToStaticMarkup(
  <EarnersTable rows={earners} totals={earnerTotals} period="month" gross />,
);
check('ten people to a page', (table.match(/<tr class="divider-row/g) || []).length === 10);
check('the money column is called Amount now', table.includes('>Amount</th>'));
check('and it is joined by the affiliate share', table.includes('>Affiliate revenue</th>'));
check('earnings is not a column heading any more', !table.includes('>Total earnings</th>'));
check('a row shows half of its own amount', table.includes(formatMoney(affiliateRevenueOf(12.35))));
// The footer is the whole window, not the page, and it says so.
const total = Math.round(earners.reduce((s, r) => s + affiliateRevenueOf(r.earnings), 0) * 100) / 100;
check('the total is the sum of the rows', table.includes(formatMoney(total)));
check('the footer admits it counts more than the page', table.includes('everyone, not just this page'));
check('and the people page through', table.includes('Showing 1 to 10 of 23'));

/*
 * The same table read by the affiliate it belongs to. Their rows arrive already
 * halved, so the Amount column is dropped rather than blanked — and the halving
 * must not happen a second time here, which would quietly pay them a quarter.
 */
const ownRows = earners.map((row) => ({
  ...row,
  earnings: affiliateRevenueOf(row.earnings),
  // Already their share, so the two columns hold the same figure. That is what
  // buildEarnings produces for a reader who is not shown the gross.
  affiliate: affiliateRevenueOf(row.earnings),
}));
const ownTable = renderToStaticMarkup(
  <EarnersTable
    rows={ownRows}
    totals={{
      ...earnerTotals,
      earnings: affiliateRevenueOf(earnerTotals.earnings),
      affiliate: Math.round(ownRows.reduce((s, r) => s + r.affiliate, 0) * 100) / 100,
    }}
    period="month"
    gross={false}
  />,
);
check('an affiliate is shown no Amount column', !ownTable.includes('>Amount</th>'));
check('but still the affiliate revenue', ownTable.includes('>Affiliate revenue</th>'));
check('their row is their half, not a quarter of it', ownTable.includes(formatMoney(affiliateRevenueOf(12.35))));
check(
  'and the merchant gross is nowhere in the page',
  !ownTable.includes(formatMoney(12.35)) && !ownTable.includes(formatMoney(earnerTotals.earnings)),
);
check('the total is still the sum of the column above it', ownTable.includes(formatMoney(total)));
check('they still page through', ownTable.includes('Showing 1 to 10 of 23'));

console.log('\n— approvals —');
const approvals: ConversionView[] = Array.from({ length: 23 }, (_, i) => ({
  id: 'c' + i,
  createdAt: '2026-08-01T00:00:00.000Z',
  approvedOn: '2026-08-12',
  slug: 'slug',
  usr: 'usr',
  amount: 100 + i,
  notes: '',
  person: 'Person ' + i,
  card: 'Card',
  // What this one approval paid the affiliate, at the rate in force the day it
  // was approved. Worked out on the server, like every other figure here.
  affiliate: affiliateRevenueOf(100 + i),
  client: '-',
  note: '',
}));
/*
 * canEdit stays false throughout: DeleteApproval calls useRouter, which cannot
 * be mounted outside a Next request. What that costs is one column; what it
 * buys is the ability to check the two that matter here.
 */
const list = renderToStaticMarkup(
  <ApprovalsList rows={approvals} canEdit={false} gross empty="none" />,
);
check('ten approvals to a page', (list.match(/<tr class="divider-row/g) || []).length === 10);
check('with the rest a page away', list.includes('Showing 1 to 10 of 23'));
for (const heading of ['Date', 'Person', 'Card']) {
  check(`the ${heading} column is drawn`, list.includes(`>${heading}</th>`));
}
check('an admin sees what the merchant paid', list.includes('>Payout</th>'));
check('and the share of it beside', list.includes('>Affiliate share</th>'));
check('with both figures on the row', list.includes(formatMoney(100)));
check('and the share worked out', list.includes(formatMoney(affiliateRevenueOf(100))));
check('nothing to press without the right to press it', !list.includes('>Actions</th>'));

/*
 * The same rows as an affiliate reads them. Their amounts arrive already
 * worked out, so there is one money column, it is called Amount, and it prints
 * what it was given: halving an already-halved figure would quarter it, and a
 * column called "affiliate share" would name a split they are not shown.
 */
const theirOwn = approvals.map((row) => ({
  ...row,
  amount: affiliateRevenueOf(row.amount),
  affiliate: affiliateRevenueOf(row.amount),
}));
const theirs = renderToStaticMarkup(
  <ApprovalsList rows={theirOwn} canEdit={false} gross={false} empty="none" />,
);
check('an affiliate gets one money column', theirs.includes('>Amount</th>'));
check('not the merchant payout', !theirs.includes('>Payout</th>'));
check('and nothing calling it a share', !theirs.includes('>Affiliate share</th>'));
check('their figure is printed as it arrived', theirs.includes(formatMoney(affiliateRevenueOf(100))));
// 100 is a merchant payout and nobody's share, so finding it would mean the
// gross had reached a page it was halved before ever leaving the server.
check('and the merchant payout it came from is nowhere on the page', !theirs.includes(formatMoney(100)));

// One person's own page: the heading names them, so the column would be that
// name repeated down the side of it.
const solo = renderToStaticMarkup(
  <ApprovalsList rows={approvals} canEdit={false} gross={false} showPerson={false} empty="none" />,
);
check('their own page drops the Person column', !solo.includes('>Person</th>'));
check('but keeps the card', solo.includes('>Card</th>'));

const noApprovals = renderToStaticMarkup(
  <ApprovalsList rows={[]} canEdit={false} gross empty="none yet" />,
);
check('an empty history says so and stops', noApprovals.includes('none yet') && !noApprovals.includes('Showing'));

console.log('\n— the CPA rate card —');
/*
 * Twelve cards paying one flat rate and three paying by tier, which is the
 * shape of the real export. Fifteen cards, twenty-one rates: the difference
 * between those two numbers is what the grouping and the pager are for.
 */
const flat: CpaRate[] = Array.from({ length: 12 }, (_, i) => ({
  placement: '714025 - LGF',
  issuer: i % 2 === 0 ? 'AmEx Consumer' : 'Capital One',
  card: 'Flat Card ' + i,
  tier: '',
  current: i === 5 ? 0 : 100 + i,
  previous: i === 7 ? null : 90 + i,
  change: i === 7 ? null : 0.1,
  changedOn: i === 9 ? '' : '2026-07-01',
}));
const tiered: CpaRate[] = ['Platinum', 'Gold', 'Venture'].flatMap((name, card) =>
  [1, 2, 3].map((tier) => ({
    placement: '714025 - LGF',
    issuer: 'AmEx Consumer',
    card: name + ' Card',
    tier: 'Tier ' + tier,
    current: 400 + card * 10 + tier * 100,
    previous: 300,
    change: 0.1,
    changedOn: '2026-07-01',
  })),
);
// Tiered first, so the fold controls land on the first page where these
// checks can see them. The store sorts by issuer and card, which puts the
// AmEx tiers near the top of the real card too.
const rates = [...tiered, ...flat];
const card = renderToStaticMarkup(<CpaBrowser rows={ratesForViewer(rates, true)} gross />);

// Fifteen cards out of twenty-one rates: the page counts cards.
check('a page is ten cards, not ten rates', (card.match(/aria-expanded|Flat Card/g) || []).length >= 10);
check('the pager counts cards', card.includes('Showing 1 to 10 of 15'));
check('and names them', card.includes('Cards'));
check('there is a search box', card.includes('id="cpa-search"'));
check('the columns are sortable', card.includes('aria-sort'));
check('the rate column is named for what it answers', card.includes('Pays now'));
check('the affiliate half has a column', card.includes('Potential revenue'));
// 100 for the first flat card, so the affiliate keeps 50.
check('and it is half of what the card pays', card.includes(formatMoney(affiliateRevenueOf(100))));
/*
 * Their own two-card fixture, small enough that neither paging nor sorting can
 * hide the subject. Both of these used to read the main table, where they found
 * what they were looking for only because the cheapest cards happened to arrive
 * first — so defaulting the sort to highest-paying pushed both off page one and
 * failed two checks that were really about formatting.
 */
const edges: CpaRate[] = [
  {
    placement: '714025 - LGF',
    issuer: 'AmEx Consumer',
    card: 'Pays Nothing Card',
    tier: '',
    current: 0,
    previous: 0,
    change: null,
    changedOn: '2026-07-01',
  },
  {
    placement: '714025 - LGF',
    issuer: 'Capital One',
    card: 'Modest Card',
    tier: '',
    current: 100,
    previous: 90,
    change: 0.1,
    changedOn: '2026-07-01',
  },
];
const edgeCard = renderToStaticMarkup(<CpaBrowser rows={ratesForViewer(edges, true)} gross />);
const edgeOwn = renderToStaticMarkup(<CpaBrowser rows={ratesForViewer(edges, false)} gross={false} />);

check('a card at zero pays the affiliate zero, not a dash', (edgeCard.match(/\$0/g) || []).length >= 2);

// The grouping itself.
check('a tiered card is foldable', card.includes('aria-expanded="true"'));
check('and says how many tiers it has', card.includes('>3</span>'));
check('its tiers are drawn under it', card.includes('Tier 1') && card.includes('Tier 3'));
check('with an indent marker', card.includes('↳'));
check('a screen reader still hears which card a tier belongs to', card.includes('Platinum Card, '));
check('there is a way to fold them all', card.includes('Fold every card'));
// A flat card has no tiers to fold, so it gets a dash rather than a control.
const flatOnly = renderToStaticMarkup(<CpaBrowser rows={ratesForViewer(flat, true)} gross />);
check('a card with one rate has nothing to fold', !flatOnly.includes('aria-expanded'));
check('and no fold-everything button', !flatOnly.includes('Fold every card'));
check('twelve flat cards is twelve cards', flatOnly.includes('Showing 1 to 10 of 12'));

const noRates = renderToStaticMarkup(<CpaBrowser rows={[]} gross />);
check('an empty card says nothing is uploaded', noRates.includes('No rates uploaded yet'));
check('and offers no page controls', !noRates.includes('Previous'));

console.log('\n— sorting by tier —');
/*
 * The Tier column puts cards in order by how many tiers they pay at, which is
 * the number the badge shows. A card with no tiers has nothing to be ordered
 * by, so it reads blank and sinks, the same as every other blank here.
 */
const cardGroups = groupRates(ratesForViewer(rates, true));
check('a three-tier card counts three', tierCount(cardGroups[0]!) === 3);
check('a flat card counts nothing at all', tierCount(cardGroups[3]!) === null);

const byTier = sortRows(cardGroups, tierCount, 'number', 'desc');
check('the tiered cards come first', byTier.slice(0, 3).every((g) => g.tiered));
check('and the flat ones sink', byTier.slice(3).every((g) => !g.tiered));
check(
  'ascending sinks them too — a blank is not a low number',
  sortRows(cardGroups, tierCount, 'number', 'asc').slice(3).every((g) => !g.tiered),
);

// The direction has to mean something inside the card as well, or "highest
// first" reorders three cards and leaves Tier 1 at the top of each of them.
const platinum = cardGroups[0]!;
check(
  'unsorted, the tiers read as the report writes them',
  tiersOf(platinum, null).map((r) => r.tier).join() === 'Tier 1,Tier 2,Tier 3',
);
check(
  'highest first turns the tiers round',
  tiersOf(platinum, { key: 'tier', direction: 'desc' }).map((r) => r.tier).join() ===
    'Tier 3,Tier 2,Tier 1',
);
check(
  'lowest first puts them back',
  tiersOf(platinum, { key: 'tier', direction: 'asc' }).map((r) => r.tier).join() ===
    'Tier 1,Tier 2,Tier 3',
);
check(
  'sorting by another column leaves the tiers alone',
  tiersOf(platinum, { key: 'current', direction: 'desc' }).map((r) => r.tier).join() ===
    'Tier 1,Tier 2,Tier 3',
);
check('and the card itself is never reordered in place', platinum.rates[0]!.tier === 'Tier 1');

console.log('\n— the banding —');
/*
 * Every other card sits on a band and takes its tiers with it. Read off the
 * rendered rows rather than trusted: the rule is only worth anything if a
 * tiered card's four rows really do come out one colour.
 */
const body = card.slice(card.indexOf('<tbody>'), card.indexOf('</tbody>'));
const banded = [...body.matchAll(/<tr class="([^"]*)"/g)].map((m) => m[1]!.includes('bg-paper-sunk'));
check('the first page draws every row', banded.length === 19);
check('the first card takes no band', banded.slice(0, 4).every((on) => !on));
check('the second card takes one, tiers and all', banded.slice(4, 8).every((on) => on));
check('the third takes none again', banded.slice(8, 12).every((on) => !on));
check(
  'and flat cards alternate a row at a time',
  banded.slice(12).join(',') === 'true,false,true,false,true,false,true',
);
check('a table with no tiers still stripes', flatOnly.includes('bg-paper-sunk'));

console.log('\n— the rate card, as an affiliate reads it —');
/*
 * Half, and only half. The merchant's rate, what it paid before and how it
 * moved are dropped from the rows themselves, so this checks the page source
 * rather than the columns: a hidden column that still ships the number is not
 * hidden from anybody who can open dev tools.
 */
const ownCard = renderToStaticMarkup(<CpaBrowser rows={ratesForViewer(rates, false)} gross={false} />);
check('there is no Pays now column', !ownCard.includes('Pays now'));
check('no Paid before column', !ownCard.includes('Paid before'));
// The quote at the end is load-bearing: 'Sort by Change' is a prefix of
// 'Sort by Changed', and the Changed column is one this reader keeps.
check('no Change column', !ownCard.includes('title="Sort by Change"'));
check('the potential revenue stays', ownCard.includes('Potential revenue'));
check('and so does the day the rate changed', ownCard.includes('title="Sort by Changed"'));
// 700 is the top tier of the Platinum fixture, so 350 is the half.
check('the half is printed', ownCard.includes(formatMoney(350)));
check('the merchant rate is not printed', !ownCard.includes(formatMoney(700)));
// 90 is a flat card's previous rate and is nobody's half, so finding it
// would mean the merchant's own figure had reached the page.
check('nor the rate it paid before', !edgeOwn.includes(formatMoney(90)) && edgeCard.includes(formatMoney(90)));

console.log('\n— what the rate card opens on —');
{
  /*
   * The table used to open unsorted, which is alphabetical by issuer: an order
   * that answers "who do we work with" when the question this page exists for
   * is "which card is worth pushing".
   */
  check('the money column, highest first', defaultSort(true).direction === 'desc');
  check('an admin opens on what the merchant pays', defaultSort(true).key === 'current');
  /* "Pays now" is admin-only. Naming it for an affiliate would leave the table
     unsorted, because the sort is looked up among the columns that viewer was
     given, and the arrow would be drawn on no header at all. */
  check('an affiliate opens on their own half instead', defaultSort(false).key === 'affiliate');
  check('which is a column they have', columnsFor(false).some((c) => c.key === defaultSort(false).key));
  check('as is the admin one', columnsFor(true).some((c) => c.key === defaultSort(true).key));

  /*
   * The rendered order, not the intent. Venture tops out at 720, Gold at 710,
   * Platinum at 700 — so this also pins that a tiered card is ranked on its
   * best tier rather than on its name, which alphabetical order would reverse.
   */
  const rank = (html: string, name: string) => html.indexOf(name);
  check('the highest payer is the first row', rank(card, 'Venture Card') < rank(card, 'Gold Card'));
  check('and the order runs down from there', rank(card, 'Gold Card') < rank(card, 'Platinum Card'));
  check('with the flat cards below all three', rank(card, 'Platinum Card') < rank(card, 'Flat Card'));
  check('the header says which way it points', card.includes('aria-sort="descending"'));
  // Ten cards to a page, so the cheapest of fifteen is no longer on the first.
  check('the card paying nothing is off page one', !card.includes('Flat Card 5'));

  check('an affiliate sees the same ranking', rank(ownCard, 'Venture Card') < rank(ownCard, 'Gold Card'));
  check('and their column carries the arrow', ownCard.includes('aria-sort="descending"'));
}
check('the cards are still grouped and foldable', ownCard.includes('aria-expanded="true"'));
check('the tiers are still listed', ownCard.includes('Tier 1') && ownCard.includes('Tier 3'));
check('the banding survives the narrower table', ownCard.includes('bg-paper-sunk'));
check('and it is still sortable by tier', ownCard.includes('Sort by Tier'));
check('the Tier heading is a control now', card.includes('Sort by Tier'));

console.log('\n— narrowing it down, and taking it away —');
{
  /*
   * The search box was the only filter here, and searching is the wrong tool
   * for "which cards are worth quoting": the answer to that is an amount, and
   * an amount is not a word you can type into a name.
   */
  check('there is an issuer to pick', card.includes('id="cpa-issuer"'));
  check('with every issuer on the card in it', card.includes('<option value="AmEx Consumer">') && card.includes('<option value="Capital One">'));
  check('and a way back to all of them', card.includes('Every issuer'));

  check('there is a floor', card.includes('id="cpa-min"'));
  check('in round numbers', card.includes('<option value="200">'));
  /*
   * The same control, worded twice. A floor reads against whichever money
   * column the viewer has, so 200 means the merchant's rate to an admin and
   * their own half to everybody else, and the label is the only thing that
   * says which.
   */
  check('an admin sets what a card pays', card.includes('Pays $200 or more'));
  check('an affiliate sets what they would earn', ownCard.includes('Earns $200 or more'));
  check('and never sees the merchant wording', !ownCard.includes('Pays $200 or more'));

  check('there is a tiers filter', card.includes('id="cpa-shape"'));
  check('with both kinds of card and each on its own', card.includes('Tiered and flat') && card.includes('>Tiered cards<') && card.includes('One rate only'));

  // Nothing is filtered on the first render, so there is nothing to clear.
  check('no clear button until something is set', !card.includes('>Clear</button>'));

  console.log('\n— the downloads —');
  check('a PDF can be had', card.includes('/api/cpa/export?format=pdf'));
  check('so can a spreadsheet', card.includes('/api/cpa/export?format=xlsx'));
  check('and the data on its own', card.includes('/api/cpa/export?format=csv'));
  check('an affiliate gets all three too', ['pdf', 'xlsx', 'csv'].every((format) => ownCard.includes(`/api/cpa/export?format=${format}`)));
  /*
   * A download follows the table: the same cards, in the same order. Unfiltered
   * that is the sort and nothing else, and the ampersands are entities because
   * this is an href in HTML rather than a URL in a string.
   */
  check('the link carries the order the table is in', card.includes('format=pdf&amp;sort=current&amp;dir=desc'));
  check('which on their copy is their own column', ownCard.includes('format=pdf&amp;sort=affiliate&amp;dir=desc'));
  check('and no filter, because none is set', !card.includes('&amp;q=') && !card.includes('&amp;min=') && !card.includes('&amp;issuer='));
  check('the reader is told what a download will contain', card.includes('A download takes all 15 cards.'));
  check('and that it is not just the page they are on', !card.includes('takes the 15 cards this filter'));
}

console.log('\n— the campaign settings table —');
/*
 * What the Save button is allowed to send. A duplicate name is the one that
 * matters: the link form looks a destination up by name, so two rows called
 * "Cash Back" would make which URL a link gets depend on the order they happen
 * to be in.
 */
const settingsRow = (key: number, name: string, destination: string) => ({ key, name, destination });

const cleanRows = problemsIn([
  settingsRow(0, 'Best Cards', 'https://example.com?src=1'),
  settingsRow(1, 'Cash Back', ''),
]);
check('a good row and a URL-less row both pass', Object.keys(cleanRows).length === 0);

const dupeRows = problemsIn([settingsRow(0, 'Cash Back', ''), settingsRow(1, 'cash back', '')]);
check('a duplicate name is caught whatever its case', Boolean(dupeRows[1]));
check('and only the second one is blamed', !dupeRows[0]);

check('a URL with no name is caught', Boolean(problemsIn([settingsRow(0, '', 'https://example.com')])[0]));
// Clearing both fields is how a row is deleted, so it must not be an error.
check('a wholly blank row is not an error', Object.keys(problemsIn([settingsRow(0, '', '')])).length === 0);
check('half a URL is caught', Boolean(problemsIn([settingsRow(0, 'Best Cards', 'example.com')])[0]));
check(
  'and so is a javascript: url',
  Boolean(problemsIn([settingsRow(0, 'Best Cards', 'javascript:alert(1)')])[0]),
);
check(
  'surrounding space does not make a name blank',
  Object.keys(problemsIn([settingsRow(0, '  Best Cards  ', '  https://example.com  ')])).length === 0,
);

/*
 * Whether two dozen rows of inputs are on the screen. Folded away is the
 * resting state, because the commission and the rate card sit above this list
 * and were being pushed off the page by it. The override is the part worth
 * holding: unsaved work is never folded away, whatever the toggle says.
 */
check('the list starts folded away', listShowing(false, false, 0) === false);
check('the toggle opens it', listShowing(true, false, 0) === true);
check('unsaved changes hold it open', listShowing(false, true, 0) === true);
check('so does a row that needs fixing', listShowing(false, false, 1) === true);
check('an open list with a broken row stays open', listShowing(true, false, 2) === true);
check('and once it is saved it can fold away again', listShowing(false, false, 0) === false);

/*
 * Two sides of the same records, and neither side sees the other's door.
 * Payouts is everybody's requests on one page; a payslip is one person's own.
 * The payouts search box is checked with the rest of that tab, as
 * matchesPerson in payout-admin-checks.
 */
check('an admin gets payouts', visibleItems(true).some((item) => item.href === '/payouts'));
check('and not a payslip tab, having no payslips', !visibleItems(true).some((item) => item.href === '/payslips'));
check('an affiliate gets their payslip', visibleItems(false).some((item) => item.href === '/payslips'));
check('and never payouts', !visibleItems(false).some((item) => item.href === '/payouts'));

console.log('\n— accounts —');
/*
 * UsersPanel itself cannot be rendered here — it calls useRouter at the top,
 * which needs a Next request — so the filtering is pulled out as a plain
 * function and checked directly. That is the part with the bugs in it: the
 * table around it is the same table as everywhere else in the app.
 */
function account(i: number, over: Partial<AccountRow> = {}): AccountRow {
  return {
    id: `u${i}`,
    username: `user${i}`,
    role: i === 0 ? 'admin' : 'affiliate',
    usr: i === 0 ? '' : `key${i}`,
    fullName: `Person ${i}`,
    email: `person${i}@example.test`,
    active: true,
    createdAt: '2026-08-01T00:00:00.000Z',
    lastLoginAt: null,
    createdBy: 'seed',
    setup: null,
    // An admin is not reviewed; the affiliates below are approved unless a
    // check says otherwise.
    approval: i === 0 ? null : { ...UNREVIEWED, status: 'approved' },
    bypass: i === 0 ? null : { ...NO_BYPASS },
    ...over,
  };
}
const accountRows = [
  account(0, { username: 'arthur', fullName: 'Arthur Reyes' }),
  account(1, { username: 'dana', fullName: 'Dana Okafor', email: 'dana@elsewhere.test' }),
  account(2, { username: 'ali', fullName: 'Ali Haddad', usr: 'c89buy' }),
];
const names = (list: AccountRow[]) => list.map((r) => r.username).join();

check('no filter, everybody', matchAccounts(accountRows, '', 'all').length === 3);
check('a role narrows it', names(matchAccounts(accountRows, '', 'admin')) === 'arthur');
check('and so does the other one', matchAccounts(accountRows, '', 'affiliate').length === 2);
check('search finds a username', matchAccounts(accountRows, 'dana', 'all').length === 1);
check('and a full name', matchAccounts(accountRows, 'haddad', 'all').length === 1);
check(
  'and an email nobody would remember the username for',
  matchAccounts(accountRows, 'elsewhere', 'all').length === 1,
);
check(
  'and a tracking key, which is what an approval carries',
  matchAccounts(accountRows, 'c89buy', 'all').length === 1,
);
check('case does not matter', matchAccounts(accountRows, 'ARTHUR', 'all').length === 1);
check('surrounding space does not either', matchAccounts(accountRows, '  dana  ', 'all').length === 1);
check('the two filters compose', matchAccounts(accountRows, 'reyes', 'admin').length === 1);
check('and can leave nothing', matchAccounts(accountRows, 'dana', 'admin').length === 0);
check('a miss is empty, not everything', matchAccounts(accountRows, 'zzz', 'all').length === 0);

console.log('\n— the W-9, as rendered —');
/*
 * The IRS accepts a substitute Form W-9 only where the Part II certification
 * language is unaltered. Nothing about that is enforced by a type, and it is
 * exactly the sort of text somebody tidies up for line length one day — so the
 * four numbered certifications are pinned here word for word.
 */
const w9Html = renderToStaticMarkup(
  <W9Form initialName="Arthur Reyes" initialAddress="1 Example Street" today="2026-08-24" />,
);

check('it says which revision it is', w9Html.includes('(Rev. March 2024)'));
check('and where the real one lives', w9Html.includes('www.irs.gov/FormW9'));
check('Part I is drawn', w9Html.includes('Taxpayer Identification Number'));
check('Part II is drawn', w9Html.includes('>Certification</span>'));
check(
  'the perjury preamble is verbatim',
  w9Html.includes('Under penalties of perjury, I certify that:'),
);
check(
  'certification 1 is verbatim',
  w9Html.includes(
    'The number shown on this form is my correct taxpayer identification number (or I am',
  ),
);
check(
  'certification 2 is verbatim',
  w9Html.includes('I am not subject to backup withholding because (a) I am exempt from backup'),
);
check(
  'certification 3 is verbatim',
  w9Html.includes('I am a U.S. citizen or other U.S. person (defined below); and'),
);
check(
  'certification 4 is verbatim',
  w9Html.includes('The FATCA code(s) entered on this form (if any) indicating that I am exempt'),
);
check(
  'and so are the certification instructions',
  w9Html.includes('You must cross out item 2 above if you have'),
);

// Every line the paper form has, by the number it prints.
for (const line of ['1', '2', '3a', '4', '5', '6', '7']) {
  check(`line ${line} is on the form`, w9Html.includes(`>${line}</span>`));
}
for (const option of ['Individual/sole proprietor', 'C corporation', 'S corporation', 'Partnership', 'Trust/estate', 'LLC']) {
  check(`the ${option} box is offered`, w9Html.includes(option));
}
check('the prefilled name arrives', w9Html.includes('value="Arthur Reyes"'));
check('so does the prefilled address', w9Html.includes('value="1 Example Street"'));
check('and the date it will be signed', w9Html.includes('2026-08-24'));
// 3b only applies to a partnership, a trust/estate, or an LLC taxed as one, and
// nothing is chosen on a fresh form.
check('3b is not asked before a box is checked', !w9Html.includes('foreign partners, owners, or beneficiaries'));
check('the requester is named for them', w9Html.includes('LaunchStone LLC'));
check('and the number is promised back masked', w9Html.includes('last four digits'));

console.log('\n— the step rail —');
const railFresh = renderToStaticMarkup(
  <OnboardingRail current="profile" state={{ ...NOTHING_DONE }} />,
);
check('every step is listed', STEPS.every((step) => railFresh.includes(step.label)));
check('it counts them', railFresh.includes('>0 of 4</span>'));
check('the optional one says so', railFresh.includes('Can wait'));
check('and it says what the first three are for', railFresh.includes('before you can use the dashboard'));

const railDone = renderToStaticMarkup(
  <OnboardingRail current="bank" state={{ profile: true, agreement: true, w9: true, bank: false }} />,
);
check('a finished step is ticked', railDone.includes('✓'));
check('and the count follows', railDone.includes('>3 of 4</span>'));

/*
 * Waived: two steps rather than four. The rail is the map of what is being
 * asked of somebody, and drawing two rooms that have been taken off the
 * building is how a waived affiliate ends up hunting for a W-9 nobody wants.
 */
const railWaived = renderToStaticMarkup(
  <OnboardingRail current="profile" state={{ ...NOTHING_DONE }} bypassed />,
);
check('a waived account still gets their own details', railWaived.includes('Your details'));
check('and their bank details', railWaived.includes('Bank details'));
check('but not the agreement', !railWaived.includes('Affiliate agreement'));
check('nor the W-9', !railWaived.includes('Form W-9'));
check('the count is out of two', railWaived.includes('>0 of 2</span>'));
check('nothing claims to be blocking them', !railWaived.includes('before you can use the dashboard'));
check('because nothing is', railWaived.includes('Neither of these is blocking'));

console.log('\n- a document that has settled -');
const settled = renderToStaticMarkup(
  <LockedDocument
    title="Signed"
    savedAt="24 Aug 2026"
    note="It is on file as part of your account now."
    facts={[
      { label: 'Name signed', value: 'Arthur Reyes' },
      { label: 'Effective date', value: '2026-08-24' },
    ]}
    signaturePng={'data:image/png;base64,' + 'A'.repeat(900)}
    downloadHref="/api/onboarding/u-1/agreement.pdf"
    onward={{ path: '/profile', label: 'Back to your profile' }}
  />,
);
check('it says what happened and when', settled.includes('Signed on 24 Aug 2026'));
check('the details are shown', settled.includes('Arthur Reyes'));
check('so is the signature that is on it', settled.includes('data:image/png;base64,'));
check('the file is offered', settled.includes('href="/api/onboarding/u-1/agreement.pdf"'));
check('and there is a way back', settled.includes('href="/profile"'));
/*
 * The point of this component. A disabled form is still a form: it looks like
 * somewhere to type and the only way to find out it is not is to fill it in and
 * be refused. There is nothing here to press that will not work.
 */
check('there is no form left to submit', !settled.includes('<form'));
check('and no button that would refuse', !settled.includes('<button'));
check('an empty fact reads as absent rather than blank', settled.includes('Not given') === false);

console.log('\n— the agreement, as rendered —');
const agreementHtml = renderToStaticMarkup(
  <AgreementForm initialName="Arthur Reyes" initialEmail="a@example.com" today="2026-08-24" />,
);

check('all twelve sections are set', [...Array(12).keys()].every((i) => agreementHtml.includes(`${i + 1}. `)));
check('section 12 is one of them', agreementHtml.includes('12. General'));
/*
 * The block the .docx ends on, which was missing: section 12 ran out and the
 * page went straight to the signature pad, so the four things typed at the top
 * never appeared as the execution of anything.
 */
check('the execution block is there', agreementHtml.includes('>Company</p>'));
check('with both parties', agreementHtml.includes('>Affiliate</p>'));
check('and the four lines each side', ['Signature:', 'Name:', 'Title:', 'Date:'].every((label) => agreementHtml.includes(label)));
check('the affiliate side fills in live', agreementHtml.includes('>Arthur Reyes</span>'));
check('and so does the date', agreementHtml.includes('>2026-08-24</span>'));
check('the company is named', agreementHtml.includes(COMPANY.name));
// The description that used to trail the company name everywhere.
check('and not described after its own name', !agreementHtml.includes('a limited liability company'));
check('the governing state is a visible blank until it is set', agreementHtml.includes('____________________'));
/*
 * The page somebody signs shows the wording in force, always. An older version
 * is only ever read back for a copy of something already signed, which is the
 * PDF's job and is checked in pdf-checks.
 */
check('the payment term they are agreeing to is Net 45', agreementHtml.includes('Net 45'));
check('section 4 spells it out the same way', agreementHtml.includes('net forty-five (45) days'));
check('and the term it replaced is nowhere on the page', !agreementHtml.includes('Net 30') && !agreementHtml.includes('net thirty'));
check('the version stamped on it is the one in force', agreementHtml.includes(AGREEMENT_VERSION));

console.log('\n— coming back to a step already done —');
const agreementAgain = renderToStaticMarkup(
  <AgreementForm
    initialName="Arthur Reyes"
    initialEmail="a@example.com"
    initialAddress={{
      line1: '1 Example Street',
      line2: '',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
    }}
    today="2026-08-24"
    previousSignature={'data:image/png;base64,' + 'A'.repeat(900)}
    revisiting
    backTo={{ path: '/welcome', label: 'Your details' }}
    continueTo="/welcome/w9"
    continueLabel="Continue to form w-9"
  />,
);
check('Back points at the step before', agreementAgain.includes('href="/welcome"'));
check('and says which one that is', agreementAgain.includes('Your details'));
check('there is a way out without signing again', agreementAgain.includes('href="/welcome/w9"'));
check('the button says what saving would do', agreementAgain.includes('Sign again and save'));
check('the address they gave comes back', agreementAgain.includes('1 Example Street'));
check('the city comes back with it', agreementAgain.includes('value="Austin"'));
check('and the ZIP', agreementAgain.includes('value="78701"'));
const texas = agreementAgain.match(/<option[^>]*value="TX"[^>]*>Texas<\/option>/)?.[0] ?? '';
check('the state they picked is the selected option', texas.includes('selected'));

/*
 * The address as a US form asks for it. It used to be one free-text box, which
 * let a state be typed as "Tex." and a ZIP be left off entirely, on a document
 * that then printed whatever was typed.
 */
check('the street has its own field', agreementHtml.includes('Street address'));
check('so does the apartment, marked optional', agreementHtml.includes('Apartment, suite, unit') && agreementHtml.includes('(optional)'));
check('so do the city and the ZIP', agreementHtml.includes('>City</span>') && agreementHtml.includes('ZIP code'));
check('the state is a list, not a spelling', agreementHtml.includes('<select') && agreementHtml.includes('Select a state'));
check('every state, the District and the territories are on it', US_STATES.every((state) => agreementHtml.includes(`value="${state.code}">${state.name}<`)));
check('the box it replaced is gone', !agreementHtml.includes('<textarea'));
// A browser that already knows where somebody lives should be able to fill the
// whole block, which is what these attributes are for.
check('the browser can autofill the block', ['address-line1', 'address-line2', 'address-level1', 'address-level2', 'postal-code'].every((token) => agreementHtml.includes(token)));
// Nothing is pre-picked: a state field that answers for somebody who has not
// looked at it is a state field that puts the wrong state on a contract.
check('nothing is picked until somebody picks it', !/<option selected value="[A-Z]{2}"/.test(agreementHtml));
check('the signature on file is shown', agreementAgain.includes('The signature currently on file'));
// Read-to-the-end gating is for a document nobody has read yet; making somebody
// scroll a contract they have already signed to get the button back is not a
// second reading, it is a scroll.
check('and the document does not have to be re-scrolled', agreementAgain.includes('You have read to the end'));
check('a first visit still has to scroll it', agreementHtml.includes('Scroll to the end of the agreement'));

const w9Again = renderToStaticMarkup(
  <W9Form
    initialName="Arthur Reyes"
    initialAddress="1 Example Street"
    today="2026-08-24"
    existing={{
      line1Name: 'Arthur Reyes',
      line2Business: 'Reyes Referrals',
      classification: 'individual',
      llcCode: '',
      otherText: '',
      foreignPartners: false,
      exemptPayeeCode: '',
      fatcaCode: '',
      address: '1 Example Street',
      cityStateZip: 'Austin, TX 78701',
      accountNumbers: '',
      tinType: 'ssn',
      tinLast4: '6789',
      signaturePng: 'data:image/png;base64,' + 'A'.repeat(900),
    } satisfies W9Prefill}
    revisiting
    backTo={{ path: '/welcome/agreement', label: 'Affiliate agreement' }}
    continueTo="/welcome/bank"
  />,
);
check('the filed W-9 comes back filled in', w9Again.includes('value="Reyes Referrals"'));
check('including the city line', w9Again.includes('value="Austin, TX 78701"'));
/*
 * The taxpayer number is the one field that cannot come back, because nothing
 * unseals it to fill in a form. What comes back is the mask and an instruction,
 * and the field itself must be empty — a prefilled-looking box that submits
 * nothing is how somebody ends up wiping their own SSN.
 */
check('the number on file is shown as a mask', w9Again.includes('•••-••-6789'));
check('with the field left empty', w9Again.includes('Leave empty to keep it'));
check('and said in words too', w9Again.includes('Leave this empty to keep it'));
check('Back points at the agreement', w9Again.includes('href="/welcome/agreement"'));
check('the last signature is shown', w9Again.includes('The signature currently on file'));
// Nothing carried over from the last certification: perjury is affirmed now or
// not at all.
check('the certification starts unticked', !w9Again.includes('type="checkbox" checked=""'));

const profileAgain = renderToStaticMarkup(
  <ProfileForm
    initialName="Arthur Reyes"
    initialEmail="a@example.com"
    initialPosition="Affiliate"
    initialMobile="+1 415 555 0123"
    revisiting
    continueTo="/welcome/agreement"
    continueLabel="Continue to affiliate agreement"
  />,
);
check('the details come back', profileAgain.includes('value="Affiliate"'));
check('mobile included', profileAgain.includes('value="+1 415 555 0123"'));
check('the password half becomes optional', profileAgain.includes('Change your password'));
check('and says what leaving it empty means', profileAgain.includes('stays as it is'));
check('with a way onward', profileAgain.includes('href="/welcome/agreement"'));

console.log('\n— the rail as a way back —');
const railMid = renderToStaticMarkup(
  <OnboardingRail current="w9" state={{ profile: true, agreement: true, w9: false, bank: false }} />,
);
check('a finished step links to itself', railMid.includes('href="/welcome"'));
check('and so does the one after it', railMid.includes('href="/welcome/agreement"'));
// Nothing here may be used to jump the queue.
check('the step they are on is not a link', !railMid.includes('href="/welcome/w9"'));
check('nor is one they have not reached', !railMid.includes('href="/welcome/bank"'));
check('an untouched rail links nowhere', !renderToStaticMarkup(
  <OnboardingRail current="profile" state={{ ...NOTHING_DONE }} />,
).includes('href='));

console.log('\n— where an account stands —');
/*
 * ReviewDecision itself is not rendered here: it calls useRouter to refresh the
 * page after a decision, which needs a Next request. Its one piece of logic,
 * reviewProblems, is checked directly in approval-checks.
 */
const pill = (over: Partial<Approval> = {}) =>
  renderToStaticMarkup(<ApprovalPill approval={{ ...UNREVIEWED, ...over }} />);

check('an account that has sent nothing', pill().includes('Not submitted'));
check('and it is drawn quietly', pill().includes('chip-quiet'));
check('one waiting on an admin', pill({ submittedAt: '2026-08-24T10:00:00.000Z' }).includes('Awaiting review'));
// Gold is this palette's "deal with me", which is what a queue entry is.
check('in the colour that asks for attention', pill({ submittedAt: '2026-08-24T10:00:00.000Z' }).includes('chip-gold'));
check('an approved one', pill({ status: 'approved' }).includes('Approved'));
check('in green', pill({ status: 'approved' }).includes('chip-live'));
check('a declined one', pill({ status: 'declined' }).includes('Declined'));
check('in red', pill({ status: 'declined' }).includes('text-alarm'));
check('no em dash anywhere in it', !pill({ submittedAt: 'x' }).includes('—'));

console.log('\n— finding the queue —');
const waiting: Approval = { ...UNREVIEWED, submittedAt: '2026-08-24T10:00:00.000Z' };
const queueRows = [
  account(0, { username: 'arthur' }),
  account(1, { username: 'dana', approval: waiting }),
  account(2, { username: 'ali', approval: { ...UNREVIEWED, status: 'declined' } }),
  account(3, { username: 'kim', approval: { ...UNREVIEWED } }),
  // account() approves every affiliate it makes unless told otherwise, so this
  // one is the approved row.
  account(4, { username: 'sam' }),
];
check('everybody, by default', matchAccounts(queueRows, '', 'all').length === 5);
check('only the one waiting', names(matchAccounts(queueRows, '', 'all', 'waiting')) === 'dana');
check('the declined one', names(matchAccounts(queueRows, '', 'all', 'declined')) === 'ali');
check('the approved one', names(matchAccounts(queueRows, '', 'all', 'approved')) === 'sam');
/*
 * kim has signed up and filled in nothing. Pending, but not waiting on anybody:
 * putting her in the queue would be asking an admin to approve a blank form.
 */
check('somebody who has not submitted is not in the queue', !names(matchAccounts(queueRows, '', 'all', 'waiting')).includes('kim'));
// An admin has no approval state at all, so a status filter must exclude them
// rather than treat "no answer" as a match.
check('an admin is not in any status', matchAccounts(queueRows, '', 'all', 'approved').every((r) => r.role !== 'admin'));
check('search still applies on top', names(matchAccounts(queueRows, 'dana', 'all', 'waiting')) === 'dana');
check('and can rule the queue out', matchAccounts(queueRows, 'ali', 'all', 'waiting').length === 0);
check('role and status together', matchAccounts(queueRows, '', 'affiliate', 'waiting').length === 1);

console.log('\n— an account let in without the paperwork —');
const WAIVED = { at: '2026-08-24T12:00:00.000Z', by: 'arthur', note: 'Signed on paper' };
const waivedPill = renderToStaticMarkup(
  <ApprovalPill approval={{ ...UNREVIEWED, submittedAt: '2026-08-24T10:00:00.000Z' }} bypass={WAIVED} />,
);
check('the pill says so', waivedPill.includes('Bypassed'));
/*
 * And says nothing else. Underneath, this account is pending and its paperwork
 * is in the queue; on screen, the fact that matters is that nobody is blocked.
 */
check('rather than what the review column says', !waivedPill.includes('Awaiting review'));
check('and it is not drawn as work to do', !waivedPill.includes('chip-gold'));
check('no em dash', !waivedPill.includes('—'));

const waivedRows = [
  account(0, { username: 'arthur' }),
  account(1, { username: 'dana', approval: { ...UNREVIEWED, submittedAt: '2026-08-24T10:00:00.000Z' } }),
  account(2, { username: 'ali', approval: { ...UNREVIEWED, submittedAt: '2026-08-24T10:00:00.000Z' }, bypass: WAIVED }),
  account(3, { username: 'sam' }),
];
check('the waived one is findable', names(matchAccounts(waivedRows, '', 'all', 'bypassed')) === 'ali');
/*
 * The one that would waste an admin's afternoon: ali has submitted and is
 * pending, so on the raw numbers ali is in the queue. But nobody is waiting on
 * ali, because ali is already inside. Listing them as work to do would mean
 * clearing a queue that never empties.
 */
check('and is not also in the review queue', names(matchAccounts(waivedRows, '', 'all', 'waiting')) === 'dana');
check('nor under approved', !names(matchAccounts(waivedRows, '', 'all', 'approved')).includes('ali'));
check('the approved one is still there', names(matchAccounts(waivedRows, '', 'all', 'approved')) === 'sam');
check('everybody, unfiltered', matchAccounts(waivedRows, '', 'all').length === 4);

console.log('\n— where the forms live afterwards —');
const affiliateTabs = visibleItems(false).map((item) => item.href);
const adminTabs = visibleItems(true).map((item) => item.href);
// The whole point of the waiver is that they can still fill things in, so there
// has to be a way back to the forms from inside the app.
check('an affiliate has a profile tab', affiliateTabs.includes('/profile'));
check('and not the admin ones', !affiliateTabs.includes('/users') && !affiliateTabs.includes('/settings'));
check('an admin does not get a profile tab', !adminTabs.includes('/profile'));
check('but keeps People', adminTabs.includes('/users'));
check('both keep the shared pages', ['/', '/links', '/cpa'].every((href) => affiliateTabs.includes(href) && adminTabs.includes(href)));

console.log('\n— who a new link belongs to —');
{
  /*
   * LinkForm itself is not rendered here: it calls useRouter at the top, which
   * cannot be mounted outside a Next request. The two decisions the dropdown
   * rests on are exported instead and checked directly, the same arrangement
   * UsersPanel has above.
   */
  const people: KnownPerson[] = [
    { usr: 'zzz111', assignee: 'Zoe Adams', email: '', username: 'zoe' },
    { usr: 'aaa222', assignee: 'arthur reyes', email: '', username: 'arthur' },
    { usr: 'bbb333', assignee: '', email: '', username: 'no-name' },
    { usr: 'ccc444', assignee: 'Arthur Reyes', email: '', username: 'arthur2' },
  ];
  const order = peopleInListOrder(people).map((person) => person.usr);

  check('the list reads alphabetically', order.join() === 'aaa222,ccc444,bbb333,zzz111');
  /* Case is how somebody typed the account, not a sort key. Without this,
     "arthur" files under a different letter from "Arthur" and the two sit
     apart in a list being scanned for exactly that name. */
  check('regardless of how the name was capitalised', order.indexOf('aaa222') < order.indexOf('bbb333'));
  check('and the array it was given is not reordered', people[0]!.usr === 'zzz111');

  // Two people, one name. The key is what decides who gets paid, so it belongs
  // on the line rather than somewhere else on the page.
  const twins = people.filter((person) => (person.assignee || '').toLowerCase() === 'arthur reyes');
  check('a shared name is still told apart', personLabel(twins[0]!) !== personLabel(twins[1]!));
  check('because the key is on the line', personLabel(twins[0]!).includes('usr=aaa222'));
  // Somebody with no display name still has to be pickable.
  check('a nameless account falls back to its username', personLabel(people[2]!).startsWith('no-name'));
  check('and never reads as blank', personLabel({ usr: 'ddd555', assignee: '', email: '' }).startsWith('ddd555'));
}


// The row overflow menu, shut.
//
// Only the trigger renders until somebody opens it, and that trigger is the
// whole of this control's accessibility: with no label it is three dots with
// no name, and with no aria-expanded a screen reader cannot tell an open menu
// from a closed one. Both are one careless edit from vanishing, and neither
// shows up in a type check.
{
  const shut = renderToStaticMarkup(
    <RowMenu label="More actions for marvin">
      {() => <RowMenuItem onClick={() => {}}>Client View</RowMenuItem>}
    </RowMenu>,
  );
  check('the trigger is named for the person it acts on', shut.includes('aria-label="More actions for marvin"'));
  check('it says that it opens a menu', shut.includes('aria-haspopup="menu"'));
  check('and that the menu is currently shut', shut.includes('aria-expanded="false"'));
  check('the three dots are decoration, not content', shut.includes('aria-hidden'));
  check('nothing inside it is rendered until it opens', !shut.includes('Client View'));
  check('and there is no menu in the markup either', !shut.includes('role="menu"'));
}

// The sync's words.
//
// The one button that writes money says what it is about to write, and now
// that the sync moves leads as well, what it is about to do to them. The words
// for a lead's state have to be the captions the leads list shows, or the
// button promises a state by a name nobody sees anywhere else; and none of it
// may carry a dash. ReportRunner holds state from the first render, so the
// sentences are exported and read directly rather than rendered.
{
  const approvedWord = statusLabel('registered').toLowerCase();
  const appliedWord = statusLabel('applied').toLowerCase();
  const plan = { toCreate: 3, amountToCreate: 412.5, leadsToMark: 2, leadsToApply: 1, cardsToRecord: 1 };
  const nothing = { toCreate: 0, amountToCreate: 0, leadsToMark: 0, leadsToApply: 0, cardsToRecord: 0 };
  const label = applyLabel(plan);
  check('the money comes first', label.startsWith('Write 3 approvals ('));
  check('with the amount', label.includes('412.50'));
  check(
    "then the leads, in the leads list's own words",
    label.includes(`, mark 2 leads ${approvedWord} and 1 ${appliedWord}`),
  );
  check('then the cards', label.endsWith(', record a card on 1 lead'));
  check('a plan that only moves one lead to applied says so', applyLabel({ ...nothing, leadsToApply: 1 }) === 'Mark 1 lead applied');
  check('one that only approves', applyLabel({ ...nothing, leadsToMark: 2 }) === `Mark 2 leads ${approvedWord}`);
  check('one that only records cards', applyLabel({ ...nothing, cardsToRecord: 3 }) === 'Record cards on 3 leads');
  check(
    'approvals with no lead changes say nothing about leads',
    applyLabel({ ...nothing, toCreate: 1, amountToCreate: 10 }).startsWith('Write 1 approval (') &&
      !applyLabel({ ...nothing, toCreate: 1, amountToCreate: 10 }).includes('lead'),
  );

  const done = { toCreate: 3, created: 3, leadsMarked: 2, leadsApplied: 1, cardsRecorded: 1 };
  check(
    'the result says what was written',
    appliedSummary(done) ===
      `3 approvals written to Ledger, 2 leads marked ${approvedWord} and 1 ${appliedWord}, and a card recorded on 1 lead.`,
  );
  check(
    'a run that only moved leads does not open with no approvals',
    appliedSummary({ toCreate: 0, created: 0, leadsMarked: 0, leadsApplied: 1, cardsRecorded: 0 }) ===
      `1 lead marked ${appliedWord}.`,
  );
  check(
    'a run that meant to write approvals says how many made it',
    appliedSummary({ toCreate: 3, created: 0, leadsMarked: 1 }).startsWith('0 approvals written to Ledger, '),
  );
  check('a run with nothing in it still says so', appliedSummary({ toCreate: 0, created: 0 }) === '0 approvals written to Ledger.');

  const note = leadPlanNote(plan);
  check('the plan note names the approved leads by their caption', note.includes(`not marked ${approvedWord} yet`));
  check('and the applied ones', note.includes(`to ${appliedWord}`));
  check('and the cards', note.includes('gains a card'));
  check('and leaves out a group with nobody in it', !leadPlanNote({ ...nothing, leadsToApply: 2 }).includes('not marked'));

  const everything = [
    label,
    applyLabel({ ...nothing, leadsToApply: 1 }),
    applyLabel({ ...nothing, cardsToRecord: 3 }),
    appliedSummary(done),
    appliedSummary({ toCreate: 0, created: 0, leadsApplied: 2, cardsRecorded: 1 }),
    note,
    leadPlanNote({ ...nothing, leadsToApply: 2 }),
  ];
  check('none of the sync wording carries a dash', everything.every((text) => !/[–—]/.test(text)));
}

// The leads list, in three states.
//
// LeadsPanel calls useRouter at the top, like UsersPanel, so it is not rendered
// whole. What it rests on is exported and read here instead: the status each
// row is shown with, what each filter option counts, the words for a filter
// that finds nobody, the pill, the toggle, the card cell and the note that
// explains the states. The toggle's accessible name is the one place a screen
// reader hears where a click will send a lead, so it is pinned for every case,
// and so is the click itself.
{
  const pendingWord = statusLabel('pending').toLowerCase();
  const appliedWord = statusLabel('applied').toLowerCase();
  const approvedWord = statusLabel('registered').toLowerCase();

  const leadRow = (over: Partial<LeadRow>): LeadRow => ({
    id: 'rc7czk6xa61y',
    fullName: 'Priya Nair',
    email: 'priya@example.test',
    phone: '',
    campaign: 'Best Cards',
    slug: 'best-cards',
    assignee: 'Mark',
    status: 'pending',
    card: '',
    hasApproval: false,
    age: '4 hrs ago',
    capturedAt: 'Sep 1, 2026, 9:00 AM',
    ...over,
  });

  const rows: LeadRow[] = [
    leadRow({ id: 'p1' }),
    leadRow({ id: 'a1', status: 'applied', card: 'Chase Sapphire Preferred' }),
    leadRow({ id: 'a2', status: 'applied', card: 'Amex Gold' }),
    leadRow({ id: 'r1', status: 'registered', card: 'Chase Freedom' }),
    // Stored as applied, but an approval names it.
    leadRow({ id: 'a3', status: 'applied', card: 'Amex Gold', hasApproval: true }),
  ];
  const shownAs = (list: LeadRow[], id: string) => list.find((r) => r.id === id)?.status;

  const shown = withShownStatus(rows, {});
  check('an approval outranks a stored applied', shownAs(shown, 'a3') === 'registered');
  check('without one, applied is shown as applied', shownAs(shown, 'a1') === 'applied');
  const clicked = withShownStatus(rows, { p1: 'registered', a3: 'pending' });
  check('a click shows before the server answers', shownAs(clicked, 'p1') === 'registered');
  check('but never over an approval', shownAs(clicked, 'a3') === 'registered');
  check('and the rows it was handed are left as they were', rows[0]!.status === 'pending');

  // Counted from what the pills say, so the number on an option is the number
  // of rows choosing it shows.
  const counts = leadCounts(shown);
  check('All counts every lead', counts.all === 5);
  check(
    'each state counts the leads shown in it',
    counts.pending === 1 && counts.applied === 2 && counts.registered === 2,
  );
  check('the three states add up to All', counts.pending + counts.applied + counts.registered === counts.all);
  check(
    'each option finds as many leads as it says',
    LEAD_FILTERS.every((f) => shown.filter((r) => matchesFilter(r, f)).length === counts[f]),
  );
  check('the options run All, then the funnel in order', LEAD_FILTERS.join() === 'all,pending,applied,registered');
  check('All is called All', filterLabel('all') === 'All');
  check(
    'and each state by its caption',
    (['pending', 'applied', 'registered'] as const).every((s) => filterLabel(s) === statusLabel(s)),
  );
  // An untyped row reads Pending on its pill (statusLabel's fallback), so it
  // has to count and filter as pending too, or the options stop adding up.
  const odd = { status: 'nonsense' as LeadStatus };
  check('a status that is not one counts as pending', leadCounts([odd]).pending === 1);
  check('and is found under pending', matchesFilter(odd, 'pending') && !matchesFilter(odd, 'applied'));

  check('a filter that finds nobody names the state', noLeadsText('applied') === `No ${appliedWord} leads in this list.`);
  check('by its caption, not the stored word', noLeadsText('registered') === `No ${approvedWord} leads in this list.`);
  check('pending too', noLeadsText('pending') === `No ${pendingWord} leads in this list.`);

  const pill = (row: LeadRow) => renderToStaticMarkup(<StatusPill row={row} />);
  const dotOf = (markup: string) => /style="background:([^";]+)/.exec(markup)?.[1] ?? '';
  const pendingPill = pill(leadRow({}));
  const appliedPill = pill(leadRow({ status: 'applied', card: 'Amex Gold' }));
  const approvedPill = pill(leadRow({ status: 'registered' }));
  check('an applied lead gets its own pill', appliedPill.includes('data-status="applied"'));
  check('captioned by statusLabel', appliedPill.includes(`${statusLabel('applied')}</span>`));
  const dots = [pendingPill, appliedPill, approvedPill].map(dotOf);
  check('each state has a dot of its own', dots.every(Boolean) && new Set(dots).size === 3);
  check('applied is not green, which means approved', !dots[1]!.includes('leaf'));
  check('and no state is gold', dots.every((dot) => !dot.includes('gold')));

  const toggle = (row: LeadRow) =>
    renderToStaticMarkup(<StatusToggle row={row} onToggle={() => {}} />);
  const nameOf = (markup: string) => /aria-label="([^"]+)"/.exec(markup)?.[1] ?? '';
  // Approved is recorded with Approve, which asks what it paid; the pill
  // never offers it.
  check(
    'a pending lead offers applied',
    nameOf(toggle(leadRow({}))) === `${statusLabel('pending')}, mark Priya Nair as ${appliedWord}`,
  );
  check(
    'an applied lead with no card offers pending',
    nameOf(toggle(leadRow({ status: 'applied' }))) ===
      `${statusLabel('applied')}, mark Priya Nair as ${pendingWord}`,
  );
  check(
    'an applied lead with a card is a pill with nothing to press',
    !toggle(leadRow({ status: 'applied', card: 'Amex Gold' })).includes('<button'),
  );
  check(
    'an approved lead with a card goes back to applied',
    nameOf(toggle(leadRow({ status: 'registered', card: 'Amex Gold' }))) ===
      `${statusLabel('registered')}, mark Priya Nair as ${appliedWord}`,
  );
  check(
    'one with no card goes back to pending',
    nameOf(toggle(leadRow({ status: 'registered' }))) ===
      `${statusLabel('registered')}, mark Priya Nair as ${pendingWord}`,
  );
  check(
    'the toggle wears the same state as the pill',
    toggle(leadRow({ status: 'applied' })).includes('data-status="applied"'),
  );
  // The click, not only its name. Called as a function to reach the handler,
  // which static markup does not carry.
  const sent: LeadStatus[] = [];
  const element = StatusToggle({
    row: leadRow({ status: 'registered', card: 'Amex Gold' }),
    onToggle: (next) => sent.push(next),
  });
  element.props.onClick();
  check('and a click sends the state its name promised', sent.join() === 'applied');

  const card = (text: string) => renderToStaticMarkup(<CardName card={text} />);
  check('a lead with no card shows the blank', card('').includes(`>${BLANK}</span>`));
  check('so does a card of only spaces', card('   ').includes(`>${BLANK}</span>`));
  const twoCards = card('Chase Sapphire Preferred, Amex Gold');
  check('the cards show as recorded', twoCards.includes('>Chase Sapphire Preferred, Amex Gold</span>'));
  check(
    'and whole on hover, since the column cuts them short',
    twoCards.includes('title="Chase Sapphire Preferred, Amex Gold"'),
  );

  const words = (markup: string) => markup.replace(/<[^>]+>/g, '');
  const note = (canEdit: boolean, fromApprovals: number) =>
    words(renderToStaticMarkup(<StatusNote canEdit={canEdit} fromApprovals={fromApprovals} />));
  const adminNote = note(true, 0);
  const affiliateNote = note(false, 0);
  const threeWords = [pendingWord, appliedWord, approvedWord];
  check('the admin note names all three states', threeWords.every((w) => adminNote.includes(w)));
  check('so does the affiliate note', threeWords.every((w) => affiliateNote.includes(w)));
  check('both say where the card is', adminNote.includes('Card column') && affiliateNote.includes('Card column'));
  check('the admin is told approving takes the card', adminNote.includes('Approve') && adminNote.includes('pick the card'));
  check(
    'an affiliate gets no recipe for a control they do not have',
    !affiliateNote.includes('Approve') && !affiliateNote.includes('pick the card'),
  );
  check(
    'an approval on file is explained when there is one',
    note(true, 1).includes(`One of them reads ${approvedWord} because`),
  );
  check('and several are counted', note(false, 3).includes(`3 of them read ${approvedWord} because`));
  check('and it is not said when it does not apply', !adminNote.includes('approval on file'));

  const everything = [
    adminNote,
    affiliateNote,
    note(true, 1),
    note(false, 3),
    ...LEAD_FILTERS.map(filterLabel),
    ...(['pending', 'applied', 'registered'] as const).map(noLeadsText),
    ...(['pending', 'applied', 'registered'] as const).map((s) =>
      nameOf(toggle(leadRow({ status: s, card: 'Amex Gold' }))),
    ),
    nameOf(toggle(leadRow({ status: 'registered' }))),
    words(pendingPill),
    words(appliedPill),
    words(approvedPill),
  ];
  check('none of the leads list wording carries a dash', everything.every((text) => !/[–—]/.test(text)));
  check(
    'and nothing an affiliate reads is a split or a percentage',
    !/%|split|share/i.test(affiliateNote + note(false, 3)),
  );
}
console.log(`\nlist-render: ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
