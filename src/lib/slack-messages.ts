import { formatDay } from './analytics';

/**
 * What Ledger says in Slack when an approval lands.
 *
 * Pure: text in, text out, no network and no environment, so what a channel
 * will read can be checked without posting anything anywhere.
 *
 * No money, deliberately. A Slack channel is the least controlled surface this
 * app writes to — anybody invited reads everything ever posted, and nobody is
 * signed in to it — so a message carries who, which card and which client, and
 * never a payout, an affiliate's share or the commission rate. An approval is
 * news; what it paid is on the dashboard, behind a sign-in.
 */

/** One approval, as a channel needs to read it. */
export type ApprovalAnnouncement = {
  /** The person the link belongs to. '' when the key matches nobody. */
  person: string;
  /** The card, as the merchant names it. '' when none is on record. */
  card: string;
  /** The lead behind it. '' when there is none, which is every approval with the form off. */
  client: string;
  approvedOn: string;
  /** Recorded by hand on the dashboard, or imported from the QMP report. */
  source: 'manual' | 'sync';
};

/**
 * How many approvals a sync names one by one before the rest become a line.
 *
 * A first sync, or one catching up a backlog, can import dozens. Ten messages
 * is a channel telling you something; fifty is a channel nobody reads again.
 */
export const SLACK_MESSAGE_CAP = 10;

/** What a key with nobody behind it is called, rather than a blank space. */
const NOBODY = 'Unassigned';

export function approvalMessage(approval: ApprovalAnnouncement, baseUrl: string): string {
  const head = ['New approval', approval.person.trim() || NOBODY, approval.card.trim()]
    .filter(Boolean)
    .join(' · ');

  const detail = [
    approval.client.trim() ? `Client: ${approval.client.trim()}` : '',
    `Approved ${formatDay(approval.approvedOn)}`,
    approval.source === 'sync' ? 'From the QMP report' : 'Recorded by hand',
  ]
    .filter(Boolean)
    .join(' · ');

  // The link is where the figures are, which is the reason it is the only part
  // of this message that leads anywhere.
  const link = baseUrl.trim().replace(/\/+$/, '');
  return [head, detail, link].filter(Boolean).join('\n');
}

/**
 * What a sync posts: each approval it imported, up to the cap, then a line for
 * whatever is past it, then one summary.
 *
 * The summary counts every approval, not only the named ones, so the channel's
 * last line is the run's actual total.
 */
export function syncMessages(
  approvals: ApprovalAnnouncement[],
  leadsMarked: number,
  baseUrl = '',
): string[] {
  if (approvals.length === 0) return [];

  const messages = approvals
    .slice(0, SLACK_MESSAGE_CAP)
    .map((approval) => approvalMessage(approval, baseUrl));

  const rest = approvals.length - SLACK_MESSAGE_CAP;
  if (rest > 0) messages.push(`…and ${rest} more.`);

  const counted = `${approvals.length} approval${approvals.length === 1 ? '' : 's'} imported`;
  const leads =
    leadsMarked > 0 ? `, ${leadsMarked} lead${leadsMarked === 1 ? '' : 's'} marked approved` : '';
  messages.push(`QMP sync: ${counted}${leads}.`);
  return messages;
}
