'use client';

import Link from 'next/link';
import { useState } from 'react';
import { EmptyState } from '@/components/EmptyState';
import { Pager } from '@/components/Pager';
import { formatDateTime } from '@/lib/analytics';
import { PAGE_SIZES, pageSlice } from '@/lib/paging';
import type { SupportRow } from '@/lib/support';

/**
 * Support tickets, as a list: what each is about, whose move it is, and
 * whether there is something in it this viewer has not read.
 *
 * One component for both sides. An admin's rows carry whose ticket it is; an
 * affiliate's do not, because every one of them is their own.
 *
 * The whole row is the link. A list of conversations has one thing to do with
 * each of them, which is open it.
 */
export function SupportList({ rows, admin }: { rows: SupportRow[]; admin: boolean }) {
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState<number>(PAGE_SIZES[1]);

  if (rows.length === 0) {
    return admin ? (
      <p className="panel mt-5 px-5 py-14 text-center text-[13px] text-ink-soft">
        No tickets match. Try another filter.
      </p>
    ) : (
      <div className="mt-5">
        <EmptyState
          title="No tickets yet"
          body="Have a question, found something broken, or have an idea? Press New ticket and we will get back to you here."
        />
      </div>
    );
  }

  const shown = pageSlice(rows, page, perPage);

  return (
    <>
      <ul className="panel mt-5 divide-y divide-edge">
        {shown.map((row) => (
          <li key={row.id} data-unread={row.unread ? 'true' : 'false'}>
            <Link
              href={`/support/${row.id}`}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4 hover:bg-paper-sunk"
            >
              <span
                aria-hidden
                className={`h-2 w-2 flex-none rounded-full ${row.unread ? 'bg-gold' : 'bg-transparent'}`}
              />
              <span className="min-w-0 flex-1">
                <span className={`block truncate text-[14px] text-ink ${row.unread ? 'font-semibold' : 'font-medium'}`}>
                  {row.subject}
                  {row.unread ? <span className="sr-only"> (unread)</span> : null}
                </span>
                <span className="mt-1 block truncate text-[12px] text-ink-soft">
                  {admin ? `${row.person} · ` : ''}
                  {row.category} · {formatDateTime(row.lastAt)}
                </span>
              </span>
              <span className={`chip ${row.status === 'closed' ? 'chip-quiet' : row.status === 'resolved' ? 'chip-live' : 'chip-gold'}`}>
                {row.waiting}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <Pager
        total={rows.length}
        page={page}
        perPage={perPage}
        onPage={setPage}
        onPerPage={(next) => {
          setPerPage(next);
          setPage(1);
        }}
        label="Tickets"
      />
    </>
  );
}
