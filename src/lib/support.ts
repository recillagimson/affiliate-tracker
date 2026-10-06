/**
 * Support tickets: the rules, as plain functions.
 *
 * An affiliate opens a ticket, admins answer it, and the two sides talk until
 * it is closed. Everything here is a decision that needs no database and no
 * request: who is on which side, who may read what, when a ticket counts as
 * unread, what the list says about it, and what an attached image has to be
 * before it is kept. scripts/support-checks.ts pins all of it.
 *
 * Named "support" rather than "ticket" throughout, because that word already
 * means the view-as ticket in lib/impersonation.ts and the request counter in
 * lib/optimistic.ts. The pages still call the thing a ticket.
 *
 * Pure. receipt-file.ts is the only import with code in it, and that is pure
 * too, so the checks load this file without a database, a session or Next.js.
 */

import { cleanFileName, decodedSize, headBytes, isBase64, matchesType } from './receipt-file';
import type { Viewer } from './viewer-core';

/* -------------------------------------------------------------- constants --- */

/** The same four, in the same order, as the check constraint in the migration. */
export const SUPPORT_CATEGORIES = ['question', 'payout', 'bug', 'feedback'] as const;
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<SupportCategory, string> = {
  question: 'Question',
  payout: 'Payout issue',
  bug: 'Bug',
  feedback: 'Feedback',
};

export const SUPPORT_STATUSES = ['open', 'closed'] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];

/** Which half of the conversation somebody is on. */
export type SupportSide = 'affiliate' | 'admin';

/**
 * Images only. A ticket attachment is a screenshot of what somebody is asking
 * about; a PDF is a document, and documents already have their own places in
 * this app. SVG is left out for the reason receipt-file.ts gives.
 */
export const SUPPORT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type SupportImageType = (typeof SUPPORT_IMAGE_TYPES)[number];

export const MAX_SUBJECT = 150;
export const MAX_BODY = 5_000;
export const MAX_ATTACHMENTS = 3;

/*
 * Across one message, not per file. The files travel as base64 inside the JSON
 * body, a third larger than they are, and the host refuses a request over
 * about 4.5 MB. Three megabytes of image is four of base64, which leaves room
 * for the text around it.
 */
export const MAX_ATTACHMENT_BYTES = 3_000_000;

export function isSupportCategory(value: unknown): value is SupportCategory {
  return typeof value === 'string' && (SUPPORT_CATEGORIES as readonly string[]).includes(value);
}

export function isSupportStatus(value: unknown): value is SupportStatus {
  return typeof value === 'string' && (SUPPORT_STATUSES as readonly string[]).includes(value);
}

export function isSupportImageType(value: unknown): value is SupportImageType {
  return typeof value === 'string' && (SUPPORT_IMAGE_TYPES as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ shape --- */

export type SupportTicket = {
  id: string;
  /** The affiliate the ticket belongs to, whoever opened it. */
  userId: string;
  subject: string;
  category: SupportCategory;
  status: SupportStatus;
  openedBy: string;
  openedByRole: SupportSide;
  createdAt: string;
  lastMessageAt: string;
  lastMessageRole: SupportSide;
  affiliateReadAt: string | null;
  /** Shared by every admin: read by one is read for all. */
  adminReadAt: string | null;
  closedAt: string | null;
  closedBy: string;
};

/** An attachment without its bytes, which is all a page ever needs to draw it. */
export type SupportAttachmentMeta = { id: string; name: string; type: string; size: number };

export type SupportMessage = {
  id: string;
  authorRole: SupportSide;
  authorId: string;
  /** "username", or "username (via Admin Name)" when sent from Client View. */
  authorName: string;
  body: string;
  createdAt: string;
  attachments: SupportAttachmentMeta[];
};

/** An image that has passed every check, as the store keeps it. `data` is bare base64. */
export type SupportUpload = { name: string; type: SupportImageType; data: string; size: number };

/* ----------------------------------------------------------------- access --- */

/**
 * An admin in Client View is the affiliate as far as the session goes, role
 * and all, so they land on the affiliate side with no special case here.
 */
export function sideFor(viewer: Pick<Viewer, 'role'>): SupportSide {
  return viewer.role === 'admin' ? 'admin' : 'affiliate';
}

/** An admin, or the affiliate the ticket belongs to. A blank id is nobody's. */
export function mayReadTicket(viewer: Pick<Viewer, 'role' | 'id'>, ownerUserId: string): boolean {
  if (viewer.role === 'admin') return true;
  return viewer.id !== '' && viewer.id === ownerUserId;
}

/* ----------------------------------------------------------------- unread --- */

/**
 * Whether this side has something it has not read.
 *
 * Only a message from the other side can be unread; your own never is. Then
 * it is unread until this side's read time is at or after it. A read time
 * that cannot be parsed counts as never read, so a damaged row shows a badge
 * rather than hiding a reply.
 */
export function isUnreadFor(
  ticket: Pick<SupportTicket, 'lastMessageRole' | 'lastMessageAt' | 'affiliateReadAt' | 'adminReadAt'>,
  side: SupportSide,
): boolean {
  if (ticket.lastMessageRole === side) return false;
  const readAt = side === 'affiliate' ? ticket.affiliateReadAt : ticket.adminReadAt;
  if (!readAt) return true;
  const read = Date.parse(readAt);
  const last = Date.parse(ticket.lastMessageAt);
  if (!Number.isFinite(read)) return true;
  return read < last;
}

export function unreadCount(
  tickets: Pick<SupportTicket, 'lastMessageRole' | 'lastMessageAt' | 'affiliateReadAt' | 'adminReadAt'>[],
  side: SupportSide,
): number {
  return tickets.filter((ticket) => isUnreadFor(ticket, side)).length;
}

/** What the tab's badge says. Nothing at all for zero. */
export function badgeText(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '';
  return count > 99 ? '99+' : String(Math.floor(count));
}

/* --------------------------------------------------------------- the list --- */

/**
 * Whose move it is. The affiliate is told "you" rather than "affiliate":
 * a label describing the reader in the third person reads as somebody else.
 */
export function waitingLabel(
  ticket: Pick<SupportTicket, 'status' | 'lastMessageRole'>,
  side: SupportSide,
): string {
  if (ticket.status === 'closed') return 'Closed';
  if (ticket.lastMessageRole === 'affiliate') return 'Waiting on support';
  return side === 'affiliate' ? 'Waiting on you' : 'Waiting on affiliate';
}

export type SupportRow = {
  id: string;
  subject: string;
  /** The category's label, ready to show. */
  category: string;
  status: SupportStatus;
  waiting: string;
  unread: boolean;
  lastAt: string;
  /** The affiliate's name. Shown to admins only. */
  person: string;
};

export function buildSupportRows(
  tickets: SupportTicket[],
  side: SupportSide,
  names: Map<string, string>,
): SupportRow[] {
  return tickets.map((ticket) => ({
    id: ticket.id,
    subject: ticket.subject,
    category: CATEGORY_LABELS[ticket.category],
    status: ticket.status,
    waiting: waitingLabel(ticket, side),
    unread: isUnreadFor(ticket, side),
    lastAt: ticket.lastMessageAt,
    person: names.get(ticket.userId) ?? 'Unknown account',
  }));
}

/* ---------------------------------------------------------------- filters --- */

export type StatusFilter = SupportStatus | 'all';

/** Open unless the URL says otherwise: the open ones are the work. */
export function statusFilterFrom(value: unknown): StatusFilter {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return text === 'closed' || text === 'all' ? text : 'open';
}

export function categoryFilterFrom(value: unknown): SupportCategory | '' {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return isSupportCategory(text) ? text : '';
}

export function supportHref(filter: {
  status: StatusFilter;
  category: SupportCategory | '';
  unread: boolean;
}): string {
  const params: string[] = [];
  if (filter.status !== 'open') params.push(`status=${filter.status}`);
  if (filter.category) params.push(`category=${filter.category}`);
  if (filter.unread) params.push('unread=1');
  return params.length === 0 ? '/support' : `/support?${params.join('&')}`;
}

/* ------------------------------------------------------------ attachments --- */

export type AttachmentCheck =
  | { ok: true; files: SupportUpload[] }
  | { ok: false; error: string; hint: string };

const BROKEN = 'Those images did not arrive in one piece.';
const AGAIN = 'Try attaching them again.';

function no(error: string, hint: string): AttachmentCheck {
  return { ok: false, error, hint };
}

/**
 * Everything a message's images have to be before they are stored, in the
 * order that costs least to ask: how many, what they claim to be, how big they
 * are together, and last the bytes themselves.
 *
 * The same two defences receipts get. The declared type is what the file was
 * called, not what it is, so the first bytes have to be that type's signature
 * or the file is refused rather than stored and trusted later.
 */
export function checkSupportAttachments(input: unknown): AttachmentCheck {
  if (input === undefined || input === null) return { ok: true, files: [] };
  if (!Array.isArray(input)) return no(BROKEN, AGAIN);
  if (input.length > MAX_ATTACHMENTS) {
    return no(`Up to ${MAX_ATTACHMENTS} images can be attached to a message.`, 'Remove one and send it again.');
  }

  const files: SupportUpload[] = [];
  let total = 0;
  for (const entry of input) {
    const item = entry !== null && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
    const type = item.type;
    if (!isSupportImageType(type)) {
      return no('Only images can be attached.', 'A PNG, JPEG or WebP screenshot.');
    }

    const prefix = `data:${type};base64,`;
    const data = item.data;
    if (typeof data !== 'string' || !data.startsWith(prefix)) return no(BROKEN, AGAIN);
    const payload = data.slice(prefix.length);
    if (!payload) return no(BROKEN, AGAIN);

    // Counted from the length before the payload is scanned, so an oversized
    // upload is turned away without reading all of it.
    const size = decodedSize(payload);
    total += size;
    if (total > MAX_ATTACHMENT_BYTES) {
      return no('Those images are too large together.', 'Up to about 3 MB in total. Try fewer, or crop them.');
    }

    if (!isBase64(payload)) return no(BROKEN, AGAIN);
    if (!matchesType(headBytes(payload), type)) {
      return no(
        'One of those files does not look like the image it claims to be.',
        'Attach the original PNG, JPEG or WebP, not a renamed copy.',
      );
    }

    const name = typeof item.name === 'string' && item.name.trim() !== '' ? cleanFileName(item.name) : 'image';
    files.push({ name, type, data: payload, size });
  }
  return { ok: true, files };
}
