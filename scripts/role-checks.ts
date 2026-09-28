/**
 * The three roles the People page shows, and the two the app enforces.
 *
 *   npx tsx scripts/role-checks.ts
 */
import { accessRole, personRole, ROLE_LABELS } from '../src/lib/roles';
import { bulkRoleSchema, newUserSchema, userPatchSchema } from '../src/lib/validate';
import { matchAccounts, type AccountRow } from '../src/components/UsersPanel';
import { buildEarnings, describeConversions, salesFigures, shareFor } from '../src/lib/analytics';
import { asAffiliateShare } from '../src/lib/load';
import { splitByReadiness } from '../src/lib/payout-request';
import { defaultSettings } from '../src/lib/settings';
import type { Conversion } from '../src/lib/types';

let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n       got ${JSON.stringify(actual)}\n       want ${JSON.stringify(expected)}`}`);
}

console.log('— what somebody is called —');
check('an admin', personRole('admin', false), 'admin');
check('an admin with a stale marker is still an admin', personRole('admin', true), 'admin');
check('an affiliate', personRole('affiliate', false), 'affiliate');
check('an affiliate with the marker', personRole('affiliate', true), 'lgf_employee');
check('the label', ROLE_LABELS.lgf_employee, 'LGF - Employee');

console.log('\n— what they can see —');
check('an LGF employee has an affiliate’s access', accessRole('lgf_employee'), 'affiliate');
check('an affiliate', accessRole('affiliate'), 'affiliate');
check('an admin', accessRole('admin'), 'admin');

console.log('\n— what the routes accept —');
check('creating an LGF employee', newUserSchema.safeParse({ username: 'dan', role: 'lgf_employee' }).success, true);
check('not a made-up role', newUserSchema.safeParse({ username: 'dan', role: 'owner' }).success, false);
check('a role change', userPatchSchema.safeParse({ action: 'set-role', role: 'lgf_employee' }).success, true);
check('a role change needs a role', userPatchSchema.safeParse({ action: 'set-role' }).success, false);
check('the old actions still parse', userPatchSchema.safeParse({ action: 'disable' }).success, true);
check('a bulk change', bulkRoleSchema.safeParse({ ids: ['a', 'b'], role: 'lgf_employee' }).success, true);
check('a bulk change with nobody ticked', bulkRoleSchema.safeParse({ ids: [], role: 'admin' }).success, false);
check('a bulk change to a made-up role', bulkRoleSchema.safeParse({ ids: ['a'], role: 'owner' }).success, false);

console.log('\n— the People filter —');
const base: AccountRow = {
  id: '1',
  username: 'a',
  role: 'affiliate',
  usr: 'aaaaaa',
  fullName: '',
  email: '',
  active: true,
  createdAt: '',
  lastLoginAt: null,
  createdBy: '',
  setup: null,
  approval: null,
  bypass: null,
};
const rows: AccountRow[] = [
  { ...base, id: 'aff', username: 'aff' },
  { ...base, id: 'lgf', username: 'lgf', lgfEmployee: true },
  { ...base, id: 'adm', username: 'adm', role: 'admin', usr: '' },
];
const ids = (role: Parameters<typeof matchAccounts>[2]) => matchAccounts(rows, '', role).map((row) => row.id);
check('Affiliate is outside affiliates only', ids('affiliate'), ['aff']);
check('LGF - Employee is employees only', ids('lgf_employee'), ['lgf']);
check('Admin', ids('admin'), ['adm']);
check('All roles', ids('all'), ['aff', 'lgf', 'adm']);

console.log('\n— an LGF employee earns no share —');
const settings = defaultSettings();
const shares = settings.shares;
const noShare = new Set(['emp001']);
const sale = (id: string, usr: string, amount: number, approvedOn = '2026-09-01'): Conversion =>
  ({ id, createdAt: approvedOn, approvedOn, slug: 'cards', usr, amount, notes: '' }) as Conversion;
const sales = [sale('a1', 'aff001', 200), sale('e1', 'emp001', 300)];

check('an affiliate’s rate is the rate in force', shareFor('aff001', '2026-09-01', shares, noShare), shareFor('aff001', '2026-09-01', shares));
check('an employee’s rate is nothing', shareFor('emp001', '2026-09-01', shares, noShare), 0);
check('no list, no exception', shareFor('emp001', '2026-09-01', shares) > 0, true);

const view = buildEarnings([], [], sales, { month: '2026-09', shares, gross: true, noShare });
const figures = salesFigures(view.totals, true);
const affiliateCut = Math.round(200 * shareFor('aff001', '2026-09-01', shares) * 100) / 100;
check('the payout is both sales', figures.payout, 500);
check('the affiliate share is the affiliate’s cut only', figures.share, affiliateCut);
check('the company keeps the rest, the employee’s sale in full', figures.keep, 500 - affiliateCut);

const listed = describeConversions([], sales, [], { shares, gross: true, noShare });
check('the approvals list prices the employee’s at nothing', listed.map((row) => row.affiliate), [affiliateCut, 0]);

const owed = asAffiliateShare(sales, settings, noShare);
check('what they are owed: the affiliate their cut, the employee nothing', owed.map((row) => row.amount), [affiliateCut, 0]);
const split = splitByReadiness(owed, '2026-12-31', new Set());
check('an employee has nothing to request', split.ready.map((row) => row.id), ['a1']);

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
