'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * A dialog over the page, for a decision that needs what is not on the row.
 *
 * The native <dialog>, opened with showModal(), rather than a div with a
 * z-index: the browser then owns the parts that are easy to get wrong and
 * expensive to get wrong — focus moves in and is trapped, Escape closes,
 * everything behind it is inert, and it sits in the top layer above any
 * stacking context. All this file adds is the plumbing between that element
 * and React's `open`, and returning focus to whatever opened it.
 *
 * Closing is always the caller's to decide, so `onClose` fires for Escape and
 * for the backdrop as well as for a Close button, and the element is never
 * left open while React thinks it is shut.
 */
export function Modal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  /** Names the dialog for a screen reader, and heads it on screen. */
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);
  /** What had the keyboard before this opened, to hand it back afterwards. */
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      opener.current = document.activeElement as HTMLElement | null;
      dialog.showModal();
    }
    if (!open && dialog.open) {
      dialog.close();
      // Only if nothing else has taken it in the meantime: a dialog that
      // closed because the row underneath it disappeared should not steal
      // the keyboard back from wherever the page moved it.
      if (document.activeElement === document.body) opener.current?.focus();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-label={title}
      /* Escape fires `cancel` before `close`; both are answered so the parent
         hears about a close it did not ask for. */
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
      /* The backdrop is the dialog's own box, so a press that lands on the
         element itself rather than on the panel inside it is a press outside. */
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      className="w-[min(680px,calc(100vw-2rem))] rounded-[14px] border-2 border-edge bg-panel p-0 text-ink backdrop:bg-ink/40"
    >
      <div className="max-h-[min(82vh,900px)] overflow-y-auto p-6 sm:p-8">
        <div className="flex items-start justify-between gap-6">
          <h2 className="font-display text-[18px] leading-tight">{title}</h2>
          <button type="button" className="btn-quiet btn-sm flex-none" onClick={onClose}>
            Close
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
