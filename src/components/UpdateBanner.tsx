import Link from 'next/link';
import type { Update } from '@/lib/updates';

/**
 * The overview's standing notice about the latest update. Solid gold rather
 * than the pale wash the quieter notices use, because this one has to be seen.
 */
export function UpdateBanner({ update }: { update: Update }) {
  return (
    <div
      role="status"
      className="rise mb-5 flex flex-col gap-3 border-2 border-gold-edge bg-gold px-5 py-4 text-gold-ink sm:flex-row sm:items-center sm:justify-between sm:gap-6"
    >
      <div className="flex min-w-0 items-start gap-3">
        <span
          aria-hidden
          className="flex h-9 w-9 flex-none items-center justify-center bg-gold-ink text-[18px] font-bold text-gold"
        >
          !
        </span>
        <div className="min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-[0.08em]">Important update</p>
          <p className="mt-0.5 text-[16px] font-semibold leading-snug">{update.title}</p>
          <p className="mt-1 text-[13px] leading-relaxed">{update.summary}</p>
        </div>
      </div>
      <Link
        href="/updates"
        className="flex-none self-start bg-gold-ink px-4 py-2.5 text-[13px] font-semibold text-gold hover:bg-navy sm:self-center"
      >
        See what changed →
      </Link>
    </div>
  );
}
