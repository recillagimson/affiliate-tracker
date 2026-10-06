// The support pages, rendered rather than reasoned about.
//
// support-checks pins what the pages are handed; this pins what they draw from
// it, which is where a wiring mistake hides: an unread ticket with no mark on
// it, an affiliate shown somebody's name column, a closed ticket still
// offering Close, a message body that reaches the page as markup.
//
// The components call useRouter, which throws outside a Next request, so the
// router's own context is provided with a stand-in and the real components
// mount.
//
//   npx tsx --tsconfig scripts/render.tsconfig.json scripts/support-render-checks.tsx
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { NewTicket } from '../src/components/NewTicket';
import { SupportList } from '../src/components/SupportList';
import { SupportMessages, SupportThread } from '../src/components/SupportThread';
import { addPicked, checkPicked, failureText, openedNotice } from '../src/lib/support-client';
import { AttachmentPicker } from '../src/components/AttachmentPicker';
import { MAX_FILE_BYTES, type SupportMessage, type SupportRow } from '../src/lib/support';

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
const router = {
  push() {},
  replace() {},
  refresh() {},
  back() {},
  forward() {},
  prefetch() {},
} as unknown as AppRouterInstance;
function render(node: ReactNode): string {
  const html = renderToStaticMarkup(<AppRouterContext.Provider value={router}>{node}</AppRouterContext.Provider>);
  rendered.push(html);
  return html;
}

const rows: SupportRow[] = [
  { id: '12', subject: 'Where is my payout?', category: 'Payout issue', status: 'open', waiting: 'Waiting on support', unread: true, lastAt: '2026-10-01T10:00:00.000Z', person: 'Maria Santos' },
  { id: '9', subject: 'Thanks', category: 'Feedback', status: 'closed', waiting: 'Closed', unread: false, lastAt: '2026-09-20T10:00:00.000Z', person: 'Jon Reyes' },
];

console.log('- the list -');
const adminList = render(<SupportList rows={rows} admin />);
check('each ticket links to its conversation', adminList.includes('href="/support/12"') && adminList.includes('href="/support/9"'));
check('the subject is shown', adminList.includes('Where is my payout?'));
check('the category is shown', adminList.includes('Payout issue'));
check('whose move it is is shown', adminList.includes('Waiting on support'));
check('an admin sees whose ticket it is', adminList.includes('Maria Santos'));
check('exactly one ticket is marked unread', adminList.split('data-unread="true"').length === 2);
const mineList = render(<SupportList rows={rows} admin={false} />);
check('an affiliate is not shown a name column', !mineList.includes('Maria Santos') && !mineList.includes('Jon Reyes'));
const emptyAdmin = render(<SupportList rows={[]} admin />);
check('an empty admin list says so', emptyAdmin.includes('No tickets'));
const emptyMine = render(<SupportList rows={[]} admin={false} />);
check('an empty affiliate list invites a first one', emptyMine.includes('New ticket') || emptyMine.includes('new ticket'));

console.log('- a new ticket -');
const mineForm = render(<NewTicket people={null} filer="Maria Santos" />);
check('there is a button to open one', mineForm.includes('New ticket'));
check('an affiliate is not asked who it is for', !mineForm.includes('name="userId"'));
check('all four categories are offered', ['Question', 'Payout issue', 'Bug', 'Feedback'].every((label) => mineForm.includes(label)));
check('it says who is filing it', mineForm.includes('Filing as') && mineForm.includes('Maria Santos'));
check('images, video and PDF can be attached', mineForm.includes('image/png,image/jpeg,image/webp,video/mp4,video/quicktime,video/webm,application/pdf'));
const adminForm = render(<NewTicket people={[{ id: 'u1', name: 'Maria Santos' }]} filer={null} />);
check('an admin chooses who it is for', adminForm.includes('name="userId"') && adminForm.includes('Maria Santos'));

check('an admin is not told they are filing as anybody', !adminForm.includes('Filing as'));

console.log('- attaching files -');
const emptyPicker = render(<AttachmentPicker files={[]} onChange={() => {}} />);
check('it invites a drop, a paste or a browse', emptyPicker.includes('Drag files here') && emptyPicker.includes('paste') && emptyPicker.includes('Browse'));
check('it says what can be attached', emptyPicker.includes('50 MB') && emptyPicker.includes('5 files'));
const shot = new File([new Uint8Array(2048)], 'shot.png', { type: 'image/png' });
const clip = new File([new Uint8Array(3 * 1024 * 1024)], 'clip.mp4', { type: 'video/mp4' });
const fullPicker = render(<AttachmentPicker files={[shot, clip]} onChange={() => {}} progress={[100, 40]} />);
check('each chosen file is listed by name', fullPicker.includes('shot.png') && fullPicker.includes('clip.mp4'));
check('with its size', fullPicker.includes('2 KB') && fullPicker.includes('3.0 MB'));
check('and a way to take it off', fullPicker.split('Remove ').length === 3);
check('how many are chosen is counted', fullPicker.includes('2 of 5'));
check('an upload under way shows how far it is', fullPicker.includes('aria-valuenow="40"'));
const busyPicker = render(<AttachmentPicker files={[shot]} onChange={() => {}} disabled />);
check('nothing can be removed while it is sending', !busyPicker.includes('Remove '));

console.log('- a conversation -');
const messages: SupportMessage[] = [
  { id: '1', authorRole: 'affiliate', authorId: 'u1', authorName: 'maria', body: 'It is late.\nPlease check.', createdAt: '2026-10-01T10:00:00.000Z', attachments: [{ id: '5', name: 'shot.png', type: 'image/png', size: 2000 }] },
  { id: '2', authorRole: 'admin', authorId: 'a1', authorName: 'gimson', body: '<script>alert(1)</script>', createdAt: '2026-10-01T11:00:00.000Z', attachments: [{ id: '6', name: 'clip.mp4', type: 'video/mp4', size: 3_000_000 }, { id: '7', name: 'statement.pdf', type: 'application/pdf', size: 90_000 }] },
];
const talk = render(<SupportMessages messages={messages} side="affiliate" />);
check('both messages are there', talk.includes('It is late.') && talk.includes('alert(1)'));
check('who wrote each is shown', talk.includes('maria') && talk.includes('gimson'));
check('a message body never reaches the page as markup', !talk.includes('<script>'));
check('line breaks are kept', talk.includes('whitespace-pre-wrap'));
check('an image opens through the signed-in route', talk.includes('/api/support/attachments/5'));
check('an image is drawn', /<img[^>]*\/api\/support\/attachments\/5/.test(talk));
check('a video is played, not drawn', /<video[^>]*controls/.test(talk) && talk.includes('/api/support/attachments/6'));
check('a video does not load until it is played', talk.includes('preload="metadata"'));
check('a PDF is a named link', />[^<]*statement\.pdf/.test(talk) && talk.includes('/api/support/attachments/7'));
check('the affiliate\'s own message is marked as theirs', /data-mine="true"[\s\S]*It is late/.test(talk));
check('support is named as support to an affiliate', talk.includes('Support'));

const open = render(
  <SupportThread ticket={{ id: '12', subject: 'Where is my payout?', category: 'Payout issue', status: 'open' }} messages={messages} side="affiliate" markRead />,
);
check('an open ticket can be replied to', open.includes('Send reply'));
check('and closed', open.includes('Close ticket'));
check('and not reopened', !open.includes('Reopen ticket'));
const closed = render(
  <SupportThread ticket={{ id: '12', subject: 'Where is my payout?', category: 'Payout issue', status: 'closed' }} messages={messages} side="admin" markRead={false} />,
);
check('a closed ticket can be reopened', closed.includes('Reopen ticket'));
check('and not closed again', !closed.includes('Close ticket'));
check('and still replied to, which reopens it', closed.includes('Send reply') && closed.includes('reopen'));

console.log('- before it is sent -');
check('no files is fine', checkPicked([]) === '');
check('images, a video and a PDF are fine', checkPicked([{ size: 10, type: 'image/png' }, { size: 10, type: 'video/mp4' }, { size: 10, type: 'application/pdf' }]) === '');
check('six is refused', checkPicked(Array.from({ length: 6 }, () => ({ size: 10, type: 'image/png' }))) !== '');
check('a spreadsheet is refused', checkPicked([{ size: 10, type: 'text/csv' }]) !== '');
check('a file the browser cannot name the type of is refused', checkPicked([{ size: 10, type: '' }]) !== '');
check('a file over the limit is refused', checkPicked([{ size: MAX_FILE_BYTES + 1, type: 'video/mp4' }]) !== '');
check('one at the limit is fine', checkPicked([{ size: MAX_FILE_BYTES, type: 'video/mp4' }]) === '');
check('adding keeps what was there and drops exact repeats', addPicked([shot], [shot, clip]).length === 2);
// Review focus 4: a body the host refuses arrives as a sentence.
check('a 413 from the host is explained', failureText(413, {}).includes('too large'));
check('a refusal says what the route said', failureText(400, { error: 'Write a message first.' }) === 'Write a message first.');
check('with its hint', failureText(409, { error: 'That ticket is already closed.', hint: 'Reload the page to see it.' }) === 'That ticket is already closed. Reload the page to see it.');
check('anything else names the status', failureText(500, {}).includes('500'));

console.log('- after a ticket is opened -');
check('an affiliate\'s own ticket has nothing to add', openedNotice({ ok: true, ticketId: '12' }) === '');
check('an emailed one has nothing to add either', openedNotice({ emailed: true }) === '');
check('one that could not be emailed says so, and why', openedNotice({ emailed: false, emailProblem: 'They have no email address on file, so no email was sent.' }) === 'Ticket opened. No email went: They have no email address on file, so no email was sent.');
check('even when no reason came back', openedNotice({ emailed: false }) === 'Ticket opened. No email went.');

console.log('- house rules -');
check('there was something to read', rendered.length > 8, rendered.length);
check('no em or en dash anywhere', rendered.every((html) => !/[\u2013\u2014]/.test(html)));

console.log(`\nsupport-render: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
