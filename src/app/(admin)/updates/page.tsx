import type { Metadata } from 'next';
import { UPDATES, updateDay } from '@/lib/updates';
import { requireViewer } from '@/lib/viewer';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Update notes' };

/** Every update note, newest first. Open to everybody signed in. */
export default async function UpdatesPage() {
  await requireViewer();

  return (
    <div className="mx-auto w-full max-w-[900px]">
      <div className="rise">
        <h1 className="font-display text-[26px] leading-[1.05]">Update notes</h1>
        <p className="plain mt-2.5">What has changed in Ledger and in how you are paid, newest first.</p>
      </div>

      {UPDATES.map((update) => (
        <article key={update.id} className="rise panel mt-5 p-6 sm:p-8">
          <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-soft">
            <time dateTime={update.date}>{updateDay(update.date)}</time>
          </p>
          <h2 className="mt-1.5 font-display text-[18px] leading-tight">{update.title}</h2>
          <p className="mt-2.5 text-[13px] leading-relaxed text-ink-soft">{update.summary}</p>
          <ul className="mt-3 list-disc space-y-1.5 pl-5 text-[13px] leading-relaxed text-ink-soft">
            {update.points.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        </article>
      ))}
    </div>
  );
}
