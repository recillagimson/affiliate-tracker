'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Modal } from '@/components/Modal';
import {
  CATEGORY_LABELS,
  MAX_BODY,
  MAX_SUBJECT,
  SUPPORT_CATEGORIES,
  SUPPORT_IMAGE_TYPES,
  type SupportCategory,
} from '@/lib/support';
import { postSupport, readImages } from '@/lib/support-client';

/**
 * Opening a ticket.
 *
 * A button and the dialog behind it. An affiliate fills in what it is about
 * and what they want to say. An admin also chooses who it is for, which is
 * what `people` being a list rather than null means; the route decides
 * ownership again from the session whatever this form posts.
 *
 * On success it goes straight to the new conversation, which is where the
 * person's next message will be read.
 */
export function NewTicket({ people }: { people: { id: string; name: string }[] | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [userId, setUserId] = useState('');
  const [subject, setSubject] = useState('');
  const [category, setCategory] = useState<SupportCategory>('question');
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [problems, setProblems] = useState<Record<string, string>>({});

  async function send() {
    if (busy) return;
    setBusy(true);
    setError('');
    setProblems({});
    try {
      const images = await readImages(files);
      if (!images.ok) {
        setError(images.error);
        return;
      }
      const result = await postSupport({
        action: 'open',
        userId: people ? userId : undefined,
        subject,
        category,
        body,
        attachments: images.attachments,
      });
      if (!result.ok) {
        setError(result.error);
        setProblems(result.fields);
        return;
      }
      setOpen(false);
      router.push(`/support/${String(result.payload.ticketId ?? '')}`);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="btn-primary" onClick={() => setOpen(true)}>
        New ticket
      </button>

      <Modal open={open} title="New ticket" onClose={() => setOpen(false)}>
        <form
          className="mt-5 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
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

          <label className="block">
            <span className="label-cap">Screenshots (optional, up to 3)</span>
            <input
              type="file"
              name="attachments"
              multiple
              accept={SUPPORT_IMAGE_TYPES.join(',')}
              className="mt-1.5 block w-full text-[13px] text-ink-soft"
              onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
            />
          </label>

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
              {busy ? 'Sending' : 'Send'}
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}
