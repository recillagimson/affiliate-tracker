import { NextResponse } from 'next/server';
import { unauthorized, viewerFromRequest } from '@/lib/api-auth';
import { readRowId, storeFailure, type Refusal } from '@/lib/payout-api';
import { receiptHeaders } from '@/lib/receipt-file';
import { mayReadTicket } from '@/lib/support';
import { noSuchTicket } from '@/lib/support-api';
import {
  readSupportAttachmentFile,
  readSupportAttachmentTicket,
  readSupportTicket,
} from '@/lib/support-store';

/**
 * One image from a support conversation, handed back as the file it is.
 *
 *   GET /api/support/attachments/<id>
 *
 * A route of its own because it is the one thing in the support API that reads
 * the bytes. Every other query names its columns and leaves the files behind.
 *
 * Checked before it reads, in three steps, the way the receipt route does. The
 * id in the URL is a small sequential number that says nothing about whose
 * image it is, so the route first asks which ticket it belongs to, then
 * whether this viewer may read that ticket, and only then reads the file. An
 * affiliate typing somebody else's id is refused without the image ever
 * leaving the database, and is told the same thing as for an id that was never
 * issued.
 *
 * Served with nosniff, and with the stored type only when the bytes still open
 * the way it says (lib/receipt-file.ts). Anything else is downloaded as plain
 * bytes, never rendered inside this app.
 */

export const dynamic = 'force-dynamic';

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
    const refusal = storeFailure(error, 'Could not read that image.');
    if (refusal.status >= 500) console.error('reading a support image', error);
    return refuse(refusal);
  }

  if (!file) return refuse(noSuchTicket());

  const bytes = Buffer.from(file.data, 'base64');
  if (bytes.length === 0) return refuse({ status: 500, error: 'That image could not be read back.' });

  return new NextResponse(new Uint8Array(bytes), {
    headers: receiptHeaders({ name: file.name, type: file.type, bytes }),
  });
}
