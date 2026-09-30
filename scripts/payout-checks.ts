// The day arithmetic every payout screen counts with.
//
// There is no payout schedule any more. Each approved card runs on its own 15
// day clock and the affiliate requests it once that has run (lib/payout-request,
// pinned in payout-request-checks). What stays in lib/payout is the part both
// the old model and the new one needed: turning whatever a database hands back
// into a day key, counting days across month ends and leap years, printing a
// day the way people read it, and adding money up once rather than per row.
//
// The last section pins the cleanup itself. The cycle and anchor apparatus was
// deleted, and a deleted export that something still imports is a build that
// breaks on the next deploy rather than here, so the module's surface and the
// tree's imports are both read back.
//
//   npx tsx scripts/payout-checks.ts
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as payout from '../src/lib/payout';
import {
  addDays,
  daysBetween,
  dayOf,
  isDay,
  PAYOUT_DAYS,
  settlesUp,
  shortDay,
  totalOf,
} from '../src/lib/payout';
import { PAYMENT_DAYS } from '../src/lib/agreement';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) pass++;
  else {
    fail++;
    console.error('FAIL:', name, extra === undefined ? '' : extra);
  }
}

console.log('- the wait is the payment term -');
check('15 days', PAYOUT_DAYS === 15);
/*
 * Not a second 15 typed next to the first. The agreement says Net 15 in words
 * and the payout screens count in days; if those two ever disagree, somebody is
 * paid on a date their own contract does not describe.
 */
check('and it is the agreement that says so', PAYOUT_DAYS === PAYMENT_DAYS);

console.log('\n- counting days -');
// Approved 19 August, requestable 3 September. The example the screens were built on.
const AUG19 = '2026-08-19';
check('15 days on from 19 August is 3 September', addDays(AUG19, PAYOUT_DAYS) === '2026-09-03');
check('and those are 15 days apart', daysBetween(AUG19, '2026-09-03') === 15);
check('counting back reads as negative', daysBetween('2026-09-03', AUG19) === -15);
check('a day from itself is nothing', daysBetween(AUG19, AUG19) === 0);
check('a day can be moved back', addDays(AUG19, -1) === '2026-08-18');
/*
 * An unreadable day is handed back unchanged and counts as no distance at all.
 * lib/payout-request does not lean on either answer: it checks isDay first and
 * refuses the card, because "0 days left" on a broken date reads as ready.
 */
check('an unreadable day is not moved', addDays('soon', 45) === 'soon');
check('and is no distance from anything', daysBetween('soon', AUG19) === 0 && daysBetween(AUG19, '') === 0);

console.log('\n- month ends and leap days -');
// 31 January plus 45 days lands in March, a day earlier in a leap year.
// Counting in days rather than months is what makes both come out.
check('31 Jan 2026 plus 45 is 17 Mar', addDays('2026-01-31', 45) === '2026-03-17');
check('31 Jan 2028 plus 45 is 16 Mar, the leap year', addDays('2028-01-31', 45) === '2028-03-16');
check('29 Feb is a day to count from', addDays('2028-02-29', 45) === '2028-04-14');
check('and a year with no 29 Feb skips it', addDays('2027-02-28', 1) === '2027-03-01');
check('December crosses the year', addDays('2026-12-01', 45) === '2027-01-15');
check('and so does the count', daysBetween('2026-12-01', '2027-01-15') === 45);

console.log('\n- reading a Postgres timestamp -');
// One of these comes back as an ISO string and the other as Postgres writes it.
check('an ISO stamp', dayOf('2026-08-15T09:30:00.000Z') === '2026-08-15');
check('a Postgres stamp with microseconds and a bare offset', dayOf('2026-08-15 09:30:00.308994+00') === '2026-08-15');
check('a bare date column', dayOf('2026-08-15') === '2026-08-15');
check('nothing at all', dayOf(null) === '' && dayOf(undefined) === '' && dayOf('') === '' && dayOf('later') === '');
// A day key is taken as it stands rather than parsed and re-printed, so a
// ready date cannot move with the server's timezone.
check('a day key is never re-timezoned', dayOf('2026-01-01') === '2026-01-01');
check('a day is a day', isDay('2026-08-15') && !isDay('2026-8-15') && !isDay('2026-02-30'));
check('a leap day is a day only in a leap year', isDay('2028-02-29') && !isDay('2027-02-29'));
check('and a timestamp is not a day key', !isDay('2026-08-15T00:00:00Z'));

console.log('\n- what it comes to -');
check('a total', totalOf([{ amount: 20 }, { amount: 30 }]) === 50);
check('nothing is nothing', totalOf([]) === 0);
// Rounded once at the end. Half a cent rounded per row is a total that does not
// match the sum of the lines somebody is reading.
check('rounded once', totalOf([{ amount: 0.005 }, { amount: 0.005 }]) === 0.01);
check('a broken amount does not poison the sum', totalOf([{ amount: Number.NaN }, { amount: 5 }]) === 5);
// A request's items carry no approval day, and a card still does. Both add up.
check(
  'anything with an amount adds up',
  totalOf([{ conversionId: '7', amount: 35.5 }]) === 35.5 &&
    totalOf([{ approvedOn: AUG19, amount: 1.25 }, { approvedOn: AUG19, amount: 1.25 }]) === 2.5,
);

console.log('\n- what was paid against what was asked for -');
check('nothing recorded, nothing to reconcile', settlesUp(284.22, null));
check('the same figure settles', settlesUp(284.22, 284.22));
check('a cent apart does not', !settlesUp(284.22, 284.21));
// An admin can type a different figure than the request came to. The page has
// to say so rather than quietly showing one number as though it were both.
check('a different figure shows up as a difference', !settlesUp(320, 284.22));
check('and floating point noise does not', settlesUp(0.1 + 0.2, 0.3));

console.log('\n- dates as people read them -');
check('a day', shortDay('2026-08-15') === '15 Aug 2026');
check('the first of a month', shortDay('2026-01-01') === '1 Jan 2026');
check('the day a card becomes ready', shortDay(addDays(AUG19, PAYOUT_DAYS)) === '3 Sep 2026');
check('a timestamp reads as its day', shortDay('2026-08-15T22:00:00Z') === '15 Aug 2026');
check('and a Postgres one too', shortDay('2026-08-15 22:00:00.1+00') === '15 Aug 2026');
check('and nonsense is handed back unchanged', shortDay('someday') === 'someday');
check('a day has no dash in it', !/[\u2013\u2014-]/.test(shortDay('2026-12-31')));

console.log('\n- what is left of the module -');
/*
 * Exactly these, and nothing else. The cycle and anchor exports (anchorFor,
 * periodAt, bandOf and the rest) counted pay from the day somebody signed,
 * which is the model the payout requests replaced. A leftover export is how a
 * screen quietly goes back to drawing a payday nobody has.
 */
const SURVIVORS = ['addDays', 'dayOf', 'daysBetween', 'isDay', 'PAYOUT_DAYS', 'settlesUp', 'shortDay', 'totalOf'];
const exported = Object.keys(payout).sort();
check('lib/payout exports only the day arithmetic', exported.join() === [...SURVIVORS].sort().join(), exported);

const ROOT = join(__dirname, '..');
check('lib/payout-store is gone', !existsSync(join(ROOT, 'src', 'lib', 'payout-store.ts')));
check('PayoutSchedule is gone', !existsSync(join(ROOT, 'src', 'components', 'PayoutSchedule.tsx')));
check('and so is the pay-period payslip', !existsSync(join(ROOT, 'src', 'app', '(admin)', 'payslips', '[period]')));

/** Every source file under a folder. Scratch probes (scripts/_tmp-*) are not the app's. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('_tmp')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx|mts)$/.test(name)) out.push(path);
  }
  return out;
}
const files = ['src', 'scripts', 'test'].flatMap((dir) => sources(join(ROOT, dir)));
check('there was a tree to read', files.length > 50, files.length);

/*
 * The old addresses, built from pieces so this file's own source cannot match
 * them: a payslip named by its pay period, and a receipt found by user and
 * period. Both are named by the request now.
 */
const OLD_ADDRESSES = ['payslips/${' + 'period', 'receipt?' + 'user=', '&' + 'period='];
const leaning: string[] = [];
const stale: string[] = [];
const links: string[] = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const name = file.slice(ROOT.length + 1);
  for (const match of text.matchAll(/import\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
    const [, clause = '', from = ''] = match;
    if (/(^|\/)(payout-store|PayoutSchedule)$/.test(from)) leaning.push(`${name}: ${from}`);
    if (!/(^|\/)payout$/.test(from)) continue;
    const names = (clause.match(/\{([\s\S]*)\}/)?.[1] ?? '')
      .split(',')
      .map((part) => part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim())
      .filter(Boolean);
    for (const imported of names) {
      if (!SURVIVORS.includes(imported)) stale.push(`${name}: ${imported}`);
    }
  }
  if (OLD_ADDRESSES.some((needle) => text.includes(needle))) links.push(name);
}
check('nothing imports the deleted store or schedule', leaning.length === 0, leaning);
check('nothing imports a deleted name from lib/payout', stale.length === 0, stale);
check('and nothing links to a pay period', links.length === 0, links);

// A doc comment that sends a reader to a function that no longer exists.
const onboardingStore = readFileSync(join(ROOT, 'src', 'lib', 'onboarding-store.ts'), 'utf8');
check('onboarding-store no longer cites anchorFor', !onboardingStore.includes('anchorFor'));
const agreement = readFileSync(join(ROOT, 'src', 'lib', 'agreement.ts'), 'utf8');
check('and the agreement no longer counts cycles', !agreement.includes('counts cycles in days'));

console.log(`\npayout: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
