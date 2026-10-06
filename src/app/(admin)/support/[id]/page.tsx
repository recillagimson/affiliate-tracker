import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ErrorPanel } from '@/components/ErrorPanel';
import { SupportThread } from '@/components/SupportThread';
import { CATEGORY_LABELS, sideFor, waitingLabel } from '@/lib/support';
import { ownerFilter, shouldMarkRead } from '@/lib/support-api';
import { readSupportThread, supportEnabled } from '@/lib/support-store';
import { findUserById } from '@/lib/users';
import { requireViewer } from '@/lib/viewer';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Support ticket' };

/**
 * One support conversation.
 *
 * An affiliate's own user id goes into the read itself, so somebody else's
 * ticket is never fetched, and resolves to the same not-found page as a
 * number that was never issued. The ids are sequential; a page that said
 * "that is not yours" would be telling anybody who asked which ones exist.
 *
 * Nothing is marked read here. The conversation component does that from the
 * browser once it has actually mounted, so a link Next prefetched does not
 * count as somebody reading it.
 */
export default async function SupportTicketPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireViewer();
  const { id } = await params;
  const side = sideFor(viewer);

  if (!supportEnabled()) {
    return (
      <ErrorPanel
        title="Support needs a database"
        message="Tickets are kept in Supabase. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, then reload this page."
        hint=""
      />
    );
  }

  let thread: Awaited<ReturnType<typeof readSupportThread>>;
  try {
    thread = await readSupportThread(id, ownerFilter(viewer));
  } catch (caught) {
    return (
      <ErrorPanel
        title="Could not read that ticket"
        message={caught instanceof Error ? caught.message : 'Try again in a moment.'}
        hint=""
      />
    );
  }
  if (!thread) notFound();

  const { ticket, messages } = thread;
  // Whose ticket it is, for an admin. A name that cannot be read is left off
  // rather than failing the page: the conversation is still the point.
  let person = '';
  if (side === 'admin') {
    const account = await findUserById(ticket.userId).catch(() => null);
    person = account ? account.fullName || account.username : 'Unknown account';
  }

  return (
    <div className="mx-auto w-full max-w-[900px]">
      <p className="text-[13px]">
        <Link href="/support" className="link-text font-medium">
          All tickets
        </Link>
      </p>
      <div className="rise mt-3">
        <h1 className="font-display text-[24px] leading-[1.1]">{ticket.subject}</h1>
        <p className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px] text-ink-soft">
          <span className={`chip ${ticket.status === 'closed' ? 'chip-quiet' : ticket.status === 'resolved' ? 'chip-live' : 'chip-gold'}`}>
            {waitingLabel(ticket, side)}
          </span>
          <span>{CATEGORY_LABELS[ticket.category]}</span>
          {person ? <span>{person}</span> : null}
          <span>Ticket {ticket.id}</span>
        </p>
      </div>

      <SupportThread
        ticket={{
          id: ticket.id,
          subject: ticket.subject,
          category: CATEGORY_LABELS[ticket.category],
          status: ticket.status,
        }}
        messages={messages}
        side={side}
        markRead={shouldMarkRead(viewer)}
      />
    </div>
  );
}
