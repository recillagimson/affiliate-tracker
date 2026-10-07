'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { BusyLabel } from '@/components/Spinner';
import {
  SERVICE_LABELS,
  SERVICES,
  servicesProblem,
  toggleService,
  type Service,
} from '@/lib/services';

/** What each service is, said where the choice is made. */
const MEANING: Record<Service, string> = {
  personal_cards: 'Credit card referrals: the links, approvals and payouts this app tracks today.',
  tradelines: 'Tradeline referrals. Recorded here now; tracking for them comes later.',
};

/**
 * The two checkboxes, with no state of their own.
 *
 * Used in two places that must offer the same choice the same way: the
 * new-account form on the People page, and a person's own page. The list
 * lives with the caller, which is told what it would become.
 */
export function ServiceBoxes({
  value,
  onChange,
  disabled = false,
}: {
  value: readonly Service[];
  onChange: (next: Service[]) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      {SERVICES.map((service) => (
        <label key={service} className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            name="services"
            value={service}
            checked={value.includes(service)}
            disabled={disabled}
            onChange={(event) => onChange(toggleService(value, service, event.target.checked))}
            className="mt-0.5 h-4 w-4 flex-none accent-navy"
          />
          <span className="min-w-0">
            <span className="block text-[14px] font-medium text-ink">{SERVICE_LABELS[service]}</span>
            <span className="block text-[12px] leading-relaxed text-ink-soft">{MEANING[service]}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

/** Somebody's services as small labels. Tradelines is the one that stands out: it is the one that is new. */
export function ServiceChips({ services }: { services: readonly Service[] }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {SERVICES.filter((service) => services.includes(service)).map((service) => (
        <span key={service} className={`chip ${service === 'tradelines' ? 'chip-gold' : 'chip-quiet'}`}>
          {SERVICE_LABELS[service]}
        </span>
      ))}
    </span>
  );
}

/**
 * Changing what somebody is onboarded for, from their page.
 *
 * Nothing is saved until Save, the way the role beside it works, and for the
 * same reason: a checkbox is easy to catch by accident. A choice of nothing
 * cannot be saved, and says why instead of offering the button.
 */
export function ServicesSelect({ userId, current }: { userId: string; current: readonly Service[] }) {
  const router = useRouter();
  const [services, setServices] = useState<Service[]>([...current]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = services.join() !== [...current].join();
  const problem = servicesProblem(services);

  async function save() {
    if (problem) return;
    setError(null);
    setBusy(true);
    try {
      const response = await fetch(`/api/users/${encodeURIComponent(userId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'set-services', services }),
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

      <ServiceBoxes value={services} onChange={setServices} disabled={busy} />

      {changed ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {problem ? (
            <p className="field-note">{problem}</p>
          ) : (
            <button type="button" className="btn-gold btn-sm" disabled={busy} onClick={save}>
              <BusyLabel busy={busy} idle="Save services" busyLabel="Saving…" />
            </button>
          )}
          <button
            type="button"
            className="btn-outline btn-sm"
            disabled={busy}
            onClick={() => {
              setServices([...current]);
              setError(null);
            }}
          >
            Cancel
          </button>
        </div>
      ) : null}
    </div>
  );
}
