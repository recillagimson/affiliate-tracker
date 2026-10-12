// The Tradelines Table page, rendered: the table an admin reads, and the
// dialogs they keep it up to date with.
//
//   npx tsx --tsconfig scripts/render.tsconfig.json scripts/tradelines-render-checks.tsx
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { visibleItems, Nav } from '../src/components/Nav';
import { TradelineCheckouts, TradelineFigures, TradelinesSummaryPanel } from '../src/components/TradelinesSummary';
import { issuerHref, IssuerTabs, PastePreview, pickIssuer, TradelinesBrowser, TradelinesTable } from '../src/components/TradelinesTable';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parsePaste, TRADELINE_ISSUERS, type Tradeline } from '../src/lib/tradelines';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) pass++;
  else {
    fail++;
    console.error('FAIL:', name, extra === undefined ? '' : extra);
  }
}

const rendered: string[] = [];
const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} } as unknown as AppRouterInstance;
function render(node: ReactNode): string {
  const html = renderToStaticMarkup(<AppRouterContext.Provider value={router}>{node}</AppRouterContext.Provider>);
  rendered.push(html);
  return html;
}

const TODAY = '2025-08-25';
const rows: Tradeline[] = [
  { id: '1', issuer: 'capital-one', name: 'Capital One/Cabelas', creditLimit: 500, openDate: '2012-04-10', age: '13.38356164', userPrice: 450 },
  { id: '2', issuer: 'capital-one', name: 'Capital One Walmart', creditLimit: 1524, openDate: '2017-12-31', age: '7.654794521', userPrice: 1250.5 },
  { id: '3', issuer: 'capital-one', name: 'Capital One <b>', creditLimit: 5000, openDate: '2011-04-02', age: null, userPrice: null },
];

console.log('- the navigation -');
check('admins have a Tradelines tab', visibleItems(true).some((item) => item.href === '/tradelines' && item.label === 'Tradelines'));
check('an affiliate on personal cards does not', !visibleItems(false).some((item) => item.href === '/tradelines'));
check('nor one whose services are not said', !visibleItems(false, ['personal_cards']).some((item) => item.href === '/tradelines'));
const tradeTabs = visibleItems(false, ['tradelines']).map((item) => item.href);
check('an affiliate on tradelines does', tradeTabs.includes('/tradelines'));
check('and has none of the card tabs', ['/', '/links', '/links/new', '/cpa'].every((href) => !tradeTabs.includes(href)), tradeTabs);
check('and keeps payslip, support and profile', ['/payslips', '/support', '/profile'].every((href) => tradeTabs.includes(href)), tradeTabs);
check('and still none of the admin tabs', ['/users', '/reports', '/payouts', '/settings'].every((href) => !tradeTabs.includes(href)));
const bothTabs = visibleItems(false, ['personal_cards', 'tradelines']).map((item) => item.href);
check('an affiliate on both has both', ['/', '/links', '/links/new', '/cpa', '/tradelines'].every((href) => bothTabs.includes(href)), bothTabs);
check('an admin has every tab whatever services are passed', ['/', '/links', '/cpa', '/tradelines'].every((href) => visibleItems(true, ['tradelines']).some((item) => item.href === href)));
const nav = renderToStaticMarkup(
  <PathnameContext.Provider value="/tradelines">
    <Nav isAdmin />
  </PathnameContext.Provider>,
);
check('the tab is current on its page', /href="\/tradelines"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/tradelines"/.test(nav));

console.log('- choosing an issuer -');
const tabs = render(
  <IssuerTabs current="capital-one" counts={{ 'capital-one': 14, citi: 0, discover: 3, 'fidelity-elan': 0, pnc: 0, 'us-bank': 1 }} />,
);
for (const label of ['Capital One', 'Citi Tradeline', 'Discover Tradeline', 'Fidelity/Elan Tradeline', 'PNC Tradeline', 'US Bank Tradeline']) {
  check(`${label} is offered`, tabs.includes(label));
}
check('each links to its own table', tabs.includes('href="/tradelines?issuer=citi"') && tabs.includes('href="/tradelines?issuer=us-bank"'));
check('the first is the bare address', tabs.includes('href="/tradelines"'));
check('the one showing is marked', /href="\/tradelines"[^>]*data-active="true"|data-active="true"[^>]*href="\/tradelines"/.test(tabs));
check('each says how many it holds', tabs.includes('>14<') && tabs.includes('>3<'));
for (const issuer of TRADELINE_ISSUERS) {
  check(`${issuer.label} shows its logo`, new RegExp(`<img[^>]*src="/issuers/${issuer.key}\\.webp"`).test(tabs), issuer.key);
  check(`${issuer.label}'s logo file is there to be served`, existsSync(join(__dirname, '..', 'public', 'issuers', `${issuer.key}.webp`)));
}
check('six logos, one each', (tabs.match(/<img/g) ?? []).length === 6);
check('the logo is the name: no name is written under it', !/>Capital One</.test(tabs) && !/>Fidelity\/Elan Tradeline</.test(tabs));
check('but each logo still says who it is, for anybody who cannot see it', TRADELINE_ISSUERS.every((issuer) => tabs.includes(`alt="${issuer.label}"`)));

console.log('- switching issuer -');
const all: Tradeline[] = [
  ...rows,
  { id: '9', issuer: 'citi', name: 'Citi Double Cash', creditLimit: 7500, openDate: '2015-03-03', age: '10.5', userPrice: 300 },
];
const browser = render(<TradelinesBrowser all={all} initialIssuer="citi" today={TODAY} canEdit />);
check('it opens on the issuer in the address', browser.includes('Citi Double Cash') && !browser.includes('Capital One/Cabelas'));
check('with every issuer counted from the rows it was handed', browser.includes('>3<') && browser.includes('>1<'));
check('every issuer\'s rows are already on the page, so choosing one waits for nothing', pickIssuer(all, 'capital-one').length === 3 && pickIssuer(all, 'citi').length === 1 && pickIssuer(all, 'pnc').length === 0);
check('each address is the one a reload would open on', issuerHref('capital-one') === '/tradelines' && issuerHref('pnc') === '/tradelines?issuer=pnc');
check('the one showing is told apart without relying on the logo', tabs.includes('aria-current="page"'));

console.log('- the table -');
const table = render(<TradelinesTable issuer="capital-one" rows={rows} today={TODAY} canEdit />);
for (const heading of ['Issuer/Type', 'Credit Limit', 'Open Date', 'Age (Years)', 'User Price']) {
  check(`a ${heading} column`, table.includes(heading));
}
check('a tradeline is named', table.includes('Capital One/Cabelas'));
check('its limit is written as money', table.includes('$1,524') && table.includes('$500'));
check('its open date is written out', table.includes('10 Apr 2012'));
check('its age is the pasted figure, every digit of it', table.includes('>13.38356164<') && table.includes('>7.654794521<'));
// Rendered a year after the sheet was made: a worked-out age would be 14.5.
check('and is not worked out from the open date', !render(<TradelinesTable issuer="capital-one" rows={rows} today="2026-10-07" canEdit />).includes('14.5'));
check('a tradeline with no age shows none', !table.includes('NaN') && !table.includes('>0<'));
check('an age can be typed when adding one', table.includes('name="age"'));
check('the user price is shown as money', table.includes('>$450.00<') && table.includes('>$1,250.50<'));
check('and can be typed when adding one', table.includes('name="userPrice"'));
check('the columns run in the sheet\'s order, price last', table.indexOf('Age (Years)') < table.indexOf('User Price'));
check('a name is text, never markup', !table.includes('<b>') && table.includes('&lt;b&gt;'));
check('each row can be edited and deleted', table.split('>Edit<').length === 4 && table.split('>Delete<').length === 4);
check('one can be added', table.includes('Add tradeline'));
check('rows can be pasted in', table.includes('Paste rows'));
check('the table says how many there are', table.includes('3 tradelines'));
const empty = render(<TradelinesTable issuer="citi" rows={[]} today={TODAY} canEdit />);
check('an empty table says so, and for which issuer', empty.includes('No tradelines') && empty.includes('Citi Tradeline'));
check('and still offers to add some', empty.includes('Paste rows') && empty.includes('Add tradeline'));

console.log('- the table as an affiliate on tradelines sees it -');
const viewing = render(<TradelinesTable issuer="capital-one" rows={rows} today={TODAY} />);
check('every tradeline is there', viewing.includes('Capital One/Cabelas') && viewing.includes('Capital One Walmart') && viewing.includes('3 tradelines'));
check('with its price, which is what they quote', viewing.includes('$450.00') && viewing.includes('$1,250.50'));
check('no row can be edited or deleted', !viewing.includes('>Edit<') && !viewing.includes('>Delete<'));
check('none can be added or pasted in', !viewing.includes('Add tradeline') && !viewing.includes('Paste rows'));
check('and no dialog for either is on the page', !viewing.includes('dialog'));
check('it can still be sorted', viewing.includes('aria-sort'));
const viewingEmpty = render(<TradelinesTable issuer="citi" rows={[]} today={TODAY} />);
check('an empty table says so without offering to fill it', viewingEmpty.includes('No tradelines') && !viewingEmpty.includes('Paste') && !viewingEmpty.includes('add one'));
const viewingAll = render(<TradelinesBrowser all={rows} initialIssuer="capital-one" today={TODAY} />);
check('the whole page is view only unless it is said otherwise', !viewingAll.includes('Add tradeline') && !viewingAll.includes('>Edit<'));

console.log('- an affiliate\'s tradelines dashboard -');
const NONE = { income: 0, pendingPayout: 0, checkouts: 0 };
const panel = render(<TradelinesSummaryPanel tradelineRef="TL-48213" summary={NONE} />);
check('their link is said to be coming, not made up', panel.includes('Your link') && panel.includes('Coming soon') && !panel.includes('http'));
check('their reference number is shown', panel.includes('TL-48213'));
check('and can be copied', panel.includes('Copy your reference number'));
check('income is shown', panel.includes('Income') && panel.includes('$0.00'));
check('and pending payout', panel.includes('Pending payout') && panel.split('$0.00').length === 3);
check('view all goes to the dashboard', /href="\/tradelines\/dashboard"[^>]*>[^<]*View all/.test(panel), panel);
const noRef = render(<TradelinesSummaryPanel tradelineRef="" summary={NONE} />);
check('somebody without a number yet is shown none', !noRef.includes('TL-') && !noRef.includes('Copy'));
check('and still their link and figures', noRef.includes('Coming soon') && noRef.includes('Income') && noRef.includes('Pending payout'));
const linked = render(
  <TradelinesSummaryPanel tradelineRef="TL-48213" link="https://tradelines.example.com/?ref=TL-48213" summary={NONE} />,
);
check('with a storefront, their link is shown whole', linked.includes('https://tradelines.example.com/?ref=TL-48213') && !linked.includes('Coming soon'));
check('and is what gets copied', linked.includes('Copy your link'));
check('their number is still said', linked.includes('TL-48213'));
const earned = render(<TradelineFigures summary={{ income: 1250.5, pendingPayout: 450, checkouts: 3 }} />);
check('figures are to the cent', earned.includes('$1,250.50') && earned.includes('$450.00'));
const list = render(<TradelineCheckouts rows={[]} />);
check('with no checkouts the list says so', list.includes('No checkouts yet') && list.includes('reference number'));
const sold = render(
  <TradelineCheckouts
    rows={[
      { orderNumber: 'LGF-100002', placedAt: '2026-10-12T12:00:00Z', customerName: 'Jordan <i>Testcase</i>', status: 'paid', total: 3300, commission: 400, items: [{ name: 'Capital One/Cabelas', quantity: 2 }, { name: 'Capital One Walmart', quantity: 1 }] },
      { orderNumber: 'LGF-100001', placedAt: '2026-10-11T12:00:00Z', customerName: 'Sam Example', status: 'awaiting_payment', total: 1100, commission: 200, items: [{ name: 'Citi Plus', quantity: 1 }] },
      { orderNumber: 'LGF-100004', placedAt: '2026-10-10T12:00:00Z', customerName: 'Alex Example', status: 'cancelled', total: 1100, commission: 0, items: [{ name: 'Citi Plus', quantity: 1 }] },
    ]}
  />,
);
check('each checkout is listed with its order number and customer', ['LGF-100002', 'LGF-100001', 'LGF-100004', 'Sam Example'].every((part) => sold.includes(part)));
check('a customer name is text, never markup', !sold.includes('<i>Testcase') && sold.includes('&lt;i&gt;'));
check('what was bought is said, with its months', sold.includes('Capital One/Cabelas') && sold.includes('6 months') && sold.includes('Capital One Walmart'));
check('a paid one shows what it earned', sold.includes('$400.00') && sold.includes('Paid'));
check('one awaiting payment says the commission is to come', sold.includes('$200.00 when paid') && sold.includes('Awaiting payment'));
check('a cancelled one earns nothing', sold.includes('Cancelled') && !sold.includes('$0.00 when paid'));
check('the order totals are shown', sold.includes('$3,300.00') && sold.includes('$1,100.00'));

console.log('- what a paste will do -');
const good = render(<PastePreview result={parsePaste('Citi A\t$7,500\t3-Mar-15\t10.48493151\t$425\nCiti B\t$2,000\t20-Jan-16\n', TODAY)} />);
check('it says how many rows were read', good.includes('2 tradelines read'));
check('and shows them, with the age as pasted', good.includes('Citi A') && good.includes('$7,500') && good.includes('3 Mar 2015') && good.includes('10.48493151'));
check('and the price as pasted', good.includes('$425'));
const mixed = render(<PastePreview result={parsePaste('Citi A\t$7,500\t3-Mar-15\nCiti B\tcall us\t3-Mar-15\n', TODAY)} />);
check('a row it could not read is listed with its line', mixed.includes('Line 2') && mixed.includes('credit limit'));
check('and counted', mixed.includes('1 row could not be read'));
const nothing = render(<PastePreview result={parsePaste('', TODAY)} />);
check('nothing pasted shows nothing', !nothing.includes('read'));

check('no em or en dash anywhere', rendered.every((html) => !/[–—]/.test(html)));

console.log(`\ntradelines-render: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
