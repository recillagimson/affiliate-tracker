// Support tickets, as arithmetic: who may read one, when it counts as unread,
// what the list says about it, and what an attached image has to be.
//
// The unread rule is the one worth pinning hardest. It decides the badge both
// sides rely on to notice a reply, and it is a comparison of two timestamps
// and a role, which is exactly the kind of thing that is right in three cases
// and wrong in the fourth.
//
//   npx tsx scripts/support-checks.ts

import {
  badgeText,
  countsTowardBadge,
  buildSupportRows,
  CATEGORY_LABELS,
  categoryFilterFrom,
  checkSupportAttachments,
  isSupportCategory,
  isUnreadFor,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  mayReadTicket,
  sideFor,
  statusFilterFrom,
  SUPPORT_CATEGORIES,
  supportHref,
  unreadCount,
  waitingLabel,
  type SupportTicket,
} from '../src/lib/support';

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
function heard<T extends string>(text: T): T {
  said.push(text);
  return text;
}

function ticket(patch: Partial<SupportTicket> = {}): SupportTicket {
  return {
    id: '7',
    userId: 'u1',
    subject: 'Where is my payout?',
    category: 'payout',
    status: 'open',
    openedBy: 'maria',
    openedByRole: 'affiliate',
    createdAt: '2026-10-01T10:00:00.000Z',
    lastMessageAt: '2026-10-01T10:00:00.000Z',
    lastMessageRole: 'affiliate',
    affiliateReadAt: '2026-10-01T10:00:00.000Z',
    adminReadAt: null,
    closedAt: null,
    closedBy: '',
    ...patch,
  };
}

console.log('- sides and access -');
check('an admin is on the admin side', sideFor({ role: 'admin' }) === 'admin');
check('an affiliate is on the affiliate side', sideFor({ role: 'affiliate' }) === 'affiliate');
check('an admin may read any ticket', mayReadTicket({ role: 'admin', id: 'a1' }, 'u1'));
check('the env admin too', mayReadTicket({ role: 'admin', id: 'env:admin' }, 'u1'));
check('an affiliate may read their own', mayReadTicket({ role: 'affiliate', id: 'u1' }, 'u1'));
check('and nobody else\'s', !mayReadTicket({ role: 'affiliate', id: 'u2' }, 'u1'));
check('a blank id matches nobody, even a blank owner', !mayReadTicket({ role: 'affiliate', id: '' }, ''));

console.log('- unread -');
check('an affiliate\'s own new ticket is not unread for them', !isUnreadFor(ticket(), 'affiliate'));
check('but it is unread for admins who have never opened it', isUnreadFor(ticket(), 'admin'));
check(
  'once an admin has read it, it is not',
  !isUnreadFor(ticket({ adminReadAt: '2026-10-01T10:05:00.000Z' }), 'admin'),
);
check(
  'an admin read before the affiliate\'s latest message does not count',
  isUnreadFor(
    ticket({ adminReadAt: '2026-10-01T10:05:00.000Z', lastMessageAt: '2026-10-01T11:00:00.000Z' }),
    'admin',
  ),
);
const replied = ticket({
  lastMessageRole: 'admin',
  lastMessageAt: '2026-10-01T12:00:00.000Z',
  adminReadAt: '2026-10-01T12:00:00.000Z',
});
check('an admin reply is unread for the affiliate', isUnreadFor(replied, 'affiliate'));
check('and not for admins', !isUnreadFor(replied, 'admin'));
check(
  'reading it at the same instant it was written counts as read',
  !isUnreadFor({ ...replied, affiliateReadAt: '2026-10-01T12:00:00.000Z' }, 'affiliate'),
);
check(
  'an admin-opened ticket the affiliate has never seen is unread for them',
  isUnreadFor(ticket({ openedByRole: 'admin', lastMessageRole: 'admin', affiliateReadAt: null }), 'affiliate'),
);
check(
  'a timestamp that cannot be read is treated as never read',
  isUnreadFor({ ...replied, affiliateReadAt: 'nonsense' }, 'affiliate'),
);
check('counting', unreadCount([ticket(), replied, ticket({ id: '9' })], 'admin') === 2);
check('counting nothing', unreadCount([], 'affiliate') === 0);

console.log('- what the badge counts -');
const thanked = ticket({ status: 'closed', closedAt: '2026-10-01T10:01:00.000Z' });
check('an open unread ticket counts for admins', countsTowardBadge(ticket(), 'admin'));
check('one the affiliate closed behind their last message does not: the admin list opens on Open and would show nothing', !countsTowardBadge(thanked, 'admin'));
check('a closed ticket with an unread reply still counts for the affiliate, whose list shows everything', countsTowardBadge({ ...replied, status: 'closed' }, 'affiliate'));
check('a read ticket counts for nobody', !countsTowardBadge(ticket(), 'affiliate'));

console.log('- what the list says -');
check('waiting on support, for both sides', waitingLabel(ticket(), 'admin') === heard('Waiting on support'));
check('and the affiliate reads the same', waitingLabel(ticket(), 'affiliate') === 'Waiting on support');
check('an admin sees who they are waiting on', waitingLabel(replied, 'admin') === heard('Waiting on affiliate'));
check('the affiliate is told it is them', waitingLabel(replied, 'affiliate') === heard('Waiting on you'));
check('a closed ticket is just closed', waitingLabel(ticket({ status: 'closed' }), 'admin') === heard('Closed'));
check('no badge text for nothing', badgeText(0) === '');
check('a count as itself', badgeText(3) === '3');
check('capped', badgeText(140) === '99+');
check('a negative or broken count shows nothing', badgeText(-1) === '' && badgeText(Number.NaN) === '');

const rows = buildSupportRows(
  [ticket(), replied],
  'admin',
  new Map([['u1', 'Maria Santos']]),
);
check('one row per ticket, in the order given', rows.map((r) => r.id).join() === '7,7');
check('the category is labelled', rows[0]!.category === CATEGORY_LABELS.payout);
check('the person is named', rows[0]!.person === 'Maria Santos');
check('unread carries through', rows[0]!.unread && !rows[1]!.unread);
check(
  'an account that is gone still gets a row',
  buildSupportRows([ticket({ userId: 'gone' })], 'admin', new Map())[0]!.person === heard('Unknown account'),
);
for (const label of Object.values(CATEGORY_LABELS)) heard(label);
check('every category has a label', SUPPORT_CATEGORIES.every((c) => CATEGORY_LABELS[c].length > 0));
check('a category is recognised', isSupportCategory('bug') && !isSupportCategory('Bug') && !isSupportCategory(3));

console.log('- filters -');
check('open by default', statusFilterFrom(undefined) === 'open');
check('closed when asked', statusFilterFrom(' Closed ') === 'closed');
check('all when asked', statusFilterFrom('all') === 'all');
check('nonsense falls back to open', statusFilterFrom('x') === 'open');
check('a category from the URL', categoryFilterFrom('bug') === 'bug');
check('nonsense is no category', categoryFilterFrom('x') === '' && categoryFilterFrom(undefined) === '');
check('the default view is the bare path', supportHref({ status: 'open', category: '', unread: false }) === '/support');
check(
  'everything else is spelled out',
  supportHref({ status: 'closed', category: 'bug', unread: true }) === '/support?status=closed&category=bug&unread=1',
);

console.log('- attachments -');
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
function image(type: string, head: number[], size: number, name = 'shot.png') {
  const bytes = Buffer.concat([Buffer.from(head), Buffer.alloc(Math.max(0, size - head.length))]);
  return { name, type, data: `data:${type};base64,${bytes.toString('base64')}` };
}
const none = checkSupportAttachments(undefined);
check('no attachments is fine', none.ok && none.files.length === 0);
check('null too', checkSupportAttachments(null).ok);
const good = checkSupportAttachments([image('image/png', PNG, 2000)]);
check('a real PNG is kept', good.ok && good.files.length === 1);
check('with its exact size', good.ok && good.files[0]!.size === 2000);
check('and stored as bare base64', good.ok && !good.files[0]!.data.startsWith('data:'));
check('its name is kept', good.ok && good.files[0]!.name === 'shot.png');
const pathy = checkSupportAttachments([image('image/png', PNG, 2000, 'C:\\Users\\me\\shot.png')]);
check('a path is cut down to the file name', pathy.ok && pathy.files[0]!.name === 'shot.png');
const nameless = checkSupportAttachments([{ ...image('image/png', PNG, 2000), name: undefined }]);
check('a missing name becomes a plain one', nameless.ok && nameless.files[0]!.name === 'image');
const jpeg = checkSupportAttachments([image('image/jpeg', [0xff, 0xd8, 0xff, 0xe0], 500)]);
check('a JPEG is kept', jpeg.ok);
function refused(input: unknown): string {
  const result = checkSupportAttachments(input);
  if (result.ok) return '';
  heard(result.error);
  heard(result.hint);
  return result.error;
}
check('something that is not a list is refused', refused('x') !== '');
check('four is one too many', refused(Array.from({ length: MAX_ATTACHMENTS + 1 }, () => image('image/png', PNG, 100))) !== '');
check('a PDF is not an image', refused([image('application/pdf', [0x25, 0x50, 0x44, 0x46, 0x2d], 500)]) !== '');
check('an SVG is refused', refused([image('image/svg+xml', [0x3c, 0x73, 0x76, 0x67], 500)]) !== '');
check('a text file renamed to PNG is refused', refused([image('image/png', [0x68, 0x65, 0x6c, 0x6c, 0x6f], 500)]) !== '');
check('a PNG declared as JPEG is refused', refused([image('image/jpeg', PNG, 500)]) !== '');
check('a missing payload is refused', refused([{ name: 'a.png', type: 'image/png', data: 'data:image/png;base64,' }]) !== '');
check('junk in the base64 is refused', refused([{ name: 'a.png', type: 'image/png', data: 'data:image/png;base64,iVBORw0KGgo!!!!' }]) !== '');
check('an entry that is not an object is refused', refused([null]) !== '');
check('one image over the limit is refused', refused([image('image/png', PNG, MAX_ATTACHMENT_BYTES + 1)]) !== '');
check(
  'three that are over it together are refused',
  refused([
    image('image/png', PNG, 1_200_000),
    image('image/png', PNG, 1_200_000),
    image('image/png', PNG, 1_200_000),
  ]) !== '',
);
const full = checkSupportAttachments([
  image('image/png', PNG, 1_000_000),
  image('image/png', PNG, 1_000_000),
  image('image/png', PNG, 1_000_000),
]);
check('three that add up to exactly the limit are kept', full.ok && full.files.length === 3);
// Review focus 4: the largest body this accepts has to fit under the host's
// 4.5 MB request limit with room for the text and the JSON around it.
const largestBody = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 5_000 * 4 + 2_000;
check('the largest accepted message fits a 4.5 MB request', largestBody < 4_500_000, largestBody);

check('there was something to read', said.length > 12, said.length);
check('no em or en dash anywhere', said.every((text) => !/[\u2013\u2014]/.test(text)), said.filter((t) => /[\u2013\u2014]/.test(t)));

console.log(`\nsupport: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
