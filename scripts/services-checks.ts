// Which services somebody is onboarded for: Personal Cards, Tradelines, or
// both.
//
// It is only a record for now. Nothing else in the app reads it, which is
// exactly why it has to be right: when tradeline tracking is built, this list
// is what decides who it applies to. So what is pinned is that the list is
// always one the database accepts, that nobody who should have a service ends
// up with none, and that a row this version cannot read falls back to what
// everybody was doing before services existed.
//
//   npx tsx scripts/services-checks.ts

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_SERVICES,
  isService,
  normalizeServices,
  SERVICE_LABELS,
  SERVICES,
  servicesLabel,
  servicesProblem,
  toggleService,
} from '../src/lib/services';
import { newUserSchema, userPatchSchema } from '../src/lib/validate';

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

console.log('- the services -');
check('there are two, cards first', SERVICES.join() === 'personal_cards,tradelines');
check('each has a name', SERVICE_LABELS.personal_cards === 'Personal Cards' && SERVICE_LABELS.tradelines === 'Tradelines');
check('one is recognised', isService('tradelines') && !isService('Tradelines') && !isService(1));
check('everybody starts on cards', DEFAULT_SERVICES.join() === 'personal_cards');
for (const label of Object.values(SERVICE_LABELS)) said.push(label);

console.log('- reading a stored list -');
check('a good list is kept', normalizeServices(['personal_cards', 'tradelines']).join() === 'personal_cards,tradelines');
check('order is always the same', normalizeServices(['tradelines', 'personal_cards']).join() === 'personal_cards,tradelines');
check('tradelines alone is a list', normalizeServices(['tradelines']).join() === 'tradelines');
check('a repeat is dropped', normalizeServices(['tradelines', 'tradelines']).join() === 'tradelines');
check('a service this version does not know is dropped', normalizeServices(['tradelines', 'mortgages']).join() === 'tradelines');
check('nothing readable falls back to cards', normalizeServices(['mortgages']).join() === 'personal_cards');
check('an empty list falls back to cards', normalizeServices([]).join() === 'personal_cards');
check('a missing column falls back to cards', normalizeServices(undefined).join() === 'personal_cards' && normalizeServices(null).join() === 'personal_cards');
check('something that is not a list falls back to cards', normalizeServices('tradelines').join() === 'personal_cards');
check('the default is never handed out to be changed', normalizeServices(undefined) !== DEFAULT_SERVICES);

console.log('- saying it -');
check('one service', servicesLabel(['tradelines']) === 'Tradelines');
check('both, cards first', servicesLabel(['tradelines', 'personal_cards']) === 'Personal Cards, Tradelines');
said.push(servicesLabel(['personal_cards', 'tradelines']));

console.log('- choosing -');
check('ticking adds', toggleService(['personal_cards'], 'tradelines', true).join() === 'personal_cards,tradelines');
check('unticking removes', toggleService(['personal_cards', 'tradelines'], 'personal_cards', false).join() === 'tradelines');
check('ticking twice is once', toggleService(['tradelines'], 'tradelines', true).join() === 'tradelines');
check('the last one can be unticked in the form', toggleService(['tradelines'], 'tradelines', false).length === 0);
check('but a list with none is refused', servicesProblem([]) !== '');
check('one is fine', servicesProblem(['tradelines']) === '');
check('both are fine', servicesProblem(['personal_cards', 'tradelines']) === '');
said.push(servicesProblem([]));

console.log('- what the routes accept -');
const base = { username: 'maria', role: 'affiliate' as const };
const plain = newUserSchema.safeParse(base);
check('a new account with nothing said is on cards', plain.success && plain.data.services.join() === 'personal_cards');
const both = newUserSchema.safeParse({ ...base, services: ['tradelines', 'personal_cards'] });
check('a new account can be on both, in the usual order', both.success && both.data.services.join() === 'personal_cards,tradelines');
const tradeOnly = newUserSchema.safeParse({ ...base, services: ['tradelines'] });
check('or on tradelines alone', tradeOnly.success && tradeOnly.data.services.join() === 'tradelines');
check('but not on none', !newUserSchema.safeParse({ ...base, services: [] }).success);
check('nor on something that is not a service', !newUserSchema.safeParse({ ...base, services: ['mortgages'] }).success);
const patch = userPatchSchema.safeParse({ action: 'set-services', services: ['tradelines', 'tradelines'] });
check('an existing account can be changed', patch.success && patch.data.action === 'set-services' && patch.data.services.join() === 'tradelines');
check('but not to none', !userPatchSchema.safeParse({ action: 'set-services', services: [] }).success);
check('the other account actions are untouched', userPatchSchema.safeParse({ action: 'disable' }).success);

console.log('- the migration -');
const MIGRATION = join(__dirname, '..', 'supabase', 'migrations', '20261009120000_user_services.sql');
check('it exists under its name', existsSync(MIGRATION));
const sql = existsSync(MIGRATION) ? readFileSync(MIGRATION, 'utf8') : '';
const at = sql.indexOf('constraint users_services_check');
const allowed = at === -1 ? [] : [...(/array\[([^\]]*)\]/.exec(sql.slice(at, at + 400))?.[1] ?? '').matchAll(/'([^']*)'/g)].map((m) => m[1]!);
check('the database allows the same services, in the same order', allowed.join() === SERVICES.join(), allowed);
check('everybody already here starts on cards', /default array\['personal_cards'\]/.test(sql));
check('a list cannot be empty', /cardinality\(services\) >= 1/.test(sql));
check('it can be run twice', /add column if not exists services/.test(sql) && /drop constraint if exists users_services_check/.test(sql));

check('there was something to read', said.length >= 4, said.length);
check('no em or en dash anywhere', said.every((text) => !/[–—]/.test(text)));

console.log(`\nservices: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
