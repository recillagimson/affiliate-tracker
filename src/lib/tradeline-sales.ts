/**
 * What an affiliate has made from tradelines.
 *
 * Worked out from their orders (lib/tradeline-order-store), never stored. An
 * order carries a commission on each of its lines, fixed when it was placed.
 * That commission is theirs once the order is paid, and only while it stays
 * paid: an order still awaiting payment has earned nothing yet, and one paid
 * and later cancelled no longer counts.
 *
 * Pending payout is what has been earned and not yet paid out to them.
 * Tradeline commissions are not paid out through the payout system yet, so
 * for now it is all of it. That is the one line to change when they are.
 *
 * What their page is handed about a customer is a name. affiliateRows builds
 * each row field by field so that an order's other columns cannot ride along.
 *
 * scripts/tradeline-sales-checks.ts pins it.
 */

import { StoreConfigError } from './store/errors';
import { listTradelineOrdersFor, type OrderStatus, type TradelineOrder } from './tradeline-order-store';

export type TradelineSummary = {
  /** What they have earned from tradelines sold, in dollars. */
  income: number;
  /** The part of that which has not been paid to them yet. */
  pendingPayout: number;
  /** How many orders were made with their reference number and not cancelled. */
  checkouts: number;
};

/** Nothing sold. */
export const NO_TRADELINE_SALES: Readonly<TradelineSummary> = { income: 0, pendingPayout: 0, checkouts: 0 };

/** One order as its affiliate sees it. */
export type AffiliateOrderRow = {
  orderNumber: string;
  placedAt: string;
  customerName: string;
  status: OrderStatus;
  total: number;
  /** What it earns them: on a paid order, earned; on one awaiting payment, to come; on a cancelled one, nought. */
  commission: number;
  items: { name: string; quantity: number }[];
};

function cents(amount: number): number {
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
}

/** The commission an order carries, across its lines. */
export function orderCommission(order: TradelineOrder): number {
  return order.items.reduce((sum, item) => sum + cents(item.commission), 0) / 100;
}

export function summarizeOrders(orders: readonly TradelineOrder[]): TradelineSummary {
  const income = orders.filter((order) => order.status === 'paid').reduce((sum, order) => sum + cents(orderCommission(order)), 0) / 100;
  return {
    income,
    pendingPayout: income,
    checkouts: orders.filter((order) => order.status !== 'cancelled').length,
  };
}

/** The orders as rows for their dashboard, in the order given. */
export function affiliateRows(orders: readonly TradelineOrder[]): AffiliateOrderRow[] {
  return orders.map((order) => ({
    orderNumber: order.orderNumber,
    placedAt: order.createdAt,
    customerName: order.customerName,
    status: order.status,
    total: order.total,
    commission: order.status === 'cancelled' ? 0 : orderCommission(order),
    items: order.items.map((item) => ({ name: item.name, quantity: item.quantity })),
  }));
}

/**
 * One affiliate's figures and rows.
 *
 * Noughts and no rows on a database that has not had the orders migration
 * yet, so their pages load the way they did before there were orders. Any
 * other failure is the caller's to show.
 */
export async function tradelineSalesFor(userId: string): Promise<{ summary: TradelineSummary; rows: AffiliateOrderRow[] }> {
  try {
    const orders = await listTradelineOrdersFor(userId);
    return { summary: summarizeOrders(orders), rows: affiliateRows(orders) };
  } catch (error) {
    if (error instanceof StoreConfigError) return { summary: { ...NO_TRADELINE_SALES }, rows: [] };
    throw error;
  }
}
