import { NextResponse } from 'next/server';
import { requireApiAdmin } from '@/lib/api-auth';
import { describeConversions } from '@/lib/analytics';
import { configuredBaseUrl } from '@/lib/config';
import { EmailError, sendEmail } from '@/lib/email';
import { payoutSentEmail } from '@/lib/emails/payout-sent';
import { asAffiliateShare, loadAll } from '@/lib/load';
import { dayOf, totalOf } from '@/lib/payout';
import { asBody, readConversionIds, readPayment, storeFailure, type Refusal } from '@/lib/payout-api';
import { validateRequestedIds } from '@/lib/payout-request';
import { createMonthlyPayout, listCommittedConversionIds } from '@/lib/payout-request-store';
import { checkReceiptUpload } from '@/lib/receipt-file';
import { StoreConflictError } from '@/lib/store/errors';
import { originFromHeaders } from '@/lib/request';
import { payslipHref } from '@/lib/payslip-view';
import { findUserById } from '@/lib/users';

/**
 * The monthly payout: payroll pays one affiliate for the unpaid approvals it
 * chose, with the date, a reference and the receipt, in one step.
 *
 * Admin only. The body names the affiliate and the cards; nothing else in it
 * is believed. The amounts are priced here, from the commission history, as
 * the affiliate's own share, and the cards are held against what this
 * affiliate actually has unpaid (validateRequestedIds, without the 15-day
 * wait). create_monthly_payout checks ownership and double payment again
 * inside the transaction that writes it, which is the check that cannot be
 * raced. What was sent is the total of the chosen cards.
 */

export const dynamic = 'force-dynamic';

function refuse(refusal: Refusal): NextResponse {
  const { status, ...body } = refusal;
  return NextResponse.json(body, { status });
}

export async function POST(request: Request) {
  const gate = await requireApiAdmin(request, 'Only an admin can record a payout.');
  if ('response' in gate) return gate.response;
  const { viewer } = gate;

  let body: Record<string, unknown>;
  try {
    body = asBody(await request.json());
  } catch {
    return refuse({ status: 400, error: 'Expected a JSON body.' });
  }

  const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
  if (!userId) return refuse({ status: 400, error: 'Which affiliate is being paid?' });

  const ids = readConversionIds(body.conversionIds);
  if (!ids.ok) return refuse(ids.refusal);

  let proof: { name: string; type: string; data: string } | null = null;
  if (body.proof && typeof body.proof === 'object') {
    const upload = checkReceiptUpload(body.proof as Record<string, unknown>);
    if (!upload.ok) return refuse({ status: 422, error: upload.error, hint: upload.hint });
    proof = upload.receipt;
  }

  const today = dayOf(new Date().toISOString());

  try {
    const account = await findUserById(userId);
    if (!account || account.role !== 'affiliate' || !account.usr) {
      return refuse({ status: 404, error: 'That affiliate account no longer exists.' });
    }

    const [load, committed] = await Promise.all([loadAll(viewer), listCommittedConversionIds()]);
    if (load.error) {
      console.error('monthly payout: reading approvals', load.error);
      return refuse({ status: 503, error: 'The approvals could not be read just now.', hint: 'Try again in a moment.' });
    }
    if (load.noShare.has(account.usr)) {
      return refuse({ status: 403, error: 'LGF employees and admins earn no commission, so there is nothing to pay.' });
    }

    // Priced as the affiliate's share, exactly as the Monthly tab showed it.
    const owed = asAffiliateShare(load.conversions, load.settings, load.noShare);
    const candidates = owed.map((row) => ({ id: row.id, usr: row.usr, approvedOn: row.approvedOn, amount: row.amount }));
    const result = validateRequestedIds(ids.ids, candidates, account.usr, today, committed, { anyAge: true });
    if (!result.ok) return refuse({ status: 422, error: result.reason.replace('not yours', "not this affiliate's") });

    const total = totalOf(result.items);
    const payment = readPayment({ ...body, amount: total }, today, today);
    if (!payment.ok) return refuse(payment.refusal);

    const requestId = await createMonthlyPayout({
      userId: account.id,
      usr: account.usr,
      paidBy: viewer.username,
      items: result.items,
      amount: payment.payment.amount,
      paidOn: payment.payment.paidOn,
      reference: payment.payment.reference,
      note: payment.payment.note,
      proof,
    });
    // Tell the affiliate. Never fails the payout: the money is recorded either
    // way, and payroll is shown why no email went.
    const emailed = await emailAffiliate({
      to: account.email,
      name: account.fullName || account.username,
      origin: originFromHeaders(request.headers, configuredBaseUrl()),
      amount: payment.payment.amount,
      paidOn: payment.payment.paidOn,
      reference: payment.payment.reference,
      cards: describeConversions(
        load.links,
        owed.filter((row) => result.items.some((item) => item.conversionId === row.id)),
        load.submissions,
        { gross: false },
      ).map((view) => ({ card: view.card || 'Card', customer: view.client || 'Customer', approvedOn: dayOf(view.approvedOn), amount: view.affiliate })),
      payslipPath: payslipHref(requestId),
      hasReceipt: proof !== null,
    });

    return NextResponse.json(
      { ok: true, requestId, amount: payment.payment.amount, ...emailed },
      { status: 201 },
    );
  } catch (error) {
    // Somebody else paid one of these cards between the page loading and Save.
    const refusal: Refusal =
      error instanceof StoreConflictError
        ? {
            status: 409,
            error: 'One of those approvals has already been paid or requested.',
            hint: 'Reload the page to see what is still unpaid.',
          }
        : storeFailure(error, 'That payout did not save.', { showUnknown: true });
    if (refusal.status >= 500) console.error('monthly payout', error);
    return refuse(refusal);
  }
}

async function emailAffiliate(
  input: Omit<Parameters<typeof payoutSentEmail>[0], 'to'> & { to: string },
): Promise<{ emailed: boolean; emailProblem?: string }> {
  if (!input.to.trim()) return { emailed: false, emailProblem: 'They have no email address on file, so no email was sent.' };
  try {
    await sendEmail(payoutSentEmail(input));
    return { emailed: true };
  } catch (error) {
    const why = error instanceof EmailError || error instanceof Error ? error.message : 'The email could not be sent.';
    if (!(error instanceof EmailError && error.unconfigured)) console.error('monthly payout: email', error);
    return { emailed: false, emailProblem: why };
  }
}
