// The tradeline orders migration.
//
// Nothing here runs it. This reads the file and pins what the app and the
// payout build after it depend on: the three statuses and that their dates
// agree with them, that an order's lines go in with it or not at all, that
// the sealed columns cannot be empty, and that nobody but the server can read
// any of it.
//
//   npx tsx scripts/tradeline-orders-migration-checks.ts

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) pass++;
  else {
    fail++;
    console.error('FAIL:', name, extra === undefined ? '' : extra);
  }
}

const FILE = join(__dirname, '..', 'supabase', 'migrations', '20261014120000_tradeline_orders.sql');
check('it exists under its name', existsSync(FILE));
const sql = existsSync(FILE) ? readFileSync(FILE, 'utf8') : '';
const has = (pattern: RegExp) => pattern.test(sql);

console.log('- the tables -');
for (const table of ['tradeline_orders', 'tradeline_order_items', 'tradeline_ssn_reveals']) {
  check(`${table} is created, and only if it is not there`, has(new RegExp(`create table if not exists public\\.${table} \\(`)));
  check(`${table} is closed to everybody but the server`, has(new RegExp(`alter table public\\.${table} enable row level security`)) && has(new RegExp(`revoke all on public\\.${table} from anon, authenticated`)));
}

console.log('- an order -');
check('has the three statuses', has(/status in \('awaiting_payment', 'paid', 'cancelled'\)/));
check('starts awaiting payment', has(/status text not null default 'awaiting_payment'/));
check('awaiting payment has neither date', has(/status = 'awaiting_payment' and paid_at is null and cancelled_at is null/));
check('paid has its date and is not cancelled', has(/status = 'paid' and paid_at is not null and cancelled_at is null/));
check('cancelled has its date', has(/status = 'cancelled' and cancelled_at is not null/));
check('the sealed SSN and date of birth cannot be empty', has(/ssn_encrypted <> ''/) && has(/dob_encrypted <> ''/));
check('only the last four of the SSN are kept readable', has(/ssn_last4 ~ '\^\[0-9\]\{4\}\$'/) && !/\bssn text\b/.test(sql) && !/\bdob date\b/.test(sql));
check('the total is more than nought', has(/total > 0/));
check('the order number has its shape and is nobody else\'s', has(/order_number ~ '\^LGF-\[0-9\]\{6\}\$'/) && has(/create unique index if not exists tradeline_orders_number_key\s+on public\.tradeline_orders \(order_number\)/));
check('it is drawn at random, six digits never starting with a nought', has(/100000 \+ floor\(random\(\) \* 900000\)/));
check('an affiliate with orders cannot be deleted from under them', has(/affiliate_user_id text references public\.users \(id\) on delete restrict/));

console.log('- its lines -');
check('go when the order goes', has(/order_id bigint not null references public\.tradeline_orders \(id\) on delete cascade/));
check('carry a quantity from 1 to 12', has(/quantity between 1 and 12/));
check('carry a commission that is not negative', has(/commission >= 0/));
check('are a copy: nothing points at the tradelines table', !/references public\.tradelines\b/.test(sql));

console.log('- placing one -');
check('is one function, so the order and its lines are one transaction', has(/create or replace function public\.place_tradeline_order\(\s*p_order jsonb,\s*p_items jsonb\s*\)\s*returns text/));
check('refuses an order with no lines', has(/LG001/));
check('works the total out itself', has(/sum\(line_total\)/));
check('only the server may call it', has(/revoke all on function public\.place_tradeline_order\(jsonb, jsonb\) from public, anon, authenticated/) && has(/grant execute on function public\.place_tradeline_order\(jsonb, jsonb\) to service_role/));
check('runs with no search path to be led astray by', (sql.match(/set search_path = ''/g) ?? []).length >= 2);

console.log('- running it twice -');
check('nothing is created unconditionally', !/create table public\./.test(sql) && !/create (unique )?index (?!if not exists)/.test(sql));
check('the trigger is replaced, not duplicated', has(/drop trigger if exists tradeline_orders_number_trigger on public\.tradeline_orders/));

console.log(`\ntradeline-orders-migration: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
