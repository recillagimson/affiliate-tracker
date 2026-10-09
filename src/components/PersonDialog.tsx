'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Modal } from '@/components/Modal';
import { ServiceBoxes } from '@/components/ServicesSelect';
import { BusyLabel } from '@/components/Spinner';
import type { AccountRow } from '@/components/UsersPanel';
import { accountProblems, formFor, MAX_FULL_NAME, planAccountSave, type AccountForm } from '@/lib/account-edit';
import { type PersonRole } from '@/lib/roles';

/** The three roles, and what each one means, the same words as when adding somebody. */
const ROLES: readonly [PersonRole, string, string][] = [
  ['affiliate', 'Affiliate', 'Their own links, leads and earnings only.'],
  ['lgf_employee', 'LGF - Employee', 'An LGF employee. Sees what an affiliate does.'],
  ['admin', 'Admin', 'Everybody’s numbers, and can create links, record approvals and add people.'],
];

function day(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * A password that has just been issued, shown the one time it can be.
 *
 * Nothing stores it. Once this dialog is closed the only way to another is to
 * reset it again, so it says so, and offers to copy it rather than leaving an
 * admin to select sixteen characters by hand.
 */
export function IssuedPassword({ username, password }: { username: string; password: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div data-issued-password className="rounded-[8px] border border-gold-wash bg-gold-faint p-4">
      <p className="text-[13px] text-ink">
        New password for <strong className="font-semibold">{username}</strong>. It is shown once: copy it
        now and hand it over yourself.
      </p>
      <p className="mt-3 flex flex-wrap items-center gap-3">
        <code className="tnum select-all rounded-[4px] border border-edge bg-panel px-3 py-2 text-[14px] text-ink">
          {password}
        </code>
        <button
          type="button"
          className="btn-outline btn-sm"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(password)
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </p>
    </div>
  );
}

/**
 * One person's account, opened over the People list.
 *
 * Who they are at the top, and under it the four things an admin can change:
 * name, email, role and services. Laid out the way the add-account dialog is,
 * so the two read as one form met at two moments.
 *
 * Nothing is saved until Save changes, and only what changed is sent, one
 * action at a time through the account route so each keeps its own guards
 * (lib/account-edit.ts). A refusal part way says what did save.
 *
 * Resetting the password is separate from Save, on its own button, because it
 * is not an edit: it happens the moment it is confirmed, signs that person out
 * everywhere, and produces a password that has to be read here and now.
 *
 * The paperwork is not here. An agreement, a W-9 and bank details are
 * documents to read, not fields to tick, and they stay on the person's own
 * page, which this links to.
 */
export function PersonDialog({
  row,
  viewerId,
  onClose,
}: {
  row: AccountRow;
  viewerId: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const before = formFor(row);
  const [form, setForm] = useState<AccountForm>(before);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [password, setPassword] = useState<string | null>(null);

  const isSelf = row.id === viewerId;
  const steps = planAccountSave(before, form);
  const affiliate = form.role !== 'admin';
  const name = row.fullName || row.username;
  const signedIn = day(row.lastLoginAt);
  const created = day(row.createdAt);

  function set<K extends keyof AccountForm>(key: K, value: AccountForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setProblems((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  async function resetPassword() {
    if (busy || resetting) return;
    if (
      !confirm(
        `Reset the password for ${row.username}? Their current password stops working and they are signed out everywhere.`,
      )
    ) {
      return;
    }
    setResetting(true);
    setError(null);
    try {
      const response = await fetch(`/api/users/${encodeURIComponent(row.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'reset-password' }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || typeof data.password !== 'string') {
        setError(`The password was not reset. ${data.error || 'Try again.'}`);
        return;
      }
      setPassword(data.password);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setResetting(false);
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy || steps.length === 0) return;
    const found = accountProblems(form);
    if (Object.keys(found).length > 0) {
      setProblems(found);
      return;
    }
    // The two moves that change what somebody can see on their next click.
    const roleStep = steps.find((step) => step.action === 'set-role');
    if (roleStep && form.role === 'admin' && !confirm('Make this person an admin? They will see everybody’s numbers.')) return;
    if (roleStep && before.role === 'admin' && !confirm('Take admin away? They will only see their own tracking key.')) return;

    setBusy(true);
    setError(null);
    const saved: string[] = [];
    try {
      for (const step of steps) {
        const response = await fetch(`/api/users/${encodeURIComponent(row.id)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(step),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          const what = step.action === 'set-details' ? 'Their details' : step.action === 'set-role' ? 'The role' : 'Their services';
          const kept = saved.length > 0 ? ` Saved before that: ${saved.join(', ')}.` : '';
          setError(`${what} did not save. ${data.error || 'Try again.'}${kept}`);
          if (data.fields) setProblems(data.fields);
          // What did save should show behind the dialog straight away.
          if (saved.length > 0) router.refresh();
          return;
        }
        saved.push(step.action === 'set-details' ? 'details' : step.action === 'set-role' ? 'role' : 'services');
      }
      router.refresh();
      onClose();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open title={name} onClose={onClose}>
      <p className="plain mt-2">
        <span className="tnum">{row.username}</span>
        {row.usr ? (
          <>
            {' · '}
            <span className="tnum">usr={row.usr}</span>
          </>
        ) : null}
        {row.tradelineRef ? (
          <>
            {' · '}
            <span className="tnum">Tradelines ref {row.tradelineRef}</span>
          </>
        ) : null}
        {' · '}
        {signedIn ? `Last signed in ${signedIn}` : 'Never signed in'}
        {created ? ` · Added ${created}${row.createdBy ? ` by ${row.createdBy}` : ''}` : ''}
        {row.active ? '' : ' · Disabled'}
      </p>

      <form onSubmit={save} className="mt-6 flex flex-col gap-6">
        <div aria-live="polite">
          {error ? (
            <p role="alert" className="warn-note">
              <span aria-hidden className="warn-note-mark">
                ⚠
              </span>
              <span>{error}</span>
            </p>
          ) : null}
        </div>

        <div className="grid gap-x-5 gap-y-6 sm:grid-cols-2">
          <label className="block">
            <span className="field-label">Full name</span>
            <input
              name="fullName"
              className="field mt-1.5"
              value={form.fullName}
              maxLength={MAX_FULL_NAME}
              onChange={(e) => set('fullName', e.target.value)}
              autoComplete="off"
              disabled={busy}
              aria-invalid={problems.fullName ? true : undefined}
            />
            {problems.fullName ? (
              <span className="field-error">{problems.fullName}</span>
            ) : (
              <span className="field-note">How they are labelled here and greeted in emails.</span>
            )}
          </label>

          <label className="block">
            <span className="field-label">Email</span>
            <input
              name="email"
              type="email"
              className="field mt-1.5"
              value={form.email}
              onChange={(e) => set('email', e.target.value)}
              autoComplete="off"
              disabled={busy}
              aria-invalid={problems.email ? true : undefined}
            />
            {problems.email ? (
              <span className="field-error">{problems.email}</span>
            ) : (
              <span className="field-note">Where approval, payout and support emails go.</span>
            )}
          </label>
        </div>

        <fieldset className="block">
          <legend className="field-label">What they can see</legend>
          <div className="mt-2.5 flex flex-col gap-2.5">
            {ROLES.map(([value, label, meaning]) => (
              <label key={value} className={`flex items-start gap-3 ${isSelf ? '' : 'cursor-pointer'}`}>
                <input
                  type="radio"
                  name="role"
                  value={value}
                  checked={form.role === value}
                  disabled={busy || isSelf}
                  onChange={() => set('role', value)}
                  className="mt-0.5 h-4 w-4 flex-none accent-navy"
                />
                <span className="min-w-0">
                  <span className="block text-[14px] font-medium text-ink">{label}</span>
                  <span className="block text-[12px] leading-relaxed text-ink-soft">{meaning}</span>
                </span>
              </label>
            ))}
          </div>
          {isSelf ? (
            <span className="field-note">This is your account. Another admin can change your role.</span>
          ) : null}
        </fieldset>

        {affiliate ? (
          <fieldset className="block">
            <legend className="field-label">What they are onboarded for</legend>
            <div className="mt-2.5">
              <ServiceBoxes value={form.services} onChange={(next) => set('services', next)} disabled={busy} />
            </div>
            {problems.services ? (
              <span role="alert" className="field-error">
                {problems.services}
              </span>
            ) : null}
          </fieldset>
        ) : null}

        <fieldset className="block">
          <legend className="field-label">Password</legend>
          {password ? (
            <div className="mt-2.5">
              <IssuedPassword username={row.username} password={password} />
            </div>
          ) : (
            <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
              <button
                type="button"
                className="btn-outline btn-sm"
                disabled={busy || resetting}
                aria-busy={resetting}
                onClick={resetPassword}
              >
                <BusyLabel busy={resetting} idle="Reset password" busyLabel="Resetting…" />
              </button>
              <span className="text-[12px] leading-relaxed text-ink-soft">
                Issues a new one, shown here once. They are signed out everywhere.
              </span>
            </div>
          )}
        </fieldset>

        <div className="flex flex-wrap items-center justify-between gap-2.5 border-t border-edge pt-5">
          <Link href={`/users/${encodeURIComponent(row.id)}`} className="link-text text-[13px] font-medium">
            Open full record
          </Link>
          <span className="flex flex-wrap gap-2.5">
            <button type="button" className="btn-outline" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn-gold" disabled={busy || steps.length === 0} aria-busy={busy}>
              <BusyLabel busy={busy} idle="Save changes" busyLabel="Saving…" />
            </button>
          </span>
        </div>
      </form>
    </Modal>
  );
}
