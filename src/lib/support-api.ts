/**
 * The rules the support routes apply, as plain functions.
 *
 * /api/support makes the same kinds of decision the payout routes do: is this
 * body readable, whose ticket is it, and what does a refusal say. None of that
 * needs a request or a database, and nothing in this repo can run a route
 * handler under test, so the decisions live here and
 * scripts/support-api-checks.ts pins them. The route is left holding the order
 * things happen in.
 *
 * Every sentence here can reach an affiliate, so none has a dash in it and
 * none names another account.
 *
 * Pure. payout-api.ts is imported for the body readers and the audit line it
 * already has, rather than writing them a second time.
 */

import { asBody, readRowId, requestedByFor, textField, type Refusal } from './payout-api';
import {
  checkSupportAttachments,
  isSupportCategory,
  MAX_BODY,
  MAX_SUBJECT,
  sideFor,
  type SupportCategory,
  type SupportSide,
  type SupportUpload,
} from './support';
import type { Viewer } from './viewer-core';

export { asBody };

/* ---------------------------------------------------------------- actions --- */

export type SupportAction = 'open' | 'reply' | 'close' | 'reopen' | 'read';

const ACTIONS: readonly SupportAction[] = ['open', 'reply', 'close', 'reopen', 'read'];

export function readSupportAction(value: unknown): SupportAction | null {
  return typeof value === 'string' && (ACTIONS as readonly string[]).includes(value)
    ? (value as SupportAction)
    : null;
}

/* ----------------------------------------------------------- which ticket --- */

/**
 * The one answer for a ticket this viewer cannot have: one that never was, an
 * id that could not be one, or somebody else's. The ids are sequential, so a
 * 403 of its own would let any affiliate walk them and learn which exist.
 */
export function noSuchTicket(): Refusal {
  return { status: 404, error: 'No such ticket.' };
}

export function readTicketId(value: unknown): { ok: true; id: string } | { ok: false; refusal: Refusal } {
  const id = readRowId(value);
  if (id) return { ok: true, id };
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    return { ok: false, refusal: { status: 400, error: 'Which ticket?' } };
  }
  return { ok: false, refusal: noSuchTicket() };
}

/* ------------------------------------------------------------------ fields --- */

function invalid(error: string, field: string): Refusal {
  return { status: 400, error, fields: { [field]: error } };
}

/**
 * A subject, tidied. Every run of whitespace becomes one space: a subject is
 * one line wherever it is shown, and it is also an email's Subject header,
 * where a line break is how a header gets a second header nobody wrote.
 */
function readSubject(body: Record<string, unknown>): { ok: true; text: string } | { ok: false; refusal: Refusal } {
  const text = textField(body, 'subject').replace(/\s+/g, ' ').trim();
  if (!text) return { ok: false, refusal: invalid('Give the ticket a subject.', 'subject') };
  if (text.length > MAX_SUBJECT) {
    return { ok: false, refusal: invalid(`Keep the subject to ${MAX_SUBJECT} characters.`, 'subject') };
  }
  return { ok: true, text };
}

function readMessage(body: Record<string, unknown>): { ok: true; text: string } | { ok: false; refusal: Refusal } {
  const text = textField(body, 'body').trim();
  if (!text) return { ok: false, refusal: invalid('Write a message first.', 'body') };
  if (text.length > MAX_BODY) {
    return {
      ok: false,
      refusal: invalid(`Keep a message to ${MAX_BODY.toLocaleString('en-US')} characters.`, 'body'),
    };
  }
  return { ok: true, text };
}

function readFiles(body: Record<string, unknown>): { ok: true; files: SupportUpload[] } | { ok: false; refusal: Refusal } {
  const result = checkSupportAttachments(body.attachments);
  if (result.ok) return { ok: true, files: result.files };
  return {
    ok: false,
    refusal: { status: 400, error: result.error, hint: result.hint, fields: { attachments: result.error } },
  };
}

/* ---------------------------------------------------------------- opening --- */

export type OpenInput = {
  userId: string;
  subject: string;
  category: SupportCategory;
  body: string;
  files: SupportUpload[];
};

/**
 * A new ticket, and who it is for.
 *
 * An affiliate's ticket is their own: the body's `userId` is not read at all,
 * so a hand-made POST can only ever open a ticket for the person who sent it.
 * An admin has to say who it is for. Whether that account exists and is an
 * affiliate is the database's to decide, inside the transaction that writes it.
 */
export function readOpen(
  body: Record<string, unknown>,
  viewer: Pick<Viewer, 'role' | 'id'>,
): { ok: true; value: OpenInput } | { ok: false; refusal: Refusal } {
  let userId: string;
  if (sideFor(viewer) === 'affiliate') {
    if (!viewer.id) return { ok: false, refusal: { status: 403, error: 'This account cannot open a ticket.' } };
    userId = viewer.id;
  } else {
    userId = textField(body, 'userId').trim();
    if (!userId) return { ok: false, refusal: invalid('Choose who this ticket is for.', 'userId') };
  }

  const subject = readSubject(body);
  if (!subject.ok) return subject;
  const category = body.category;
  if (!isSupportCategory(category)) {
    return { ok: false, refusal: invalid('Choose what the ticket is about.', 'category') };
  }
  const message = readMessage(body);
  if (!message.ok) return message;
  const files = readFiles(body);
  if (!files.ok) return files;

  return {
    ok: true,
    value: { userId, subject: subject.text, category, body: message.text, files: files.files },
  };
}

/* --------------------------------------------------------------- replying --- */

export type ReplyInput = { ticketId: string; body: string; files: SupportUpload[] };

export function readReply(
  body: Record<string, unknown>,
): { ok: true; value: ReplyInput } | { ok: false; refusal: Refusal } {
  const id = readTicketId(body.ticketId);
  if (!id.ok) return id;
  const message = readMessage(body);
  if (!message.ok) return message;
  const files = readFiles(body);
  if (!files.ok) return files;
  return { ok: true, value: { ticketId: id.id, body: message.text, files: files.files } };
}

/* ------------------------------------------------------------- the viewer --- */

/**
 * Who a message is recorded as written by.
 *
 * From Client View the viewer is the affiliate, so the role is 'affiliate' and
 * the id is theirs; the name is the one place it says an admin was behind it.
 */
export function authorFor(
  viewer: Pick<Viewer, 'role' | 'id' | 'username' | 'actingAs'>,
): { role: SupportSide; id: string; name: string } {
  return { role: sideFor(viewer), id: viewer.id, name: requestedByFor(viewer) };
}

/**
 * The user id every read and write is confined to, or undefined for an admin.
 *
 * An affiliate with a blank id gets '' rather than undefined: a blank id must
 * match nobody, never read as "no restriction".
 */
export function ownerFilter(viewer: Pick<Viewer, 'role' | 'id'>): string | undefined {
  return sideFor(viewer) === 'affiliate' ? viewer.id : undefined;
}

/**
 * Whether opening a thread records it as read.
 *
 * Not from Client View. An admin looking at an affiliate's screen has not
 * read the reply on the affiliate's behalf, and clearing their badge would
 * mean they never learn it came.
 */
export function shouldMarkRead(viewer: Pick<Viewer, 'actingAs'>): boolean {
  return viewer.actingAs === null;
}

/* ----------------------------------------------------------------- limits --- */

const HOUR = 3_600_000;

/** How much one affiliate may send. Admins are not limited. */
export const SUPPORT_LIMITS: Record<'open' | 'reply', { limit: number; windowMs: number }> = {
  open: { limit: 5, windowMs: HOUR },
  reply: { limit: 30, windowMs: HOUR },
};

export function throttleApplies(viewer: Pick<Viewer, 'role'>): boolean {
  return sideFor(viewer) === 'affiliate';
}

export function tooMany(): Refusal {
  return {
    status: 429,
    error: 'That is a lot of messages in a short time.',
    hint: 'Give it a little while and try again.',
  };
}

/* ----------------------------------------------------------------- status --- */

/** A close or reopen that matched nothing, because the ticket was already there. */
export function alreadyRefusal(action: 'close' | 'reopen'): Refusal {
  return action === 'close'
    ? { status: 409, error: 'That ticket is already closed.', hint: 'Reload the page to see it.' }
    : { status: 409, error: 'That ticket is already open.', hint: 'Reload the page to see it.' };
}

/* ------------------------------------------------------------------ email --- */

/** Why no email will be sent, or '' when one can be. Shown to the admin who replied. */
export function emailSkipReason(email: string): string {
  return email.trim() === '' ? 'They have no email address on file, so no email was sent.' : '';
}
