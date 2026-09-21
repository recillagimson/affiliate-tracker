'use client';

import { useRouter } from 'next/navigation';
import { Fragment, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { ApproveLead, type ApproveContext } from './ApproveLead';
import { Pager } from './Pager';
import { TableScroller } from './TableScroller';
import { isLeadId } from '@/lib/lead-id';
import { dropSettled, isCurrent, takeTicket } from '@/lib/optimistic';
import { PAGE_SIZES, pageSlice } from '@/lib/paging';
import { BLANK } from '@/lib/report-table';
import { LEAD_STATUSES, displayStatus, nextManualStatus, statusLabel } from '@/lib/status';
import type { LeadStatus } from '@/lib/types';

/**
 * One captured lead, as the dashboard needs it.
 *
 * `age` and `capturedAt` arrive pre-formatted from the server. Formatting a
 * relative time in the browser instead would produce a different string a
 * second after the server produced it, which React reports as a hydration
 * mismatch. The IP and user agent are logged but deliberately never sent here.
 */
export type LeadRow = {
  id: string;
  fullName: string;
  email: string;
  phone: string;
  campaign: string;
  slug: string;
  assignee: string;
  /** As stored. What is shown may be stronger — see `hasApproval`. */
  status: LeadStatus;
  /**
   * The card or cards the lead applied for, as the merchant's report names
   * them, joined with commas; '' until a sync has seen one. Shown, never
   * edited: it is the merchant's record of the application, and a copy
   * corrected by hand would be a second version of it.
   */
  card: string;
  /**
   * Whether an approval names this lead. Passed in rather than worked out here
   * because the approvals live on the server beside the leads, and shipping
   * them to the browser a second time to re-derive one boolean per row would be
   * the same answer at ten times the weight.
   */
  hasApproval: boolean;
  age: string;
  capturedAt: string;
};

/** Keyed by the stored word; `statusLabel` decides what it is called on screen. */
export type LeadFilter = 'all' | LeadStatus;

/** The filter's options: everything, then the funnel in order. */
export const LEAD_FILTERS: readonly LeadFilter[] = ['all', ...LEAD_STATUSES];

export function filterLabel(filter: LeadFilter): string {
  return filter === 'all' ? 'All' : statusLabel(filter);
}

/**
 * The state a row is counted and filtered under: its own, except for a value
 * that is not a status at all, from an untyped row. That reads Pending on its
 * pill, so it is counted and found there too. Anything else and the three
 * options stop adding up to All, by exactly the rows nobody can find.
 */
function filedUnder(status: LeadStatus): LeadStatus {
  return (LEAD_STATUSES as readonly string[]).includes(status) ? status : 'pending';
}

export function matchesFilter(row: { status: LeadStatus }, filter: LeadFilter): boolean {
  return filter === 'all' || filedUnder(row.status) === filter;
}

/**
 * How many rows each option finds. Given the rows as shown, not as stored, so
 * the number on an option is the number of rows choosing it brings up.
 */
export function leadCounts(rows: { status: LeadStatus }[]): Record<LeadFilter, number> {
  const counts: Record<LeadFilter, number> = { all: rows.length, pending: 0, applied: 0, registered: 0 };
  for (const row of rows) counts[filedUnder(row.status)] += 1;
  return counts;
}

/** What the list says when the chosen state has nobody in it. */
export function noLeadsText(filter: LeadFilter): string {
  return filter === 'all'
    ? 'No leads in this list.'
    : `No ${statusLabel(filter).toLowerCase()} leads in this list.`;
}

/**
 * The rows with the status each is shown with.
 *
 * A click this session has made stands in for the stored status until the
 * server agrees. The approval wins over both, so the counts, the filter and
 * the pill all read the same thing the approvals panel does.
 */
export function withShownStatus(rows: LeadRow[], changed: Record<string, LeadStatus>): LeadRow[] {
  return rows.map((row) => ({
    ...row,
    status: displayStatus(changed[row.id] ?? row.status, row.hasApproval),
  }));
}

/**
 * The leads, one to a row.
 *
 * A table rather than a stack of cards because of what a reader does with this
 * list: run down the status column to see what is still pending, or down the
 * owner column to see whose links are producing. Both are comparisons between
 * rows, and a card puts every field of one lead close together at the cost of
 * putting the same field of two leads far apart.
 *
 * `canEdit` hides the status toggle for an affiliate, who may read their own
 * leads but not change them. It is presentation only — /api/leads/[id] refuses
 * them regardless, and has to, because nothing stops someone calling it
 * directly.
 *
 * `approving` is what Approve needs: the rate card and the commission history.
 * Without it, which is how an affiliate gets the panel, there is no Approve.
 *
 * The wording is overridable because this panel appears in two places that mean
 * different things by it: everyone's leads on the dashboard, and one person's
 * on their own page. Same rows, same controls, different sentence — which is
 * much better than a second copy of the list that can drift from this one.
 */
export function LeadsPanel({
  rows,
  total,
  canEdit = true,
  title = 'Latest submissions',
  summary,
  emptyBody = 'No leads captured yet. Share a link and they will appear here.',
  showAssignee = true,
  approving,
}: {
  rows: LeadRow[];
  total: number;
  canEdit?: boolean;
  title?: string;
  /** Replaces the count line under the heading. */
  summary?: string;
  emptyBody?: string;
  /**
   * Off when every row belongs to the same person and the heading already says
   * who — their name down the side of their own page is six copies of a fact
   * the reader arrived with.
   */
  showAssignee?: boolean;
  /** Given to an admin only. See ApproveLead. */
  approving?: ApproveContext;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [filter, setFilter] = useState<LeadFilter>('all');
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState<number>(PAGE_SIZES[0]);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  /** The lead whose approve form is open, one at a time. */
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [approvedNote, setApprovedNote] = useState('');

  /**
   * Statuses this session has changed, applied over whatever the server last
   * sent. The toggle flips instantly and the row is re-rendered from the server
   * a moment later; without this the pill would sit on its old value for the
   * whole round trip to the spreadsheet, which is not fast.
   */
  const [changed, setChanged] = useState<Record<string, LeadStatus>>({});

  /*
   * Clicks outrun replies, especially on the Sheets adapter. One ticket per
   * row, so a slow response for a lead that has since been toggled again is
   * discarded rather than allowed to roll the pill back to a value nobody
   * asked for.
   */
  const tickets = useRef<Record<string, number>>({});

  /*
   * Drop an override once the server is saying the same thing.
   *
   * Without this the map only ever grows, and every entry in it is a value this
   * browser will keep drawing over the truth. Somebody else marks the same lead
   * back to pending, the refresh brings that down, and this tab carries on
   * showing "Registered" because that is what it clicked twenty minutes ago.
   */
  useEffect(() => {
    setChanged((prev) => dropSettled(prev, rows, (row) => row.status));
  }, [rows]);

  const withStatus = useMemo(() => withShownStatus(rows, changed), [rows, changed]);

  /** How many of those are approved because an approval says so, not by hand. */
  const fromApprovals = withStatus.filter((row) => row.hasApproval).length;
  const counts = leadCounts(withStatus);

  const matching = withStatus.filter((row) => matchesFilter(row, filter));
  const visible = pageSlice(matching, page, perPage);

  /*
   * A reference column only when there are references to put in it. Leads
   * captured before references existed carry a uuid that never travelled
   * anywhere, and a column of dashes invites a search that cannot succeed.
   * Read off the whole list rather than the page, so the table does not gain
   * and lose a column as you page through it.
   */
  const showRef = rows.some((row) => isLeadId(row.id));

  /* Static strings, because the class scanner reads this file rather than
     running it: a width built by arithmetic is a width Tailwind never emits. */
  const minWidth =
    showAssignee && showRef
      ? 'min-w-[1300px]'
      : showAssignee || showRef
        ? 'min-w-[1160px]'
        : 'min-w-[1020px]';

  const columns = 6 + (showAssignee ? 1 : 0) + (showRef ? 1 : 0);

  /*
   * Approve is offered where it can land: an admin, a lead with no approval
   * yet, and one with a reference for the approval to name. A lead captured
   * before references existed is approved through Record an approval instead.
   */
  const canApprove = (row: LeadRow) =>
    Boolean(approving) && canEdit && !row.hasApproval && isLeadId(row.id);

  /** The approval landed: close the form and let the refresh bring the row in as approved. */
  function approved(message: string) {
    setApprovingId(null);
    setError(null);
    setApprovedNote(message);
    setAnnouncement(message);
    startTransition(() => router.refresh());
  }

  /** A different set of leads is a different first page, not page 4 of it. */
  function choose(next: LeadFilter) {
    setFilter(next);
    setPage(1);
  }

  /**
   * Flip the pill, then tell the server.
   *
   * Not awaited by anything the user can see. Marking a lead registered is a
   * one-word write that succeeds essentially always, and the honest response to
   * a click on it is the new word, immediately. The request goes out behind
   * that; if it fails, the pill goes back and the panel says why.
   */
  function setStatus(row: LeadRow, next: LeadStatus) {
    const ticket = takeTicket(tickets.current, row.id);

    setError(null);
    setChanged((prev) => ({ ...prev, [row.id]: next }));
    setAnnouncement(`${row.fullName || row.email} marked ${statusLabel(next).toLowerCase()}.`);

    void (async () => {
      try {
        const res = await fetch(`/api/leads/${row.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status: next }),
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw new Error(payload.error ?? `Request failed (${res.status})`);
        }
        if (!isCurrent(tickets.current, row.id, ticket)) return;
        startTransition(() => router.refresh());
      } catch (err) {
        if (!isCurrent(tickets.current, row.id, ticket)) return;
        // Put the pill back where it was: the row did not change.
        setChanged((prev) => {
          const rest = { ...prev };
          delete rest[row.id];
          return rest;
        });
        setAnnouncement('');
        setError(err instanceof Error ? err.message : 'Could not update that lead');
      }
    })();
  }

  return (
    <section className="rise panel mt-5 p-6 sm:p-8">
      {/* Heading, what you are looking at, and the one control — the same shape
          as the Approvals panel above it on the dashboard. */}
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
        <div>
          <h2 className="font-display text-[18px]">{title}</h2>
          <p className="plain mt-1">
            {summary ??
              (total > rows.length
                ? `Latest ${rows.length} of ${total.toLocaleString()}. Older leads live in your sheet.`
                : `${total.toLocaleString()} in total.`)}
          </p>
        </div>

        {rows.length > 0 ? (
          <>
            <label className="sr-only" htmlFor="lead-status">
              Filter leads by status
            </label>
            {/* The counts ride on the options rather than sitting beside them:
                together the options are the whole funnel, and they are read at
                the moment you go looking for one stage of it. */}
            <select
              id="lead-status"
              value={filter}
              onChange={(e) => choose(e.target.value as LeadFilter)}
              className="field w-auto"
            >
              {LEAD_FILTERS.map((key) => (
                <option key={key} value={key}>
                  {filterLabel(key)} {counts[key]}
                </option>
              ))}
            </select>
          </>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <p className="py-12 text-center text-[13px] text-ink-soft">{emptyBody}</p>
      ) : (
        <>
          {/* Instructions for a control this reader does not have are worse
              than no instructions, so an affiliate gets the reading of the
              statuses instead of the recipe for changing them. */}
          <StatusNote canEdit={canEdit} fromApprovals={fromApprovals} />

          {error ? (
            <p role="alert" className="field-error">
              {error}
            </p>
          ) : null}

          {approvedNote ? (
            <p className="mt-3 text-[13px] font-semibold text-leaf-text">{approvedNote}</p>
          ) : null}

          {matching.length === 0 ? (
            <p className="py-12 text-center text-[13px] text-ink-soft">{noLeadsText(filter)}</p>
          ) : (
            <TableScroller className="mt-5" label="Captured leads">
              <table className={`w-full border-collapse text-left ${minWidth}`}>
                <thead>
                  <tr className="bg-paper-card">
                    <Th>Lead</Th>
                    <Th>Contact</Th>
                    <Th>Campaign</Th>
                    {showAssignee ? <Th>Owner</Th> : null}
                    {showRef ? <Th>Ref</Th> : null}
                    <Th>Status</Th>
                    <Th>Card</Th>
                    <Th align="right">Captured</Th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((row) => (
                    <Fragment key={row.id}>
                    <tr className="divider-row last:border-0">
                      <td className="max-w-[200px] px-5 py-3.5">
                        <span className="block truncate text-[14px] font-medium">
                          {row.fullName || <span className="text-ink-dim">No name given</span>}
                        </span>
                      </td>

                      {/* Both of these are the point of capturing a lead, so
                          both are one click from here rather than one click
                          plus a selection. */}
                      <td className="max-w-[240px] px-5 py-3.5">
                        <a
                          href={`mailto:${row.email}`}
                          className="tnum block truncate text-[12px] text-link hover:underline"
                          title={row.email}
                        >
                          {row.email}
                        </a>
                        {row.phone ? (
                          <a
                            href={`tel:${row.phone.replace(/[^\d+]/g, '')}`}
                            className="tnum mt-0.5 block truncate text-[11px] text-ink-dim hover:underline"
                          >
                            {row.phone}
                          </a>
                        ) : null}
                      </td>

                      <td className="max-w-[200px] px-5 py-3.5">
                        <span
                          className="block truncate text-[14px] text-ink-soft"
                          title={row.campaign || row.slug}
                        >
                          {row.campaign || row.slug}
                        </span>
                      </td>

                      {showAssignee ? (
                        <td className="max-w-[160px] px-5 py-3.5">
                          <span className="block truncate text-[14px] text-ink-soft">
                            {row.assignee || 'Unassigned'}
                          </span>
                        </td>
                      ) : null}

                      {/* The value this lead was forwarded to the merchant
                          with. It is what turns up in the report's var3
                          column, so it is the thing to search for when an
                          approval needs tracing back to a person. */}
                      {showRef ? (
                        <td className="tnum px-5 py-3.5 text-[12px] text-ink-dim">
                          {isLeadId(row.id) ? row.id : 'None'}
                        </td>
                      ) : null}

                      {/* py-2.5: the pill is 30px and brings its own height, so
                          the same padding as the text cells would make this the
                          tallest cell in the row. */}
                      <td className="px-5 py-2.5">
                        {/* No toggle where an approval decides it: pressing it
                            would write a status the next render overrules,
                            which is a control that lies about what it does. */}
                        <div className="flex flex-wrap items-center gap-2">
                          {canEdit && !row.hasApproval ? (
                            <StatusToggle row={row} onToggle={(next) => setStatus(row, next)} />
                          ) : (
                            <StatusPill row={row} />
                          )}
                          {canApprove(row) ? (
                            <button
                              type="button"
                              className="btn-outline btn-sm"
                              aria-expanded={approvingId === row.id}
                              onClick={() => {
                                setApprovedNote('');
                                setApprovingId(approvingId === row.id ? null : row.id);
                              }}
                            >
                              Approve
                            </button>
                          ) : null}
                        </div>
                      </td>

                      {/* Beside the status because it is the detail of it:
                          applied for what, approved for what. */}
                      <td className="max-w-[220px] px-5 py-3.5">
                        <CardName card={row.card} />
                      </td>

                      {/* No .tnum here, unlike every other narrow column: "4
                          hrs ago" is a phrase, not a figure, and monospacing it
                          spaces the words out like a countdown. The exact
                          timestamp is on the title. */}
                      <td
                        className="whitespace-nowrap px-5 py-3.5 text-right text-[13px] text-ink-dim"
                        title={row.capturedAt}
                      >
                        {row.age}
                      </td>
                    </tr>
                    {/* Under its lead rather than in a dialog, so the name, the
                        owner and the card on record stay in view while the
                        approval is filled in. */}
                    {approving && approvingId === row.id && canApprove(row) ? (
                      <tr>
                        <td colSpan={columns} className="px-5 pb-5">
                          <ApproveLead
                            lead={row}
                            context={approving}
                            onDone={approved}
                            onCancel={() => setApprovingId(null)}
                          />
                        </td>
                      </tr>
                    ) : null}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </TableScroller>
          )}

          {/* The line above already says the filter found nothing, and
              says it better than a count of zero would. */}
          {matching.length > 0 ? (
            <Pager
              total={matching.length}
              page={page}
              perPage={perPage}
              onPage={setPage}
              onPerPage={setPerPage}
              label="Leads"
            />
          ) : null}

          <p role="status" aria-live="polite" className="sr-only left-0">
            {announcement}
          </p>
        </>
      )}
    </section>
  );
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      scope="col"
      className={`label-cap border-b border-edge px-5 py-2.5 text-[10px] ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </th>
  );
}

/**
 * What the three states mean, under the heading.
 *
 * Exported, like the pieces below it, because the panel calls useRouter and
 * cannot be rendered outside a Next request, so the wording is checked on its
 * own. Each state is named by statusLabel, the caption on its pill, so the
 * note and the table cannot call the same state two different things.
 */
export function StatusNote({ canEdit, fromApprovals }: { canEdit: boolean; fromApprovals: number }) {
  const pending = statusLabel('pending').toLowerCase();
  const applied = statusLabel('applied').toLowerCase();
  const approved = statusLabel('registered').toLowerCase();
  return (
    <p className="plain mt-3">
      {canEdit ? (
        <>
          Every lead starts <strong>{pending}</strong> and reads <strong>{applied}</strong> once a
          report sync finds their application, with the card they applied for in the Card column.
          Press <strong>Approve</strong> once they are approved, and pick the card: that records
          what it paid, and the affiliate&rsquo;s share of it. The report sync replaces it with
          QMP&rsquo;s own approval when that arrives.
        </>
      ) : (
        <>
          Every lead starts <strong>{pending}</strong>, reads <strong>{applied}</strong> once the
          merchant has their application, and is marked <strong>{approved}</strong> once they have
          signed up. The Card column says which card they applied for.
        </>
      )}{' '}
      {/* Said only when it applies. An explanation of something that is
          not happening on this list is one more line to read past. */}
      {fromApprovals > 0 ? (
        <>
          {fromApprovals === 1 ? 'One of them reads' : `${fromApprovals} of them read`}{' '}
          {approved} because there is an approval on file, which is the merchant confirming it
          went through. Removing the approval is what changes that back.
        </>
      ) : null}
    </p>
  );
}

/**
 * The card or cards a lead applied for, or the blank when no sync has seen
 * one. Cut to the column with the whole of it on the title, since a lead that
 * applied for two cards carries both names in the one cell.
 */
export function CardName({ card }: { card: string }) {
  const text = card.trim();
  if (!text) return <span className="text-[14px] text-ink-dim">{BLANK}</span>;
  return (
    <span className="block truncate text-[14px] text-ink-soft" title={text}>
      {text}
    </span>
  );
}

/**
 * The dot on each pill. A record, like the captions, so a status added later
 * cannot reach the table without one. Grey is pending, navy is applied (under
 * way, waiting on the merchant), green is approved and nothing else. Gold is
 * not a state: it marks totals.
 */
const DOTS: Record<LeadStatus, string> = {
  pending: 'var(--color-ink-dim)',
  applied: 'var(--color-navy-hi)',
  registered: 'var(--color-leaf-live)',
};

/**
 * The same pill with nothing to press. Not a disabled button: a disabled
 * control reads as "temporarily unavailable, try again", when the truth is that
 * this is simply not yours to change.
 */
export function StatusPill({ row }: { row: LeadRow }) {
  return (
    <span
      className="pill-status"
      data-status={row.status}
      title={row.hasApproval ? 'An approval is recorded against this lead.' : undefined}
    >
      <span
        aria-hidden
        className="h-2.5 w-2.5 flex-none rounded-full"
        style={{ background: DOTS[row.status] ?? DOTS.pending }}
      />
      {statusLabel(row.status)}
    </span>
  );
}

/**
 * No spinner and no disabled state.
 *
 * The pill already shows the new word by the time the pointer lifts, so there
 * is nothing left to wait for and nothing a spinner could truthfully report. It
 * stays pressable too: pressing again is somebody changing their mind, which is
 * a thing they are allowed to do faster than a spreadsheet can answer.
 *
 * Where a press sends the lead is nextManualStatus's call, made once here and
 * used for both the accessible name and the press, so the name cannot promise
 * one state while the click writes another.
 */
export function StatusToggle({
  row,
  onToggle,
}: {
  row: LeadRow;
  onToggle: (next: LeadStatus) => void;
}) {
  const next = nextManualStatus(row);
  // Nowhere to go, such as an applied lead with its card on record: a button
  // that does nothing is worse than a pill that does not claim to.
  if (next === null) return <StatusPill row={row} />;
  const who = row.fullName || row.email || 'this lead';
  return (
    <button
      type="button"
      className="pill-status"
      data-status={row.status}
      onClick={() => onToggle(next)}
      /* The visible word starts the accessible name so "click Pending" still
         works for voice control, and the rest says what clicking will do. */
      aria-label={`${statusLabel(row.status)}, mark ${who} as ${statusLabel(next).toLowerCase()}`}
    >
      <span
        aria-hidden
        className="h-2.5 w-2.5 flex-none rounded-full"
        style={{ background: DOTS[row.status] ?? DOTS.pending }}
      />
      {statusLabel(row.status)}
    </button>
  );
}
