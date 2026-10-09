// The tradelines reference number: the code, like TL-48213, that says which
// affiliate sold a tradeline.
//
// The database hands them out (migration 20261013120000) and the app only
// reads them, so what is pinned here is that the two agree on what a code
// looks like, that the app never shows something that is not one, and that
// the migration does what the checkout will later depend on: one code per
// person, nobody sharing, and a code that is never taken away or changed.
//
//   npx tsx scripts/tradeline-ref-checks.ts

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isTradelineRef, readTradelineRef, tradelineLinkFor, TRADELINE_REF_PATTERN } from '../src/lib/tradeline-ref';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) pass++;
  else {
    fail++;
    console.error('FAIL:', name, extra === undefined ? '' : extra);
  }
}

console.log('- what a code looks like -');
check('TL- and five digits is one', isTradelineRef('TL-48213'));
check('the lowest the database draws is one', isTradelineRef('TL-10000'));
check('the highest is one', isTradelineRef('TL-99999'));
check('four digits is not', !isTradelineRef('TL-4821'));
check('six digits is not', !isTradelineRef('TL-482130'));
check('lower case is not', !isTradelineRef('tl-48213'));
check('the number alone is not', !isTradelineRef('48213'));
check('a letter among the digits is not', !isTradelineRef('TL-4821a'));
check('padding is not', !isTradelineRef(' TL-48213') && !isTradelineRef('TL-48213\n'));
check('nothing is not', !isTradelineRef('') && !isTradelineRef(null) && !isTradelineRef(undefined));
check('a number is not', !isTradelineRef(48213));

console.log('- reading a stored code -');
check('a good one is kept as it is', readTradelineRef('TL-48213') === 'TL-48213');
check('somebody with none reads as none', readTradelineRef(null) === '');
check('a missing column reads as none', readTradelineRef(undefined) === '');
check('something that is not a code reads as none', readTradelineRef('arthur-smith') === '' && readTradelineRef(7) === '');

console.log('- the link an affiliate hands out -');
const SITE = 'https://tradelines.example.com';
check('is the storefront with their number on it', tradelineLinkFor(SITE, 'TL-48213') === 'https://tradelines.example.com/?ref=TL-48213');
check('a trailing slash in the setting is not doubled', tradelineLinkFor(`${SITE}/`, 'TL-48213') === 'https://tradelines.example.com/?ref=TL-48213');
check('padding round the setting is ignored', tradelineLinkFor(`  ${SITE} `, 'TL-48213') === 'https://tradelines.example.com/?ref=TL-48213');
check('no storefront address, no link', tradelineLinkFor('', 'TL-48213') === '' && tradelineLinkFor(undefined, 'TL-48213') === '');
check('no number, no link', tradelineLinkFor(SITE, '') === '');
check('something that is not a number, no link', tradelineLinkFor(SITE, 'arthur-smith') === '');
check('an address that is not a web address, no link', tradelineLinkFor('tradelines.example.com', 'TL-48213') === '' && tradelineLinkFor('javascript:alert(1)', 'TL-48213') === '');

console.log('- the migration -');
const MIGRATION = join(__dirname, '..', 'supabase', 'migrations', '20261013120000_tradeline_ref.sql');
check('it exists under its name', existsSync(MIGRATION));
const sql = existsSync(MIGRATION) ? readFileSync(MIGRATION, 'utf8') : '';
const shape = /tradeline_ref ~ '([^']*)'/.exec(sql)?.[1] ?? '';
check('the database allows the same shape the app reads', shape === TRADELINE_REF_PATTERN.source, shape);
check('the column may be empty, for somebody not on tradelines', /add column if not exists tradeline_ref text(?! not null)/.test(sql));
check('no two people share a code', /create unique index if not exists users_tradeline_ref_key\s+on public\.users \(tradeline_ref\)/.test(sql));
check('a code is given when tradelines is among the services', /'tradelines' = any\s*\(new\.services\)/.test(sql));
check('and only to somebody without one', /new\.tradeline_ref is null/.test(sql));
check('on a new account and on a changed one', /before insert or update[^;]*on public\.users/.test(sql));
check('a code already given cannot be changed or removed', /new\.tradeline_ref := old\.tradeline_ref/.test(sql));
check('it draws five digits, never starting with a nought', /10000 \+ floor\(random\(\) \* 90000\)/.test(sql));
check('everybody already on tradelines is given one', /update public\.users[\s\S]*where 'tradelines' = any\s*\(services\)[\s\S]*tradeline_ref is null/.test(sql));
check('it can be run twice', /create or replace function/.test(sql) && /drop trigger if exists users_tradeline_ref_trigger/.test(sql));

console.log(`\ntradeline-ref: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
