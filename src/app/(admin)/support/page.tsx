import type { Metadata } from 'next';
import Link from 'next/link';
import { ErrorPanel } from '@/components/ErrorPanel';
import { NewTicket } from '@/components/NewTicket';
import { SupportList } from '@/components/SupportList';
import {
  buildSupportRows,
  CATEGORY_LABELS,
  categoryFilterFrom,
  sideFor,
  statusFilterFrom,
  SUPPORT_CATEGORIES,
  supportHref,
  type StatusFilter,
  type SupportTicket,
} from '@/lib/support';
import { listSupportTickets, listSupportTicketsFor, supportEnabled } from '@/lib/support-store';
import { findUserById, listUsers } from '@/lib/users';
import { requireViewer } from '@/lib/viewer';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Support' };

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'open', label: 'Open' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'closed', label: 'Closed' },
  { key: 'all', label: 'All' },
];

/**
 * Support: questions and feedback, as conversations.
 *
 * The same page for both sides, deciding which from the session. An affiliate
 * sees their own tickets, newest activity first, and a button to open one. An
 * admin sees everybody's, opening on the open ones because those are the work,
 * with filters in the URL so a filtered view can be linked to and survives a
 * reload.
 *
 * An admin in Client View is the affiliate here, as everywhere else, and sees
 * that affiliate's tickets.
 */
export default async function SupportPage({ searchParams }: PageProps) {
  const viewer = await requireViewer();
  const side = sideFor(viewer);
  const admin = side === 'admin';

  if (!supportEnabled()) {
    return (
      <ErrorPanel
        title="Support needs a database"
        message="Tickets are kept in Supabase. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, then reload this page."
        hint=""
      />
    );
  }

  const query = await searchParams;
  const status = statusFilterFrom(first(query.status));
  const category = categoryFilterFrom(first(query.category));
  const unread = first(query.unread) === '1';

  let tickets: SupportTicket[] = [];
  let people: { id: string; name: string }[] = [];
  let error = '';
  // Whose name an affiliate's new ticket goes under, shown on the form.
  let filer = viewer.username;
  try {
    if (admin) {
      const [all, users] = await Promise.all([
        listSupportTickets({
          status: status === 'all' ? undefined : status,
          category: category || undefined,
        }),
        listUsers(),
      ]);
      tickets = all;
      people = users
        .filter((user) => user.role === 'affiliate' && user.active)
        .map((user) => ({ id: user.id, name: user.fullName || user.username }))
        .sort((a, b) => a.name.localeCompare(b.name));
      // Names for every account, active or not: an old ticket still belongs
      // to somebody.
      const names = new Map(users.map((user) => [user.id, user.fullName || user.username]));
      const rows = buildSupportRows(tickets, side, names).filter((row) => !unread || row.unread);
      return (
        <div className="mx-auto w-full max-w-[900px]">
          <Heading admin>
            <NewTicket people={people} filer={null} />
          </Heading>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            {STATUS_FILTERS.map((option) => (
              <Link
                key={option.key}
                href={supportHref({ status: option.key, category, unread })}
                className="pill-filter"
                data-active={status === option.key ? 'true' : 'false'}
              >
                {option.label}
              </Link>
            ))}
            <Link
              href={supportHref({ status, category, unread: !unread })}
              className="pill-filter"
              data-active={unread ? 'true' : 'false'}
            >
              Unread only
            </Link>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Link
              href={supportHref({ status, category: '', unread })}
              className="pill-filter"
              data-active={category === '' ? 'true' : 'false'}
            >
              Every category
            </Link>
            {SUPPORT_CATEGORIES.map((key) => (
              <Link
                key={key}
                href={supportHref({ status, category: key, unread })}
                className="pill-filter"
                data-active={category === key ? 'true' : 'false'}
              >
                {CATEGORY_LABELS[key]}
              </Link>
            ))}
          </div>
          <SupportList rows={rows} admin />
        </div>
      );
    }
    tickets = await listSupportTicketsFor(viewer.id);
    filer = await filerName(viewer);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : 'Could not read the tickets.';
  }

  return (
    <div className="mx-auto w-full max-w-[900px]">
      <Heading admin={admin}>{admin ? null : <NewTicket people={null} filer={filer} />}</Heading>
      {error ? (
        <div className="mt-5">
          <ErrorPanel title="Could not read the tickets" message={error} hint="" />
        </div>
      ) : (
        <SupportList rows={buildSupportRows(tickets, side, new Map())} admin={false} />
      )}
    </div>
  );
}

/**
 * Who a ticket opened from this session is filed as: the signed-in affiliate,
 * by their full name when there is one. From Client View it names the admin
 * behind it as well, the way the ticket's own record will.
 */
async function filerName(viewer: { id: string; username: string; actingAs: { adminName: string } | null }): Promise<string> {
  const account = await findUserById(viewer.id).catch(() => null);
  const name = account?.fullName ? `${account.fullName} (${viewer.username})` : viewer.username;
  return viewer.actingAs ? `${name}, via ${viewer.actingAs.adminName}` : name;
}

function Heading({ admin, children }: { admin: boolean; children: React.ReactNode }) {
  return (
    <div className="rise flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="font-display text-[26px] leading-[1.05]">Support</h1>
        <p className="plain mt-2.5">
          {admin
            ? 'Questions and feedback from affiliates. Open a ticket to read and answer it.'
            : 'Ask a question, report something broken, or tell us what would make this better. We answer here, and email you when we do.'}
        </p>
      </div>
      {children}
    </div>
  );
}
