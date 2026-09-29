import { NextResponse } from 'next/server';
import { unauthorized, viewerFromRequest, type Viewer } from '@/lib/api-auth';
import { loadAll, type LoadResult } from '@/lib/load';
import { dayOf } from '@/lib/payout';
import {
  asBody,
  candidatesFrom,
  payslipGate,
  readConversionIds,
  readPayslipAction,
  readRequestId,
  requestedByFor,
  requestFailure,
  storeFailure,
  type Refusal,
} from '@/lib/payout-api';
import { validateRequestedIds } from '@/lib/payout-request';
import {
  confirmReceipt,
  createPayoutRequest,
  listCommittedConversionIds,
} from '@/lib/payout-request-store';
import { listNoShareKeys } from '@/lib/users';

/**
 * An affiliate's own side of getting paid: asking for it, and saying it
 * arrived.
 *
 * Two actions. `request` files a payout request for the ready cards the
 * affiliate chose; `confirm` marks a recorded payment as received. Both act on
 * the account in the session and neither reads who it is from the body: the
 * user id, the tracking key and the audit line all come from the viewer, so a
 * hand-made POST can only ever ask on behalf of the person who sent it.
 *
 * The card ids are the one thing the body does decide, and they are trusted
 * for nothing beyond naming a choice. validateRequestedIds holds them against
 * this viewer's own approvals (loadAll has already cut those down to this
 * tracking key and priced them at the affiliate's own rate), and
 * create_payout_request checks all of it again inside the transaction that
 * writes the request. The first gives a sentence somebody can act on; the
 * second is the one that cannot be raced.
 *
 * An admin in Client View is the affiliate as far as this route is concerned
 * and may file a request for them, with the audit line naming both. A plain
 * admin session is refused, and so is an LGF employee, who earns no share to
 * ask for. The rules for both live in lib/payout-api.ts, with their checks.
 *
 * Nothing this route answers carries an amount. A request's figures are read
 * back on the payslip page, from the snapshot the database kept.
 */

export const dynamic = 'force-dynamic';

function refuse(refusal: Refusal): NextResponse {
  const { status, ...body } = refusal;
  return NextResponse.json(body, { status });
}

export async function POST(request: Request) {
  const viewer = await viewerFromRequest(request);
  if (!viewer) return unauthorized();

  let body: Record<string, unknown>;
  try {
    body = asBody(await request.json());
  } catch {
    return refuse({ status: 400, error: 'Expected a JSON body.' });
  }

  const action = readPayslipAction(body.action);
  if (!action) {
    return refuse({ status: 400, error: 'No such action.', hint: 'Expected request or confirm.' });
  }

  // Only a request needs to know, and only an affiliate with a key could get
  // that far. A failed read refuses rather than guessing "not an employee".
  let lgfEmployee = false;
  if (action === 'request' && viewer.role === 'affiliate' && viewer.usr) {
    try {
      lgfEmployee = (await listNoShareKeys()).has(viewer.usr);
    } catch (error) {
      const refusal = storeFailure(error, 'Your account could not be checked just now.');
      if (refusal.status >= 500) console.error('checking for an LGF employee', error);
      return refuse(refusal);
    }
  }

  const refused = payslipGate(viewer, action, lgfEmployee);
  if (refused) return refuse(refused);

  const by = requestedByFor(viewer);
  return action === 'request'
    ? requestPayment(viewer, body.conversionIds, by)
    : confirmPayment(viewer, body.requestId, by);
}

async function requestPayment(viewer: Viewer, chosen: unknown, requestedBy: string): Promise<NextResponse> {
  const ids = readConversionIds(chosen);
  if (!ids.ok) return refuse(ids.refusal);

  let load: LoadResult;
  let committed: Set<string>;
  try {
    // Read side by side: neither depends on the other, and the database checks
    // both again when the request is written, so a card committed a moment
    // after this read is still caught.
    [load, committed] = await Promise.all([loadAll(viewer), listCommittedConversionIds()]);
  } catch (error) {
    const refusal = storeFailure(error, 'Your cards could not be read just now.');
    if (refusal.status >= 500) console.error('reading cards for a payout request', error);
    return refuse(refusal);
  }

  // loadAll captures its failures rather than throwing, so a storage outage
  // arrives as a message. Its text is for the logs, not for the affiliate.
  if (load.error) {
    console.error('reading approvals for a payout request', load.error);
    return refuse({
      status: 503,
      error: 'Your approvals could not be read just now.',
      hint: 'Try again in a moment.',
    });
  }

  const candidates = candidatesFrom(load);
  if (!candidates) {
    console.error('a payout request was about to be priced from merchant amounts', viewer.id);
    return refuse({ status: 500, error: 'That could not be processed.' });
  }

  const today = dayOf(new Date().toISOString());
  const result = validateRequestedIds(ids.ids, candidates, viewer.usr, today, committed);
  if (!result.ok) return refuse({ status: 422, error: result.reason });

  try {
    const requestId = await createPayoutRequest({
      userId: viewer.id,
      usr: viewer.usr,
      requestedBy,
      items: result.items,
    });
    return NextResponse.json({ ok: true, requestId }, { status: 201 });
  } catch (error) {
    const refusal = requestFailure(error);
    if (refusal.status >= 500) console.error('creating a payout request', error);
    return refuse(refusal);
  }
}

/**
 * Saying the money arrived.
 *
 * There is nothing to confirm until a payment has been recorded, and the store
 * enforces that inside the query, filtered on this viewer's own id, rather
 * than trusting this route to have checked. Somebody else's request and a
 * request with no payment yet both match nothing, and both get the same
 * sentence, so the answer says nothing about requests that are not theirs.
 */
async function confirmPayment(viewer: Viewer, rawId: unknown, by: string): Promise<NextResponse> {
  const id = readRequestId(rawId);
  if (!id.ok) return refuse(id.refusal);

  try {
    const done = await confirmReceipt(viewer.id, id.id, by);
    if (!done) {
      return refuse({
        status: 409,
        error: 'There is no payment recorded for that request yet.',
        hint: 'You can confirm it once the payment shows here.',
      });
    }
  } catch (error) {
    const refusal = storeFailure(error, 'That did not save.');
    if (refusal.status >= 500) console.error('confirming a payment', error);
    return refuse(refusal);
  }

  return NextResponse.json({ ok: true });
}
