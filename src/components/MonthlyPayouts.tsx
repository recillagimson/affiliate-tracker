'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Modal } from './Modal';
import { PayeeDetails } from './PayeeDetails';
import { BusyLabel } from './Spinner';
import { formatMoney, initialsOf } from '@/lib/analytics';
import { shortDay, totalOf } from '@/lib/payout';
import { describeCardCount, describeMonthly, type MonthlyRow, type Payee } from '@/lib/payout-admin';
import { BLANK } from '@/lib/report-table';

/**
 * The Monthly tab: every affiliate with unpaid approvals, and the total owed.
 *
 * Payroll opens an affiliate, checks who and where the money goes, keeps the
 * approvals this transfer covers ticked (all of them by default), and records
 * it with the date, a reference and the receipt. That is one post to
 * /api/payouts/monthly, which writes a paid payout covering exactly the ticked
 * cards, so afterwards everybody can see which approvals were paid and when.
 */
export function MonthlyPayouts({
  rows,
  payees,
  today,
}: {
  rows: MonthlyRow[];
  payees: Record<string, Payee>;
  today: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [openUsr, setOpenUsr] = useState('');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [paidOn, setPaidOn] = useState(today);
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState('');
  const fileInput = useRef<HTMLInputElement | null>(null);

  const open = rows.find((row) => row.usr === openUsr) ?? null;
  const selected = open ? open.cards.filter((card) => chosen.has(card.id)) : [];
  const selectedTotal = totalOf(selected);

  function start(row: MonthlyRow) {
    setOpenUsr(row.usr);
    setChosen(new Set(row.cards.map((card) => card.id)));
    setPaidOn(today);
    setReference('');
    setNote('');
    setFile(null);
    setError('');
    setProblems({});
    setSaved('');
  }

  function toggle(id: string) {
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function save() {
    if (!open || busy) return;
    if (selected.length === 0) {
      setError('Tick at least one approval to pay.');
      return;
    }
    setBusy(true);
    setError('');
    setProblems({});
    try {
      let proof: { name: string; type: string; data: string } | undefined;
      if (file) {
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result ?? ''));
          reader.onerror = () => reject(new Error('unreadable'));
          reader.readAsDataURL(file);
        }).catch(() => '');
        if (!data) throw new Error('That receipt could not be read. Attach it again.');
        proof = { name: file.name, type: file.type, data };
      }

      const res = await fetch('/api/payouts/monthly', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: open.userId,
          conversionIds: selected.map((card) => card.id),
          paidOn,
          reference,
          note,
          proof,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setProblems((payload.fields ?? {}) as Record<string, string>);
        throw new Error(payload.hint ? `${payload.error} ${payload.hint}` : payload.error ?? `That did not save (${res.status}).`);
      }
      setSaved(`Paid ${open.name} ${formatMoney(selectedTotal)} for ${describeCardCount(selected.length)}.`);
      setOpenUsr('');
      startTransition(() => router.refresh());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That did not save.');
    } finally {
      setBusy(false);
    }
  }

  if (rows.length === 0) {
    return (
      <>
        {saved ? <p role="status" className="panel mt-5 border-leaf-edge bg-leaf-wash p-4 text-[13px] text-ink">{saved}</p> : null}
        <p className="panel mt-5 px-5 py-14 text-center text-[13px] text-ink-soft">
          Nothing to pay. Every approved card has been paid.
        </p>
      </>
    );
  }

  return (
    <>
      <p className="plain mt-5">{describeMonthly(rows)}</p>
      {saved ? (
        <p role="status" className="panel mt-4 border-leaf-edge bg-leaf-wash p-4 text-[13px] text-ink">
          {saved}
        </p>
      ) : null}

      <section className="panel mt-5 overflow-hidden">
        <ul>
          {rows.map((row) => {
            const bank = payees[row.userId]?.bank ?? null;
            return (
              <li key={row.usr} className="border-b border-edge-faint last:border-b-0">
                <div className="flex flex-wrap items-center gap-x-5 gap-y-3 px-5 py-4">
                  <span
                    aria-hidden
                    className="flex h-[30px] w-[30px] flex-none items-center justify-center bg-paper-sunk text-[11px] font-semibold text-ink-dim"
                  >
                    {initialsOf(row.name)}
                  </span>
                  <span className="min-w-[170px] flex-1">
                    <span className="block text-[13px] font-semibold text-ink">{row.name}</span>
                    <span className="tnum block text-[11px] text-ink-dim">{`usr=${row.usr}`}</span>
                  </span>
                  <span className="w-[150px] flex-none">
                    {!bank ? (
                      <span className="chip chip-gold">No bank details</span>
                    ) : !bank.routingNumber ? (
                      <span className="chip chip-gold">No routing number</span>
                    ) : (
                      <span className="block text-[12px] text-ink-dim">{bank.bankName}</span>
                    )}
                  </span>
                  <span className="w-[110px] flex-none text-[12px] text-ink-dim">
                    {describeCardCount(row.cards.length)}
                  </span>
                  <span className="w-[110px] flex-none text-right">
                    <span className="tnum block text-[15px] font-semibold text-ink">{formatMoney(row.total)}</span>
                  </span>
                  <button type="button" className="btn-primary btn-sm flex-none" onClick={() => start(row)}>
                    Pay
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {open ? (
        <Modal open title={`Pay ${open.name}`} onClose={() => (busy ? undefined : setOpenUsr(''))}>
          <PayeeDetails payee={payees[open.userId] ?? null} />

          <div className="mt-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="label-cap">Unpaid approvals</h3>
              <button
                type="button"
                className="link-text text-[12px]"
                onClick={() =>
                  setChosen(
                    selected.length === open.cards.length ? new Set() : new Set(open.cards.map((card) => card.id)),
                  )
                }
              >
                {selected.length === open.cards.length ? 'Untick all' : 'Tick all'}
              </button>
            </div>
            <ul className="mt-2 max-h-[260px] overflow-y-auto border border-edge">
              {open.cards.map((card) => (
                <li key={card.id} className="border-b border-edge-faint last:border-b-0">
                  <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 text-[13px]">
                    <input type="checkbox" checked={chosen.has(card.id)} onChange={() => toggle(card.id)} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-ink">{card.card}</span>
                      <span className="block text-[11px] text-ink-dim">
                        {card.customer}, approved {card.approvedOn ? shortDay(card.approvedOn) : BLANK}
                      </span>
                    </span>
                    <span className="tnum flex-none font-semibold text-ink">{formatMoney(card.amount)}</span>
                  </label>
                </li>
              ))}
            </ul>
            <p className="mt-2 flex flex-wrap justify-between gap-2 text-[13px]">
              <span className="text-ink-soft">
                {selected.length} of {describeCardCount(open.cards.length)} ticked
              </span>
              <span>
                To send: <strong className="tnum text-[15px] text-ink">{formatMoney(selectedTotal)}</strong>
              </span>
            </p>
          </div>

          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="field-label">Date paid</span>
              <input
                type="date"
                className="field mt-1.5"
                value={paidOn}
                max={today}
                onChange={(event) => setPaidOn(event.target.value)}
                aria-invalid={problems.paidOn ? true : undefined}
              />
              {problems.paidOn ? <span className="field-error">{problems.paidOn}</span> : null}
            </label>
            <label className="block">
              <span className="field-label">Reference</span>
              <input
                className="field mt-1.5"
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                placeholder="ACH trace or transfer ID"
                maxLength={120}
              />
            </label>
            <label className="block sm:col-span-2">
              <span className="field-label">Note</span>
              <input
                className="field mt-1.5"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Optional, e.g. September payout"
                maxLength={500}
              />
            </label>
            <div className="sm:col-span-2">
              <span className="field-label">Receipt</span>
              <div className="mt-1.5 flex flex-wrap items-center gap-3">
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,application/pdf"
                  className="sr-only"
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                />
                <button type="button" className="btn-outline btn-sm" onClick={() => fileInput.current?.click()}>
                  {file ? 'Replace receipt' : 'Attach receipt'}
                </button>
                <span className="text-[12px] text-ink-dim">
                  {file ? file.name : 'A photo of the transfer or a PDF from the bank, up to about 2.5 MB.'}
                </span>
              </div>
            </div>
          </div>

          {error ? (
            <p role="alert" className="field-error mt-4 block text-[13px]">
              {error}
            </p>
          ) : null}

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="btn-gold"
              onClick={() => void save()}
              disabled={busy || selected.length === 0}
              aria-busy={busy}
            >
              <BusyLabel busy={busy} idle={`Save payment of ${formatMoney(selectedTotal)}`} busyLabel="Saving…" />
            </button>
            <span className="text-[12px] text-ink-dim">
              The ticked approvals are marked paid. Unticked ones stay for next month.
            </span>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
