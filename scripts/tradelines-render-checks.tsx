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
check('affiliates do not', !visibleItems(false).some((item) => item.href === '/tradelines'));
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
const browser = render(<TradelinesBrowser all={all} initialIssuer="citi" today={TODAY} />);
check('it opens on the issuer in the address', browser.includes('Citi Double Cash') && !browser.includes('Capital One/Cabelas'));
check('with every issuer counted from the rows it was handed', browser.includes('>3<') && browser.includes('>1<'));
check('every issuer\'s rows are already on the page, so choosing one waits for nothing', pickIssuer(all, 'capital-one').length === 3 && pickIssuer(all, 'citi').length === 1 && pickIssuer(all, 'pnc').length === 0);
check('each address is the one a reload would open on', issuerHref('capital-one') === '/tradelines' && issuerHref('pnc') === '/tradelines?issuer=pnc');
check('the one showing is told apart without relying on the logo', tabs.includes('aria-current="page"'));

console.log('- the table -');
const table = render(<TradelinesTable issuer="capital-one" rows={rows} today={TODAY} />);
for (const heading of ['Issuer/Type', 'Credit Limit', 'Open Date', 'Age (Years)', 'User Price']) {
  check(`a ${heading} column`, table.includes(heading));
}
check('a tradeline is named', table.includes('Capital One/Cabelas'));
check('its limit is written as money', table.includes('$1,524') && table.includes('$500'));
check('its open date is written out', table.includes('10 Apr 2012'));
check('its age is the pasted figure, every digit of it', table.includes('>13.38356164<') && table.includes('>7.654794521<'));
// Rendered a year after the sheet was made: a worked-out age would be 14.5.
check('and is not worked out from the open date', !render(<TradelinesTable issuer="capital-one" rows={rows} today="2026-10-07" />).includes('14.5'));
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
const empty = render(<TradelinesTable issuer="citi" rows={[]} today={TODAY} />);
check('an empty table says so, and for which issuer', empty.includes('No tradelines') && empty.includes('Citi Tradeline'));
check('and still offers to add some', empty.includes('Paste rows') && empty.includes('Add tradeline'));

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
