import { approvalMessage, syncMessages, type ApprovalAnnouncement } from './slack-messages';

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

function webhookUrl(): string {
  return (process.env.SLACK_WEBHOOK_URL ?? '').trim();
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
export function slackConfigured(): boolean {
  const url = webhookUrl();
  if (url.startsWith('https://')) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
}

/**
 * Post one message. Throws on anything that went wrong, so the callers below
 * can decide what to do; nothing outside this file is expected to call it.
 */
export async function postToSlack(text: string): Promise<void> {
  const url = webhookUrl();
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
export async function announce(messages: string[]): Promise<string> {
  if (messages.length === 0 || !slackConfigured()) return '';
  for (const message of messages) {
    try {
      await postToSlack(message);
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
export async function announceApproval(approval: ApprovalAnnouncement): Promise<string> {
  if (!slackConfigured()) return '';
  return announce([approvalMessage(approval)]);
}

/** A sync's approvals and its summary, in the order the channel should read them. */
export async function announceSync(
  approvals: ApprovalAnnouncement[],
  leadsMarked: number,
): Promise<string> {
  if (!slackConfigured()) return '';
  return announce(syncMessages(approvals, leadsMarked));
}
