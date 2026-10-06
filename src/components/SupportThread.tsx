'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { AttachmentPicker } from '@/components/AttachmentPicker';
import { formatDateTime } from '@/lib/analytics';
import { fileKind, MAX_BODY, sizeText, type SupportMessage, type SupportSide, type SupportStatus } from '@/lib/support';
import { addPicked, checkPicked, emailNote, filesFrom, postSupport, uploadFiles } from '@/lib/support-client';

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
              <ul className="mt-3 flex flex-wrap items-start gap-2">
                {message.attachments.map((file) => {
                  const href = `/api/support/attachments/${file.id}`;
                  const kind = fileKind(file.type);
                  if (kind === 'image') {
                    return (
                      <li key={file.id}>
                        <a href={href} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-[6px] border border-edge">
                          {/* A plain img: these come through this app's own
                              signed-in route, which next/image cannot fetch. */}
                          <img src={href} alt={file.name} loading="lazy" className="h-28 w-28 object-cover" />
                        </a>
                      </li>
                    );
                  }
                  if (kind === 'video') {
                    return (
                      <li key={file.id} className="w-full max-w-[420px]">
                        {/* metadata only, so a thread with five recordings
                            does not start five downloads on open. */}
                        <video
                          controls
                          preload="metadata"
                          src={href}
                          aria-label={file.name}
                          className="w-full rounded-[6px] border border-edge bg-ink"
                        />
                        <span className="mt-1 block truncate text-[12px] text-ink-soft">
                          {file.name} · {sizeText(file.size)}
                        </span>
                      </li>
                    );
                  }
                  return (
                    <li key={file.id}>
                      <a
                        href={href}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-2 rounded-[6px] border border-edge bg-panel px-3 py-2 text-[13px]"
                      >
                        <span aria-hidden className="rounded-[4px] bg-navy-wash px-1.5 py-0.5 text-[10px] font-semibold uppercase text-navy">
                          PDF
                        </span>
                        <span className="link-text font-medium">{file.name}</span>
                        <span className="text-[12px] text-ink-soft">{sizeText(file.size)}</span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * One conversation: its messages, a box to answer in, and a way to end it or
 * reopen it. An admin ends one with Mark as resolved; an affiliate with Close.
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
  const [progress, setProgress] = useState<number[]>([]);
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
        action: 'reply',
        ticketId: ticket.id,
        body,
        attachments: uploaded.attachments,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setBody('');
      setFiles([]);
      setSaved(`Sent.${emailNote(result.payload)}`);
      startTransition(() => router.refresh());
    } finally {
      setBusy(false);
      setProgress([]);
    }
  }

  async function move(action: 'close' | 'resolve' | 'reopen') {
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

  // Resolved or closed: either way it is no longer open, and a reply reopens it.
  const ended = ticket.status !== 'open';

  return (
    <>
      <SupportMessages messages={messages} side={side} />

      <form
        className="panel mt-5 space-y-3 p-4 sm:p-5"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
        /* A screenshot on the clipboard, pasted into the reply box. */
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
        {ended ? (
          <p className="text-[12px] text-ink-soft">
            This ticket is {ticket.status}. Sending a reply will reopen it.
          </p>
        ) : null}
        <AttachmentPicker files={files} onChange={setFiles} disabled={busy} progress={progress} />

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
          {ended ? (
            <button type="button" className="btn-outline" disabled={busy} onClick={() => void move('reopen')}>
              Reopen ticket
            </button>
          ) : side === 'admin' ? (
            /* Support's way of ending a ticket: the matter is dealt with.
               An affiliate gets Close instead, for one they no longer need. */
            <button type="button" className="btn-gold" disabled={busy} onClick={() => void move('resolve')}>
              Mark as resolved
            </button>
          ) : (
            <button type="button" className="btn-outline" disabled={busy} onClick={() => void move('close')}>
              Close ticket
            </button>
          )}
          <button type="submit" className="btn-primary" disabled={busy || body.trim() === ''}>
            {busy ? (files.length > 0 ? 'Uploading' : 'Sending') : 'Send reply'}
          </button>
        </div>
      </form>
    </>
  );
}
