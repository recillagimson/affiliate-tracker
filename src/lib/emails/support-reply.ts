import type { Message } from '../email';

/**
 * "Support has written to you."
 *
 * Sent when an admin replies on a support ticket, or opens one with an
 * affiliate. Carries the message itself, so it can be read without signing in,
 * and a link back to the conversation to answer it. Images are not included:
 * they are in the app, behind a sign-in. Text and HTML built together, as in
 * payout-sent.ts, and with no em dashes for the same reason.
 *
 * Everything typed by a person is escaped on its way into the HTML. The
 * subject has already had its line breaks removed by lib/support-api.ts, which
 * is what keeps it safe to use as the Subject header.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function supportReplyEmail(input: {
  to: string;
  /** Their full name, or their username if that is all we have. */
  name: string;
  /** Where the app lives, worked out by the caller. */
  origin: string;
  /** The ticket's subject. */
  subject: string;
  /** What the admin wrote. */
  body: string;
  /** The conversation's path, e.g. /support/12. */
  ticketPath: string;
  /** True when this message opened the ticket, false when it is a reply. */
  opened: boolean;
}): Message {
  const base = input.origin.replace(/\/+$/, '');
  const link = `${base}${input.ticketPath}`;
  const first = (input.name || '').trim().split(/\s+/)[0] || 'there';
  const lead = input.opened
    ? 'LaunchStone support has sent you a message:'
    : 'LaunchStone support has replied to your ticket:';

  const text = [
    `Hi ${first},`,
    '',
    lead,
    '',
    `Subject: ${input.subject}`,
    '',
    input.body,
    '',
    'To answer, open the conversation in Ledger:',
    link,
    '',
    'The LaunchStone team',
  ].join('\n');

  const html = `
<div style="margin:0;padding:24px;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #dde3e9;border-radius:4px;">
    <div style="padding:22px 26px;border-bottom:1px solid #edf1f4;">
      <p style="margin:0;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#6b7c8f;">
        Support
      </p>
      <h1 style="margin:6px 0 0;font-size:20px;line-height:1.25;color:#0b2239;font-weight:600;">
        ${escapeHtml(input.subject)}
      </h1>
    </div>
    <div style="padding:22px 26px;">
      <p style="margin:0;font-size:14px;line-height:1.6;color:#33475b;">
        Hi ${escapeHtml(first)},<br>${escapeHtml(lead)}
      </p>
      <p style="margin:16px 0 0;padding:14px 16px;background:#f4f6f8;border-left:3px solid #f0b429;font-size:14px;line-height:1.6;color:#0b2239;">
        ${escapeHtml(input.body).replace(/\r?\n/g, '<br>')}
      </p>
      <p style="margin:22px 0 0;">
        <a href="${escapeHtml(link)}"
           style="display:inline-block;background:#f0b429;color:#3a2a00;text-decoration:none;
                  font-size:14px;font-weight:600;padding:11px 20px;border-radius:3px;">
          Open the conversation
        </a>
      </p>
    </div>
    <div style="padding:16px 26px;border-top:1px solid #edf1f4;">
      <p style="margin:0;font-size:12px;line-height:1.6;color:#6b7c8f;">
        Answer in Ledger so the whole conversation stays in one place.
      </p>
    </div>
  </div>
</div>`.trim();

  return {
    to: input.to,
    subject: input.opened
      ? `New message from LaunchStone support: ${input.subject}`
      : `Reply to your support ticket: ${input.subject}`,
    text,
    html,
  };
}
