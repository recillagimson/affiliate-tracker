/**
 * The tradelines table, in Supabase.
 *
 * public.tradelines holds one row per tradeline; see migrations
 * 20261010120000, 20261011120000 and 20261012120000. Sits beside the other feature stores rather than inside the
 * Store interface: this is reference data an admin maintains by hand, with no
 * Google Sheets or local-file equivalent. Supabase or nothing.
 *
 * Replacing an issuer's whole table goes through a Postgres function, so the
 * delete and the insert are one transaction. Everything else is a single
 * statement and needs no help.
 */

import { StoreConfigError, StoreNotFoundError, StoreValidationError } from './store/errors';
import { getSupabaseClient, isSupabaseConfigured } from './store/supabase';
import { isIssuerKey, type IssuerKey, type Tradeline, type TradelineInput } from './tradelines';

export function tradelinesEnabled(): boolean {
  return isSupabaseConfigured();
}

function requireStore(): void {
  if (!tradelinesEnabled()) {
    throw new StoreConfigError(
      'The tradelines table needs a database. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, then reload.',
    );
  }
}

type PostgrestErrorish = { code?: string; message?: string; details?: string | null } | null;

const MISSING =
  'The tradelines table is missing from this Supabase project. Run the 20261010120000_tradelines migration.';

function fail(context: string, error: PostgrestErrorish): never {
  const code = error?.code ?? '';
  const message = error?.message ?? '';
  if (['42P01', 'PGRST205', '42883', 'PGRST202'].includes(code)) throw new StoreConfigError(MISSING);
  // The table is there but a column is not: a later migration has not been
  // run. Postgres names the column it could not find, which says which one.
  if (code === '42703' || code === 'PGRST204') {
    throw new StoreConfigError(
      /user_price/.test(message)
        ? 'The tradelines table is missing its user price column. Run the 20261012120000_tradelines_user_price migration.'
        : 'The tradelines table is missing a column. Run the 20261011120000_tradelines_age and 20261012120000_tradelines_user_price migrations.',
    );
  }
  if (code === '42501') {
    throw new StoreConfigError(
      'Supabase refused the request. SUPABASE_SERVICE_ROLE_KEY must be the service role key, not the publishable one.',
    );
  }
  // A row the table's own constraints refused, or the function's LG001. The
  // app checks every row first, so this is a hand-made request.
  if (code === '23514' || code === '22007' || code === '22008' || code === '22P02' || code === 'LG001') {
    throw new StoreValidationError('One of those tradelines could not be saved. Check its limit and its date.');
  }
  throw new Error(`${context}: ${message || 'unknown error'}${code ? ` (${code})` : ''}`);
}

function isRowId(id: string): boolean {
  return /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id));
}

const COLUMNS = 'id, issuer, name, credit_limit, open_date, age_years, user_price';

function toTradeline(row: Record<string, unknown>): Tradeline | null {
  if (!isIssuerKey(row.issuer)) return null;
  return {
    id: String(row.id ?? ''),
    issuer: row.issuer,
    name: String(row.name ?? ''),
    creditLimit: Number(row.credit_limit ?? 0),
    openDate: String(row.open_date ?? '').slice(0, 10),
    // As stored, which is as given. Null stays null: no age is not zero.
    age: row.age_years === null || row.age_years === undefined ? null : Number(row.age_years),
    userPrice: row.user_price === null || row.user_price === undefined ? null : Number(row.user_price),
  };
}

/** PostgREST answers with at most 1000 rows; a list that stopped there would quietly lose tradelines. */
const PAGE_SIZE = 1000;

/**
 * Every tradeline, in the order entered, for the page to split by issuer.
 *
 * All of them rather than one issuer's, because the page shows a count beside
 * every issuer as well as the table for one, and six small lists are one
 * small read.
 */
export async function listTradelines(): Promise<Tradeline[]> {
  requireStore();
  const out: Tradeline[] = [];
  for (let from = 0; from < 100_000; from += PAGE_SIZE) {
    const { data, error } = await getSupabaseClient()
      .from('tradelines')
      .select(COLUMNS)
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) fail('reading the tradelines', error);
    const rows = (data ?? []) as unknown as Record<string, unknown>[];
    for (const row of rows) {
      const tradeline = toTradeline(row);
      if (tradeline) out.push(tradeline);
    }
    if (rows.length < PAGE_SIZE) break;
  }
  return out;
}

function forInsert(issuer: IssuerKey, row: TradelineInput, by: string) {
  return {
    issuer,
    name: row.name,
    credit_limit: row.creditLimit,
    open_date: row.openDate,
    age_years: row.age,
    user_price: row.userPrice,
    created_by: by,
    updated_by: by,
  };
}

/** Add tradelines to an issuer's table, after what is already there. Returns how many were added. */
export async function addTradelines(issuer: IssuerKey, rows: TradelineInput[], by: string): Promise<number> {
  requireStore();
  if (rows.length === 0) return 0;
  const { data, error } = await getSupabaseClient()
    .from('tradelines')
    .insert(rows.map((row) => forInsert(issuer, row, by)))
    .select('id');
  if (error) fail('adding tradelines', error);
  return Array.isArray(data) ? data.length : 0;
}

/** Replace an issuer's whole table with a new list, in one transaction. Returns how many it now has. */
export async function replaceTradelines(issuer: IssuerKey, rows: TradelineInput[], by: string): Promise<number> {
  requireStore();
  const { data, error } = await getSupabaseClient().rpc('replace_tradelines', {
    p_issuer: issuer,
    p_rows: rows.map((row) => ({
      name: row.name,
      credit_limit: row.creditLimit,
      open_date: row.openDate,
      age_years: row.age,
      user_price: row.userPrice,
    })),
    p_by: by,
  });
  if (error) fail('replacing the tradelines', error);
  return Number(data ?? 0);
}

/** Change one tradeline. Its issuer is not changed: a tradeline moved to another table is deleted and added. */
export async function updateTradeline(id: string, row: TradelineInput, by: string): Promise<void> {
  requireStore();
  if (!isRowId(id)) throw new StoreNotFoundError('That tradeline no longer exists.');
  const { data, error } = await getSupabaseClient()
    .from('tradelines')
    .update({
      name: row.name,
      credit_limit: row.creditLimit,
      open_date: row.openDate,
      age_years: row.age,
      user_price: row.userPrice,
      updated_at: new Date().toISOString(),
      updated_by: by,
    })
    .eq('id', id)
    .select('id');
  if (error) fail('saving a tradeline', error);
  if (!Array.isArray(data) || data.length === 0) throw new StoreNotFoundError('That tradeline no longer exists.');
}

/** Remove one tradeline. False when it was already gone, which the caller treats as done. */
export async function deleteTradeline(id: string): Promise<boolean> {
  requireStore();
  if (!isRowId(id)) return false;
  const { data, error } = await getSupabaseClient().from('tradelines').delete().eq('id', id).select('id');
  if (error) fail('deleting a tradeline', error);
  return Array.isArray(data) && data.length > 0;
}
