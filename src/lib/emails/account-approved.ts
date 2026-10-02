import type { Message } from '../email';

/**
 * "Your account is approved."
 *
 * One place for the wording, because this is the first message the app sends and
 * it is the first thing an affiliate reads from us that is not a form. Both
 * parts are built together so the text version cannot drift into being an
 * afterthought: plenty of people, and every screen reader, get the text one.
 *
 * No em dashes in anything here. It is the most recognisable tell in generated
 * copy and this is the most customer-facing surface in the app.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function accountApprovedEmail(input: {
  to: string;
  /** What to call them. Their full name, or their username if that is all we
   *  have. */
  name: string;
  /** Where the app lives. Worked out by the caller from the configured base
   *  URL or the request, rather than guessed here, so a link in an email is
   *  never wrong. */
  origin: string;
  /** Anything the admin typed when approving. Usually nothing. */
  note?: string;
}): Message {
  const base = input.origin.replace(/\/+$/, '');
  const signIn = `${base}/login`;
  const first = (input.name || '').trim().split(/\s+/)[0] || 'there';
  const note = (input.note ?? '').trim();

  const text = [
    `Hi ${first},`,
    '',
    'Your affiliate account has been approved. Everything you sent through has been',
    'checked and your dashboard is open.',
    '',
    'Sign in here:',
    signIn,
    '',
    'Your tracking link is on the Links page. Commission is paid monthly by ACH',
    'to the account you gave us.',
    ...(note ? ['', 'A note from the team:', note] : []),
    '',
    'If anything looks wrong, reply to this message and we will sort it out.',
  ].join('\n');

  const html = `
<div style="margin:0;padding:24px;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #dde3e9;border-radius:4px;">
    <div style="padding:22px 26px;border-bottom:1px solid #edf1f4;">
      <p style="margin:0;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#6b7c8f;">
        Account approved
      </p>
      <h1 style="margin:6px 0 0;font-size:20px;line-height:1.25;color:#0b2239;font-weight:600;">
        You are all set, ${escapeHtml(first)}.
      </h1>
    </div>
    <div style="padding:22px 26px;">
      <p style="margin:0;font-size:14px;line-height:1.6;color:#33475b;">
        Your affiliate account has been approved. Everything you sent through has been checked
        and your dashboard is open.
      </p>
      <p style="margin:20px 0 0;">
        <a href="${escapeHtml(signIn)}"
           style="display:inline-block;background:#f0b429;color:#3a2a00;text-decoration:none;
                  font-size:14px;font-weight:600;padding:11px 20px;border-radius:3px;">
          Sign in to your dashboard
        </a>
      </p>
      <p style="margin:20px 0 0;font-size:13px;line-height:1.6;color:#33475b;">
        Your tracking link is on the Links page. Commission is paid monthly by ACH to the
        account you gave us.
      </p>
      ${
        note
          ? `<div style="margin:20px 0 0;padding:14px 16px;background:#f7f9fb;border:1px solid #edf1f4;border-radius:3px;">
               <p style="margin:0;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#6b7c8f;">
                 A note from the team
               </p>
               <p style="margin:6px 0 0;font-size:13px;line-height:1.6;color:#33475b;">
                 ${escapeHtml(note)}
               </p>
             </div>`
          : ''
      }
    </div>
    <div style="padding:16px 26px;border-top:1px solid #edf1f4;">
      <p style="margin:0;font-size:12px;line-height:1.6;color:#6b7c8f;">
        If anything looks wrong, reply to this message and we will sort it out.
      </p>
    </div>
  </div>
</div>`.trim();

  return {
    to: input.to,
    subject: 'Your affiliate account is approved',
    text,
    html,
  };
}
