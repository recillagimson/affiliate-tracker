'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { BusyLabel } from '@/components/Spinner';
import { PERSON_ROLES, ROLE_LABELS, type PersonRole } from '@/lib/roles';

/** What each role means, said where the choice is made. */
const MEANING: Record<PersonRole, string> = {
  admin: 'Sees every person’s numbers, and can create links, record approvals and add people.',
  affiliate: 'Sees only the links, leads and earnings on their own tracking key.',
  lgf_employee:
    'An LGF employee. Sees exactly what an affiliate does: their own tracking key, onboarding and earnings.',
};

/**
 * Changing somebody's role, from their page.
 *
 * Nothing is saved until Save, because the dropdown is easy to catch by
 * accident and a move to or from Admin changes what that person can see on
 * their very next click. Those two moves ask first.
 */
export function RoleSelect({
  userId,
  current,
  lockedReason = '',
}: {
  userId: string;
  current: PersonRole;
  /** Why the role cannot be changed here, e.g. it is your own account. */
  lockedReason?: string;
}) {
  const router = useRouter();
  const [role, setRole] = useState<PersonRole>(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = role !== current;

  async function save() {
    if (role === 'admin' && !confirm('Make this person an admin? They will see everybody’s numbers.')) return;
    if (current === 'admin' && !confirm('Take admin away? They will only see their own tracking key.')) return;
    setError(null);
    setBusy(true);
    try {
      const response = await fetch(`/api/users/${encodeURIComponent(userId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'set-role', role }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data.error || 'That did not save.');
        return;
      }
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {error ? (
        <p role="alert" className="warn-note mb-4">
          <span aria-hidden className="warn-note-mark">
            ⚠
          </span>
          <span>{error}</span>
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <label className="sr-only" htmlFor="person-role">
          Role
        </label>
        <select
          id="person-role"
          className="field w-auto"
          value={role}
          disabled={busy || Boolean(lockedReason)}
          onChange={(event) => setRole(event.target.value as PersonRole)}
        >
          {PERSON_ROLES.map((value) => (
            <option key={value} value={value}>
              {ROLE_LABELS[value]}
            </option>
          ))}
        </select>
        {changed ? (
          <>
            <button type="button" className="btn-gold btn-sm" disabled={busy} onClick={save}>
              <BusyLabel busy={busy} idle="Save role" busyLabel="Saving…" />
            </button>
            <button
              type="button"
              className="btn-outline btn-sm"
              disabled={busy}
              onClick={() => {
                setRole(current);
                setError(null);
              }}
            >
              Cancel
            </button>
          </>
        ) : null}
      </div>

      <p className="field-note mt-2">{lockedReason || MEANING[role]}</p>
      {changed && current === 'admin' ? (
        <p className="plain-note mt-2">
          They will go through onboarding like any affiliate, and are given a tracking key if they
          have none.
        </p>
      ) : null}
      {changed && role === 'admin' ? (
        <p className="plain-note mt-2">
          Their tracking key and its links stay as they are. They may need to sign in again before
          the admin pages open.
        </p>
      ) : null}
    </div>
  );
}
