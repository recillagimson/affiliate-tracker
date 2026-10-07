// Adding somebody, rendered: the form is a dialog over the People page rather
// than a block that pushes the list down, and its fields sit in one column in
// the order somebody fills them in.
//
//   npx tsx --tsconfig scripts/render.tsconfig.json scripts/add-account-render-checks.tsx
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { UsersPanel } from '../src/components/UsersPanel';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) pass++;
  else {
    fail++;
    console.error('FAIL:', name, extra === undefined ? '' : extra);
  }
}

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} } as unknown as AppRouterInstance;
const html = renderToStaticMarkup(
  <AppRouterContext.Provider value={router}>
    <UsersPanel rows={[]} viewerId="a1" viewerUsername="gimson" />
  </AppRouterContext.Provider>,
);

const dialog = /<dialog[^>]*aria-label="Add someone"[\s\S]*?<\/dialog>/.exec(html)?.[0] ?? '';
check('adding somebody is a dialog', dialog !== '');
check('the form is inside it', dialog.includes('<form'));
check('the list is not inside it', !dialog.includes('<table'));
check('the button that opens it says what it does', html.includes('+ Add account') && !html.includes('Close form'));

const order = ['Username', 'Full name', 'Email', 'What they can see', 'What they are onboarded for', 'Create account'].map((text) => dialog.indexOf(text));
check('every part of the form is there', order.every((at) => at !== -1), order);
check('in the order somebody fills it in', order.every((at, i) => i === 0 || at > order[i - 1]!), order);
check('one column, with name and email as the only pair', !/<form[^>]*lg:grid-cols-2/.test(dialog) && dialog.includes('sm:grid-cols-2'));
check('the three roles are stacked the same way the services are', (dialog.match(/type="radio"/g) ?? []).length === 3 && (dialog.match(/type="checkbox"/g) ?? []).length === 2);
check('it can be backed out of from the bottom as well as the top', /Cancel<\/button>[\s\S]*Create account/.test(dialog));
check('a refusal is said inside the dialog, where the admin is looking', dialog.includes('data-form-error'));
check('no em or en dash in it', !/[–—]/.test(dialog));

console.log(`\nadd-account: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
