/**
 * What an affiliate has made from tradelines.
 *
 * Two figures and a count: what they have earned from the tradelines sold
 * with their reference number (lib/tradeline-ref), how much of that has not
 * been paid to them yet, and how many checkouts that is.
 *
 * There is no tradelines checkout yet, so nothing has been sold and nothing is
 * recorded anywhere. Until there is, everybody's summary is nought. The
 * dashboard is built against this now so that when the checkout exists this
 * is the one place to change, and the pages that show it do not.
 *
 * scripts/tradeline-sales-checks.ts pins it.
 */

export type TradelineSummary = {
  /** What they have earned from tradelines sold, in dollars. */
  income: number;
  /** The part of that which has not been paid to them yet. */
  pendingPayout: number;
  /** How many checkouts were made with their reference number. */
  checkouts: number;
};

/** Nothing sold. */
export const NO_TRADELINE_SALES: Readonly<TradelineSummary> = { income: 0, pendingPayout: 0, checkouts: 0 };

/**
 * The summary for one reference number.
 *
 * Nought for everybody until the checkout records sales. Asynchronous already,
 * because it will be a read, so that nothing that calls it has to change.
 */
export async function tradelineSummaryFor(tradelineRef: string): Promise<TradelineSummary> {
  void tradelineRef;
  return { ...NO_TRADELINE_SALES };
}
