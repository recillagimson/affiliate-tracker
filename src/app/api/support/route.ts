import { NextResponse } from 'next/server';
import { unauthorized, viewerFromRequest, type Viewer } from '@/lib/api-auth';
import { configuredBaseUrl } from '@/lib/config';
import { EmailError, sendEmail } from '@/lib/email';
import { supportReplyEmail } from '@/lib/emails/support-reply';
import { storeFailure, type Refusal } from '@/lib/payout-api';
import { rateLimit } from '@/lib/ratelimit';
import { originFromHeaders } from '@/lib/request';
import { announceSupport } from '@/lib/slack';
import {
  isSupportFileType,
  MAX_FILE_BYTES,
  newUploadPath,
  sideFor,
  type AttachmentRef,
  type SupportCategory,
  type SupportUpload,
} from '@/lib/support';
import {
  alreadyRefusal,
  asBody,
  authorFor,
  emailSkipReason,
  missingUpload,
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
} from '@/lib/support-api';
import {
  addSupportMessage,
  closeSupportTicket,
  createSupportUpload,
  markSupportRead,
  openSupportTicket,
  readSupportTicket,
  reopenSupportTicket,
  resolveSupportTicket,
  statSupportUpload,
} from '@/lib/support-store';
import { findUserById } from '@/lib/users';

/**
 * Everything somebody does to a support ticket.
 *
 * Seven actions on one POST: `open` a ticket, `reply` on one, `close` it,
 * `resolve` it (admins only), `reopen` it, mark it `read`, and `upload`, which hands back somewhere to put
 * files. Both sides use the same route. Which side
 * the caller is on, and which tickets they may touch, comes from the session
 * and nothing else: an affiliate's user id goes into every query, so somebody
 * else's ticket is never found rather than found and refused, and it answers
 * the same 404 as a ticket that never existed.
 *
 * An admin in Client View is the affiliate as far as this route is concerned.
 * They may write for them, and the message records that an admin did. The one
 * thing they do not do is mark the ticket read, because looking at somebody's
 * screen is not that person reading their reply.
 *
 * Files never pass through here. `upload` answers with a signed URL per file,
 * the browser sends each one straight to a private storage bucket, and the
 * message then names the paths it was given. Before anything is written each
 * path is read back from storage, so the size and type a message records are
 * what is really there, and a path that was never uploaded to is refused.
 *
 * A message is written first and announced afterwards. An email or a Slack
 * post that fails never undoes it: the admin is told no email went and why,
 * and Slack swallows its own failures.
 *
 * The rules themselves are in lib/support-api.ts, with their checks. This file
 * holds the order things happen in.
 */

export const dynamic = 'force-dynamic';

function refuse(refusal: Refusal, headers?: Record<string, string>): NextResponse {
  const { status, ...body } = refusal;
  return NextResponse.json(body, { status, headers });
}

export async function POST(request: Request) {
  const viewer = await viewerFromRequest(request);
  if (!viewer) return unauthorized();

  let body: Record<string, unknown>;
  try {
    body = asBody(await request.json());
  } catch {
    return refuse({ status: 400, error: 'Expected a JSON body.' });
  }

  const action = readSupportAction(body.action);
  if (!action) {
    return refuse({ status: 400, error: 'No such action.', hint: 'Expected open, reply, close, resolve, reopen, read or upload.' });
  }

  const origin = originFromHeaders(request.headers, configuredBaseUrl());
  try {
    if (action === 'open') return await open(viewer, body, origin);
    if (action === 'reply') return await reply(viewer, body, origin);
    if (action === 'read') return await read(viewer, body);
    if (action === 'upload') return await upload(viewer, body);
    return await move(viewer, body, action);
  } catch (error) {
    // An admin is shown the raw reason, as on every other admin route here; an
    // affiliate is shown the fallback, since a Postgres message is no use to them.
    const refusal = storeFailure(error, 'That did not save.', { showUnknown: viewer.role === 'admin' });
    if (refusal.status >= 500) console.error(`support: ${action}`, error);
    return refuse(refusal);
  }
}

/** Refuses when an affiliate has sent too much. Counted only for a request that was otherwise good. */
function throttled(viewer: Viewer, action: 'open' | 'reply' | 'upload'): NextResponse | null {
  if (!throttleApplies(viewer)) return null;
  const result = rateLimit(`support:${action}:${viewer.id}`, SUPPORT_LIMITS[action]);
  if (result.ok) return null;
  return refuse(tooMany(), { 'retry-after': String(result.retryAfterSeconds) });
}

/** Somewhere to put each file: a path in the viewer's own folder and a URL that accepts one upload to it. */
async function upload(viewer: Viewer, body: Record<string, unknown>): Promise<NextResponse> {
  const parsed = readUpload(body, viewer);
  if (!parsed.ok) return refuse(parsed.refusal);
  const limited = throttled(viewer, 'upload');
  if (limited) return limited;

  const uploads = await Promise.all(
    parsed.value.files.map(async (file) => {
      const path = newUploadPath(parsed.value.key, crypto.randomUUID(), file.name);
      return { path, url: await createSupportUpload(path) };
    }),
  );
  return NextResponse.json({ ok: true, uploads });
}

/**
 * The files a message names, as storage actually has them. Null when any one
 * is missing, is not a type this app attaches, or is over the size limit.
 */
async function stored(refs: AttachmentRef[]): Promise<SupportUpload[] | null> {
  const files: SupportUpload[] = [];
  for (const ref of refs) {
    const found = await statSupportUpload(ref.path);
    if (!found || !isSupportFileType(found.type) || found.size > MAX_FILE_BYTES) return null;
    files.push({ name: ref.name, type: found.type, size: found.size, path: ref.path });
  }
  return files;
}

async function open(viewer: Viewer, body: Record<string, unknown>, origin: string): Promise<NextResponse> {
  const parsed = readOpen(body, viewer);
  if (!parsed.ok) return refuse(parsed.refusal);
  const limited = throttled(viewer, 'open');
  if (limited) return limited;

  const files = await stored(parsed.value.refs);
  if (!files) return refuse(missingUpload());

  const author = authorFor(viewer);
  const ticketId = await openSupportTicket({
    userId: parsed.value.userId,
    subject: parsed.value.subject,
    category: parsed.value.category,
    openedBy: author.name,
    openedByRole: author.role,
    authorId: author.id,
    body: parsed.value.body,
    files,
  });

  const told = await tell({
    author,
    userId: parsed.value.userId,
    ticketId,
    subject: parsed.value.subject,
    category: parsed.value.category,
    body: parsed.value.body,
    opened: true,
    origin,
  });
  return NextResponse.json({ ok: true, ticketId, ...told }, { status: 201 });
}

async function reply(viewer: Viewer, body: Record<string, unknown>, origin: string): Promise<NextResponse> {
  const parsed = readReply(body, viewer);
  if (!parsed.ok) return refuse(parsed.refusal);

  // Read with the owner in the query, before anything is written: a reply to
  // somebody else's ticket finds nothing, and writes nothing.
  const ticket = await readSupportTicket(parsed.value.ticketId, ownerFilter(viewer));
  if (!ticket) return refuse(noSuchTicket());

  const limited = throttled(viewer, 'reply');
  if (limited) return limited;

  const files = await stored(parsed.value.refs);
  if (!files) return refuse(missingUpload());

  const author = authorFor(viewer);
  await addSupportMessage({
    ticketId: ticket.id,
    authorRole: author.role,
    authorId: author.id,
    authorName: author.name,
    body: parsed.value.body,
    files,
  });

  const told = await tell({
    author,
    userId: ticket.userId,
    ticketId: ticket.id,
    subject: ticket.subject,
    category: ticket.category,
    body: parsed.value.body,
    opened: false,
    origin,
  });
  return NextResponse.json({ ok: true, ticketId: ticket.id, ...told });
}

async function move(
  viewer: Viewer,
  body: Record<string, unknown>,
  action: 'close' | 'resolve' | 'reopen',
): Promise<NextResponse> {
  if (action === 'resolve') {
    const refused = resolveRefusal(viewer);
    if (refused) return refuse(refused);
  }
  const id = readTicketId(body.ticketId);
  if (!id.ok) return refuse(id.refusal);

  const owner = ownerFilter(viewer);
  const ticket = await readSupportTicket(id.id, owner);
  if (!ticket) return refuse(noSuchTicket());

  const by = authorFor(viewer).name;
  const done =
    action === 'close'
      ? await closeSupportTicket(ticket.id, by, owner)
      : action === 'resolve'
        ? await resolveSupportTicket(ticket.id, by)
        : await reopenSupportTicket(ticket.id, owner);
  if (!done) return refuse(alreadyRefusal(action));
  return NextResponse.json({ ok: true, ticketId: ticket.id });
}

async function read(viewer: Viewer, body: Record<string, unknown>): Promise<NextResponse> {
  const id = readTicketId(body.ticketId);
  if (!id.ok) return refuse(id.refusal);
  // Answered as done rather than refused: the page sends this on every open,
  // and from Client View there is simply nothing to record.
  if (!shouldMarkRead(viewer)) return NextResponse.json({ ok: true, marked: false });
  await markSupportRead(id.id, sideFor(viewer), viewer.id);
  return NextResponse.json({ ok: true, marked: true });
}

/**
 * Tell the other side, after the write. Never throws.
 *
 * An admin's message is emailed to the affiliate. An affiliate's message goes
 * to the admins' Slack channel, subject and category only.
 */
async function tell(input: {
  author: { role: 'affiliate' | 'admin'; name: string };
  userId: string;
  ticketId: string;
  subject: string;
  category: SupportCategory;
  body: string;
  opened: boolean;
  origin: string;
}): Promise<{ emailed?: boolean; emailProblem?: string }> {
  const path = `/support/${input.ticketId}`;

  if (input.author.role === 'affiliate') {
    await announceSupport({
      person: input.author.name,
      subject: input.subject,
      category: input.category,
      kind: input.opened ? 'opened' : 'replied',
      url: `${input.origin.replace(/\/+$/, '')}${path}`,
    });
    return {};
  }

  try {
    const account = await findUserById(input.userId);
    const skip = emailSkipReason(account?.email ?? '');
    if (!account || skip) return { emailed: false, emailProblem: skip || 'That account could not be read, so no email was sent.' };
    await sendEmail(
      supportReplyEmail({
        to: account.email,
        name: account.fullName || account.username,
        origin: input.origin,
        subject: input.subject,
        body: input.body,
        ticketPath: path,
        opened: input.opened,
      }),
    );
    return { emailed: true };
  } catch (error) {
    const why = error instanceof Error ? error.message : 'The email could not be sent.';
    if (!(error instanceof EmailError && error.unconfigured)) console.error('support: email', error);
    return { emailed: false, emailProblem: why };
  }
}
