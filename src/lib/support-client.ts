/**
 * What the support forms do in the browser before and after a request.
 *
 * Shared by the new-ticket form and the reply box, which both take files from
 * a picker, a drop or a paste, upload them straight to storage, send a JSON
 * body to /api/support, and have to turn whatever comes back into a sentence.
 *
 * The checks here repeat the route's, on purpose. The route is the one that
 * decides; these exist so somebody who picked six files is told so at once,
 * rather than after uploading a video to be refused.
 */

import { isSupportFileType, MAX_ATTACHMENTS, MAX_FILE_BYTES } from './support';

/** What is wrong with the files somebody picked, or '' when nothing is. Pure. */
export function checkPicked(files: { size: number; type: string }[]): string {
  if (files.length > MAX_ATTACHMENTS) return `Up to ${MAX_ATTACHMENTS} files can be attached to a message.`;
  if (files.some((file) => !isSupportFileType(file.type))) {
    return 'Only images (PNG, JPEG, WebP), videos (MP4, MOV, WebM) and PDFs can be attached.';
  }
  if (files.some((file) => file.size > MAX_FILE_BYTES)) return 'One of those files is over 50 MB. Trim it, or send a shorter one.';
  return '';
}

/**
 * The chosen files plus some more, without the same file twice. Pure.
 *
 * Dropping a file that is already in the list, or picking it again from the
 * dialog, is somebody making sure it is attached, not asking for two copies.
 */
export function addPicked<T extends { name: string; size: number; lastModified: number }>(current: T[], added: T[]): T[] {
  const out = [...current];
  for (const file of added) {
    const same = out.some((have) => have.name === file.name && have.size === file.size && have.lastModified === file.lastModified);
    if (!same) out.push(file);
  }
  return out;
}

/** The files on a clipboard or in a drop. A pasted screenshot arrives as one of these. */
export function filesFrom(transfer: DataTransfer | null): File[] {
  if (!transfer) return [];
  return Array.from(transfer.files ?? []);
}

/** One file, sent straight to storage. XMLHttpRequest because fetch cannot report upload progress. */
function putFile(url: string, file: File, onProgress: (percent: number) => void): Promise<boolean> {
  return new Promise((resolve) => {
    const request = new XMLHttpRequest();
    request.open('PUT', url);
    request.setRequestHeader('content-type', file.type);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    request.onload = () => resolve(request.status >= 200 && request.status < 300);
    request.onerror = () => resolve(false);
    request.onabort = () => resolve(false);
    request.send(file);
  });
}

/**
 * Upload the chosen files and return what a message needs to carry them.
 *
 * Two steps. The route is asked for somewhere to put each file, which is
 * where it refuses a type or a size it will not take. Then each file goes
 * from this browser straight to storage, one after another so the progress
 * somebody sees is one bar moving at a time.
 */
export async function uploadFiles(
  files: File[],
  onProgress: (index: number, percent: number) => void,
): Promise<{ ok: true; attachments: { path: string; name: string }[] } | { ok: false; error: string }> {
  if (files.length === 0) return { ok: true, attachments: [] };
  const problem = checkPicked(files);
  if (problem) return { ok: false, error: problem };

  const asked = await postSupport({
    action: 'upload',
    files: files.map((file) => ({ name: file.name, type: file.type, size: file.size })),
  });
  if (!asked.ok) return { ok: false, error: asked.error };
  const places = Array.isArray(asked.payload.uploads) ? (asked.payload.uploads as { path?: unknown; url?: unknown }[]) : [];
  if (places.length !== files.length) return { ok: false, error: 'Those files could not be uploaded. Try again.' };

  const attachments: { path: string; name: string }[] = [];
  for (let index = 0; index < files.length; index++) {
    const file = files[index]!;
    const place = places[index]!;
    if (typeof place.path !== 'string' || typeof place.url !== 'string') {
      return { ok: false, error: 'Those files could not be uploaded. Try again.' };
    }
    onProgress(index, 0);
    const sent = await putFile(place.url, file, (percent) => onProgress(index, percent));
    if (!sent) return { ok: false, error: `${file.name} did not upload. Check your connection and try again.` };
    onProgress(index, 100);
    attachments.push({ path: place.path, name: file.name });
  }
  return { ok: true, attachments };
}

/**
 * What to tell somebody when a request was refused. Pure.
 *
 * 413 is the host turning the body away before the route ever saw it, so it
 * arrives with no JSON and no sentence of ours; it gets one here.
 */
export function failureText(status: number, payload: Record<string, unknown>): string {
  if (status === 413) return 'That message is too large to send. Shorten it and try again.';
  const error = typeof payload.error === 'string' ? payload.error : '';
  const hint = typeof payload.hint === 'string' ? payload.hint : '';
  if (error) return hint ? `${error} ${hint}` : error;
  return `That did not save (${status}).`;
}

export async function postSupport(
  body: Record<string, unknown>,
): Promise<{ ok: true; payload: Record<string, unknown> } | { ok: false; error: string; fields: Record<string, string> }> {
  let res: Response;
  try {
    res = await fetch('/api/support', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: 'That did not send. Check your connection and try again.', fields: {} };
  }
  const payload = ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  if (!res.ok) {
    const fields = payload.fields && typeof payload.fields === 'object' ? (payload.fields as Record<string, string>) : {};
    return { ok: false, error: failureText(res.status, payload), fields };
  }
  return { ok: true, payload };
}

/**
 * What an admin has to be told after opening a ticket, or '' when there is
 * nothing to say. Pure.
 *
 * Opening one normally goes straight to the conversation. When the affiliate
 * could not be emailed, that is the one thing the admin needs to know before
 * moving on, because otherwise they believe somebody was told who was not.
 */
export function openedNotice(payload: Record<string, unknown>): string {
  if (payload.emailed !== false) return '';
  const why = typeof payload.emailProblem === 'string' ? payload.emailProblem.trim() : '';
  return why ? `Ticket opened. No email went: ${why}` : 'Ticket opened. No email went.';
}

/** What to add to a success message about the email, if the route said anything. */
export function emailNote(payload: Record<string, unknown>): string {
  if (payload.emailed === true) return ' They have been emailed.';
  if (typeof payload.emailProblem === 'string' && payload.emailProblem) return ` No email went: ${payload.emailProblem}`;
  return '';
}
