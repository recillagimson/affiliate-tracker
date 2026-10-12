import {
  approvalMessage,
  supportMessage,
  syncMessages,
  type ApprovalAnnouncement,
  type SupportAnnouncement,
} from './slack-messages';

/**
 * Posting to a Slack channel, through an incoming webhook.
 *
 * One rule runs through this file: **Slack never fails an approval**. The money
 * is written first and announced afterwards, and every function here that the
 * routes call swallows its own failures. A channel that missed a message is a
 * channel somebody scrolls past; an approval refused because Slack timed out is
 * money that did not get recorded.
 *
 * A webhook URL is the whole configuration. Unset means the feature is off, and
 * off is silent rather than an error: most installs never wire this up.
 */

const TIMEOUT_MS = 10_000;

/**
 * Which channel a message is for.
 *
 * 'default' is the first channel this app ever posted to: affiliates'
 * approvals, support tickets, and everything else. 'employee' is the channel
 * for approvals on an LGF employee's link, which has a webhook of its own.
 */
export type SlackChannel = 'default' | 'employee';

/**
 * The webhook for a channel. The employee channel falls back to the first one
 * when it has no webhook of its own, so an install with one channel behaves as
 * it did before there were two.
 */
function webhookUrl(channel: SlackChannel = 'default'): string {
  const main = (process.env.SLACK_WEBHOOK_URL ?? '').trim();
  if (channel === 'default') return main;
  return (process.env.SLACK_WEBHOOK_URL_LGF_EMPLOYEE ?? '').trim() || main;
}

/**
 * Where an approval on this tracking key is announced.
 *
 * `noShare` is lib/users listNoShareKeys: the keys of LGF employees (and
 * admins), whose approvals go to the employee channel. Every other key is an
 * affiliate's and stays in the first one. Null is a list that could not be
 * read, and that stays in the first channel too: it is where every approval
 * went before, and a failed read is no reason to guess at somebody's role.
 */
export function approvalChannel(usr: string, noShare: Set<string> | null): SlackChannel {
  return noShare?.has(usr) ? 'employee' : 'default';
}

/**
 * Whether there is somewhere to post.
 *
 * https only, because the URL is the credential: anyone who reads it off the
 * wire can post into that channel for as long as it lives. Slack's own
 * webhooks are https without exception, so the rule costs nothing in practice.
 *
 * Plain http is allowed for localhost alone, which is a fake channel on a
 * development machine — there is no wire to read it off — and is how the end
 * to end test posts without a Slack workspace.
 */
export function slackConfigured(channel: SlackChannel = 'default'): boolean {
  const url = webhookUrl(channel);
  if (url.startsWith('https://')) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
}

/**
 * Post one message. Throws on anything that went wrong, so the callers below
 * can decide what to do; nothing outside this file is expected to call it.
 */
export async function postToSlack(text: string, channel: SlackChannel = 'default'): Promise<void> {
  const url = webhookUrl(channel);
  if (!url) throw new Error('SLACK_WEBHOOK_URL is not set.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    if (!response.ok) {
      // Slack answers a bad webhook in plain text ("no_service"), which is the
      // useful half of the failure and short enough to log whole.
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      throw new Error(`Slack refused the message (HTTP ${response.status}${detail ? `: ${detail}` : ''}).`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Post messages one after another, and never throw.
 *
 * Sequential because a channel reads top to bottom: sent together, ten
 * approvals arrive in whatever order the network settles on, and the summary
 * could land before the rows it counts.
 *
 * Returns what went wrong, for a caller that has somewhere to say it — the
 * sync's result does — and '' when there was nothing to do or it all landed.
 */
export async function announce(messages: string[], channel: SlackChannel = 'default'): Promise<string> {
  if (messages.length === 0 || !slackConfigured(channel)) return '';
  for (const message of messages) {
    try {
      await postToSlack(message, channel);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Slack did not accept the message.';
      // Logged as well as returned: a route that ignores the return value
      // still leaves a trace in the server log.
      console.error('slack:', detail);
      return detail;
    }
  }
  return '';
}

/** One approval, announced. Safe to call without awaiting the result. */
export async function announceApproval(
  approval: ApprovalAnnouncement,
  channel: SlackChannel = 'default',
): Promise<string> {
  return announce([approvalMessage(approval)], channel);
}

/**
 * A sync's approvals and its summary, in the order the channel should read them.
 *
 * Each channel gets its own approvals, its own cap and a summary that counts
 * only what it was shown. The leads marked are one figure for the whole run,
 * so it is said once: in the first channel that has anything to read.
 *
 * Grouped by webhook rather than by name, so that with one webhook this is one
 * run of messages in the order they were written, as it always was. A channel
 * that refuses does not cost the other its messages.
 */
export async function announceSync(
  approvals: Array<ApprovalAnnouncement & { channel: SlackChannel }>,
  leadsMarked: number,
): Promise<string> {
  const groups = new Map<string, { channel: SlackChannel; approvals: ApprovalAnnouncement[] }>();
  for (const channel of ['default', 'employee'] as const) {
    if (!slackConfigured(channel)) continue;
    const mine = approvals.filter((approval) => approval.channel === channel);
    if (mine.length === 0) continue;
    const url = webhookUrl(channel);
    if (!groups.has(url)) groups.set(url, { channel, approvals: [] });
  }
  for (const approval of approvals) {
    groups.get(webhookUrl(approval.channel))?.approvals.push(approval);
  }

  const problems: string[] = [];
  let leads = leadsMarked;
  for (const group of groups.values()) {
    const problem = await announce(syncMessages(group.approvals, leads), group.channel);
    if (problem) problems.push(problem);
    leads = 0;
  }
  return problems.join(' ');
}

/** A support ticket opened or replied on by an affiliate. Never throws. */
export async function announceSupport(announcement: SupportAnnouncement): Promise<string> {
  return announce([supportMessage(announcement)]);
}
