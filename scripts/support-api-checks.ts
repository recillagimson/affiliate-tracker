// What the support routes decide, as plain functions: is this body readable,
// whose ticket is it, and what does a refusal say.
//
// Nothing in this repo can run a route handler under test, so every decision
// the route makes is made here and pinned here. The two that matter most are
// who a ticket is opened for (never the body's word when the sender is an
// affiliate) and whether opening a thread marks it read (never, from Client
// View).
//
//   npx tsx scripts/support-api-checks.ts

import {
  alreadyRefusal,
  authorFor,
  emailSkipReason,
  noSuchTicket,
  ownerFilter,
  readOpen,
  readReply,
  readSupportAction,
  readTicketId,
  readUpload,
  resolveRefusal,
  shouldMarkRead,
  SUPPORT_LIMITS,
  throttleApplies,
  tooMany,
} from '../src/lib/support-api';
import { MAX_BODY, MAX_SUBJECT } from '../src/lib/support';

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
function note(refusal: { error: string; hint?: string; fields?: Record<string, string> }) {
  said.push(refusal.error);
  if (refusal.hint) said.push(refusal.hint);
  for (const text of Object.values(refusal.fields ?? {})) said.push(text);
}

const affiliate = { role: 'affiliate' as const, id: 'u1' };
const admin = { role: 'admin' as const, id: 'a1' };

console.log('- actions -');
for (const action of ['open', 'reply', 'close', 'resolve', 'reopen', 'read', 'upload']) {
  check(`${action} is an action`, readSupportAction(action) === action);
}
check('nothing else is', readSupportAction('delete') === null && readSupportAction(undefined) === null && readSupportAction(1) === null);

console.log('- which ticket -');
const id = readTicketId('12');
check('an id is read', id.ok && id.id === '12');
const numeric = readTicketId(12);
check('a number too', numeric.ok && numeric.id === '12');
const missing = readTicketId(undefined);
check('a missing id is a 400', !missing.ok && missing.refusal.status === 400);
const shaped = readTicketId('abc');
check('a thing that is not an id is simply not found', !shaped.ok && shaped.refusal.status === 404);
check('not found says the same thing every time', !shaped.ok && shaped.refusal.error === noSuchTicket().error);
note(noSuchTicket());
if (!missing.ok) note(missing.refusal);

console.log('- opening -');
const base = { subject: '  Where is   my payout?  ', category: 'payout', body: '  It is late.  ' };
const opened = readOpen(base, affiliate);
check('a good ticket is read', opened.ok);
check('the subject is trimmed and its spaces collapsed', opened.ok && opened.value.subject === 'Where is my payout?');
check('the body is trimmed', opened.ok && opened.value.body === 'It is late.');
check('it is for the affiliate who sent it', opened.ok && opened.value.userId === 'u1');
const spoofed = readOpen({ ...base, userId: 'u2' }, affiliate);
check('an affiliate naming somebody else is ignored', spoofed.ok && spoofed.value.userId === 'u1');
const lines = readOpen({ ...base, subject: 'Line one\nLine two' }, affiliate);
check('a line break in a subject becomes a space', lines.ok && lines.value.subject === 'Line one Line two');
const kept = readOpen({ ...base, body: 'One\n\nTwo' }, affiliate);
check('line breaks in a body are kept', kept.ok && kept.value.body === 'One\n\nTwo');
const forSomebody = readOpen({ ...base, userId: ' u2 ' }, admin);
check('an admin opens it for the person they chose', forSomebody.ok && forSomebody.value.userId === 'u2');
function refusedOpen(body: Record<string, unknown>, viewer: { role: 'admin' | 'affiliate'; id: string } = affiliate) {
  const result = readOpen(body, viewer);
  if (result.ok) return null;
  note(result.refusal);
  return result.refusal;
}
check('an admin who chose nobody is asked who', refusedOpen(base, admin)?.fields?.userId !== undefined);
check('an account with no id cannot open one', refusedOpen(base, { role: 'affiliate', id: '' })?.status === 403);
check('no subject is refused, on that field', refusedOpen({ ...base, subject: '   ' })?.fields?.subject !== undefined);
check('a subject one character too long is refused', refusedOpen({ ...base, subject: 'x'.repeat(MAX_SUBJECT + 1) })?.status === 400);
check('a subject at the limit is kept', readOpen({ ...base, subject: 'x'.repeat(MAX_SUBJECT) }, affiliate).ok);
check('no message is refused, on that field', refusedOpen({ ...base, body: '' })?.fields?.body !== undefined);
check('a message one character too long is refused', refusedOpen({ ...base, body: 'x'.repeat(MAX_BODY + 1) })?.status === 400);
check('a message at the limit is kept', readOpen({ ...base, body: 'x'.repeat(MAX_BODY) }, affiliate).ok);
check('no category is refused, on that field', refusedOpen({ ...base, category: 'other' })?.fields?.category !== undefined);
check('a subject that is not text is refused', refusedOpen({ ...base, subject: 5 })?.status === 400);
check('a bad attachment is refused', refusedOpen({ ...base, attachments: 'x' })?.fields?.attachments !== undefined);
check('no attachments is fine', opened.ok && opened.value.refs.length === 0);
const UUID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
const withFile = readOpen({ ...base, attachments: [{ path: `u1/${UUID}/shot.png`, name: 'shot.png' }] }, affiliate);
check('a file this affiliate uploaded rides along', withFile.ok && withFile.value.refs.length === 1);
check('a file somebody else uploaded does not', refusedOpen({ ...base, attachments: [{ path: `u2/${UUID}/shot.png`, name: 'shot.png' }] })?.fields?.attachments !== undefined);
const adminFile = readOpen({ ...base, userId: 'u2', attachments: [{ path: `a1/${UUID}/shot.png`, name: 'shot.png' }] }, admin);
check('an admin attaches from their own folder, whoever the ticket is for', adminFile.ok && adminFile.value.refs.length === 1);

console.log('- uploading -');
const up = readUpload({ files: [{ name: 'clip.mp4', type: 'video/mp4', size: 1000 }] }, affiliate);
check('an upload is read', up.ok && up.value.key === 'u1' && up.value.files.length === 1);
const noId = readUpload({ files: [{ name: 'clip.mp4', type: 'video/mp4', size: 1000 }] }, { id: '' });
check('an account with no id cannot upload', !noId.ok && noId.refusal.status === 403);
const badUp = readUpload({ files: [{ name: 'a.html', type: 'text/html', size: 10 }] }, affiliate);
check('a file that cannot be attached is refused before anything is uploaded', !badUp.ok && badUp.refusal.status === 400);
if (!badUp.ok) note(badUp.refusal);
check('uploads are limited too', SUPPORT_LIMITS.upload.limit === 60 && SUPPORT_LIMITS.upload.windowMs === 3_600_000);

console.log('- replying -');
const reply = readReply({ ticketId: '12', body: ' Thanks ' }, affiliate);
check('a reply is read', reply.ok && reply.value.ticketId === '12' && reply.value.body === 'Thanks');
const noTicket = readReply({ body: 'x' }, affiliate);
check('a reply to nothing is a 400', !noTicket.ok && noTicket.refusal.status === 400);
const empty = readReply({ ticketId: '12', body: '  ' }, affiliate);
check('an empty reply is refused', !empty.ok && empty.refusal.fields?.body !== undefined);
if (!empty.ok) note(empty.refusal);

console.log('- who is writing -');
const plain = authorFor({ role: 'affiliate', id: 'u1', username: 'maria', actingAs: null });
check('an affiliate writes as themselves', plain.role === 'affiliate' && plain.id === 'u1' && plain.name === 'maria');
const viaAdmin = authorFor({ role: 'affiliate', id: 'u1', username: 'maria', actingAs: { adminId: 'a1', adminName: 'Gimson' } });
check('from Client View the line names both', viaAdmin.name === 'maria (via Gimson)' && viaAdmin.role === 'affiliate');
const asAdmin = authorFor({ role: 'admin', id: 'env:admin', username: 'admin', actingAs: null });
check('the env admin writes as an admin', asAdmin.role === 'admin' && asAdmin.id === 'env:admin');
check('an affiliate is confined to their own tickets', ownerFilter(affiliate) === 'u1');
check('an affiliate with no id is confined to nobody\'s', ownerFilter({ role: 'affiliate', id: '' }) === '');
check('an admin is not confined', ownerFilter(admin) === undefined);

console.log('- marking read -');
// Review focus 3.
check('opening your own thread marks it read', shouldMarkRead({ actingAs: null }));
check('opening it from Client View does not', !shouldMarkRead({ actingAs: { adminId: 'a1', adminName: 'Gimson' } }));

console.log('- limits -');
check('five tickets an hour', SUPPORT_LIMITS.open.limit === 5 && SUPPORT_LIMITS.open.windowMs === 3_600_000);
check('thirty replies an hour', SUPPORT_LIMITS.reply.limit === 30 && SUPPORT_LIMITS.reply.windowMs === 3_600_000);
check('affiliates are throttled', throttleApplies({ role: 'affiliate', actingAs: null }));
check('admins are not', !throttleApplies({ role: 'admin', actingAs: null }));
check('nor an admin writing from Client View, who would otherwise spend the affiliate\'s allowance', !throttleApplies({ role: 'affiliate', actingAs: { adminId: 'a1', adminName: 'Gimson' } }));
check('too many is a 429', tooMany().status === 429);
note(tooMany());
check('an admin may mark a ticket resolved', resolveRefusal({ role: 'admin' }) === null);
check('an affiliate may not', resolveRefusal({ role: 'affiliate' })?.status === 403);
note(resolveRefusal({ role: 'affiliate' })!);
check('resolving one that is not open is a 409', alreadyRefusal('resolve').status === 409);
note(alreadyRefusal('resolve'));
check('closing a closed ticket is a 409', alreadyRefusal('close').status === 409);
check('reopening an open one too', alreadyRefusal('reopen').status === 409);
check('and they say different things', alreadyRefusal('close').error !== alreadyRefusal('reopen').error);
note(alreadyRefusal('close'));
note(alreadyRefusal('reopen'));

console.log('- email -');
// Review focus 5.
check('an address is no reason to skip', emailSkipReason('maria@example.com') === '');
check('a blank one is', emailSkipReason('   ') !== '');
said.push(emailSkipReason(''));

check('there was something to read', said.length > 15, said.length);
check('no em or en dash anywhere', said.every((text) => !/[\u2013\u2014]/.test(text)), said.filter((t) => /[\u2013\u2014]/.test(t)));

console.log(`\nsupport-api: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
