// What the tradelines storefront is allowed to read.
//
// The storefront is a public site, so this is the one place tradelines leave
// the app without a sign-in. What is pinned is that only what a shopper may
// see goes out: priced tradelines, with nothing about who entered them, and
// that only the storefront's own address may read it from a browser.
//
//   npx tsx scripts/tradelines-public-checks.ts

import { allowedOrigin, publicInventory } from '../src/lib/tradelines-public';
import { TRADELINE_ISSUERS, type Tradeline } from '../src/lib/tradelines';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) pass++;
  else {
    fail++;
    console.error('FAIL:', name, extra === undefined ? '' : extra);
  }
}

const rows: Tradeline[] = [
  { id: '1', issuer: 'capital-one', name: 'Capital One/Cabelas', creditLimit: 500, openDate: '2012-04-10', age: '13.38356164', userPrice: 450 },
  { id: '2', issuer: 'capital-one', name: 'Capital One Walmart', creditLimit: 1524, openDate: '2017-12-31', age: null, userPrice: 1250.5 },
  { id: '3', issuer: 'capital-one', name: 'No price yet', creditLimit: 5000, openDate: '2011-04-02', age: '14.4', userPrice: null },
  { id: '4', issuer: 'citi', name: 'Free is not a price', creditLimit: 7500, openDate: '2015-03-03', age: '10.4', userPrice: 0 },
  { id: '5', issuer: 'us-bank', name: 'US Bank A', creditLimit: 9000, openDate: '2010-01-01', age: '15.6', userPrice: 700 },
];

console.log('- what goes out -');
const out = publicInventory(rows);
check('only priced tradelines are offered', out.tradelines.map((row) => row.id).join() === '1,2,5', out.tradelines);
check('the price is the user price', out.tradelines[0]?.price === 450 && out.tradelines[1]?.price === 1250.5);
check('the age is the text as stored', out.tradelines[0]?.age === '13.38356164' && out.tradelines[1]?.age === null);
const fields = 'age,creditLimit,id,issuer,name,openDate,price';
check('a tradeline carries those seven fields and no others', out.tradelines.every((row) => Object.keys(row).sort().join() === fields), Object.keys(out.tradelines[0] ?? {}));
const leaky = publicInventory([{ ...rows[0]!, createdBy: 'marvin', updatedBy: 'marvin' } as Tradeline]);
check('nothing extra on a row is passed through', Object.keys(leaky.tradelines[0] ?? {}).sort().join() === fields);

console.log('- the issuers -');
check('every issuer is there, in the usual order', out.issuers.map((issuer) => issuer.key).join() === TRADELINE_ISSUERS.map((issuer) => issuer.key).join());
const capitalOne = out.issuers.find((issuer) => issuer.key === 'capital-one');
check('the count is of priced tradelines', capitalOne?.count === 2, capitalOne);
check('from is the lowest price', capitalOne?.fromPrice === 450, capitalOne);
const citi = out.issuers.find((issuer) => issuer.key === 'citi');
check('an issuer with nothing priced has none and no from', citi?.count === 0 && citi?.fromPrice === null, citi);
check('an issuer carries those four fields and no others', out.issuers.every((issuer) => Object.keys(issuer).sort().join() === 'count,fromPrice,key,label'));
const none = publicInventory([]);
check('no tradelines at all is six empty issuers', none.tradelines.length === 0 && none.issuers.length === 6 && none.issuers.every((issuer) => issuer.count === 0));

console.log('- who may read it from a browser -');
const SITE = 'https://tradelines.example.com';
check('in production the answer is always the storefront, whoever asked', allowedOrigin(SITE, SITE, true) === SITE && allowedOrigin('https://evil.example.com', SITE, true) === SITE && allowedOrigin(null, SITE, true) === SITE);
check('so it never names another site', allowedOrigin('https://evil.example.com', SITE, true) !== 'https://evil.example.com' && allowedOrigin(`${SITE}.evil.com`, SITE, true) === SITE);
check('with a trailing slash in the setting', allowedOrigin(SITE, `${SITE}/`, true) === SITE);
check('and capitals in it', allowedOrigin(SITE, 'https://Tradelines.Example.com', true) === SITE);
check('nobody may when the setting is empty', allowedOrigin(SITE, '', true) === '' && allowedOrigin(SITE, undefined, true) === '');
check('nor when it is not a plain site address', allowedOrigin(SITE, `${SITE}/shop`, true) === '' && allowedOrigin(SITE, 'tradelines.example.com', true) === '');
check('a local site may, outside production', allowedOrigin('http://localhost:5173', SITE, false) === 'http://localhost:5173');
check('and on 127.0.0.1', allowedOrigin('http://127.0.0.1:4173', undefined, false) === 'http://127.0.0.1:4173');
check('a local site may not in production', allowedOrigin('http://localhost:5173', '', true) === '');
check('and not something merely starting with localhost', allowedOrigin('http://localhost.evil.com', undefined, false) === '');
check('outside production a request with no origin gets the storefront too', allowedOrigin(null, SITE, false) === SITE);

console.log(`\ntradelines-public: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
