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
  /** The campaign on the link it came through. '' when the link has none. */
  campaign: string;
  /** The card, as the merchant names it. '' when none is on record. */
  card: string;
  /** The lead behind it. '' when there is none, which is every approval with the form off. */
  client: string;
  approvedOn: string;
  /**
   * Recorded by hand or imported from the report. Kept because the routes know
   * it and a later message may want it; the wording does not use it — where an
   * approval came from is Ledger's business, not the channel's.
   */
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

const HEADING = '*LEDGER - AFFILIATE APPROVAL* 🎉';

/**
 * One approval, in the shape the channel reads: a heading, then a labelled
 * line each for who earned it, what it was for, and when.
 *
 * `*text*` is Slack's own bold, which is what makes the labels labels. The
 * card line carries the campaign, the client and the card together, because
 * they answer one question between them — what this approval was for — and a
 * line of three labels for three short values reads worse than one.
 *
 * Every part is dropped when there is nothing behind it, and a card line with
 * nothing at all on it goes entirely: a label followed by a blank is a message
 * that looks broken, and somebody will ask whether the data is.
 */
export function approvalMessage(approval: ApprovalAnnouncement): string {
  const detail = [
    approval.client.trim() ? `Client ${approval.client.trim()}` : '',
    approval.card.trim(),
  ]
    .filter(Boolean)
    .join(' · ');
  const cardLine = [approval.campaign.trim(), detail].filter(Boolean).join(' | ');

  return [
    HEADING,
    `*Affiliate Name:* ${approval.person.trim() || NOBODY}`,
    cardLine ? `*CARD:* ${cardLine}` : '',
    `*Approved:* ${formatDay(approval.approvedOn)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * What a sync posts: each approval it imported, up to the cap, then a line for
 * whatever is past it, then one summary.
 *
 * The summary counts every approval, not only the named ones, so the channel's
 * last line is the run's actual total.
 */
export function syncMessages(approvals: ApprovalAnnouncement[], leadsMarked: number): string[] {
  if (approvals.length === 0) return [];

  const messages = approvals.slice(0, SLACK_MESSAGE_CAP).map((approval) => approvalMessage(approval));

  const rest = approvals.length - SLACK_MESSAGE_CAP;
  if (rest > 0) messages.push(`…and ${rest} more.`);

  const counted = `${approvals.length} approval${approvals.length === 1 ? '' : 's'} imported`;
  const leads =
    leadsMarked > 0 ? `, ${leadsMarked} lead${leadsMarked === 1 ? '' : 's'} marked approved` : '';
  messages.push(`QMP sync: ${counted}${leads}.`);
  return messages;
}
