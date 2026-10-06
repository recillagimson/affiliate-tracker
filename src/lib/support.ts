/**
 * Support tickets: the rules, as plain functions.
 *
 * An affiliate opens a ticket, admins answer it, and the two sides talk until
 * it is closed. Everything here is a decision that needs no database and no
 * request: who is on which side, who may read what, when a ticket counts as
 * unread, what the list says about it, and which files a message may carry. scripts/support-checks.ts pins all of it.
 *
 * Named "support" rather than "ticket" throughout, because that word already
 * means the view-as ticket in lib/impersonation.ts and the request counter in
 * lib/optimistic.ts. The pages still call the thing a ticket.
 *
 * Pure. receipt-file.ts is the only import with code in it, and that is pure
 * too, so the checks load this file without a database, a session or Next.js.
 */

import { cleanFileName } from './receipt-file';
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

/**
 * Open while it is being worked on. Resolved when an admin has dealt with it.
 * Closed when it ended without that, usually because the affiliate closed it.
 * The same three, in the same order, as the check constraint in the
 * 20261008120000 migration.
 */
export const SUPPORT_STATUSES = ['open', 'resolved', 'closed'] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];

/** Which half of the conversation somebody is on. */
export type SupportSide = 'affiliate' | 'admin';

/**
 * What can be attached: a screenshot, a screen recording, or a PDF. The same
 * list, in the same order, as the bucket's allowed types and the table's check
 * constraint in the storage migration. SVG and HTML are left out on purpose:
 * both can carry script.
 */
export const SUPPORT_FILE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'application/pdf',
] as const;
export type SupportFileType = (typeof SUPPORT_FILE_TYPES)[number];

/** The private Supabase Storage bucket the files live in. */
export const SUPPORT_BUCKET = 'support-attachments';

export const MAX_SUBJECT = 150;
export const MAX_BODY = 5_000;
export const MAX_ATTACHMENTS = 5;

/*
 * Per file. A minute or two of screen recording, and the most a Supabase
 * project accepts in one upload without being reconfigured. The files go from
 * the browser straight to storage, so the host's request limit is not in the
 * way; this number and the bucket's own limit are.
 */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

export function isSupportCategory(value: unknown): value is SupportCategory {
  return typeof value === 'string' && (SUPPORT_CATEGORIES as readonly string[]).includes(value);
}

export function isSupportStatus(value: unknown): value is SupportStatus {
  return typeof value === 'string' && (SUPPORT_STATUSES as readonly string[]).includes(value);
}

export function isSupportFileType(value: unknown): value is SupportFileType {
  return typeof value === 'string' && (SUPPORT_FILE_TYPES as readonly string[]).includes(value);
}

/** How a file is shown: drawn, played, or linked. '' for a type that cannot be attached. */
export function fileKind(type: string): 'image' | 'video' | 'document' | '' {
  if (!isSupportFileType(type)) return '';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  return 'document';
}

/** A size the way people say it. */
export function sizeText(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

/** A file already in storage and checked there, as the store records it. */
export type SupportUpload = { name: string; type: SupportFileType; size: number; path: string };

/** A file somebody wants to upload, as described by the browser before a byte has moved. */
export type UploadAsk = { name: string; type: SupportFileType; size: number };

/** A file a message claims to carry: where it was uploaded, and what to call it. */
export type AttachmentRef = { path: string; name: string };

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

/**
 * Whether a ticket adds to this side's badge.
 *
 * For admins, only while it is open. An affiliate who says thanks and closes
 * the ticket leaves a message no admin has read, but the admin list opens on
 * Open, so a badge for it would point at a page showing nothing unread. The
 * affiliate's list shows every ticket, so theirs counts whatever its status.
 */
export function countsTowardBadge(
  ticket: Pick<SupportTicket, 'status' | 'lastMessageRole' | 'lastMessageAt' | 'affiliateReadAt' | 'adminReadAt'>,
  side: SupportSide,
): boolean {
  if (side === 'admin' && ticket.status !== 'open') return false;
  return isUnreadFor(ticket, side);
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
  if (ticket.status === 'resolved') return 'Resolved';
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

/** Everything unless the URL says otherwise, so no ticket is ever out of sight on arrival. */
export function statusFilterFrom(value: unknown): StatusFilter {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return text === 'open' || text === 'resolved' || text === 'closed' ? text : 'all';
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
  if (filter.status !== 'all') params.push(`status=${filter.status}`);
  if (filter.category) params.push(`category=${filter.category}`);
  if (filter.unread) params.push('unread=1');
  return params.length === 0 ? '/support' : `/support?${params.join('&')}`;
}

/* ------------------------------------------------------------ attachments --- */

/*
 * Files do not travel through this app. The browser asks for somewhere to put
 * them, uploads each one straight to a private storage bucket, and then sends
 * the message with the paths it was given. So there are two things to check,
 * at two moments: what somebody asks to upload, and which uploaded paths a
 * message is allowed to claim. What the file actually is, once it has landed,
 * is read back from storage by the route (its real size and type), never
 * taken from the browser's word.
 */

type Refused = { ok: false; error: string; hint: string };

function no(error: string, hint: string): Refused {
  return { ok: false, error, hint };
}

const UNREADABLE = 'Those files could not be read.';
const AGAIN = 'Try attaching them again.';
const TYPES_HINT = 'A PNG, JPEG or WebP image, an MP4, MOV or WebM video, or a PDF.';

/** What an upload has to be before it is given somewhere to go. */
export function checkUploadRequest(input: unknown): { ok: true; files: UploadAsk[] } | Refused {
  if (!Array.isArray(input) || input.length === 0) return no('Choose at least one file.', AGAIN);
  if (input.length > MAX_ATTACHMENTS) {
    return no(`Up to ${MAX_ATTACHMENTS} files can be attached to a message.`, 'Remove one and send it again.');
  }
  const files: UploadAsk[] = [];
  for (const entry of input) {
    const item = entry !== null && typeof entry === 'object' ? (entry as Record<string, unknown>) : null;
    if (!item) return no(UNREADABLE, AGAIN);
    const type = item.type;
    if (!isSupportFileType(type)) return no('That kind of file cannot be attached.', TYPES_HINT);
    const size = item.size;
    if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return no(UNREADABLE, AGAIN);
    if (size > MAX_FILE_BYTES) {
      return no('One of those files is too large.', 'Up to 50 MB each. Trim the video, or send a shorter one.');
    }
    const name = typeof item.name === 'string' && item.name.trim() !== '' ? cleanFileName(item.name) : 'file';
    files.push({ name, type, size });
  }
  return { ok: true, files };
}

/**
 * The folder one account's uploads go into. Their id, with anything a storage
 * path would trip on replaced: the environment admin's id has a colon in it.
 */
export function uploaderKey(viewerId: string): string {
  return viewerId.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * Where one file goes: the uploader's folder, a part nobody can guess, and
 * the file's own name made safe. The unguessable part is what keeps two files
 * called screenshot.png apart, and what makes a path worth nothing to anybody
 * who was not handed it.
 */
export function newUploadPath(key: string, unique: string, name: string): string {
  const safe = cleanFileName(name).replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.{2,}/g, '_').slice(0, 120) || 'file';
  return `${key}/${unique}/${safe}`;
}

const UNIQUE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * Which uploaded files a message may carry.
 *
 * Only paths inside the sender's own folder, in exactly the shape
 * newUploadPath makes. A message cannot name a file somebody else uploaded,
 * or reach for anything else in the bucket by writing a path by hand.
 */
export function checkAttachmentRefs(input: unknown, key: string): { ok: true; refs: AttachmentRef[] } | Refused {
  if (input === undefined || input === null) return { ok: true, refs: [] };
  if (!Array.isArray(input)) return no(UNREADABLE, AGAIN);
  if (input.length > MAX_ATTACHMENTS) {
    return no(`Up to ${MAX_ATTACHMENTS} files can be attached to a message.`, 'Remove one and send it again.');
  }
  const shape = key ? new RegExp(`^${key}/${UNIQUE}/[A-Za-z0-9._-]{1,120}$`) : null;
  const refs: AttachmentRef[] = [];
  const seen = new Set<string>();
  for (const entry of input) {
    const item = entry !== null && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
    const path = typeof item.path === 'string' ? item.path : '';
    if (!shape || !shape.test(path) || path.includes('..') || seen.has(path)) return no(UNREADABLE, AGAIN);
    seen.add(path);
    const name = typeof item.name === 'string' && item.name.trim() !== '' ? cleanFileName(item.name) : 'file';
    refs.push({ path, name });
  }
  return { ok: true, refs };
}
