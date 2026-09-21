import type { ApproveContext } from '@/components/ApproveLead';
import { rateChoices } from './manual-approval';
import type { ShareRate } from './settings';
import { getStore } from './store';

/**
 * What Approve on the leads list needs, read on the server for an admin.
 *
 * A rate card that cannot be read is no rate card rather than a broken page:
 * the leads are still worth reading, and the form falls back to a typed card
 * and payout, the way it does before a rate card has ever been uploaded.
 */
export async function loadApproveContext(shares: ShareRate[]): Promise<ApproveContext> {
  const report = await getStore()
    .readCpaReport()
    .catch(() => null);
  return {
    choices: rateChoices(report?.rows ?? []),
    shares,
    // UTC, the clock every approval day in the app is kept in.
    today: new Date().toISOString().slice(0, 10),
  };
}
