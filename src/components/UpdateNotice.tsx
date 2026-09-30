'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { updateDay, type Update } from '@/lib/updates';

/**
 * The latest update note, as a pop-up after every sign-in.
 *
 * `login` differs from one sign-in to the next (lib/viewer loginStamp), so
 * remembering "shown for this note and this login" in the browser means it
 * shows once per login rather than on every page. Storage that throws
 * (private mode, blocked site data) just means it shows.
 */
const KEY = 'ledger_update_notice';

export function UpdateNotice({ update, login }: { update: Update; login: string }) {
  const [open, setOpen] = useState(false);
  const stamp = `${update.id}:${login}`;

  useEffect(() => {
    let seen = '';
    try {
      seen = window.localStorage.getItem(KEY) ?? '';
    } catch {
      seen = '';
    }
    if (seen !== stamp) setOpen(true);
  }, [stamp]);

  function close() {
    setOpen(false);
    try {
      window.localStorage.setItem(KEY, stamp);
    } catch {
      // Nothing to do: it shows again next time, which is harmless.
    }
  }

  return (
    <Modal open={open} title="What's new" onClose={close}>
      <p className="mt-4 flex flex-wrap items-center gap-2">
        <span className="bg-gold px-2 py-0.5 text-[11px] font-bold uppercase tracking-[0.06em] text-gold-ink">
          New
        </span>
        <span className="text-[12px] text-ink-dim">{updateDay(update.date)}</span>
      </p>
      <p className="mt-2 text-[17px] font-semibold leading-snug text-ink">{update.title}</p>
      <ul className="mt-3 list-disc space-y-1.5 pl-5 text-[13px] leading-relaxed text-ink-soft">
        {update.points.map((point) => (
          <li key={point}>{point}</li>
        ))}
      </ul>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button type="button" className="btn-primary" onClick={close}>
          Got it
        </button>
        <Link href="/updates" className="link-text text-[13px] font-medium" onClick={close}>
          Read the update notes
        </Link>
      </div>
    </Modal>
  );
}
