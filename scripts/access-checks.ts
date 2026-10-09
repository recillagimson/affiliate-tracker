// What an affiliate may open, from what they are onboarded for.
//
// Personal Cards and Tradelines are two different jobs, and somebody signed up
// for one is not shown the other. The tabs, the pages and the routes all ask
// the same two functions, so what is pinned here is the rule itself: an admin
// opens everything, an affiliate opens only what they are on, and somebody
// whose services cannot be read is treated as cards only, never as tradelines.
//
//   npx tsx scripts/access-checks.ts

import { canOpenService, homeFor } from '../src/lib/access';
import { normalizeServices, SERVICES } from '../src/lib/services';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) pass++;
  else {
    fail++;
    console.error('FAIL:', name, extra === undefined ? '' : extra);
  }
}

console.log('- an admin -');
check('opens the card pages', canOpenService('admin', [], 'personal_cards'));
check('and tradelines', canOpenService('admin', [], 'tradelines'));
check('whatever their own list says', SERVICES.every((service) => canOpenService('admin', ['personal_cards'], service)));
check('and starts on the overview', homeFor('admin', []) === '/');

console.log('- an affiliate on personal cards -');
check('opens the card pages', canOpenService('affiliate', ['personal_cards'], 'personal_cards'));
check('and not tradelines', !canOpenService('affiliate', ['personal_cards'], 'tradelines'));
check('and starts on the overview', homeFor('affiliate', ['personal_cards']) === '/');

console.log('- an affiliate on tradelines -');
check('opens tradelines', canOpenService('affiliate', ['tradelines'], 'tradelines'));
check('and not the card pages', !canOpenService('affiliate', ['tradelines'], 'personal_cards'));
check('and starts on tradelines, the overview being a card page', homeFor('affiliate', ['tradelines']) === '/tradelines');

console.log('- an affiliate on both -');
check('opens both', SERVICES.every((service) => canOpenService('affiliate', ['personal_cards', 'tradelines'], service)));
check('and starts on the overview', homeFor('affiliate', ['tradelines', 'personal_cards']) === '/');

console.log('- services that cannot be read -');
const unread = normalizeServices(undefined);
check('are cards, so nobody is locked out of what they had', canOpenService('affiliate', unread, 'personal_cards'));
check('and never tradelines', !canOpenService('affiliate', unread, 'tradelines'));
check('an empty list opens nothing by itself', !canOpenService('affiliate', [], 'personal_cards') && !canOpenService('affiliate', [], 'tradelines'));
check('and still has somewhere to go', homeFor('affiliate', []) === '/tradelines' || homeFor('affiliate', []) === '/');

console.log(`\naccess: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
