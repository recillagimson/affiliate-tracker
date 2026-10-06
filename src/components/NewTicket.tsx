'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AttachmentPicker } from '@/components/AttachmentPicker';
import { Modal } from '@/components/Modal';
import {
  CATEGORY_LABELS,
  MAX_BODY,
  MAX_SUBJECT,
  SUPPORT_CATEGORIES,
  type SupportCategory,
} from '@/lib/support';
import { addPicked, checkPicked, filesFrom, openedNotice, postSupport, uploadFiles } from '@/lib/support-client';

/**
 * Opening a ticket.
 *
 * A button and the dialog behind it. An affiliate fills in what it is about
 * and what they want to say, and is shown whose name it will be filed under:
 * that is `filer`, read from the session by the page, never typed. An admin
 * instead chooses who the ticket is for, which is what `people` being a list
 * rather than null means. Either way the route decides ownership again from
 * the session, whatever this form posts.
 *
 * On success it goes straight to the new conversation, which is where the
 * person's next message will be read.
 */
export function NewTicket({
  people,
  filer,
}: {
  /** The affiliates an admin can open a ticket for. Null for an affiliate. */
  people: { id: string; name: string }[] | null;
  /** Who an affiliate's ticket is filed as. Null for an admin. */
  filer: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [userId, setUserId] = useState('');
  const [subject, setSubject] = useState('');
  const [category, setCategory] = useState<SupportCategory>('question');
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [problems, setProblems] = useState<Record<string, string>>({});
  /** Set when a ticket was opened but the affiliate could not be emailed. */
  const [opened, setOpened] = useState<{ id: string; notice: string } | null>(null);

  async function send() {
    if (busy) return;
    setBusy(true);
    setError('');
    setProblems({});
    try {
      const uploaded = await uploadFiles(files, (index, percent) =>
        setProgress((current) => {
          const next = [...current];
          next[index] = percent;
          return next;
        }),
      );
      if (!uploaded.ok) {
        setError(uploaded.error);
        return;
      }
      const result = await postSupport({
        action: 'open',
        userId: people ? userId : undefined,
        subject,
        category,
        body,
        attachments: uploaded.attachments,
      });
      if (!result.ok) {
        setError(result.error);
        setProblems(result.fields);
        return;
      }
      const id = String(result.payload.ticketId ?? '');
      const notice = openedNotice(result.payload);
      if (notice) {
        // Stay, and say so. The ticket is saved; what did not happen is the
        // email, and the admin should hear that before they move on.
        setOpened({ id, notice });
        setSubject('');
        setBody('');
        setFiles([]);
        router.refresh();
        return;
      }
      setOpen(false);
      router.push(`/support/${id}`);
      router.refresh();
    } finally {
      setBusy(false);
      setProgress([]);
    }
  }

  return (
    <>
      <button type="button" className="btn-primary" onClick={() => setOpen(true)}>
        New ticket
      </button>

      <Modal
        open={open}
        title="New ticket"
        onClose={() => {
          setOpen(false);
          setOpened(null);
        }}
      >
        {opened ? (
          <div className="mt-5 space-y-4">
            <p role="status" className="text-[14px] leading-relaxed text-ink">
              {opened.notice}
            </p>
            <Link href={`/support/${opened.id}`} className="btn-primary">
              Open the conversation
            </Link>
          </div>
        ) : (
        <form
          className="mt-5 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
          /* A screenshot on the clipboard, pasted anywhere in the form,
             the message box included. Text pastes are left alone. */
          onPaste={(event) => {
            const pasted = filesFrom(event.clipboardData);
            if (pasted.length === 0 || busy) return;
            event.preventDefault();
            const next = addPicked(files, pasted);
            const wrong = checkPicked(next);
            if (wrong) setError(wrong);
            else setFiles(next);
          }}
        >
          {filer ? (
            <p className="flex items-center gap-2 rounded-[8px] bg-paper-sunk px-3 py-2.5 text-[13px] text-ink-soft">
              <span className="label-cap">Filing as</span>
              <strong className="font-semibold text-ink">{filer}</strong>
            </p>
          ) : null}

          {people ? (
            <label className="block">
              <span className="label-cap">Who is it for</span>
              <select
                name="userId"
                className="field mt-1.5 w-full"
                value={userId}
                onChange={(event) => setUserId(event.target.value)}
                aria-invalid={problems.userId ? true : undefined}
              >
                <option value="">Choose an affiliate</option>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <label className="block">
            <span className="label-cap">Subject</span>
            <input
              name="subject"
              className="field mt-1.5 w-full"
              value={subject}
              maxLength={MAX_SUBJECT}
              onChange={(event) => setSubject(event.target.value)}
              aria-invalid={problems.subject ? true : undefined}
            />
          </label>

          <label className="block">
            <span className="label-cap">What is it about</span>
            <select
              name="category"
              className="field mt-1.5 w-full"
              value={category}
              onChange={(event) => setCategory(event.target.value as SupportCategory)}
            >
              {SUPPORT_CATEGORIES.map((key) => (
                <option key={key} value={key}>
                  {CATEGORY_LABELS[key]}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="label-cap">Message</span>
            <textarea
              name="body"
              className="field mt-1.5 min-h-[140px] w-full"
              value={body}
              maxLength={MAX_BODY}
              onChange={(event) => setBody(event.target.value)}
              aria-invalid={problems.body ? true : undefined}
            />
          </label>

          <div>
            <span className="label-cap">Attachments (optional)</span>
            <div className="mt-1.5">
              <AttachmentPicker files={files} onChange={setFiles} disabled={busy} progress={progress} />
            </div>
          </div>

          {error ? (
            <p role="alert" className="text-[13px] text-alarm">
              {error}
            </p>
          ) : null}

          <div className="flex justify-end gap-2">
            <button type="button" className="btn-quiet" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? (files.length > 0 ? 'Uploading' : 'Sending') : 'Send'}
            </button>
          </div>
        </form>
        )}
      </Modal>
    </>
  );
}
