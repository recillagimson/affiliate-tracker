/**
 * What a customer is sent when they place a tradelines order.
 *
 * It confirms the order number, what was ordered and what it comes to, and
 * says the order is not paid for yet. It goes to whatever address was typed
 * into a public form, so it carries nothing that would matter if that address
 * were somebody else's: no SSN, no date of birth, no street address.
 *
 * Pure. scripts/tradeline-order-email-checks.ts pins it.
 */

import type { Message } from '../email';

const PHONE = '+1 (518) 671-8758';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function money(amount: number): string {
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function tradelineOrderEmail(input: {
  to: string;
  name: string;
  orderNumber: string;
  items: { name: string; quantity: number; lineTotal: number }[];
  total: number;
}): Message {
  /*
   * Their first name, if it reads as one. This goes to whatever address a
   * stranger typed, under our name, so it must not be a way to put words of
   * their choosing at the top of our email: letters only, a sensible length,
   * and no dots, which is what makes "www.something.com" a link in a mail
   * client. Anything else is greeted plainly.
   */
  const given = (input.name.trim().split(/\s+/)[0] ?? '').replace(/[^\p{L}\p{M}'-]/gu, '');
  const first = given.length >= 1 && given.length <= 30 && !(input.name.trim().split(/\s+/)[0] ?? '').includes('.') ? given : 'there';
  const lines = input.items.map((item) => ({
    name: item.name,
    months: `${item.quantity * 3} months`,
    total: money(item.lineTotal),
  }));

  const text = [
    `Hi ${first},`,
    '',
    `We have your order, ${input.orderNumber}. It is awaiting payment.`,
    '',
    ...lines.map((line) => `${line.name}, ${line.months}: ${line.total}`),
    '',
    `Total: ${money(input.total)}`,
    '',
    'We will be in touch about payment. Once it is received we will add you to the',
    'accounts you chose.',
    '',
    `Questions? Call ${PHONE} and quote your order number.`,
    '',
    'If you did not place this order, reply to this message and we will cancel it.',
  ].join('\n');

  const rows = lines
    .map(
      (line) => `
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #edf1f4;font-size:14px;color:#0b2239;">
            ${escapeHtml(line.name)}<br />
            <span style="font-size:12px;color:#6b7c8f;">${escapeHtml(line.months)}</span>
          </td>
          <td style="padding:10px 0;border-bottom:1px solid #edf1f4;font-size:14px;color:#0b2239;text-align:right;white-space:nowrap;">
            ${escapeHtml(line.total)}
          </td>
        </tr>`,
    )
    .join('');

  const html = `
<div style="margin:0;padding:24px;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #dde3e9;border-radius:4px;">
    <div style="padding:22px 26px;border-bottom:1px solid #edf1f4;">
      <p style="margin:0;font-size:13px;color:#6b7c8f;">Order ${escapeHtml(input.orderNumber)}</p>
      <h1 style="margin:6px 0 0;font-size:20px;line-height:1.25;color:#0b2239;font-weight:600;">
        We have your order, ${escapeHtml(first)}.
      </h1>
    </div>
    <div style="padding:22px 26px;">
      <p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#33475b;">
        It is awaiting payment. We will be in touch about that, and once it is received we will add
        you to the accounts you chose.
      </p>
      <table role="presentation" style="width:100%;border-collapse:collapse;">${rows}
        <tr>
          <td style="padding:12px 0 0;font-size:14px;color:#33475b;">Total</td>
          <td style="padding:12px 0 0;font-size:16px;font-weight:600;color:#0b2239;text-align:right;">${escapeHtml(money(input.total))}</td>
        </tr>
      </table>
      <p style="margin:18px 0 0;font-size:13px;line-height:1.6;color:#6b7c8f;">
        Questions? Call ${escapeHtml(PHONE)} and quote your order number. If you did not place this
        order, reply to this message and we will cancel it.
      </p>
    </div>
  </div>
</div>`;

  return { to: input.to, subject: `Your tradelines order ${input.orderNumber}`, text, html };
}
