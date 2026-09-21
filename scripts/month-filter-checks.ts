/**
 * The month filter and the sales figures: which days a month covers, which
 * months are offered, and that payout, affiliate share and what is kept add up.
 *
 *   npx tsx scripts/month-filter-checks.ts
 */
import {
  activeMonths,
  affiliateHref,
  buildEarnings,
  monthLabel,
  monthWindow,
  parseMonth,
  salesFigures,
} from '../src/lib/analytics';
import type { AffiliateLink, Conversion, Visit } from '../src/lib/types';

let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n       got ${JSON.stringify(actual)}\n       want ${JSON.stringify(expected)}`}`);
}

console.log('— reading a month out of the URL —');
check('a month', parseMonth('2026-09'), '2026-09');
check('trimmed', parseMonth(' 2026-09 '), '2026-09');
check('a month that does not exist is no month', parseMonth('2026-13'), '');
check('month zero is no month', parseMonth('2026-00'), '');
check('a day is not a month', parseMonth('2026-09-01'), '');
check('nothing is no month', parseMonth(''), '');
check('a year before the web had links is no month', parseMonth('0226-09'), '');

console.log('\n— the days a month covers —');
check('September is the 1st to the 30th', monthWindow('2026-09'), { start: '2026-09-01', end: '2026-09-30' });
check('February in a leap year ends on the 29th', monthWindow('2028-02'), { start: '2028-02-01', end: '2028-02-29' });
check('and in a common year on the 28th', monthWindow('2026-02'), { start: '2026-02-01', end: '2026-02-28' });
check('December ends the year', monthWindow('2026-12'), { start: '2026-12-01', end: '2026-12-31' });
check('named in full', monthLabel('2026-09'), 'September 2026');

console.log('\n— the months offered —');
const visit = (usr: string, createdAt: string): Visit => ({ id: createdAt, createdAt, slug: 'cash-back', usr, referrer: '', userAgent: '', ip: '' });
const sale = (usr: string, approvedOn: string, amount: number, id = approvedOn): Conversion => ({
  id,
  createdAt: `${approvedOn}T12:00:00Z`,
  approvedOn,
  slug: 'cash-back',
  usr,
  amount,
  notes: '',
});
check(
  'every month with a visit or an approval, newest first, once each',
  activeMonths(
    [visit('arthur', '2026-07-31T23:59:59Z'), visit('arthur', '2026-09-01T00:00:00Z')],
    [sale('arthur', '2026-08-15', 100), sale('mark', '2026-09-30', 100)],
  ),
  ['2026-09', '2026-08', '2026-07'],
);
check('nothing recorded offers nothing', activeMonths([], []), []);

console.log('\n— a month in the earnings —');
const links: AffiliateLink[] = [
  {
    id: 'l1',
    createdAt: '2026-01-01T00:00:00Z',
    slug: 'cash-back',
    usr: 'arthur',
    assignee: 'Arthur',
    assigneeEmail: '',
    destination: '',
    campaign: 'Cash back',
    headline: '',
    subheadline: '',
    ctaLabel: '',
    requirePhone: false,
    passUsrParam: '',
    active: true,
    notes: '',
  },
];
const visits = [
  visit('arthur', '2026-08-31T23:59:59Z'),
  visit('arthur', '2026-09-01T00:00:00Z'),
  visit('arthur', '2026-09-30T23:59:59Z'),
  visit('arthur', '2026-10-01T00:00:00Z'),
];
const conversions = [
  sale('arthur', '2026-08-31', 1000, 'a'),
  sale('arthur', '2026-09-01', 270, 'b'),
  sale('arthur', '2026-09-20', 210, 'c'),
  sale('arthur', '2026-09-30', 540, 'd'),
  sale('arthur', '2026-10-01', 1000, 'e'),
];
// The rate changed mid-month: 50% until the 14th, 60% from the 15th.
const shares = [
  { from: '', rate: 0.5 },
  { from: '2026-09-15', rate: 0.6 },
];
const september = buildEarnings(links, visits, conversions, { month: '2026-09', shares });
check('only the month’s visits count, the first and last days included', september.totals.visits, 2);
check('only the month’s approvals count, the first and last days included', september.totals.approved, 3);
check('its payout', september.totals.earnings, 1020);
check('its affiliate share, each at the rate on its day', september.totals.affiliate, 135 + 126 + 324);

const figures = salesFigures(september.totals, true);
check('sales, payout, share and what is kept', figures, { sales: 3, payout: 1020, share: 585, keep: 435 });
check('share and kept add back up to the payout', figures.share + figures.keep!, figures.payout);
check(
  'an affiliate, whose figures are already their share, keeps nothing that is shown',
  salesFigures({ approved: 2, earnings: 300, affiliate: 300 }, false),
  { sales: 2, payout: null, share: 300, keep: null },
);
check(
  'cents that do not split evenly still add back up',
  (() => {
    const f = salesFigures({ approved: 1, earnings: 99.99, affiliate: 50 }, true);
    return Math.round((f.share + f.keep!) * 100) / 100;
  })(),
  99.99,
);

const whole = buildEarnings(links, visits, conversions, { period: 'all', shares });
check('with no month, the period still decides', whole.totals.approved, 5);
check(
  'a month the data has nothing in is empty, not everything',
  buildEarnings(links, visits, conversions, { month: '2025-01', shares }).totals.approved,
  0,
);

console.log('\n— links that keep the month —');
check('a person’s page keeps the month', affiliateHref('arthur', 'month', '2026-09'), '/affiliate/arthur?month=2026-09');
check('a month outranks the period', affiliateHref('arthur', 'week', '2026-09'), '/affiliate/arthur?month=2026-09');
check('no month keeps the period as before', affiliateHref('arthur', 'week'), '/affiliate/arthur?period=week');
check('and the default stays bare', affiliateHref('arthur', 'month'), '/affiliate/arthur');

console.log(failed === 0 ? '\nPASS' : `\nFAIL — ${failed} check(s)`);
process.exit(failed === 0 ? 0 : 1);
