// The Support tab and its badge, rendered.
//
// The badge is the only way either side learns there is something to read
// without opening the page, so what is pinned is that it appears on the right
// tab, for both roles, on both the desktop tabs and the phone bar, and that
// zero draws nothing at all rather than an empty circle.
//
//   npx tsx --tsconfig scripts/render.tsconfig.json scripts/support-nav-render-checks.tsx
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { MobileTabs, Nav, visibleItems } from '../src/components/Nav';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) pass++;
  else {
    fail++;
    console.error('FAIL:', name, extra === undefined ? '' : extra);
  }
}

function at(pathname: string, node: ReactNode): string {
  return renderToStaticMarkup(<PathnameContext.Provider value={pathname}>{node}</PathnameContext.Provider>);
}

console.log('- the tab -');
check('an affiliate has a Support tab', visibleItems(false).some((item) => item.href === '/support'));
check('an admin too', visibleItems(true).some((item) => item.href === '/support'));
check('it is labelled Support', visibleItems(true).find((item) => item.href === '/support')?.label === 'Support');

console.log('- the badge -');
for (const [name, isAdmin] of [['affiliate', false], ['admin', true]] as const) {
  const quiet = at('/', <Nav isAdmin={isAdmin} supportUnread={0} />);
  check(`${name}: nothing unread draws no badge`, !quiet.includes('data-support-unread'));
  const loud = at('/', <Nav isAdmin={isAdmin} supportUnread={3} />);
  check(`${name}: three unread draws a 3`, /data-support-unread="3"[^>]*>3</.test(loud), loud);
  check(`${name}: and says so to a screen reader`, loud.includes('3 unread'));
  const phone = at('/', <MobileTabs isAdmin={isAdmin} supportUnread={3} />);
  check(`${name}: the phone bar has it too`, /data-support-unread="3"[^>]*>3</.test(phone));
  check(`${name}: exactly one badge per bar`, loud.split('data-support-unread').length === 2 && phone.split('data-support-unread').length === 2);
}
check('a large count is capped', at('/', <Nav isAdmin supportUnread={250} />).includes('>99+<'));
check('the prop is optional', !at('/', <Nav isAdmin />).includes('data-support-unread'));

console.log('- where you are -');
const onList = at('/support', <Nav isAdmin={false} />);
check('the tab is current on the list', /href="\/support"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/support"/.test(onList));
const onThread = at('/support/12', <Nav isAdmin={false} />);
check('and on a conversation', /href="\/support"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/support"/.test(onThread));
const elsewhere = at('/links', <Nav isAdmin={false} />);
check('and not anywhere else', !/href="\/support"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/support"/.test(elsewhere));
check('the Create tab still owns /links/new', /href="\/links\/new"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/links\/new"/.test(at('/links/new', <Nav isAdmin={false} />)));

console.log(`\nsupport-nav: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
