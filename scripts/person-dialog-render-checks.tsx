// A person's account, opened from the People list: the dialog that shows who
// they are and lets an admin change their name, email, role and services.
//
//   npx tsx --tsconfig scripts/render.tsconfig.json scripts/person-dialog-render-checks.tsx
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { IssuedPassword, PersonDialog } from '../src/components/PersonDialog';
import type { AccountRow } from '../src/components/UsersPanel';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) pass++;
  else {
    fail++;
    console.error('FAIL:', name, extra === undefined ? '' : extra);
  }
}

const rendered: string[] = [];
const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} } as unknown as AppRouterInstance;
function render(node: ReactNode): string {
  const html = renderToStaticMarkup(<AppRouterContext.Provider value={router}>{node}</AppRouterContext.Provider>);
  rendered.push(html);
  return html;
}
function input(html: string, name: string): string {
  return new RegExp(`<input[^>]*name="${name}"[^>]*>`).exec(html)?.[0] ?? '';
}
function box(html: string, value: string): string {
  return new RegExp(`<input[^>]*value="${value}"[^>]*>`).exec(html)?.[0] ?? '';
}

const maria: AccountRow = {
  id: 'u1',
  username: 'maria',
  role: 'affiliate',
  lgfEmployee: false,
  services: ['personal_cards', 'tradelines'],
  usr: 'ab12cd',
  fullName: 'Maria Santos',
  email: 'maria@example.com',
  active: true,
  createdAt: '2026-09-01T10:00:00.000Z',
  lastLoginAt: '2026-10-05T08:30:00.000Z',
  createdBy: 'gimson',
  setup: null,
  approval: null,
  bypass: null,
};

console.log('- an affiliate -');
const html = render(<PersonDialog row={maria} viewerId="a1" onClose={() => {}} />);
check('it is a dialog named for the person', /<dialog[^>]*aria-label="Maria Santos"/.test(html));
check('it says who they are', html.includes('maria') && html.includes('usr=ab12cd'));
check('their name is there to edit', input(html, 'fullName').includes('value="Maria Santos"'));
check('and their email', input(html, 'email').includes('value="maria@example.com"'));
check('their role is the one ticked', box(html, 'affiliate').includes('checked') && !box(html, 'admin').includes('checked'));
check('their services are ticked', box(html, 'personal_cards').includes('checked') && box(html, 'tradelines').includes('checked'));
const order = ['Full name', 'Email', 'What they can see', 'What they are onboarded for', 'Save changes'].map((text) => html.indexOf(text));
check('laid out in the same order as adding somebody', order.every((at, i) => at !== -1 && (i === 0 || at > order[i - 1]!)), order);
check('name and email are the one pair', html.includes('sm:grid-cols-2'));
check('nothing to save until something changes', /<button[^>]*disabled[^>]*>(<[^>]+>)*Save changes/.test(html) || /disabled=""[^>]*>[^<]*Save changes/.test(html), html.slice(html.indexOf('Save changes') - 200, html.indexOf('Save changes')));
check('the paperwork is one click away', html.includes('href="/users/u1"') && html.includes('Open full record'));

console.log('- their password -');
check('a password can be reset from here', /<button[^>]*>(<[^>]+>)*Reset password/.test(html));
check('it says what resetting does before it is pressed', html.includes('signed out'));
check('it sits above the buttons that save and close', html.indexOf('Reset password') < html.indexOf('Open full record'));
check('no password is on show until one is issued', !html.includes('data-issued-password'));
const issued = render(<IssuedPassword username="maria" password="Xk3!vTq9-mNp2#Lw" />);
check('a new password is shown in full', issued.includes('Xk3!vTq9-mNp2#Lw'));
check('for the person it belongs to', issued.includes('maria'));
check('with a way to copy it', /<button[^>]*>(<[^>]+>)*Copy/.test(issued));
check('and a warning that it is shown once', issued.includes('once'));

console.log('- an admin -');
const admin = render(<PersonDialog row={{ ...maria, id: 'a2', role: 'admin', usr: '', services: undefined }} viewerId="a1" onClose={() => {}} />);
check('an admin is not offered services', !admin.includes('What they are onboarded for'));
check('and starts as an admin', box(admin, 'admin').includes('checked'));

console.log('- yourself -');
const self = render(<PersonDialog row={{ ...maria, id: 'a1', role: 'admin', usr: '', services: undefined }} viewerId="a1" onClose={() => {}} />);
check('your own role cannot be changed', box(self, 'admin').includes('disabled') && box(self, 'affiliate').includes('disabled'));
check('and it says why', self.includes('Another admin can change your role'));
check('but your own name still can', !input(self, 'fullName').includes('disabled'));

console.log('- somebody with nothing on file -');
const bare = render(<PersonDialog row={{ ...maria, fullName: '', email: '', lastLoginAt: null }} viewerId="a1" onClose={() => {}} />);
check('the dialog falls back to their username', /<dialog[^>]*aria-label="maria"/.test(bare));
check('and says they have never signed in', bare.includes('Never signed in'));

check('no em or en dash anywhere', rendered.every((text) => !/[–—]/.test(text)));

console.log(`\nperson-dialog: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
