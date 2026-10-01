'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { BusyLabel } from './Spinner';
import { TableScroller } from './TableScroller';
import { formatMoney } from '@/lib/analytics';
import { PAYOUT_DAYS } from '@/lib/payout';
import { describeSelection } from '@/lib/payout-request';
import {
  chosenRows,
  keepListed,
  nothingReadyText,
  selectAllState,
  SUCCESS_MESSAGE,
  toggleAll,
  toggleOne,
  type CardRow,
  type CountdownRow,
  type RequestRow,
} from '@/lib/payslip-view';

/**
 * The affiliate's side of payout requests: choosing which ready cards to be
 * paid for, and seeing what became of the requests already made.
 *
 * Every card runs on its own clock, so there is no payday to wait for and
 * nothing is paid until somebody asks. This is where they ask. The ready cards
 * are a real table with a checkbox column rather than the card rows the admin
 * pages use, because a select-all box has to sit over the boxes it selects, and
 * a running total has to say what the button is about to send before anybody
 * presses it.
 *
 * The rows arrive already shaped by lib/payslip-view: the card, the customer,
 * the day and the reader's own money, and nothing else. Nothing in this file
 * works a figure out; it adds up figures it was handed.
 *
 * RequestPayment calls useRouter, which cannot be mounted outside a Next
 * request, so the table it draws is exported on its own as well, taking its
 * state as props. That is what scripts/payslip-render-checks.tsx renders to see
 * every state the table can be in without clicking towards it.
 */

type TableProps = {
  rows: CardRow[];
  selected: ReadonlySet<string>;
  busy: boolean;
  /** Good news from the last request, '' when there is none. */
  message: string;
  /** The server's refusal, word for word, or null. */
  error: string | null;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
  onSubmit: () => void;
};

const SELECT_ALL = 'Select every card ready to request';

const UNREACHABLE = 'Ledger could not be reached, so nothing was requested. Check your connection and try again.';
const REFUSED = 'That did not go through, so nothing was requested. Try again.';

export function RequestPayment({ rows }: { rows: CardRow[] }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);

  /*
   * A ref, not the button. The button is never disabled while it sends (see
   * the table), and a double click lands both clicks before React renders
   * anyway; a second request for the same cards would come back as a conflict
   * and read as a failure of the first.
   */
  const sending = useRef(false);

  const ids = useMemo(() => rows.map((row) => row.id), [rows]);

  /*
   * After a refresh the list can be shorter than the selection: a card went
   * onto a request from another tab, or this one. Dropping it here means the
   * card comes back unticked if it is ever listed again, rather than quietly
   * selected. The table never counts it in the meantime either.
   */
  useEffect(() => {
    setSelected((current) => keepListed(current, ids));
  }, [ids]);

  function onToggle(id: string) {
    setMessage('');
    setError(null);
    setSelected((current) => toggleOne(current, id));
  }

  function onToggleAll() {
    setMessage('');
    setError(null);
    setSelected((current) => toggleAll(current, ids));
  }

  async function onSubmit() {
    const chosen = chosenRows(rows, selected);
    if (sending.current || chosen.length === 0) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    setMessage('');

    try {
      let res: Response;
      try {
        res = await fetch('/api/payslips', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'request', conversionIds: chosen.map((row) => row.id) }),
        });
      } catch {
        setError(UNREACHABLE);
        return;
      }

      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        const said = typeof payload.error === 'string' && payload.error ? payload.error : REFUSED;
        setError(typeof payload.hint === 'string' && payload.hint ? `${said} ${payload.hint}` : said);
        /*
         * A refusal about the cards themselves (one already on a request, one
         * not old enough) means the list on screen is out of date. Refreshing
         * it shows the truth, and the effect above drops whatever left.
         */
        if (res.status === 409 || res.status === 422) startTransition(() => router.refresh());
        return;
      }

      setSelected(new Set());
      setMessage(SUCCESS_MESSAGE);
      startTransition(() => router.refresh());
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  return (
    <RequestPaymentTable
      rows={rows}
      selected={selected}
      busy={busy}
      message={message}
      error={error}
      onToggle={onToggle}
      onToggleAll={onToggleAll}
      onSubmit={onSubmit}
    />
  );
}

/**
 * The ready list, its running total and its button, drawn from props alone.
 *
 * What is counted is what is listed and ticked, never the size of the set, so a
 * card that left the list cannot add itself to the total or to the request.
 */
export function RequestPaymentTable({
  rows,
  selected,
  busy,
  message,
  error,
  onToggle,
  onToggleAll,
  onSubmit,
}: TableProps) {
  const ids = rows.map((row) => row.id);
  const chosen = chosenRows(rows, selected);
  const state = selectAllState(selected, ids);
  const statusLine = useRef<HTMLParagraphElement | null>(null);

  /*
   * Where the keyboard goes once a request has gone through. Clearing the
   * selection leaves the button nothing to send, so it turns disabled, and a
   * request for every ready card empties the list, so the button is gone.
   * Either way the focus it had would fall back to the top of the page. The
   * sentence saying it worked is always in the page, and is the next thing
   * worth reading.
   */
  useEffect(() => {
    if (message) statusLine.current?.focus();
  }, [message]);

  /*
   * One live region for both things worth announcing. The good news stays
   * until somebody starts choosing again, then gives way to the total, which is
   * the thing they need to hear from then on. With nothing listed there is no
   * total to give, only the news, if any.
   */
  const said =
    rows.length === 0 ? message : message && chosen.length === 0 ? message : describeSelection(chosen);

  return (
    <section className="panel mt-5 p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-[14px] font-semibold text-ink">Ready to request</h2>
        {rows.length > 0 ? <span className="tnum text-[12px] text-ink-dim">{rows.length}</span> : null}
      </div>
      <p className="plain mt-1">
        Each of these was approved at least {PAYOUT_DAYS} days ago. Tick the cards you want to be paid
        for, then request payment.
      </p>

      {rows.length === 0 ? (
        <p className="panel-sunk mt-4 px-5 py-10 text-center text-[13px] text-ink-soft">
          {nothingReadyText()}
        </p>
      ) : (
        <TableScroller className="mt-4" label="Cards ready to request">
          {/*
            Five columns from sm up. Below it there are three: the box, the card
            with its customer and day under it, and the money in a column of its
            own. Asked to be 640px wide on a phone, the table showed the box and
            half a card name, and an affiliate could tick cards without seeing
            what any of them paid.

            One table either way, with one row and one box per card. The
            customer and the day are written once for each width, and each copy
            is display:none at the other, so a screen reader reads them once.

            On a phone the padding is cut to what keeps the columns apart, and
            the box column to its 44px target, because every pixel of either
            comes out of the card name.

            From sm up the five columns are the ones this table always had,
            padding and all, and they need a window about 770px wide. So from sm
            to a screen about 860px wide, a tablet held upright for one, they
            still overflow, and the money is reached the way it always was
            there: by scrolling the window, with TableScroller's Left and Right
            buttons drawn above it for exactly that. Stacking the columns up to
            a wider breakpoint would take them away from every screen in that
            range, so the switch stays at sm.
          */}
          <table className="w-full border-collapse text-left sm:min-w-[640px]">
            <thead>
              <tr className="bg-paper-card">
                <th scope="col" className="w-11 border-b border-edge px-0 py-0.5 sm:w-[56px] sm:px-2">
                  {/* The whole cell is the target, not just the box: 44px is
                      what a thumb actually hits. */}
                  <label className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center">
                    <input
                      type="checkbox"
                      className="h-5 w-5"
                      aria-label={SELECT_ALL}
                      checked={state === 'all'}
                      data-selection={state}
                      /* Part way is a property, not an attribute, so it can only
                         be set on the element once it exists. */
                      ref={(element) => {
                        if (element) element.indeterminate = state === 'some';
                      }}
                      disabled={busy}
                      onChange={onToggleAll}
                    />
                  </label>
                </th>
                <Th className="pl-1 pr-3 sm:px-5">Card</Th>
                <Th className="hidden px-5 sm:table-cell">Customer</Th>
                <Th className="hidden px-5 sm:table-cell">Approved</Th>
                <Th align="right" className="pl-0 pr-3 sm:px-5">
                  Amount
                </Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const on = selected.has(row.id);
                return (
                  <tr key={row.id} className={`divider-row last:border-0 ${on ? 'bg-paper-card' : ''}`}>
                    <td className="px-0 py-0.5 sm:px-2">
                      <label className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center">
                        <input
                          type="checkbox"
                          className="h-5 w-5"
                          aria-label={row.label}
                          checked={on}
                          disabled={busy}
                          onChange={() => onToggle(row.id)}
                        />
                      </label>
                    </td>
                    {/* From sm up the name is cut to one line, with the rest in
                        its title. A phone has the height to spare and none of
                        the width, so there it wraps, and a name with no spaces
                        in it breaks where it has to rather than pushing the
                        money off the edge. */}
                    <td className="max-w-[240px] py-3 pl-1 pr-3 max-sm:wrap-anywhere sm:px-5">
                      <span className="block text-[14px] font-medium text-ink sm:truncate" title={row.card}>
                        {row.card}
                      </span>
                      <span className="mt-0.5 block text-[13px] text-ink-soft sm:hidden">{row.customer}</span>
                      <span className="mt-0.5 block text-[12px] text-ink-dim sm:hidden">
                        Approved <span className="tnum whitespace-nowrap">{row.approved}</span>
                      </span>
                    </td>
                    <td className="hidden max-w-[200px] px-5 py-3 sm:table-cell">
                      <span className="block truncate text-[14px] text-ink-soft" title={row.customer}>
                        {row.customer}
                      </span>
                    </td>
                    <td className="tnum hidden whitespace-nowrap px-5 py-3 text-[13px] text-ink-soft sm:table-cell">
                      {row.approved}
                    </td>
                    <td className="tnum whitespace-nowrap py-3 pl-0 pr-3 text-right text-[14px] font-semibold text-ink sm:px-5">
                      {formatMoney(row.amount)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroller>
      )}

      {error ? (
        <p role="alert" className="field-error mt-4">
          {error}
        </p>
      ) : null}

      <div
        className={`flex flex-wrap items-center justify-between gap-x-5 gap-y-3 ${
          said || rows.length > 0 ? 'mt-4' : ''
        }`}
      >
        {/* Always in the page, even empty: a live region that appears at the
            same moment as its text is one a screen reader may never announce. */}
        <p
          ref={statusLine}
          tabIndex={-1}
          role="status"
          aria-live="polite"
          className="tnum text-[13px] font-semibold text-ink"
        >
          {said}
        </p>

        {rows.length > 0 ? (
          <button
            type="button"
            className="btn-primary"
            /* Marked busy while it sends, never disabled: it has the keyboard,
               since Enter was just pressed on it, and a focused button that
               turns disabled throws focus back to the top of the page. The
               sending ref in RequestPayment is what stops a second request. */
            disabled={!busy && chosen.length === 0}
            aria-disabled={busy || undefined}
            aria-busy={busy}
            onClick={busy ? undefined : onSubmit}
          >
            <BusyLabel busy={busy} idle="Request payment" busyLabel="Requesting…" />
          </button>
        ) : null}
      </div>
    </section>
  );
}

/**
 * The cards not old enough to ask for yet, soonest first.
 *
 * Nothing to tick, because there is nothing anybody can do about them but wait.
 * Each says how long and which day, since "12 days left" is arithmetic and the
 * day is what goes in a calendar. Drawn only when there is something counting:
 * an empty section here would be a heading over nothing.
 */
export function CountingDown({ rows }: { rows: CountdownRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="panel mt-5 overflow-hidden">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-edge bg-paper-card px-5 py-3.5">
        <h2 className="text-[14px] font-semibold text-ink">Counting down</h2>
        <span className="tnum text-[12px] text-ink-dim">{rows.length}</span>
        <p className="w-full text-[12px] text-ink-dim sm:w-auto">
          Not old enough to request yet. Each moves up to the list above on the day shown.
        </p>
      </div>

      <ul>
        {rows.map((row) => (
          <li
            key={row.id}
            className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-edge-faint px-5 py-3.5 last:border-b-0"
          >
            <span className="min-w-[180px] flex-1">
              <span className="block text-[13px] font-semibold text-ink">{row.card}</span>
              <span className="block text-[11px] text-ink-dim">{row.customer}</span>
            </span>

            <span className="tnum min-w-[110px] text-[12px] text-ink-soft">Approved {row.approved}</span>

            <span className="tnum w-[90px] flex-none text-right text-[14px] font-semibold text-ink">
              {formatMoney(row.amount)}
            </span>

            {/* Phrases, not figures, so not monospaced: a countdown set in a
                fixed-width face reads like a clock ticking. */}
            <span className="min-w-[140px] flex-none">
              <span className="block text-[13px] font-semibold text-ink">{row.countdown}</span>
              <span className="block text-[11px] text-ink-dim">{row.readyDay}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The requests already made, newest first, each a door to its payslip.
 *
 * The same row shape the admin pages use rather than a table, since every row
 * holds the same few things and a phone has no room for columns. The chip says
 * where it stands in words as well as colour.
 */
export function YourRequests({ rows }: { rows: RequestRow[] }) {
  return (
    <section className="panel mt-5 overflow-hidden">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-edge bg-paper-card px-5 py-3.5">
        <h2 className="text-[14px] font-semibold text-ink">Your payments</h2>
        {rows.length > 0 ? <span className="tnum text-[12px] text-ink-dim">{rows.length}</span> : null}
        <p className="w-full text-[12px] text-ink-dim sm:w-auto">
          Each monthly payout we send, with its payslip and receipt. Open one to confirm the money arrived.
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="px-5 py-10 text-center text-[13px] text-ink-soft">
          No payments yet. Your first one comes with the next monthly payout.
        </p>
      ) : (
        <ul>
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center gap-x-5 gap-y-3 border-b border-edge-faint px-5 py-4 last:border-b-0"
            >
              <span className="min-w-[160px] flex-1">
                <span className="block text-[13px] font-semibold text-ink">{row.requested}</span>
                <span className="block text-[11px] text-ink-dim">{row.cards}</span>
              </span>

              <span className="tnum w-[110px] flex-none text-right text-[15px] font-semibold text-ink">
                {formatMoney(row.total)}
              </span>

              <span className="flex min-w-[150px] flex-none flex-wrap items-center gap-2">
                <span className={`chip ${row.chip.className}`}>{row.chip.label}</span>
                {row.outcome ? <span className="text-[11px] text-ink-dim">{row.outcome}</span> : null}
              </span>

              <Link href={row.href} className="btn-outline btn-sm ml-auto">
                View payslip
                {/* Three links called "View payslip" are three identical links
                    to a screen reader. This says which one. */}
                <span className="sr-only">
                  , {row.cards} {row.requested.charAt(0).toLowerCase() + row.requested.slice(1)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Th({
  children,
  align = 'left',
  className,
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
  /** Its padding, and the widths it is drawn at, which differ by column. */
  className: string;
}) {
  return (
    <th
      scope="col"
      className={`label-cap border-b border-edge py-2.5 text-[10px] ${
        align === 'right' ? 'text-right' : 'text-left'
      } ${className}`}
    >
      {children}
    </th>
  );
}
