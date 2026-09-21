'use client';

import { useState } from 'react';
import { BusyLabel } from './Spinner';
import { formatMoney } from '@/lib/analytics';
import { affiliateCut, amountFor, preselectChoice, type RateChoice } from '@/lib/manual-approval';
import { formatShare, shareOn, type ShareRate } from '@/lib/settings';

/** What the leads list needs to offer Approve: the rate card and the commission history. */
export type ApproveContext = {
  choices: RateChoice[];
  shares: ShareRate[];
  /** The server's today, so the default approval day cannot disagree with it at midnight. */
  today: string;
};

/**
 * Approve one lead: which card, what it paid, and on what day.
 *
 * The card comes off the rate card and fills the amount in, by tier where the
 * card has them. The amount stays editable for the approval that paid
 * something the rate card does not say; the sync swaps it for what QMP paid
 * once QMP reports it. Under the amount is what the lead's affiliate keeps of
 * it, at the share in force on the approval day, which is how the dashboard
 * will value it.
 */
export function ApproveLead({
  lead,
  context,
  onDone,
  onCancel,
}: {
  lead: { id: string; fullName: string; email: string; assignee: string; card: string };
  context: ApproveContext;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const { choices, shares, today } = context;
  const start = preselectChoice(lead.card, choices);
  const [choiceIndex, setChoiceIndex] = useState(start);
  // A card with one rate keeps it under the tier '', so starting every card on
  // '' fills a one-rate card in straight away and leaves a tiered one asking.
  const [tier, setTier] = useState('');
  const [amount, setAmount] = useState(() => {
    const filled = amountFor(choices[start], '');
    return filled === null ? '' : String(filled);
  });
  // With no rate card uploaded there is nothing to pick from, so the card is typed.
  const [typedCard, setTypedCard] = useState(choices.length === 0 ? lead.card.split(',')[0]!.trim() : '');
  const [approvedOn, setApprovedOn] = useState(today);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choice = choiceIndex === -1 ? undefined : choices[choiceIndex];
  const tiered = choice ? choice.tiers.some((entry) => entry.tier !== '') : false;
  const card = choices.length === 0 ? typedCard.trim() : (choice?.card ?? '');
  const value = amount.trim() === '' ? null : Number(amount);
  const who = lead.fullName || lead.email;
  const affiliate = lead.assignee || 'The affiliate';

  function pickCard(index: number) {
    setChoiceIndex(index);
    const next = index === -1 ? undefined : choices[index];
    setTier('');
    const filled = amountFor(next, '');
    setAmount(filled === null ? '' : String(filled));
  }

  function pickTier(next: string) {
    setTier(next);
    const filled = amountFor(choice, next);
    if (filled !== null) setAmount(String(filled));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!card) {
      setError('Pick the card they were approved for.');
      return;
    }
    if (tiered && !tier) {
      setError('Pick the tier, so the amount is what that tier pays.');
      return;
    }
    if (value === null || !Number.isFinite(value) || value < 0) {
      setError('Enter what the approval paid.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/leads/${lead.id}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ card, amount: value, approvedOn }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error ?? `Request failed (${res.status})`);
      }
      onDone(`${who} approved for ${card} at ${formatMoney(value)}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not approve that lead');
      setBusy(false);
    }
  }

  // Grouped by issuer, the way the rate card reads, so a card is found under
  // the bank that offers it rather than by scrolling forty names.
  const issuers: { issuer: string; items: { index: number; choice: RateChoice }[] }[] = [];
  choices.forEach((entry, index) => {
    const last = issuers[issuers.length - 1];
    if (last && last.issuer === entry.issuer) last.items.push({ index, choice: entry });
    else issuers.push({ issuer: entry.issuer, items: [{ index, choice: entry }] });
  });

  return (
    /* Held to the visible part of the table rather than its full scrolling
       width, and pinned to the left as it scrolls, so no field of the form
       sits off screen beside the columns. */
    <form
      onSubmit={submit}
      className="panel-sunk sticky left-0 w-[min(960px,calc(100vw-6rem))] p-5 sm:p-6"
      aria-label={`Approve ${who}`}
    >
      <p className="font-display text-[15px]">Approve {who}</p>

      <div className="mt-4 grid gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,140px)_minmax(0,150px)_minmax(0,180px)]">
        {choices.length > 0 ? (
          <label className="block min-w-0">
            <span className="field-label mb-2 block">Card</span>
            <select
              value={choiceIndex}
              onChange={(event) => pickCard(Number(event.target.value))}
              className="field"
              autoFocus
            >
              <option value={-1}>Pick a card…</option>
              {issuers.map((group) => (
                <optgroup key={group.issuer} label={group.issuer || 'Other'}>
                  {group.items.map(({ index, choice: entry }) => (
                    <option key={index} value={index}>
                      {entry.card}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
        ) : (
          <label className="block min-w-0">
            <span className="field-label mb-2 block">Card</span>
            <input
              type="text"
              value={typedCard}
              onChange={(event) => setTypedCard(event.target.value)}
              className="field"
              autoFocus
            />
            <span className="field-note">No rate card is uploaded, so type the card and its payout.</span>
          </label>
        )}

        {/* Only where the card has tiers. A select with one option in it is a
            question with one answer. */}
        {tiered ? (
          <label className="block min-w-0">
            <span className="field-label mb-2 block">Tier</span>
            <select value={tier} onChange={(event) => pickTier(event.target.value)} className="field">
              <option value="">Pick…</option>
              {choice!.tiers.map((entry) => (
                <option key={entry.tier} value={entry.tier}>
                  {entry.tier} · {formatMoney(entry.amount)}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span aria-hidden className="hidden lg:block" />
        )}

        <label className="block min-w-0">
          <span className="field-label mb-2 block">Payout</span>
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="0.00"
            className="field"
          />
        </label>

        <label className="block min-w-0">
          <span className="field-label mb-2 block">Approved on</span>
          <input
            type="date"
            required
            value={approvedOn}
            onChange={(event) => setApprovedOn(event.target.value)}
            className="field"
          />
        </label>
      </div>

      {value !== null && Number.isFinite(value) && value >= 0 ? (
        <p className="plain mt-4">
          {affiliate} earns <strong>{formatMoney(affiliateCut(value, approvedOn, shares))}</strong> (
          {formatShare(shareOn(approvedOn, shares))} of {formatMoney(value)}). When QMP reports this
          approval, the sync puts in what QMP paid.
        </p>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center gap-4">
        <button type="submit" disabled={busy} aria-busy={busy} className="btn-primary">
          <BusyLabel busy={busy} idle="Confirm approval" busyLabel="Approving…" />
        </button>
        <button type="button" className="btn-quiet" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>

      {error ? (
        <p role="alert" className="field-error">
          {error}
        </p>
      ) : null}
    </form>
  );
}
