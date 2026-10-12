/**
 * Tradeline orders, in Supabase.
 *
 * public.tradeline_orders, its lines and the record of SSN reveals; see
 * migration 20261014120000. Supabase or nothing, like the tradelines table.
 *
 * Two things here are deliberate.
 *
 * The sealed columns are named in exactly one query, the one that reveals
 * them. Every list and every read leaves them out, so there is no page that
 * could show an SSN by mistake, because no page was handed one.
 *
 * Paying and cancelling are single updates that name the status they expect
 * to find. Two admins pressing at once cannot both succeed, and a cancelled
 * order cannot be paid, without a transaction having to be held open.
 */

import { open, seal } from './secret-box';
import { normalizeServices } from './services';
import { StoreConfigError, StoreConflictError, StoreNotFoundError, StoreValidationError } from './store/errors';
import { getSupabaseClient, isSupabaseConfigured } from './store/supabase';
import { isTradelineRef } from './tradeline-ref';
import type { OrderCustomer, PricedItem } from './tradeline-order';

export type OrderStatus = 'awaiting_payment' | 'paid' | 'cancelled';

export type TradelineOrderItem = {
  id: string;
  issuer: string;
  name: string;
  creditLimit: number;
  openDate: string;
  age: string | null;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
  commission: number;
};

export type TradelineOrder = {
  orderNumber: string;
  createdAt: string;
  status: OrderStatus;
  paidAt: string | null;
  paidBy: string;
  cancelledAt: string | null;
  cancelledBy: string;
  customerName: string;
  customerEmail: string;
  customerMobile: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  zip: string;
  ssnLast4: string;
  tradelineRef: string;
  affiliateUserId: string | null;
  total: number;
  items: TradelineOrderItem[];
};

export const ORDERS_MISSING =
  'Tradeline orders are not set up in this database yet. Run the 20261014120000_tradeline_orders migration.';

export function tradelineOrdersEnabled(): boolean {
  return isSupabaseConfigured();
}

function requireStore(): void {
  if (!tradelineOrdersEnabled()) {
    throw new StoreConfigError('Tradeline orders need a database. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  }
}

type PostgrestErrorish = { code?: string; message?: string } | null;

function fail(context: string, error: PostgrestErrorish): never {
  const code = error?.code ?? '';
  // The table, a column, or the function is not there: the migration is behind the code.
  if (['42P01', 'PGRST205', '42883', 'PGRST202', '42703', 'PGRST204', 'PGRST200'].includes(code)) {
    throw new StoreConfigError(ORDERS_MISSING);
  }
  if (code === '42501') {
    throw new StoreConfigError(
      'Supabase refused the request. SUPABASE_SERVICE_ROLE_KEY must be the service role key, not the publishable one.',
    );
  }
  // A row the constraints refused. The app checks first, so this is a hand-made request.
  if (['23514', '23502', '22007', '22008', '22P02', 'LG001'].includes(code)) {
    throw new StoreValidationError('That order could not be saved. Check the details and try again.');
  }
  // Deliberately without the database's message: it can quote the row, and the row has a customer in it.
  throw new Error(`${context} failed${code ? ` (${code})` : ''}`);
}

/* Never the sealed columns. See the note at the top. */
const COLUMNS =
  'order_number, created_at, status, paid_at, paid_by, cancelled_at, cancelled_by, ' +
  'customer_name, customer_email, customer_mobile, address_line1, address_line2, city, state, zip, ' +
  'ssn_last4, tradeline_ref, affiliate_user_id, total, ' +
  'tradeline_order_items (id, issuer, name, credit_limit, open_date, age_years::text, unit_price, quantity, line_total, commission)';

function text(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function amount(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

function toStatus(value: unknown): OrderStatus {
  return value === 'paid' || value === 'cancelled' ? value : 'awaiting_payment';
}

function toItem(row: Record<string, unknown>): TradelineOrderItem {
  return {
    id: text(row.id),
    issuer: text(row.issuer),
    name: text(row.name),
    creditLimit: amount(row.credit_limit),
    openDate: text(row.open_date),
    age: row.age_years === null || row.age_years === undefined ? null : text(row.age_years),
    unitPrice: amount(row.unit_price),
    quantity: amount(row.quantity),
    lineTotal: amount(row.line_total),
    commission: amount(row.commission),
  };
}

function toOrder(row: Record<string, unknown>): TradelineOrder {
  const items = Array.isArray(row.tradeline_order_items) ? (row.tradeline_order_items as Record<string, unknown>[]) : [];
  return {
    orderNumber: text(row.order_number),
    createdAt: text(row.created_at),
    status: toStatus(row.status),
    paidAt: row.paid_at ? text(row.paid_at) : null,
    paidBy: text(row.paid_by),
    cancelledAt: row.cancelled_at ? text(row.cancelled_at) : null,
    cancelledBy: text(row.cancelled_by),
    customerName: text(row.customer_name),
    customerEmail: text(row.customer_email),
    customerMobile: text(row.customer_mobile),
    line1: text(row.address_line1),
    line2: text(row.address_line2),
    city: text(row.city),
    state: text(row.state),
    zip: text(row.zip),
    ssnLast4: text(row.ssn_last4),
    tradelineRef: text(row.tradeline_ref),
    affiliateUserId: row.affiliate_user_id ? text(row.affiliate_user_id) : null,
    total: amount(row.total),
    items: items.map(toItem).sort((a, b) => Number(a.id) - Number(b.id)),
  };
}

function isOrderNumber(value: string): boolean {
  return /^LGF-[0-9]{6}$/.test(value);
}

/**
 * The affiliate a reference number belongs to, if a sale can be credited to
 * them: an active affiliate onboarded for tradelines. Null for anybody else,
 * and the sale is the house's.
 *
 * `earns` is whether they are paid commission. An LGF employee is credited
 * with the sale and earns nothing on it, as with cards.
 */
export async function findEarningAffiliate(ref: string): Promise<{ userId: string; earns: boolean } | null> {
  requireStore();
  if (!isTradelineRef(ref)) return null;
  const { data, error } = await getSupabaseClient()
    .from('users')
    .select('id, role, active, services')
    .eq('tradeline_ref', ref)
    .maybeSingle();
  if (error) fail('Looking up the reference number', error);
  const row = data as { id?: unknown; role?: unknown; active?: unknown; services?: unknown } | null;
  if (!row || row.role !== 'affiliate' || row.active !== true) return null;
  if (!normalizeServices(row.services).includes('tradelines')) return null;
  const userId = text(row.id);
  /*
   * Whether they are an LGF employee, who is credited and earns nothing. Asked
   * here rather than through users.isLgfEmployee, which answers "no" when it
   * cannot read: fine for a label, wrong for money, since the commission is
   * fixed on the order for good. A database with no such column has no
   * employees. Any other failure stops the order, and the customer tries
   * again, rather than guessing either way.
   */
  const employee = await getSupabaseClient().from('users').select('lgf_employee').eq('id', userId).maybeSingle();
  if (employee.error && !['42703', 'PGRST204'].includes(employee.error.code ?? '')) {
    fail('Looking up the reference number', employee.error);
  }
  const isEmployee = Boolean((employee.data as { lgf_employee?: unknown } | null)?.lgf_employee);
  return { userId, earns: !isEmployee };
}

/** Save an order and its lines, sealing the SSN and date of birth on the way. Returns the order number. */
export async function placeTradelineOrder(input: {
  customer: OrderCustomer;
  items: PricedItem[];
  ref: string;
  affiliateUserId: string | null;
}): Promise<string> {
  requireStore();
  const { customer } = input;
  const { data, error } = await getSupabaseClient().rpc('place_tradeline_order', {
    p_order: {
      customer_name: customer.name,
      customer_email: customer.email,
      customer_mobile: customer.mobile,
      address_line1: customer.line1,
      address_line2: customer.line2,
      city: customer.city,
      state: customer.state,
      zip: customer.zip,
      ssn_encrypted: seal(customer.ssn),
      ssn_last4: customer.ssn.slice(-4),
      dob_encrypted: seal(customer.dob),
      tradeline_ref: input.ref,
      affiliate_user_id: input.affiliateUserId ?? '',
    },
    p_items: input.items.map((item) => ({
      issuer: item.issuer,
      name: item.name,
      credit_limit: item.creditLimit,
      open_date: item.openDate,
      age_years: item.age,
      unit_price: item.unitPrice,
      quantity: item.quantity,
      line_total: item.lineTotal,
      commission: item.commission,
    })),
  });
  if (error) fail('Placing the order', error);
  const orderNumber = text(data);
  if (!isOrderNumber(orderNumber)) throw new Error('Placing the order failed (no order number came back)');
  return orderNumber;
}

/** Every order, newest first. */
export async function listTradelineOrders(): Promise<TradelineOrder[]> {
  requireStore();
  const { data, error } = await getSupabaseClient()
    .from('tradeline_orders')
    .select(COLUMNS)
    .order('created_at', { ascending: false })
    .limit(2000);
  if (error) fail('Reading the orders', error);
  return ((data ?? []) as unknown as Record<string, unknown>[]).map(toOrder);
}

/** One affiliate's orders, newest first. */
export async function listTradelineOrdersFor(userId: string): Promise<TradelineOrder[]> {
  requireStore();
  if (!userId) return [];
  const { data, error } = await getSupabaseClient()
    .from('tradeline_orders')
    .select(COLUMNS)
    .eq('affiliate_user_id', userId)
    .order('created_at', { ascending: false })
    .limit(2000);
  if (error) fail('Reading the orders', error);
  return ((data ?? []) as unknown as Record<string, unknown>[]).map(toOrder);
}

export async function readTradelineOrder(orderNumber: string): Promise<TradelineOrder | null> {
  requireStore();
  if (!isOrderNumber(orderNumber)) return null;
  const { data, error } = await getSupabaseClient()
    .from('tradeline_orders')
    .select(COLUMNS)
    .eq('order_number', orderNumber)
    .maybeSingle();
  if (error) fail('Reading the order', error);
  return data ? toOrder(data as unknown as Record<string, unknown>) : null;
}

/** Why a change that found no row to change did not happen. */
async function refuseChange(orderNumber: string, wanted: string): Promise<never> {
  const order = await readTradelineOrder(orderNumber);
  if (!order) throw new StoreNotFoundError('That order no longer exists.');
  throw new StoreConflictError(
    order.status === 'cancelled'
      ? 'That order has been cancelled, and a cancelled order is not reopened.'
      : order.status === 'paid'
        ? 'That order is already marked paid.'
        : `That order could not be ${wanted}. Reload and try again.`,
  );
}

/** Mark an order paid. Only one awaiting payment can be. */
export async function markTradelineOrderPaid(orderNumber: string, by: string): Promise<void> {
  requireStore();
  const { data, error } = await getSupabaseClient()
    .from('tradeline_orders')
    .update({ status: 'paid', paid_at: new Date().toISOString(), paid_by: by })
    .eq('order_number', orderNumber)
    .eq('status', 'awaiting_payment')
    .select('id');
  if (error) fail('Marking the order paid', error);
  if (!data || data.length === 0) await refuseChange(orderNumber, 'marked paid');
}

/** Cancel an order, paid or not. A paid one keeps its paid date as history. */
export async function cancelTradelineOrder(orderNumber: string, by: string): Promise<void> {
  requireStore();
  const { data, error } = await getSupabaseClient()
    .from('tradeline_orders')
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_by: by })
    .eq('order_number', orderNumber)
    .in('status', ['awaiting_payment', 'paid'])
    .select('id');
  if (error) fail('Cancelling the order', error);
  if (!data || data.length === 0) await refuseChange(orderNumber, 'cancelled');
}

/**
 * An order's SSN and date of birth, read back.
 *
 * The reveal is written down before anything is opened, so there is no way to
 * read one without leaving the record of having done so.
 */
export async function revealTradelineOrderSecrets(orderNumber: string, by: string): Promise<{ ssn: string; dob: string }> {
  requireStore();
  if (!isOrderNumber(orderNumber)) throw new StoreNotFoundError('That order no longer exists.');
  const client = getSupabaseClient();
  const { data, error } = await client
    .from('tradeline_orders')
    .select('id, ssn_encrypted, dob_encrypted')
    .eq('order_number', orderNumber)
    .maybeSingle();
  if (error) fail('Reading the order', error);
  const row = data as { id?: unknown; ssn_encrypted?: unknown; dob_encrypted?: unknown } | null;
  if (!row) throw new StoreNotFoundError('That order no longer exists.');

  const logged = await client.from('tradeline_ssn_reveals').insert({ order_id: row.id, revealed_by: by });
  if (logged.error) fail('Recording the reveal', logged.error);

  return { ssn: open(text(row.ssn_encrypted)), dob: open(text(row.dob_encrypted)) };
}

/** Each time an order's SSN was read back, newest first. */
export async function listSsnReveals(orderNumber: string): Promise<{ at: string; by: string }[]> {
  requireStore();
  if (!isOrderNumber(orderNumber)) return [];
  const { data, error } = await getSupabaseClient()
    .from('tradeline_ssn_reveals')
    .select('revealed_at, revealed_by, tradeline_orders!inner (order_number)')
    .eq('tradeline_orders.order_number', orderNumber)
    .order('revealed_at', { ascending: false });
  if (error) fail('Reading the reveals', error);
  return ((data ?? []) as unknown as Record<string, unknown>[]).map((row) => ({ at: text(row.revealed_at), by: text(row.revealed_by) }));
}
