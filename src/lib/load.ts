import { affiliateRevenueOf, shareFor, type NoShare } from './analytics';
import { scopeData, seesEverything } from './scope';
import { defaultSettings, type Settings } from './settings';
import { getStore } from './store';
import type { AffiliateLink, Conversion, Submission, Visit } from './types';
import { listNoShareKeys } from './users';
import type { Viewer } from './viewer';

export type LoadResult = {
  links: AffiliateLink[];
  submissions: Submission[];
  visits: Visit[];
  conversions: Conversion[];
  /**
   * Whether the amounts on those conversions are the merchant's gross payouts.
   * False means they are already this viewer's half, which is what an affiliate
   * gets. Every figure downstream — the hero, the per-card totals, the
   * approvals list — is a sum of these, so this one flag is the difference
   * between a page of gross payouts and a page of somebody's own revenue.
   */
  gross: boolean;
  /**
   * The shared settings, chiefly the commission history.
   *
   * Handed back rather than read again by each page, so every figure on a
   * screen is priced off one read of one history. Two reads a few milliseconds
   * apart either side of somebody pressing Save would be two pages of numbers
   * that do not add up.
   */
  settings: Settings;
  /**
   * LGF employees' tracking keys. Their approvals pay no affiliate share: the
   * company keeps all of it. Pass it wherever `settings.shares` goes.
   */
  noShare: NoShare;
  error: string | null;
};

const EMPTY = { links: [], submissions: [], visits: [], conversions: [] };

/**
 * Every payout replaced by the affiliate's half of it.
 *
 * Done here rather than at each figure because there are a dozen figures and
 * one boundary. A page that forgets to halve a number shows an affiliate the
 * merchant's money as though it were theirs; a page that reads through this
 * cannot, and neither can the next page somebody writes.
 *
 * Halving row by row rather than the totals afterwards, because the rows are
 * what gets grouped, charted and listed — and because the sum of what they are
 * actually paid per approval is the figure they can check against a payment.
 */
export function asAffiliateShare(
  conversions: Conversion[],
  settings: Settings,
  noShare: NoShare = new Set(),
): Conversion[] {
  return conversions.map((row) => ({
    // At the rate in force on the day it was approved, not the rate in force
    // now. Raising the commission tomorrow must leave every figure an affiliate
    // has already been shown, and already been paid against, exactly where it
    // is.
    ...row,
    // Nothing at all on an LGF employee's key: see shareFor.
    amount: affiliateRevenueOf(row.amount, shareFor(row.usr, row.approvedOn, settings.shares, noShare)),
  }));
}

/**
 * Reads everything the admin pages need, cut down to what this viewer may see.
 *
 * The viewer is a required argument rather than something read from the request
 * inside here, and that is deliberate: a default would mean a page that forgot
 * to pass one still renders, showing every affiliate's data to whoever asked.
 * Making it explicit turns that mistake into a type error.
 *
 * A Sheets outage or a bad credential should degrade to an in-page message,
 * never a 500 — so failures are captured rather than thrown.
 *
 * Note on cost: every row is read and then filtered in memory. That matches how
 * the Sheets adapter already works (it can only fetch whole tabs) and is fine at
 * this size. If the tables ever outgrow it, the filter belongs in the query, and
 * scopeData stays as the thing that defines what the filter has to mean.
 */
export async function loadAll(viewer: Viewer | null): Promise<LoadResult> {
  const store = getStore();
  try {
    const [links, submissions, visits, conversions, settings, noShare] = await Promise.all([
      store.listLinks(),
      store.listSubmissions(),
      store.listVisits(),
      store.listConversions(),
      store.readSettings(),
      listNoShareKeys(),
    ]);

    const scoped = scopeData({ links, submissions, visits, conversions }, viewer);

    /*
     * The same predicate that decided which rows they see now decides which
     * number is on them. One gate, asked twice, rather than two gates that can
     * disagree about who is an admin.
     */
    const gross = seesEverything(viewer);
    const money = gross ? scoped.conversions : asAffiliateShare(scoped.conversions, settings, noShare);

    // Newest first for display. Sorted into new arrays: a store adapter may be
    // handing back rows it also caches, and sorting those in place would change
    // which link the public landing page resolves to.
    return {
      links: [...scoped.links].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      submissions: [...scoped.submissions].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      visits: scoped.visits,
      conversions: [...money].sort((a, b) => b.approvedOn.localeCompare(a.approvedOn)),
      gross,
      settings,
      noShare,
      error: null,
    };
  } catch (error) {
    return {
      ...EMPTY,
      gross: seesEverything(viewer),
      // The defaults rather than nothing: a page that could not reach the store
      // has no rows to price anyway, and a missing commission history would
      // turn a storage message into a crash.
      settings: defaultSettings(),
      noShare: new Set(),
      error: error instanceof Error ? error.message : 'Unknown storage error',
    };
  }
}
