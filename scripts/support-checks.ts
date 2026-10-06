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
  checkAttachmentRefs,
  checkUploadRequest,
  fileKind,
  isSupportCategory,
  isSupportStatus,
  SUPPORT_STATUSES,
  isUnreadFor,
  MAX_ATTACHMENTS,
  MAX_FILE_BYTES,
  mayReadTicket,
  newUploadPath,
  sideFor,
  sizeText,
  statusFilterFrom,
  SUPPORT_CATEGORIES,
  supportHref,
  unreadCount,
  uploaderKey,
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
check('a resolved ticket says so, to both sides', waitingLabel(ticket({ status: 'resolved' }), 'admin') === heard('Resolved') && waitingLabel(ticket({ status: 'resolved' }), 'affiliate') === 'Resolved');
check('resolved is a status', isSupportStatus('resolved') && SUPPORT_STATUSES.join() === 'open,resolved,closed');
check('a resolved ticket does not count toward the admin badge', !countsTowardBadge(ticket({ status: 'resolved' }), 'admin'));
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
check('everything by default', statusFilterFrom(undefined) === 'all');
check('open when asked', statusFilterFrom('open') === 'open');
check('closed when asked', statusFilterFrom(' Closed ') === 'closed');
check('all when asked', statusFilterFrom('all') === 'all');
check('resolved when asked', statusFilterFrom('resolved') === 'resolved');
check('nonsense falls back to everything', statusFilterFrom('x') === 'all');
check('a category from the URL', categoryFilterFrom('bug') === 'bug');
check('nonsense is no category', categoryFilterFrom('x') === '' && categoryFilterFrom(undefined) === '');
check('the default view is the bare path', supportHref({ status: 'all', category: '', unread: false }) === '/support');
check('open is spelled out now that it is not the default', supportHref({ status: 'open', category: '', unread: false }) === '/support?status=open');
check(
  'everything else is spelled out',
  supportHref({ status: 'closed', category: 'bug', unread: true }) === '/support?status=closed&category=bug&unread=1',
);

console.log('- attachments -');
check('five files a message', MAX_ATTACHMENTS === 5);
check('fifty megabytes each', MAX_FILE_BYTES === 50 * 1024 * 1024);
check('a screenshot is an image', fileKind('image/png') === 'image' && fileKind('image/webp') === 'image');
check('a recording is a video', fileKind('video/mp4') === 'video' && fileKind('video/quicktime') === 'video' && fileKind('video/webm') === 'video');
check('a PDF is a document', fileKind('application/pdf') === 'document');
check('anything else is nothing', fileKind('text/html') === '' && fileKind('image/svg+xml') === '');
check('sizes read the way people say them', sizeText(900) === '900 B' && sizeText(2048) === '2 KB' && sizeText(5 * 1024 * 1024) === '5.0 MB');

function refusedUpload(input: unknown): string {
  const result = checkUploadRequest(input);
  if (result.ok) return '';
  heard(result.error);
  heard(result.hint);
  return result.error;
}
const asked = checkUploadRequest([
  { name: 'C:\\Users\\me\\My Screen Shot (1).png', type: 'image/png', size: 2000 },
  { name: 'clip.mov', type: 'video/quicktime', size: 40_000_000 },
]);
check('two good files are accepted', asked.ok && asked.files.length === 2);
check('a path is cut down to the file name', asked.ok && asked.files[0]!.name === 'My Screen Shot (1).png');
check('nothing to upload is refused', refusedUpload([]) !== '' && refusedUpload(undefined) !== '');
check('six is one too many', refusedUpload(Array.from({ length: 6 }, () => ({ name: 'a.png', type: 'image/png', size: 10 }))) !== '');
check('a web page is not an attachment', refusedUpload([{ name: 'a.html', type: 'text/html', size: 10 }]) !== '');
check('an SVG is refused', refusedUpload([{ name: 'a.svg', type: 'image/svg+xml', size: 10 }]) !== '');
check('a file with no type is refused', refusedUpload([{ name: 'a.mov', type: '', size: 10 }]) !== '');
check('one byte over the limit is refused', refusedUpload([{ name: 'a.mp4', type: 'video/mp4', size: MAX_FILE_BYTES + 1 }]) !== '');
check('exactly the limit is kept', checkUploadRequest([{ name: 'a.mp4', type: 'video/mp4', size: MAX_FILE_BYTES }]).ok);
check('an empty file is refused', refusedUpload([{ name: 'a.png', type: 'image/png', size: 0 }]) !== '');
check('a size that is not a number is refused', refusedUpload([{ name: 'a.png', type: 'image/png', size: '10' }]) !== '');
check('an entry that is not an object is refused', refusedUpload([null]) !== '');

const UUID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
check('an account id is its own folder', uploaderKey('u1') === 'u1');
check('the env admin\'s id is made safe for a path', uploaderKey('env:admin') === 'env_admin');
check('a blank id has no folder', uploaderKey('') === '');
const path = newUploadPath('u1', UUID, 'My Screen Shot (1).png');
check('a path is the folder, a unique part and a safe name', path === `u1/${UUID}/My_Screen_Shot__1_.png`, path);
check('a name with nothing safe in it still has one', newUploadPath('u1', UUID, '\u00e9\u00e9').endsWith('/__'));
check('a path cannot climb out of its folder', !newUploadPath('u1', UUID, '../../x.png').includes('..'), newUploadPath('u1', UUID, '../../x.png'));

function refusedRefs(input: unknown, key = 'u1'): string {
  const result = checkAttachmentRefs(input, key);
  if (result.ok) return '';
  heard(result.error);
  heard(result.hint);
  return result.error;
}
const noRefs = checkAttachmentRefs(undefined, 'u1');
check('no attachments is fine', noRefs.ok && noRefs.refs.length === 0);
const refs = checkAttachmentRefs([{ path, name: 'My Screen Shot (1).png' }], 'u1');
check('a path this person uploaded is accepted', refs.ok && refs.refs[0]!.path === path);
check('and keeps the name they gave it', refs.ok && refs.refs[0]!.name === 'My Screen Shot (1).png');
check('somebody else\'s upload is refused', refusedRefs([{ path, name: 'a.png' }], 'u2') !== '');
check('a blank folder matches nothing', refusedRefs([{ path, name: 'a.png' }], '') !== '');
check('a path that climbs is refused', refusedRefs([{ path: `u1/${UUID}/../../u2/x.png`, name: 'a.png' }]) !== '');
check('a path with no unique part is refused', refusedRefs([{ path: 'u1/x.png', name: 'a.png' }]) !== '');
check('the same file twice is refused', refusedRefs([{ path, name: 'a.png' }, { path, name: 'a.png' }]) !== '');
check('six is one too many here too', refusedRefs(Array.from({ length: 6 }, (_, n) => ({ path: `u1/${UUID.slice(0, -1)}${n}/a.png`, name: 'a.png' }))) !== '');
check('something that is not a list is refused', refusedRefs('x') !== '');

check('there was something to read', said.length > 12, said.length);
check('no em or en dash anywhere', said.every((text) => !/[\u2013\u2014]/.test(text)), said.filter((t) => /[\u2013\u2014]/.test(t)));

console.log(`\nsupport: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
