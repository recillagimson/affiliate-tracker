// The tradelines table, as arithmetic and reading: which issuers there are,
// how a pasted spreadsheet becomes rows, and how old a tradeline is.
//
// The paste reader is the part worth pinning hardest. It is how nearly every
// row gets in, it reads money and dates written for people rather than for a
// parser, and a row read wrong is a tradeline quoted to somebody with the
// wrong limit or the wrong age. The first fixture is the Capital One list
// exactly as it was handed over: one value per line, header included.
//
// The age is shown exactly as it was pasted or typed, never worked out from
// the open date: the owner's sheet is the source of the figure, and the table
// must show the sheet's number, not this app's opinion of it.
//
//   npx tsx scripts/tradelines-checks.ts

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkTradeline,
  formatAge,
  formatLimit,
  formatOpenDate,
  isIssuerKey,
  issuerFrom,
  issuerLabel,
  MAX_PASTE_ROWS,
  parseAge,
  parseLimit,
  parseOpenDate,
  parsePaste,
  readTradelineInput,
  sortTradelines,
  TRADELINE_ISSUERS,
  type Tradeline,
} from '../src/lib/tradelines';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) pass++;
  else {
    fail++;
    console.error('FAIL:', name, extra === undefined ? '' : extra);
  }
}

const said: string[] = [];
// The day the sheet's own Age column was worked out on: 2012-04-10 plus the
// 4,885 days its 13.38356164 years comes to.
const TODAY = '2025-08-25';

console.log('- the issuers -');
check(
  'the six, in the order they were asked for',
  TRADELINE_ISSUERS.map((issuer) => issuer.label).join('|') ===
    'Capital One|Citi Tradeline|Discover Tradeline|Fidelity/Elan Tradeline|PNC Tradeline|US Bank Tradeline',
);
check('each has a key that is safe in an address', TRADELINE_ISSUERS.every((issuer) => /^[a-z][a-z-]*$/.test(issuer.key)));
check('no two share a key', new Set(TRADELINE_ISSUERS.map((issuer) => issuer.key)).size === 6);
check('a key is recognised', isIssuerKey('capital-one') && !isIssuerKey('Capital One') && !isIssuerKey(undefined));
check('the page opens on the first', issuerFrom(undefined) === 'capital-one' && issuerFrom('nonsense') === 'capital-one');
check('or on the one in the address', issuerFrom(' PNC ') === 'pnc');
check('a key has its label', issuerLabel('fidelity-elan') === 'Fidelity/Elan Tradeline');
for (const issuer of TRADELINE_ISSUERS) said.push(issuer.label);

console.log('- money -');
check('a plain limit', parseLimit('$500') === 500);
check('with a thousands comma', parseLimit('$1,524') === 1524);
check('with cents', parseLimit('$1,524.50') === 1524.5);
check('without the sign', parseLimit('3000') === 3000);
check('with spaces round it', parseLimit('  $ 5,000 ') === 5000);
check('nothing is not a limit', parseLimit('') === null && parseLimit('$') === null);
check('words are not a limit', parseLimit('Credit Limit') === null);
check('zero is not a limit', parseLimit('$0') === null);
check('a negative is not a limit', parseLimit('-500') === null);
check('shown the way it was written', formatLimit(1524) === '$1,524' && formatLimit(1524.5) === '$1,524.50');

console.log('- dates -');
check('the spreadsheet\'s own format', parseOpenDate('10-Apr-12', TODAY) === '2012-04-10');
check('a single-digit day', parseOpenDate('2-Apr-11', TODAY) === '2011-04-02');
check('a leading zero in the year', parseOpenDate('22-Jul-09', TODAY) === '2009-07-22');
check('a four-digit year', parseOpenDate('31-Dec-2017', TODAY) === '2017-12-31');
check('a two-digit year later than this one is last century', parseOpenDate('1-Jan-98', TODAY) === '1998-01-01');
check('this year is this year', parseOpenDate('1-Jan-25', TODAY) === '2025-01-01');
check('the way a date field writes it', parseOpenDate('2012-04-10', TODAY) === '2012-04-10');
check('month first with slashes', parseOpenDate('4/10/2012', TODAY) === '2012-04-10' && parseOpenDate('04/10/12', TODAY) === '2012-04-10');
check('a month name written out', parseOpenDate('April 10, 2012', TODAY) === '2012-04-10' && parseOpenDate('Apr 10 2012', TODAY) === '2012-04-10');
check('spaces instead of dashes', parseOpenDate('10 Apr 2012', TODAY) === '2012-04-10');
check('a day that does not exist is refused', parseOpenDate('31-Feb-12', TODAY) === '' && parseOpenDate('2012-02-30', TODAY) === '');
check('a month that does not exist is refused', parseOpenDate('10-Foo-12', TODAY) === '' && parseOpenDate('13/40/2012', TODAY) === '');
check('words are not a date', parseOpenDate('Open Date', TODAY) === '' && parseOpenDate('', TODAY) === '');
check('shown unambiguously', formatOpenDate('2012-04-10') === '10 Apr 2012');

console.log('- age -');
check('an age is read as it is written', parseAge('13.38356164') === 13.38356164);
check('a whole number', parseAge('7') === 7);
check('with spaces round it', parseAge(' 16.45753425 ') === 16.45753425);
check('a number is a number', parseAge(12.5) === 12.5);
check('zero is an age', parseAge('0') === 0);
check('nothing is no age', parseAge('') === null && parseAge(undefined) === null && parseAge(null) === null);
check('words are no age', parseAge('Age (Years)') === null && parseAge('about 13') === null);
check('a negative is no age', parseAge('-3') === null);
check('an absurd one is no age', parseAge('1200') === null);
check('shown exactly as it was given, every digit', formatAge(13.38356164) === '13.38356164' && formatAge(15.1890411) === '15.1890411' && formatAge(7.654794521) === '7.654794521');
check('a whole number is shown whole', formatAge(7) === '7');
check('no age shows nothing', formatAge(null) === '');

console.log('- the list as it was handed over -');
const HANDED_OVER = `Issuer/Type
Credit Limit
Open Date
Age (Years)
Capital One/Cabelas
$500
10-Apr-12
13.38356164
Capital One/Cabelas
$500
22-May-14
11.26849315
Capital One/Cabelas
$500
10-Apr-12
13.38356164
Capital One Walmart
$1,524
31-Dec-17
7.654794521
Capital One
$3,000
15-Nov-11
13.78630137
Capital One
$2,000
11-Mar-13
12.46575342
Capital One
$300
31-Dec-12
12.65753425
Capital One
$3,000
2-Apr-11
14.40821918
Capital One
$5,000
2-Apr-11
14.40821918
Capital One
$5,000
16-Nov-11
13.78356164
Capital One
$5,000
15-Nov-11
13.78630137
Capital One
$3,000
21-Jun-10
15.1890411
Capital One
$1,000
22-Jul-09
16.10410959
Capital One
$500
15-Mar-09
16.45753425
`;
const handed = parsePaste(HANDED_OVER, TODAY);
check('all fourteen are read', handed.rows.length === 14, handed.rows.length);
check('with nothing it could not read', handed.problems.length === 0, handed.problems);
check('the header is not a tradeline', !handed.rows.some((row) => /issuer/i.test(row.name)));
check('the first is the first', JSON.stringify(handed.rows[0]) === JSON.stringify({ name: 'Capital One/Cabelas', creditLimit: 500, openDate: '2012-04-10', age: 13.38356164 }), handed.rows[0]);
check('the comma in a limit is read', handed.rows[3]!.name === 'Capital One Walmart' && handed.rows[3]!.creditLimit === 1524 && handed.rows[3]!.openDate === '2017-12-31');
check('the last is the last', handed.rows[13]!.creditLimit === 500 && handed.rows[13]!.openDate === '2009-03-15');
check('the same tradeline twice is two rows, as it was in the sheet', handed.rows.filter((row) => row.name === 'Capital One/Cabelas' && row.openDate === '2012-04-10').length === 2);
const EXPECTED_AGES = [13.38356164, 11.26849315, 13.38356164, 7.654794521, 13.78630137, 12.46575342, 12.65753425, 14.40821918, 14.40821918, 13.78356164, 13.78630137, 15.1890411, 16.10410959, 16.45753425];
check('every pasted age is kept exactly as it was pasted', handed.rows.map((row) => row.age).join() === EXPECTED_AGES.join(), handed.rows.map((row) => row.age));
check('and is shown exactly as it was pasted', handed.rows.map((row) => formatAge(row.age)).join() === '13.38356164,11.26849315,13.38356164,7.654794521,13.78630137,12.46575342,12.65753425,14.40821918,14.40821918,13.78356164,13.78630137,15.1890411,16.10410959,16.45753425');
check('none of them was worked out from the open date', handed.rows[0]!.age === handed.rows[2]!.age && handed.rows[0]!.age !== 14.5);

console.log('- copied straight from a spreadsheet -');
const tabbed = parsePaste('Issuer/Type\tCredit Limit\tOpen Date\tAge (Years)\nCiti Double Cash\t$7,500\t3-Mar-15\t10.5\nCiti Simplicity\t$2,000\t2016-01-20\t9.6\n', TODAY);
check('two rows, header skipped', tabbed.rows.length === 2 && tabbed.problems.length === 0, tabbed);
check('read across, age included', tabbed.rows[0]!.name === 'Citi Double Cash' && tabbed.rows[0]!.creditLimit === 7500 && tabbed.rows[0]!.openDate === '2015-03-03' && tabbed.rows[0]!.age === 10.5 && tabbed.rows[1]!.age === 9.6);
const noAge = parsePaste('PNC Cash Rewards\t$4,000\t5/6/2014\n', TODAY);
check('three columns, with no age, is fine', noAge.rows.length === 1 && noAge.rows[0]!.openDate === '2014-05-06');
check('and that row simply has no age: none is made up for it', noAge.rows[0]!.age === null);
const noHeader = parsePaste('Discover it\n$2,500\n1-Feb-13\nDiscover Miles\n$6,000\n9-Sep-16\n', TODAY);
check('one value per line with no ages and no header', noHeader.rows.length === 2 && noHeader.problems.length === 0 && noHeader.rows.every((row) => row.age === null), noHeader);
const windows = parsePaste('US Bank Cash+\t$3,000\t1-Jan-14\r\nUS Bank Altitude\t$9,000\t1-Jun-18\r\n', TODAY);
check('Windows line endings', windows.rows.length === 2 && windows.rows[1]!.name === 'US Bank Altitude');
check('blank lines between rows are ignored', parsePaste('\n\nPNC\t$1,000\t1-Jan-14\n\n\nPNC Core\t$2,000\t1-Jan-15\n\n', TODAY).rows.length === 2);

console.log('- what it cannot read -');
const bad = parsePaste('Citi A\t$7,500\t3-Mar-15\nCiti B\tcall us\t3-Mar-15\nCiti C\t$1,000\tsoon\n\t$1,000\t3-Mar-15\nCiti E\t$900\t4-Apr-16\n', TODAY);
check('the good rows are still read', bad.rows.length === 2 && bad.rows[1]!.name === 'Citi E', bad.rows);
check('each bad row is reported once', bad.problems.length === 3, bad.problems);
check('with the line it is on', bad.problems.map((problem) => problem.line).join() === '2,3,4', bad.problems.map((p) => p.line));
check('and which part was wrong', /limit/i.test(bad.problems[0]!.reason) && /date/i.test(bad.problems[1]!.reason) && /name/i.test(bad.problems[2]!.reason));
for (const problem of bad.problems) said.push(problem.reason);
check('a date in the future is reported', parsePaste('Citi F\t$1,000\t1-Jan-2030\n', TODAY).problems.length === 1);
check('nothing pasted is nothing read', parsePaste('   \n  ', TODAY).rows.length === 0 && parsePaste('', TODAY).problems.length === 0);
check('only a header is nothing read', parsePaste('Issuer/Type\tCredit Limit\tOpen Date\tAge (Years)\n', TODAY).rows.length === 0);
const many = parsePaste(Array.from({ length: MAX_PASTE_ROWS + 5 }, (_, n) => `Card ${n}\t$1,000\t1-Jan-14`).join('\n'), TODAY);
check('more than fits in one paste is said, not silently cut', many.rows.length === MAX_PASTE_ROWS && many.problems.some((problem) => /at a time/.test(problem.reason)));

console.log('- one tradeline -');
const good = { name: 'Capital One', creditLimit: 3000, openDate: '2011-11-15', age: 13.78630137 };
check('a good one has no problems', Object.keys(checkTradeline(good, TODAY)).length === 0);
check('no name', checkTradeline({ ...good, name: '  ' }, TODAY).name !== undefined);
check('a name too long', checkTradeline({ ...good, name: 'x'.repeat(121) }, TODAY).name !== undefined);
check('no limit', checkTradeline({ ...good, creditLimit: 0 }, TODAY).creditLimit !== undefined);
check('an absurd limit', checkTradeline({ ...good, creditLimit: 50_000_000 }, TODAY).creditLimit !== undefined);
check('no date', checkTradeline({ ...good, openDate: '' }, TODAY).openDate !== undefined);
check('a date tomorrow', checkTradeline({ ...good, openDate: '2025-08-26' }, TODAY).openDate !== undefined);
check('a date today is fine', checkTradeline({ ...good, openDate: TODAY }, TODAY).openDate === undefined);
check('no age is allowed', checkTradeline({ ...good, age: null }, TODAY).age === undefined);
check('an absurd age is caught', checkTradeline({ ...good, age: 500 }, TODAY).age !== undefined);
for (const text of Object.values(checkTradeline({ name: '', creditLimit: 0, openDate: '', age: 500 }, TODAY))) said.push(text);
const typed = readTradelineInput({ name: ' Capital One ', creditLimit: '$3,000', openDate: '15-Nov-11', age: '13.78630137' }, TODAY);
check('a form\'s text is read the way a paste is', typed.ok && typed.value.name === 'Capital One' && typed.value.creditLimit === 3000 && typed.value.openDate === '2011-11-15' && typed.value.age === 13.78630137);
const blankAge = readTradelineInput({ name: 'Capital One', creditLimit: 3000, openDate: '2011-11-15', age: '' }, TODAY);
check('a blank age is no age, not zero', blankAge.ok && blankAge.value.age === null);
const wordAge = readTradelineInput({ name: 'Capital One', creditLimit: 3000, openDate: '2011-11-15', age: 'old' }, TODAY);
check('an age that is not a number is refused, not dropped', !wordAge.ok && wordAge.fields.age !== undefined);
const numeric = readTradelineInput({ name: 'Capital One', creditLimit: 3000, openDate: '2011-11-15' }, TODAY);
check('and so are a number and a plain date', numeric.ok && numeric.value.creditLimit === 3000);
const wrong = readTradelineInput({ name: 'Capital One', creditLimit: 'lots', openDate: 'soon' }, TODAY);
check('what cannot be read is refused by field', !wrong.ok && wrong.fields.creditLimit !== undefined && wrong.fields.openDate !== undefined);
check('something that is not a tradeline at all is refused', !readTradelineInput(null, TODAY).ok && !readTradelineInput('x', TODAY).ok);

console.log('- sorting -');
const rows: Tradeline[] = [
  { id: '1', issuer: 'capital-one', name: 'Capital One', creditLimit: 3000, openDate: '2011-11-15', age: 13.78 },
  { id: '2', issuer: 'capital-one', name: 'Capital One Walmart', creditLimit: 1524, openDate: '2017-12-31', age: null },
  { id: '3', issuer: 'capital-one', name: 'Capital One/Cabelas', creditLimit: 500, openDate: '2012-04-10', age: 20 },
  { id: '4', issuer: 'capital-one', name: 'capital one', creditLimit: 5000, openDate: '2011-04-02', age: 14.4 },
];
const ids = (key: Parameters<typeof sortTradelines>[1], dir: 'asc' | 'desc') => sortTradelines(rows, key, dir).map((row) => row.id).join();
check('as entered, by default', ids('entered', 'asc') === '1,2,3,4');
check('highest age first, by the age on the row and not by its date', ids('age', 'desc') === '3,4,1,2');
check('lowest age first', ids('age', 'asc') === '1,4,3,2');
check('a row with no age goes last either way', ids('age', 'desc').endsWith('2') && ids('age', 'asc').endsWith('2'));
check('earliest opened first', ids('openDate', 'asc') === '4,1,3,2');
check('highest limit first', ids('creditLimit', 'desc') === '4,1,2,3');
check('by name, ignoring case, ties in the order entered', ids('name', 'asc') === '1,4,2,3');
check('sorting does not disturb the list it was given', rows.map((row) => row.id).join() === '1,2,3,4');

console.log('- the migration -');
const MIGRATION = join(__dirname, '..', 'supabase', 'migrations', '20261010120000_tradelines.sql');
check('it exists under its name', existsSync(MIGRATION));
const sql = existsSync(MIGRATION) ? readFileSync(MIGRATION, 'utf8') : '';
const at = sql.indexOf('constraint tradelines_issuer_check');
const allowed = at === -1 ? [] : [...(/\bin\s*\(([^)]*)\)/.exec(sql.slice(at, at + 400))?.[1] ?? '').matchAll(/'([^']*)'/g)].map((m) => m[1]!);
check('the database allows the same issuers, in the same order', allowed.join() === TRADELINE_ISSUERS.map((issuer) => issuer.key).join(), allowed);
check('row level security is on', sql.includes('alter table public.tradelines enable row level security'));
check('and it is revoked from the public roles', sql.includes('revoke all on public.tradelines from anon, authenticated'));
check('replacing an issuer\'s table is one transaction', sql.includes('create or replace function public.replace_tradelines('));
check('it can be run twice', sql.includes('create table if not exists public.tradelines'));
const AGE = join(__dirname, '..', 'supabase', 'migrations', '20261011120000_tradelines_age.sql');
check('the age migration exists under its name', existsSync(AGE));
const ageSql = existsSync(AGE) ? readFileSync(AGE, 'utf8') : '';
check('the age is a column of its own', /add column if not exists age_years numeric/.test(ageSql));
check('kept with every digit: no rounding scale on it', !/age_years numeric\s*\(/.test(ageSql));
check('a row may have none', !/age_years numeric[^;]*not null/.test(ageSql));
check('replacing a table carries the ages', /function public\.replace_tradelines\(/.test(ageSql) && /age_years/.test(ageSql.slice(ageSql.indexOf('function public.replace_tradelines('))));

check('there was something to read', said.length > 10, said.length);
check('no em or en dash anywhere', said.every((text) => !/[–—]/.test(text)));

console.log(`\ntradelines: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
