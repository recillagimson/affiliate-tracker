'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { formatDateTime } from '@/lib/analytics';
import { MAX_BODY, SUPPORT_IMAGE_TYPES, type SupportMessage, type SupportSide, type SupportStatus } from '@/lib/support';
import { emailNote, postSupport, readImages } from '@/lib/support-client';

/**
 * The messages of a ticket, oldest first. No state, so every shape it can
 * take is rendered directly by scripts/support-render-checks.tsx.
 *
 * A body is drawn as text and nothing else. React escapes it, and
 * whitespace-pre-wrap keeps the line breaks somebody typed, so there is no
 * markup to interpret and none is.
 *
 * An affiliate sees an admin's messages as coming from "Support" with the
 * admin's name beside it; an admin sees everybody by name.
 */
export function SupportMessages({ messages, side }: { messages: SupportMessage[]; side: SupportSide }) {
  return (
    <ol className="mt-5 space-y-3">
      {messages.map((message) => {
        const mine = message.authorRole === side;
        const who =
          message.authorRole === 'admin' && side === 'affiliate'
            ? `Support (${message.authorName})`
            : message.authorName || (message.authorRole === 'admin' ? 'Support' : 'Affiliate');
        return (
          <li
            key={message.id}
            data-mine={mine ? 'true' : 'false'}
            className={`panel p-4 sm:p-5 ${mine ? 'bg-paper-sunk' : ''}`}
          >
            <p className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-[12px] text-ink-soft">
              <strong className="font-semibold text-ink">{who}</strong>
              <time dateTime={message.createdAt}>{formatDateTime(message.createdAt)}</time>
            </p>
            <p className="mt-2 whitespace-pre-wrap break-words text-[14px] leading-relaxed text-ink">{message.body}</p>
            {message.attachments.length > 0 ? (
              <ul className="mt-3 flex flex-wrap gap-2">
                {message.attachments.map((file) => (
                  <li key={file.id}>
                    <a
                      href={`/api/support/attachments/${file.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="block border border-edge"
                    >
                      {/* A plain img: these are served from this app's own
                          signed-in route, which next/image cannot fetch. */}
                      <img
                        src={`/api/support/attachments/${file.id}`}
                        alt={file.name}
                        loading="lazy"
                        className="h-24 w-24 object-cover"
                      />
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * One conversation: its messages, a box to answer in, and Close or Reopen.
 *
 * Opening it tells the route it has been read, once, after it mounts. Not
 * during the server render: a link Next prefetched would then mark a ticket
 * read that nobody had looked at. `markRead` is false from Client View, where
 * an admin looking is not the affiliate reading.
 */
export function SupportThread({
  ticket,
  messages,
  side,
  markRead,
}: {
  ticket: { id: string; subject: string; category: string; status: SupportStatus };
  messages: SupportMessage[];
  side: SupportSide;
  markRead: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const picker = useRef<HTMLInputElement | null>(null);
  const marked = useRef(false);

  useEffect(() => {
    if (!markRead || marked.current) return;
    marked.current = true;
    // Refreshed afterwards so the tab's badge drops without a reload.
    void postSupport({ action: 'read', ticketId: ticket.id }).then((result) => {
      if (result.ok) startTransition(() => router.refresh());
    });
  }, [markRead, ticket.id, router]);

  async function send() {
    if (busy) return;
    setBusy(true);
    setError('');
    setSaved('');
    try {
      const images = await readImages(files);
      if (!images.ok) {
        setError(images.error);
        return;
      }
      const result = await postSupport({
        action: 'reply',
        ticketId: ticket.id,
        body,
        attachments: images.attachments,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setBody('');
      setFiles([]);
      if (picker.current) picker.current.value = '';
      setSaved(`Sent.${emailNote(result.payload)}`);
      startTransition(() => router.refresh());
    } finally {
      setBusy(false);
    }
  }

  async function move(action: 'close' | 'reopen') {
    if (busy) return;
    setBusy(true);
    setError('');
    setSaved('');
    try {
      const result = await postSupport({ action, ticketId: ticket.id });
      if (!result.ok) setError(result.error);
      startTransition(() => router.refresh());
    } finally {
      setBusy(false);
    }
  }

  const closed = ticket.status === 'closed';

  return (
    <>
      <SupportMessages messages={messages} side={side} />

      <form
        className="panel mt-5 space-y-3 p-4 sm:p-5"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label className="block">
          <span className="label-cap">Reply</span>
          <textarea
            name="body"
            className="field mt-1.5 min-h-[110px] w-full"
            value={body}
            maxLength={MAX_BODY}
            onChange={(event) => setBody(event.target.value)}
          />
        </label>
        {closed ? (
          <p className="text-[12px] text-ink-soft">This ticket is closed. Sending a reply will reopen it.</p>
        ) : null}
        <input
          ref={picker}
          type="file"
          name="attachments"
          multiple
          accept={SUPPORT_IMAGE_TYPES.join(',')}
          aria-label="Attach screenshots, up to 3"
          className="block w-full text-[13px] text-ink-soft"
          onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
        />

        {error ? (
          <p role="alert" className="text-[13px] text-alarm">
            {error}
          </p>
        ) : null}
        {saved ? (
          <p role="status" className="text-[13px] text-ink-soft">
            {saved}
          </p>
        ) : null}

        <div className="flex flex-wrap justify-between gap-2">
          {closed ? (
            <button type="button" className="btn-outline" disabled={busy} onClick={() => void move('reopen')}>
              Reopen ticket
            </button>
          ) : (
            <button type="button" className="btn-outline" disabled={busy} onClick={() => void move('close')}>
              Close ticket
            </button>
          )}
          <button type="submit" className="btn-primary" disabled={busy || body.trim() === ''}>
            {busy ? 'Sending' : 'Send reply'}
          </button>
        </div>
      </form>
    </>
  );
}
