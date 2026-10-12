/**
 * The owner's side of tradeline orders: finding one, and what can be done to
 * it. The parts that need no database, so they can be checked.
 *
 * Pure. scripts/tradeline-order-admin-checks.tsx pins it.
 */

import type { OrderStatus, TradelineOrder } from './tradeline-order-store';

export type OrderAction = 'pay' | 'cancel' | 'reveal';

export function readOrderAction(value: unknown): OrderAction | null {
  return value === 'pay' || value === 'cancel' || value === 'reveal' ? value : null;
}

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  awaiting_payment: 'Awaiting payment',
  paid: 'Paid',
  cancelled: 'Cancelled',
};

/**
 * The orders somebody is looking for: by order number, customer name or
 * email, and by status. Deliberately not by SSN digits, which would make the
 * search box a way of testing guesses at one.
 */
export function matchOrders(orders: readonly TradelineOrder[], query: string, status: OrderStatus | 'all'): TradelineOrder[] {
  const wanted = query.trim().toLowerCase();
  return orders.filter((order) => {
    if (status !== 'all' && order.status !== status) return false;
    if (!wanted) return true;
    return [order.orderNumber, order.customerName, order.customerEmail].some((value) => value.toLowerCase().includes(wanted));
  });
}

/** "(518) 555-0142". Anything that is not ten digits is handed back as it is. */
export function formatMobile(digits: string): string {
  return /^[0-9]{10}$/.test(digits) ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : digits;
}

/** "123-45-6789". Anything that is not nine digits is handed back as it is. */
export function formatSsn(digits: string): string {
  return /^[0-9]{9}$/.test(digits) ? `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}` : digits;
}
