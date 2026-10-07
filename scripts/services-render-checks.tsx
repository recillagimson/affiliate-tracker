// The services control on a person's page, rendered.
//
// Two checkboxes and a Save are easy to get subtly wrong: a box that does not
// start from what is on file, a Save offered when nothing changed, a Save that
// can send an empty list. Each state is rendered directly through the
// stateless view rather than clicked towards.
//
//   npx tsx --tsconfig scripts/render.tsconfig.json scripts/services-render-checks.tsx
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { ServiceBoxes, ServiceChips, ServicesSelect } from '../src/components/ServicesSelect';

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
/** The <input> for one service, as markup. */
function box(html: string, service: string): string {
  return new RegExp(`<input[^>]*value="${service}"[^>]*>`).exec(html)?.[0] ?? '';
}

console.log('- the boxes -');
const cards = render(<ServiceBoxes value={['personal_cards']} onChange={() => {}} />);
check('both services are offered by name', cards.includes('Personal Cards') && cards.includes('Tradelines'));
check('what is on file is ticked', box(cards, 'personal_cards').includes('checked'));
check('and what is not, is not', !box(cards, 'tradelines').includes('checked'));
const both = render(<ServiceBoxes value={['personal_cards', 'tradelines']} onChange={() => {}} />);
check('both can be ticked', box(both, 'personal_cards').includes('checked') && box(both, 'tradelines').includes('checked'));
const locked = render(<ServiceBoxes value={['tradelines']} onChange={() => {}} disabled />);
check('nothing can be changed while it is saving', box(locked, 'personal_cards').includes('disabled') && box(locked, 'tradelines').includes('disabled'));

console.log('- on a person\'s page -');
const page = render(<ServicesSelect userId="u1" current={['personal_cards']} />);
check('it starts from what is on file', box(page, 'personal_cards').includes('checked') && !box(page, 'tradelines').includes('checked'));
check('there is nothing to save until something changes', !page.includes('Save services'));

console.log('- as labels -');
const chips = render(<ServiceChips services={['tradelines', 'personal_cards']} />);
check('each service is its own label, cards first', chips.indexOf('Personal Cards') !== -1 && chips.indexOf('Personal Cards') < chips.indexOf('Tradelines'));
check('tradelines stands out from cards', /chip-gold[^>]*>Tradelines/.test(chips) && /chip-quiet[^>]*>Personal Cards/.test(chips));

check('no em or en dash anywhere', rendered.every((html) => !/[–—]/.test(html)));

console.log(`\nservices-render: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
