/**
 * Approving a payout: who the money is going to, as the dialog reads them off
 * the roster and the bank details, and the two counts the Pending tab carries.
 *
 *   npx tsx scripts/payout-approve-checks.ts
 */
import {
  buildPayees,
  payeeBankLines,
  payeeContactLines,
  pendingCounts,
  pendingTabCounts,
  PENDING_SECTIONS,
} from '../src/lib/payout-admin';
import { PAYOUT_DAYS } from '../src/lib/payout';

let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n       got ${JSON.stringify(actual)}\n       want ${JSON.stringify(expected)}`}`);
}

const person = {
  userId: 'u1',
  username: 'rusinque',
  fullName: 'Stefany Rusinque',
  email: 'stefany@example.com',
  position: 'Affiliate',
  mobile: '+1 555 0100',
  usr: 'd4wz7v',
};
const bank = {
  userId: 'u1',
  savedAt: '2026-08-01T00:00:00Z',
  accountName: 'Stefany Rusinque',
  bankName: 'Chase',
  accountLast4: '4321',
};

console.log('— who is being paid —');
const payees = buildPayees([person], [bank]);
check('kept under the account id the request carries', Object.keys(payees), ['u1']);
check('their details', payees.u1, {
  userId: 'u1',
  name: 'Stefany Rusinque',
  username: 'rusinque',
  email: 'stefany@example.com',
  mobile: '+1 555 0100',
  position: 'Affiliate',
  usr: 'd4wz7v',
  bank: { accountName: 'Stefany Rusinque', bankName: 'Chase', last4: '4321', savedAt: '2026-08-01T00:00:00Z' },
});
check(
  'somebody with no bank details on file still reads as a person',
  buildPayees([{ ...person, userId: 'u2' }], []).u2!.bank,
  null,
);
check(
  'a name nobody filled in falls back to the username',
  buildPayees([{ ...person, userId: 'u3', fullName: '  ' }], []).u3!.name,
  'rusinque',
);
check('bank details for somebody not on the roster are ignored', Object.keys(buildPayees([], [bank])), []);

console.log('\n— what the dialog puts on screen —');
check('the contact lines, blanks left out', payeeContactLines(payees.u1!), [
  { label: 'Username', value: 'rusinque' },
  { label: 'Email', value: 'stefany@example.com' },
  { label: 'Mobile', value: '+1 555 0100' },
  { label: 'Position', value: 'Affiliate' },
  { label: 'Tracking key', value: 'd4wz7v' },
]);
check(
  'a blank field is left out rather than shown empty',
  payeeContactLines({ ...payees.u1!, mobile: '', position: '' }).map((line) => line.label),
  ['Username', 'Email', 'Tracking key'],
);
check('the account number is masked, never whole', payeeBankLines(payees.u1!), [
  { label: 'Account name', value: 'Stefany Rusinque' },
  { label: 'Bank', value: 'Chase' },
  { label: 'Account number', value: '••••4321' },
]);
check(
  'no bank details is said plainly, not left blank',
  payeeBankLines({ ...payees.u1!, bank: null }),
  [{ label: 'Bank details', value: 'No bank details on file' }],
);
check(
  'bank details saved with no number behind them say so',
  payeeBankLines({ ...payees.u1!, bank: { accountName: 'S R', bankName: 'Chase', last4: '', savedAt: '' } }).at(-1),
  { label: 'Account number', value: 'Not on file' },
);

console.log('\n— the two counts on Pending —');
const split = { ready: [{ amount: 1 }, { amount: 2 }, { amount: 3 }], countingDown: [{}, {}] };
check('ready, and how many are still inside their 45 days', pendingCounts(split), { ready: 3, waiting: 2 });
check('the pill carries both', pendingTabCounts(split), {
  badge: '3 · 2',
  label: `3 ready to request, 2 not yet ${PAYOUT_DAYS} days old`,
});
check('one of each reads in the singular', pendingTabCounts({ ready: [{ amount: 1 }], countingDown: [{}] }), {
  badge: '1 · 1',
  label: `1 ready to request, 1 not yet ${PAYOUT_DAYS} days old`,
});
check('nothing waiting still says both, rather than hiding a zero', pendingTabCounts({ ready: [], countingDown: [] }), {
  badge: '0 · 0',
  label: `0 ready to request, 0 not yet ${PAYOUT_DAYS} days old`,
});
check(
  'and the section that holds them is named for what it means',
  PENDING_SECTIONS.map((section) => section.label),
  ['Ready to request', `Not yet ${PAYOUT_DAYS} days`],
);

console.log(failed === 0 ? '\nPASS' : `\nFAIL — ${failed} check(s)`);
process.exit(failed === 0 ? 0 : 1);
