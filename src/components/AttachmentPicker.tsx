'use client';

import { useEffect, useRef, useState } from 'react';
import {
  fileKind,
  MAX_ATTACHMENTS,
  sizeText,
  SUPPORT_FILE_TYPES,
} from '@/lib/support';
import { addPicked, checkPicked, filesFrom } from '@/lib/support-client';

/**
 * Choosing what to attach to a support message.
 *
 * A drop target rather than a bare file input, because the thing people attach
 * to a ticket is nearly always on screen already: a screenshot they just took,
 * or a recording sitting on the desktop. So there are three ways in. Drag it
 * here, press Browse, or paste, which the form around this handles so that a
 * paste into the message box works too.
 *
 * What is chosen is listed underneath with a preview, its size and a way to
 * take it off again. Nothing is uploaded until the message is sent; while it
 * is, each row shows how far its upload has got.
 *
 * The list of files lives with the caller. This component only ever proposes
 * a new list, and refuses one that could not be sent, saying why.
 */
export function AttachmentPicker({
  files,
  onChange,
  disabled = false,
  progress = [],
}: {
  files: File[];
  onChange: (files: File[]) => void;
  /** True while the message is sending: nothing can be added or removed. */
  disabled?: boolean;
  /** How far each file's upload has got, 0 to 100, by its place in `files`. */
  progress?: number[];
}) {
  const input = useRef<HTMLInputElement | null>(null);
  const [over, setOver] = useState(false);
  const [problem, setProblem] = useState('');

  function add(added: File[]) {
    if (disabled || added.length === 0) return;
    const next = addPicked(files, added);
    const wrong = checkPicked(next);
    if (wrong) {
      // Refused whole, rather than keeping the ones that fit: a list that
      // silently dropped a file is a message sent without it.
      setProblem(wrong);
      return;
    }
    setProblem('');
    onChange(next);
  }

  const full = files.length >= MAX_ATTACHMENTS;

  return (
    <div>
      <div
        data-over={over ? 'true' : 'false'}
        onDragOver={(event) => {
          if (disabled) return;
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          add(filesFrom(event.dataTransfer));
        }}
        className={`rounded-[10px] border-2 border-dashed px-4 py-5 text-center transition-colors ${
          over ? 'border-navy bg-navy-wash' : 'border-edge-strong bg-paper-sunk'
        } ${disabled ? 'opacity-60' : ''}`}
      >
        <p className="text-[13px] text-ink">
          <span className="font-medium">Drag files here</span>, paste a screenshot, or{' '}
          <button
            type="button"
            className="link-text font-medium"
            disabled={disabled || full}
            onClick={() => input.current?.click()}
          >
            Browse
          </button>
        </p>
        <p className="mt-1.5 text-[12px] text-ink-soft">
          Images, videos (MP4, MOV, WebM) or PDF. Up to {MAX_ATTACHMENTS} files, 50 MB each.
        </p>
        <input
          ref={input}
          type="file"
          multiple
          accept={SUPPORT_FILE_TYPES.join(',')}
          className="sr-only"
          tabIndex={-1}
          aria-label="Attach files"
          disabled={disabled}
          onChange={(event) => {
            add(Array.from(event.target.files ?? []));
            // Cleared so choosing the same file again, after removing it, still fires.
            event.target.value = '';
          }}
        />
      </div>

      {problem ? (
        <p role="alert" className="mt-2 text-[13px] text-alarm">
          {problem}
        </p>
      ) : null}

      {files.length > 0 ? (
        <>
          <p className="mt-3 text-[12px] text-ink-soft">
            {files.length} of {MAX_ATTACHMENTS} attached
          </p>
          <ul className="mt-2 space-y-2">
            {files.map((file, index) => {
              const sent = progress[index];
              return (
                <li
                  key={`${file.name}:${file.size}:${file.lastModified}`}
                  className="flex items-center gap-3 rounded-[8px] border border-edge bg-panel p-2"
                >
                  <Preview file={file} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-ink">{file.name}</span>
                    <span className="block text-[12px] text-ink-soft">{sizeText(file.size)}</span>
                    {sent !== undefined ? (
                      <span
                        role="progressbar"
                        aria-label={`Uploading ${file.name}`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={sent}
                        className="mt-1.5 block h-1 w-full overflow-hidden rounded-full bg-edge"
                      >
                        <span className="block h-full bg-navy transition-[width]" style={{ width: `${sent}%` }} />
                      </span>
                    ) : null}
                  </span>
                  {disabled ? null : (
                    <button
                      type="button"
                      className="btn-quiet btn-sm flex-none"
                      aria-label={`Remove ${file.name}`}
                      onClick={() => {
                        setProblem('');
                        onChange(files.filter((_, at) => at !== index));
                      }}
                    >
                      Remove
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </div>
  );
}

/**
 * A small picture of a chosen file: the image itself, or a tile saying what
 * kind of file it is.
 *
 * The image is read through an object URL made after mount and released when
 * the row goes, so a removed file's memory goes with it.
 */
function Preview({ file }: { file: File }) {
  const kind = fileKind(file.type);
  const [url, setUrl] = useState('');

  useEffect(() => {
    if (kind !== 'image') return;
    const made = URL.createObjectURL(file);
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [file, kind]);

  if (kind === 'image' && url) {
    return <img src={url} alt="" className="h-11 w-11 flex-none rounded-[6px] object-cover" />;
  }
  return (
    <span
      aria-hidden
      className="flex h-11 w-11 flex-none items-center justify-center rounded-[6px] bg-navy-wash text-[10px] font-semibold uppercase tracking-[0.04em] text-navy"
    >
      {kind === 'video' ? 'Video' : kind === 'document' ? 'PDF' : 'Image'}
    </span>
  );
}
