'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Modal } from './Modal';
import { PayeeDetails } from './PayeeDetails';
import { RowMenu, RowMenuItem } from './RowMenu';
import { BusyLabel } from './Spinner';
import { TableScroller } from './TableScroller';
import { formatMoney, initialsOf } from '@/lib/analytics';
import { dayOf, shortDay } from '@/lib/payout';
import {
  awaitingPayment,
  canCancel,
  CANCEL_CONFIRM,
  cancelledMessage,
  describeCancelled,
  describeCardCount,
  describeRequested,
  countRequestsByStatus,
  filterRequests,
  groupRequests,
  matchesRequestFilter,
  mismatchNote,
  noRequestsText,
  paymentMessage,
  receiptMessage,
  REQUEST_FILTERS,
  REQUEST_SECTIONS,
  requestBody,
  requestFilterFrom,
  requestToggleId,
  statusChip,
  type Payee,
  type RequestCard,
  type RequestFilter,
  type RequestRow,
} from '@/lib/payout-admin';
import { BLANK } from '@/lib/report-table';

/**
 * The Requests tab: every payment an affiliate has asked for.
 *
 * There is no schedule any more. Each card turns requestable 45 days after it
 * is approved, the affiliate picks which ready cards to be paid for, and what
 * lands here is that choice: a request, with its cards and what they came to
 * when it was made. The admin's job on this page is to pay what was asked for,
 * write down that they did, and attach the evidence.
 *
 * Recording a payment and attaching its receipt still sit in one panel opened
 * from the row, for the reason the old schedule gave: they are one job done at
 * one moment. Send the transfer, screenshot it, write both down. The panel
 * lists the request's cards above the fields, so what is being paid for is in
 * front of whoever is paying it.
 *
 * Cancelling is behind the row's menu rather than on the row, and only on a
 * request nobody has paid. It is rare, it cannot be undone from here, and the
 * affiliate has to ask again afterwards, so it is asked about first and
 * reported once done.
 *
 * Grouping, sorting, totals, search and every sentence come from
 * lib/payout-admin, where they are checked. This file draws them and posts.
 */

type Draft = { amount: string; paidOn: string; reference: string; note: string };

export function PayoutRequests({
  rows,
  today,
  payees = {},
  status = 'all',
}: {
  rows: RequestRow[];
  today: string;
  /** Who each request is filed under, keyed by account id. See buildPayees. */
  payees?: Record<string, Payee>;
  /** Which section to show, read off the URL by the page. */
  status?: RequestFilter;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [, startTransition] = useTransition();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState('');
  const [busy, setBusy] = useState('');
  /** Which action is running on the busy row, so only its own button says so. */
  const [doing, setDoing] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState('');
  const [draft, setDraft] = useState<Draft>({ amount: '', paidOn: '', reference: '', note: '' });
  const fileInput = useRef<HTMLInputElement | null>(null);
  const statusLine = useRef<HTMLParagraphElement | null>(null);
  /** One post at a time. The pressed button is not disabled, so a second press reaches send(). */
  const inFlight = useRef(false);
  /** The row to put the keyboard back on, and the rows to wait past first (null: none to wait for). */
  const returnTo = useRef<{ id: string; after: RequestRow[] | null } | null>(null);

  /** The name search, which the status options are then counted over. */
  const matched = useMemo(() => filterRequests(rows, query), [rows, query]);
  const counts = useMemo(() => countRequestsByStatus(matched), [matched]);
  const shown = useMemo(
    () => matched.filter((row) => matchesRequestFilter(row, status)),
    [matched, status],
  );
  /** The request the dialog is showing, read back off the latest rows. */
  const openRowData = useMemo(() => rows.find((row) => row.id === open) ?? null, [rows, open]);
  const grouped = useMemo(() => groupRequests(shown), [shown]);

  /*
   * The chosen section lives in the URL, like every other filter here, so a
   * view of what is still to be paid can be bookmarked or passed to somebody.
   * Replaced rather than pushed: flipping between sections is looking at one
   * page, not walking through several, and the Back button should leave the
   * payouts page rather than retrace every pill that was pressed.
   */
  function choose(next: RequestFilter) {
    const query = new URLSearchParams(params.toString());
    if (next === 'all') query.delete('status');
    else query.set('status', next);
    const search = query.toString();
    startTransition(() => router.replace(search ? `${pathname}?${search}` : pathname, { scroll: false }));
  }

  /*
   * The figure somebody opens this page to find. Over what the search matched,
   * like the schedule it replaces: type a name and it becomes what that person
   * is waiting on.
   */
  const owed = useMemo(() => awaitingPayment(matched), [matched]);

  /*
   * Where the keyboard goes once an action is over, if the control that had it
   * is gone.
   *
   * The button that was pressed keeps focus while its request runs (see
   * PaymentFields), but the result can still take it away. Recording or
   * clearing a payment moves the row to another section, which React draws as
   * a new row; removing a receipt removes its button; cancelling takes the
   * row's menu away, trigger and all. A focused element that leaves the page
   * hands focus to the page itself, and the next Tab starts from the top.
   *
   * So once the refreshed rows have arrived, focus that has fallen through to
   * <body> goes to the row's own button, which every request has in every
   * section. Not before they arrive: until then that button is the old row's,
   * which the refresh is about to remove. A refusal refreshes nothing, so it
   * does not wait. Focus that is still somewhere real is left where it is.
   */
  useEffect(() => {
    const pending = returnTo.current;
    if (!pending || busy) return;
    if (pending.after === rows) return;
    returnTo.current = null;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    (document.getElementById(requestToggleId(pending.id)) ?? statusLine.current)?.focus();
  });

  function openRow(row: RequestRow) {
    setError(null);
    setProblems({});
    setSaved('');
    if (open === row.id) {
      setOpen('');
      return;
    }
    setOpen(row.id);
    setDraft({
      /*
       * Prefilled with what the request came to, because that is what is about
       * to be sent nine times in ten. Editable because the tenth is a transfer
       * that was rounded, split, or settled against something else, and the
       * mismatch banner says so once it is saved.
       */
      amount: row.amount !== null ? String(row.amount) : String(row.totalAmount || ''),
      paidOn: row.paidAt ? dayOf(row.paidAt) : today,
      reference: row.reference,
      note: row.note,
    });
  }

  /** Post one action about one request. True when the server accepted it. */
  async function send(row: RequestRow, body: Record<string, unknown>, done: string): Promise<boolean> {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(row.id);
    setDoing(typeof body.action === 'string' ? body.action : '');
    setError(null);
    setProblems({});
    setSaved('');
    try {
      const res = await fetch('/api/payouts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requestBody(row.id, body)),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setProblems((payload.fields ?? {}) as Record<string, string>);
        throw new Error(
          payload.hint
            ? `${payload.error} ${payload.hint}`
            : payload.error ?? `That did not save (${res.status})`,
        );
      }
      setSaved(done);
      returnTo.current = { id: row.id, after: rows };
      startTransition(() => router.refresh());
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That did not save.');
      returnTo.current = { id: row.id, after: null };
      return false;
    } finally {
      inFlight.current = false;
      setBusy('');
      setDoing('');
    }
  }

  async function attach(row: RequestRow, file: File) {
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.onerror = () => reject(new Error('unreadable'));
      reader.readAsDataURL(file);
    }).catch(() => '');

    if (!data) {
      setError('That file could not be read. Try attaching it again.');
      return;
    }
    await send(
      row,
      { action: 'proof', name: file.name, type: file.type, data },
      receiptMessage(row.name, Boolean(row.proof)),
    );
  }

  async function cancel(row: RequestRow) {
    if (inFlight.current || !confirm(CANCEL_CONFIRM)) return;
    const done = await send(row, { action: 'cancel' }, cancelledMessage(row.name));
    // Its row moves to Cancelled on the refresh, so a panel left open would be
    // a payment form on a request that can no longer be paid.
    if (done && open === row.id) setOpen('');
  }

  return (
    <>
      <div className="mt-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <label className="block w-full max-w-[320px]">
          <span className="field-label">Find someone</span>
          <input
            className="field mt-1.5"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Name or tracking key"
            autoComplete="off"
          />
        </label>

        {/* Named for what it does to the list below, and counted over whatever
            the search above it has already found. */}
        <nav aria-label="Filter requests by status" className="flex flex-wrap items-center gap-2">
          {REQUEST_FILTERS.map((option) => (
            <button
              key={option.key}
              type="button"
              className="pill-filter"
              data-active={option.key === status}
              aria-pressed={option.key === status}
              onClick={() => choose(option.key)}
            >
              {option.label}
              <span className="tnum text-[11px]">{counts[option.key]}</span>
            </button>
          ))}
        </nav>

        {/*
          The one figure this page exists to answer, set against the gold
          highlighter rather than in a coloured box. That is the only thing gold
          does in this app.
        */}
        <p className="text-right">
          <span className="field-label">Awaiting payment</span>
          <span className="mark tnum mt-1 block text-[26px] font-semibold leading-none">
            {formatMoney(owed)}
          </span>
        </p>
      </div>

      {error ? (
        <p role="alert" className="warn-note mt-5">
          <span aria-hidden className="warn-note-mark">
            ⚠
          </span>
          <span>{error}</span>
        </p>
      ) : null}
      {/* In the page from the start, so a screen reader is already listening
          when there is something to say. Hidden while it is empty. */}
      <p
        ref={statusLine}
        tabIndex={-1}
        role="status"
        className="mt-5 text-[13px] font-semibold text-leaf-text empty:hidden"
      >
        {saved}
      </p>

      {shown.length === 0 ? (
        <p className="panel mt-5 px-5 py-14 text-center text-[13px] text-ink-soft">
          {/* The search has an answer of its own; a status with nothing in it
              is a different thing to say, and says which status. */}
          {matched.length === 0
            ? noRequestsText(rows.length, query)
            : `Nothing under ${REQUEST_FILTERS.find((option) => option.key === status)?.label}.`}
        </p>
      ) : null}

      {REQUEST_SECTIONS.map((meta) => {
        const list = grouped[meta.key];
        if (list.length === 0) return null;

        return (
          <section key={meta.key} className="panel mt-5 overflow-hidden">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-edge bg-paper-card px-5 py-3.5">
              <h2 className="text-[14px] font-semibold text-ink">{meta.label}</h2>
              <span className="tnum text-[12px] text-ink-dim">{list.length}</span>
              <p className="w-full text-[12px] text-ink-dim sm:w-auto">{meta.blurb}</p>
            </div>

            <ul>
              {list.map((row) => {
                const working = busy === row.id;
                const chip = statusChip(row.status);
                const mismatch = mismatchNote(row);
                const when = row.status === 'cancelled' ? describeCancelled(row) : describeRequested(row);

                return (
                  <li key={row.id} className="border-b border-edge-faint last:border-b-0">
                    <div className="flex flex-wrap items-center gap-x-5 gap-y-3 px-5 py-4">
                      <span
                        aria-hidden
                        className="flex h-[30px] w-[30px] flex-none items-center justify-center bg-paper-sunk text-[11px] font-semibold text-ink-dim"
                      >
                        {initialsOf(row.name)}
                      </span>

                      <span className="min-w-[150px] flex-1">
                        <span className="block text-[13px] font-semibold text-ink">{row.name}</span>
                        <span className="tnum block text-[11px] text-ink-dim">
                          {row.usr ? `usr=${row.usr}` : 'No tracking key'}
                        </span>
                      </span>

                      {/* When, and who by. A request filed from Client View
                          carries the admin's name here, which is the only place
                          that shows. */}
                      <span className="min-w-[170px] flex-1">
                        <span className="tnum block text-[13px] text-ink">{when.when}</span>
                        <span className="block text-[11px] text-ink-dim">{when.by}</span>
                      </span>

                      <span className="w-[110px] flex-none text-right">
                        <span className="tnum block text-[15px] font-semibold text-ink">
                          {formatMoney(row.totalAmount)}
                        </span>
                        <span className="block text-[11px] text-ink-dim">
                          {describeCardCount(row.cards.length)}
                        </span>
                      </span>

                      <span className="flex flex-none flex-wrap items-center gap-2">
                        <span className={chip.className}>{chip.label}</span>
                        {row.confirmedAt ? <span className="chip chip-quiet">Confirmed</span> : null}
                        {row.proof ? (
                          <a
                            href={`/api/payouts/receipt?request=${encodeURIComponent(row.id)}`}
                            target="_blank"
                            rel="noreferrer"
                            className="chip chip-quiet"
                          >
                            Receipt
                          </a>
                        ) : row.status === 'paid' ? (
                          <span className="chip chip-gold">No receipt</span>
                        ) : null}

                        <button
                          id={requestToggleId(row.id)}
                          type="button"
                          className="btn-outline btn-sm"
                          aria-haspopup="dialog"
                          onClick={() => openRow(row)}
                        >
                          {row.status === 'cancelled'
                            ? 'Show cards'
                            : row.status === 'paid'
                              ? 'Edit payment'
                              : 'Approve payment'}
                        </button>

                        {canCancel(row.status) ? (
                          <RowMenu
                            label={`More actions for ${row.name}`}
                            /* Held while the panel saves something, but not
                               while its own cancel runs: the menu handed the
                               keyboard back to this button as it closed, and
                               disabling it would throw that away. */
                            disabled={working && doing !== 'cancel'}
                            busy={working && doing === 'cancel'}
                            busyLabel={`Working on the request for ${row.name}`}
                          >
                            {(close) => (
                              <RowMenuItem
                                disabled={working}
                                onClick={() => {
                                  close();
                                  void cancel(row);
                                }}
                              >
                                Cancel request
                              </RowMenuItem>
                            )}
                          </RowMenu>
                        ) : null}
                      </span>
                    </div>

                    {mismatch ? (
                      <p className="border-t border-gold-wash bg-gold-faint px-5 py-2.5 text-[12px] text-gold-deep">
                        {mismatch}
                      </p>
                    ) : null}

                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}

      {/*
        One dialog for the whole list rather than one per row: only one request
        is ever being approved, and a dialog per row would put fifty of them in
        the page for the one that is open.
      */}
      {openRowData ? (
        <Modal
          open
          title={
            openRowData.status === 'cancelled'
              ? `Cards on ${openRowData.name}'s cancelled request`
              : openRowData.status === 'paid'
                ? `Edit ${openRowData.name}'s payment`
                : `Approve payment for ${openRowData.name}`
          }
          onClose={() => setOpen('')}
        >
            {/* Who, before what: the details are what the amount is checked
                against, and they are read in that order. */}
            {openRowData.status === 'cancelled' ? null : (
              <PayeeDetails payee={payees[openRowData.userId] ?? null} />
            )}

            <div className="mt-5">
              <RequestCards cards={openRowData.cards} total={openRowData.totalAmount} />
            </div>

            {openRowData.status === 'cancelled' ? (
              <p className="plain mt-4 text-[12px]">
                This request was withdrawn before it was paid, so these cards are free to be
                requested again.
              </p>
            ) : (
              <PaymentFields
                row={openRowData}
                today={today}
                draft={draft}
                setDraft={setDraft}
                problems={problems}
                working={busy === openRowData.id}
                doing={doing}
                fileInput={fileInput}
                onPay={() =>
                  send(
                    openRowData,
                    {
                      action: 'pay',
                      amount: Number(draft.amount),
                      paidOn: draft.paidOn,
                      reference: draft.reference,
                      note: draft.note,
                    },
                    paymentMessage(openRowData.name, openRowData.status === 'paid'),
                  ).then((done) => {
                    // Closed only once the payment landed. A refusal keeps the
                    // dialog open on the fields that were refused.
                    if (done) setOpen('');
                    return done;
                  })
                }
                onAttach={(file) => void attach(openRowData, file)}
                onRemoveProof={() =>
                  send(openRowData, { action: 'remove-proof' }, `Receipt removed for ${openRowData.name}.`)
                }
                onClear={() =>
                  send(openRowData, { action: 'clear' }, `Payment cleared for ${openRowData.name}.`)
                }
              />
            )}
        </Modal>
      ) : null}
    </>
  );
}

/**
 * The payment half of an open request: what was sent, when, and the receipt.
 *
 * A component of its own to keep the row readable, and exported so the render
 * checks can draw it: it opens on a click, which a static render cannot make.
 * Every piece of state it touches belongs to PayoutRequests, which is the only
 * thing that posts.
 *
 * While an action runs, the button that was pressed says what it is doing and
 * is marked busy, but is never disabled. It has the keyboard, since Enter was
 * just pressed on it, and a focused button that turns disabled throws focus
 * back to the top of the page. The other buttons are disabled, which is what
 * shows the row is busy, and nobody is on them to lose. A press on the busy
 * button does nothing: its handler is taken away, and send() refuses a second
 * post besides.
 */
export function PaymentFields({
  row,
  today,
  draft,
  setDraft,
  problems,
  working,
  doing,
  fileInput,
  onPay,
  onAttach,
  onRemoveProof,
  onClear,
}: {
  row: RequestRow;
  today: string;
  draft: Draft;
  setDraft: (draft: Draft) => void;
  problems: Record<string, string>;
  working: boolean;
  /** The action running on this row ('pay', 'proof', 'remove-proof', 'clear', 'cancel'), '' when none. */
  doing: string;
  fileInput: { current: HTMLInputElement | null };
  onPay: () => void;
  onAttach: (file: File) => void;
  onRemoveProof: () => void;
  onClear: () => void;
}) {
  const paid = row.status === 'paid';
  /** This button's own action is the one running. */
  const pressed = (action: string) => working && doing === action;
  /** Something else on this row is running. */
  const held = (action: string) => working && doing !== action;
  return (
    <>
      <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block">
          <span className="field-label">Amount sent</span>
          <input
            className="field tnum mt-1.5"
            type="number"
            min={0}
            step="0.01"
            inputMode="decimal"
            value={draft.amount}
            onChange={(event) => setDraft({ ...draft, amount: event.target.value })}
            aria-invalid={problems.amount ? true : undefined}
          />
          {problems.amount ? <span className="field-error">{problems.amount}</span> : null}
        </label>

        <label className="block">
          <span className="field-label">Day it was sent</span>
          {/* Not before the request was made, which the route refuses too:
              a payment cannot answer a request nobody had made yet. */}
          <input
            className="field mt-1.5"
            type="date"
            min={dayOf(row.requestedAt) || undefined}
            max={today}
            value={draft.paidOn}
            onChange={(event) => setDraft({ ...draft, paidOn: event.target.value })}
            aria-invalid={problems.paidOn ? true : undefined}
          />
          {problems.paidOn ? <span className="field-error">{problems.paidOn}</span> : null}
        </label>

        <label className="block">
          <span className="field-label">
            Reference <span className="font-normal text-ink-dim">(optional)</span>
          </span>
          <input
            className="field mt-1.5"
            value={draft.reference}
            onChange={(event) => setDraft({ ...draft, reference: event.target.value })}
            placeholder="ACH 4821"
            maxLength={120}
          />
        </label>

        <label className="block">
          <span className="field-label">
            Note <span className="font-normal text-ink-dim">(optional)</span>
          </span>
          <input
            className="field mt-1.5"
            value={draft.note}
            onChange={(event) => setDraft({ ...draft, note: event.target.value })}
            maxLength={500}
          />
        </label>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn-primary btn-sm"
          disabled={held('pay')}
          aria-disabled={pressed('pay') || undefined}
          aria-busy={pressed('pay')}
          onClick={working ? undefined : onPay}
        >
          <BusyLabel busy={pressed('pay')} idle={paid ? 'Save payment' : 'Record payment'} busyLabel="Saving…" />
        </button>

        {/* One job, one panel: the transfer and the evidence for it are
            written down at the same moment. */}
        <input
          ref={fileInput}
          type="file"
          className="sr-only"
          /* Out of the tab order: the button beside it is the control, and this
             is only how that button opens a file picker. As a tab stop it
             would be one nobody can see. Named all the same, for a screen
             reader that walks the page rather than tabbing it. */
          tabIndex={-1}
          aria-label={row.proof ? `Replace the receipt for ${row.name}` : `Attach a receipt for ${row.name}`}
          accept="image/png,image/jpeg,image/webp,application/pdf"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) onAttach(file);
          }}
        />
        <button
          type="button"
          className="btn-outline btn-sm"
          disabled={held('proof')}
          aria-disabled={pressed('proof') || undefined}
          aria-busy={pressed('proof')}
          onClick={working ? undefined : () => fileInput.current?.click()}
        >
          <BusyLabel
            busy={pressed('proof')}
            idle={row.proof ? 'Replace receipt' : 'Attach receipt'}
            busyLabel={row.proof ? 'Replacing…' : 'Attaching…'}
          />
        </button>

        {row.proof ? (
          <button
            type="button"
            className="btn-quiet btn-sm"
            disabled={held('remove-proof')}
            aria-disabled={pressed('remove-proof') || undefined}
            aria-busy={pressed('remove-proof')}
            onClick={working ? undefined : onRemoveProof}
          >
            <BusyLabel busy={pressed('remove-proof')} idle="Remove receipt" busyLabel="Removing…" />
          </button>
        ) : null}

        {paid ? (
          <button
            type="button"
            className="btn-quiet btn-sm"
            disabled={held('clear')}
            aria-disabled={pressed('clear') || undefined}
            aria-busy={pressed('clear')}
            onClick={working ? undefined : onClear}
          >
            <BusyLabel busy={pressed('clear')} idle="Clear payment" busyLabel="Clearing…" />
          </button>
        ) : null}
      </div>

      <p className="plain mt-4 text-[12px]">
        {row.proof
          ? `Receipt on file: ${row.proof.name}. They can open it from their own payslip too.`
          : 'A photo of the transfer or a PDF from the bank, up to about 2.5 MB. It shows on their payslip as proof of payment.'}
        {row.paidBy ? ` Last recorded by ${row.paidBy}.` : ''}
      </p>
    </>
  );
}

/**
 * The cards on one request, read only.
 *
 * Each amount is the one the request recorded when it was made, and the total
 * is the request's own fixed total rather than a sum done here, so this list
 * says exactly what the affiliate asked for even if an approval has changed
 * since. A line whose approval is gone keeps its amount and reads blank.
 *
 * Four columns from sm up. Below it the customer and the day go under the card
 * and the amount keeps a column of its own, so nobody paying from a phone has
 * to scroll sideways to see what they are paying. The words that move are
 * written once for each width and hidden at the other, so a screen reader
 * reads each of them once.
 *
 * Just above sm, up to a screen about 670px wide, the four columns are a few
 * pixels wider than the panel. TableScroller draws its buttons there to reach
 * the amounts, as it did before the phone layout existed.
 *
 * Exported so the render checks can draw it: the panel it sits in opens on a
 * click, which a static render cannot make.
 */
export function RequestCards({ cards, total }: { cards: RequestCard[]; total: number }) {
  return (
    <TableScroller label="Cards on this request">
      <table className="w-full text-left text-[13px]">
        <thead>
          <tr className="border-b border-edge">
            <th scope="col" className="label-cap py-2 pr-4">Card</th>
            <th scope="col" className="label-cap hidden py-2 pr-4 sm:table-cell">Customer</th>
            <th scope="col" className="label-cap hidden py-2 pr-4 sm:table-cell">Approved</th>
            <th scope="col" className="label-cap py-2 text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {cards.map((card, index) => (
            <tr key={card.conversionId ?? `released-${index}`} className="divider-row">
              <td className="py-2 pr-4 text-ink max-sm:wrap-anywhere">
                {card.card}
                <span className="block text-[12px] text-ink-soft sm:hidden">{card.customer}</span>
                {/* A line whose approval is gone has no day to give, and a line
                    saying only that would be a line about nothing. */}
                {card.approvedOn ? (
                  <span className="block text-[12px] text-ink-dim sm:hidden">
                    Approved <span className="tnum whitespace-nowrap">{shortDay(card.approvedOn)}</span>
                  </span>
                ) : null}
              </td>
              <td className="hidden py-2 pr-4 text-ink-soft sm:table-cell">{card.customer}</td>
              <td className="tnum hidden py-2 pr-4 text-ink-soft sm:table-cell">
                {card.approvedOn ? shortDay(card.approvedOn) : BLANK}
              </td>
              <td className="tnum whitespace-nowrap py-2 text-right text-ink">{formatMoney(card.amount)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            {/* Across the three columns before the amount from sm up. A phone
                has one column there, and a cell still spanning three would
                push the total two columns past the amounts it adds up, so the
                words are a cell for each width. */}
            <th
              scope="row"
              colSpan={3}
              className="hidden py-2 pr-4 text-left text-[13px] font-semibold text-ink sm:table-cell"
            >
              Total requested
            </th>
            <th scope="row" className="py-2 pr-4 text-left text-[13px] font-semibold text-ink sm:hidden">
              Total requested
            </th>
            <td className="tnum whitespace-nowrap py-2 text-right font-semibold text-ink">{formatMoney(total)}</td>
          </tr>
        </tfoot>
      </table>
    </TableScroller>
  );
}
