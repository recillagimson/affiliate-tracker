// Editing somebody's account from the People list: what the dialog will send,
// and in what order.
//
// The dialog holds four things an admin can change at once (name, email, role,
// services) and saves only the ones that changed, through the account route's
// own actions so each keeps its guards. What is pinned is that nothing is sent
// for a field nobody touched, that a role change goes before services (an
// admin has none, so the order decides whether the second write makes sense),
// and that a form that could not be saved is stopped before anything is sent.
//
//   npx tsx scripts/account-edit-checks.ts

import { accountProblems, formFor, planAccountSave, type AccountForm } from '../src/lib/account-edit';
import { userPatchSchema } from '../src/lib/validate';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) pass++;
  else {
    fail++;
    console.error('FAIL:', name, extra === undefined ? '' : extra);
  }
}

const before: AccountForm = { fullName: 'Maria Santos', email: 'maria@example.com', role: 'affiliate', services: ['personal_cards'] };
const actions = (after: AccountForm) => planAccountSave(before, after).map((step) => step.action).join();

console.log('- what gets sent -');
check('nothing changed, nothing sent', planAccountSave(before, { ...before }).length === 0);
check('a name alone is one write', actions({ ...before, fullName: 'Maria S. Santos' }) === 'set-details');
check('spaces around a name are not a change', planAccountSave(before, { ...before, fullName: '  Maria Santos ' }).length === 0);
const details = planAccountSave(before, { ...before, fullName: ' Maria S ', email: ' M@Example.com ' })[0];
check('details go tidied, both together', details?.action === 'set-details' && details.fullName === 'Maria S' && details.email === 'M@Example.com');
check('a service alone is one write', actions({ ...before, services: ['personal_cards', 'tradelines'] }) === 'set-services');
check('the same services in another order are not a change', planAccountSave(before, { ...before, services: ['personal_cards'] }).length === 0);
check('a role alone is one write', actions({ ...before, role: 'lgf_employee' }) === 'set-role');
check(
  'everything at once goes details, then role, then services',
  actions({ fullName: 'M', email: '', role: 'lgf_employee', services: ['tradelines'] }) === 'set-details,set-role,set-services',
);
check('made an admin, their services are left alone', actions({ ...before, role: 'admin', services: ['tradelines'] }) === 'set-role');
const fromAdmin: AccountForm = { fullName: '', email: '', role: 'admin', services: ['personal_cards'] };
check(
  'an admin made an affiliate on cards needs no services write, since that is the default',
  planAccountSave(fromAdmin, { ...fromAdmin, role: 'affiliate' }).map((s) => s.action).join() === 'set-role',
);
check(
  'but one made an affiliate on tradelines does',
  planAccountSave(fromAdmin, { ...fromAdmin, role: 'affiliate', services: ['tradelines'] }).map((s) => s.action).join() === 'set-role,set-services',
);
check('every step is something the route accepts', planAccountSave(before, { fullName: 'M', email: 'm@example.com', role: 'lgf_employee', services: ['tradelines'] }).every((step) => userPatchSchema.safeParse(step).success));

console.log('- what stops it -');
check('a good form has no problems', Object.keys(accountProblems(before)).length === 0);
check('a blank email is allowed', Object.keys(accountProblems({ ...before, email: '' })).length === 0);
check('a blank name is allowed', Object.keys(accountProblems({ ...before, fullName: '' })).length === 0);
check('something that is not an email is caught', accountProblems({ ...before, email: 'maria@' }).email !== undefined);
check('a name far too long is caught', accountProblems({ ...before, fullName: 'x'.repeat(121) }).fullName !== undefined);
check('an affiliate on no service is caught', accountProblems({ ...before, services: [] }).services !== undefined);
check('an admin on no service is fine, since they have none', accountProblems({ ...before, role: 'admin', services: [] }).services === undefined);
const said = Object.values({ ...accountProblems({ ...before, email: 'x', fullName: 'x'.repeat(200), services: [] }) });
check('each problem is a sentence', said.length === 3 && said.every((text) => text.length > 5 && !/[–—]/.test(text)));

console.log('- what the route accepts -');
const ok = userPatchSchema.safeParse({ action: 'set-details', fullName: ' Maria ', email: '' });
check('details with a blank email', ok.success && ok.data.action === 'set-details' && ok.data.fullName === 'Maria');
check('not a bad email', !userPatchSchema.safeParse({ action: 'set-details', fullName: 'M', email: 'nope' }).success);
check('not a name that is too long', !userPatchSchema.safeParse({ action: 'set-details', fullName: 'x'.repeat(121), email: '' }).success);

console.log('- starting the form -');
const form = formFor({ fullName: 'Maria', email: 'm@example.com', role: 'affiliate', lgfEmployee: true, services: ['tradelines'] });
check('an LGF employee starts as one', form.role === 'lgf_employee');
check('with their services', form.services.join() === 'tradelines');
check('an admin starts with the default, unshown', formFor({ fullName: '', email: '', role: 'admin' }).services.join() === 'personal_cards');

console.log(`\naccount-edit: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
