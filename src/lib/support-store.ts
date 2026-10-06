/**
 * Support tickets, in Supabase.
 *
 * public.support_tickets is the conversation's header, public.support_messages
 * the conversation, and public.support_attachments the screenshots. See the
 * migration, 20261006120000.
 *
 * Sits beside lib/payout-request-store.ts rather than inside the Store
 * interface, for the same reason that one does: this is a conversation with a
 * person, and a Google Sheet is the wrong place for it. Supabase or nothing.
 *
 * Four things about this file are deliberate, and they are the same four as
 * the payout store's:
 *
 *   - Opening a ticket and adding a message go through Postgres functions,
 *     called with .rpc(). "Write the message, then move the ticket's
 *     last-message fields" as two calls could leave a reply nobody is badged
 *     for. One RPC is one transaction.
 *   - Marking read is a function too, so the time is the database's own.
 *   - The image bytes are never selected by a list or a thread read.
 *     readSupportAttachmentFile is the one query that touches them, and a
 *     route calls it only after it knows the caller may see them.
 *   - A ticket id is a small sequential number anybody can guess. So a read
 *     on an affiliate's behalf puts their user id into the query itself, and
 *     a ticket that is not theirs is never fetched rather than fetched and
 *     then checked.
 */

import {
  StoreConfigError,
  StoreNotFoundError,
  StoreValidationError,
} from './store/errors';
import { getSupabaseClient, isSupabaseConfigured } from './store/supabase';
import {
  isSupportCategory,
  isSupportStatus,
  countsTowardBadge,
  type SupportAttachmentMeta,
  type SupportCategory,
  type SupportMessage,
  type SupportSide,
  type SupportStatus,
  type SupportTicket,
  type SupportUpload,
} from './support';

export function supportEnabled(): boolean {
  return isSupabaseConfigured();
}

function requireStore(): void {
  if (!supportEnabled()) {
    throw new StoreConfigError(
      'Support tickets need a database. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, then reload.',
    );
  }
}

/* ----------------------------------------------------------------- errors --- */

type PostgrestErrorish = { code?: string; message?: string; details?: string | null } | null;

const DASHES = /[\u2013\u2014]/;

/** The SQLSTATEs the migration's functions raise, and what each one is. */
const RAISED: Record<string, { as: 'invalid' | 'missing'; fallback: string }> = {
  LG001: { as: 'invalid', fallback: 'That could not be read. Reload the page and try again.' },
  LG003: { as: 'invalid', fallback: 'A ticket can only be opened for an affiliate account.' },
  LG005: { as: 'missing', fallback: 'That ticket no longer exists.' },
};

/** Exported for scripts/support-store-checks.ts; nothing else should call it. */
export function supportFailure(context: string, error: PostgrestErrorish): never {
  const code = error?.code ?? '';
  const message = error?.message ?? '';

  if (code === '42P01' || code === 'PGRST205') {
    throw new StoreConfigError(
      'The support ticket tables are missing from this Supabase project. Run the 20261006120000_support_tickets migration.',
    );
  }
  if (code === '42883' || code === 'PGRST202') {
    throw new StoreConfigError(
      'The support ticket functions are missing from this Supabase project. Run the 20261006120000_support_tickets migration.',
    );
  }
  if (code === '42703' || code === 'PGRST204') {
    throw new StoreConfigError(
      'The support ticket tables are missing columns this version needs. Run the 20261006120000_support_tickets migration.',
    );
  }
  if (code === '42501') {
    throw new StoreConfigError(
      'Supabase refused the request. SUPABASE_SERVICE_ROLE_KEY must be the service role key, not the publishable one.',
    );
  }

  const raised = RAISED[code];
  if (raised) {
    const sentence = message && !DASHES.test(message) ? message : raised.fallback;
    if (raised.as === 'invalid') throw new StoreValidationError(sentence);
    throw new StoreNotFoundError(sentence);
  }

  // The account a ticket was being opened for was deleted between the check
  // and the insert.
  if (code === '23503') throw new StoreNotFoundError('That account no longer exists.');

  throw new Error(`${context}: ${message || 'unknown error'}${code ? ` (${code})` : ''}`);
}

/** A bigint row id, as the app carries it: a string of digits. */
function isRowId(id: string): boolean {
  return /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id));
}

/* ------------------------------------------------------------------ shape --- */

const TICKET_COLUMNS =
  'id, user_id, subject, category, status, opened_by, opened_by_role, created_at, ' +
  'last_message_at, last_message_role, affiliate_read_at, admin_read_at, closed_at, closed_by';

/** Every message column, and each attachment without its bytes. */
const MESSAGE_COLUMNS =
  'id, author_role, author_id, author_name, body, created_at, support_attachments(id, name, type, size)';

function when(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function side(value: unknown): SupportSide {
  return value === 'admin' ? 'admin' : 'affiliate';
}

/** Exported for the checks. A row from support_tickets, as the pages read it. */
export function toTicket(row: Record<string, unknown>): SupportTicket {
  return {
    id: String(row.id ?? ''),
    userId: String(row.user_id ?? ''),
    subject: String(row.subject ?? ''),
    // A value this version does not know is a row written by a newer one.
    // The safest reading is the plainest: a question, still open.
    category: isSupportCategory(row.category) ? row.category : 'question',
    status: isSupportStatus(row.status) ? row.status : 'open',
    openedBy: String(row.opened_by ?? ''),
    openedByRole: side(row.opened_by_role),
    createdAt: String(row.created_at ?? ''),
    lastMessageAt: String(row.last_message_at ?? ''),
    lastMessageRole: side(row.last_message_role),
    affiliateReadAt: when(row.affiliate_read_at),
    adminReadAt: when(row.admin_read_at),
    closedAt: when(row.closed_at),
    closedBy: String(row.closed_by ?? ''),
  };
}

/** Exported for the checks. A row from support_messages with its attachments. */
export function toMessage(row: Record<string, unknown>): SupportMessage {
  const files = Array.isArray(row.support_attachments) ? row.support_attachments : [];
  const attachments: SupportAttachmentMeta[] = files
    .map((entry) => {
      const file = entry as Record<string, unknown>;
      return {
        id: String(file.id ?? ''),
        name: String(file.name ?? 'image'),
        type: String(file.type ?? ''),
        size: Number(file.size ?? 0),
      };
    })
    .sort((a, b) => Number(a.id) - Number(b.id));
  return {
    id: String(row.id ?? ''),
    authorRole: side(row.author_role),
    authorId: String(row.author_id ?? ''),
    authorName: String(row.author_name ?? ''),
    body: String(row.body ?? ''),
    createdAt: String(row.created_at ?? ''),
    attachments,
  };
}

/* ------------------------------------------------------------------ reads --- */

/** PostgREST answers with at most 1000 rows; a list that stopped there would quietly lose tickets. */
const PAGE_SIZE = 1000;
const MAX_ROWS = 200_000;

type Page = PromiseLike<{ data: unknown; error: PostgrestErrorish }>;

async function readPages(
  context: string,
  page: (from: number, to: number) => Page,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) supportFailure(context, error);
    const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
    for (const row of rows) out.push(row);
    if (rows.length < PAGE_SIZE) return out;
  }
  throw new Error(`${context}: more than ${MAX_ROWS} rows, which this page was never built to read`);
}

/** Every ticket that matches, newest activity first, for the admin list. */
export async function listSupportTickets(
  filter: { status?: SupportStatus; category?: SupportCategory } = {},
): Promise<SupportTicket[]> {
  requireStore();
  const rows = await readPages('reading support tickets', (from, to) => {
    let query = getSupabaseClient().from('support_tickets').select(TICKET_COLUMNS);
    if (filter.status) query = query.eq('status', filter.status);
    if (filter.category) query = query.eq('category', filter.category);
    return query
      .order('last_message_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to);
  });
  return rows.map(toTicket);
}

/** One person's tickets, newest activity first. */
export async function listSupportTicketsFor(userId: string): Promise<SupportTicket[]> {
  requireStore();
  const rows = await readPages('reading support tickets', (from, to) =>
    getSupabaseClient()
      .from('support_tickets')
      .select(TICKET_COLUMNS)
      .eq('user_id', userId)
      .order('last_message_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to),
  );
  return rows.map(toTicket);
}

/**
 * One ticket, without its messages.
 *
 * `forUserId`, when given, goes into the query itself, so a ticket that is not
 * this person's resolves to null. An admin caller omits it. An empty string is
 * still a filter, and matches nobody: a caller with a blank id must never read
 * as a caller with no restriction.
 */
export async function readSupportTicket(id: string, forUserId?: string): Promise<SupportTicket | null> {
  requireStore();
  if (!isRowId(id)) return null;
  let query = getSupabaseClient().from('support_tickets').select(TICKET_COLUMNS).eq('id', id);
  if (forUserId !== undefined) query = query.eq('user_id', forUserId);
  const { data, error } = await query.maybeSingle();
  if (error) supportFailure('reading a support ticket', error);
  return data ? toTicket(data as unknown as Record<string, unknown>) : null;
}

/** One ticket and its whole conversation, oldest message first. */
export async function readSupportThread(
  id: string,
  forUserId?: string,
): Promise<{ ticket: SupportTicket; messages: SupportMessage[] } | null> {
  const ticket = await readSupportTicket(id, forUserId);
  if (!ticket) return null;
  const rows = await readPages('reading a support conversation', (from, to) =>
    getSupabaseClient()
      .from('support_messages')
      .select(MESSAGE_COLUMNS)
      .eq('ticket_id', id)
      .order('id', { ascending: true })
      .range(from, to),
  );
  return { ticket, messages: rows.map(toMessage) };
}

/**
 * How many tickets this side has not read, for the tab's badge.
 *
 * Postgres cannot be asked "read_at < last_message_at" through PostgREST's
 * filters, so this narrows to the tickets where the other side spoke last,
 * reads five small columns of each, and counts with countsTowardBadge, which
 * is the list's own isUnreadFor plus the one rule about closed tickets.
 */
export async function countUnreadSupport(side: SupportSide, userId?: string): Promise<number> {
  requireStore();
  if (side === 'affiliate' && !userId) return 0;
  const other: SupportSide = side === 'affiliate' ? 'admin' : 'affiliate';
  const rows = await readPages('counting unread support tickets', (from, to) => {
    let query = getSupabaseClient()
      .from('support_tickets')
      .select('id, status, last_message_at, last_message_role, affiliate_read_at, admin_read_at')
      .eq('last_message_role', other);
    if (side === 'affiliate') query = query.eq('user_id', userId ?? '');
    return query.order('id', { ascending: true }).range(from, to);
  });
  return rows.map(toTicket).filter((ticket) => countsTowardBadge(ticket, side)).length;
}

/** Which ticket an attachment belongs to, and nothing else. */
export async function readSupportAttachmentTicket(attachmentId: string): Promise<string | null> {
  requireStore();
  if (!isRowId(attachmentId)) return null;
  const { data, error } = await getSupabaseClient()
    .from('support_attachments')
    .select('id, ticket_id')
    .eq('id', attachmentId)
    .maybeSingle();
  if (error) supportFailure('reading which ticket an image belongs to', error);
  const row = data as Record<string, unknown> | null;
  return row ? String(row.ticket_id ?? '') : null;
}

/**
 * The image itself.
 *
 * The only query in this file that touches the bytes. Call it only once the
 * caller is known to be allowed.
 */
export async function readSupportAttachmentFile(
  attachmentId: string,
): Promise<{ name: string; type: string; data: string } | null> {
  requireStore();
  if (!isRowId(attachmentId)) return null;
  const { data, error } = await getSupabaseClient()
    .from('support_attachments')
    .select('name, type, data')
    .eq('id', attachmentId)
    .maybeSingle();
  if (error) supportFailure('reading a support image', error);
  const row = data as Record<string, unknown> | null;
  const content = String(row?.data ?? '');
  if (!row || !content) return null;
  return {
    name: String(row.name ?? 'image'),
    type: String(row.type ?? 'application/octet-stream'),
    data: content,
  };
}

/* ----------------------------------------------------------------- writes --- */

function filesForRpc(files: SupportUpload[]): Record<string, unknown>[] {
  return files.map((file) => ({ name: file.name, type: file.type, size: file.size, data: file.data }));
}

function idFrom(context: string, data: unknown): string {
  if (data === null || data === undefined || data === '') {
    throw new Error(`${context}: the function returned no id`);
  }
  return String(data);
}

/** Open a ticket with its first message, and return the ticket's id. */
export async function openSupportTicket(input: {
  userId: string;
  subject: string;
  category: SupportCategory;
  openedBy: string;
  openedByRole: SupportSide;
  authorId: string;
  body: string;
  files: SupportUpload[];
}): Promise<string> {
  requireStore();
  const { data, error } = await getSupabaseClient().rpc('create_support_ticket', {
    p_user_id: input.userId,
    p_subject: input.subject,
    p_category: input.category,
    p_opened_by: input.openedBy,
    p_opened_by_role: input.openedByRole,
    p_author_id: input.authorId,
    p_body: input.body,
    p_attachments: filesForRpc(input.files),
  });
  if (error) supportFailure('opening a support ticket', error);
  return idFrom('opening a support ticket', data);
}

/** Add a message to a ticket, reopening it if it was closed. Returns the message's id. */
export async function addSupportMessage(input: {
  ticketId: string;
  authorRole: SupportSide;
  authorId: string;
  authorName: string;
  body: string;
  files: SupportUpload[];
}): Promise<string> {
  requireStore();
  if (!isRowId(input.ticketId)) throw new StoreNotFoundError('That ticket no longer exists.');
  const { data, error } = await getSupabaseClient().rpc('add_support_message', {
    p_ticket_id: Number(input.ticketId),
    p_author_role: input.authorRole,
    p_author_id: input.authorId,
    p_author_name: input.authorName,
    p_body: input.body,
    p_attachments: filesForRpc(input.files),
  });
  if (error) supportFailure('adding a support message', error);
  return idFrom('adding a support message', data);
}

/**
 * One UPDATE that moves a ticket from one status to the other. True when it
 * matched. The status it must currently have is in the WHERE clause, so two
 * people closing the same ticket cannot both be told they did.
 */
async function moveStatus(
  context: string,
  id: string,
  from: SupportStatus,
  patch: Record<string, unknown>,
  forUserId?: string,
): Promise<boolean> {
  requireStore();
  if (!isRowId(id)) return false;
  let query = getSupabaseClient().from('support_tickets').update(patch).eq('id', id).eq('status', from);
  if (forUserId !== undefined) query = query.eq('user_id', forUserId);
  const { data, error } = await query.select('id');
  if (error) supportFailure(context, error);
  return Array.isArray(data) && data.length > 0;
}

/** Close an open ticket. False when it was not open, or not this person's. */
export async function closeSupportTicket(id: string, closedBy: string, forUserId?: string): Promise<boolean> {
  return moveStatus(
    'closing a support ticket',
    id,
    'open',
    { status: 'closed', closed_at: new Date().toISOString(), closed_by: closedBy },
    forUserId,
  );
}

/** Reopen a closed ticket. False when it was not closed, or not this person's. */
export async function reopenSupportTicket(id: string, forUserId?: string): Promise<boolean> {
  return moveStatus(
    'reopening a support ticket',
    id,
    'closed',
    { status: 'open', closed_at: null, closed_by: '' },
    forUserId,
  );
}

/**
 * Record that one side has read a ticket. The time is the database's own:
 * see mark_support_read. `userId` is only used on the affiliate side, where it
 * is part of the WHERE clause.
 */
export async function markSupportRead(id: string, side: SupportSide, userId: string): Promise<void> {
  requireStore();
  if (!isRowId(id)) return;
  const { error } = await getSupabaseClient().rpc('mark_support_read', {
    p_ticket_id: Number(id),
    p_side: side,
    p_user_id: userId,
  });
  if (error) supportFailure('marking a support ticket read', error);
}
