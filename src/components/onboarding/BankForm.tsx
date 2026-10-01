'use client';

import { useState } from 'react';
import { BusyLabel } from '@/components/Spinner';
import { BackLink, ContinueLink } from '@/components/onboarding/StepControls';
import { maskAccount } from '@/lib/mask';
import { bankProblems, type BankInput } from '@/lib/onboarding';

/**
 * Step 4: where the ACH goes.
 *
 * The one step that does not bar the door. Somebody may genuinely not have this
 * to hand — a new account, a shared business account, a bank that has to be
 * phoned — and Net 15 leaves two weeks to produce it in. So the app opens without
 * it and a banner nags until it arrives.
 *
 * `alreadySaved` changes the wording rather than the form: replacing a bank
 * account is a thing people do, and a screen that says "done" with no way to
 * correct it is a screen that sends them looking for an admin.
 */
export function BankForm({
  alreadySaved,
  initialAccountName = '',
  initialBankName = '',
  initialRoutingNumber = '',
  accountLast4 = '',
  backTo,
  continueTo = '',
  continueLabel = 'Continue',
}: {
  alreadySaved: boolean;
  initialAccountName?: string;
  initialBankName?: string;
  initialRoutingNumber?: string;
  /** The four digits of what is already stored, so the field can be left empty
   *  to keep it. The rest of the number cannot be read back. */
  accountLast4?: string;
  backTo?: { path: string; label: string };
  continueTo?: string;
  continueLabel?: string;
}) {
  const [values, setValues] = useState<BankInput>({
    accountName: initialAccountName,
    bankName: initialBankName,
    routingNumber: initialRoutingNumber,
    accountNumber: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function set<K extends keyof BankInput>(key: K, value: BankInput[K]) {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => {
      if (!current[key as string]) return current;
      const next = { ...current };
      delete next[key as string];
      return next;
    });
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const problems = bankProblems(values, { accountOnFile: alreadySaved });
    if (Object.keys(problems).length > 0) {
      setErrors(problems);
      return;
    }

    setBusy(true);
    try {
      const response = await fetch('/api/onboarding/bank', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(values),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data.error || 'That did not save.');
        if (data.fields) setErrors(data.fields);
        setBusy(false);
        return;
      }
      globalThis.location.assign(data.next || '/');
    } catch {
      setError('Could not reach the server.');
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="panel mt-5 p-6 sm:p-7" noValidate>
      {error ? (
        <p role="alert" className="warn-note mb-5">
          <span aria-hidden className="warn-note-mark">
            ⚠
          </span>
          <span>{error}</span>
        </p>
      ) : null}

      <div className="grid gap-5 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <span className="field-label">Name on the account</span>
          <input
            className="field mt-1.5"
            value={values.accountName}
            onChange={(e) => set('accountName', e.target.value)}
            placeholder="Arthur Reyes"
            autoComplete="off"
            aria-invalid={errors.accountName ? true : undefined}
          />
          <span className="field-note">
            Exactly as the bank has it. A mismatched name is the usual reason an ACH bounces.
          </span>
          {errors.accountName ? <span className="field-error">{errors.accountName}</span> : null}
        </label>

        <label className="block sm:col-span-2">
          <span className="field-label">Bank name</span>
          <input
            className="field mt-1.5"
            value={values.bankName}
            onChange={(e) => set('bankName', e.target.value)}
            placeholder="Example Bank"
            autoComplete="off"
            aria-invalid={errors.bankName ? true : undefined}
          />
          {errors.bankName ? <span className="field-error">{errors.bankName}</span> : null}
        </label>

        <label className="block">
          <span className="field-label">Routing number</span>
          <input
            className="field tnum mt-1.5"
            value={values.routingNumber}
            onChange={(e) => set('routingNumber', e.target.value)}
            inputMode="numeric"
            autoComplete="off"
            maxLength={11}
            placeholder="9 digits"
            aria-invalid={errors.routingNumber ? true : undefined}
          />
          <span className="field-note">
            The 9-digit ABA number for ACH. It is on a cheque, bottom left, and in your bank app.
          </span>
          {errors.routingNumber ? <span className="field-error">{errors.routingNumber}</span> : null}
        </label>

        <label className="block">
          <span className="field-label">Account number</span>
          <input
            className="field tnum mt-1.5"
            value={values.accountNumber}
            onChange={(e) => set('accountNumber', e.target.value)}
            inputMode="numeric"
            autoComplete="off"
            placeholder={alreadySaved ? 'Leave empty to keep it' : undefined}
            aria-invalid={errors.accountNumber ? true : undefined}
          />
          <span className="field-note">
            {alreadySaved ? (
              <>
                <span className="tnum font-semibold text-ink-soft">{maskAccount(accountLast4)}</span>{' '}
                is on file. Leave this empty to correct the name or the bank without retyping
                the number, which cannot be shown back to you in full.
              </>
            ) : (
              'Encrypted before it is stored. Only the last four digits are ever shown back.'
            )}
          </span>
          {errors.accountNumber ? <span className="field-error">{errors.accountNumber}</span> : null}
        </label>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-4">
        {backTo ? <BackLink to={backTo.path} label={backTo.label} /> : null}
        <button type="submit" className="btn-gold" disabled={busy} aria-busy={busy}>
          <BusyLabel
            busy={busy}
            idle={alreadySaved ? 'Save changes' : 'Save and finish'}
            busyLabel="Saving…"
          />
        </button>
        {alreadySaved && continueTo ? (
          <ContinueLink to={continueTo} label={continueLabel} />
        ) : (
          <span className="text-[12px] text-ink-dim">That is everything.</span>
        )}
      </div>
    </form>
  );
}
