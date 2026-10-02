import type { Message } from '../email';

/**
 * "You've been paid."
 *
 * Sent when payroll records a monthly payout. Says how much, when, the
 * reference to look for on the bank statement, which approvals it covers, and
 * where the payslip and receipt are. Text and HTML built together, as in
 * account-approved.ts, and with no em dashes for the same reason.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function money(amount: number): string {
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: amount % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
}

function day(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  if (!y || !m || !d) return key;
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1];
  return `${d} ${month} ${y}`;
}

export type PaidCard = { card: string; customer: string; approvedOn: string; amount: number };

export function payoutSentEmail(input: {
  to: string;
  /** Their full name, or their username if that is all we have. */
  name: string;
  /** Where the app lives, worked out by the caller. */
  origin: string;
  amount: number;
  /** YYYY-MM-DD, the day the money was sent. */
  paidOn: string;
  reference: string;
  cards: PaidCard[];
  /** The payslip's path, e.g. /payslips/12. */
  payslipPath: string;
  hasReceipt: boolean;
}): Message {
  const base = input.origin.replace(/\/+$/, '');
  const payslip = `${base}${input.payslipPath}`;
  const first = (input.name || '').trim().split(/\s+/)[0] || 'there';
  const count = input.cards.length === 1 ? '1 approved card' : `${input.cards.length} approved cards`;
  const receiptLine = input.hasReceipt
    ? 'Your payslip and the transfer receipt are in Ledger:'
    : 'Your payslip is in Ledger:';

  const text = [
    `Hi ${first},`,
    '',
    `We have sent your LaunchStone affiliate commission: ${money(input.amount)} by ACH on ${day(input.paidOn)}.`,
    ...(input.reference ? [`Reference: ${input.reference}`] : []),
    '',
    `It covers ${count}:`,
    ...input.cards.map((c) => `- ${c.card}, ${c.customer}, approved ${day(c.approvedOn)}: ${money(c.amount)}`),
    '',
    receiptLine,
    payslip,
    '',
    'ACH transfers usually arrive within 1 to 3 business days. Once it lands, you can confirm it on your payslip.',
    '',
    'If anything looks wrong, reply to this message and we will sort it out.',
    '',
    'The LaunchStone team',
  ].join('\n');

  const rows = input.cards
    .map(
      (c) => `
        <tr>
          <td style="padding:8px 0;border-bottom:1px solid #edf1f4;font-size:13px;color:#0b2239;">
            ${escapeHtml(c.card)}<br>
            <span style="font-size:11px;color:#6b7c8f;">${escapeHtml(c.customer)}, approved ${escapeHtml(day(c.approvedOn))}</span>
          </td>
          <td style="padding:8px 0;border-bottom:1px solid #edf1f4;font-size:13px;color:#0b2239;text-align:right;white-space:nowrap;">
            ${escapeHtml(money(c.amount))}
          </td>
        </tr>`,
    )
    .join('');

  const html = `
<div style="margin:0;padding:24px;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #dde3e9;border-radius:4px;">
    <div style="padding:22px 26px;border-bottom:1px solid #edf1f4;">
      <p style="margin:0;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#6b7c8f;">
        Commission paid
      </p>
      <h1 style="margin:6px 0 0;font-size:20px;line-height:1.25;color:#0b2239;font-weight:600;">
        You have been paid ${escapeHtml(money(input.amount))}, ${escapeHtml(first)}.
      </h1>
    </div>
    <div style="padding:22px 26px;">
      <p style="margin:0;font-size:14px;line-height:1.6;color:#33475b;">
        We sent your LaunchStone affiliate commission by ACH on <strong>${escapeHtml(day(input.paidOn))}</strong>.
        ${input.reference ? `<br>Reference: <strong>${escapeHtml(input.reference)}</strong>` : ''}
      </p>
      <p style="margin:20px 0 6px;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#6b7c8f;">
        It covers ${escapeHtml(count)}
      </p>
      <table role="presentation" style="width:100%;border-collapse:collapse;">
        ${rows}
        <tr>
          <td style="padding:10px 0 0;font-size:13px;font-weight:600;color:#0b2239;">Total</td>
          <td style="padding:10px 0 0;font-size:15px;font-weight:600;color:#0b2239;text-align:right;">
            ${escapeHtml(money(input.amount))}
          </td>
        </tr>
      </table>
      <p style="margin:22px 0 0;">
        <a href="${escapeHtml(payslip)}"
           style="display:inline-block;background:#f0b429;color:#3a2a00;text-decoration:none;
                  font-size:14px;font-weight:600;padding:11px 20px;border-radius:3px;">
          ${input.hasReceipt ? 'View payslip and receipt' : 'View payslip'}
        </a>
      </p>
      <p style="margin:20px 0 0;font-size:13px;line-height:1.6;color:#33475b;">
        ACH transfers usually arrive within 1 to 3 business days. Once it lands, you can confirm it on your payslip.
      </p>
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
    subject: `You've been paid ${money(input.amount)}: LaunchStone affiliate commission`,
    text,
    html,
  };
}
