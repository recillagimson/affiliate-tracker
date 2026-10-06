import { NextResponse } from 'next/server';
import { unauthorized, viewerFromRequest } from '@/lib/api-auth';
import { readRowId, storeFailure, type Refusal } from '@/lib/payout-api';
import { mayReadTicket } from '@/lib/support';
import { noSuchTicket } from '@/lib/support-api';
import {
  readSupportAttachmentFile,
  readSupportAttachmentTicket,
  readSupportTicket,
  signSupportAttachment,
} from '@/lib/support-store';

/**
 * One file from a support conversation.
 *
 *   GET /api/support/attachments/<id>
 *
 * The files are in a private storage bucket that nothing but this server can
 * read, so this route is the only way to one. It answers with a redirect to a
 * link that opens that single file for a few minutes.
 *
 * Checked before it signs anything, in three steps, the way the receipt route
 * does. The id in the URL is a small sequential number that says nothing
 * about whose file it is, so the route first asks which ticket it belongs to,
 * then whether this viewer may read that ticket, and only then asks storage
 * for a link. An affiliate typing somebody else's id is told the same thing
 * as for an id that was never issued.
 *
 * The file is served by storage, from storage's own domain, with the type the
 * bucket accepted it as. Nothing somebody uploaded is ever rendered from this
 * app's origin.
 */

export const dynamic = 'force-dynamic';

/** Long enough to start a video and scrub through it; short enough that a copied link is soon worthless. */
const LINK_SECONDS = 600;

function refuse(refusal: Refusal): NextResponse {
  const { status, ...body } = refusal;
  return NextResponse.json(body, { status });
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const viewer = await viewerFromRequest(request);
  if (!viewer) return unauthorized();

  const { id: raw } = await context.params;
  const id = readRowId(raw);
  if (!id) return refuse(noSuchTicket());

  let file: Awaited<ReturnType<typeof readSupportAttachmentFile>>;
  try {
    const ticketId = await readSupportAttachmentTicket(id);
    if (!ticketId) return refuse(noSuchTicket());
    const ticket = await readSupportTicket(ticketId);
    if (!ticket || !mayReadTicket(viewer, ticket.userId)) return refuse(noSuchTicket());
    file = await readSupportAttachmentFile(id);
  } catch (error) {
    const refusal = storeFailure(error, 'Could not read that file.');
    if (refusal.status >= 500) console.error('reading a support attachment', error);
    return refuse(refusal);
  }

  if (!file) return refuse(noSuchTicket());

  let url: string;
  try {
    url = await signSupportAttachment(file.path, LINK_SECONDS);
  } catch (error) {
    console.error('opening a support attachment', error);
    return refuse({ status: 500, error: 'That file could not be opened.' });
  }

  // Not cached: the link inside it expires, and whether this viewer may have
  // one is decided on every request.
  return NextResponse.redirect(url, { status: 302, headers: { 'cache-control': 'private, no-store' } });
}
