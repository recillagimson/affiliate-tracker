/**
 * Payout requests, in Supabase.
 *
 * An affiliate chooses which of their approved cards to be paid for, once each
 * one is 15 days old, and this is where that choice and what became of it
 * live: public.payout_requests is the payment record, and
 * public.payout_request_items says which approvals it covers and what each was
 * worth when it was asked for. See the migration, 20260914120000.
 *
 * Sits beside lib/onboarding-store.ts rather than inside the Store interface,
 * for the same reason the old payout store did: these rows say what each
 * person was paid, and a Google Sheet is the wrong place for that. Supabase or
 * nothing.
 *
 * Four things about this file are deliberate:
 *
 *   - Creating and cancelling go through Postgres functions, called with
 *     .rpc(). Every .insert() or .update() here is its own HTTP call and its
 *     own transaction, so "write the request, then write its cards" as two
 *     calls could leave a request with no cards, or a card locked to nothing.
 *     One RPC is one transaction.
 *   - The receipt bytes are never selected by a list or a document read. A
 *     scan of a bank transfer is a few hundred kilobytes of base64, and the
 *     admin page reads every request on every render. readPayoutRequestProof
 *     is the one query that touches them, and a route calls it only after
 *     readPayoutRequestOwner has told it the caller may see them.
 *   - A request id is a small sequential number anybody can guess. So a read
 *     on somebody's behalf puts their user id into the query itself, and a
 *     request that is not theirs is never fetched rather than fetched and then
 *     checked.
 *   - Every write that touches a payment or its receipt carries
 *     .neq('status', 'cancelled') and reports whether it matched. A cancel
 *     that lands a moment before a payment then comes back as "nothing
 *     matched", which the route turns into a 409, instead of a row the paid
 *     pair constraint would have to refuse.
 */

import { PAYOUT_DAYS } from './payout';
import {
  StoreConfigError,
  StoreConflictError,
  StoreNotFoundError,
  StoreValidationError,
} from './store/errors';
import { getSupabaseClient, isSupabaseConfigured } from './store/supabase';

export function payoutsEnabled(): boolean {
  return isSupabaseConfigured();
}

function requireStore(): void {
  if (!payoutsEnabled()) {
    throw new StoreConfigError(
      'Payout requests need a database. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, then reload.',
    );
  }
}

/* ----------------------------------------------------------------- errors --- */

type PostgrestErrorish = { code?: string; message?: string; details?: string | null } | null;

const CREATING = 'creating a payout request';
const CANCELLING = 'cancelling a payout request';

/** What a person sees when a request function fails for a reason this file does not know. */
const UNPROCESSED = 'That could not be processed.';

/** A card list that arrived malformed: an id that is not a row id, or an amount that is not money. */
const UNREADABLE = 'Those cards could not be read. Reload the page and choose them again.';

const DASHES = /[\u2013\u2014]/;

/**
 * The SQLSTATEs the migration's functions raise, and what each one is.
 *
 * The migration's own sentence is what normally reaches the page: it is this
 * app's copy, written for a person, and LG001 has two of them. The fallback is
 * for a database running an older or hand-edited copy of the function, and
 * for a message that has picked up a dash somewhere, which the pages never
 * show.
 */
const RAISED: Record<string, { as: 'invalid' | 'conflict' | 'missing'; fallback: string }> = {
  LG001: { as: 'invalid', fallback: 'Choose at least one approved card.' },
  LG002: { as: 'invalid', fallback: 'The same card was selected twice.' },
  LG003: {
    as: 'invalid',
    fallback: `One of those approvals is not yours, or is not ${PAYOUT_DAYS} days old yet.`,
  },
  LG004: { as: 'conflict', fallback: 'One of those approvals is already on a request.' },
  LG005: { as: 'missing', fallback: 'That request no longer exists.' },
  LG006: { as: 'conflict', fallback: 'Only an unpaid request can be cancelled.' },
};

function fail(context: string, error: PostgrestErrorish): never {
  const code = error?.code ?? '';
  const message = error?.message ?? '';

  // The migrations being behind the deploy, which has one fix whichever of
  // these PostgREST happens to say. PGRST202 is its word for a function it
  // cannot find, which is what calling create_payout_request on a project
  // that has not had 20260914120000 looks like.
  if (code === '42P01' || code === 'PGRST205') {
    throw new StoreConfigError(
      'The payout request tables are missing from this Supabase project. Run: npx supabase db push',
    );
  }
  if (code === '42883' || code === 'PGRST202') {
    throw new StoreConfigError(
      'The payout request functions are missing from this Supabase project. Run: npx supabase db push',
    );
  }
  if (code === '42703' || code === 'PGRST204') {
    throw new StoreConfigError(
      'The payout request tables are missing columns this version needs. Run: npx supabase db push',
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
    if (raised.as === 'conflict') throw new StoreConflictError(sentence);
    throw new StoreNotFoundError(sentence);
  }

  // The account a request was being filed under is gone. The function checks
  // for it before it inserts, so this is the narrow race with a delete.
  if (code === '23503') {
    throw new StoreNotFoundError('That account no longer exists.');
  }

  /*
   * Anything else the two request functions raise is a bug worth
   * investigating, not a sentence worth showing somebody mid-payment. The raw
   * text goes to the server log and stops there. Scoped to the functions on
   * purpose: the table reads and writes below keep the house pattern that
   * lib/store/supabase.ts uses, which names the context for whoever reads the
   * error.
   */
  if (context === CREATING || context === CANCELLING) {
    console.error(context, code, message, error?.details ?? '');
    throw new Error(UNPROCESSED);
  }
  throw new Error(`${context}: ${message || 'unknown error'}${code ? ` (${code})` : ''}`);
}

/**
 * A bigint row id, as the app carries it: a string of digits.
 *
 * Checked before any query, for two reasons. A URL like /payslips/abc would
 * otherwise reach Postgres and come back as an "invalid input syntax" error
 * rather than a plain not-found. And the functions take the id as a JSON
 * number, which is only exact up to Number.MAX_SAFE_INTEGER; an identity
 * column at this app's scale is nowhere near it, and anything past it is not
 * one of ours.
 */
function isRowId(id: string): boolean {
  return /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id));
}

/* ------------------------------------------------------------------ shape --- */

export type PayoutRequestStatus = 'requested' | 'paid' | 'cancelled';

/**
 * One card on a request. `conversionId` is null only on a released line whose
 * approval was deleted after its request was cancelled: the line and its
 * amount survive, the reference does not.
 */
export type PayoutRequestItem = { conversionId: string | null; amount: number };

/**
 * A request as the pages read it. No receipt bytes: whether one is attached is
 * `proof` being non-null, and the file itself is fetched one at a time by
 * readPayoutRequestProof.
 */
export type PayoutRequestRecord = {
  id: string;
  userId: string;
  status: PayoutRequestStatus;
  requestedAt: string;
  requestedBy: string;
  /** The sum of the items when it was requested. Fixed then, never recomputed. */
  totalAmount: number;
  /**
   * What was actually sent, or null until a payment is recorded. Nullable
   * rather than defaulted to zero, which would read as "we paid them nothing".
   */
  amount: number | null;
  paidAt: string | null;
  paidBy: string;
  reference: string;
  note: string;
  proof: { name: string; type: string; at: string | null; by: string } | null;
  confirmedAt: string | null;
  confirmedBy: string;
  cancelledAt: string | null;
  cancelledBy: string;
  updatedAt: string;
  items: PayoutRequestItem[];
};

/**
 * Every column except proof_data, plus each request's items.
 *
 * Built with + rather than written as one literal so the Supabase client
 * treats it as a plain string instead of trying to type-parse the select.
 */
const COLUMNS =
  'id, user_id, status, requested_at, requested_by, total_amount, amount, paid_at, paid_by, ' +
  'reference, note, proof_name, proof_type, proof_at, proof_by, confirmed_at, confirmed_by, ' +
  'cancelled_at, cancelled_by, updated_at, payout_request_items(conversion_id, amount)';

/** numeric can arrive as a string. Read straight through, money would concatenate. */
function money(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function when(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : String(value);
}

function toRecord(raw: unknown): PayoutRequestRecord {
  const row = raw as Record<string, unknown>;
  const name = String(row.proof_name ?? '');
  const items = Array.isArray(row.payout_request_items) ? row.payout_request_items : [];
  return {
    id: String(row.id ?? ''),
    userId: String(row.user_id ?? ''),
    // The check constraint allows only these three. Anything else is a row
    // somebody edited by hand, and it is read as the state that pays nothing
    // out by itself.
    status: row.status === 'paid' || row.status === 'cancelled' ? row.status : 'requested',
    requestedAt: String(row.requested_at ?? ''),
    requestedBy: String(row.requested_by ?? ''),
    totalAmount: money(row.total_amount) ?? 0,
    amount: money(row.amount),
    paidAt: when(row.paid_at),
    paidBy: String(row.paid_by ?? ''),
    reference: String(row.reference ?? ''),
    note: String(row.note ?? ''),
    /*
     * A name is what makes a receipt a receipt here. The bytes live in a column
     * this query does not ask for, so "is there one" is the only question a
     * listing can answer, and the only one it asks.
     */
    proof: name
      ? {
          name,
          type: String(row.proof_type ?? ''),
          at: when(row.proof_at),
          by: String(row.proof_by ?? ''),
        }
      : null,
    confirmedAt: when(row.confirmed_at),
    confirmedBy: String(row.confirmed_by ?? ''),
    cancelledAt: when(row.cancelled_at),
    cancelledBy: String(row.cancelled_by ?? ''),
    updatedAt: String(row.updated_at ?? ''),
    items: items.map((entry) => {
      const item = entry as Record<string, unknown>;
      return {
        conversionId:
          item.conversion_id === null || item.conversion_id === undefined ? null : String(item.conversion_id),
        amount: money(item.amount) ?? 0,
      };
    }),
  };
}

/* ------------------------------------------------------------------ reads --- */

/**
 * PostgREST answers with at most 1000 rows. A request list that stopped there
 * would quietly lose the oldest requests, and a committed-card set that
 * stopped there would show cards already paid for as ready to request again.
 */
const PAGE_SIZE = 1000;
const MAX_ROWS = 500_000;

type Page = PromiseLike<{ data: unknown; error: PostgrestErrorish }>;

/**
 * Read every page of a query. `range` is inclusive at both ends, and a short
 * page is the only reliable signal that nothing comes after it. The query has
 * to carry an order that ends on a unique column, or rows can shift between
 * pages while it reads.
 */
async function readPages(
  context: string,
  page: (from: number, to: number) => Page,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) fail(context, error);
    const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
    for (const row of rows) out.push(row);
    if (rows.length < PAGE_SIZE) return out;
  }
  throw new Error(`${context}: more than ${MAX_ROWS} rows, which this page was never built to read`);
}

/** Every request on record, newest first, for the admin Requests tab. Without the receipts. */
export async function listPayoutRequests(): Promise<PayoutRequestRecord[]> {
  requireStore();
  const rows = await readPages('reading payout requests', (from, to) =>
    getSupabaseClient()
      .from('payout_requests')
      .select(COLUMNS)
      .order('requested_at', { ascending: false })
      .order('id', { ascending: false })
      .order('id', { referencedTable: 'payout_request_items', ascending: true })
      .range(from, to),
  );
  return rows.map(toRecord);
}

/** One person's requests, newest first, for their own payslips page. */
export async function listPayoutRequestsFor(userId: string): Promise<PayoutRequestRecord[]> {
  requireStore();
  const rows = await readPages('reading payout requests', (from, to) =>
    getSupabaseClient()
      .from('payout_requests')
      .select(COLUMNS)
      .eq('user_id', userId)
      .order('requested_at', { ascending: false })
      .order('id', { ascending: false })
      .order('id', { referencedTable: 'payout_request_items', ascending: true })
      .range(from, to),
  );
  return rows.map(toRecord);
}

/**
 * One request, as a document.
 *
 * `forUserId`, when given, goes into the query itself, so a request that is
 * not this person's resolves to null (and the page calls notFound()) rather
 * than a hydrated record being handed back and only then checked. An admin
 * caller omits it. An empty string is still a filter, and matches nobody:
 * a caller with a blank id must never read as a caller with no restriction.
 */
export async function readPayoutRequest(
  id: string,
  forUserId?: string,
): Promise<PayoutRequestRecord | null> {
  requireStore();
  if (!isRowId(id)) return null;
  let query = getSupabaseClient().from('payout_requests').select(COLUMNS).eq('id', id);
  if (forUserId !== undefined) query = query.eq('user_id', forUserId);
  const { data, error } = await query
    .order('id', { referencedTable: 'payout_request_items', ascending: true })
    .maybeSingle();
  if (error) fail('reading a payout request', error);
  return data ? toRecord(data) : null;
}

/**
 * Every conversion id currently locked to a live request: requested or paid,
 * not cancelled. Reads only the small join table, never the receipts. As
 * strings, because that is how Conversion.id is carried everywhere else.
 */
export async function listCommittedConversionIds(): Promise<Set<string>> {
  requireStore();
  const rows = await readPages('reading committed cards', (from, to) =>
    getSupabaseClient()
      .from('payout_request_items')
      .select('conversion_id')
      .is('released_at', null)
      .order('id', { ascending: true })
      .range(from, to),
  );
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.conversion_id !== null && row.conversion_id !== undefined) ids.add(String(row.conversion_id));
  }
  return ids;
}

/**
 * Just enough to authorize a receipt read: who the request belongs to, and
 * nothing else. Its own tiny query, so the receipt route can decide 403 or
 * 404 before it ever asks for the bytes.
 */
export async function readPayoutRequestOwner(id: string): Promise<{ userId: string } | null> {
  requireStore();
  if (!isRowId(id)) return null;
  const { data, error } = await getSupabaseClient()
    .from('payout_requests')
    .select('id, user_id')
    .eq('id', id)
    .maybeSingle();
  if (error) fail('reading who a payout request belongs to', error);
  const row = data as Record<string, unknown> | null;
  return row ? { userId: String(row.user_id ?? '') } : null;
}

/**
 * The receipt itself.
 *
 * The only query in this file that touches the bytes, so that handing
 * somebody a receipt is a deliberate, greppable act rather than a side effect
 * of drawing a table. Call it only once the caller is known to be allowed.
 */
export async function readPayoutRequestProof(
  id: string,
): Promise<{ name: string; type: string; data: string } | null> {
  requireStore();
  if (!isRowId(id)) return null;
  const { data, error } = await getSupabaseClient()
    .from('payout_requests')
    .select('proof_name, proof_type, proof_data')
    .eq('id', id)
    .maybeSingle();
  if (error) fail('reading a receipt', error);
  const row = data as Record<string, unknown> | null;
  const content = String(row?.proof_data ?? '');
  if (!row || !content) return null;
  return {
    name: String(row.proof_name ?? 'receipt'),
    type: String(row.proof_type ?? 'application/octet-stream'),
    data: content,
  };
}

/* ----------------------------------------------------------------- writes --- */

/**
 * File a request for a set of cards, and return its id.
 *
 * Every rule that matters is enforced by create_payout_request, in one
 * transaction: the cards belong to this account, are old enough, are not
 * already on a live request, and the request and its items land together or
 * not at all. The amounts are this person's own share, computed by the caller
 * from the commission history, and recorded as given.
 *
 * `conversion_id` goes over as a JSON number because the function reads it as
 * bigint. The shape is checked here first, so a malformed list is a plain
 * validation error rather than a Postgres cast failure.
 */
export async function createPayoutRequest(input: {
  userId: string;
  usr: string;
  requestedBy: string;
  items: { conversionId: string; amount: number }[];
}): Promise<string> {
  requireStore();
  for (const item of input.items) {
    if (!isRowId(item.conversionId) || !Number.isFinite(item.amount) || item.amount < 0) {
      throw new StoreValidationError(UNREADABLE);
    }
  }
  const { data, error } = await getSupabaseClient().rpc('create_payout_request', {
    p_user_id: input.userId,
    p_usr: input.usr,
    p_requested_by: input.requestedBy,
    p_items: input.items.map((item) => ({
      conversion_id: Number(item.conversionId),
      amount: item.amount,
    })),
  });
  if (error) fail(CREATING, error);
  if (data === null || data === undefined || data === '') {
    console.error(CREATING, 'the function returned no id');
    throw new Error(UNPROCESSED);
  }
  return String(data);
}

/**
 * Cancel an unpaid request and free its cards to be requested again.
 *
 * A paid request is refused (LG006): clear the payment first. Both halves,
 * the status and the release of every card, happen inside
 * cancel_payout_request.
 */
export async function cancelPayoutRequest(id: string, cancelledBy: string): Promise<void> {
  requireStore();
  if (!isRowId(id)) throw new StoreNotFoundError('That request no longer exists.');
  const { error } = await getSupabaseClient().rpc('cancel_payout_request', {
    p_request_id: Number(id),
    p_cancelled_by: cancelledBy,
  });
  if (error) fail(CANCELLING, error);
}

/**
 * One UPDATE on one request that is not cancelled. True when it matched.
 *
 * The status guard lives in the WHERE clause rather than in a read beforehand,
 * because a read-then-write leaves a gap a cancel can land in. Postgres
 * re-checks the WHERE against the row as it stands once any cancel holding it
 * has committed, so the write either happens to a live request or to nothing.
 */
async function updateLive(context: string, id: string, patch: Record<string, unknown>): Promise<boolean> {
  requireStore();
  if (!isRowId(id)) return false;
  const { data, error } = await getSupabaseClient()
    .from('payout_requests')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .neq('status', 'cancelled')
    .select('id');
  if (error) fail(context, error);
  return Array.isArray(data) && data.length > 0;
}

/**
 * Record a payment against a request, or correct one already recorded.
 *
 * Status and paid_at move together in the one UPDATE, which is what keeps
 * payout_requests_paid_pair_check true. Returns false when the request was
 * cancelled (or is gone), which the route answers with a 409.
 */
export async function recordPayment(
  id: string,
  input: { amount: number; paidOn: string; reference: string; note: string; by: string },
): Promise<boolean> {
  return updateLive('recording a payment', id, {
    status: 'paid',
    amount: input.amount,
    /*
     * Midday on the day the money actually left, which is not always today:
     * a transfer sent on Friday gets recorded on Monday. Midday rather than
     * midnight so that reading it back in any timezone lands on the day that
     * was typed.
     */
    paid_at: `${input.paidOn}T12:00:00.000Z`,
    paid_by: input.by,
    reference: input.reference.trim().slice(0, 120),
    note: input.note.trim().slice(0, 500),
  });
}

/**
 * Take a payment back off a request, returning it to requested.
 *
 * The receipt and the note stay. Somebody undoing a payment recorded against
 * the wrong request has not un-uploaded the file, and deleting it here would
 * mean finding it again to attach it to the right one. The affiliate's
 * confirmation goes, because it confirmed the payment being undone.
 */
export async function clearPayment(id: string): Promise<boolean> {
  return updateLive('clearing a payment', id, {
    status: 'requested',
    amount: null,
    paid_at: null,
    paid_by: '',
    reference: '',
    confirmed_at: null,
    confirmed_by: '',
  });
}

/** Attach the receipt, before or after the payment is recorded. Replacing a bad scan is the same call. */
export async function saveProof(
  id: string,
  input: { name: string; type: string; data: string; by: string },
): Promise<boolean> {
  return updateLive('saving a receipt', id, {
    proof_name: input.name.slice(0, 200),
    proof_type: input.type.slice(0, 100),
    proof_data: input.data,
    proof_at: new Date().toISOString(),
    proof_by: input.by,
  });
}

export async function removeProof(id: string): Promise<boolean> {
  return updateLive('removing a receipt', id, {
    proof_name: '',
    proof_type: '',
    proof_data: '',
    proof_at: null,
    proof_by: '',
  });
}

/**
 * The affiliate says the money arrived.
 *
 * Filtered on the user as well as the id, so nobody can confirm a payment
 * that is not theirs by changing a number, and on paid_at, so there is nothing
 * to confirm until an admin has recorded a payment. paid_at being set already
 * means the request is paid (the pair constraint), so no status guard is
 * needed. Returns false when it matched nothing, which the route turns into a
 * plain sentence rather than a silent success.
 */
export async function confirmReceipt(userId: string, id: string, by: string): Promise<boolean> {
  requireStore();
  if (!isRowId(id)) return false;
  const now = new Date().toISOString();
  const { data, error } = await getSupabaseClient()
    .from('payout_requests')
    .update({ confirmed_at: now, confirmed_by: by, updated_at: now })
    .eq('user_id', userId)
    .eq('id', id)
    .not('paid_at', 'is', null)
    .select('id');
  if (error) fail('confirming a payment', error);
  return Array.isArray(data) && data.length > 0;
}
