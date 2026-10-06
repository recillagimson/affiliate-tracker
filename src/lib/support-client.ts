/**
 * What the support forms do in the browser before and after a request.
 *
 * Shared by the new-ticket form and the reply box, which both read images off
 * a file input, send a JSON body to /api/support, and have to turn whatever
 * comes back into a sentence.
 *
 * The checks here repeat the route's, on purpose. The route is the one that
 * decides; these exist so somebody who picked four files is told so at once,
 * rather than after uploading three megabytes to be refused.
 */

import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, isSupportImageType } from './support';

/** What is wrong with the files somebody picked, or '' when nothing is. Pure. */
export function checkPicked(files: { size: number; type: string }[]): string {
  if (files.length > MAX_ATTACHMENTS) return `Up to ${MAX_ATTACHMENTS} images can be attached to a message.`;
  if (files.some((file) => !isSupportImageType(file.type))) return 'Only PNG, JPEG or WebP images can be attached.';
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > MAX_ATTACHMENT_BYTES) return 'Those images are too large together. Up to about 3 MB in total.';
  return '';
}

/** Each picked file as a data URL, the shape the route reads. */
export async function readImages(
  files: File[],
): Promise<{ ok: true; attachments: { name: string; type: string; data: string }[] } | { ok: false; error: string }> {
  const problem = checkPicked(files);
  if (problem) return { ok: false, error: problem };
  const attachments: { name: string; type: string; data: string }[] = [];
  for (const file of files) {
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.onerror = () => reject(new Error('unreadable'));
      reader.readAsDataURL(file);
    }).catch(() => '');
    if (!data) return { ok: false, error: `${file.name} could not be read. Attach it again.` };
    attachments.push({ name: file.name, type: file.type, data });
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
  if (status === 413) return 'Those images are too large to send. Try fewer, or crop them.';
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

/** What to add to a success message about the email, if the route said anything. */
export function emailNote(payload: Record<string, unknown>): string {
  if (payload.emailed === true) return ' They have been emailed.';
  if (typeof payload.emailProblem === 'string' && payload.emailProblem) return ` No email went: ${payload.emailProblem}`;
  return '';
}
