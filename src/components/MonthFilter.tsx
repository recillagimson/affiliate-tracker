'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import { Spinner } from './Spinner';

/**
 * Month filter: one calendar month instead of a rolling period.
 *
 * Beside the period pills rather than among them, because the list grows by
 * one every month. Choosing a month drops the period from the URL, and the
 * pills drop the month, so the two never both claim the window. Everything
 * else in the URL, the person above all, is kept.
 */
export function MonthFilter({
  months,
  value,
}: {
  /** `YYYY-MM` and its name, newest first. */
  months: { key: string; label: string }[];
  value: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  function choose(next: string) {
    const query = new URLSearchParams(params.toString());
    query.delete('period');
    if (next) query.set('month', next);
    else query.delete('month');
    const search = query.toString();
    startTransition(() => router.push(search ? `${pathname}?${search}` : pathname));
  }

  if (months.length === 0) return null;

  return (
    <span className="flex min-w-0 items-center gap-3">
      <label htmlFor="month-filter" className="text-[13px] font-semibold text-ink-soft">
        Month
      </label>
      {pending ? <Spinner className="text-ink-soft" /> : null}
      <select
        id="month-filter"
        value={value}
        disabled={pending}
        aria-busy={pending}
        onChange={(event) => choose(event.target.value)}
        className="field w-auto"
      >
        <option value="">Pick a month</option>
        {months.map((month) => (
          <option key={month.key} value={month.key}>
            {month.label}
          </option>
        ))}
      </select>
    </span>
  );
}
